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
const { printSlip, listPrinters } = require('./slip-print');

const PORT    = 3001;
// When packaged as .exe (pkg), __dirname points inside the snapshot FS.
// Use process.execPath dir so config file sits next to the .exe on disk.
const APP_DIR     = typeof process.pkg !== 'undefined' ? path.dirname(process.execPath) : __dirname;
// The install folder (C:\Program Files (x86)\...) is read-only for a normal user — saving there threw and
// stopped the agent. The config now lives in the user's own folder; an older one next to the .exe is
// still read the first time.
const OLD_CONFIG  = path.join(APP_DIR, 'local-print-config.json');
const CONFIG_DIR  = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'QueuePrintAgent') : APP_DIR;
const CONFIG_FILE = path.join(CONFIG_DIR, 'local-print-config.json');

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
  for (const f of [CONFIG_FILE, OLD_CONFIG]) {
    try { return Object.assign({}, DEFAULT_CONFIG, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch {}
  }
  return Object.assign({}, DEFAULT_CONFIG);
}

// returns an error message instead of throwing — a failed save must never stop the agent
function saveConfig(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    return null;
  } catch (err) {
    console.log(`Could not save config: ${err.message}`);
    return err.message;
  }
}
// last line of defence: log it and keep running
process.on('uncaughtException',  err => console.log(`Error: ${err && err.message}`));
process.on('unhandledRejection', err => console.log(`Error: ${err && err.message}`));

let localCfg = loadConfig();

// ── Helpers ───────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Chrome: a page on the LAN (http://10.x.x.x:3000) calling this machine's localhost asks first
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
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

// ?fresh=1 (the 🔄 button) reads the list again instead of the cached one
const getPrinters = (cb, fresh) => listPrinters(cb, { maxAgeMs: fresh ? 0 : 60000 });

// ── HTTP Server ───────────────────────────────────────────────────────────
// The queue server relays the page's calls here (Chrome blocks a LAN page from calling localhost), so the
// agent also answers on the LAN — but only from this PC, from private network addresses
// (10.x / 172.16–31.x / 192.168.x), and from this PC's own network (same first two numbers of the IP:
// some hospitals number their LAN with public-range addresses, e.g. 162.16.x.x).
function ownPrefixes() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' || a.family === 4) out.add(a.address.split('.').slice(0, 2).join('.'));
  return out;
}
function allowedFrom(addr) {
  const ip = String(addr || '').replace(/^::ffff:/, '');
  if (ip === '::1' || ip.startsWith('127.')) return true;
  const m = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return true;
  return ownPrefixes().has(`${a}.${b}`);
}

const server = http.createServer((req, res) => {
  if (!allowedFrom(req.socket.remoteAddress)) {
    const from = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    console.log(`Refused a request from ${from} (not this PC's network)`);
    sendJson(res, { success: false, message: `Print Agent ไม่รับคำสั่งจาก ${from} (คนละเครือข่ายกับเครื่องนี้)` }, 403);
    return;
  }
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /api/printers
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/printers') {
    getPrinters((printers, error) => sendJson(res, { printers, error }), /[?&]fresh=1/.test(req.url));
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
      const err = saveConfig(localCfg);
      sendJson(res, err ? { success: false, message: 'บันทึกค่าบนเครื่องนี้ไม่ได้: ' + err, printConfig: localCfg }
                        : { success: true, printConfig: localCfg });
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

// the console window has no Thai font — its messages stay in English
server.on('error', err => {
  console.log(err.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use - Queue Print Agent may already be running on this PC.`
    : `Error: ${err.message}`);
  setTimeout(() => process.exit(1), 15000);
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Queue Print Agent  http://localhost:${PORT}`);
  console.log(`Config: ${CONFIG_FILE}`);
  console.log('Ready - keep this window open (minimize is OK). Closing it stops printing.');
  // read the printer list now, so the first settings page doesn't wait for PowerShell
  getPrinters((p, error) => console.log(p.length ? `Printers (${p.length}): ${p.join(' | ')}` : `No printers found${error ? ' - ' + error : ''}`));
});
