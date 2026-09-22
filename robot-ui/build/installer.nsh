; installer.nsh — 自定义 NSIS 安装宏

; 1. 安装前强制关闭旧版本，替换默认弹窗逻辑
!macro customCheckAppRunning
  DetailPrint "正在关闭运行中的旧版本..."
  nsExec::ExecToLog `taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T`
  Sleep 1500
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
