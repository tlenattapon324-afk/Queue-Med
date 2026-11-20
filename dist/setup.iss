[Setup]
AppName=Queue Print Agent
AppVersion=1.5.0
AppVerName=Queue Print Agent v1.5.0
AppPublisher=Hospital Queue System
DefaultDirName={autopf}\QueuePrintAgent
DefaultGroupName=Queue Print Agent
OutputDir=.
OutputBaseFilename=QueuePrintAgent_Setup-v1.5.0
SetupIconFile=..\assets\icons\setup.ico
WizardSmallImageFile=..\assets\icons\wizard-small-55.bmp,..\assets\icons\wizard-small-110.bmp
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayName=Queue Print Agent
UninstallDisplayIcon={app}\QueuePrintAgent.exe

[Languages]
Name: "thai"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "สร้าง Shortcut บน Desktop"; GroupDescription: "ตัวเลือกเพิ่มเติม:"; Flags: unchecked
Name: "startup"; Description: "เปิดโปรแกรมอัตโนมัติเมื่อ Windows เริ่มทำงาน"; GroupDescription: "ตัวเลือกเพิ่มเติม:"; Flags: checkedonce

[Files]
Source: "QueuePrintAgent.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Queue Print Agent"; Filename: "{app}\QueuePrintAgent.exe"; Comment: "เปิดระบบรับคำสั่งปริ้นคิว"
Name: "{group}\ถอนการติดตั้ง Queue Print Agent"; Filename: "{uninstallexe}"
Name: "{commondesktop}\Queue Print Agent"; Filename: "{app}\QueuePrintAgent.exe"; Tasks: desktopicon; Comment: "เปิดระบบรับคำสั่งปริ้นคิว"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "QueuePrintAgent"; ValueData: """{app}\QueuePrintAgent.exe"""; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\QueuePrintAgent.exe"; Description: "เปิดใช้งาน Queue Print Agent ทันที"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "taskkill"; Parameters: "/F /IM QueuePrintAgent.exe"; Flags: runhidden; RunOnceId: "KillAgent"

[Code]
// ติดตั้งทับรุ่นเก่า: ปิด Print Agent ที่เปิดค้างอยู่ก่อน ไม่งั้นไฟล์ .exe ถูกล็อกเขียนทับไม่ได้
// (ค่าเครื่องพิมพ์ local-print-config.json ไม่ได้มาจากตัวติดตั้ง จึงไม่ถูกลบ/ทับ)
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM QueuePrintAgent.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(1000);
end;
