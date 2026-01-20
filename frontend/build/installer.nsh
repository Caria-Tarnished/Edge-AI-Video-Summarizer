!macro preInit
  nsExec::ExecToLog '"$SYSDIR\\taskkill.exe" /F /T /IM "llama-server.exe"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\\taskkill.exe" /F /T /IM "edge-video-agent-backend.exe"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\\taskkill.exe" /F /T /IM "Edge Video Agent.exe"'
  Pop $0
  Sleep 800
!macroend

!macro customUnInit
  nsExec::ExecToLog '"$SYSDIR\\taskkill.exe" /F /T /IM "llama-server.exe"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\\taskkill.exe" /F /T /IM "edge-video-agent-backend.exe"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\\taskkill.exe" /F /T /IM "Edge Video Agent.exe"'
  Pop $0
  Sleep 800
!macroend

!macro customUnInstall
  nsExec::ExecToLog '"$SYSDIR\\taskkill.exe" /F /T /IM "llama-server.exe"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\\taskkill.exe" /F /T /IM "edge-video-agent-backend.exe"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\\taskkill.exe" /F /T /IM "Edge Video Agent.exe"'
  Pop $0
  Sleep 800
!macroend
