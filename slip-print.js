/**
 * Shared slip printing — used by server.js (HOST mode) and print-agent.js (local mode).
 * Builds "lines" from print config + ticket, then draws them with PowerShell GDI+ (or ZPL raw).
 * Layout/styling rules must match public/slip-render.js (browser preview / browser print).
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { exec } = require('child_process');

// same as public/slip-render.js — without 'barcode' here a slip with no saved layout printed no barcode
const DEFAULT_ORDER = ['header','patientName','hnQn','pttype','queueType','queueNum','slipNote','barcode','dateTime','footer'];

// Default per-section style — matches the original fixed look
const STYLE_DEFAULTS = {
  header:      { align:'center', bold:true,  color:'black' },
  patientName: { align:'center', bold:true,  color:'black' },
  slipNote:    { align:'center', bold:true,  color:'black' },
  hnQn:        { align:'center', bold:false, color:'gray'  },
  pttype:      { align:'center', bold:false, color:'black' },
  queueType:   { align:'center', bold:false, color:'black' },
  queueNum:    { align:'center', bold:true,  color:'black' },
  dateTime:    { align:'center', bold:false, color:'gray'  },
  footer:      { align:'center', bold:false, color:'gray'  },
  logo:        { align:'center' },
  barcode:     { align:'center' },
};

const c = (x, d) => x !== undefined && x !== null && x !== '' ? x : d;

function sectionStyle(cfg, id) {
  return Object.assign({}, STYLE_DEFAULTS[id] || { align:'center', bold:false, color:'black' },
                       (cfg.sectionStyles || {})[id] || {});
}

// {queue} {type} {hn} {qn} {name} {pttype} {date} {time} {hospital}
function fillPlaceholders(text, t) {
  return String(text || '').replace(/\{(queue|type|hn|qn|name|pttype|date|time|hospital)\}/g, (_, k) => ({
    queue: t.display, type: t.typeName, hn: t.hn, qn: t.qn, name: t.patientName, pttype: t.pttypeName,
    date: t.date, time: t.issuedAt, hospital: t.sysName,
  }[k] || ''));
}

const psColor = col => col === 'gray' ? 'DimGray' : 'Black';
const b64Of   = dataUrl => String(dataUrl || '').replace(/^data:image\/[a-z+]+;base64,/i, '');

// HN / QN: their own line (default) or on the patient name's line — hnQnPosition 'left' | 'right'
const hnQnInline = cfg => (cfg.hnQnPosition === 'left' || cfg.hnQnPosition === 'right') && cfg.showHnQn !== false;
const hnQnText = (cfg, t) => [t.hn ? 'HN: ' + t.hn : '', t.qn ? 'QN: ' + t.qn : ''].filter(Boolean).join('   ');
// a line is drawn in one row (no wrapping) — a long one gets a smaller font instead of being cut off.
// Width estimate: ~0.62 em per character (bold Thai is wide); Thai vowel / tone marks take no width of their own.
function fitOneLine(text, fs, widthMm) {
  const n = String(text).replace(/[ัิ-ฺ็-๎]/g, '').length || 1;
  const fit = widthMm / (n * 0.62 * 25.4 / 72);
  return Math.max(6, Math.min(fs, Math.floor(fit * 2) / 2));
}

// "3 - 001" → "3-001": the spaces around the hyphen are very wide at queue-number size
const compactNum = d => String(d == null ? '' : d).replace(/\s*-\s*/g, '-');
// a note line too long for the paper: split at the space nearest the middle (rather than shrink it a lot)
function noteRows(text, fs, widthMm) {
  const f = fitOneLine(text, fs, widthMm);
  if (f >= fs * 0.85 || !/\s/.test(text)) return [[text, f]];
  const mid = text.length / 2;
  let cut = -1;
  for (let i = 0; i < text.length; i++) if (/\s/.test(text[i]) && (cut < 0 || Math.abs(i - mid) < Math.abs(cut - mid))) cut = i;
  return [text.slice(0, cut).trim(), text.slice(cut + 1).trim()].filter(Boolean).map(t => [t, fitOneLine(t, fs, widthMm)]);
}
// layouts saved before the ticket note existed: it goes right under the queue number
function withSlipNote(order) {
  if (order.includes('slipNote')) return order;
  const o = order.slice(), at = o.indexOf('queueNum');
  o.splice(at >= 0 ? at + 1 : o.length, 0, 'slipNote');
  return o;
}

function buildPrintLines(cfg, ticket) {
  const lines = [];
  const order = withSlipNote((cfg.layoutOrder && cfg.layoutOrder.length) ? cfg.layoutOrder : DEFAULT_ORDER);
  const textLine = (text, fs, st) =>
    lines.push({ t:'text', text, fs, bold: !!st.bold, color: psColor(st.color), align: st.align });

  const builders = {
    logo: () => {
      if (!cfg.showLogo || !cfg.logoData) return;
      const w = Number(cfg.logoWidth) || 30;
      lines.push({ t:'img', b64: b64Of(cfg.logoData), wmm: w, hmm: w * (Number(cfg.logoAspect) || 1),
                   align: sectionStyle(cfg, 'logo').align, crisp: false });
    },
    header: () => {
      if (!c(cfg.showHeader, true)) return;
      const st = sectionStyle(cfg, 'header');
      const hfs = c(cfg.headerFontSize, 14);
      textLine(fillPlaceholders(c(cfg.headerName, ticket.sysName || 'ระบบคิว'), ticket), hfs, st);
      if (cfg.headerSubtitle)
        textLine(fillPlaceholders(cfg.headerSubtitle, ticket), Number(cfg.subtitleFontSize) || Math.max(7, hfs - 3), { align: st.align, bold:false, color:'gray' });
    },
    patientName: () => {
      if (!c(cfg.showPatientName, true) || !ticket.patientName) return;
      const fs = c(cfg.patientFontSize, 11), hq = hnQnText(cfg, ticket);
      if (hnQnInline(cfg) && hq) {
        // HN / QN on the name's line (left or right of it), in the name's style — shrunk to stay on one line
        const text = cfg.hnQnPosition === 'left' ? `${hq}  ${ticket.patientName}` : `${ticket.patientName}  ${hq}`;
        textLine(text, fitOneLine(text, fs, paperWidthMm(cfg) - 6), sectionStyle(cfg, 'patientName'));
        return;
      }
      textLine(ticket.patientName, fs, sectionStyle(cfg, 'patientName'));
    },
    hnQn: () => {
      if (!c(cfg.showHnQn, true)) return;
      if (hnQnInline(cfg) && c(cfg.showPatientName, true) && ticket.patientName) return;   // already on the name's line
      const hq = hnQnText(cfg, ticket);
      if (hq) textLine(hq, Number(cfg.hnQnFontSize) || Math.max(7, c(cfg.patientFontSize, 11) - 2), sectionStyle(cfg, 'hnQn'));
    },
    pttype: () => {
      if (!cfg.showPttype || !ticket.pttypeName) return;
      const label = cfg.pttypeLabel != null ? cfg.pttypeLabel : 'สิทธิ: ';
      textLine(label + ticket.pttypeName, c(cfg.pttypeFontSize, 10), sectionStyle(cfg, 'pttype'));
    },
    queueType: () => {
      if (c(cfg.queueTypePosition, 'above') === 'left') return; // rendered with queueNum
      if (!c(cfg.showQueueType, true) || !ticket.typeName) return;
      textLine(ticket.typeName, c(cfg.queueTypeFontSize, 11), sectionStyle(cfg, 'queueType'));
    },
    queueNum: () => {
      const box = c(cfg.numBoxStyle, 'thick');
      if (c(cfg.queueTypePosition, 'above') === 'left' && c(cfg.showQueueType, true) && ticket.typeName) {
        const st = sectionStyle(cfg, 'queueType');
        lines.push({ t:'numWithType', typeText: ticket.typeName, typeFs: c(cfg.queueTypeFontSize, 11),
                     typeBold: !!st.bold, typeColor: psColor(st.color),
                     numText: compactNum(ticket.display), numFs: c(cfg.queueNumFontSize, 60), box });
      } else {
        lines.push({ t:'num', text: compactNum(ticket.display), fs: c(cfg.queueNumFontSize, 60), bold:true, color:'Black',
                     align: sectionStyle(cfg, 'queueNum').align, box });
      }
    },
    // ข้อความบนบัตรคิว — set per queue type (where to go next); nothing when the type has none
    slipNote: () => {
      if (cfg.showSlipNote === false || !ticket.slipNote) return;
      const st = sectionStyle(cfg, 'slipNote'), fs = c(cfg.slipNoteFontSize, 11);
      String(ticket.slipNote).split(/\r?\n/).forEach(l => {
        if (l.trim()) noteRows(l.trim(), fs, paperWidthMm(cfg) - 6).forEach(([t, f]) => textLine(t, f, st));
      });
    },
    barcode: () => {
      // Barcode / QR image is generated by the browser (public/slip-render.js) and sent with the ticket
      // codeImgs = QN and/or HN barcode; codeImg alone comes from pages older than that
      if (!cfg.showBarcode) return;
      for (const img of ticket.codeImgs || [ticket.codeImg]) {
        if (!img || !img.dataUrl) continue;
        lines.push({ t:'img', b64: b64Of(img.dataUrl), wmm: Number(img.wmm) || 40,
                     hmm: Number(img.hmm) || 15, align: sectionStyle(cfg, 'barcode').align, crisp: true });
      }
    },
    dateTime: () => {
      if (!c(cfg.showDateTime, true)) return;
      textLine(`${ticket.date}  ${ticket.issuedAt}`, c(cfg.dateFontSize, 9), sectionStyle(cfg, 'dateTime'));
    },
    footer: () => {
      if (!c(cfg.showFooter, true) || !cfg.footerText) return;
      const st = sectionStyle(cfg, 'footer');
      fillPlaceholders(cfg.footerText, ticket).split('\n').forEach(l => {
        if (l.trim()) textLine(l, c(cfg.footerFontSize, 8), st);
      });
    },
  };

  for (const id of order) {
    const from = lines.length;
    if (id === 'divider') {
      if (c(cfg.showDividerLine, true) && lines.length && lines[lines.length-1].t !== 'div')
        lines.push({ t:'div', style: c(cfg.dividerStyle, 'dashed') });
    } else if (id.startsWith('text:')) {
      const blk = (cfg.customTexts || []).find(b => 'text:' + b.id === id);
      if (!blk || !blk.text) continue;
      const st = { align: c(blk.align, 'center'), bold: !!blk.bold, color: c(blk.color, 'black') };
      fillPlaceholders(blk.text, ticket).split('\n').forEach(l => {
        if (l.trim()) textLine(l, Number(blk.fs) || 10, st);
      });
    } else if (builders[id]) {
      builders[id]();
    }
    // ◀ ▶ ▲ ▼ of this section (mm) — drawn shifted; the next section still starts where it would have
    const o = (cfg.sectionOffsets || {})[id] || {}, dx = clampOff(o.x), dy = clampOff(o.y);
    if (dx || dy) for (let i = from; i < lines.length; i++) { lines[i].dx = dx; lines[i].dy = dy; }
  }
  return lines;
}

// Image lines are scaled down to fit the printable width (paper - 6mm margins)
function imgSize(line, paperMm) {
  const w = Math.min(line.wmm, Math.max(10, paperMm - 6));
  return { w, h: line.hmm * (w / line.wmm) };
}

// ── Calculate paper height from content (for printers without auto-cut) ──────
function calcPrintHeight(lines, paperMm = 80, bottomMargin = 8) {
  let y = 3; // top margin
  // a section moved down (▼) may reach below the last line — keep it on the paper
  let bottom = 0;
  for (const line of lines) {
    if (line.t === 'div') {
      y += 3.0;
    } else if (line.t === 'img') {
      y += imgSize(line, paperMm).h + 1.5;
    } else if (line.t === 'numWithType') {
      y += (line.numFs / 72.0 * 25.4) * 1.5 + 1.5;
    } else {
      y += (line.fs / 72.0 * 25.4) * 1.5 + 1.5;
    }
    bottom = Math.max(bottom, y + (Number(line.dy) || 0));   // where this line ends after its ▲ ▼ shift
  }
  return Math.ceil(Math.max(y, bottom) + bottomMargin);
}

function paperWidthMm(cfg) {
  return cfg.paperSize === '58mm' ? 58 : cfg.paperSize === 'a4' ? 210
       : cfg.paperSize === 'custom' ? (Number(cfg.customWidth) || 80) : 80;
}

function paperHeightMm(cfg, lines, paperMm) {
  return cfg.paperSize === 'a4' ? 297
       : cfg.paperSize === 'custom' && Number(cfg.customHeight) ? Number(cfg.customHeight)
       : calcPrintHeight(lines, paperMm);
}

// ── Print via PowerShell GDI+ (ZPL raw for Zebra printers) ────────────────────
const PS_SCRIPT = `
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class RawPrint{
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
  struct DOCINFOW{[MarshalAs(UnmanagedType.LPWStr)]public string pDocName;[MarshalAs(UnmanagedType.LPWStr)]public string pOutputFile;[MarshalAs(UnmanagedType.LPWStr)]public string pDatatype;}
  [DllImport("winspool.drv",CharSet=CharSet.Unicode)]static extern bool OpenPrinter(string p,out IntPtr h,IntPtr d);
  [DllImport("winspool.drv")]static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv",CharSet=CharSet.Unicode)]static extern int StartDocPrinterW(IntPtr h,int lv,ref DOCINFOW di);
  [DllImport("winspool.drv")]static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv")]static extern bool WritePrinter(IntPtr h,byte[] b,int n,out int w);
  [DllImport("winspool.drv")]static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv")]static extern bool EndDocPrinter(IntPtr h);
  public static bool Send(string name,byte[] data){
    IntPtr h;if(!OpenPrinter(name,out h,IntPtr.Zero))return false;
    var di=new DOCINFOW{pDocName="Q",pDatatype="RAW"};
    if(StartDocPrinterW(h,1,ref di)<=0){ClosePrinter(h);return false;}
    StartPagePrinter(h);int w;WritePrinter(h,data,data.Length,out w);
    EndPagePrinter(h);EndDocPrinter(h);ClosePrinter(h);return true;
  }
}
'@ -Language CSharp -ErrorAction SilentlyContinue
$script:d = Get-Content $env:QSLIP_DATA -Raw -Encoding utf8 | ConvertFrom-Json
$pw100 = [int]($script:d.paperMm / 25.4 * 100)
$ph100 = if($script:d.paperHmm -gt 0){[int]($script:d.paperHmm / 25.4 * 100)}else{2000}
$script:fontName = if($script:d.fontFamily -and $script:d.fontFamily -ne ''){$script:d.fontFamily}else{'Segoe UI'}

# Font fallback: if configured font not installed in Windows, use Thai-capable system font
$allFamilies = [System.Drawing.FontFamily]::Families | ForEach-Object { $_.Name }
if ($script:fontName -notin $allFamilies) {
  foreach ($fb in @('Leelawadee UI','Leelawadee','Tahoma','Segoe UI')) {
    if ($fb -in $allFamilies) { $script:fontName = $fb; break }
  }
}

# Decode images once (logo / barcode / QR)
$script:imgs = @{}
for($i=0; $i -lt $script:d.lines.Count; $i++){
  $ln = $script:d.lines[$i]
  if($ln.t -eq 'img'){
    try {
      $bytes = [Convert]::FromBase64String($ln.b64)
      $script:imgs[$i] = [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream(,$bytes)))
    } catch {}
  }
}

# Detect ZPL printer — driver name check first, then printer name fallback
# (network/shared printers show MEPPC driver locally, not ZDesigner)
$script:isZPL = $false
try {
  $pName = $script:d.printerName
  $pWmi = Get-WmiObject Win32_Printer -Filter ("Name='" + $pName.Replace("'","''") + "'") -ErrorAction SilentlyContinue
  if ($pWmi -and ($pWmi.DriverName -like '*ZDesigner*' -or $pWmi.DriverName -like '*Zebra*' -or $pWmi.DriverName -like '*ZPL*')) {
    $script:isZPL = $true
  }
  # Fallback: match on printer name itself (covers shared/network printers)
  if (-not $script:isZPL) {
    $script:isZPL = ($pName -like '*ZDesigner*' -or $pName -like '*Zebra*' -or $pName -like '*ZPL*')
  }
} catch {}

function AlignOf($a){
  switch($a){ 'left' {[System.Drawing.StringAlignment]::Near} 'right' {[System.Drawing.StringAlignment]::Far} default {[System.Drawing.StringAlignment]::Center} }
}

# Queue-number box: thick | thin | none | inverse (white text on black)
# the queue number must never be cut: measured with the real font, made smaller until it fits the width
function FitSmm($g,$text,[float]$smm,$style,[float]$maxW){
  while($smm -gt 3){
    $f=New-Object System.Drawing.Font($script:fontName,$smm,$style,[System.Drawing.GraphicsUnit]::Millimeter)
    $w=$g.MeasureString([string]$text,$f).Width
    $f.Dispose()
    if($w -le $maxW){ return $smm }
    $smm=$smm*[float]0.94
  }
  return $smm
}
function DrawNumBox($g,$box,$x,$y,$w,$h){
  if($box -eq 'inverse'){ $g.FillRectangle([System.Drawing.Brushes]::Black,$x,$y,$w,$h); return [System.Drawing.Brushes]::White }
  if($box -eq 'thick'){ $g.DrawRectangle((New-Object System.Drawing.Pen([System.Drawing.Color]::Black,[float]0.7)),$x,$y,$w,$h) }
  elseif($box -eq 'thin'){ $g.DrawRectangle((New-Object System.Drawing.Pen([System.Drawing.Color]::Black,[float]0.3)),$x,$y,$w,$h) }
  return [System.Drawing.Brushes]::Black
}

# Drawing logic shared by GDI+ and ZPL paths
$script:drawContent = {
  param($g)
  $g.PageUnit = [System.Drawing.GraphicsUnit]::Millimeter
  # shift the whole slip (mm) — set in the slip designer
  $g.TranslateTransform([float]$script:d.offX, [float]$script:d.offY)
  # fit the printer's real printable width (e.g. an "80mm" Xprinter that prints 72mm) — else the right side is cut off
  [float]$avail=$script:d.paperMm
  if($script:fitMm -gt 10 -and $script:fitMm -lt $avail){ $avail=[float]$script:fitMm }
  [float]$pw=$avail-6.0; [float]$m=3.0; [float]$y=$m
  for($i=0; $i -lt $script:d.lines.Count; $i++){
    $line = $script:d.lines[$i]
    # ◀ ▶ ▲ ▼ of this section (mm) — only its own drawing moves
    [float]$sdx = 0; [float]$sdy = 0
    if($line.dx){ $sdx = [float]$line.dx }; if($line.dy){ $sdy = [float]$line.dy }
    if($sdx -ne 0 -or $sdy -ne 0){ $g.TranslateTransform($sdx, $sdy) }
    if($line.t -eq 'div'){
      $col = if($line.style -eq 'solid' -or $line.style -eq 'double'){[System.Drawing.Color]::Black}else{[System.Drawing.Color]::Gray}
      $pen=New-Object System.Drawing.Pen($col,[float]0.3)
      if($line.style -eq 'dotted'){ $pen.DashStyle=[System.Drawing.Drawing2D.DashStyle]::Dot }
      elseif($line.style -ne 'solid' -and $line.style -ne 'double'){ $pen.DashStyle=[System.Drawing.Drawing2D.DashStyle]::Dash }
      if($line.style -eq 'double'){
        $g.DrawLine($pen,$m,($y-0.4),($m+$pw),($y-0.4)); $g.DrawLine($pen,$m,($y+0.4),($m+$pw),($y+0.4))
      } else { $g.DrawLine($pen,$m,$y,($m+$pw),$y) }
      $y+=[float]3.0
    }elseif($line.t -eq 'img'){
      $img = $script:imgs[$i]
      [float]$w=[Math]::Min([float]$line.wmm,$pw); [float]$h=[float]$line.hmm*($w/[float]$line.wmm)
      [float]$x = if($line.align -eq 'left'){$m}elseif($line.align -eq 'right'){$m+$pw-$w}else{$m+($pw-$w)/2}
      if($img){
        $g.InterpolationMode = if($line.crisp){[System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor}else{[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic}
        $g.DrawImage($img,$x,$y,$w,$h)
      }
      $y+=$h+[float]1.5
    }elseif($line.t -eq 'numWithType'){
      [float]$typeSmm=$line.typeFs/72.0*25.4
      [float]$numSmm=$line.numFs/72.0*25.4
      [float]$lh=$numSmm*1.5
      [float]$leftW=$pw*[float]0.35; [float]$gap=[float]2.0
      [float]$rightW=$pw-$leftW-$gap; [float]$rightX=$m+$leftW+$gap
      $numSmm=FitSmm $g $line.numText $numSmm ([System.Drawing.FontStyle]::Bold) ($rightW-[float]3)
      $tst=if($line.typeBold){[System.Drawing.FontStyle]::Bold}else{[System.Drawing.FontStyle]::Regular}
      $typeFont=New-Object System.Drawing.Font($script:fontName,$typeSmm,$tst,[System.Drawing.GraphicsUnit]::Millimeter)
      $numFont=New-Object System.Drawing.Font($script:fontName,$numSmm,[System.Drawing.FontStyle]::Bold,[System.Drawing.GraphicsUnit]::Millimeter)
      $fmt=New-Object System.Drawing.StringFormat
      $fmt.Alignment=[System.Drawing.StringAlignment]::Center; $fmt.LineAlignment=[System.Drawing.StringAlignment]::Center
      $typeBrush=[System.Drawing.Brushes]::($line.typeColor); if(-not $typeBrush){$typeBrush=[System.Drawing.Brushes]::Black}
      $leftRect=New-Object System.Drawing.RectangleF($m,$y,$leftW,$lh)
      $g.DrawString($line.typeText,$typeFont,$typeBrush,$leftRect,$fmt)
      $numBrush = DrawNumBox $g $line.box $rightX $y $rightW $lh
      $rightRect=New-Object System.Drawing.RectangleF($rightX,$y,$rightW,$lh)
      $g.DrawString($line.numText,$numFont,$numBrush,$rightRect,$fmt)
      $y+=$lh+[float]1.5
    }else{
      [float]$smm=$line.fs/72.0*25.4
      $st=if($line.bold){[System.Drawing.FontStyle]::Bold}else{[System.Drawing.FontStyle]::Regular}
      [float]$lh=$smm*1.5
      if($line.t -eq 'num'){ $smm=FitSmm $g $line.text $smm $st ($pw-[float]4) }
      $font=New-Object System.Drawing.Font($script:fontName,$smm,$st,[System.Drawing.GraphicsUnit]::Millimeter)
      $brush=[System.Drawing.Brushes]::($line.color)
      if(-not $brush){$brush=[System.Drawing.Brushes]::Black}
      $fmt=New-Object System.Drawing.StringFormat
      $fmt.Alignment=AlignOf $line.align; $fmt.LineAlignment=[System.Drawing.StringAlignment]::Center
      if($line.t -eq 'num'){ $brush = DrawNumBox $g $line.box $m $y $pw $lh }
      $rect=New-Object System.Drawing.RectangleF($m,$y,$pw,$lh)
      $g.DrawString($line.text,$font,$brush,$rect,$fmt)
      $y+=$lh+[float]1.5
    }
    if($sdx -ne 0 -or $sdy -ne 0){ $g.TranslateTransform(-$sdx, -$sdy) }
  }
}

$script:fitMm = 0
function DoPrint {
  if ($script:isZPL) {
    # ZPL path: render to bitmap at printer DPI → convert to ^GFA hex → send raw ZPL
    # ^PW and ^LL in ZPL data stream enforce exact label dimensions the driver cannot override
    [int]$dpi = 203
    try {
      $pdDpi = New-Object System.Drawing.Printing.PrintDocument
      $pdDpi.PrinterSettings.PrinterName = $script:d.printerName
      $r = $pdDpi.PrinterSettings.DefaultPageSettings.PrinterResolution.X
      if ($r -gt 0) { $dpi = $r }
    } catch {}
    [int]$bmpW = [Math]::Max(1,[int]($script:d.paperMm / 25.4 * $dpi))
    [int]$bmpH = [Math]::Max(1,[int]($script:d.paperHmm / 25.4 * $dpi))
    $bmp = New-Object System.Drawing.Bitmap($bmpW, $bmpH)
    $bmp.SetResolution($dpi, $dpi)
    $gBmp = [System.Drawing.Graphics]::FromImage($bmp)
    $gBmp.Clear([System.Drawing.Color]::White)
    & $script:drawContent $gBmp
    $gBmp.Dispose()
    # Convert to 1-bit ZPL ^GFA hex
    $bytesPerRow = [int][Math]::Ceiling($bmpW / 8.0)
    $totalBytes  = $bytesPerRow * $bmpH
    $bmp1 = $bmp.Clone([System.Drawing.Rectangle]::new(0,0,$bmpW,$bmpH),[System.Drawing.Imaging.PixelFormat]::Format1bppIndexed)
    $bmp.Dispose()
    $bd = $bmp1.LockBits([System.Drawing.Rectangle]::new(0,0,$bmpW,$bmpH),[System.Drawing.Imaging.ImageLockMode]::ReadOnly,[System.Drawing.Imaging.PixelFormat]::Format1bppIndexed)
    $stride = [Math]::Abs($bd.Stride)
    $raw = New-Object byte[] ($bmpH * $stride)
    [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0,$raw,0,$raw.Length)
    $bmp1.UnlockBits($bd); $bmp1.Dispose()
    $sb = [System.Text.StringBuilder]::new($totalBytes * 2)
    for ($r = 0; $r -lt $bmpH; $r++) {
      for ($b = 0; $b -lt $bytesPerRow; $b++) {
        [void]$sb.Append((($raw[$r * $stride + $b] -bxor 0xFF) -band 0xFF).ToString('X2'))
      }
    }
    $zpl = "^XA^PW$bmpW^LL$bmpH^FO0,0^GFA,$totalBytes,$totalBytes,$bytesPerRow,$($sb.ToString())^FS^XZ"
    [void][RawPrint]::Send($script:d.printerName,[System.Text.Encoding]::UTF8.GetBytes($zpl))
  } else {
    # Standard GDI+ path
    $pd = New-Object System.Drawing.Printing.PrintDocument
    $pd.PrinterSettings.PrinterName = $script:d.printerName
    $pd.PrinterSettings.Copies = [int16]1
    # the printer's own printable width — read BEFORE the custom paper size below, which would report 80mm back
    $script:fitMm = [float]($pd.PrinterSettings.DefaultPageSettings.PrintableArea.Width * 0.254)
    $customSize = New-Object System.Drawing.Printing.PaperSize('Custom',$pw100,$ph100)
    $customSize.RawKind = 256
    $pd.DefaultPageSettings.PaperSize = $customSize
    $pd.DefaultPageSettings.Landscape = $false
    $pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0,0,0,0)
    $pd.add_PrintPage({ param($s,$e)
      # fixed height: thermal drivers cut right after the last printed dot (blank trimming) — one tiny dot at the
      # bottom makes the paper feed to the set length before the cut
      if($script:d.fixedH -and $script:d.paperHmm -gt 10){
        $e.Graphics.PageUnit = [System.Drawing.GraphicsUnit]::Millimeter
        $e.Graphics.FillRectangle([System.Drawing.Brushes]::Black, [float]2.0, [float]($script:d.paperHmm - 1.5), [float]0.3, [float]0.3)
      }
      [float]$pa = $e.PageSettings.PrintableArea.Width * 0.254   # 1/100 inch → mm
      if($pa -gt 10 -and ($script:fitMm -le 10 -or $pa -lt $script:fitMm)){ $script:fitMm = $pa }
      & $script:drawContent $e.Graphics })
    $pd.Print()
  }
}

for($i=0; $i -lt [int]$script:d.copies; $i++){
  DoPrint
  if($i -lt ([int]$script:d.copies - 1)){ Start-Sleep -Milliseconds 300 }
}
`;

function runSlipPrint({ printerName, paperMm, paperHmm, copies, fontFamily, lines, offX, offY, fixedH }, callback, timeoutMs = 30000) {
  const ts       = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dataFile = path.join(os.tmpdir(), `qslip_data_${ts}.json`);
  const ps1File  = path.join(os.tmpdir(), `qslip_print_${ts}.ps1`);
  const safeFont = (fontFamily || 'Segoe UI').replace(/['"]/g, '');
  fs.writeFileSync(dataFile, JSON.stringify({
    printerName, paperMm, paperHmm: paperHmm || 300, copies: Math.max(1, Number(copies) || 1),
    fontFamily: safeFont, lines, offX: clampOff(offX), offY: clampOff(offY), fixedH: !!fixedH,
  }), 'utf8');
  fs.writeFileSync(ps1File, PS_SCRIPT, 'utf8');
  exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1File}"`,
    { timeout: timeoutMs, windowsHide: true, env: { ...process.env, QSLIP_DATA: dataFile } },
    (err, stdout, stderr) => {
      try { fs.unlinkSync(ps1File); } catch {}
      try { fs.unlinkSync(dataFile); } catch {}
      callback(err, stderr);
    });
}

function clampOff(v) { const n = Number(v) || 0; return Math.max(-20, Math.min(20, Math.round(n * 2) / 2)); }

// One-call helper: config + ticket → print
function printSlip(cfg, ticket, printerName, callback, timeoutMs) {
  const paperMm  = paperWidthMm(cfg);
  const lines    = buildPrintLines(cfg, ticket || {});
  const paperHmm = paperHeightMm(cfg, lines, paperMm);
  runSlipPrint({ printerName, paperMm, paperHmm, copies: cfg.copies || 1, fontFamily: cfg.fontFamily || '', lines,
                 offX: cfg.offsetX, offY: cfg.offsetY,
                 fixedH: cfg.paperSize === 'a4' || (cfg.paperSize === 'custom' && Number(cfg.customHeight) > 0) },
               callback, timeoutMs);
}

// ── Installed printers (server "เครื่องหลัก" and the client's Print Agent) ──────────────────
// The list printing itself uses (System.Drawing) first; Get-Printer / WMI only as fallbacks, since
// Get-Printer is missing on some machines (Windows 7, no PrintManagement module). Output is forced to
// UTF-8 so Thai printer names come through. The first call can take several seconds on a slow PC
// (PowerShell start-up), so the list is cached and requests made meanwhile share one run.
const PS_PRINTERS = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$n = @()
try { Add-Type -AssemblyName System.Drawing; $n = @([System.Drawing.Printing.PrinterSettings]::InstalledPrinters) } catch {}
if (-not $n.Count) { try { $n = @(Get-Printer | ForEach-Object { $_.Name }) } catch {} }
if (-not $n.Count) { try { $n = @(Get-WmiObject Win32_Printer | ForEach-Object { $_.Name }) } catch {} }
$n | ForEach-Object { $_ }
`;
let _printers = null, _printersAt = 0, _printersWait = null;
function listPrinters(cb, { maxAgeMs = 60000 } = {}) {
  if (_printers && Date.now() - _printersAt < maxAgeMs) return cb(_printers, null);
  if (_printersWait) return _printersWait.push(cb);
  _printersWait = [cb];
  const enc = Buffer.from(PS_PRINTERS, 'utf16le').toString('base64');
  exec(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${enc}`,
    { timeout: 30000, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout) => {
      const list = String(stdout || '').replace(/^﻿/, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (list.length) { _printers = [...new Set(list)]; _printersAt = Date.now(); }
      const out = list.length ? _printers : (_printers || []);
      const msg = list.length ? null : err ? String(err.killed ? 'หมดเวลารอรายชื่อเครื่องพิมพ์' : err.message).slice(0, 200) : 'เครื่องนี้ไม่มีเครื่องพิมพ์ติดตั้งไว้';
      const waiting = _printersWait; _printersWait = null;
      waiting.forEach(f => f(out, msg));
    });
}

module.exports = { buildPrintLines, calcPrintHeight, paperWidthMm, paperHeightMm, runSlipPrint, printSlip, fillPlaceholders, listPrinters };
