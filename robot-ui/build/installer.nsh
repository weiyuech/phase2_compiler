; installer.nsh — 自定义 NSIS 安装宏

; 1. Confirm the old UI, utility backends and bundled media processes have exited.
; This hook also runs in the uninstaller, before electron-builder removes files.
!macro customCheckAppRunning
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  InitPluginsDir
  File /oname=$PLUGINSDIR\installer-exit-guard.ps1 "${BUILD_RESOURCES_DIR}\installer-exit-guard.ps1"
  StrCpy $2 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ; The installer bootstrapper is 32-bit. Use native PowerShell when available
  ; so process inspection matches the x64 app and the Windows verification job.
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $2 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ; Small fixed files in TEMP provide evidence even if PowerShell cannot start
  ; or the native wait times out. No settings, keys, or speech content are logged.
  FileOpen $3 "$TEMP\robot-live-installer-exit-status.log" w
  FileWrite $3 "phase=guard-start$\r$\npowershell=$2$\r$\n"
  FileClose $3
  FileOpen $3 "$TEMP\robot-live-installer-exit-diagnostic.json" w
  FileWrite $3 '{"Phase":"not-started"}$\r$\n'
  FileClose $3
  DetailPrint "正在关闭旧版本并确认后台进程退出（最多 10 秒）..."
  ; Launch directly: nsExec supplies the write end of a pipe as child stdin,
  ; which can block PowerShell before -File even when -InputFormat None is set.
  ; CREATE_NO_WINDOW and no inherited handles avoid that console/stdio contract.
  ; -File arguments keep spaces/apostrophes in installation paths literal.
  ; Append \. so even a drive-root path never ends in a backslash before a quote.
  StrCpy $1 `"$2" -NoLogo -NoProfile -NonInteractive -InputFormat None -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-exit-guard.ps1" -InstallDirectory "$INSTDIR\." -AppExecutable "${APP_EXECUTABLE_FILENAME}" -DiagnosticPath "$TEMP\robot-live-installer-exit-diagnostic.json"`
  StrCpy $0 "error"
  StrCpy $4 0
  StrCpy $5 0
  StrCpy $6 0
  StrCpy $7 0
  ; NSIS silently truncates long strings. Refuse a full command buffer instead
  ; of accidentally passing an incomplete path or dropping a safety argument.
  StrLen $8 $1
  IntOp $9 ${NSIS_MAX_STRLEN} - 1
  ${If} $8 >= $9
    StrCpy $0 "command-too-long"
  ${Else}
    ; electron-builder's NSIS bootstrapper is x86: these are the Win32 layouts,
    ; independent of the x64 PowerShell child. System::Alloc zeroes both buffers.
    System::Alloc 68
    Pop $4
    System::Alloc 16
    Pop $5
    ${If} $4 != 0
    ${AndIf} $5 != 0
      System::Call '*$4(i 68)'
      ; bInheritHandles=FALSE, CREATE_NO_WINDOW, environment inherited, safe cwd.
      System::Call 'kernel32::CreateProcessW(w r2, w r1, p 0, p 0, i 0, i 0x08000000, p 0, w "$WINDIR", p r4, p r5) i.r9 ?e'
      Pop $8
      ${If} $9 == 0
        StrCpy $0 "create-error-$8"
      ${Else}
        System::Call '*$5(p.r6, p.r7)'
        System::Call 'kernel32::WaitForSingleObject(p r6, i 10000) i.r8 ?e'
        Pop $9
        ${If} $8 == 0
          System::Call 'kernel32::GetExitCodeProcess(p r6, *i.r0) i.r9'
          ${If} $9 == 0
            StrCpy $0 "exit-code-error"
          ${EndIf}
        ${Else}
          ${If} $8 == 258
            StrCpy $0 "timeout"
          ${Else}
            StrCpy $0 "wait-error-$9"
          ${EndIf}
          ; Terminate only the helper we created. Installation always aborts on
          ; this path; neither output nor child activity can extend the deadline.
          System::Call 'kernel32::TerminateProcess(p r6, i 1) i.r9'
        ${EndIf}
      ${EndIf}
    ${Else}
      StrCpy $0 "memory-error"
    ${EndIf}
  ${EndIf}
  ${If} $7 != 0
    System::Call 'kernel32::CloseHandle(p r7) i.r9'
  ${EndIf}
  ${If} $6 != 0
    System::Call 'kernel32::CloseHandle(p r6) i.r9'
  ${EndIf}
  ${If} $5 != 0
    System::Free $5
  ${EndIf}
  ${If} $4 != 0
    System::Free $4
  ${EndIf}
  FileOpen $3 "$TEMP\robot-live-installer-exit-status.log" a
  FileSeek $3 0 END
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
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
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
