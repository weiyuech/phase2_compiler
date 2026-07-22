; installer.nsh — 自定义 NSIS 安装宏

; 1. 安装前强制关闭旧版本，替换默认弹窗逻辑
!macro customCheckAppRunning
  DetailPrint "正在关闭运行中的旧版本..."
  nsExec::ExecToLog `taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T`
  Sleep 1500
!macroend

; 2. 安装后静默安装 Visual C++ 2022 运行库（@ngrok/ngrok 原生模块依赖）
;    检查注册表，仅在未安装时才运行，对已有用户完全透明
!macro customInstall
;   ReadRegDword $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
;   ${If} $0 != 1
;     DetailPrint "正在安装 Visual C++ 2022 运行库（首次安装需要）..."
;     SetOutPath $TEMP
;     File "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
;     ExecWait '"$TEMP\vc_redist.x64.exe" /install /quiet /norestart'
;     Delete "$TEMP\vc_redist.x64.exe"
;     SetOutPath $INSTDIR
;   ${EndIf}
!macroend
