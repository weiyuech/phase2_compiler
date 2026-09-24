# Run through: node --test robot-ui/test/installer-exit-guard.test.mjs
# Or: powershell.exe -NoProfile -File robot-ui/test/installer-exit-guard.windows.ps1
# Uses only synthetic processes and a temporary directory, never the installed app.
$ErrorActionPreference = 'Stop'
$helper = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\build\installer-exit-guard.ps1'))
. $helper -FunctionsOnly

function Assert-Guard($Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}
function New-Snapshot([int] $Number, [string] $Name, [string] $Path, [int] $Parent = 0, [int] $CreatedSeconds = 0) {
    [pscustomobject] @{ ProcessId = $Number; ParentProcessId = $Parent; Name = $Name; ExecutablePath = $Path; CreationDate = [DateTime]::new(2026, 1, 1, 0, 0, 0, [DateTimeKind]::Utc).AddSeconds($CreatedSeconds) }
}
function New-Scenario {
    $state = [pscustomobject] @{ Time = 0; Reads = 0; Killed = @(); Scenario = '' }
    @{
        State = $state
        Arguments = @{
            Directory = 'C:\guard'
            Executable = 'guard-fixture.exe'
            ElapsedMilliseconds = { $state.Time }.GetNewClosure()
            Sleep = { param($milliseconds) $state.Time += $milliseconds }.GetNewClosure()
            StopProcess = { param($process) $state.Killed += $process.ProcessId }.GetNewClosure()
        }
    }
}

# Orchestration tests execute the production guard, with only OS boundaries replaced.
$case = New-Scenario
$state = $case.State
$case.Arguments.ReadProcesses = { $state.Reads++ }.GetNewClosure()
$arguments = $case.Arguments
Assert-Guard ((Invoke-InstallerExitGuard @arguments) -eq 0) 'Already stopped should succeed.'
Assert-Guard ($state.Reads -eq 2 -and $state.Time -eq 200) 'Success requires two fresh snapshots.'

$case = New-Scenario
$state = $case.State
$case.Arguments.ReadProcesses = {
    $state.Reads++
    if ($state.Reads -eq 1) {
        New-Snapshot 99101 'guard-fixture.exe' 'D:\old app\guard-fixture.exe'
        New-Snapshot 99102 'guard-fixture.exe' 'D:\old app\guard-fixture.exe'
    }
    if ($state.Reads -le 2) { New-Snapshot 99103 'ffplay.exe' 'D:\old app\resources\backend\ffplay.exe' }
    New-Snapshot 99104 'ffplay.exe' 'D:\old app sibling\resources\backend\ffplay.exe'
}.GetNewClosure()
$arguments = $case.Arguments
Assert-Guard ((Invoke-InstallerExitGuard @arguments) -eq 0) 'UI, utility backend and orphan media should exit.'
Assert-Guard (($state.Killed -join ',') -eq '99101,99102,99103,99103') 'Keep discovered roots but exclude sibling paths.'
Assert-Guard ($state.Reads -eq 4) 'A successful kill is not enough; fresh verification is required.'

$case = New-Scenario
$case.Arguments.ReadProcesses = { throw 'Synthetic query denial' }
$arguments = $case.Arguments
Assert-Guard ((Invoke-InstallerExitGuard @arguments) -eq 11) 'Query failure must fail closed.'
Assert-Guard ($script:InstallerGuardFailure.Stage -eq 'query' -and $script:InstallerGuardFailure.Message -eq 'Synthetic query denial') 'Query diagnostics must retain the exact reason without printing.'

$case = New-Scenario
$case.Arguments.ReadProcesses = {
    New-Snapshot 99101 'node.exe' ''
    New-Snapshot 99102 'ffplay.exe' ''
    New-Snapshot 99103 'ffmpeg.exe' ''
}
$arguments = $case.Arguments
Assert-Guard ((Invoke-InstallerExitGuard @arguments) -eq 0 -and $case.State.Killed.Count -eq 0) 'Unrelated inaccessible generic processes must not block an upgrade or be terminated.'

$case = New-Scenario
$case.Arguments.ReadProcesses = {
    New-Snapshot 99101 'guard-fixture.exe' 'C:\guard\guard-fixture.exe'
    New-Snapshot 99102 'ffplay.exe' '' 99101 1
}
$arguments = $case.Arguments
Assert-Guard ((Invoke-InstallerExitGuard @arguments) -eq 11) 'An owned media child with an unknown path must fail closed.'
Assert-Guard ($script:InstallerGuardFailure.Stage -eq 'identity-selection' -and $script:InstallerGuardFailure.Message.Contains('PID=99102')) 'Selection diagnostics must distinguish an uninspectable owned process.'

$case = New-Scenario
$case.Arguments.ReadProcesses = { New-Snapshot 99101 'guard-fixture.exe' '' }
$arguments = $case.Arguments
Assert-Guard ((Invoke-InstallerExitGuard @arguments) -eq 11) 'The known app executable with an unknown path must fail closed.'

$case = New-Scenario
$state = $case.State
$case.Arguments.ReadProcesses = {
    $state.Reads++
    if ($state.Reads -eq 1) {
        New-Snapshot 99101 'guard-fixture.exe' 'C:\guard\guard-fixture.exe'
        New-Snapshot 99102 'ffplay.exe' 'C:\external media\ffplay.exe' 99101 1
    } else {
        New-Snapshot 99102 'ffplay.exe' '' 99101 1
    }
}.GetNewClosure()
$arguments = $case.Arguments
Assert-Guard ((Invoke-InstallerExitGuard @arguments) -eq 11) 'A captured owned child with unreadable path stays owned after its parent disappears.'
Assert-Guard (($state.Killed -join ',') -eq '99101,99102' -and $state.Reads -eq 2) 'Only the proven parent and child should have been terminated before the unreadable orphan blocked verification.'

$case = New-Scenario
$state = $case.State
$case.Arguments.ReadProcesses = {
    $state.Reads++
    if ($state.Reads -eq 1) {
        New-Snapshot 99101 'guard-fixture.exe' 'C:\guard\guard-fixture.exe'
        New-Snapshot 99102 'ffplay.exe' 'C:\external media\ffplay.exe' 99101 1
    } else {
        New-Snapshot 99102 'ffplay.exe' '' 0 10
    }
}.GetNewClosure()
$arguments = $case.Arguments
Assert-Guard ((Invoke-InstallerExitGuard @arguments) -eq 0 -and ($state.Killed -join ',') -eq '99101,99102') 'A reused media PID must not inherit ownership from an exited process.'

$case = New-Scenario
$state = $case.State
$case.Arguments.ReadProcesses = {
    $state.Reads++
    if ($state.Reads -eq 1) { New-Snapshot 99101 'guard-fixture.exe' 'C:\guard\guard-fixture.exe' 0 10 }
    New-Snapshot 99102 'ffplay.exe' '' 99101 1
}.GetNewClosure()
$arguments = $case.Arguments
Assert-Guard ((Invoke-InstallerExitGuard @arguments) -eq 0 -and ($state.Killed -join ',') -eq '99101') 'An older unrelated child whose parent PID was reused must not become owned.'

$case = New-Scenario
$case.Arguments.ReadProcesses = { New-Snapshot 99101 'guard-fixture.exe' 'C:\guard\guard-fixture.exe' }
$case.Arguments.StopProcess = { throw 'Synthetic termination denial' }
$arguments = $case.Arguments
Assert-Guard ((Invoke-InstallerExitGuard @arguments) -eq 12) 'Termination failure must fail closed.'

$case = New-Scenario
$case.Arguments.ReadProcesses = { New-Snapshot 99101 'guard-fixture.exe' 'C:\guard\guard-fixture.exe' }
$arguments = $case.Arguments
Assert-Guard ((Invoke-InstallerExitGuard @arguments) -eq 13) 'A surviving process must time out.'
Assert-Guard ($case.State.Time -eq 8000) 'The helper must stop after its bounded budget.'

$case = New-Scenario
$state = $case.State
$case.Arguments.ReadProcesses = { $state.Time += 8000 }.GetNewClosure()
$arguments = $case.Arguments
Assert-Guard ((Invoke-InstallerExitGuard @arguments) -eq 13) 'An empty but late query is not success.'

$case = New-Scenario
$state = $case.State
$case.Arguments.ReadProcesses = {
    $state.Reads++
    if ($state.Reads -eq 2) { New-Snapshot 99101 'guard-fixture.exe' 'C:\guard\guard-fixture.exe' }
}.GetNewClosure()
$arguments = $case.Arguments
Assert-Guard ((Invoke-InstallerExitGuard @arguments) -eq 0 -and $state.Reads -eq 4) 'A respawn resets the empty-snapshot count.'
Write-Output 'PASS: shutdown orchestration failure, deadline, respawn and identity-selection scenarios'

# Exercise real Win32_Process snapshots and .NET process termination. Copies of
# Windows ping supply harmless, finite-lived fixtures without compiling an installer.
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('robot-installer-guard-' + [Guid]::NewGuid().ToString('N'))
$root = Join-Path $temporary "old app's directory"
$backend = Join-Path $root 'resources\backend'
$sibling = Join-Path $temporary 'unrelated app'
$executableName = 'guard-' + [Guid]::NewGuid().ToString('N') + '.exe'
$owned = [Collections.Generic.List[Diagnostics.Process]]::new()
$guard = $null
function Start-Fixture([string] $Path) {
    $info = [Diagnostics.ProcessStartInfo]::new($Path, '-n 60 127.0.0.1')
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $process = [Diagnostics.Process]::Start($info)
    $owned.Add($process)
    return $process
}
try {
    $null = New-Item -ItemType Directory -Path $backend, $sibling -Force
    $appPath = Join-Path $root $executableName
    $mediaPath = Join-Path $backend 'ffplay.exe'
    $unrelatedPath = Join-Path $sibling 'ffplay.exe'
    foreach ($destination in @($appPath, $mediaPath, $unrelatedPath)) {
        Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\ping.exe') -Destination $destination
    }
    $ui = Start-Fixture $appPath
    $utility = Start-Fixture $appPath
    $media = Start-Fixture $mediaPath
    $unrelated = Start-Fixture $unrelatedPath
    foreach ($fixture in $owned) { Assert-Guard (-not $fixture.HasExited) 'A live fixture failed to start.' }

    # A deliberately stale record must not kill a live process with that PID.
    $stale = New-Snapshot $unrelated.Id 'ffplay.exe' $unrelatedPath
    $stale.CreationDate = $unrelated.StartTime.AddMinutes(-1)
    Stop-InstallerProcess $stale
    Assert-Guard (-not $unrelated.HasExited) 'A stale PID identity killed an unrelated process.'

    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $diagnosticPath = Join-Path $temporary 'guard-failure.json'
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $helper + '" -InstallDirectory "' + $root + '" -AppExecutable "' + $executableName + '" -DiagnosticPath "' + $diagnosticPath + '"'
    $info = [Diagnostics.ProcessStartInfo]::new($powershell, $arguments)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $guard = [Diagnostics.Process]::Start($info)
    $stdout = $guard.StandardOutput.ReadToEndAsync()
    $stderr = $guard.StandardError.ReadToEndAsync()
    Assert-Guard ($guard.WaitForExit(10000)) 'The real Windows guard exceeded 10 seconds.'
    if ($guard.ExitCode -ne 0 -and (Test-Path -LiteralPath $diagnosticPath)) {
        Write-Output ('Windows guard diagnostic: ' + [IO.File]::ReadAllText($diagnosticPath))
    }
    Assert-Guard ($guard.ExitCode -eq 0) ('Windows guard failed with exit code ' + $guard.ExitCode)
    Assert-Guard ($stdout.Result.Length -eq 0 -and $stderr.Result.Length -eq 0) 'The helper must remain silent for the nsExec timeout.'
    foreach ($fixture in @($ui, $utility, $media)) { Assert-Guard ($fixture.WaitForExit(1000)) 'An owned process survived success.' }
    Assert-Guard (-not $unrelated.HasExited) 'An unrelated media process was terminated.'
    Write-Output 'PASS: real Windows query, UI/backend/media termination, PID reuse guard, literal paths and unrelated-process survival'
} finally {
    if ($guard) {
        if (-not $guard.HasExited) { $guard.Kill() }
        $guard.Dispose()
    }
    foreach ($fixture in $owned) {
        if (-not $fixture.HasExited) { $fixture.Kill(); $null = $fixture.WaitForExit(1000) }
        $fixture.Dispose()
    }
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
