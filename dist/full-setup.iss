[Setup]
AppName=ระบบคิว (Queue System)
AppVersion=2.4.0
AppVerName=ระบบคิว (Queue System) v2.4.0
AppPublisher=Hospital Queue System
AppId={{A3F2C1D0-4E5B-6F7A-8B9C-0D1E2F3A4B5C}
DefaultDirName={autopf}\QueueSystem
OutputDir=.
OutputBaseFilename=Queue-Setup-Full
SetupIconFile=..\icon.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
PrivilegesRequired=admin
UninstallDisplayName=ระบบคิว (Queue System)
UninstallDisplayIcon={app}\QueueServer.exe
CloseApplications=no
MinVersion=6.1

[Languages]
Name: "thai"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon";  Description: "สร้าง Shortcut บน Desktop (เปิดระบบคิวในเบราว์เซอร์)"; GroupDescription: "ตัวเลือกเพิ่มเติม:"; Flags: checkedonce
Name: "firewall";     Description: "เปิด Firewall อนุญาต Port 3000 (สำหรับเชื่อมต่อจากเครื่องอื่นใน LAN)"; GroupDescription: "ตัวเลือกเพิ่มเติม:"; Flags: checkedonce
Name: "installsound"; Description: "ติดตั้งเสียงภาษาไทย (Thai TTS) สำรอง — เผื่ออินเทอร์เน็ตล่ม (ไม่จำเป็น ระบบใช้เสียง Google Translate ออนไลน์เป็นค่าเริ่มต้นอยู่แล้ว)"; GroupDescription: "ตัวเลือกเพิ่มเติม:"

[Files]
; ── โปรแกรมหลัก ──────────────────────────────────────────────────────────
Source: "QueueServer.exe";     DestDir: "{app}";          Flags: ignoreversion
Source: "nssm.exe";            DestDir: "{app}\tools";    Flags: ignoreversion
; ── ตัวติดตั้งเสียงภาษาไทยสำหรับ Client ────────────────────────────────
Source: "Setup_Sound.exe";     DestDir: "{app}";          Flags: ignoreversion skipifsourcedoesntexist
; ── หน้าเว็บ ─────────────────────────────────────────────────────────────
Source: "..\public\*";         DestDir: "{app}\public";   Flags: ignoreversion recursesubdirs createallsubdirs
; ── ค่าตั้งต้น (เฉพาะติดตั้งใหม่ครั้งแรก — ไม่ทับข้อมูลเดิมตอนอัปเกรด, ไม่รวมข้อมูลเชื่อมต่อฐานข้อมูล) ──
Source: "data-defaults\*";     DestDir: "{app}\data";     Flags: onlyifdoesntexist recursesubdirs createallsubdirs

[Dirs]
Name: "{app}\data"
Name: "{app}\logs"

[Icons]
; Start Menu
Name: "{group}\เปิดระบบคิว";                    Filename: "{app}\open-queue.url";         Comment: "เปิดระบบคิวในเบราว์เซอร์"
Name: "{group}\หยุด Queue System Service";       Filename: "{app}\tools\nssm.exe";         Parameters: "stop QueueSystem"; IconFilename: "{app}\QueueServer.exe"
Name: "{group}\เริ่ม Queue System Service";      Filename: "{app}\tools\nssm.exe";         Parameters: "start QueueSystem"; IconFilename: "{app}\QueueServer.exe"
Name: "{group}\ถอนการติดตั้ง";                  Filename: "{uninstallexe}"
; Desktop
Name: "{commondesktop}\ระบบคิว";                Filename: "{app}\open-queue.url";         Tasks: desktopicon; Comment: "เปิดระบบคิว (Queue System)"

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
    Lines.Add('IconFile=' + ExpandConstant('{app}\QueueServer.exe'));
    Lines.Add('IconIndex=0');
    Lines.SaveToFile(ExpandConstant('{app}\open-queue.url'));
  finally
    Lines.Free;
  end;
end;

// ── เขียน PS1 script ──────────────────────────────────────────────────────
procedure WritePS(FileName, Content: String);
var L: TStringList;
begin
  L := TStringList.Create;
  try L.Text := Content; L.SaveToFile(FileName);
  finally L.Free; end;
end;

// ── ติดตั้งเสียงภาษาไทย (รวมอยู่ใน installer หลัก) ──────────────────────
procedure InstallThaiTTS();
var
  D, sAudio, sInstall, sCheck: String;
  RC: Integer;
begin
  D := ExpandConstant('{tmp}') + '\';
  sAudio   := D + 'qs_audio.ps1';
  sCheck   := D + 'qs_check.ps1';
  sInstall := D + 'qs_install.ps1';

  // 1. แก้ Windows Audio Services
  WritePS(sAudio,
    'foreach ($s in @("AudioEndpointBuilder","Audiosrv")) {' + #13#10 +
    '  try {' + #13#10 +
    '    Set-Service $s -StartupType Automatic -EA SilentlyContinue' + #13#10 +
    '    $svc = Get-Service $s -EA SilentlyContinue' + #13#10 +
    '    if ($svc -and $svc.Status -ne "Running") { Start-Service $s -EA SilentlyContinue }' + #13#10 +
    '  } catch {}' + #13#10 +
    '}' + #13#10 +
    'exit 0');
  Exec('powershell.exe',
    '-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + sAudio + '"',
    D, SW_HIDE, ewWaitUntilTerminated, RC);

  // 2. ตรวจสอบว่ามี Thai TTS แล้วหรือยัง
  WritePS(sCheck,
    '$ErrorActionPreference = "SilentlyContinue"' + #13#10 +
    'try {' + #13#10 +
    '  $c = Get-WindowsCapability -Online -Name "Language.Speech~~~th-TH~0.0.1.0"' + #13#10 +
    '  if ($c -and $c.State -eq "Installed") { exit 0 }' + #13#10 +
    '  exit 1' + #13#10 +
    '} catch { exit 2 }');
  Exec('powershell.exe',
    '-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + sCheck + '"',
    D, SW_HIDE, ewWaitUntilTerminated, RC);
  if RC = 0 then Exit;  // มีอยู่แล้ว ไม่ต้องติดตั้ง

  // 3. ดาวน์โหลดและติดตั้ง Thai TTS (Microsoft Pattara)
  WritePS(sInstall,
    'try {' + #13#10 +
    '  Add-WindowsCapability -Online -Name "Language.Speech~~~th-TH~0.0.1.0" -ErrorAction Stop' + #13#10 +
    '  exit 0' + #13#10 +
    '} catch { exit 1 }');
  Exec('powershell.exe',
    '-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + sInstall + '"',
    D, SW_HIDE, ewWaitUntilTerminated, RC);
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

    // ติดตั้งเสียงภาษาไทย (ถ้าเลือก)
    if WizardIsTaskSelected('installsound') then
      InstallThaiTTS();

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
