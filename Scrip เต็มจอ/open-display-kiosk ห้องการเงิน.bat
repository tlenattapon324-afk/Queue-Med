@echo off
goto :main
────────────────────────────────────────────────────────────────
เปิดจอแสดงคิว (Queue-Med) ห้องการเงิน แบบเต็มจอ (kiosk) ไม่มีแถบ URL/แท็บ และไม่ต้องแตะเพื่อเปิดเสียง

วิธีใช้:
  1. แก้ 3 บรรทัด SET ด้านล่าง ให้ตรงกับจอที่ต้องการเปิดบนเครื่องนี้
       SERVER = IP:Port ของเครื่องที่ติดตั้งระบบคิว
       SYS    = เลขห้อง (ดูได้จาก ?sys=... ใน URL ของจอแสดงคิว)
       MODE   = opd / ipd / all
  2. ดับเบิลคลิกไฟล์นี้เพื่อทดสอบ
  3. ถ้าต้องการให้เปิดอัตโนมัติทุกครั้งที่เปิดเครื่อง ให้คัดลอกไฟล์นี้ไปไว้ที่
     โฟลเดอร์ Startup (กด Win+R พิมพ์ shell:startup แล้ว Enter แล้ววางไฟล์นี้ลงไป)

ออกจากโหมดเต็มจอ: กด Alt+F4

หมายเหตุ:
  - ใช้ Chrome ถ้ามี ถ้าไม่มีใช้ Edge (มีในทุกเครื่อง Windows)
  - ใช้โปรไฟล์เบราว์เซอร์แยกต่างหาก ไม่ปนกับที่เปิดอยู่ปกติ ถ้าใช้โปรไฟล์เดียวกัน
    หน้าต่างใหม่จะถูกสร้างโดยโปรเซสเดิม ซึ่ง "เพิกเฉย" ต่อ --kiosk (สาเหตุที่พบบ่อยที่สุดที่ไม่เต็มจอ)
    แยกโปรไฟล์ตามห้อง จึงเปิดหลายจอบนเครื่องเดียวได้
  - หลังเปิดหน้าต่าง จะกด F11 ให้อัตโนมัติ เผื่อเครื่องที่ --kiosk ไม่ทำงาน
  - ข้อความส่วนนี้ cmd จะข้ามไป (goto :main) จึงเขียนภาษาไทยได้โดยไม่เกิด error
────────────────────────────────────────────────────────────────

:main
SET SERVER=10.1.210.60:3000
SET SYS=30
SET MODE=opd

SET DISPLAY_URL=http://%SERVER%/display.html?sys=%SYS%^&mode=%MODE%
SET KIOSK_PROFILE=%LocalAppData%\QueueMedKiosk-%SYS%-%MODE%

SET CHROME="%ProgramFiles%\Google\Chrome\Application\chrome.exe"
IF NOT EXIST %CHROME% SET CHROME="%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
IF NOT EXIST %CHROME% SET CHROME="%LocalAppData%\Google\Chrome\Application\chrome.exe"
IF EXIST %CHROME% GOTO chrome

SET EDGE="%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
IF NOT EXIST %EDGE% SET EDGE="%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
IF "%DRYRUN%"=="1" (echo EDGE %EDGE% "%DISPLAY_URL%" "%KIOSK_PROFILE%" & GOTO :eof)
start "" %EDGE% --kiosk "%DISPLAY_URL%" --edge-kiosk-type=fullscreen --autoplay-policy=no-user-gesture-required --no-first-run --noerrdialogs --user-data-dir="%KIOSK_PROFILE%"
GOTO f11

:chrome
IF "%DRYRUN%"=="1" (echo CHROME %CHROME% "%DISPLAY_URL%" "%KIOSK_PROFILE%" & GOTO :eof)
start "" %CHROME% --kiosk --start-fullscreen --autoplay-policy=no-user-gesture-required --disable-infobars --disable-session-crashed-bubble --noerrdialogs --no-first-run --user-data-dir="%KIOSK_PROFILE%" "%DISPLAY_URL%"

:f11
powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{F11}')"
