try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$ErrorActionPreference = 'Continue'

$logPath = Join-Path $PSScriptRoot 'FixLog.txt'
function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Host $line
    Add-Content -Path $logPath -Value $line -Encoding UTF8
}

Log "=========================================="
Log "เริ่มตรวจสอบและแก้ไขระบบคิว"
Log "=========================================="

# ---- 1. หาโปรแกรมเป้าหมายในโฟลเดอร์ที่ติดตั้งจริง (โฟลเดอร์แม่ของ tools) ----
$installDir = Split-Path -Parent $PSScriptRoot
Log "โฟลเดอร์ติดตั้งที่ตรวจสอบ: $installDir"

$node = Get-Command node.exe -ErrorAction SilentlyContinue

$exeMain  = Join-Path $installDir 'QueueServer.exe'
$jsMain   = Join-Path $installDir 'server.js'
$exeAgent = Join-Path $installDir 'QueuePrintAgent.exe'
$jsAgent  = Join-Path $installDir 'print-agent.js'

$targets = @()

if (Test-Path $exeMain) {
    $targets += [PSCustomObject]@{ Name='Queue Server';      Path=$exeMain;      Args='';                     Port=3000; Match='QueueServer.exe' }
} elseif ((Test-Path $jsMain) -and $node) {
    $targets += [PSCustomObject]@{ Name='Queue Server';      Path=$node.Source; Args="`"$jsMain`"";           Port=3000; Match='server.js' }
}

if (Test-Path $exeAgent) {
    $targets += [PSCustomObject]@{ Name='Queue Print Agent'; Path=$exeAgent;     Args='';                     Port=3001; Match='QueuePrintAgent.exe' }
} elseif ((Test-Path $jsAgent) -and $node) {
    $targets += [PSCustomObject]@{ Name='Queue Print Agent'; Path=$node.Source; Args="`"$jsAgent`"";          Port=3001; Match='print-agent.js' }
}

if ($targets.Count -eq 0) {
    Log "ไม่พบโปรแกรมระบบคิว (QueueServer.exe / server.js / QueuePrintAgent.exe / print-agent.js) ในโฟลเดอร์: $installDir"
    Log "กรุณาตรวจสอบว่าวางไฟล์แก้ไขนี้ไว้ในโฟลเดอร์ tools ที่อยู่ใต้โฟลเดอร์ติดตั้งระบบคิวจริง แล้วลองใหม่"
    Log "=== จบการทำงาน (ไม่สำเร็จ) ==="
    exit 1
}

foreach ($t in $targets) {
    Log "------------------------------------------"
    Log "กำลังจัดการ: $($t.Name)"

    # ---- 2. หา Windows Service ที่ผูกกับโปรแกรมนี้ (ถ้ามี) และลบทิ้ง ----
    try {
        $svc = Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object {
            $_.PathName -and ($_.PathName -like "*$($t.Match)*")
        }
    } catch { $svc = $null }

    foreach ($s in $svc) {
        Log "พบว่า '$($t.Name)' ถูกติดตั้งเป็น Windows Service ชื่อ '$($s.Name)' (เปิดใช้งานด้วยบัญชี: $($s.StartName))"
        Log "กำลังยกเลิก Service นี้ เพื่อเปลี่ยนไปเปิดพร้อม Windows ในบัญชีผู้ใช้งานจริงแทน (แก้ปัญหาหาเครื่องพิมพ์ไม่เจอ)..."
        try {
            & sc.exe stop $s.Name | Out-Null
            Start-Sleep -Seconds 2
            & sc.exe delete $s.Name | Out-Null
            Log "ยกเลิก Service '$($s.Name)' สำเร็จ"
        } catch {
            Log "ยกเลิก Service ไม่สำเร็จ: $($_.Exception.Message)"
        }
    }

    # ---- 3. ปิดโปรเซสเดิมที่อาจค้างอยู่บนพอร์ตเดียวกัน ----
    try {
        $conns = Get-NetTCPConnection -LocalPort $t.Port -State Listen -ErrorAction SilentlyContinue
        foreach ($c in $conns) {
            Log "ปิดโปรเซสเดิมที่ใช้พอร์ต $($t.Port) อยู่ (PID $($c.OwningProcess))"
            Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        }
        if ($conns) { Start-Sleep -Seconds 1 }
    } catch {}

    # ---- 4. ตั้งค่าให้เปิดอัตโนมัติทุกครั้งที่เข้าสู่ระบบ Windows (Startup folder) ----
    try {
        $startupDir = [Environment]::GetFolderPath('Startup')
        $lnkPath = Join-Path $startupDir ("$($t.Name).lnk")
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut($lnkPath)
        $lnk.TargetPath = $t.Path
        $lnk.Arguments = $t.Args
        $lnk.WorkingDirectory = $installDir
        $lnk.WindowStyle = 7
        $lnk.Description = "$($t.Name) - เปิดอัตโนมัติเมื่อเข้าสู่ระบบ Windows"
        $lnk.Save()
        Log "ตั้งค่าเปิดอัตโนมัติตอนเข้า Windows สำเร็จ: $lnkPath"
    } catch {
        Log "สร้างทางลัดเปิดอัตโนมัติไม่สำเร็จ: $($_.Exception.Message)"
    }

    # ---- 5. เปิดโปรแกรมทันที ไม่ต้องรอ restart เครื่อง ----
    try {
        $startParams = @{ FilePath = $t.Path; WorkingDirectory = $installDir; WindowStyle = 'Minimized' }
        if ($t.Args) { $startParams['ArgumentList'] = $t.Args }
        Start-Process @startParams
        Log "เปิด $($t.Name) แล้ว"
    } catch {
        Log "เปิด $($t.Name) ไม่สำเร็จ: $($_.Exception.Message)"
    }
}

Start-Sleep -Seconds 3

# ---- 6. ตรวจผลลัพธ์ ----
Log "------------------------------------------"
foreach ($t in $targets) {
    $ok = Get-NetTCPConnection -LocalPort $t.Port -State Listen -ErrorAction SilentlyContinue
    if ($ok) { Log "$($t.Name): ทำงานปกติที่พอร์ต $($t.Port) (สำเร็จ)" }
    else     { Log "$($t.Name): ยังไม่พบว่าทำงานที่พอร์ต $($t.Port) (อาจต้องเปิดเองอีกครั้ง หรือแจ้งทีมงาน)" }
}

if ($targets | Where-Object { $_.Port -eq 3000 }) {
    try { Start-Process "http://localhost:3000" } catch {}
}

Log "=========================================="
Log "เสร็จสิ้น กรุณาไปที่หน้า ตั้งค่า > แบบฟอร์มปริ้น แล้วกดรีเฟรชรายชื่อเครื่องพิมพ์อีกครั้ง"
Log "หากยังไม่พบเครื่องพิมพ์ กรุณาส่งไฟล์ FixLog.txt (อยู่โฟลเดอร์เดียวกับไฟล์นี้) กลับมาให้ทีมงานตรวจสอบ"
Log "=========================================="
