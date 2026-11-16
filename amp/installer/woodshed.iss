#ifndef AppVersion
  #define AppVersion "2.0.0"
#endif
#ifndef BuildDir
  #define BuildDir "..\build"
#endif
#ifndef SiteDir
  #define SiteDir "..\..\woodshed"
#endif
#ifndef ExtDir
  #define ExtDir "..\..\woodshed-tab-grabber"
#endif
#ifndef OutDir
  #define OutDir "..\dist"
#endif

[Setup]
AppId={{6E2B4C1A-3F7D-4B9E-9A51-2C8D0F4E7B13}
AppName=Woodshed
AppVersion={#AppVersion}
AppPublisher=Woodshed
AppPublisherURL=https://sage-sage.github.io/woodshed/
DefaultDirName={localappdata}\Programs\Woodshed
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
DefaultGroupName=Woodshed
WizardStyle=modern
SetupIconFile=..\src\desktop\woodshed.ico
UninstallDisplayIcon={app}\woodshed.exe
UninstallDisplayName=Woodshed
OutputDir={#OutDir}
OutputBaseFilename=Woodshed-Setup
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
LicenseFile=license.txt
CloseApplications=no
UsePreviousTasks=yes
MinVersion=10.0

[Types]
Name: "full"; Description: "Everything"
Name: "custom"; Description: "Pick what to install"; Flags: iscustom

[Components]
Name: "app"; Description: "Woodshed app (the game in its own window, works offline)"; Types: full custom
Name: "amp"; Description: "Woodshed Amp (low-latency guitar input and amp tones, runs in the tray)"; Types: full custom
Name: "ext"; Description: "Tab Grabber for Chrome (saves tabs from tab sites into Woodshed)"; Types: full

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Components: app
Name: "ampstartup"; Description: "Start Woodshed Amp when Windows starts"; Components: amp; Flags: unchecked

[Files]
Source: "{#BuildDir}\woodshed.exe"; DestDir: "{app}"; Components: app; Flags: ignoreversion
Source: "{#BuildDir}\WebView2Loader.dll"; DestDir: "{app}"; Components: app; Flags: ignoreversion
Source: "{#SiteDir}\*"; DestDir: "{app}\site"; Components: app; Excludes: "test\*,tools\*,downloads\*,*.md,package.json"; Flags: ignoreversion recursesubdirs
Source: "{#BuildDir}\woodshed-amp.exe"; DestDir: "{app}"; Components: amp; Flags: ignoreversion
Source: "{#ExtDir}\*"; DestDir: "{app}\Tab Grabber"; Components: ext; Excludes: "tests\*,node_modules\*,package.json"; Flags: ignoreversion recursesubdirs
Source: "tab-grabber-howto.html"; DestDir: "{app}\Tab Grabber"; Components: ext; Flags: ignoreversion
Source: "license.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Woodshed"; Filename: "{app}\woodshed.exe"; Components: app
Name: "{group}\Woodshed Amp"; Filename: "{app}\woodshed-amp.exe"; Components: amp
Name: "{autodesktop}\Woodshed"; Filename: "{app}\woodshed.exe"; Tasks: desktopicon
Name: "{group}\Uninstall Woodshed"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\woodshed-amp.exe"; Parameters: "--autostart=on"; Tasks: ampstartup; Flags: nowait runasoriginaluser
Filename: "{app}\woodshed-amp.exe"; Components: amp; Check: IsAmpOnlyInteractive; Description: "Start Woodshed Amp"; Flags: postinstall nowait
Filename: "{app}\woodshed.exe"; Components: app; Description: "Launch Woodshed"; Flags: postinstall nowait skipifsilent
Filename: "{app}\Tab Grabber\tab-grabber-howto.html"; Components: ext; Description: "Show how to add Tab Grabber to Chrome"; Flags: postinstall shellexec skipifsilent

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "WoodshedAmp"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Woodshed\Desktop"; Flags: uninsdeletekeyifempty
Root: HKCU; Subkey: "Software\Woodshed"; Flags: uninsdeletekeyifempty

[UninstallDelete]
Type: filesandordirs; Name: "{app}\site"
Type: filesandordirs; Name: "{app}\Tab Grabber"

[Code]
var
  WasAppRunning: Boolean;
  WasAmpRunning: Boolean;

function RegisterWindowMessageW(lpString: string): UINT;
  external 'RegisterWindowMessageW@user32.dll stdcall';
function PostMessageW(hWnd: HWND; Msg: UINT; wParam, lParam: Longint): BOOL;
  external 'PostMessageW@user32.dll stdcall';

function IsAmpOnlyInteractive: Boolean;
begin
  Result := (not WizardIsComponentSelected('app')) and (not WizardSilent);
end;

function CloseRunningAppsAndWait(var ErrorMsg: string): Boolean;
var
  QuitMsg: UINT;
  I: Integer;
begin
  WasAppRunning := (FindWindowByClassName('WoodshedAppWindow') <> 0) or
                   CheckForMutexes('WoodshedAppSingleInstance');
  WasAmpRunning := (FindWindowByClassName('WoodshedAmpTrayWindowClass') <> 0) or
                   CheckForMutexes('WoodshedAmpSingleInstance');

  if not CheckForMutexes('WoodshedAppSingleInstance,WoodshedAmpSingleInstance') then
  begin
    Result := True;
    Exit;
  end;

  QuitMsg := RegisterWindowMessageW('WoodshedQuitForUpdate');
  if QuitMsg <> 0 then
    PostMessageW(HWND_BROADCAST, QuitMsg, 0, 0);

  for I := 1 to 50 do
  begin
    if not CheckForMutexes('WoodshedAppSingleInstance,WoodshedAmpSingleInstance') then
    begin
      Result := True;
      Exit;
    end;
    Sleep(200);
  end;

  ErrorMsg := 'Please close Woodshed and Woodshed Amp, then try again.';
  Result := False;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Err: string;
begin
  if CloseRunningAppsAndWait(Err) then
    Result := ''
  else
    Result := Err;
end;

function InitializeUninstall(): Boolean;
var
  Err: string;
begin
  if CloseRunningAppsAndWait(Err) then
    Result := True
  else
  begin
    if not UninstallSilent then
      MsgBox(Err, mbError, MB_OK);
    Result := False;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = wpSelectComponents then
  begin
    if (not WizardIsComponentSelected('app')) and (not WizardIsComponentSelected('amp')) then
    begin
      MsgBox('Pick the Woodshed app, Woodshed Amp, or both.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  AppDir: string;
  ExePath: string;
  ResultCode: Integer;
begin
  AppDir := ExpandConstant('{app}');

  if CurStep = ssInstall then
  begin
    if not WizardIsComponentSelected('app') then
    begin
      DeleteFile(AddBackslash(AppDir) + 'woodshed.exe');
      DeleteFile(AddBackslash(AppDir) + 'WebView2Loader.dll');
      DelTree(AddBackslash(AppDir) + 'site', True, True, True);
    end;
    if not WizardIsComponentSelected('amp') then
    begin
      DeleteFile(AddBackslash(AppDir) + 'woodshed-amp.exe');
    end;
    if not WizardIsComponentSelected('ext') then
    begin
      DelTree(AddBackslash(AppDir) + 'Tab Grabber', True, True, True);
    end;
  end
  else if CurStep = ssPostInstall then
  begin
    if Pos('/RELAUNCH', Uppercase(GetCmdTail)) > 0 then
    begin
      if WasAppRunning and WizardIsComponentSelected('app') then
      begin
        ExePath := AddBackslash(AppDir) + 'woodshed.exe';
        if FileExists(ExePath) then
          Exec(ExePath, '', AppDir, SW_SHOWNORMAL, ewNoWait, ResultCode);
      end;
      if WasAmpRunning and WizardIsComponentSelected('amp') then
      begin
        ExePath := AddBackslash(AppDir) + 'woodshed-amp.exe';
        if FileExists(ExePath) then
          Exec(ExePath, '', AppDir, SW_SHOWNORMAL, ewNoWait, ResultCode);
      end;
    end;
  end;
end;

