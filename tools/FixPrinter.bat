@echo off
chcp 65001 >nul
setlocal
set "SCRIPT_DIR=%~dp0"

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo กำลังขอสิทธิ์ผู้ดูแลระบบ กรุณากด "Yes" ในหน้าต่างที่ปรากฏขึ้น...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

title แก้ไขปัญหาเครื่องพิมพ์ระบบคิว
cd /d "%SCRIPT_DIR%"
echo ==========================================
echo   กำลังตรวจสอบและแก้ไขระบบคิว
echo   กรุณารอสักครู่ อย่าปิดหน้าต่างนี้
echo ==========================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%FixQueuePrinter.ps1"

echo.
echo ==========================================
echo   เสร็จสิ้น กรุณากดปุ่มใดก็ได้เพื่อปิดหน้าต่างนี้
echo   ถ้ายังมีปัญหา กรุณาส่งไฟล์ FixLog.txt กลับมาให้ทีมงาน
echo ==========================================
pause >nul
