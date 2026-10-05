/**
 * Queue System — Local Print Agent
 * รันบนเครื่อง Client เพื่อปริ้นโดยตรงโดยไม่ผ่าน browser dialog
 * Port: 3001  (แยกจาก Queue Server port 3000)
 */
const http = require('http');
const { exec } = require('child_process');
const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { printSlip } = require('./slip-print');

const PORT    = 3001;
// When packaged as .exe (pkg), __dirname points inside the snapshot FS.
// Use process.execPath dir so config file sits next to the .exe on disk.
const APP_DIR     = typeof process.pkg !== 'undefined' ? path.dirname(process.execPath) : __dirname;
const CONFIG_FILE = path.join(APP_DIR, 'local-print-config.json');

// ── Local print config ────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  paperSize: '80mm', customWidth: 80, customHeight: 200,
  showHeader: true, headerName: '', headerSubtitle: '', headerFontSize: 14,
  showDividerLine: true,
  showPatientName: true, showHnQn: true, patientFontSize: 11,
  showQueueType: true, queueTypeFontSize: 11,
  queueNumFontSize: 60,
  showDateTime: true, dateFontSize: 9,
  showFooter: false, footerText: '', footerFontSize: 8,
  autoPrint: true, copies: 1,
  fontFamily: '',
  layoutOrder: ['header','patientName','hnQn','queueType','queueNum','dateTime','footer'],
};

function loadConfig() {
  try {
    return Object.assign({}, DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch {
    return Object.assign({}, DEFAULT_CONFIG);
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

let localCfg = loadConfig();

// ── Helpers ───────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
  });
}

function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function getPrinters(cb) {
  exec('powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"',
    { timeout: 6000, windowsHide: true }, (err, stdout) => {
      if (err) { cb([]); return; }
      cb(stdout.split('\n').map(p => p.trim()).filter(Boolean));
    });
}

// ── HTTP Server ───────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /api/printers
  if (req.method === 'GET' && req.url === '/api/printers') {
    getPrinters(printers => sendJson(res, { printers }));
    return;
  }

  // GET /api/print-config — return local config
  if (req.method === 'GET' && req.url === '/api/print-config') {
    sendJson(res, localCfg);
    return;
  }

  // POST /api/print-config — save local config
  if (req.method === 'POST' && req.url === '/api/print-config') {
    readBody(req).then(body => {
      Object.assign(localCfg, body);
      saveConfig(localCfg);
      sendJson(res, { success: true, printConfig: localCfg });
    });
    return;
  }

  // POST /api/local-print
  if (req.method === 'POST' && req.url === '/api/local-print') {
    readBody(req).then(body => {
      const { printerName, ticket, cfg } = body;
      if (!printerName) { sendJson(res, { success: false, message: 'ไม่ได้ระบุเครื่องพิมพ์' }); return; }
      const useCfg = Object.assign({}, localCfg, cfg || {});
      printSlip(useCfg, ticket || {}, printerName, (err, stderr) => {
        if (err) sendJson(res, { success: false, message: (stderr || err.message).trim() });
        else     sendJson(res, { success: true });
      });
    });
    return;
  }

  // GET /ping
  if (req.method === 'GET' && req.url === '/ping') {
    sendJson(res, { ok: true, hostname: os.hostname() });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Queue Print Agent  http://localhost:${PORT}`);
  console.log(`Config: ${CONFIG_FILE}`);
  console.log('พร้อมรับคำสั่งปริ้นจากเครื่องอื่น — กด Ctrl+C เพื่อหยุด');
});
