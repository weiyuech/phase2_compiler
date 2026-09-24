; installer.nsh — 自定义 NSIS 安装宏

; 1. Confirm the old UI, utility backends and bundled media processes have exited.
; This hook also runs in the uninstaller, before electron-builder removes files.
!macro customCheckAppRunning
  Push $0
  Push $1
  Push $2
  Push $3
  InitPluginsDir
  File /oname=$PLUGINSDIR\installer-exit-guard.ps1 "${BUILD_RESOURCES_DIR}\installer-exit-guard.ps1"
  StrCpy $2 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ; The installer bootstrapper is 32-bit. Use native PowerShell when available
  ; so process inspection matches the x64 app and the Windows verification job.
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $2 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ; Small fixed files in TEMP provide evidence even if PowerShell cannot start
  ; or nsExec terminates it. These contain no settings, keys, or speech content.
  FileOpen $3 "$TEMP\robot-live-installer-exit-status.log" w
  FileWrite $3 "phase=guard-start$\r$\npowershell=$2$\r$\n"
  FileClose $3
  FileOpen $3 "$TEMP\robot-live-installer-exit-diagnostic.json" w
  FileWrite $3 '{"Phase":"not-started"}$\r$\n'
  FileClose $3
  DetailPrint "正在关闭旧版本并确认后台进程退出（最多 10 秒）..."
  ; The helper writes no stdout/stderr: nsExec's inactivity timeout therefore
  ; bounds the entire PowerShell invocation, including startup or a stuck CIM call.
  ; Use -File arguments so spaces/apostrophes in installation paths stay literal.
  ; Append \. so even a drive-root path never ends in a backslash before a quote.
  nsExec::Exec /TIMEOUT=10000 `"$2" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-exit-guard.ps1" -InstallDirectory "$INSTDIR\." -AppExecutable "${APP_EXECUTABLE_FILENAME}" -DiagnosticPath "$TEMP\robot-live-installer-exit-diagnostic.json"`
  Pop $0
  FileOpen $3 "$TEMP\robot-live-installer-exit-status.log" a
  FileWrite $3 "phase=guard-completed$\r$\nresult=$0$\r$\n"
  FileClose $3
  ${If} $0 != 0
    StrCpy $1 "无法启动或完成进程检查。"
    ${If} $0 == 11
      StrCpy $1 "无法查询或确认后台进程的身份。"
    ${ElseIf} $0 == 12
      StrCpy $1 "无法结束旧版本或后台进程，可能缺少权限。"
    ${ElseIf} $0 == 13
      StrCpy $1 "等待后台进程退出超时。"
    ${ElseIf} $0 == "timeout"
      StrCpy $1 "进程检查超时。"
    ${EndIf}
    DetailPrint "旧版本退出确认失败（状态 $0），已停止安装/卸载。"
    MessageBox MB_OK|MB_ICONSTOP "$1（状态 $0）$\r$\n操作已停止，用户数据未被清理。$\r$\n$\r$\n请退出机器人直播控制台及其后台程序后重试；若权限不足，请以管理员身份运行安装程序。仍失败时，请重启 Windows 后重试。$\r$\n诊断日志：$TEMP\robot-live-installer-exit-status.log" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  DetailPrint "已确认旧版本及后台进程退出。"
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; 2. ONNX Runtime requires the x64 MSVC runtime on end-user PCs.
; Always run the bundled bootstrapper: Installed=1 can describe an older runtime.
; The Microsoft bootstrapper handles elevation and an already-current runtime.
!macro customInstall
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
  DetailPrint "正在安装 OCR 所需的 Microsoft Visual C++ x64 运行库..."
  ClearErrors
  ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart /log "$TEMP\robot-live-vc-redist.log"' $0
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "无法启动 Visual C++ 运行库安装程序，弹幕识别将不可用。请重新运行安装程序。" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  ${If} $0 == 3010
    SetRebootFlag true
  ${ElseIf} $0 == 1638
    ; A newer compatible runtime is already installed.
    DetailPrint "已安装更新版本的 Visual C++ 运行库。"
  ${ElseIf} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Visual C++ 运行库安装失败（错误码 $0）。请安装微软官方 x64 运行库后重试。日志：$TEMP\robot-live-vc-redist.log" /SD IDOK
    SetErrorLevel $0
    Abort
  ${EndIf}
  SetOutPath "$INSTDIR"
!macroend
