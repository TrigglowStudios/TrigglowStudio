; Install to %LOCALAPPDATA%\Trigglow instead of electron-builder's default %LOCALAPPDATA%\Programs\<package name>
; (which came out as "@trigglowdesktop" from the scoped package name).
!macro customInit
  StrCpy $INSTDIR "$LOCALAPPDATA\Trigglow"
!macroend
