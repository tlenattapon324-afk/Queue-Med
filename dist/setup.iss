[Setup]
AppName=Queue Print Agent
AppVersion=1.4.0
AppPublisher=Hospital Queue System
DefaultDirName={autopf}\QueuePrintAgent
DefaultGroupName=Queue Print Agent
OutputDir=.
OutputBaseFilename=QueuePrintAgent_Setup
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
