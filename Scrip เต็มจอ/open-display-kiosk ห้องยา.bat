@echo off
rem ────────────────────────────────────────────────────────────────
rem เปิดจอแสดงคิวแบบเต็มจอ (kiosk) ไม่มีแถบ URL/แท็บ และไม่ต้องแตะเพื่อเปิดเสียง
rem
rem วิธีใช้:
rem   1. แก้บรรทัด SET DISPLAY_URL ด้านล่างให้เป็น URL ของจอที่ต้องการเปิดบนเครื่องนี้
rem   2. ดับเบิลคลิกไฟล์นี้เพื่อทดสอบ
rem   3. ถ้าต้องการให้เปิดอัตโนมัติทุกครั้งที่เปิดเครื่อง ให้คัดลอกไฟล์นี้ไปไว้ที่
rem      โฟลเดอร์ Startup (กด Win+R พิมพ์ shell:startup แล้ว Enter แล้ววางไฟล์นี้ลงไป)
rem
rem ออกจากโหมดเต็มจอ: กด Alt+F4
rem ────────────────────────────────────────────────────────────────

SET DISPLAY_URL=http://162.16.1.14:3200/#/display?id=1780456207756

SET CHROME="%ProgramFiles%\Google\Chrome\Application\chrome.exe"
IF NOT EXIST %CHROME% SET CHROME="%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
IF NOT EXIST %CHROME% SET CHROME="%LocalAppData%\Google\Chrome\Application\chrome.exe"

rem ใช้โปรไฟล์แยกต่างหาก ไม่ปนกับ Chrome ที่เปิดอยู่ปกติ — ถ้า Chrome เปิดอยู่แล้วและ
rem ใช้โปรไฟล์เดียวกัน หน้าต่างใหม่จะถูกสร้างโดยโปรเซสเดิม ซึ่ง "เพิกเฉย" ต่อ --kiosk
rem (นี่คือสาเหตุที่พบบ่อยที่สุดที่กดแล้วไม่เต็มจอ)
SET KIOSK_PROFILE=%LocalAppData%\QueueOpdKiosk

start "" %CHROME% --kiosk --start-fullscreen --autoplay-policy=no-user-gesture-required --disable-infobars --disable-session-crashed-bubble --noerrdialogs --no-first-run --user-data-dir="%KIOSK_PROFILE%" "%DISPLAY_URL%"

rem เผื่อเครื่องนี้ไม่ยอมเข้าเต็มจอเองจาก --kiosk (เจอบางเครื่อง/บาง Chrome ที่ flag ไม่ทำงาน)
rem ให้กด F11 ให้อัตโนมัติหลังหน้าต่างเปิดขึ้นมา ไม่ต้องกดเอง
powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{F11}')"
