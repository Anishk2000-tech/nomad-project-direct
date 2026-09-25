; Project NOMAD — Windows installer (NSIS 3, Modern UI 2)
;
; Installs the Docker-free native edition: the NOMAD admin app, bundled runtimes (Node.js,
; MariaDB, Redis, pmtiles) and a Windows service (WinSW) that runs everything in the background.
;
; Build (from native/installer/windows):
;   makensis /DVERSION=1.34.1 /DVIVERSION=1.34.1.0 /DSTAGE=<staged folder> /DOUTFILE=<setup.exe> nomad.nsi
;
; Command line (in addition to NSIS's /S and /D=<install dir>):
;   /DATA=<folder>   data folder for silent installs (default: previous one, else C:\ProjectNOMAD)
;   /NOSTART         install without starting the service
;   /UPDATE          (used by the in-app updater) silent upgrade of an existing install
; Uninstaller: /PURGE also deletes the data folder (otherwise data is always kept when silent).

Unicode true
ManifestDPIAware true
RequestExecutionLevel admin
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef VIVERSION
  !define VIVERSION "0.0.0.0"
!endif
!ifndef STAGE
  !error "Pass /DSTAGE=<folder produced by native/scripts/stage-app.mjs + fetch-windows-runtimes.mjs>"
!endif
!ifndef OUTFILE
  !define OUTFILE "ProjectNOMAD-Setup-${VERSION}.exe"
!endif

!define PRODUCT "Project NOMAD"
!define SERVICE_EXE "$INSTDIR\service\ProjectNOMAD.exe"
!define NODE_EXE "$INSTDIR\runtime\node\node.exe"
!define NOMADCTL "$INSTDIR\native\launcher\nomadctl.mjs"
!define REGKEY "Software\ProjectNOMAD"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ProjectNOMAD"
!define UNINSTALLER "Uninstall Project NOMAD.exe"
!define WEBURL "http://localhost:8080"
!define LOGSURL "http://localhost:9999"
!define FIREWALL_RULE "Project NOMAD"
!define FIREWALL_PORTS "8080,8090,8100,8200,8310,8311,8400-8500"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WinVer.nsh"
!include "x64.nsh"

Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\Project NOMAD"
BrandingText "Project NOMAD ${VERSION} - Windows edition (no Docker)"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VIVERSION}"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "Project NOMAD Setup"
VIAddVersionKey "CompanyName" "Project NOMAD (community Windows build)"
VIAddVersionKey "LegalCopyright" "Apache-2.0. Project NOMAD by Crosstalk Solutions, LLC"

Var DataDir
Var IsUpgrade
Var NoStart

; ── Modern UI ────────────────────────────────────────────────────────────────
!define MUI_ICON "nomad.ico"
!define MUI_UNICON "nomad.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "welcome.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "welcome.bmp"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "header.bmp"
!define MUI_HEADERIMAGE_RIGHT
!define MUI_ABORTWARNING
!define MUI_COMPONENTSPAGE_NODESC

!define MUI_WELCOMEPAGE_TITLE "Welcome to Project NOMAD"
!define MUI_WELCOMEPAGE_TEXT "This will install Project NOMAD, an offline knowledge and education server, directly on Windows. Docker and WSL are not needed.$\r$\n$\r$\nProject NOMAD runs in the background as a Windows service. You use it in your web browser at ${WEBURL}, and other devices on your home network can use it too.$\r$\n$\r$\nAn internet connection is needed while you download apps and content. After that, everything works offline.$\r$\n$\r$\nClick Next to continue."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${STAGE}\LICENSE.txt"
!insertmacro MUI_PAGE_COMPONENTS

!define MUI_DIRECTORYPAGE_TEXT_TOP "Setup will install the Project NOMAD program files in the following folder. (Your content goes in a separate data folder, chosen on the next page.)"
!insertmacro MUI_PAGE_DIRECTORY

!define MUI_PAGE_HEADER_TEXT "Choose Data Folder"
!define MUI_PAGE_HEADER_SUBTEXT "Choose where Project NOMAD keeps your content."
!define MUI_DIRECTORYPAGE_TEXT_TOP "Project NOMAD stores everything it downloads in this folder: offline Wikipedia and other libraries, maps, AI models, notes and its database. This can grow to hundreds of gigabytes, so choose a drive with plenty of free space.$\r$\n$\r$\nUpgrading? Keep the folder you used before and all your content stays."
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "Data folder"
!define MUI_DIRECTORYPAGE_VARIABLE $DataDir
!define MUI_DIRECTORYPAGE_VERIFYONLEAVE
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ValidateDataDir
!insertmacro MUI_PAGE_DIRECTORY

!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "Project NOMAD is ready"
!define MUI_FINISHPAGE_TEXT "Project NOMAD is installed and running in the background.$\r$\n$\r$\nOpen it from the Start menu or go to ${WEBURL} in your browser. Other devices on your network can use http://<this computer's name>:8080.$\r$\n$\r$\nStart with Easy Setup to choose the content and tools you want."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open Project NOMAD now"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenDashboard
!define MUI_FINISHPAGE_NOREBOOTSUPPORT
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ── Helpers ──────────────────────────────────────────────────────────────────

; Stop and remove the service if it exists, then make sure no NOMAD process is left running
; (a running node.exe/mariadbd.exe would lock files we are about to replace or delete).
!macro StopNomad
  ${If} ${FileExists} "${SERVICE_EXE}"
    DetailPrint "Stopping the Project NOMAD service (this can take up to a minute)..."
    nsExec::ExecToLog '"${SERVICE_EXE}" stop'
    Pop $0
    nsExec::ExecToLog '"${SERVICE_EXE}" uninstall'
    Pop $0
  ${EndIf}
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$d = @('$INSTDIR\*', '$DataDir\engine\*'); Get-Process | Where-Object { $$p = $$_.Path; $$p -and ($$d | Where-Object { $$p -like $$_ }) } | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $0
  Sleep 1500
!macroend

Function OpenDashboard
  ExecShell "open" "${WEBURL}"
FunctionEnd

Function ValidateDataDir
  ; Drop a trailing backslash, and turn a bare drive ("D:") into D:\ProjectNOMAD.
  StrCpy $0 $DataDir 1 -1
  ${If} $0 == "\"
    StrCpy $DataDir $DataDir -1
  ${EndIf}
  StrLen $0 $DataDir
  ${If} $0 <= 2
    StrCpy $DataDir "$DataDir\ProjectNOMAD"
  ${EndIf}
  ${GetRoot} $DataDir $1
  ${DriveSpace} "$1\" "/D=F /S=G" $2
  ${If} $2 < 20
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "The drive for the data folder has only $2 GB free. Project NOMAD content usually needs much more (Wikipedia alone can be over 100 GB).$\r$\n$\r$\nUse this folder anyway?" IDYES +2
    Abort
  ${EndIf}
FunctionEnd

; ── Install ──────────────────────────────────────────────────────────────────

Section "Project NOMAD (required)" SecCore
  SectionIn RO
  SetShellVarContext all
  SetRegView 64

  !insertmacro StopNomad

  ; Replace program folders. app\storage is a junction to the user's data: remove the link
  ; itself first so deleting the old app folder can never touch content.
  RMDir "$INSTDIR\app\storage"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\native"
  RMDir /r "$INSTDIR\runtime"

  DetailPrint "Copying program files..."
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*.*"
  File "nomad.ico"
  File "restart-nomad.cmd"
  File "nomad-status.cmd"
  SetOutPath "$INSTDIR\service"
  File "ProjectNOMAD.xml"
  SetOutPath "$INSTDIR"

  ; Data folder. The config subfolder holds generated passwords: SYSTEM and Administrators only.
  CreateDirectory "$DataDir"
  CreateDirectory "$DataDir\config"
  nsExec::ExecToLog 'icacls "$DataDir\config" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"'
  Pop $0
  FileOpen $0 "$INSTDIR\data-location.txt" w
  FileWrite $0 "$DataDir"
  FileClose $0

  ; Registry + uninstaller
  WriteRegStr HKLM "${REGKEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${REGKEY}" "DataDir" "$DataDir"
  WriteRegStr HKLM "${REGKEY}" "Version" "${VERSION}"
  WriteUninstaller "$INSTDIR\${UNINSTALLER}"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTKEY}" "Publisher" "Project NOMAD (community Windows build)"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\nomad.ico"
  WriteRegStr HKLM "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTKEY}" "UninstallString" '"$INSTDIR\${UNINSTALLER}"'
  WriteRegStr HKLM "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\${UNINSTALLER}" /S'
  WriteRegStr HKLM "${UNINSTKEY}" "URLInfoAbout" "https://www.projectnomad.us"
  WriteRegStr HKLM "${UNINSTKEY}" "HelpLink" "https://www.projectnomad.us"
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${UNINSTKEY}" "EstimatedSize" "$0"

  ; Let devices on private (home) networks reach the dashboard and apps. Public networks stay closed.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${FIREWALL_RULE}"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${FIREWALL_RULE}" dir=in action=allow protocol=TCP localport=${FIREWALL_PORTS} profile=private,domain description="Project NOMAD dashboard and apps (local network access)"'
  Pop $0

  ; Start menu
  RMDir /r "$SMPROGRAMS\Project NOMAD"
  CreateDirectory "$SMPROGRAMS\Project NOMAD"
  WriteINIStr "$SMPROGRAMS\Project NOMAD\Project NOMAD.url" "InternetShortcut" "URL" "${WEBURL}"
  WriteINIStr "$SMPROGRAMS\Project NOMAD\Project NOMAD.url" "InternetShortcut" "IconFile" "$INSTDIR\nomad.ico"
  WriteINIStr "$SMPROGRAMS\Project NOMAD\Project NOMAD.url" "InternetShortcut" "IconIndex" "0"
  WriteINIStr "$SMPROGRAMS\Project NOMAD\NOMAD Logs.url" "InternetShortcut" "URL" "${LOGSURL}"
  WriteINIStr "$SMPROGRAMS\Project NOMAD\NOMAD Logs.url" "InternetShortcut" "IconFile" "$INSTDIR\nomad.ico"
  WriteINIStr "$SMPROGRAMS\Project NOMAD\NOMAD Logs.url" "InternetShortcut" "IconIndex" "0"
  CreateShortcut "$SMPROGRAMS\Project NOMAD\NOMAD Data Folder.lnk" "$DataDir"
  CreateShortcut "$SMPROGRAMS\Project NOMAD\NOMAD Status.lnk" "$INSTDIR\nomad-status.cmd" "" "$INSTDIR\nomad.ico"
  CreateShortcut "$SMPROGRAMS\Project NOMAD\Restart NOMAD.lnk" "$INSTDIR\restart-nomad.cmd" "" "$INSTDIR\nomad.ico"
  CreateShortcut "$SMPROGRAMS\Project NOMAD\Uninstall Project NOMAD.lnk" "$INSTDIR\${UNINSTALLER}"

  ; Windows service
  DetailPrint "Registering the Project NOMAD Windows service..."
  nsExec::ExecToLog '"${SERVICE_EXE}" install'
  Pop $0
  ${If} $0 != 0
    DetailPrint "WARNING: could not register the service (exit code $0)."
  ${EndIf}
  ${If} $NoStart != 1
    nsExec::ExecToLog '"${SERVICE_EXE}" start'
    Pop $0
    DetailPrint "Starting Project NOMAD for the first time (this can take a minute or two)..."
    nsExec::ExecToLog '"${NODE_EXE}" "${NOMADCTL}" wait --install-dir "$INSTDIR" --timeout 300'
    Pop $0
    ${If} $0 != 0
      DetailPrint "Project NOMAD is still starting; it will be available at ${WEBURL} shortly."
    ${EndIf}
  ${EndIf}
SectionEnd

Section "Desktop shortcut" SecDesktop
  SetShellVarContext all
  WriteINIStr "$DESKTOP\Project NOMAD.url" "InternetShortcut" "URL" "${WEBURL}"
  WriteINIStr "$DESKTOP\Project NOMAD.url" "InternetShortcut" "IconFile" "$INSTDIR\nomad.ico"
  WriteINIStr "$DESKTOP\Project NOMAD.url" "InternetShortcut" "IconIndex" "0"
SectionEnd

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Project NOMAD requires 64-bit Windows 10 or newer."
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "Project NOMAD requires Windows 10 or newer."
    Abort
  ${EndIf}
  SetRegView 64

  StrCpy $IsUpgrade 0
  ReadRegStr $0 HKLM "${REGKEY}" "InstallDir"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
    StrCpy $IsUpgrade 1
  ${EndIf}
  ReadRegStr $DataDir HKLM "${REGKEY}" "DataDir"
  ${If} $DataDir == ""
    StrCpy $0 $WINDIR 2
    StrCpy $DataDir "$0\ProjectNOMAD"
  ${EndIf}

  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/DATA=" $R1
  ${IfNot} ${Errors}
    StrCpy $DataDir $R1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/NOSTART" $R1
  ${IfNot} ${Errors}
    StrCpy $NoStart 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/UPDATE" $R1
  ${IfNot} ${Errors}
    SetSilent silent
  ${EndIf}
FunctionEnd

; ── Uninstall ────────────────────────────────────────────────────────────────

Section "Uninstall"
  SetShellVarContext all
  SetRegView 64
  ReadRegStr $DataDir HKLM "${REGKEY}" "DataDir"

  !insertmacro StopNomad

  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${FIREWALL_RULE}"'
  Pop $0
  RMDir /r "$SMPROGRAMS\Project NOMAD"
  Delete "$DESKTOP\Project NOMAD.url"

  ; Unlink app\storage before removing program files so user content is never touched.
  RMDir "$INSTDIR\app\storage"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${UNINSTKEY}"
  DeleteRegKey HKLM "${REGKEY}"

  ${If} $DataDir != ""
  ${AndIf} ${FileExists} "$DataDir\*.*"
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/PURGE" $R1
    ${IfNot} ${Errors}
      Goto purge
    ${EndIf}
    ${If} ${Silent}
      Goto keep
    ${EndIf}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete all Project NOMAD data?$\r$\n$\r$\n$DataDir$\r$\n$\r$\nThis removes your downloaded content, AI models, notes and database. Choose No to keep it; if you reinstall later and choose the same data folder, everything will still be there." IDYES purge IDNO keep
    purge:
      DetailPrint "Deleting $DataDir..."
      RMDir /r "$DataDir"
      Goto done
    keep:
      DetailPrint "Kept your data in $DataDir"
    done:
  ${EndIf}
SectionEnd
