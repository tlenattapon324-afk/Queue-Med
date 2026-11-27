[Setup]
AppName=Queue Print Agent
AppVersion=1.6.0
AppVerName=Queue Print Agent v1.6.0
AppPublisher=Hospital Queue System
DefaultDirName={autopf}\QueuePrintAgent
DefaultGroupName=Queue Print Agent
OutputDir=.
OutputBaseFilename=QueuePrintAgent_Setup-v1.6.0
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
Source: "agent-hidden.vbs";    DestDir: "{app}"; Flags: ignoreversion

; ทำงานเบื้องหลัง ไม่มีหน้าต่าง (agent-hidden.vbs) — "แสดงหน้าต่าง" ไว้ใช้ตรวจสอบเท่านั้น
[Icons]
Name: "{group}\Queue Print Agent"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\agent-hidden.vbs"""; IconFilename: "{app}\QueuePrintAgent.exe"; Comment: "เปิดระบบรับคำสั่งปริ้นคิว (ทำงานเบื้องหลัง)"
Name: "{group}\Queue Print Agent (แสดงหน้าต่าง - ตรวจสอบ)"; Filename: "{app}\QueuePrintAgent.exe"; Comment: "เปิดแบบเห็นหน้าต่าง — หยุดตัวที่ทำงานเบื้องหลังก่อน"
Name: "{group}\หยุด Queue Print Agent"; Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM QueuePrintAgent.exe"; IconFilename: "{app}\QueuePrintAgent.exe"
Name: "{group}\ถอนการติดตั้ง Queue Print Agent"; Filename: "{uninstallexe}"
Name: "{commondesktop}\Queue Print Agent"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\agent-hidden.vbs"""; IconFilename: "{app}\QueuePrintAgent.exe"; Tasks: desktopicon; Comment: "เปิดระบบรับคำสั่งปริ้นคิว (ทำงานเบื้องหลัง)"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "QueuePrintAgent"; ValueData: """{sys}\wscript.exe"" ""{app}\agent-hidden.vbs"""; Flags: uninsdeletevalue; Tasks: startup

[Run]
; เครื่องหลักส่งงานพิมพ์มาที่ port 3001 ของเครื่องนี้ (Chrome บล็อกหน้าเว็บไม่ให้เรียก localhost ตรง ๆ)
; ลบกฎ "บล็อก" ที่ Windows สร้างไว้ตอนกด Cancel ที่หน้าต่าง Firewall ก่อน แล้วเปิด port 3001
; (ไม่จำกัด IP ที่ Firewall: บาง รพ. ใช้ IP นอกช่วงมาตรฐาน เช่น 162.16.x.x — ตัว Agent กรองเองว่ารับเฉพาะเครือข่ายเดียวกัน)
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=all program=""{app}\QueuePrintAgent.exe"""; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Queue Print Agent 3001"""; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Queue Print Agent 3001"" dir=in action=allow protocol=TCP localport=3001 profile=any"; Flags: runhidden
Filename: "{sys}\wscript.exe"; Parameters: """{app}\agent-hidden.vbs"""; Description: "เปิดใช้งาน Queue Print Agent ทันที (ทำงานเบื้องหลัง)"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "taskkill"; Parameters: "/F /IM QueuePrintAgent.exe"; Flags: runhidden; RunOnceId: "KillAgent"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Queue Print Agent 3001"""; Flags: runhidden; RunOnceId: "DelFw3001"

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
