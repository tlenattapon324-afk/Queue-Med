[Setup]
AppName=ระบบคิว (Queue System)
AppVersion=2.6.0
AppVerName=ระบบคิว (Queue System) v2.6.0
AppPublisher=Hospital Queue System
AppId={{A3F2C1D0-4E5B-6F7A-8B9C-0D1E2F3A4B5C}
DefaultDirName={autopf}\QueueSystem
OutputDir=.
OutputBaseFilename=Queue-Setup-Full
SetupIconFile=..\assets\icons\setup.ico
WizardSmallImageFile=..\assets\icons\wizard-small-55.bmp,..\assets\icons\wizard-small-110.bmp
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
PrivilegesRequired=admin
UninstallDisplayName=ระบบคิว (Queue System)
UninstallDisplayIcon={app}\app.ico
CloseApplications=no
MinVersion=6.1

[Languages]
Name: "thai"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon";  Description: "สร้าง Shortcut บน Desktop (เปิดระบบคิวในเบราว์เซอร์)"; GroupDescription: "ตัวเลือกเพิ่มเติม:"; Flags: checkedonce
Name: "firewall";     Description: "เปิด Firewall อนุญาต Port 3000 (สำหรับเชื่อมต่อจากเครื่องอื่นใน LAN)"; GroupDescription: "ตัวเลือกเพิ่มเติม:"; Flags: checkedonce

[Files]
; ── โปรแกรมหลัก ──────────────────────────────────────────────────────────
Source: "QueueServer.exe";     DestDir: "{app}";          Flags: ignoreversion
Source: "..\assets\icons\app.ico"; DestDir: "{app}";      Flags: ignoreversion
Source: "nssm.exe";            DestDir: "{app}\tools";    Flags: ignoreversion
; ── เสียงเรียกคิว Google TTS (ใช้ได้แม้ไม่มีอินเทอร์เน็ต — tools/make-tts-clips.js) ──
Source: "..\tts-clips\*";      DestDir: "{app}\tts-clips"; Flags: ignoreversion
; ── หน้าเว็บ ─────────────────────────────────────────────────────────────
Source: "..\public\*";         DestDir: "{app}\public";   Flags: ignoreversion recursesubdirs createallsubdirs
; ── ค่าตั้งต้น (เฉพาะติดตั้งใหม่ครั้งแรก — ไม่ทับข้อมูลเดิมตอนอัปเกรด, ไม่รวมข้อมูลเชื่อมต่อฐานข้อมูล) ──
Source: "data-defaults\*";     DestDir: "{app}\data";     Flags: onlyifdoesntexist recursesubdirs createallsubdirs

[Dirs]
Name: "{app}\data"
Name: "{app}\logs"

[Icons]
; Start Menu
Name: "{group}\เปิดระบบคิว";                    Filename: "{app}\open-queue.url";         IconFilename: "{app}\app.ico"; Comment: "เปิดระบบคิวในเบราว์เซอร์"
Name: "{group}\หยุด Queue System Service";       Filename: "{app}\tools\nssm.exe";         Parameters: "stop QueueSystem"; IconFilename: "{app}\app.ico"
Name: "{group}\เริ่ม Queue System Service";      Filename: "{app}\tools\nssm.exe";         Parameters: "start QueueSystem"; IconFilename: "{app}\app.ico"
Name: "{group}\ถอนการติดตั้ง";                  Filename: "{uninstallexe}"
; Desktop
Name: "{commondesktop}\ระบบคิว";                Filename: "{app}\open-queue.url";         IconFilename: "{app}\app.ico"; Tasks: desktopicon; Comment: "เปิดระบบคิว (Queue System)"

[Code]

// ── ถอนการติดตั้งเวอร์ชันเก่าอัตโนมัติ ──────────────────────────────────
function GetOldUninstallString(): String;
var
  RegKey, UninstStr: String;
begin
  UninstStr := '';
  RegKey := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{A3F2C1D0-4E5B-6F7A-8B9C-0D1E2F3A4B5C}_is1';
  if not RegQueryStringValue(HKLM, RegKey, 'UninstallString', UninstStr) then
    RegQueryStringValue(HKCU, RegKey, 'UninstallString', UninstStr);
  Result := UninstStr;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  UninstStr, NssmExe: String;
  ResultCode: Integer;
begin
  Result := '';

  // หยุด service เก่าก่อน
  NssmExe := ExpandConstant('{autopf}') + '\QueueSystem\tools\nssm.exe';
  if FileExists(NssmExe) then
  begin
    Exec(NssmExe, 'stop QueueSystem', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmExe, 'remove QueueSystem confirm', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(2000);
  end;

  // ถอนการติดตั้งเวอร์ชันเก่า (silent)
  UninstStr := GetOldUninstallString();
  if UninstStr <> '' then
  begin
    UninstStr := RemoveQuotes(UninstStr);
    Exec(UninstStr, '/SILENT /NORESTART /SUPPRESSMSGBOXES', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(2500);
  end;
end;

// ── ตรวจสอบ service ──────────────────────────────────────────────────────
function ServiceExists(ServiceName: string): Boolean;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{app}\tools\nssm.exe'), 'status ' + ServiceName,
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := (ResultCode <> 3);
end;

// ── สร้าง URL shortcut ───────────────────────────────────────────────────
procedure CreateUrlShortcut();
var
  Lines: TStringList;
begin
  Lines := TStringList.Create;
  try
    Lines.Add('[InternetShortcut]');
    Lines.Add('URL=http://localhost:3000');
    Lines.Add('IconFile=' + ExpandConstant('{app}\app.ico'));
    Lines.Add('IconIndex=0');
    Lines.SaveToFile(ExpandConstant('{app}\open-queue.url'));
  finally
    Lines.Free;
  end;
end;

// ── หลังติดตั้งไฟล์เสร็จ ──────────────────────────────────────────────────
procedure CurStepChanged(CurStep: TSetupStep);
var
  AppDir, NssmExe: string;
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    AppDir  := ExpandConstant('{app}');
    NssmExe := AppDir + '\tools\nssm.exe';

    // สร้าง URL shortcut
    CreateUrlShortcut();

    // หยุด/ลบ service เก่าที่อาจค้างอยู่
    if ServiceExists('QueueSystem') then
    begin
      Exec(NssmExe, 'stop QueueSystem', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Exec(NssmExe, 'remove QueueSystem confirm', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Sleep(1500);
    end;

    // ติดตั้ง service ใหม่
    Exec(NssmExe, 'install QueueSystem "' + AppDir + '\QueueServer.exe"',
      AppDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmExe, 'set QueueSystem AppDirectory "' + AppDir + '"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmExe, 'set QueueSystem DisplayName "Queue Management System"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmExe, 'set QueueSystem Description "ระบบบริหารจัดการคิวโรงพยาบาล"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmExe, 'set QueueSystem Start SERVICE_AUTO_START',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmExe, 'set QueueSystem AppStdout "' + AppDir + '\logs\service.log"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmExe, 'set QueueSystem AppStderr "' + AppDir + '\logs\error.log"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmExe, 'set QueueSystem AppRotateFiles 1',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmExe, 'set QueueSystem AppRotateBytes 5242880',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmExe, 'set QueueSystem AppExit Default Restart',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

    // Firewall
    if WizardIsTaskSelected('firewall') then
    begin
      Exec('netsh', 'advfirewall firewall delete rule name="Queue System Port 3000"',
        '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Exec('netsh', 'advfirewall firewall add rule name="Queue System Port 3000" dir=in action=allow protocol=TCP localport=3000',
        '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    end;

    // เริ่ม service
    Exec(NssmExe, 'start QueueSystem', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(2000);
  end;
end;

// ── ถอนการติดตั้ง ────────────────────────────────────────────────────────
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  NssmExe: string;
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    NssmExe := ExpandConstant('{app}\tools\nssm.exe');
    Exec(NssmExe, 'stop QueueSystem', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(1500);
    Exec(NssmExe, 'remove QueueSystem confirm', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('netsh', 'advfirewall firewall delete rule name="Queue System Port 3000"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

[Run]
Filename: "http://localhost:3000"; Description: "เปิดระบบคิวในเบราว์เซอร์หลังติดตั้งเสร็จ"; Flags: shellexec postinstall skipifsilent nowait
