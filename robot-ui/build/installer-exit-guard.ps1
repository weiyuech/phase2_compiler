# Windows PowerShell 5.1, shipped in the installer's temporary plugin directory.
# No app data is opened or modified. Stay silent: nsExec's /TIMEOUT is an
# inactivity timeout, so emitting progress would extend its 10-second deadline.
param(
    [string] $InstallDirectory,
    [string] $AppExecutable,
    [switch] $FunctionsOnly,
    [string] $DiagnosticPath
)

function Set-InstallerGuardFailure {
    param([string] $Stage, $Failure, [long] $Elapsed = 0)
    # Retain one small failure record in memory; never print progress or errors.
    # Only the synthetic Windows harness requests a diagnostic output file.
    $script:InstallerGuardFailure = @{
        Stage = $Stage
        ElapsedMilliseconds = $Elapsed
        ExceptionType = $Failure.Exception.GetType().FullName
        Message = $Failure.Exception.Message.Substring(0, [Math]::Min(2048, $Failure.Exception.Message.Length))
        Position = [string] $Failure.InvocationInfo.PositionMessage
    }
}

function Get-InstallerProcessSnapshot {
    @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, Name, ExecutablePath, CreationDate -OperationTimeoutSec 1 -ErrorAction Stop -WarningAction SilentlyContinue)
}

function Select-InstallerProcesses {
    param([object[]] $Processes, [string] $Executable, [System.Collections.Generic.HashSet[string]] $BackendRoots)

    # Electron utilityProcess backends use the same executable as the GUI. Keep
    # roots discovered on the first snapshot even after the GUI has disappeared.
    foreach ($process in $Processes) {
        if ($process.Name -ieq $Executable -and $process.ExecutablePath) {
            $directory = [IO.Path]::GetDirectoryName($process.ExecutablePath)
            [void] $BackendRoots.Add([IO.Path]::Combine($directory, 'resources\backend').TrimEnd('\') + '\')
        }
    }
    foreach ($process in $Processes) {
        $owned = $process.Name -ieq $Executable
        if ($process.ExecutablePath) {
            foreach ($root in $BackendRoots) {
                if ($process.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { $owned = $true }
            }
        } elseif (@('ffplay.exe', 'ffmpeg.exe', 'node.exe') -icontains $process.Name) {
            # An inaccessible possible media/backend process is not proof of exit.
            throw ('Cannot inspect a possible backend process: PID={0}, Name={1}.' -f $process.ProcessId, $process.Name)
        }
        if ($owned) {
            if (-not $process.CreationDate -or $process.ProcessId -eq $PID) { throw ('Cannot establish process identity: PID={0}, Name={1}.' -f $process.ProcessId, $process.Name) }
            $process
        }
    }
}

function Stop-InstallerProcess {
    param($Snapshot)
    try { $process = [Diagnostics.Process]::GetProcessById([int] $Snapshot.ProcessId) }
    catch [ArgumentException] { return } # Exited between the snapshot and lookup.
    try {
        # Pin the process handle before checking identity, so PID reuse cannot
        # turn a stale snapshot into permission to terminate an unrelated process.
        $null = $process.Handle
        if ($process.HasExited) { return }
        $ageDifference = [Math]::Abs(($process.StartTime.ToUniversalTime() - $Snapshot.CreationDate.ToUniversalTime()).TotalMilliseconds)
        if ($ageDifference -ge 1 -or ($process.ProcessName + '.exe') -ine $Snapshot.Name) { return }
        $process.Kill()
    } catch {
        if (-not $process.HasExited) { throw }
    } finally { $process.Dispose() }
}

function Invoke-InstallerExitGuard {
    param(
        [string] $Directory,
        [string] $Executable,
        [int] $TimeoutMilliseconds = 8000,
        [scriptblock] $ReadProcesses = { Get-InstallerProcessSnapshot },
        [scriptblock] $StopProcess = { param($process) Stop-InstallerProcess $process },
        [scriptblock] $Sleep = { param($milliseconds) Start-Sleep -Milliseconds $milliseconds },
        [scriptblock] $ElapsedMilliseconds
    )
    # nsExec supplies the outer 10-second bound, including PowerShell startup.
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $script:InstallerGuardFailure = $null
    if (-not $ElapsedMilliseconds) { $ElapsedMilliseconds = { $watch.ElapsedMilliseconds }.GetNewClosure() }
    if (-not [IO.Path]::IsPathRooted($Directory) -or [IO.Path]::GetFileName($Executable) -cne $Executable -or $Executable -notmatch '(?i)\.exe$' -or $TimeoutMilliseconds -lt 1 -or $TimeoutMilliseconds -gt 8000) { return 14 }
    $roots = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [void] $roots.Add([IO.Path]::Combine([IO.Path]::GetFullPath($Directory), 'resources\backend').TrimEnd('\') + '\')
    $emptySnapshots = 0
    while ((& $ElapsedMilliseconds) -lt $TimeoutMilliseconds) {
        try {
            $snapshot = @(& $ReadProcesses)
        } catch {
            Set-InstallerGuardFailure 'query' $_ (& $ElapsedMilliseconds)
            return 11
        }
        try {
            $remaining = @(Select-InstallerProcesses -Processes $snapshot -Executable $Executable -BackendRoots $roots)
        } catch {
            Set-InstallerGuardFailure 'identity-selection' $_ (& $ElapsedMilliseconds)
            return 11
        }
        if ((& $ElapsedMilliseconds) -ge $TimeoutMilliseconds) { return 13 }
        if ($remaining.Count -eq 0) {
            # A second fresh snapshot also catches a backend launched during exit.
            $emptySnapshots++
            if ($emptySnapshots -ge 2) { return 0 }
        } else {
            $emptySnapshots = 0
            foreach ($process in $remaining) {
                if ((& $ElapsedMilliseconds) -ge $TimeoutMilliseconds) { return 13 }
                try { $null = & $StopProcess $process } catch {
                    Set-InstallerGuardFailure 'termination' $_ (& $ElapsedMilliseconds)
                    return 12
                }
            }
        }
        $left = $TimeoutMilliseconds - (& $ElapsedMilliseconds)
        if ($left -gt 0) { $null = & $Sleep ([Math]::Min(200, $left)) }
    }
    return 13
}

if (-not $FunctionsOnly) {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $WarningPreference = 'SilentlyContinue'
    $InformationPreference = 'SilentlyContinue'
    try { $result = Invoke-InstallerExitGuard -Directory $InstallDirectory -Executable $AppExecutable }
    catch { Set-InstallerGuardFailure 'initialization' $_; $result = 11 }
    if ($result -ne 0 -and $DiagnosticPath) {
        try {
            $record = @{ ExitCode = $result; Failure = $script:InstallerGuardFailure }
            [IO.File]::WriteAllText($DiagnosticPath, ($record | ConvertTo-Json -Depth 3 -Compress))
        } catch {} # Diagnostics never change the guard result or emit output.
    }
    exit $result
}
