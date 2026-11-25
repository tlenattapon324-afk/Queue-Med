const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const crypto  = require('crypto');
const { exec } = require('child_process');
const { printSlip } = require('./slip-print');
const { createTts } = require('./tts-voice');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// When packaged as .exe (pkg), NSSM sets AppDirectory to {app},
// so process.cwd() reliably points to the install folder.
const IS_PKG  = typeof process.pkg !== 'undefined';
const APP_DIR = IS_PKG ? process.cwd() : __dirname;

const PUBLIC_DIR = path.join(APP_DIR, 'public');

// Write startup log for diagnostics (pkg mode only)
if (IS_PKG) {
  try {
    const log = `[${new Date().toISOString()}] cwd=${process.cwd()} execPath=${process.execPath}\n  APP_DIR=${APP_DIR}\n  PUBLIC_DIR=${PUBLIC_DIR} exists=${fs.existsSync(PUBLIC_DIR)}\n`;
    fs.mkdirSync(path.join(APP_DIR, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(APP_DIR, 'logs', 'startup.log'), log, { flag: 'a' });
  } catch {}
}

// Install as an app (PWA): one manifest per page + room, so a phone can install "ออกคิว · ห้อง X" and
// "เรียกคิว · ห้อง Y" as separate apps that open straight to their page
app.get('/manifest.webmanifest', (req, res) => {
  const page = req.query.page === 'cashier' ? 'cashier' : 'queue';
  const sysId = Number(req.query.sys) || null;
  const room = sysId ? ((systems.find(x => x.id === sysId) || {}).name || '') : '';
  const label = page === 'cashier' ? 'เรียกคิว' : 'ออกคิว';
  const name = room ? `${label} · ${room}` : `${label} · ระบบคิว`;
  const start = `/${page}.html${sysId ? `?sys=${sysId}` : ''}`;
  res.type('application/manifest+json').send(JSON.stringify({
    id: start, name, short_name: (room || label).slice(0, 12), description: `ระบบคิวโรงพยาบาล — ${name}`,
    start_url: start, scope: '/', display: 'standalone', orientation: 'any', lang: 'th',
    background_color: '#f2f4fa', theme_color: '#1e2a5a',
    icons: [
      { src: '/app-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/app-icon.png', sizes: '256x256', type: 'image/png', purpose: 'any' },
    ],
  }));
});
// the service worker must be served from the site root to cover every page
app.get('/sw.js', (req, res, next) => { res.setHeader('Service-Worker-Allowed', '/'); res.setHeader('Cache-Control', 'no-cache'); next(); });
app.use(express.static(PUBLIC_DIR));
app.use(express.json({ limit: '5mb' })); // print config may carry a logo image

// ── Persist helpers ──────────────────────────────────────────────────────
const DATA_DIR = path.join(APP_DIR, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function sysDir(sysId) {
  const d = path.join(DATA_DIR, `sys-${sysId}`);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
function loadJson(file, defaults) {
  if (!fs.existsSync(file)) { fs.writeFileSync(file, JSON.stringify(defaults, null, 2)); return JSON.parse(JSON.stringify(defaults)); }
  try { return Object.assign(JSON.parse(JSON.stringify(defaults)), JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return JSON.parse(JSON.stringify(defaults)); }
}
function saveJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ── DB Config (moved up — needed by requireApiToken before the /api/sys routes) ──
const DB_CONFIG_FILE = path.join(DATA_DIR, 'db-config.json');
function loadDbConfig() {
  return loadJson(DB_CONFIG_FILE, { type: 'mysql', host: '', port: 3306, database: '', username: '', password: '', hospitalCode: '', apiToken: '' });
}
function genApiToken(hospitalCode) {
  const code = String(hospitalCode || '').trim();
  const rand = crypto.randomBytes(8).toString('hex').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return code + rand;
}

// DB type ที่ HOSxP/ระบบส่วนใหญ่ใช้คือ MySQL — ค่า default ต้องเป็น MySQL เสมอ
// ห้ามให้ค่า type ที่หายไป/พิมพ์ผิด/ตัวพิมพ์ไม่ตรง หลุดไปเข้า branch PostgreSQL โดยไม่ตั้งใจ
// (เคยเกิดปัญหา "timeout expired" เพราะ pg client พยายามต่อ MySQL server)
function isMysqlType(t) {
  return String(t || 'mysql').trim().toLowerCase() !== 'postgresql';
}

// ── Systems ───────────────────────────────────────────────────────────────
const SYSTEMS_FILE = path.join(DATA_DIR, 'systems.json');
const GLOBAL_CONFIG_FILE = path.join(DATA_DIR, 'global-config.json');

function migrateIfNeeded() {
  if (fs.existsSync(SYSTEMS_FILE)) return;
  saveJson(SYSTEMS_FILE, [
    { id: 1, name: 'ระบบคิวการเงิน', description: 'ระบบแสดงคิวแผนกการเงิน', icon: '💰', color: '#42a5f5' }
  ]);
  const newDir = path.join(DATA_DIR, 'sys-1');
  if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
  ['queue-types.json', 'counters.json', 'display-config.json'].forEach(f => {
    const src = path.join(DATA_DIR, f);
    const dst = path.join(newDir, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
  });
}
migrateIfNeeded();

let systems   = loadJson(SYSTEMS_FILE, []);
let nextSysId = Math.max(0, ...systems.map(s => s.id)) + 1;

// ── Per-system state ──────────────────────────────────────────────────────
const sysData = {};

const SCREEN_CFG_DEFAULTS = {
  fontFamily:      'Kanit',
  bgPreset:        'teal',
  bgC1:            '#29b6c8',
  bgC2:            '#0097a7',
  bgC3:            '#00696f',
  accentColor:     '#00bcd4',
  cardSize:        'normal',
  cardStyle:       'glass',
  showScannerCard: true,
  showToggles:     true,
  navOpacity:      45,
  titleFontSize:    24,
  titleColor:       '#ffd54f',
  cardNameFontSize: 15,
  cardNameColor:    '#ffffff',
  cardWaitFontSize: 12,
  cardWaitNumColor: '#ffd54f',
  barBgColor:       '#001c28',
  barBgOpacity:     78,
  barInputBg:       8,
  barInputBorderColor: '',
  barInputTextColor:   '#ffffff',
  barInputFontSize:    17,
  barPlaceholderColor: '#ffffff',
  barPlaceholderOpacity: 28,
  barLabelColor:    '',
  barLabelSize:     10,
};

const PRINT_CFG_DEFAULTS = {
  paperSize:'80mm', customWidth:'80', customHeight:'',
  printerName:'',
  showHeader:true, headerName:'', headerSubtitle:'Queue System', headerFontSize:14,
  showDividerLine:true,
  showPatientName:true, showHnQn:true, patientFontSize:11,
  showQueueType:true, queueTypeFontSize:11, queueNumFontSize:60,
  showDateTime:true, dateFontSize:9,
  showFooter:true,
  footerText:'กรุณานั่งรอเรียกหมายเลขของท่าน\nPlease wait for your number',
  footerFontSize:8, autoPrint:true, copies:1,
  showBarcode:false, barcodeSource:'qn',
};

function loadSysData(sysId) {
  const dir             = sysDir(sysId);
  const typesFile       = path.join(dir, 'queue-types.json');
  const ctrsFile        = path.join(dir, 'counters.json');
  const displayFile     = path.join(dir, 'display-config.json');
  const printConfigFile  = path.join(dir, 'print-config.json');
  const screenConfigFile = path.join(dir, 'screen-config.json');

  const queueTypes = loadJson(typesFile, [
    { id: 1, name: 'ทั่วไป',    prefix: 'A', color: '#42a5f5', forMode: 'both' },
    { id: 2, name: 'นิติบุคคล', prefix: 'B', color: '#66bb6a', forMode: 'both' },
  ]);
  // migrate old types that were created before forMode field existed
  let _typesChanged = false;
  queueTypes.forEach(t => { if (!t.forMode) { t.forMode = 'both'; _typesChanged = true; } });
  if (_typesChanged) saveJson(typesFile, queueTypes);

  const counters = loadJson(ctrsFile, [
    { id: 1, name: 'ช่อง 1' },
    { id: 2, name: 'ช่อง 2' },
  ]);
  const displayConfig = loadJson(displayFile, {
    tickerMessages: [
      'ยินดีต้อนรับสู่ระบบคิว',
      'กรุณานั่งรอเรียกหมายเลขของท่าน',
      'ขอบคุณที่ใช้บริการ',
    ],
  });
  const printConfig       = loadJson(printConfigFile,  PRINT_CFG_DEFAULTS);
  const screenConfig      = loadJson(screenConfigFile, SCREEN_CFG_DEFAULTS);
  const lookupConfigFile  = path.join(dir, 'lookup-config.json');
  const lookupConfig      = loadJson(lookupConfigFile, {
    barcodeField: 'hn', barcodePrefixLen: 0, barcodeUseLen: 0,
    allowAllPtypes: true, pttypeRules: [],
  });
  const displaySettingsFile  = path.join(dir, 'display-settings.json');
  const displaySettings      = loadJson(displaySettingsFile, {});
  const cashierSettingsFile  = path.join(dir, 'cashier-settings.json');
  const cashierSettings      = loadJson(cashierSettingsFile, {});
  // how the kiosk issues tickets: 'type' = staff picks a queue type, 'drug' = by drug count (rules → queue types)
  const issueModeFile        = path.join(dir, 'issue-mode.json');
  const issueMode            = loadJson(issueModeFile, { mode: 'type', rules: [] });

  const state = {};
  queueTypes.forEach(t => { state[t.id] = { serial: 0, waiting: [], served: [], calledQueue: null }; });

  sysData[sysId] = {
    queueTypes, counters, displayConfig, printConfig, screenConfig, lookupConfig, displaySettings, cashierSettings, issueMode,
    typesFile, ctrsFile, displayFile, printConfigFile, screenConfigFile, lookupConfigFile, displaySettingsFile, cashierSettingsFile, issueModeFile,
    nextTypeId:          Math.max(0, ...queueTypes.map(t => t.id)) + 1,
    nextCounterId:       Math.max(0, ...counters.map(c => c.id))   + 1,
    state,
    noShows:             [],
    clearedNoShows:      [],
    deletedQueues:       [],
    lastCalledByCounter: {},
    recentByCounter:     {},
  };
  restoreQueueState(sysId, sysData[sysId]);
}
systems.forEach(s => loadSysData(s.id));

function getSys(sysId) { return sysData[Number(sysId)] || null; }

function requireSys(req, res, next) {
  const sys = getSys(req.params.sysId);
  if (!sys) return res.status(404).json({ success: false, message: 'ไม่พบระบบคิว' });
  req.sys   = sys;
  req.sysId = Number(req.params.sysId);
  next();
}

// ── API Token gate ───────────────────────────────────────────────────────
// ป้องกันไม่ให้ใคร copy URL ของ /api/sys/*, patient-lookup, patient-drugs ไปยิงตรงใน Postman ได้
// หน้าเว็บของระบบเองแนบ token ให้อัตโนมัติผ่าน public/vendor/api-token.js (ผู้ใช้ไม่ต้องกรอกเอง)
// ถ้ายังไม่เคย gen token ไว้ (ติดตั้งใหม่) จะปล่อยผ่านก่อน จนกว่าแอดมินจะสร้าง token ที่หน้าตั้งค่าการเชื่อมต่อ
function requireApiToken(req, res, next) {
  const cfg = loadDbConfig();
  if (!cfg.apiToken) return next();
  const token = req.headers['x-queue-token'] || (req.query || {}).token;
  if (token && token === cfg.apiToken) return next();
  res.status(401).json({ success: false, message: 'Unauthorized: token required' });
}
app.use('/api/sys', requireApiToken);
// Changing systems, server control and shared settings — same token as /api/sys
app.use('/api/systems', (req, res, next) => req.method === 'GET' ? next() : requireApiToken(req, res, next));
app.use(['/api/server/restart', '/api/startup/set', '/api/local-print'], requireApiToken);
app.post('/api/global-config', requireApiToken);

// ── ชื่อโรงพยาบาล (หน้า Login): opdconfig.hospitalname จาก HOSxP — ยังไม่ได้ต่อฐานข้อมูลก็ส่ง "รพ." ──
let _hospName = { name: '', at: 0 };
app.get('/api/hospital-name', async (req, res) => {
  const fresh = Date.now() - _hospName.at < (_hospName.name ? 10 * 60000 : 60000);
  if (!fresh) {
    _hospName.at = Date.now();
    try {
      if (loadDbConfig().host) {
        const [rows] = await hosQuery([['SELECT hospitalname FROM opdconfig LIMIT 1', []]]);
        _hospName.name = String((rows && rows[0] && rows[0].hospitalname) || '').trim();
      } else _hospName.name = '';
    } catch (e) { _hospName.name = ''; }
  }
  res.json({ success: true, name: _hospName.name || 'รพ.', fromHosxp: !!_hospName.name });
});

// ── DB helpers (fire-and-forget queue logging) ────────────────────────────
function dbFire(fn) {
  const cfg = loadDbConfig();
  if (!cfg.host) return;
  (async () => {
    if (isMysqlType(cfg.type)) {
      const mysql = require('mysql2/promise');
      const conn  = await mysql.createConnection({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectTimeout: 10000, charset: 'utf8mb4' });
      await conn.execute('SET NAMES utf8mb4');
      try { await fn('mysql', conn); } finally { conn.end().catch(() => {}); }
    } else {
      const { Client } = require('pg');
      const client = new Client({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectionTimeoutMillis: 10000 });
      await client.connect();
      try { await fn('pg', client); } finally { client.end().catch(() => {}); }
    }
  })().catch(e => console.error('[DB]', e.message));
}

async function dbRun(type, conn, sql, params) {
  if (type === 'mysql') {
    const [r] = await conn.execute(sql, params);
    return r;
  } else {
    let i = 0;
    const r = await conn.query(sql.replace(/\?/g, () => `$${++i}`), params);
    return r;
  }
}

function dbIssueTicket(sysId, ticket) {
  dbFire(async (type, conn) => {
    const today = todayStr();
    let ticketDbId;
    if (type === 'mysql') {
      const r = await dbRun(type, conn,
        `INSERT INTO app_queue_opd (sys_id,service_date,vn,vstdate,vsttime,type_id,type_name,prefix,ticket_no,display,hn,qn,patient_name,status,issued_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'waiting',NOW())`,
        [sysId, today, ticket.vn||null, ticket.vstdate||today, ticket.vsttime||null,
         ticket.typeId, ticket.typeName, ticket.prefix, ticket.number,
         ticket.display, ticket.hn||null, ticket.qn||null, ticket.patientName||null]);
      ticketDbId = r.insertId;
    } else {
      const r = await dbRun(type, conn,
        `INSERT INTO app_queue_opd (sys_id,service_date,vn,vstdate,vsttime,type_id,type_name,prefix,ticket_no,display,hn,qn,patient_name,status,issued_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'waiting',NOW()) RETURNING id`,
        [sysId, today, ticket.vn||null, ticket.vstdate||today, ticket.vsttime||null,
         ticket.typeId, ticket.typeName, ticket.prefix, ticket.number,
         ticket.display, ticket.hn||null, ticket.qn||null, ticket.patientName||null]);
      ticketDbId = r.rows[0].id;
    }
    ticket._dbId = ticketDbId;
    await dbRun(type, conn,
      `INSERT INTO app_queue_events (ticket_id,sys_id,service_date,event_type,event_at) VALUES (?,?,?,'issued',NOW())`,
      [ticketDbId, sysId, today]);
  });
}

function dbCallTicket(sysId, ticket) {
  dbFire(async (type, conn) => {
    const today = todayStr();
    await dbRun(type, conn,
      `UPDATE app_queue_opd SET status='called', called_at=NOW(), counter_id=?, counter_name=?, updated_at=NOW()
       WHERE display=? AND sys_id=? AND service_date=?`,
      [ticket.counterId||null, ticket.counterName||null, ticket.display, sysId, today]);
    const dbId = ticket._dbId || null;
    await dbRun(type, conn,
      `INSERT INTO app_queue_events (ticket_id,sys_id,service_date,event_type,counter_id,counter_name,event_at) VALUES (?,?,?,?,?,?,NOW())`,
      [dbId, sysId, today, ticket.recalled?'recalled':'called', ticket.counterId||null, ticket.counterName||null]);
  });
}

function dbReturnTicket(sysId, display) {
  dbFire(async (type, conn) => {
    const today = todayStr();
    const r = await dbRun(type, conn,
      `SELECT id FROM app_queue_opd WHERE display=? AND sys_id=? AND service_date=? LIMIT 1`,
      [display, sysId, today]);
    const dbId = (type==='mysql' ? r[0]?.id : r.rows[0]?.id) || null;
    await dbRun(type, conn,
      `UPDATE app_queue_opd SET status='waiting', called_at=NULL, updated_at=NOW() WHERE display=? AND sys_id=? AND service_date=?`,
      [display, sysId, today]);
    await dbRun(type, conn,
      `INSERT INTO app_queue_events (ticket_id,sys_id,service_date,event_type,event_at) VALUES (?,?,?,'returned',NOW())`,
      [dbId, sysId, today]);
  });
}

function dbNoShow(sysId, display) {
  dbFire(async (type, conn) => {
    const today = todayStr();
    const r = await dbRun(type, conn,
      `SELECT id FROM app_queue_opd WHERE display=? AND sys_id=? AND service_date=? LIMIT 1`,
      [display, sysId, today]);
    const dbId = (type==='mysql' ? r[0]?.id : r.rows[0]?.id) || null;
    await dbRun(type, conn,
      `UPDATE app_queue_opd SET status='noshow', noshow_at=NOW(), updated_at=NOW() WHERE display=? AND sys_id=? AND service_date=?`,
      [display, sysId, today]);
    await dbRun(type, conn,
      `INSERT INTO app_queue_events (ticket_id,sys_id,service_date,event_type,event_at) VALUES (?,?,?,'noshow',NOW())`,
      [dbId, sysId, today]);
  });
}

// ── Queue-state persistence ───────────────────────────────────────────────
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function saveQueueState(sysId, sys) {
  const file = path.join(sysDir(sysId), 'queue-state.json');
  saveJson(file, {
    date:                todayStr(),
    state:               sys.state,
    noShows:             sys.noShows,
    clearedNoShows:      sys.clearedNoShows || [],
    deletedQueues:       sys.deletedQueues  || [],
    issuedLog:           sys.issuedLog      || [],
    flowAway:            sys.flowAway       || [],
    calledLog:           sys.calledLog      || [],
    lastCalledByCounter: sys.lastCalledByCounter,
    recentByCounter:     sys.recentByCounter,
  });
}

function restoreQueueState(sysId, sys) {
  const file = path.join(sysDir(sysId), 'queue-state.json');
  if (!fs.existsSync(file)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.date !== todayStr()) return;
    for (const [id, s] of Object.entries(saved.state || {})) {
      const tid = Number(id);
      if (sys.state[tid]) sys.state[tid] = s;
    }
    sys.noShows             = saved.noShows             || [];
    sys.clearedNoShows      = saved.clearedNoShows      || [];
    sys.deletedQueues       = saved.deletedQueues       || [];
    sys.flowAway            = saved.flowAway            || [];
    sys.calledLog           = saved.calledLog           || [];
    // state saved before the call log existed: start it from the called lists still on hand
    if (!saved.calledLog) {
      Object.values(sys.state).flatMap(s => s.served).sort((a, b) => a._ts - b._ts).forEach(t => {
        logCalled(sys, t);
        if (t.noShow) logMark(sys, t.display, { noShowAt: '' });
        if (t.forwardedTo) logMark(sys, t.display, { fwdTo: t.forwardedTo.name, fwdAt: t.forwardedTo.at, flowDone: t.flowDone });
      });
    }
    sys.lastCalledByCounter = saved.lastCalledByCounter || {};
    sys.recentByCounter     = saved.recentByCounter     || {};
    // state saved before the issued log existed: rebuild it from the tickets still on hand
    sys.issuedLog = saved.issuedLog || Object.values(sys.state).flatMap(s => [...s.waiting, ...s.served])
      .concat(sys.noShows).filter(t => t && t.vn).map(issuedEntry);
  } catch {}
}

// ── Issued today (one entry per ticket) — "ออกคิวซ้ำ" check ─────────────────
function issuedEntry(t) {
  return { vn: t.vn, display: t.display, typeId: t.typeId, typeName: t.typeName, color: t.color, issuedAt: t.issuedAt, mode: t.mode || 'opd' };
}
function findIssued(sys, vn) {
  if (!vn) return null;
  const e = (sys.issuedLog || []).find(x => x.vn === vn);
  if (!e) return null;
  const where = (e.sysId && getSys(e.sysId)) || sys;   // a "ไม่มียา" ticket lives in the cashier room
  const inState = pick => Object.values(where.state).some(s => pick(s).some(t => t.display === e.display));
  const status = inState(s => s.waiting) ? 'รอเรียก'
    : (where.noShows || []).some(t => t.display === e.display) ? 'ไม่มารับ'
    : 'เรียกแล้ว';
  const room = e.sysId ? (systems.find(x => x.id === e.sysId) || {}).name : '';
  return { ...e, status: room ? `${status} ที่${room}` : status };
}

// ── Helpers ───────────────────────────────────────────────────────────────
function initTypeState(sys, typeId) {
  if (!sys.state[typeId]) sys.state[typeId] = { serial: 0, waiting: [], served: [], calledQueue: null };
}
function allServed(sys) {
  return Object.values(sys.state).flatMap(s => s.served).filter(t => !t.noShow)
    .sort((a, b) => b._ts - a._ts).slice(0, 40);
}
function allWaiting(sys) {
  return Object.values(sys.state).flatMap(s => s.waiting).sort((a, b) => a._ts - b._ts);
}
function typeWaiting(sys) {
  const r = {};
  for (const [id, s] of Object.entries(sys.state)) r[id] = s.waiting.length;
  return r;
}
function broadcastCall(sysId, sys, called) {
  io.to('sys-' + sysId).emit('queue_called', {
    calledQueue:         called,
    typeWaiting:         typeWaiting(sys),
    allWaiting:          allWaiting(sys),
    allServed:           allServed(sys),
    noShows:             sys.noShows.slice(0, 40),
    lastCalledByCounter: sys.lastCalledByCounter,
    recentByCounter:     sys.recentByCounter,
  });
}

// ── Socket rooms ──────────────────────────────────────────────────────────
// ── 🖥 display presence: each open display.html says hello (mode / layout / sound) — the Staff Monitor lists them ──
const displayPresence = {};          // sysId → { socketId → info }
const displayList = sysId => Object.values(displayPresence[sysId] || {}).sort((a, b) => a.since - b.since);
const emitDisplays = sysId => io.to('sys-' + sysId).emit('displays_updated', { sysId, displays: displayList(sysId) });
io.on('connection', socket => {
  socket.on('display_hello', info => {
    const sysId = Number(info && info.sysId);
    if (!sysId) return;
    const map = displayPresence[sysId] = displayPresence[sysId] || {};
    const prev = map[socket.id];
    const ip = String(socket.handshake.address || '').replace(/^::ffff:/, '');
    map[socket.id] = { id: socket.id, ip, since: prev ? prev.since : Date.now(), at: Date.now(),
      mode: String(info.mode || 'opd').slice(0, 8), layout: String(info.layout || '').slice(0, 20),
      sound: info.sound !== false, audio: !!info.audio, w: Number(info.w) || 0, h: Number(info.h) || 0 };
    socket.data.displaySys = sysId;
    emitDisplays(sysId);
  });
  socket.on('disconnect', () => {
    const sysId = socket.data.displaySys;
    if (sysId && displayPresence[sysId] && displayPresence[sysId][socket.id]) { delete displayPresence[sysId][socket.id]; emitDisplays(sysId); }
  });
  socket.on('displays_get', (sysId, cb) => { if (typeof cb === 'function') cb(displayList(Number(sysId))); });
  // 🔄 the monitor's "รีเฟรชจอ" — every display of this system reloads itself
  socket.on('display_reload_req', sysId => { if (Number(sysId)) io.to('sys-' + Number(sysId)).emit('display_reload', { sysId: Number(sysId) }); });
  socket.on('join_sys', sysId => {
    socket.join('sys-' + sysId);
    const sys = getSys(sysId);
    if (!sys) return;
    socket.emit('sys_state', {
      sysInfo:             systems.find(s => s.id === sysId) || null,
      counters:            sys.counters,
      queueTypes:          sys.queueTypes,
      noShows:             sys.noShows.slice(0, 40),
      clearedNoShows:      (sys.clearedNoShows || []).slice(0, 40),
      lastCalledByCounter: sys.lastCalledByCounter,
      recentByCounter:     sys.recentByCounter,
      displayConfig:       sys.displayConfig,
      displaySettings:     sys.displaySettings,
      cashierSettings:     sys.cashierSettings,
      typeWaiting:         typeWaiting(sys),
      allWaiting:          allWaiting(sys),
      allServed:           allServed(sys),
      flow:                flowView(Number(sysId)),
    });
  });
});

// ── Systems API ───────────────────────────────────────────────────────────
app.get('/api/systems', (req, res) => res.json(systems));

app.post('/api/systems', (req, res) => {
  const { name, description, icon, color, token } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'ต้องระบุชื่อระบบ' });
  const sys = { id: nextSysId++, name: name.trim(), description: description || '', icon: icon || '📋', color: color || '#42a5f5' };
  systems.push(sys);
  saveJson(SYSTEMS_FILE, systems);
  loadSysData(sys.id);
  // Associate with dept if logged in
  const depcode = token && sessions[token] ? sessions[token].depcode : null;
  if (depcode) {
    addSysToDept(depcode, sys.id);
    // remember which HOSxP database this ห้องตรวจ system belongs to (forward-candidates filter)
    sys.db = currentDbKey();
    saveJson(SYSTEMS_FILE, systems);
  }
  io.emit('systems_updated', systems);
  res.json({ success: true, system: sys });
});

app.put('/api/systems/:id', (req, res) => {
  const id  = parseInt(req.params.id);
  const idx = systems.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'ไม่พบระบบ' });
  const { name, description, icon, color } = req.body;
  if (name)                      systems[idx].name        = name.trim();
  if (description !== undefined) systems[idx].description = description;
  if (icon)                      systems[idx].icon        = icon;
  if (color)                     systems[idx].color       = color;
  saveJson(SYSTEMS_FILE, systems);
  io.emit('systems_updated', systems);
  res.json({ success: true, system: systems[idx] });
});

// ── Queue forwarding (one ticket number passed between systems, e.g. ห้องยา ↔ การเงิน) ──
// systems[i].forwardTo = [sysId, ...] — targets this system may send a called ticket to
function linkedSysIds(sysId) {
  const me = systems.find(s => s.id === sysId);
  const ids = new Set((me && me.forwardTo) || []);
  for (const s of systems) if ((s.forwardTo || []).includes(sysId)) ids.add(s.id);
  ids.delete(sysId);
  return [...ids].filter(id => systems.some(s => s.id === id));
}

app.put('/api/systems/:id/forward', (req, res) => {
  const id  = parseInt(req.params.id);
  const idx = systems.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'ไม่พบระบบ' });
  const list = Array.isArray(req.body.forwardTo) ? req.body.forwardTo : [];
  systems[idx].forwardTo = [...new Set(list.map(Number))]
    .filter(t => t !== id && systems.some(s => s.id === t));
  saveJson(SYSTEMS_FILE, systems);
  io.emit('systems_updated', systems);
  res.json({ success: true, system: systems[idx] });
});

app.delete('/api/systems/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = systems.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'ไม่พบระบบ' });
  systems.splice(idx, 1);
  delete sysData[id];
  saveJson(SYSTEMS_FILE, systems);
  // Remove from all dept mappings
  removeSysFromDepts(id);
  // Invalidate sessions that used this system
  for (const tok of Object.keys(sessions)) {
    if (sessions[tok].sysId === id) delete sessions[tok].sysId;
  }
  io.emit('systems_updated', systems);
  io.emit('system_deleted', { sysId: id });
  res.json({ success: true });
});

// ── System info ───────────────────────────────────────────────────────────
app.get('/api/sys/:sysId/info', (req, res) => {
  const id  = parseInt(req.params.sysId);
  const sys = systems.find(s => s.id === id);
  if (!sys) return res.status(404).json({ success: false, message: 'ไม่พบระบบ' });
  res.json(sys);
});

// ── Queue Types API ───────────────────────────────────────────────────────
app.get('/api/sys/:sysId/queue-types', requireSys, (req, res) => res.json(req.sys.queueTypes));

// prefix: letters / digits, optionally ending with "-" → stored as "1 -" (the number is shown as "1 - 001")
const normPrefix = p => String(p || '').toUpperCase().trim().replace(/\s*-+$/, ' -').replace(/^ -$/, '');
const PREFIX_RE = /^[A-Z0-9]{1,3}( -)?$/;
function queueDisplay(prefix, n) {
  const num = String(n).padStart(3, '0');
  return / -$/.test(prefix || '') ? `${prefix} ${num}` : (prefix || '') + num;
}
// the same queue whatever the staff typed: "1 - 001" = "1-001" = "1001"
const dispKey = d => String(d || '').toUpperCase().replace(/[\s-]/g, '');
app.post('/api/sys/:sysId/queue-types', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const { name, prefix, color, forMode } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'ต้องระบุชื่อประเภทคิว' });
  const p = normPrefix(prefix);
  if (p !== '' && !PREFIX_RE.test(p)) return res.status(400).json({ success: false, message: 'Prefix ต้องเป็นตัวอักษร/ตัวเลข 1–3 ตัว และลงท้ายด้วย - ได้ (เช่น 1 -)' });
  if (p !== '' && sys.queueTypes.find(t => t.prefix === p))
    return res.status(400).json({ success: false, message: `Prefix "${p}" ถูกใช้แล้ว` });
  const type = { id: sys.nextTypeId++, name: name.trim(), prefix: p, color: color || '#42a5f5', forMode: forMode || 'both' };
  sys.queueTypes.push(type); initTypeState(sys, type.id);
  saveJson(sys.typesFile, sys.queueTypes);
  io.to('sys-' + sysId).emit('types_updated', sys.queueTypes);
  res.json({ success: true, type });
});

app.put('/api/sys/:sysId/queue-types/:id', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const id  = parseInt(req.params.id);
  const idx = sys.queueTypes.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'ไม่พบประเภทคิว' });
  const { name, prefix, color, forMode } = req.body;
  if (prefix !== undefined && prefix !== null) {
    const p = normPrefix(prefix);
    if (p !== '' && !PREFIX_RE.test(p)) return res.status(400).json({ success: false, message: 'Prefix ต้องเป็นตัวอักษร/ตัวเลข 1–3 ตัว และลงท้ายด้วย - ได้ (เช่น 1 -)' });
    if (p !== '' && sys.queueTypes.find(t => t.id !== id && t.prefix === p))
      return res.status(400).json({ success: false, message: `Prefix "${p}" ถูกใช้แล้ว` });
    sys.queueTypes[idx].prefix = p;
  }
  if (name)    sys.queueTypes[idx].name    = name.trim();
  if (color)   sys.queueTypes[idx].color   = color;
  if (forMode) sys.queueTypes[idx].forMode = forMode;
  saveJson(sys.typesFile, sys.queueTypes);
  io.to('sys-' + sysId).emit('types_updated', sys.queueTypes);
  res.json({ success: true, type: sys.queueTypes[idx] });
});

app.delete('/api/sys/:sysId/queue-types/:id', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const id = parseInt(req.params.id);
  if (sys.queueTypes.length <= 1) return res.status(400).json({ success: false, message: 'ต้องมีอย่างน้อย 1 ประเภท' });
  const idx = sys.queueTypes.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'ไม่พบประเภทคิว' });
  sys.queueTypes.splice(idx, 1); delete sys.state[id];
  saveJson(sys.typesFile, sys.queueTypes);
  io.to('sys-' + sysId).emit('types_updated', sys.queueTypes);
  res.json({ success: true });
});

// ── Counters API ──────────────────────────────────────────────────────────
app.get('/api/sys/:sysId/counters', requireSys, (req, res) => res.json(req.sys.counters));

app.post('/api/sys/:sysId/counters', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const { name } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'ต้องระบุชื่อช่อง' });
  const counter = { id: sys.nextCounterId++, name: name.trim() };
  sys.counters.push(counter);
  saveJson(sys.ctrsFile, sys.counters);
  io.to('sys-' + sysId).emit('counters_updated', sys.counters);
  res.json({ success: true, counter });
});

app.put('/api/sys/:sysId/counters/:id', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const id  = parseInt(req.params.id);
  const idx = sys.counters.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'ไม่พบช่องบริการ' });
  if (req.body.name) sys.counters[idx].name = req.body.name.trim();
  saveJson(sys.ctrsFile, sys.counters);
  io.to('sys-' + sysId).emit('counters_updated', sys.counters);
  res.json({ success: true, counter: sys.counters[idx] });
});

app.delete('/api/sys/:sysId/counters/:id', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const id = parseInt(req.params.id);
  if (sys.counters.length <= 1) return res.status(400).json({ success: false, message: 'ต้องมีอย่างน้อย 1 ช่อง' });
  const idx = sys.counters.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'ไม่พบช่องบริการ' });
  sys.counters.splice(idx, 1);
  delete sys.lastCalledByCounter[id];
  delete sys.recentByCounter[id];
  saveJson(sys.ctrsFile, sys.counters);
  io.to('sys-' + sysId).emit('counters_updated', sys.counters);
  res.json({ success: true });
});

// ── Display Config API ────────────────────────────────────────────────────
app.get('/api/sys/:sysId/display-config', requireSys, (req, res) => res.json(req.sys.displayConfig));

app.put('/api/sys/:sysId/display-config', requireSys, (req, res) => {
  const { sys, sysId } = req;
  if (Array.isArray(req.body.tickerMessages)) {
    sys.displayConfig.tickerMessages = req.body.tickerMessages;
  }
  if (req.body.custom) {
    sys.displayConfig.custom = req.body.custom;
  }
  saveJson(sys.displayFile, sys.displayConfig);
  io.to('sys-' + sysId).emit('display_config_updated', sys.displayConfig);
  res.json({ success: true, displayConfig: sys.displayConfig });
});

// ── Peek next (preview without calling) ──────────────────────────────────
app.get('/api/sys/:sysId/peek-next', requireSys, (req, res) => {
  const { sys } = req;
  const typeId  = req.query.typeId ? Number(req.query.typeId) : null;
  let ticket    = null;
  if (typeId) {
    const waiting = (sys.state[typeId]?.waiting || []).slice().sort((a, b) => a._ts - b._ts);
    ticket = waiting[0] || null;
  } else {
    ticket = allWaiting(sys)[0] || null;
  }
  res.json({ ticket });
});

// ── Queue Operations ──────────────────────────────────────────────────────
// the last number issued for this type — linked systems share one running number per prefix,
// so a forwarded ticket never clashes
function currentSerial(sysId, sys, type) {
  let serial = (sys.state[type.id] && sys.state[type.id].serial) || 0;
  for (const lid of linkedSysIds(sysId)) {
    const other = getSys(lid);
    if (!other) continue;
    for (const ot of other.queueTypes)
      if (ot.prefix === type.prefix && other.state[ot.id]) serial = Math.max(serial, other.state[ot.id].serial || 0);
  }
  return serial;
}
// the number the next ticket of a type will get — shown on the kiosk before staff confirm
app.get('/api/sys/:sysId/next-number', requireSys, (req, res) => {
  const type = req.sys.queueTypes.find(t => t.id === Number(req.query.typeId));
  if (!type) return res.json({ success: false, message: 'ไม่พบประเภทคิว' });
  const n = currentSerial(req.sysId, req.sys, type) + 1;
  res.json({ success: true, display: queueDisplay(type.prefix, n), number: n });
});

app.post('/api/sys/:sysId/get-serial', requireSys, (req, res) => {
  const { sys: srcSys, sysId: srcSysId } = req;
  const { typeId, hn, qn, patientName, pttypeName, vn, vstdate, vsttime, mode, an } = req.body;
  // "ไม่มียา แต่ต้องไปการเงิน": the ticket goes straight into the cashier room's own line (its own prefix)
  const nd = noDrugTarget(srcSysId, srcSys);
  const toCashier = req.body.noDrug === true && mode !== 'ipd';
  if (toCashier && !nd) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า "ไม่มียา → ออกคิวห้องการเงิน" หรือห้องการเงินไม่พร้อม' });
  const sys = toCashier ? nd.sys : srcSys, sysId = toCashier ? nd.sysId : srcSysId;
  const type = toCashier ? nd.type : sys.queueTypes.find(t => t.id === Number(typeId));
  if (!type) return res.status(400).json({ success: false, message: 'ระบุประเภทคิวไม่ถูกต้อง' });
  // "ออกคิวซ้ำ" switched off → a visit (VN / AN) that already got a ticket today gets none
  const visitKey = (mode === 'ipd' && an) ? an : (vn || null);
  if (srcSys.issueMode.allowReissue !== true) {
    const existing = findIssued(srcSys, visitKey);
    if (existing) return res.status(409).json({ success: false, alreadyIssued: true, existing,
      message: `มีประวัติออกคิวแล้ว — คิว ${existing.display} (${existing.issuedAt})` });
  }
  initTypeState(sys, type.id);
  const s = sys.state[type.id];
  s.serial = currentSerial(sysId, sys, type) + 1;
  const ticket = {
    number:      s.serial,
    display:     queueDisplay(type.prefix, s.serial),
    typeId:      type.id, typeName: type.name, prefix: type.prefix, color: type.color,
    issuedAt:    new Date().toLocaleTimeString('th-TH'),
    date:        new Date().toLocaleDateString('th-TH'),
    _ts:         Date.now(),
    issuedTs:    Date.now(),
    hn:          hn          || null,
    qn:          qn          || null,
    vn:          (mode === 'ipd' && an) ? an : (vn || null),
    patientName: patientName || null,
    pttypeName:  pttypeName  || null,
    vstdate:     vstdate     || null,
    vsttime:     vsttime     || null,
    mode:        mode        || 'opd',
    an:          (mode === 'ipd') ? (an || null) : null,
  };
  // "ไม่ผ่านการเงิน" (issued by สิทธิ/ค่าใช้จ่าย) → never auto-forwarded and kept off the "ยังไม่ส่งต่อ" list;
  // staff can still send it by hand (➜ / undo "ไม่ต้องส่ง")
  // a ห้องตรวจ queue has its own prefix but still splits by money: the kiosk says which way this visit goes
  // (no answer, e.g. a card picked by hand → การเงิน, rather than risk an unpaid bill)
  // (the same for a สิทธิ queue — payRule 'pttype')
  const groupRule = type.payRule === 'dept' || type.payRule === 'pttype';
  // ห้องตรวจ with "เช็คไปการเงิน" off: a plain pharmacy queue — no money route, never sent to the cashier
  const srcPay = (srcSys.issueMode && srcSys.issueMode.pay) || {};
  const deptNoRoute = type.payRule === 'dept' && srcPay.deptRouteCheck === false;
  if (deptNoRoute) ticket.forwardSkipped = true;
  else if (groupRule) ticket.payRoute = req.body.payRoute === 'free' ? 'free' : 'cash';
  else if (type.payRule) ticket.payRoute = type.payRule;
  if (ticket.payRoute === 'free') ticket.forwardSkipped = true;
  // shown in the call page's "สถานะ" column (and kept when the ticket is forwarded)
  if (type.drugSize) ticket.drugSize = type.drugSize;
  // a ห้องตรวจ / สิทธิ ticket: its own prefix, plus a tag naming the group (call page "สถานะ")
  if (groupRule) ticket.deptQueue = true;
  // the labels staff typed in ⚙ ออกคิว (left column) travel with the ticket
  const pay = (srcSys.issueMode && srcSys.issueMode.pay) || {};
  const label = k => pay[k + 'Label'] || PAY_LABEL_DEF[k];
  if (ticket.payRoute) ticket.routeLabel = label(ticket.payRoute + (type.drugSize && !groupRule ? type.drugSize : ''));
  if (ticket.deptQueue) ticket.deptLabel = label(type.payRule);
  if (toCashier) {
    const me = systems.find(x => x.id === srcSysId);
    ticket.payRoute = 'cash'; ticket.noDrug = true;
    ticket.routeLabel = label('noDrug');
    ticket.issuedFrom = { sysId: srcSysId, name: me ? me.name : '' };
    ticket.forwardSkipped = true;   // already at the cashier — never auto-sent on (e.g. back to the pharmacy)
  }
  // เดินคิวตามสถานะ HOSxP: an OPD visit waits for the drug check before it can be called (or sent to การเงิน)
  if (!toCashier && !deptNoRoute && ticket.mode === 'opd' && ticket.vn && flowCashierOf(srcSysId, srcSys)) {
    ticket.flow = 'check';
    ticket.forwardSkipped = true;   // the flow moves it — "เรียกคิวถัดไป" must never auto-send it as well
  }
  s.waiting.push(ticket);
  // the issuing kiosk's log decides "มีประวัติออกคิวแล้ว", wherever the ticket went
  if (ticket.vn) (srcSys.issuedLog = srcSys.issuedLog || []).push({ ...issuedEntry(ticket), ...(toCashier ? { sysId } : {}) });
  saveQueueState(sysId, sys);
  if (toCashier) saveQueueState(srcSysId, srcSys);
  dbIssueTicket(sysId, ticket);
  io.to('sys-' + sysId).emit('queue_issued', { ticket, typeWaiting: typeWaiting(sys), allWaiting: allWaiting(sys) });
  res.json({ success: true, ticket, toSys: toCashier ? { sysId, name: (systems.find(x => x.id === sysId) || {}).name || '' } : undefined });
});

// "ไม่มียา แต่ต้องไปการเงิน" set up and usable? → { sysId, sys, type } of the cashier room
function noDrugTarget(srcSysId, srcSys) {
  const pay = (srcSys.issueMode && srcSys.issueMode.pay) || {};
  if (srcSys.issueMode.mode !== 'pay' || pay.noDrugOn !== true) return null;
  const me = systems.find(x => x.id === srcSysId);
  const id = Number(pay.noDrugSysId);
  if (!((me && me.forwardTo) || []).includes(id)) return null;
  const tsys = getSys(id);
  const type = tsys && tsys.queueTypes.find(t => t.id === pay.noDrugTypeId && t.noDrugFrom === srcSysId);
  return type ? { sysId: id, sys: tsys, type } : null;
}

// ── เรียกแล้ววันนี้: one compact line per call, kept all day (the served lists only hold the latest 40) ──
function logCalled(sys, t) {
  const log = sys.calledLog = sys.calledLog || [];
  log.push({ display: t.display, prefix: t.prefix, color: t.color, typeId: t.typeId, typeName: t.typeName, mode: t.mode || 'opd',
    qn: t.qn || null, hn: t.hn || null, vn: t.vn || null, patientName: t.patientName || null, pttypeName: t.pttypeName || null,
    issuedAt: t.issuedAt || '', calledAt: t.calledAt, calledTs: t._ts, counterName: t.counterName || '',
    payRoute: t.payRoute || null, routeLabel: t.routeLabel || null, deptLabel: t.deptLabel || null,
    flowForced: t.flowForced || undefined, flowFrom: t.flowFrom || undefined, endsAtCashier: t.endsAtCashier || undefined,
    from: t.forwardedFrom ? t.forwardedFrom.name : undefined, back: t.flowBack ? t.flowBack.at : undefined,
    rxCheckedAt: t.rxCheckedAt || undefined, returned: t.returned || undefined });
  if (log.length > 3000) log.shift();
}
// later news about the latest call of a queue (เรียกซ้ำ / ไม่มา / คืนคิว / ส่งต่อ / ชำระแล้ว)
function logMark(sys, display, patch) {
  const log = sys.calledLog || [];
  for (let i = log.length - 1; i >= 0; i--) if (log[i].display === display) {
    const e = log[i];
    if (typeof patch === 'function') patch(e); else Object.assign(e, patch);
    return;
  }
}
app.get('/api/sys/:sysId/called-today', requireSys, (req, res) => {
  res.json({ success: true, list: [...(req.sys.calledLog || [])].reverse() });
});

// ══ Dashboard ระยะเวลารอคอย (ออกคิว → ตรวจยา → จ่ายยา) ═══════════════════════
// rows from the queue history table (app_queue_opd: issued_at / called_at), the drug-check time from HOSxP
// (rx_dispenser_detail type 3, first check of the visit); today's calls are filled in from the day's call log
const pad2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hms = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const toDate = v => v == null || v === '' ? null : v instanceof Date ? v : new Date(String(v).replace(' ', 'T'));
const minsBetween = (a, b) => a && b && b >= a ? Math.round((b - a) / 600) / 100 : null;   // minutes, 2 decimals

// trace (optional): every query run, with its parameters, row count and time — shown to admins on the dashboard
async function waitReport(sysId, sys, from, to, trace) {
  const run = async (title, sql, params) => {
    const t0 = Date.now(), [rows] = await hosQuery([[sql, params]]);
    if (trace) trace.push({ title, sql: sql.replace(/\n\s+/g, '\n  ').trim(), params, rows: rows.length, ms: Date.now() - t0 });
    return rows;
  };
  const rows = await run("1. คิวที่ออกในช่วงวันที่ (ประวัติคิวของระบบ)",
    `SELECT service_date, vn, type_id, type_name, prefix, display, hn, qn, patient_name, status, issued_at, called_at, counter_name
       FROM app_queue_opd WHERE sys_id = ? AND service_date BETWEEN ? AND ? ORDER BY service_date, issued_at`, [sysId, from, to]);
  // drug check (first stamp of the visit) for every VN in range — in chunks
  const vns = [...new Set(rows.map(r => String(r.vn || '').trim()).filter(Boolean))];
  // every pharmacy step HOSxP stamps (rx_dispenser_type): 1 ผู้บันทึกรายการใบสั่งยา · 2 ผู้จัดยา · 3 ผู้ตรวจสอบยา · 4 ผู้จ่ายยา
  const steps = new Map();
  for (let i = 0; i < vns.length; i += 500) {
    const part = vns.slice(i, i + 500);
    const at = n => `MIN(CASE WHEN r.rx_dispenser_type_id = ${n} THEN r.rx_dispenser_datetime END) AS t${n}`;
    // staff = officer_login_name → the officer's name (the login itself if not found)
    const by = n => `MAX(CASE WHEN r.rx_dispenser_type_id = ${n} THEN COALESCE(o.officer_name, r.staff) END) AS s${n}`;
    const rx = await run(`2. เวลาแต่ละขั้นตอนห้องยาจาก HOSxP (rx_dispenser_type 1–4, VN ชุดที่ ${i / 500 + 1})`,
      `SELECT r.vn, ${[1, 2, 3, 4].map(at).join(', ')}, ${[1, 2, 3, 4].map(by).join(', ')} FROM rx_dispenser_detail r
      LEFT JOIN officer o ON o.officer_login_name = r.staff
      WHERE r.rx_dispenser_type_id IN (1, 2, 3, 4) AND r.vn IN (${part.map(() => '?').join(',')}) GROUP BY r.vn`, part);
    rx.forEach(r => {
      const vn = String(r.vn).trim();
      steps.set(vn, [1, 2, 3, 4].map(n => ({ at: toDate(r['t' + n]), by: String(r['s' + n] || '').trim() })));
    });
  }
  // call times of the same VN in this room and in the flow partner (การเงิน ↔ ห้องยา) — from app_queue_events,
  // e.sys_id = the room the event happened in (a queue sent to another room gets its own app_queue_opd row there)
  const other = flowOtherOf(sysId), calls = new Map();
  for (let i = 0; i < vns.length; i += 500) {
    const part = vns.slice(i, i + 500);
    const ev = await run(`4. เวลาเรียกคิวแยกห้อง: ห้องนี้ / ${other.label} (app_queue_events, VN ชุดที่ ${i / 500 + 1})`,
      `SELECT o.vn, e.sys_id, e.event_type, MIN(e.event_at) AS t_first
         FROM app_queue_opd o JOIN app_queue_events e ON e.ticket_id = o.id
        WHERE o.service_date BETWEEN ? AND ? AND e.event_type IN ('issued', 'called')
          AND o.vn IN (${part.map(() => '?').join(',')})
        GROUP BY o.vn, e.sys_id, e.event_type`, [from, to, ...part]);
    ev.forEach(r => {
      const vn = String(r.vn).trim(), sid = Number(r.sys_id), mine = sid === Number(sysId);
      if (!mine && other.ids.length && !other.ids.includes(sid)) return;
      const c = calls.get(vn) || {}, t = toDate(r.t_first);
      const keep = k => { if (t && (!c[k] || t < c[k])) c[k] = t; };
      if (mine && r.event_type === 'called') keep('call1');
      if (!mine && r.event_type === 'issued') keep('oIn');
      if (!mine && r.event_type === 'called') keep('oCall');
      calls.set(vn, c);
    });
  }
  // today: the last call of each queue from the day's call log (the table may have missed a call)
  const today = todayStr(), lastCall = new Map();
  for (const e of sys.calledLog || []) if (e.calledTs && !e.notCalled) lastCall.set(e.display, new Date(e.calledTs));
  if (trace && from <= today && today <= to) trace.push({ title: "3. เวลาเรียกคิวของวันนี้ (บันทึกการเรียกในโปรแกรม ไม่ใช่ SQL)",
    sql: "-- วันนี้: ใช้เวลาเรียกล่าสุดของแต่ละคิวจากบันทึกการเรียกของวัน (calledLog) แทน called_at ถ้ามี", params: [], rows: lastCall.size, ms: 0 });
  return rows.map(r => {
    const date = r.service_date instanceof Date ? ymd(r.service_date) : String(r.service_date).slice(0, 10);
    const issued = toDate(r.issued_at);
    let called = toDate(r.called_at);
    if (date === today && lastCall.has(r.display)) called = lastCall.get(r.display);
    // รอตรวจ / รอจ่าย come from HOSxP's own stamps (the VN is the visit): บันทึกใบสั่งยา → ตรวจสอบยา → จ่ายยา
    const st = steps.get(String(r.vn || '').trim()) || [{}, {}, {}, {}];
    const [rec, prep, , disp] = st.map(x => x.at || null), chk3 = st[2].at || null, chk = chk3;
    const cl = calls.get(String(r.vn || '').trim()) || {};
    const call1 = cl.call1 || called, oIn = cl.oIn || null, oCall = cl.oCall || null;
    return { date,
      // first call in this room + when the partner room (การเงิน / ห้องยา) received and called the same VN
      call1: call1 ? hms(call1) : '', call1Ts: call1 ? +call1 : null,
      otherIn: oIn ? hms(oIn) : '', otherInTs: oIn ? +oIn : null, otherCall: oCall ? hms(oCall) : '', otherCallTs: oCall ? +oCall : null,
      // HOSxP pharmacy steps (raw stamps of this VN) + the minutes between them
      rxRecord: rec ? hms(rec) : '', rxPrepare: prep ? hms(prep) : '', rxCheck: chk3 ? hms(chk3) : '', rxDispense: disp ? hms(disp) : '',
      rxRecordTs: rec ? +rec : null, rxPrepareTs: prep ? +prep : null, rxCheckTs: chk3 ? +chk3 : null, rxDispenseTs: disp ? +disp : null,
      rxStaff: st.map(x => x.by || ''),
      mRecPrep: minsBetween(rec, prep), mPrepCheck: minsBetween(prep, chk3), mRecCheck: minsBetween(rec, chk3),
      mCheckDisp: minsBetween(chk3, disp), mRecDisp: minsBetween(rec, disp), display: r.display, typeId: Number(r.type_id) || null, typeName: r.type_name || '', prefix: r.prefix || '',
      hn: r.hn || '', qn: r.qn || '', name: r.patient_name || '', status: r.status || '',
      issued: issued ? hms(issued) : '', checked: chk ? hms(chk) : '', called: called ? hms(called) : '',
      issuedTs: issued ? +issued : null, checkedTs: chk ? +chk : null, calledTs: called ? +called : null,
      waitCheck: minsBetween(rec, chk), waitDispense: minsBetween(chk, disp), waitTotal: minsBetween(issued, called) };
  });
}

// ── minimal .xlsx writer (stored zip, no extra library) ──
const CRC_TABLE = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipStore(files) {
  const parts = [], central = []; let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8'), fname = Buffer.from(name, 'utf8'), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fname.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(fname.length, 28); cen.writeUInt32LE(offset, 42);
    parts.push(local, fname, data); central.push(cen, fname); offset += 30 + fname.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
// sheets: [{ name, title, sub, header: [...], rows: [[cell…]…], totals: [row index…], center: [col index…], widths: [...] }]
// TH SarabunPSK 18 throughout; title + sub-title on top, a dark header row, thin borders on every cell, banded rows,
// highlighted totals, frozen header and filter buttons
function buildXlsx(sheets) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const col = i => { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
  const ST = { header: 1, body: 2, band: 3, total: 4, title: 5, sub: 6, bodyC: 7, bandC: 8, totalC: 9 };   // cellXfs ids below
  const cell = (ref, v, st) => v == null || v === '' ? `<c r="${ref}" s="${st}"/>`
    : typeof v === 'number' && isFinite(v) ? `<c r="${ref}" s="${st}"><v>${v}</v></c>`
    : `<c r="${ref}" s="${st}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
  const sheetXml = sh => {
    const n = sh.header.length, last = col(n - 1), HR = 4, first = HR + 1, lastRow = HR + sh.rows.length;
    const totals = new Set(sh.totals || []), center = new Set(sh.center || []);
    const rowsXml = sh.rows.map((row, i) => {
      const r = first + i, kind = totals.has(i) ? 'total' : i % 2 ? 'band' : 'body';
      return `<row r="${r}">${sh.header.map((_, c) => cell(col(c) + r, row[c], ST[kind + (center.has(c) ? 'C' : '')])).join('')}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="${HR}" topLeftCell="A${first}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
      `<sheetFormatPr defaultRowHeight="26"/>` +
      `<cols>${(sh.widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
      `<sheetData>` +
        `<row r="1" ht="38" customHeight="1">${cell('A1', sh.title || sh.name, ST.title)}</row>` +
        `<row r="2">${cell('A2', sh.sub || '', ST.sub)}</row><row r="3" ht="8" customHeight="1"/>` +
        `<row r="${HR}" ht="34" customHeight="1">${sh.header.map((h, c) => cell(col(c) + HR, h, ST.header)).join('')}</row>` +
        rowsXml +
      `</sheetData>` +
      (sh.rows.length ? `<autoFilter ref="A${HR}:${last}${lastRow}"/>` : '') +
      `<mergeCells count="2"><mergeCell ref="A1:${last}1"/><mergeCell ref="A2:${last}2"/></mergeCells>` +
      `<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="landscape"/>` +
      `</worksheet>`;
  };
  const F = 'TH SarabunPSK', font = (extra, sz = 18) => `<font>${extra}<sz val="${sz}"/>${''}<name val="${F}"/><family val="2"/><charset val="222"/></font>`;
  const solid = rgb => `<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
  const xf = (fontId, fillId, borderId, align) => `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"` +
    ` applyFont="1" applyFill="1" applyBorder="1"${align ? ` applyAlignment="1"><alignment ${align}/></xf>` : '/>'}`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="5">` +
      font('') +                                         // 0 body (the workbook default: TH SarabunPSK 18)
      font('<b/><color rgb="FFFFFFFF"/>') +              // 1 header — white bold
      font('<b/><color rgb="FF1F3864"/>') +              // 2 total — navy bold
      font('<b/><color rgb="FF1F3864"/>', 24) +          // 3 title
      font('<color rgb="FF595959"/>') +                  // 4 sub-title — grey
    `</fonts>` +
    `<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
      solid('FF1F4E79') + solid('FFF2F7FC') + solid('FFFFF2CC') + `</fills>` +   // 2 header · 3 band · 4 total
    `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>` +
      `<border>${['left', 'right', 'top', 'bottom'].map(e => `<${e} style="thin"><color rgb="FFB7C9E2"/></${e}>`).join('')}<diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="10">` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +           // 0 default
      xf(1, 2, 1, 'horizontal="center" vertical="center" wrapText="1"') +          // 1 header
      xf(0, 0, 1, 'vertical="center"') +                                           // 2 body
      xf(0, 3, 1, 'vertical="center"') +                                           // 3 band
      xf(2, 4, 1, 'vertical="center"') +                                           // 4 total
      xf(3, 0, 0, 'vertical="center"') +                                           // 5 title
      xf(4, 0, 0, 'vertical="center"') +                                           // 6 sub-title
      xf(0, 0, 1, 'horizontal="center" vertical="center"') +                       // 7 body, centred
      xf(0, 3, 1, 'horizontal="center" vertical="center"') +                       // 8 band, centred
      xf(2, 4, 1, 'horizontal="center" vertical="center"') +                       // 9 total, centred
    `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', styles],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return zipStore(files);
}

app.get('/api/sys/:sysId/wait-report', requireSys, async (req, res) => {
  const okDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const from = okDate(req.query.from) ? req.query.from : todayStr(), to = okDate(req.query.to) ? req.query.to : from;
  if (from > to) return res.json({ success: false, message: 'วันที่เริ่มต้องไม่มากกว่าวันที่สิ้นสุด' });
  if ((new Date(to) - new Date(from)) / 864e5 > 366) return res.json({ success: false, message: 'เลือกช่วงได้ไม่เกิน 1 ปี' });
  const typeIds = String(req.query.types || '').split(',').map(Number).filter(Boolean);
  try {
    const trace = [];
    const all = await waitReport(req.sysId, req.sys, from, to, trace);
    // every type seen in the range (names as they were issued) — for the filter chips
    const types = [...new Map(all.map(r => [r.typeId, { id: r.typeId, name: r.typeName, prefix: r.prefix,
      color: (req.sys.queueTypes.find(t => t.id === r.typeId) || {}).color || null }])).values()];
    const rows = typeIds.length ? all.filter(r => typeIds.includes(r.typeId)) : all;
    const otherLabel = flowOtherOf(req.sysId).label;
    if (req.query.format !== 'xlsx') return res.json({ success: true, from, to, types, rows, otherLabel, queries: trace, dbType: loadDbConfig().type || '' });

    const avg = a => { const v = a.filter(x => x != null); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length * 10) / 10 : null; };
    const max = a => { const v = a.filter(x => x != null); return v.length ? Math.round(Math.max(...v) * 10) / 10 : null; };
    const groups = [...new Map(rows.map(r => [r.typeId, r.prefix ? `${r.prefix} ${r.typeName}` : r.typeName])).entries()]
      .sort((a, b) => a[1].localeCompare(b[1], 'th', { numeric: true }));   // 1 2 3 … then A B …
    const sumRow = (label, list) => [label, list.length, list.filter(r => r.calledTs).length, list.filter(r => r.checkedTs).length,
      avg(list.map(r => r.waitCheck)), avg(list.map(r => r.waitDispense)), avg(list.map(r => r.waitTotal)), max(list.map(r => r.waitTotal))];
    const sysName = (systems.find(x => x.id === req.sysId) || {}).name || '';
    const thDate = d => { const [y, m, dd] = d.split('-').map(Number); return `${dd}/${m}/${y + 543}`; };
    const range = from === to ? `วันที่ ${thDate(from)}` : `วันที่ ${thDate(from)} ถึง ${thDate(to)}`;
    const typeNote = typeIds.length ? ` · เฉพาะประเภท: ${groups.map(([, l]) => l).join(', ')}` : ' · ทุกประเภทคิว';
    const sub = `${sysName} · ${range}${typeNote} · ออกรายงาน ${thDate(todayStr())} ${hms(new Date()).slice(0, 5)} น.`;
    const sumRows = [...groups.map(([id, label]) => sumRow(label, rows.filter(r => r.typeId === id))), sumRow('รวมทั้งหมด', rows)];
    const buf = buildXlsx([
      { name: 'สรุปตามประเภทคิว', title: 'สรุประยะเวลารอคอยตามประเภทคิว', sub,
        widths: [36, 14, 16, 16, 34, 32, 19, 17], center: [1, 2, 3, 4, 5, 6, 7], totals: [sumRows.length - 1],
        header: ['ประเภทคิว', 'จำนวนคิว', 'ตรวจยาแล้ว', 'จ่ายยาแล้ว', 'เฉลี่ยรอตรวจยา นาที (บันทึก→ตรวจ HOSxP)', 'เฉลี่ยรอจ่ายยา นาที (ตรวจ→จ่าย HOSxP)', 'เฉลี่ยรวม (นาที)', 'นานสุด (นาที)'],
        rows: sumRows.map(r => [r[0], r[1], r[3], r[2], r[4], r[5], r[6], r[7]]) },
      { name: 'ขั้นตอนห้องยา HOSxP', title: 'เวลาเฉลี่ยระหว่างขั้นตอนห้องยา (rx_dispenser_detail ใน HOSxP)', sub,
        widths: [36, 14, 14, 14, 14, 14, 22, 22, 22, 22, 22], center: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], totals: [groups.length],
        header: ['ประเภทคิว', 'บันทึกใบสั่งยา', 'จัดยา', 'ตรวจสอบยา', 'จ่ายยา', 'จำนวนคิว', 'บันทึก → จัดยา (นาที)', 'จัดยา → ตรวจสอบ (นาที)',
          'บันทึก → ตรวจสอบ (นาที)', 'ตรวจสอบ → จ่ายยา (นาที)', 'บันทึก → จ่ายยา (นาที)'],
        rows: [...groups.map(([id, label]) => [label, rows.filter(r => r.typeId === id)]), ['รวมทั้งหมด', rows]].map(([label, l]) => [label,
          l.filter(r => r.rxRecordTs).length, l.filter(r => r.rxPrepareTs).length, l.filter(r => r.rxCheckTs).length, l.filter(r => r.rxDispenseTs).length, l.length,
          avg(l.map(r => r.mRecPrep)), avg(l.map(r => r.mPrepCheck)), avg(l.map(r => r.mRecCheck)), avg(l.map(r => r.mCheckDisp)), avg(l.map(r => r.mRecDisp))]) },
      { name: 'รายละเอียด', title: 'รายละเอียดระยะเวลารอคอยรายคิว', sub,
        widths: [14, 12, 30, 14, 9, 32, 15, 24, 17, 18, 18, 20, 20, 20, 20, 32, 30, 28, 13, 30, 24, 28, 24],
        center: [0, 1, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
        header: ['วันที่', 'เลขคิว', 'ประเภทคิว', 'HN', 'QN', 'ชื่อผู้รับบริการ', 'ออกคิว (คิว)', 'บันทึกใบสั่งยา (HOSxP)', 'จัดยา (HOSxP)', 'ตรวจยา (HOSxP)',
          'จ่ายยา (HOSxP)', 'เรียกครั้งแรก (คิว)', `${otherLabel} รับคิว (คิว)`, `${otherLabel} เรียก (คิว)`, 'เรียกจ่ายยา (คิว)',
          'รอตรวจยา นาที (บันทึกใบสั่งยา→ตรวจยา HOSxP)', 'รอจ่ายยา นาที (ตรวจยา→จ่ายยา HOSxP)', 'รวม นาที (ออกคิว→เรียก)', 'สถานะ',
          'ผู้บันทึกใบสั่งยา (HOSxP)', 'ผู้จัดยา (HOSxP)', 'ผู้ตรวจสอบยา (HOSxP)', 'ผู้จ่ายยา (HOSxP)'],
        rows: rows.map(r => [thDate(r.date), r.display, r.typeName, r.hn, r.qn, r.name, r.issued, r.rxRecord, r.rxPrepare, r.rxCheck, r.rxDispense,
          r.call1, r.otherIn, r.otherCall, r.called,
          r.waitCheck, r.waitDispense, r.waitTotal, { waiting: 'รอ', called: 'เรียกแล้ว', noshow: 'ไม่มา' }[r.status] || r.status, ...r.rxStaff]) },
    ]);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="wait-report-${from}_${to}.xlsx"`);
    res.send(buf);
  } catch (err) {
    res.json({ success: false, message: 'ดึงข้อมูลไม่สำเร็จ: ' + err.message });
  }
});

// ⬇ Excel of one dashboard tile: the page sends the table it shows, the server styles it like the report above
app.post('/api/sys/:sysId/xlsx', requireSys, (req, res) => {
  const b = req.body || {};
  const cellOk = v => v == null ? '' : typeof v === 'number' && isFinite(v) ? v : String(v).slice(0, 500);
  const sheets = (Array.isArray(b.sheets) ? b.sheets : []).slice(0, 5).map((s, i) => {
    const header = (Array.isArray(s.header) ? s.header : []).slice(0, 40).map(h => String(h ?? ''));
    const rows = (Array.isArray(s.rows) ? s.rows : []).slice(0, 20000).map(r => header.map((_, c) => cellOk(Array.isArray(r) ? r[c] : '')));
    const nums = a => (Array.isArray(a) ? a : []).map(Number).filter(n => Number.isInteger(n) && n >= 0);
    return { name: String(s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31), title: String(s.title || '').slice(0, 200),
      sub: String(s.sub || '').slice(0, 300), header, rows, totals: nums(s.totals), center: nums(s.center),
      widths: header.map((h, c) => Number((s.widths || [])[c]) || Math.min(45, Math.max(12, h.length * 1.4 + 4))) };
  }).filter(s => s.header.length);
  if (!sheets.length) return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลสำหรับ Excel' });
  const name = String(b.filename || 'export').replace(/[\\/:*?"<>|\r\n]/g, ' ').slice(0, 120) + '.xlsx';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(buildXlsx(sheets));
});

function doCall(sys, sysId, ticket, s, counterId) {
  let counter = sys.counters.find(c => c.id === Number(counterId));
  if (!counter && sys.counters.length) counter = sys.counters[0]; // fallback to first counter
  const called  = {
    ...ticket,
    parked:      undefined,   // calling a parked (เก็บคิว) queue un-parks it
    calledAt:    new Date().toLocaleTimeString('th-TH'),
    counterId:   counter?.id   || null,
    counterName: counter?.name || '',
    _ts: Date.now(),
  };
  s.calledQueue = called;
  s.served.unshift(called);
  if (s.served.length > 40) s.served.pop();
  if (called.counterId) {
    sys.lastCalledByCounter[called.counterId] = called;
    if (!sys.recentByCounter[called.counterId]) sys.recentByCounter[called.counterId] = [];
    sys.recentByCounter[called.counterId].unshift(called);
    if (sys.recentByCounter[called.counterId].length > 10) sys.recentByCounter[called.counterId].pop();
  }
  broadcastCall(sysId, sys, called);
  logCalled(sys, called);
  saveQueueState(sysId, sys);
  dbCallTicket(sysId, called);
  // การเงินเรียกคิวของห้องยา → the pharmacy's "อยู่ที่การเงิน" lane shows it straight away
  if (called.flowFrom) setImmediate(() => emitFlow(called.flowFrom));
  return called;
}

app.post('/api/sys/:sysId/call-next', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const typeId    = req.body.typeId    ? Number(req.body.typeId)    : null;
  const counterId = req.body.counterId ? Number(req.body.counterId) : null;
  let ticket = null, s = null;
  // a queue still waiting for the drug check (pharmacy flow), or one staff parked (เก็บคิว), is never "next"
  const callable = t => t.flow !== 'check' && !t.parked;
  const notReady = list => { const n = list.filter(t => !callable(t)).length; return n ? ` (รอตรวจสอบยา ${n} คิว)` : ''; };
  if (typeId) {
    s = sys.state[typeId];
    if (!s || !s.waiting.length) return res.json({ success: false, message: 'ไม่มีคิวรอในประเภทนี้' });
    s.waiting.sort((a, b) => a._ts - b._ts);
    const idx = s.waiting.findIndex(callable);
    if (idx === -1) return res.json({ success: false, message: 'ยังไม่มีคิวที่พร้อมเรียกในประเภทนี้' + notReady(s.waiting) });
    [ticket] = s.waiting.splice(idx, 1);
  } else {
    const all = allWaiting(sys);
    if (!all.length) return res.json({ success: false, message: 'ไม่มีคิวรอ' });
    ticket = all.find(callable);
    if (!ticket) return res.json({ success: false, message: 'ยังไม่มีคิวที่พร้อมเรียก' + notReady(all) });
    s = sys.state[ticket.typeId];
    const idx = s.waiting.findIndex(t => t.display === ticket.display);
    if (idx !== -1) s.waiting.splice(idx, 1);
  }
  const prev = currentAtCounter(sys, counterId);
  const calledQueue = doCall(sys, sysId, ticket, s, counterId);
  res.json({ success: true, calledQueue, autoForwarded: autoForwardPrevious(sysId, sys, prev, calledQueue.display) });
});

app.post('/api/sys/:sysId/call-number', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const input     = (req.body.display || '').trim();
  const upper     = input.toUpperCase();
  const counterId = req.body.counterId ? Number(req.body.counterId) : null;
  const match = t => t.display === upper || dispKey(t.display) === dispKey(upper) || (t.qn && String(t.qn).trim() === input);
  // การเงิน + เรียกแบบ manual: a QN still waiting for the drug check at a pharmacy is pulled here and called
  // (it comes back to the pharmacy once paid, and waits there for the check if it still hasn't been done)
  if (flowManualCall(sys) && !Object.values(sys.state).some(s => s.waiting.some(match))) {
    for (const pharmId of flowPharmaciesOf(sysId)) {
      const pharm = getSys(pharmId);
      const w = Object.values(pharm.state).map(s => ({ s, i: s.waiting.findIndex(t => t.flow === 'check' && match(t)) })).find(x => x.i !== -1);
      if (!w) continue;
      const t = w.s.waiting[w.i];
      flowLog(t, 'การเงินเรียกก่อนตรวจยา (manual)', req.body.by, 'คนไข้มาถึงการเงินก่อน');
      if (flowPass(pharmId, pharm, t.display, { route: 'cash', unchecked: true })) {
        saveQueueState(pharmId, pharm);
        emitFlow(pharmId);
      }
      break;
    }
  }
  for (const s of Object.values(sys.state)) {
    const idx = s.waiting.findIndex(match);
    if (idx !== -1) {
      if (s.waiting[idx].flow === 'check') {
        if (!flowManualCall(sys))
          return res.json({ success: false, message: `คิว ${s.waiting[idx].display} ยังไม่ผ่านการตรวจสอบยา — เรียกได้เมื่อตรวจยาเสร็จ (หรือเปิด "เรียกแบบ manual" ใน ⚙)` });
        // เรียกแบบ manual: called before the drug check — logged on the ticket
        const h = s.waiting[idx];
        flowLog(h, 'เรียกก่อนตรวจยา (manual)', req.body.by, 'เรียกแบบ manual');
        h.flowForced = true;
      }
      const [ticket] = s.waiting.splice(idx, 1);
      const prev = currentAtCounter(sys, counterId);
      const calledQueue = doCall(sys, sysId, ticket, s, counterId);
      return res.json({ success: true, calledQueue, autoForwarded: autoForwardPrevious(sysId, sys, prev, calledQueue.display) });
    }
  }
  res.json({ success: false, message: 'ไม่พบหมายเลขคิวนี้ในระบบ' });
});

// ── Uncall (return ticket to waiting) ────────────────────────────────────
app.post('/api/sys/:sysId/uncall', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const display = (req.body.display || '').toUpperCase().trim();
  for (const s of Object.values(sys.state)) {
    const idx = s.served.findIndex(t => t.display === display && !t.noShow);
    if (idx !== -1) {
      const [ticket] = s.served.splice(idx, 1);
      if (s.calledQueue?.display === display) s.calledQueue = null;
      for (const [cid, t] of Object.entries(sys.lastCalledByCounter)) {
        if (t.display === display) delete sys.lastCalledByCounter[cid];
      }
      if (ticket.counterId) {
        const rc = sys.recentByCounter[ticket.counterId];
        if (rc) { const ri = rc.findIndex(t => t.display === display); if (ri !== -1) rc.splice(ri, 1); }
      }
      const restored = {
        ...ticket,
        issuedTs:    ticket.issuedTs || ticket._ts,
        _ts:         ticket.readyTs || ticket.issuedTs || ticket._ts,   // pharmacy flow: back to its "พร้อมจ่าย" place
        returned:    !req.body.park,
        returnedAt:  new Date().toLocaleTimeString('th-TH'),
        // เก็บคิว: back in the list but skipped by "เรียกคิวถัดไป" until someone calls it on purpose
        parked:      req.body.park ? { at: new Date().toLocaleTimeString('th-TH'), reason: String(req.body.reason || '').slice(0, 80),
                                       by: ticket.counterName || '' } : undefined,
        returnCount: (ticket.returnCount || 0) + 1,
        calledAt:    undefined,
        counterId:   undefined,
        counterName: undefined,
      };
      s.waiting.push(restored);
      s.waiting.sort((a, b) => a._ts - b._ts);
      logMark(sys, display, req.body.park ? { parkedAt: restored.returnedAt, parkReason: restored.parked.reason } : { uncalledAt: restored.returnedAt });
      saveQueueState(sysId, sys);
      dbReturnTicket(sysId, display);
      io.to('sys-' + sysId).emit('queue_uncalled', {
        display,
        typeWaiting:         typeWaiting(sys),
        allWaiting:          allWaiting(sys),
        allServed:           allServed(sys),
        lastCalledByCounter: sys.lastCalledByCounter,
        recentByCounter:     sys.recentByCounter,
      });
      return res.json({ success: true });
    }
  }
  res.json({ success: false, message: 'ไม่พบคิวนี้ในประวัติ' });
});

// ── Delete from waiting queue ─────────────────────────────────────────────
app.post('/api/sys/:sysId/delete-waiting', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const display = (req.body.display || '').toUpperCase().trim();
  for (const s of Object.values(sys.state)) {
    const idx = s.waiting.findIndex(t => t.display === display);
    if (idx !== -1) {
      const [ticket] = s.waiting.splice(idx, 1);
      // kept for the day (history → "คิวที่ลบ") so a wrong delete can be put back
      if (!sys.deletedQueues) sys.deletedQueues = [];
      sys.deletedQueues.unshift({ ...ticket, deletedAt: new Date().toLocaleTimeString('th-TH') });
      if (sys.deletedQueues.length > 200) sys.deletedQueues.pop();
      // a deleted ticket was a mistake → that patient may be issued again (a "ไม่มียา" ticket is logged at the issuing kiosk)
      const logSys = (ticket.issuedFrom && getSys(ticket.issuedFrom.sysId)) || sys;
      logSys.issuedLog = (logSys.issuedLog || []).filter(e => !(e.display === display && e.vn === ticket.vn));
      if (logSys !== sys) saveQueueState(ticket.issuedFrom.sysId, logSys);
      saveQueueState(sysId, sys);
      emitWaitingChanged(sysId, sys, display);
      return res.json({ success: true });
    }
  }
  res.json({ success: false, message: 'ไม่พบคิวนี้ในรายการรอ' });
});

// ── Close a waiting queue without calling it (คลิกที่คิว → เมนู) ───────────────────
//   as: 'noshow' → เรียกแล้วไม่มา (goes to the no-show list, can be called back from there)
//   as: 'done'   → ให้บริการแล้ว ไม่ต้องเรียก (e.g. the drugs were already handed over)
// Never announced and never put on a counter's screen; kept in "เรียกแล้ว" marked ไม่ได้เรียก.
app.post('/api/sys/:sysId/close-waiting', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const display = (req.body.display || '').toUpperCase().trim();
  const as = req.body.as === 'done' ? 'done' : 'noshow';
  const w = findWaiting(sys, display);
  if (!w) return res.json({ success: false, message: 'ไม่พบคิวนี้ในรายการรอ' });
  const [t0] = w.s.waiting.splice(w.i, 1);
  const counter = sys.counters.find(c => c.id === Number(req.body.counterId));
  const at = new Date().toLocaleTimeString('th-TH');
  const closed = { ...t0, calledAt: at, _ts: Date.now(), notCalled: true,
    counterId: counter ? counter.id : undefined, counterName: counter ? counter.name : '',
    noShow: as === 'noshow' || undefined, parked: undefined };
  w.s.served.unshift(closed);
  if (w.s.served.length > 40) w.s.served.pop();
  logCalled(sys, closed);
  const by = String(req.body.by || '').slice(0, 60) || undefined;
  if (as === 'noshow') {
    const entry = { ...closed, noShowAt: at, noShowTs: Date.now() };
    logMark(sys, display, { notCalled: true, noShowAt: at, closedBy: by });
    sys.noShows.unshift(entry);
    if (sys.noShows.length > 50) sys.noShows.pop();
    saveQueueState(sysId, sys);
    dbNoShow(sysId, display);
    io.to('sys-' + sysId).emit('queue_noshow', { display, entry, noShows: sys.noShows.slice(0, 40), allServed: allServed(sys) });
  } else {
    logMark(sys, display, { notCalled: true, closedAt: at, closedBy: by });
    saveQueueState(sysId, sys);
    dbCallTicket(sysId, closed);
    io.to('sys-' + sysId).emit('queue_noshow', { display, noShows: sys.noShows.slice(0, 40), allServed: allServed(sys) });
  }
  emitWaitingChanged(sysId, sys, display);
  res.json({ success: true, as, at });
});

// waiting list changed by a delete / restore — every page refreshes its waiting list and "คิวที่ลบ"
function emitWaitingChanged(sysId, sys, display) {
  io.to('sys-' + sysId).emit('queue_deleted_waiting', {
    display,
    typeWaiting:   typeWaiting(sys),
    allWaiting:    allWaiting(sys),
    deletedQueues: sys.deletedQueues || [],
  });
}

// ── Restore a deleted queue (same number, back in its original place in the line) ──
app.post('/api/sys/:sysId/restore-deleted', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const display = (req.body.display || '').toUpperCase().trim();
  const idx = (sys.deletedQueues || []).findIndex(t => t.display === display);
  if (idx === -1) return res.json({ success: false, message: 'ไม่พบคิวนี้ในรายการคิวที่ลบ' });
  const inLine = Object.values(sys.state).some(s => s.waiting.some(t => t.display === display) || s.served.some(t => t.display === display));
  if (inLine) return res.json({ success: false, message: `คิว ${display} อยู่ในระบบแล้ว` });
  const { deletedAt, ...ticket } = sys.deletedQueues[idx];
  // its queue type may have been removed since — then the first type of the same mode takes it
  const type = sys.queueTypes.find(t => t.id === ticket.typeId)
    || sys.queueTypes.find(t => t.forMode === (ticket.mode || 'opd') || t.forMode === 'both') || sys.queueTypes[0];
  if (!type) return res.json({ success: false, message: 'ระบบนี้ยังไม่มีประเภทคิว' });
  initTypeState(sys, type.id);
  const s = sys.state[type.id];
  s.waiting.push(type.id === ticket.typeId ? ticket : { ...ticket, typeId: type.id, typeName: type.name, color: type.color });
  s.waiting.sort((a, b) => a._ts - b._ts);
  sys.deletedQueues.splice(idx, 1);
  const logSys = (ticket.issuedFrom && getSys(ticket.issuedFrom.sysId)) || sys;
  if (ticket.vn && !(logSys.issuedLog || []).some(e => e.display === display)) {
    (logSys.issuedLog = logSys.issuedLog || []).push({ ...issuedEntry(ticket), ...(logSys !== sys ? { sysId } : {}) });
    if (logSys !== sys) saveQueueState(ticket.issuedFrom.sysId, logSys);
  }
  saveQueueState(sysId, sys);
  emitWaitingChanged(sysId, sys, display);
  res.json({ success: true });
});

// ── Clear counter display ─────────────────────────────────────────────────
app.post('/api/sys/:sysId/clear-counter', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const counterId = Number(req.body.counterId);
  if (!counterId) return res.json({ success: false, message: 'ไม่ระบุช่องบริการ' });
  const cid = String(counterId);
  delete sys.lastCalledByCounter[cid];
  delete sys.recentByCounter[cid];
  saveQueueState(sysId, sys);
  io.to('sys-' + sysId).emit('counter_cleared', {
    counterId,
    recentByCounter:     sys.recentByCounter     || {},
    lastCalledByCounter: sys.lastCalledByCounter  || {},
  });
  res.json({ success: true });
});

// ── Clear no-show from display (move to clearedNoShows, do NOT delete) ───
app.post('/api/sys/:sysId/clear-noshow-display', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const display = (req.body.display || '').toUpperCase().trim();
  const idx = sys.noShows.findIndex(t => t.display === display);
  if (idx === -1) return res.json({ success: false, message: 'ไม่พบคิวนี้ในรายการไม่มา' });
  const [ticket] = sys.noShows.splice(idx, 1);
  ticket.clearedAt = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  if (!sys.clearedNoShows) sys.clearedNoShows = [];
  sys.clearedNoShows.unshift(ticket);
  if (sys.clearedNoShows.length > 100) sys.clearedNoShows.pop();
  saveQueueState(sysId, sys);
  io.to('sys-' + sysId).emit('noshow_display_cleared', {
    noShows:        sys.noShows,
    clearedNoShows: sys.clearedNoShows.slice(0, 40),
  });
  res.json({ success: true });
});

// ── Recall served (re-announce without changing queue state) ─────────────
app.post('/api/sys/:sysId/recall-served', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const display   = (req.body.display || '').toUpperCase().trim();
  const counterId = req.body.counterId ? Number(req.body.counterId) : null;
  let ticket = null;
  for (const s of Object.values(sys.state)) {
    ticket = s.served.find(t => t.display === display);
    if (ticket) break;
  }
  if (!ticket) return res.json({ success: false, message: 'ไม่พบข้อมูลคิวนี้' });
  const counter = sys.counters.find(c => c.id === Number(counterId));
  const recalled = {
    ...ticket,
    calledAt:    new Date().toLocaleTimeString('th-TH'),
    counterId:   counter?.id   || ticket.counterId   || null,
    counterName: counter?.name || ticket.counterName || '',
    _ts: Date.now(),
  };
  if (recalled.counterId) {
    sys.lastCalledByCounter[recalled.counterId] = recalled;
    if (!sys.recentByCounter[recalled.counterId]) sys.recentByCounter[recalled.counterId] = [];
    sys.recentByCounter[recalled.counterId].unshift(recalled);
    if (sys.recentByCounter[recalled.counterId].length > 10) sys.recentByCounter[recalled.counterId].pop();
  }
  broadcastCall(sysId, sys, recalled);
  recalled.recalled = true;
  logMark(sys, display, e => { e.recalls = (e.recalls || 0) + 1; e.lastRecallAt = recalled.calledAt; });
  saveQueueState(sysId, sys);
  dbCallTicket(sysId, recalled);
  res.json({ success: true, calledQueue: recalled });
});

// ── No-show ───────────────────────────────────────────────────────────────
app.post('/api/sys/:sysId/no-show', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const { display } = req.body;
  if (!display) return res.status(400).json({ success: false, message: 'ระบุหมายเลขคิว' });
  let record = null;
  for (const s of Object.values(sys.state)) {
    const found = s.served.find(t => t.display === display);
    if (found) { found.noShow = true; record = found; break; }
  }
  if (!record) return res.json({ success: false, message: 'ไม่พบข้อมูลคิวนี้' });
  const entry = { ...record, noShowAt: new Date().toLocaleTimeString('th-TH'), noShowTs: Date.now() };
  logMark(sys, record.display, { noShowAt: entry.noShowAt });
  sys.noShows.unshift(entry);
  if (sys.noShows.length > 50) sys.noShows.pop();
  saveQueueState(sysId, sys);
  dbNoShow(sysId, display);
  io.to('sys-' + sysId).emit('queue_noshow', { display, entry, noShows: sys.noShows.slice(0, 40), allServed: allServed(sys) });
  res.json({ success: true, entry });
});

app.post('/api/sys/:sysId/recall-noshow', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const display   = (req.body.display || '').toUpperCase().trim();
  const counterId = req.body.counterId ? Number(req.body.counterId) : null;
  const idx       = sys.noShows.findIndex(t => t.display === display);
  if (idx === -1) return res.json({ success: false, message: 'ไม่พบในรายการไม่มา' });
  const entry   = sys.noShows[idx];
  const counter = sys.counters.find(c => c.id === Number(counterId));
  const recalled = {
    ...entry,
    calledAt:    new Date().toLocaleTimeString('th-TH'),
    counterId:   counter?.id   || entry.counterId   || null,
    counterName: counter?.name || entry.counterName || '',
    noShow: false, recalled: true, _ts: Date.now(),
  };
  for (const s of Object.values(sys.state)) {
    const si = s.served.findIndex(t => t.display === display);
    if (si !== -1) { s.served[si] = recalled; s.calledQueue = recalled; break; }
  }
  sys.noShows.splice(idx, 1);
  if (recalled.counterId) {
    sys.lastCalledByCounter[recalled.counterId] = recalled;
    if (!sys.recentByCounter[recalled.counterId]) sys.recentByCounter[recalled.counterId] = [];
    sys.recentByCounter[recalled.counterId].unshift(recalled);
    if (sys.recentByCounter[recalled.counterId].length > 10) sys.recentByCounter[recalled.counterId].pop();
  }
  broadcastCall(sysId, sys, recalled);
  saveQueueState(sysId, sys);
  dbCallTicket(sysId, recalled);
  io.to('sys-' + sysId).emit('noshow_recalled', { display, noShows: sys.noShows.slice(0, 40) });
  res.json({ success: true, calledQueue: recalled });
});

// ── Forward a called ticket to a linked system (same number, original issue time) ──
app.post('/api/sys/:sysId/forward', requireSys, (req, res) => {
  const { sys, sysId } = req;
  res.json(forwardTicket(sysId, sys, req.body.display, Number(req.body.targetSysId)));
});

function findServed(sys, display) {
  for (const s of Object.values(sys.state)) {
    const t = s.served.find(x => x.display === display && !x.noShow);
    if (t) return t;
  }
  return null;
}
function forwardTicket(sysId, sys, displayIn, targetId) {
  if (sys.cashierSettings.forwardEnabled === false) return { success: false, message: 'ระบบนี้ปิดการส่งต่อคิวอยู่ — เปิดได้ที่ ⚙ ตั้งค่าในหน้าเรียกคิว' };
  const display = String(displayIn || '').toUpperCase().trim();
  const me = systems.find(s => s.id === sysId);
  if (!((me && me.forwardTo) || []).includes(targetId))
    return { success: false, message: 'ระบบนี้ไม่ได้ตั้งค่าให้ส่งต่อไปยังระบบปลายทาง' };
  const target = getSys(targetId);
  const targetInfo = systems.find(s => s.id === targetId);
  if (!target || !targetInfo) return { success: false, message: 'ไม่พบระบบปลายทาง' };
  const ticket = findServed(sys, display);
  if (!ticket) return { success: false, message: 'ไม่พบคิวนี้ในรายการที่เรียกแล้ว' };
  // เดินคิวตามสถานะ HOSxP: this queue goes back to its pharmacy by itself — sending it by hand too would make a copy
  if (ticket.flowFrom === targetId && !ticket.flowDone)
    return { success: false, message: `คิว ${display} จะกลับ${targetInfo.name}เองเมื่อออกใบเสร็จ / ใบแจ้งหนี้ — ถ้าออกแล้วแต่ระบบยังไม่ขึ้น กด ⋯ ทำเอง ในช่อง "รอออกใบเสร็จ"` };
  // each leg of the journey (e.g. ห้องยา→การเงิน) may happen once, so a round trip can't loop forever
  const hop = `${sysId}>${targetId}`;
  if (ticketHops(ticket, sysId).includes(hop)) return { success: false, message: `คิว ${display} เคยส่ง ${me.name} → ${targetInfo.name} ไปแล้ว` };
  const already = Object.values(target.state).some(s => s.waiting.some(t => t.display === display));
  if (already) return { success: false, message: `คิว ${display} อยู่ในรายการรอของ ${targetInfo.name} แล้ว` };
  if (!target.queueTypes.length) return { success: false, message: `${targetInfo.name} ยังไม่มีประเภทคิว` };
  const fwd = placeForwarded(sysId, me.name, ticket, targetId, { fwdHops: [...ticketHops(ticket, sysId), hop] });
  ticket.forwardedTo = { sysId: targetId, name: targetInfo.name, at: fwd.forwardedFrom.at };
  logMark(sys, display, { fwdTo: targetInfo.name, fwdAt: fwd.forwardedFrom.at });
  saveQueueState(sysId, sys);
  io.to('sys-' + sysId).emit('queue_forwarded', { display, forwardedTo: ticket.forwardedTo, allServed: allServed(sys) });
  return { success: true, forwardedTo: ticket.forwardedTo };
}
// put a copy of the ticket into the target room's waiting line (same number) — used by ➜ ส่งต่อ and the pharmacy flow
function placeForwarded(sysId, fromName, ticket, targetId, extra) {
  const target = getSys(targetId);
  // Same prefix type in the target if it has one, otherwise its first type
  const tType = target.queueTypes.find(t => t.prefix === ticket.prefix) || target.queueTypes[0];
  initTypeState(target, tType.id);
  const ts = ticket.issuedTs || ticket._ts;
  const fwd = {
    ...ticket,
    typeId: tType.id, typeName: tType.name, color: tType.color,
    _ts: ts, issuedTs: ts,
    forwardedFrom: { sysId, name: fromName, at: new Date().toLocaleTimeString('th-TH') },
    returned: undefined, returnedAt: undefined, returnCount: undefined,
    calledAt: undefined, counterId: undefined, counterName: undefined,
    recalled: undefined, noShow: undefined, forwardedTo: undefined, forwardSkipped: undefined, _dbId: undefined,
    ...extra,
  };
  const ts2 = target.state[tType.id];
  ts2.waiting.push(fwd);
  ts2.waiting.sort((a, b) => a._ts - b._ts);
  // Keep the serial ahead so the target never re-issues this number
  if (tType.prefix === ticket.prefix) ts2.serial = Math.max(ts2.serial, ticket.number || 0);
  saveQueueState(targetId, target);
  dbIssueTicket(targetId, fwd);
  io.to('sys-' + targetId).emit('queue_issued', { ticket: fwd, typeWaiting: typeWaiting(target), allWaiting: allWaiting(target) });
  return fwd;
}

// "ไม่ต้องส่ง" — take a called ticket off the not-yet-forwarded list (e.g. the patient needs no payment)
app.post('/api/sys/:sysId/forward-skip', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const t = findServed(sys, String(req.body.display || '').toUpperCase().trim());
  if (!t) return res.json({ success: false, message: 'ไม่พบคิวนี้ในรายการที่เรียกแล้ว' });
  t.forwardSkipped = req.body.undo ? undefined : true;
  saveQueueState(sysId, sys);
  io.to('sys-' + sysId).emit('queue_forwarded', { display: t.display, forwardedTo: t.forwardedTo, allServed: allServed(sys) });
  res.json({ success: true });
});

// ── Auto-forward: calling the next patient at a counter means the previous one there is done ──
// (cashier-settings.autoForward, on unless switched off; target = autoForwardTo or the first forwardTo)
function autoForwardTarget(sysId, sys) {
  if (sys.cashierSettings.forwardEnabled === false || sys.cashierSettings.autoForward === false) return null;
  const me = systems.find(s => s.id === sysId);
  const targets = (me && me.forwardTo) || [];
  if (!targets.length) return null;
  const pick = Number(sys.cashierSettings.autoForwardTo);
  return targets.includes(pick) ? pick : targets[0];
}
// legs this ticket already travelled ("25>30" = จ่ายยา→การเงิน); older tickets only know where they came from
function ticketHops(t, hereSysId) {
  const hops = [...(t.fwdHops || [])];
  if (t.forwardedFrom && !hops.length) hops.push(`${t.forwardedFrom.sysId}>${hereSysId}`);
  return hops;
}
// may auto-forward send this called ticket on to targetId? Auto only moves queues that started in this room;
// one sent in from another room (back to collect drugs, paid first, …) goes on only by the staff's choice
// (➜ button / "ยังไม่ส่งต่อ" list) — so a patient is never bounced to a room they don't need
function canSendOn(sys, t, sysId, targetId) {
  if (t.forwardedFrom) return false;
  return !ticketHops(t, sysId).includes(`${sysId}>${targetId}`);
}
// the ticket that was on screen at this counter before a new call (doCall falls back to the first counter too)
function currentAtCounter(sys, counterId) {
  const counter = sys.counters.find(c => c.id === Number(counterId)) || sys.counters[0];
  return counter ? sys.lastCalledByCounter[counter.id] || null : null;
}
function autoForwardPrevious(sysId, sys, prev, newDisplay) {
  const targetId = autoForwardTarget(sysId, sys);
  if (!targetId || !prev || prev.display === newDisplay) return null;
  const t = findServed(sys, prev.display);            // gone = marked no-show or returned to the waiting list
  if (!t || t.forwardedTo || t.forwardSkipped) return null;   // already sent / staff said it needn't go
  if (!canSendOn(sys, t, sysId, targetId)) return null;
  const r = forwardTicket(sysId, sys, t.display, targetId);
  return r.success ? { display: t.display, to: r.forwardedTo.name } : null;
}

app.get('/api/sys/:sysId/no-shows', requireSys, (req, res) => res.json(req.sys.noShows));

// ── Status ────────────────────────────────────────────────────────────────
app.get('/api/sys/:sysId/status', requireSys, (req, res) => {
  const { sys, sysId } = req;
  res.json({
    sysInfo:             systems.find(s => s.id === sysId) || null,
    queueTypes:          sys.queueTypes,
    counters:            sys.counters,
    typeWaiting:         typeWaiting(sys),
    allWaiting:          allWaiting(sys),
    allServed:           allServed(sys),
    lastCalled:          allServed(sys)[0] || null,
    flow:                flowView(sysId),
    noShows:             sys.noShows.slice(0, 40),
    clearedNoShows:      (sys.clearedNoShows || []).slice(0, 40),
    deletedQueues:       sys.deletedQueues || [],
    lastCalledByCounter: sys.lastCalledByCounter,
    recentByCounter:     sys.recentByCounter,
    displayConfig:       sys.displayConfig,
    displaySettings:     sys.displaySettings,
    printConfig:         sys.printConfig,
    screenConfig:        sys.screenConfig,
    issueMode:           sys.issueMode,
  });
});

// ── Screen config ─────────────────────────────────────────────────────────
app.get('/api/sys/:sysId/screen-config', requireSys, (req, res) => res.json(req.sys.screenConfig));

app.post('/api/sys/:sysId/screen-config', requireSys, (req, res) => {
  const { sys, sysId } = req;
  Object.assign(sys.screenConfig, req.body);
  saveJson(sys.screenConfigFile, sys.screenConfig);
  io.to('sys-' + sysId).emit('screen_config_updated', sys.screenConfig);
  res.json({ success: true, screenConfig: sys.screenConfig });
});

// ── Lookup config (barcode field + pttype rules) ──────────────────────────
app.get('/api/sys/:sysId/lookup-config', requireSys, (req, res) => res.json(req.sys.lookupConfig));

app.post('/api/sys/:sysId/lookup-config', requireSys, (req, res) => {
  const { sys } = req;
  Object.assign(sys.lookupConfig, req.body);
  saveJson(sys.lookupConfigFile, sys.lookupConfig);
  res.json({ success: true, lookupConfig: sys.lookupConfig });
});

// ── Global color config ───────────────────────────────────────────────────
app.get('/api/global-config', (req, res) => {
  res.json(loadJson(GLOBAL_CONFIG_FILE, { brightness: 1, saturation: 1.2 }));
});

app.post('/api/global-config', (req, res) => {
  const b = parseFloat(req.body.brightness);
  const s = parseFloat(req.body.saturation);
  const cfg = { brightness: isNaN(b) ? 1 : b, saturation: isNaN(s) ? 1.2 : s };
  saveJson(GLOBAL_CONFIG_FILE, cfg);
  io.emit('global_config_updated', cfg);
  res.json({ success: true, ...cfg });
});

// ── Per-sys display settings ──────────────────────────────────────────────
app.get('/api/sys/:sysId/display-settings', requireSys, (req, res) => res.json(req.sys.displaySettings));

app.post('/api/sys/:sysId/display-settings', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const { mode, ...rest } = req.body;
  if (mode) {
    if (!sys.displaySettings.modes) sys.displaySettings.modes = {};
    sys.displaySettings.modes[mode] = rest;
  } else {
    Object.assign(sys.displaySettings, req.body);
  }
  saveJson(sys.displaySettingsFile, sys.displaySettings);
  io.to('sys-' + sysId).emit('display_settings_updated', sys.displaySettings);
  res.json({ success: true });
});

// Shared starting layout for display screens that have no settings of their own yet ("ตั้งเป็นค่าเริ่มต้น")
const DISPLAY_DEFAULT_FILE = path.join(DATA_DIR, 'display-default.json');
app.get('/api/sys/:sysId/display-default', requireSys, (req, res) => res.json(loadJson(DISPLAY_DEFAULT_FILE, {})));
app.post('/api/sys/:sysId/display-default', requireSys, (req, res) => {
  const { cfg, theme } = req.body || {};
  if (!cfg || typeof cfg !== 'object') return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลการตั้งค่า' });
  // the counter selection / column placement belong to this system's own counters — don't carry them to others
  const { selectedCounters, ctrCols, ctrOrder, ...shared } = cfg;
  for (const o of ['landscape', 'portrait']) {
    if (shared[o] && typeof shared[o] === 'object') {
      const { selectedCounters: _s, ctrCols: _c, ctrOrder: _o, ...rest } = shared[o];
      shared[o] = rest;
    }
  }
  saveJson(DISPLAY_DEFAULT_FILE, { cfg: shared, theme: theme || null, savedFrom: req.sysId, savedAt: new Date().toISOString() });
  res.json({ success: true });
});

// ── Google Translate TTS proxy (disk cache + offline Google voice clips — tts-voice.js) ──
const TTS_CACHE_DIR = path.join(DATA_DIR, 'tts-cache');
const tts = createTts({ appDir: APP_DIR, cacheDir: TTS_CACHE_DIR });

app.get('/api/tts', async (req, res) => {
  const text = (req.query.text || '').toString().trim().slice(0, 200);
  const lang = ((req.query.lang || 'th').toString().match(/^[a-zA-Z-]+$/) || ['th'])[0];
  if (!text) return res.status(400).json({ error: 'missing text' });

  res.setHeader('Content-Type', 'audio/mpeg');
  try {
    const { buf, source } = await tts.getAudio(lang, text);
    res.setHeader('Cache-Control', 'public, max-age=2592000');
    res.setHeader('X-TTS-Source', source);
    return res.end(buf);
  } catch (e) {
    // No internet (or Google refused): speak it with the bundled / learned Google word clips
    const composed = tts.composeFromClips(lang, text);
    if (composed) {
      res.setHeader('Cache-Control', 'no-store'); // retry the natural full sentence once back online
      res.setHeader('X-TTS-Source', 'offline-clips');
      if (composed.missing.length) console.warn('TTS offline: no clip for', composed.missing.join(', '));
      return res.end(composed.buf);
    }
    console.error('TTS proxy error:', e.message);
    res.status(502).json({ error: 'tts_failed' });
  }
});

// Learn Google clips for every counter name while online, so offline announcements include them
function learnCounterWords() {
  const names = Object.values(sysData).flatMap(s => (s.counters || []).map(c => c.name || ''));
  tts.learnWords('th', names)
    .then(n => { if (n) console.log(`[tts] learned ${n} word clip(s) for offline announcements`); })
    .catch(() => {});
}
setTimeout(learnCounterWords, 5000);
setInterval(learnCounterWords, 30 * 60 * 1000);

// ── Kiosk issue mode: by queue type, or automatically by drug count ───────
// Each drug rule owns a queue type (created here, flagged drugRule) so numbering, displays and the
// call page work unchanged.
const DRUG_RULE_COLORS = ['#26a69a', '#ef6c00', '#7e57c2', '#ec407a', '#5c6bc0', '#8d6e63'];
// "ตามสิทธิ" + แยกยาน้อย/ยามาก: [settings key, money route, size]
const PAY_DRUG_SPLIT  = [['cashS', 'cash', 'S'], ['cashL', 'cash', 'L'], ['freeS', 'free', 'S'], ['freeL', 'free', 'L']];
const PAY_DRUG_COLORS = { cashS: '#fb8c00', cashL: '#d84315', freeS: '#26a69a', freeL: '#00796b' };
const PAY_LABEL_DEF = { cash: '💰 ไปการเงิน', free: '✓ ไม่ผ่านการเงิน', dept: '🏥 ห้องตรวจที่เลือก', pttype: '💳 สิทธิที่เลือก',
  cashS: '💰 ไปการเงิน · ยาน้อย', cashL: '💰 ไปการเงิน · ยามาก', freeS: '✓ ไม่ผ่านการเงิน · ยาน้อย', freeL: '✓ ไม่ผ่านการเงิน · ยามาก',
  noDrug: '🧾 ไม่มียา · ตรงไปการเงิน' };
app.get('/api/sys/:sysId/issue-mode', requireSys, (req, res) => res.json(req.sys.issueMode));
// has this visit (VN / AN) already been given a ticket today? — the issue page asks right after the lookup
app.get('/api/sys/:sysId/issued-check', requireSys, (req, res) => {
  res.json({ success: true, existing: findIssued(req.sys, String(req.query.vn || '').trim()) });
});

app.put('/api/sys/:sysId/issue-mode', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const mode  = ['drug', 'pay'].includes((req.body || {}).mode) ? req.body.mode : 'type';
  const input = Array.isArray((req.body || {}).rules) ? req.body.rules : [];
  const bad = msg => res.status(400).json({ success: false, message: msg });

  const rules = [];
  for (const [i, r] of input.entries()) {
    const n = i + 1;
    const name = String(r.name || '').trim();
    const min = Number(r.min), max = Number(r.max);
    const prefix = normPrefix(r.prefix);
    if (!name) return bad(`แถวที่ ${n}: ต้องระบุชื่อประเภท`);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) return bad(`แถวที่ ${n}: จำนวนยาต้องเป็นตัวเลข และ "ถึง" ต้องไม่น้อยกว่า "ตั้งแต่"`);
    if (!PREFIX_RE.test(prefix)) return bad(`แถวที่ ${n}: Prefix ต้องเป็นตัวอักษร/ตัวเลข 1–3 ตัว (ลงท้าย - ได้)`);
    rules.push({ name, min, max, prefix, typeId: Number(r.typeId) || null });
  }
  for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
    if (rules[i].prefix === rules[j].prefix) return bad(`Prefix "${rules[i].prefix}" ซ้ำกันใน 2 แถว`);
    if (rules[i].min <= rules[j].max && rules[j].min <= rules[i].max) return bad(`ช่วงจำนวนยาของ "${rules[i].name}" กับ "${rules[j].name}" ทับกัน`);
  }
  if (mode === 'drug' && !rules.length) return bad('โหมดตามจำนวนยาต้องมีอย่างน้อย 1 ประเภท');
  // a prefix may not belong to an ordinary (manually picked) queue type
  for (const r of rules) {
    const clash = sys.queueTypes.find(t => t.prefix === r.prefix && !t.drugRule);
    if (clash) return bad(`Prefix "${r.prefix}" ซ้ำกับประเภทคิว "${clash.name}" — เลือก prefix อื่น`);
  }

  // "ตามสิทธิ / ค่าใช้จ่าย": two fixed types — ไปการเงิน (cash) and ไม่ผ่านการเงิน (free)
  const payIn = (req.body || {}).pay || sys.issueMode.pay || {};
  const codes = v => [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map(x => String(x).trim()).filter(Boolean))];
  const pay = {
    cashName: String(payIn.cashName || '').trim(), cashPrefix: normPrefix(payIn.cashPrefix),
    freeName: String(payIn.freeName || '').trim(), freePrefix: normPrefix(payIn.freePrefix),
    cashCodes: codes(payIn.cashCodes), debtCodes: codes(payIn.debtCodes), edcPttypes: codes(payIn.edcPttypes),
    // ไปการเงินทุกกรณี has its own สิทธิ list (usually one สิทธิ); settings saved before it existed: the shared list
    cashPttypes: Array.isArray(payIn.cashPttypes) || typeof payIn.cashPttypes === 'string' ? codes(payIn.cashPttypes) : codes(payIn.edcPttypes),
    cashTypeId: Number(payIn.cashTypeId) || null, freeTypeId: Number(payIn.freeTypeId) || null,
    // ห้องตรวจที่ติ๊ก (ovst.main_dep) get their own prefix; ไปการเงิน / ไม่ผ่านการเงิน still applies per ticket
    // ห้องตรวจ queue: check ไปการเงิน / ไม่ผ่านการเงิน after the pharmacy's drug check (off → plain pharmacy queue, sent nowhere)
    deptRouteCheck: payIn.deptRouteCheck !== false,
    deptOn: payIn.deptOn === true, deptName: String(payIn.deptName || '').trim(), deptPrefix: normPrefix(payIn.deptPrefix),
    deptCodes: codes(payIn.deptCodes), deptTypeId: Number(payIn.deptTypeId) || null,
    // the ticked สิทธิ (edcPttypes) can: send to the cashier for EDC (older settings: on) and/or get their own prefix
    edcOn: payIn.edcOn !== false,
    // หมวดค่าใช้จ่ายที่ติ๊ก (opitemrece.income): any item of the visit in it → ไปการเงิน, whatever its paidst
    incomeOn: payIn.incomeOn === true, incomeCodes: codes(payIn.incomeCodes),
    ptOn: payIn.ptOn === true, ptName: String(payIn.ptName || '').trim(), ptPrefix: normPrefix(payIn.ptPrefix),
    ptTypeId: Number(payIn.ptTypeId) || null,
    // ยาน้อย / ยามาก inside each money route: 4 types (ไปการเงิน×2, ไม่ผ่านการเงิน×2)
    drugOn: payIn.drugOn === true, drugMax: Number(payIn.drugMax),
    // ยาน้อย = drugMin..drugMax รายการ · fewer than drugMin (e.g. 0) → the route's single queue (แถวบน), not ยาน้อย
    drugMin: payIn.drugMin === undefined || payIn.drugMin === '' ? 1 : Number(payIn.drugMin),
    // which money routes get split (an unticked route keeps its single F / N queue) — older settings: both
    drugCash: payIn.drugCash !== false, drugFree: payIn.drugFree !== false,
    // ไม่มียา แต่ต้องไปการเงิน → ticket issued straight into a cashier room (a system this one forwards to)
    noDrugOn: payIn.noDrugOn === true, noDrugSysId: Number(payIn.noDrugSysId) || null,
    noDrugName: String(payIn.noDrugName || '').trim(), noDrugPrefix: normPrefix(payIn.noDrugPrefix),
    noDrugTypeId: Number(payIn.noDrugTypeId) || null,
  };
  for (const [k] of PAY_DRUG_SPLIT) {
    pay[k + 'Name']   = String(payIn[k + 'Name'] || '').trim();
    pay[k + 'Prefix'] = normPrefix(payIn[k + 'Prefix']);
    pay[k + 'TypeId'] = Number(payIn[k + 'TypeId']) || null;
  }
  if (!Number.isInteger(pay.drugMax) || pay.drugMax < 1) pay.drugMax = pay.drugOn ? pay.drugMax : 3;
  // ไปการเงินทุกกรณี (edcOn) and แยก Prefix (ptOn) are independent: a สิทธิ prefix without edcOn still checks the charges
  const splitOn = route =>pay.drugOn && pay[route === 'cash' ? 'drugCash' : 'drugFree'];
  // role labels (left column in the settings window) — the call page shows them in "สถานะ"
  for (const k in PAY_LABEL_DEF) pay[k + 'Label'] = String(payIn[k + 'Label'] || '').trim().slice(0, 40) || PAY_LABEL_DEF[k];
  if (mode === 'pay') {
    // the top row (F / N) of a route split into ยาน้อย / ยามาก issues nothing while ยาน้อย starts at 1
    // (ยา 0 รายการ gets no pharmacy queue) — such a row may be left blank
    const baseUsed = route => !splitOn(route) || (Number.isInteger(pay.drugMin) ? pay.drugMin : 1) > 1;
    const baseRows = [['cash', 'ไปการเงิน'], ['free', 'ไม่ผ่านการเงิน']];
    for (const [k, lbl] of baseRows) {
      if (!baseUsed(k)) {
        // unused: a blank prefix is fine (the name may stay); one that is filled in must still be valid
        if (pay[k + 'Prefix'] && !PREFIX_RE.test(pay[k + 'Prefix'])) return bad(`Prefix ของคิว "${lbl}" ต้องเป็นตัวอักษร/ตัวเลข 1–3 ตัว (ลงท้าย - ได้) หรือเว้นว่าง`);
        if (!pay[k + 'Prefix']) pay[k + 'Name'] = pay[k + 'Name'] || '';
        continue;
      }
      // still issuing: say why it cannot be blank
      const why = splitOn(k) ? `ใช้กับคนไข้ที่มียาน้อยกว่า ${pay.drugMin} รายการ`
        : `ใช้ออกคิวให้คนไข้${lbl}ทุกคน เพราะไม่ได้ติ๊ก "แยกให้คนไข้ที่ ${lbl}" — ถ้าไม่ใช้แถวนี้ ให้ติ๊กแยกยาน้อย / ยามาก ของ${lbl}`;
      if (!pay[k + 'Name']) return bad(`ต้องระบุชื่อคิว "${lbl}" — แถวนี้ยังใช้อยู่ (${why})`);
      if (!PREFIX_RE.test(pay[k + 'Prefix'])) return bad(`ต้องใส่ Prefix ของคิว "${lbl}" (ตัวอักษร/ตัวเลข 1–3 ตัว (ลงท้าย - ได้)) — แถวนี้ยังใช้อยู่ (${why})`);
    }
    if (pay.cashPrefix && pay.cashPrefix === pay.freePrefix) return bad('Prefix ของ 2 ประเภทต้องไม่ซ้ำกัน');
    if (!pay.cashCodes.length) return bad('ต้องระบุรหัสการชำระเงินที่ "ต้องจ่ายเงิน" อย่างน้อย 1 รหัส');
    if (pay.incomeOn && !pay.incomeCodes.length) return bad('ไปการเงินตามหมวดค่าใช้จ่าย: ต้องเลือกหมวด (income) อย่างน้อย 1 หมวด');
    if (pay.deptOn) {
      if (!pay.deptName) return bad('ต้องระบุชื่อคิวของห้องตรวจ');
      if (!PREFIX_RE.test(pay.deptPrefix)) return bad('Prefix ของห้องตรวจต้องเป็นตัวอักษร/ตัวเลข 1–3 ตัว (ลงท้าย - ได้)');
      if ([pay.cashPrefix, pay.freePrefix].includes(pay.deptPrefix)) return bad('Prefix ของห้องตรวจต้องไม่ซ้ำกับคิวไปการเงิน / ไม่ผ่านการเงิน');
      if (!pay.deptCodes.length) return bad('ต้องติ๊กห้องตรวจอย่างน้อย 1 ห้อง');
    }
    if (pay.ptOn) {
      if (!pay.ptName) return bad('ต้องระบุชื่อคิวของสิทธิที่เลือก');
      if (!PREFIX_RE.test(pay.ptPrefix)) return bad('Prefix ของสิทธิที่เลือกต้องเป็นตัวอักษร/ตัวเลข 1–3 ตัว (ลงท้าย - ได้)');
      if (!pay.edcPttypes.length) return bad('แยก Prefix ตามสิทธิ: ต้องติ๊กสิทธิอย่างน้อย 1 สิทธิ');
    }
    if (pay.drugOn) {
      if (!pay.drugCash && !pay.drugFree) return bad('แยกยาน้อย / ยามาก: ติ๊กอย่างน้อย 1 อย่าง (ไปการเงิน หรือ ไม่ผ่านการเงิน)');
      if (!Number.isInteger(pay.drugMax) || pay.drugMax < 1) return bad('จำนวนยาของ "ยาน้อย" ต้องเป็นตัวเลขตั้งแต่ 1 ขึ้นไป');
      if (!Number.isInteger(pay.drugMin) || pay.drugMin < 1) return bad('จำนวนยา "ตั้งแต่" ของยาน้อย ต้องเป็นตัวเลขตั้งแต่ 1 ขึ้นไป (คนไข้ไม่มียาไม่ได้คิวห้องยา)');
      if (pay.drugMin > pay.drugMax) return bad('จำนวนยาของ "ยาน้อย": "ตั้งแต่" ต้องไม่มากกว่า "ถึง"');
      for (const [k, route] of PAY_DRUG_SPLIT) {
        if (!splitOn(route)) continue;
        if (!pay[k + 'Name']) return bad('ต้องระบุชื่อคิวยาน้อย / ยามาก ให้ครบทั้ง 4 แบบ');
        if (!PREFIX_RE.test(pay[k + 'Prefix'])) return bad('Prefix ของคิวยาน้อย / ยามาก ต้องเป็นตัวอักษร/ตัวเลข 1–3 ตัว (ลงท้าย - ได้)');
      }
    }
    // every prefix in use must be different (each one is its own running number)
    const used = [['cash', null, pay.cashPrefix], ['free', null, pay.freePrefix]].filter(u => u[2]).concat([
      ...(pay.deptOn ? [['dept', null, pay.deptPrefix]] : []),
      ...(pay.ptOn ? [['pttype', null, pay.ptPrefix]] : []),
      ...PAY_DRUG_SPLIT.filter(([, route]) => splitOn(route)).map(([k, route, size]) => [route, size, pay[k + 'Prefix']])]);
    for (const [i, [, , p]] of used.entries())
      if (used.findIndex(u => u[2] === p) !== i) return bad(`Prefix "${p}" ซ้ำกัน — ทุกคิวในโหมดนี้ต้องใช้ Prefix ไม่ซ้ำกัน`);
    // compare against the prefixes types will have AFTER this save: a pay type still in use takes its new prefix
    // from this form (so swapping prefixes between pay queues is fine); a switched-off one is dropped, unless
    // today's tickets keep it (with its old prefix)
    // a pay queue that issues nothing after this save (switched off / blank top row) gives its prefix up — even if
    // today's tickets keep the type; its running number moves with the prefix (below), so no number repeats
    const others = sys.queueTypes.filter(t => !t.payRule);
    const retiring = sys.queueTypes.filter(t => t.payRule && t.prefix &&
      !used.some(([kind, size]) => t.payRule === kind && (t.drugSize || null) === size));
    for (const [, , p] of used) {
      const clash = others.find(t => t.prefix === p);
      if (clash) return bad(`Prefix "${p}" ซ้ำกับประเภทคิว "${clash.name}" — เลือก prefix อื่น`);
      if (rules.some(r => r.prefix === p)) return bad(`Prefix "${p}" ซ้ำกับประเภทในโหมดตามจำนวนยา — เลือก prefix อื่น`);
    }
    let ndSys = null;
    if (pay.noDrugOn) {
      const me = systems.find(x => x.id === sysId);
      if (!((me && me.forwardTo) || []).includes(pay.noDrugSysId) || !(ndSys = getSys(pay.noDrugSysId)))
        return bad('เลือกห้องการเงินที่ระบบนี้ส่งต่อไปได้ (ตั้งค่าการส่งต่อที่หน้าตั้งค่าระบบ)');
      if (!pay.noDrugName) return bad('ต้องระบุชื่อคิว "ไม่มียา ไปการเงิน"');
      if (!PREFIX_RE.test(pay.noDrugPrefix)) return bad('Prefix ของคิว "ไม่มียา ไปการเงิน" ต้องเป็นตัวอักษร/ตัวเลข 1–3 ตัว (ลงท้าย - ได้)');
      const p = pay.noDrugPrefix;
      if (used.some(u => u[2] === p) || others.some(t => t.prefix === p) || rules.some(r => r.prefix === p))
        return bad(`Prefix "${p}" ของคิว "ไม่มียา ไปการเงิน" ซ้ำกับคิวของห้องนี้ — เลือก prefix อื่น`);
      const clash = ndSys.queueTypes.find(t => t.prefix === p && t.noDrugFrom !== sysId);
      if (clash) return bad(`Prefix "${p}" ซ้ำกับประเภทคิว "${clash.name}" ของห้องการเงิน — เลือก prefix อื่น`);
    }
    for (const [k, route, size] of PAY_DRUG_SPLIT) {
      let t = sys.queueTypes.find(x => x.payRule === route && x.drugSize === size);
      if (splitOn(route)) {
        if (!t) {
          t = { id: sys.nextTypeId++, name: pay[k + 'Name'], prefix: pay[k + 'Prefix'], color: PAY_DRUG_COLORS[k], forMode: 'opd', payRule: route, drugSize: size };
          sys.queueTypes.push(t); initTypeState(sys, t.id);
        }
        t.name = pay[k + 'Name']; t.prefix = pay[k + 'Prefix'];
        pay[k + 'TypeId'] = t.id;
      } else if (t && !(sys.state[t.id]?.waiting || []).length && !(sys.state[t.id]?.served || []).length) {
        // switched off: drop the type, unless today's tickets still use it
        sys.queueTypes = sys.queueTypes.filter(x => x !== t);
        delete sys.state[t.id];
        pay[k + 'TypeId'] = null;
      } else pay[k + 'TypeId'] = t ? t.id : null;   // kept for today's tickets
    }
    for (const [i, kind] of ['cash', 'free'].entries()) {
      const name = pay[kind + 'Name'], prefix = pay[kind + 'Prefix'];
      let t = sys.queueTypes.find(x => x.payRule === kind && !x.drugSize);
      if (!t) {
        t = { id: sys.nextTypeId++, name, prefix, color: kind === 'cash' ? '#ef6c00' : '#26a69a', forMode: 'opd', payRule: kind };
        sys.queueTypes.push(t); initTypeState(sys, t.id);
      }
      // a blank (unused) top row keeps the type's last name / prefix — it issues nothing until it is used again
      if (name) t.name = name;
      if (prefix) t.prefix = prefix;
      pay[kind + 'TypeId'] = t.id;
    }
    let dt = sys.queueTypes.find(x => x.payRule === 'dept');
    if (pay.deptOn) {
      if (!dt) {
        dt = { id: sys.nextTypeId++, name: pay.deptName, prefix: pay.deptPrefix, color: '#5c6bc0', forMode: 'opd', payRule: 'dept' };
        sys.queueTypes.push(dt); initTypeState(sys, dt.id);
      }
      dt.name = pay.deptName; dt.prefix = pay.deptPrefix;
      pay.deptTypeId = dt.id;
    } else if (dt && !(sys.state[dt.id]?.waiting || []).length && !(sys.state[dt.id]?.served || []).length) {
      // switched off: drop the type, unless today's tickets still use it (its numbering must not restart)
      sys.queueTypes = sys.queueTypes.filter(x => x !== dt);
      delete sys.state[dt.id];
      pay.deptTypeId = null;
    }
    let pt = sys.queueTypes.find(x => x.payRule === 'pttype');
    if (pay.ptOn) {
      if (!pt) {
        pt = { id: sys.nextTypeId++, name: pay.ptName, prefix: pay.ptPrefix, color: '#0891b2', forMode: 'opd', payRule: 'pttype' };
        sys.queueTypes.push(pt); initTypeState(sys, pt.id);
      }
      pt.name = pay.ptName; pt.prefix = pay.ptPrefix;
      pay.ptTypeId = pt.id;
    } else if (pt && !(sys.state[pt.id]?.waiting || []).length && !(sys.state[pt.id]?.served || []).length) {
      // switched off: drop the type, unless today's tickets still use it
      sys.queueTypes = sys.queueTypes.filter(x => x !== pt);
      delete sys.state[pt.id];
      pay.ptTypeId = null;
    }
    // a prefix taken over from a retired pay queue (still here for today's tickets): the new owner carries on
    // its numbering (4001–4005 issued → next 4006), and the retired type lets the prefix go
    for (const old of retiring) {
      if (!sys.queueTypes.includes(old)) continue;   // dropped (no tickets today) — nothing to carry
      const owner = sys.queueTypes.find(t => t !== old && t.prefix === old.prefix);
      if (owner) {
        initTypeState(sys, owner.id);
        sys.state[owner.id].serial = Math.max(sys.state[owner.id].serial || 0, sys.state[old.id]?.serial || 0);
        old.prefix = '';
      }
    }
    // the "ไม่มียา" type lives in the cashier room; drop it from any room no longer chosen, unless used today
    for (const o of systems) {
      const os = getSys(o.id);
      if (!os) continue;
      let t = os.queueTypes.find(x => x.noDrugFrom === sysId);
      const keep = pay.noDrugOn && os === ndSys;
      if (keep) {
        if (!t) {
          t = { id: os.nextTypeId++, name: pay.noDrugName, prefix: pay.noDrugPrefix, color: '#7c3aed', forMode: 'opd', noDrugFrom: sysId };
          os.queueTypes.push(t); initTypeState(os, t.id);
        }
        t.name = pay.noDrugName; t.prefix = pay.noDrugPrefix;
        pay.noDrugTypeId = t.id;
      } else if (t && !(os.state[t.id]?.waiting || []).length && !(os.state[t.id]?.served || []).length) {
        os.queueTypes = os.queueTypes.filter(x => x !== t);
        delete os.state[t.id];
      } else continue;
      if (os !== sys) {
        saveJson(os.typesFile, os.queueTypes);
        io.to('sys-' + o.id).emit('types_updated', os.queueTypes);
      }
    }
    if (!pay.noDrugOn) pay.noDrugTypeId = null;
  }

  // create / update the queue type behind each rule
  const keep = new Set();
  rules.forEach((r, i) => {
    let t = sys.queueTypes.find(x => x.drugRule && x.id === r.typeId) || sys.queueTypes.find(x => x.drugRule && x.prefix === r.prefix);
    // another drug type may still hold this prefix (rules were re-ordered) — free it first
    sys.queueTypes.forEach(x => { if (x.drugRule && x !== t && x.prefix === r.prefix) x.prefix = ''; });
    if (!t) {
      t = { id: sys.nextTypeId++, name: r.name, prefix: r.prefix, color: DRUG_RULE_COLORS[i % DRUG_RULE_COLORS.length], forMode: 'opd', drugRule: true };
      sys.queueTypes.push(t); initTypeState(sys, t.id);
    }
    t.name = r.name; t.prefix = r.prefix;
    r.typeId = t.id; keep.add(t.id);
  });
  // drug types whose rule was removed: drop them unless people are still waiting in them
  sys.queueTypes = sys.queueTypes.filter(t => {
    if (!t.drugRule || keep.has(t.id)) return true;
    if ((sys.state[t.id]?.waiting || []).length) return true;
    delete sys.state[t.id];
    return false;
  });

  // ออกคิวซ้ำ: on = a patient already issued today can get another ticket; off = popup "มีประวัติออกคิวแล้ว"
  const allowReissue = typeof (req.body || {}).allowReissue === 'boolean' ? req.body.allowReissue : sys.issueMode.allowReissue === true;
  sys.issueMode = { mode, rules, pay, allowReissue };
  saveJson(sys.issueModeFile, sys.issueMode);
  saveJson(sys.typesFile, sys.queueTypes);
  io.to('sys-' + sysId).emit('types_updated', sys.queueTypes);
  io.to('sys-' + sysId).emit('issue_mode_updated', sys.issueMode);
  { const cashId = flowCashierOf(sysId, sys); if (cashId) emitFlow(cashId); }   // the cashier's tabs follow these settings
  res.json({ success: true, issueMode: sys.issueMode });
});

// one HOSxP connection for a few read queries (written with ? placeholders)
async function hosQuery(queries) {
  const cfg = loadDbConfig();
  if (!cfg.host) throw new Error('ยังไม่ได้ตั้งค่าฐานข้อมูล');
  if (isMysqlType(cfg.type)) {
    const mysql = require('mysql2/promise');
    const conn  = await mysql.createConnection({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectTimeout: 10000, charset: 'utf8mb4' });
    try {
      const out = [];
      for (const [sql, params] of queries) out.push(await dbRun('mysql', conn, sql, params || []));
      return out;
    } finally { await conn.end().catch(() => {}); }
  }
  const { Client } = require('pg');
  const client = new Client({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    const out = [];
    for (const [sql, params] of queries) out.push((await dbRun('pg', client, sql, params || [])).rows);
    return out;
  } finally { await client.end().catch(() => {}); }
}

// สิทธิการรักษาที่เปิดใช้ — for ticking which ones must go to the cashier to swipe EDC
app.get('/api/sys/:sysId/pttypes', requireSys, async (req, res) => {
  try {
    const [rows] = await hosQuery([[`SELECT pttype, name, hipdata_code FROM pttype WHERE isuse = 'Y' ORDER BY hipdata_code, name`]]);
    res.json({ success: true, pttypes: rows.map(r => ({
      code: String(r.pttype || '').trim(), name: String(r.name || '').trim(), hipdata: String(r.hipdata_code || '').trim(),
    })) });
  } catch (err) {
    res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
  }
});

// หมวดค่าใช้จ่าย (income) — for ticking the ones that always go to the cashier (e.g. 17 ค่ายานอกบัญชียาหลักแห่งชาติ)
app.get('/api/sys/:sysId/incomes', requireSys, async (req, res) => {
  try {
    const [rows] = await hosQuery([[`SELECT income, name FROM income ORDER BY income`]]);
    res.json({ success: true, incomes: rows.map(r => ({ code: String(r.income || '').trim(), name: String(r.name || '').trim() })) });
  } catch (err) {
    res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
  }
});

// ห้องตรวจที่เปิดใช้ — for ticking which ones get their own queue prefix
app.get('/api/sys/:sysId/departments', requireSys, async (req, res) => {
  try {
    const [rows] = await hosQuery([[`SELECT * FROM kskdepartment ORDER BY depcode`]]);
    res.json({ success: true, departments: rows
      .filter(r => String(r.department_active || '').trim().toUpperCase() !== 'N')
      .map(r => ({ code: String(r.depcode || '').trim(), name: String(r.department || '').trim() })) });
  } catch (err) {
    res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
  }
});

// Does this visit go to the cashier?  opitemrece.paidst in cashCodes (01,03) with a price → pay at the cashier;
// paidst in debtCodes (02, ลูกหนี้สิทธิ) → no payment, except สิทธิที่ติ๊ก (ข้าราชการ) who swipe EDC there
app.post('/api/sys/:sysId/pay-route', requireSys, async (req, res) => {
  const vn = String((req.body || {}).vn || '').trim();
  if (!vn) return res.json({ success: false, message: 'ไม่พบ VN ของการมาวันนี้' });
  try {
    res.json(await payRouteFor(req.sysId, req.sys, vn));
  } catch (err) {
    res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
  }
});
// the route decision on its own — the kiosk asks at issue time, the pharmacy flow asks again once the drugs are checked
// (throws when HOSxP can't be reached)
async function payRouteFor(sysId, sys, vn) {
  const pay = sys.issueMode.pay || {};
  {
    const [visit, items, drugRows] = await hosQuery([
      [`SELECT o.pttype, pt.name AS pttype_name, o.main_dep, d.department AS main_dep_name
         FROM ovst o
         LEFT JOIN pttype pt ON pt.pttype = o.pttype
         LEFT JOIN kskdepartment d ON d.depcode = o.main_dep
         WHERE o.vn = ?`, [vn]],
      [`SELECT op.paidst, ps.name AS paidst_name, COUNT(*) AS n, SUM(op.sum_price) AS total,
           SUM(CASE WHEN op.icode LIKE '1%' THEN 1 ELSE 0 END) AS drugs,
           SUM(CASE WHEN op.icode LIKE '3%' THEN 1 ELSE 0 END) AS services
         FROM ovst o
         JOIN opitemrece op ON op.vn = o.vn
         LEFT JOIN paidst ps ON ps.paidst = op.paidst
         WHERE o.vn = ?
         GROUP BY op.paidst, ps.name`, [vn]],
      // รายการยาไม่ซ้ำ — the same count as "ตามจำนวนยา" and the call page's "จำนวนยา" column
      [`SELECT COUNT(DISTINCT op.icode) AS n FROM opitemrece op WHERE op.vn = ? AND op.icode LIKE '1%'`, [vn]],
    ]);
    // หมวดค่าใช้จ่ายที่ติ๊ก (e.g. 17 ค่ายานอกบัญชียาหลักแห่งชาติ): ไปการเงินทุกเคส ไม่สนใจ paidst
    const incomeCodes = pay.incomeOn ? (pay.incomeCodes || []) : [];
    let incomeHits = [];
    if (incomeCodes.length) {
      const [rows] = await hosQuery([[`SELECT TRIM(op.income) AS income, MAX(i.name) AS name, COUNT(*) AS n FROM opitemrece op
         LEFT JOIN income i ON i.income = op.income
         WHERE op.vn = ? AND TRIM(op.income) IN (${incomeCodes.map(() => '?').join(',')}) GROUP BY TRIM(op.income)`, [vn, ...incomeCodes]]]);
      incomeHits = rows.map(r => ({ code: String(r.income || '').trim(), name: String(r.name || '').trim(), n: Number(r.n) || 0 }));
    }
    const drugCount = Number((drugRows[0] || {}).n) || 0;
    if (!visit.length) return { success: false, message: 'ไม่พบ visit นี้ในฐานข้อมูล' };
    const pttype = String(visit[0].pttype || '').trim();
    const pttypeName = String(visit[0].pttype_name || '').trim() || pttype;
    const groups = items.map(r => ({ paidst: String(r.paidst || '').trim(), name: String(r.paidst_name || '').trim(),
      n: Number(r.n) || 0, total: Number(r.total) || 0, drugs: Number(r.drugs) || 0, services: Number(r.services) || 0 }));
    const drugs    = groups.reduce((a, g) => a + g.drugs, 0);      // icode ขึ้นต้น 1 = ยา
    const services = groups.reduce((a, g) => a + g.services, 0);   // icode ขึ้นต้น 3 = ค่าบริการอื่นๆ
    const cashCodes = pay.cashCodes || ['01', '03'], debtCodes = pay.debtCodes || ['02'];
    const sum = test => groups.filter(g => test(g.paidst)).reduce((a, g) => a + g.total, 0);
    const cash = sum(c => cashCodes.includes(c)), debt = sum(c => debtCodes.includes(c));
    // priced items with no / unknown payment code: send to the cashier rather than risk an unpaid bill
    const unknown = sum(c => !cashCodes.includes(c) && !debtCodes.includes(c));
    const ptTicked = (pay.edcPttypes || []).includes(pttype);
    // สิทธิที่ติ๊ก = สิทธิที่ต้องจ่าย / รูดบัตร EDC → ไปการเงินทุกกรณี (also when only แยก Prefix is on)
    // ไปการเงินทุกกรณี: its own สิทธิ list (older settings without it: the แยก Prefix list, as before)
    const cashList = Array.isArray(pay.cashPttypes) ? pay.cashPttypes : (pay.edcPttypes || []);
    const edc  = pay.edcOn !== false && cashList.includes(pttype);
    const baht = v => v.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let route, reason;
    if (cash > 0)             { route = 'cash'; reason = `มีค่าใช้จ่ายที่ต้องชำระ ${baht(cash)} บาท`; }
    else if (unknown > 0)     { route = 'cash'; reason = `มีรายการ ${baht(unknown)} บาท ที่ยังไม่ระบุประเภทการชำระเงิน`; }
    else if (incomeHits.length) { route = 'cash'; reason = `มีรายการหมวด ${incomeHits.map(h => h.name || 'หมวด ' + h.code).join(', ')} — ไปการเงินทุกเคส`; }
    // nothing ordered yet (or nothing needed) — the kiosk asks staff to pick a type or not issue at all
    else if (!drugs && !services) { route = 'none'; reason = 'คนไข้ไม่มียาและค่าบริการ'; }
    else if (edc)             { route = 'cash'; reason = `สิทธิ ${pttypeName} ต้องไปการเงิน (รูดบัตร EDC / ชำระเงิน)${debt > 0 ? ` ${baht(debt)} บาท` : ''}`; }
    else if (!drugs)          { route = 'cash'; reason = 'ไม่มีรายการยา'; }
    else                      { route = 'free'; reason = debt > 0 ? `ค่าใช้จ่ายเบิกตามสิทธิ ${pttypeName}` : 'ไม่มีค่าใช้จ่าย'; }
    // ห้องตรวจที่ติ๊ก: same route, but the ticket comes from the room's own queue type
    const mainDep = String(visit[0].main_dep || '').trim();
    const deptType = pay.deptOn && pay.deptTypeId && (pay.deptCodes || []).includes(mainDep)
      ? sys.queueTypes.find(t => t.id === pay.deptTypeId && t.payRule === 'dept') : null;
    // สิทธิที่ติ๊ก + แยก Prefix: same route, ticket from the สิทธิ queue (a ticked ห้องตรวจ comes first)
    const ptType = !deptType && pay.ptOn && pay.ptTypeId && ptTicked
      ? sys.queueTypes.find(t => t.id === pay.ptTypeId && t.payRule === 'pttype') : null;
    const groupType = deptType || ptType;
    // แยกยาน้อย / ยามาก: same route, ticket from the matching size type (a ticked ห้องตรวจ keeps its own prefix)
    let drugSize = null, sizeType = null;
    // a route left unticked under แยกยาน้อย / ยามาก keeps its single queue (e.g. ไม่ผ่านการเงิน → N for everyone)
    // fewer drugs than the ยาน้อย minimum (e.g. 0) → no size: the route's single queue (แถวบน ไปการเงิน / ไม่ผ่านการเงิน)
    const drugMin = Number.isInteger(pay.drugMin) ? pay.drugMin : 0;   // settings saved before the minimum existed: as before
    if (!groupType && pay.drugOn && (route === 'cash' || route === 'free') && pay[route === 'cash' ? 'drugCash' : 'drugFree'] !== false
        && drugCount >= drugMin) {
      drugSize = drugCount <= pay.drugMax ? 'S' : 'L';
      sizeType = sys.queueTypes.find(t => t.id === pay[route + drugSize + 'TypeId'] && t.payRule === route && t.drugSize === drugSize) || null;
      if (!sizeType) drugSize = null;
    }
    // ไม่มียา แต่ต้องไปการเงิน → straight to the cashier room's line (no pharmacy queue at all)
    const nd = route === 'cash' && drugCount === 0 ? noDrugTarget(sysId, sys) : null;
    const noDrug = nd ? { sysId: nd.sysId, name: (systems.find(x => x.id === nd.sysId) || {}).name || '', typeName: nd.type.name, prefix: nd.type.prefix } : null;
    // ห้องยาออกคิวให้เฉพาะคนไข้ที่มียา: ยา 0 รายการ never gets a pharmacy queue (not F / ไปการเงิน, not ยาน้อย) —
    // unless it is a ticked ห้องตรวจ (its own queue) or "ไม่มียา → ห้องการเงิน" is set up. The kiosk asks staff instead.
    let noDrugs = false;
    if (drugCount === 0 && route === 'cash' && !deptType && !noDrug) {
      noDrugs = true; route = 'none'; reason = `ไม่มีรายการยา · ${reason}`;
      drugSize = null; sizeType = null;
    }
    // ห้องตรวจ: drugs / charges are usually keyed after the queue is issued — never ask staff (no "ไม่มียา" popup).
    // เช็คไปการเงิน on → the route is decided after the pharmacy's drug check; off → a plain pharmacy queue
    if (deptType) {
      if (pay.deptRouteCheck === false) { route = 'dept'; reason = 'ห้องตรวจที่เลือก · ไม่เช็คไปการเงิน (คิวห้องยา)'; }
      else if (route === 'none') { route = 'pending'; reason = 'ห้องตรวจที่เลือก · ยังไม่มีรายการ — เช็คไปการเงินหลังห้องยาตรวจยา'; }
    }
    const keepGroup = groupType && !noDrugs;   // a สิทธิ queue with 0 drugs is not issued either
    return { success: true, route, reason, noDrugs, typeId: keepGroup ? groupType.id : sizeType ? sizeType.id : (pay[route + 'TypeId'] || null),
      deptTypeId: keepGroup ? groupType.id : null,   // ห้องตรวจ or สิทธิ queue — the kiosk keeps its prefix either way
      noDrug, drugCount, drugSize, mainDep, mainDepName: String(visit[0].main_dep_name || '').trim(), pttype, pttypeName, drugs, services, items: groups };
  }
}

// ══ เดินคิวตามสถานะ HOSxP (pharmacy flow) ═════════════════════════════════
// A ห้องยา with flowOn (⚙ on its call page) holds every OPD ticket at "รอตรวจสอบยา" until HOSxP records the
// drug checker (rx_dispenser_detail type 3). Then the money route is decided again on the latest items:
//   ไม่ผ่านการเงิน → "พร้อมจ่ายยา" at the pharmacy
//   ไปการเงิน      → sent to the cashier room by itself; back to "พร้อมจ่ายยา" once the cashier has called it
//                    AND HOSxP has a receipt (rcpt_print) or debt slip (rcpt_debt). No drugs → the trip ends there.
// The server polls HOSxP itself, so queues move even with no call page open. If HOSxP is down, staff move a
// queue by hand (⋯ on the row, with a reason) — logged on the ticket.
const FLOW_TICK_MS = 12000;
// ⚙ "เรียกแบบ manual" on this room's call page: a queue still waiting for the drug check may be called on purpose
function flowManualCall(sys) { return !!(sys && sys.cashierSettings && sys.cashierSettings.flowManualCall === true); }
function flowCashierOf(sysId, sys) {
  const cs = (sys && sys.cashierSettings) || {};
  if (cs.flowOn !== true || cs.forwardEnabled === false) return null;
  const me = systems.find(s => s.id === Number(sysId));
  const targets = ((me && me.forwardTo) || []).filter(id => getSys(id));
  if (!targets.length) return null;
  const pick = Number(cs.flowCashierId);
  return targets.includes(pick) ? pick : targets[0];
}
// the pharmacies whose flow sends queues into this cashier room
function flowPharmaciesOf(cashId) {
  return systems.filter(s => s.id !== cashId && flowCashierOf(s.id, getSys(s.id)) === cashId).map(s => s.id);
}
// the partner room(s) of a room for the dashboard: ห้องยา → its cashier · การเงิน → its pharmacies
// · not in a flow → any room the queue was sent to (ids = [] means "every other room")
function flowOtherOf(sysId) {
  const id = Number(sysId), cash = flowCashierOf(id, getSys(id));
  if (cash) return { ids: [cash], label: 'การเงิน' };
  const ph = flowPharmaciesOf(id);
  if (ph.length) return { ids: ph, label: 'ห้องยา' };
  const fwd = ((systems.find(s => s.id === id) || {}).forwardTo || []).filter(x => getSys(x));
  const name = fwd.length === 1 ? (systems.find(s => s.id === fwd[0]) || {}).name : '';
  return { ids: fwd, label: name || 'ห้องที่ส่งต่อ' };
}
const flowNow = () => new Date().toLocaleTimeString('th-TH');
const flowHhmm = v => { const t = v ? new Date(v) : null; return t && !isNaN(t) ? t.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : ''; };
function findWaiting(sys, display) {
  for (const s of Object.values(sys.state)) {
    const i = s.waiting.findIndex(t => t.display === display);
    if (i !== -1) return { s, i, t: s.waiting[i] };
  }
  return null;
}
function routeLabelFor(sys, route, t) {
  const pay = (sys.issueMode && sys.issueMode.pay) || {};
  const type = sys.queueTypes.find(x => x.id === t.typeId) || {};
  const group = type.payRule === 'dept' || type.payRule === 'pttype';
  const k = route + (t.drugSize && !group ? t.drugSize : '');
  return pay[k + 'Label'] || PAY_LABEL_DEF[k] || PAY_LABEL_DEF[route];
}
function flowLog(t, what, by, reason) {
  t.flowLog = [...(t.flowLog || []), { what, by: String(by || '').slice(0, 60) || null, reason: String(reason || '').slice(0, 120) || null, at: flowNow() }].slice(-10);
}
// where a queue sent to the cashier is now: waiting there / called / no-show / gone
function awayStatus(cash, display) {
  if (!cash) return { st: 'gone' };
  for (const s of Object.values(cash.state)) {
    if (s.waiting.some(t => t.display === display && t.flowFrom)) return { st: 'waiting' };
    const c = s.served.find(t => t.display === display && t.flowFrom);
    if (c) return c.noShow ? { st: 'noshow' } : { st: 'called', calledAt: c.calledAt || '', calledTs: c._ts, counterName: c.counterName || '' };
  }
  if ((cash.noShows || []).some(t => t.display === display)) return { st: 'noshow' };
  return { st: 'gone' };
}

// drug check passed (or "ถือว่าตรวจยาแล้ว"): ไม่ผ่านการเงิน → พร้อมจ่ายยา · ไปการเงิน → off to the cashier
// info.route = the fresh decision (null when HOSxP couldn't say → keep the issue-time route)
function flowPass(pharmId, pharm, display, info) {
  const w = findWaiting(pharm, display);
  if (!w || w.t.flow !== 'check') return false;
  const t = w.t, was = t.payRoute || null;
  // already paid (the cashier called it before the check) → once checked it is simply ready to dispense
  if (t.flowBack) {
    if (info.rxAt) t.rxCheckedAt = info.rxAt;
    const now = Date.now();
    Object.assign(t, { flow: 'ready', readyTs: now, readyAt: flowNow(), _ts: now });
    w.s.waiting.sort((a, b) => a._ts - b._ts);
    return true;
  }
  const route = info.route || was || 'cash';   // never known → การเงิน, rather than risk an unpaid bill
  if (was && route !== was) t.routeChanged = { from: was, to: route, at: flowNow() };
  t.payRoute = route;
  t.routeLabel = routeLabelFor(pharm, route, t);
  if (Number.isFinite(info.drugCount)) t.drugCount = info.drugCount;
  // a visit with no drugs has nothing to check — it is not stamped "ตรวจยาแล้ว"
  if (info.rxAt) t.rxCheckedAt = info.rxAt;
  else if (t.drugCount !== 0 && !info.unchecked) t.rxCheckedAt = flowHhmm(Date.now());   // ถือว่าตรวจยาแล้ว (by hand)
  if (route === 'cash') return flowToCashier(pharmId, pharm, w);
  const now = Date.now();
  Object.assign(t, { flow: 'ready', readyTs: now, readyAt: flowNow(), _ts: now });   // ใครพร้อมก่อน ได้ก่อน
  w.s.waiting.sort((a, b) => a._ts - b._ts);
  return true;
}
function flowToCashier(pharmId, pharm, w) {
  const cashId = flowCashierOf(pharmId, pharm), cash = getSys(cashId);
  if (!cash || !cash.queueTypes.length) return false;
  const t = w.t;
  w.s.waiting.splice(w.i, 1);
  const me = systems.find(s => s.id === pharmId) || {};
  const endsAtCashier = t.drugCount === 0 || undefined;   // nothing to dispense → the trip ends at the cashier
  // keeps the pharmacy's colour and type name, so the cashier's tabs, badges and board match the pharmacy's
  placeForwarded(pharmId, me.name || '', t, cashId, { flow: undefined, flowFrom: pharmId, endsAtCashier, forwardSkipped: true,
    color: t.color, typeName: t.typeName,
    fwdHops: [...ticketHops(t, pharmId), `${pharmId}>${cashId}`] });
  (pharm.flowAway = pharm.flowAway || []).push({ ...t, flow: 'away', cashierSysId: cashId, sentTs: Date.now(), sentAt: flowNow(), endsAtCashier });
  return true;
}
// cashier finished (receipt / debt slip, or by hand) → back to the pharmacy's "พร้อมจ่ายยา" — or the trip ends there
function flowBack(pharmId, pharm, display, how, by, reason) {
  const ai = (pharm.flowAway || []).findIndex(a => a.display === display);
  if (ai === -1) return false;
  const away = pharm.flowAway.splice(ai, 1)[0];
  const cashId = away.cashierSysId, cash = getSys(cashId);
  const at = flowNow(), pinfo = systems.find(s => s.id === pharmId) || {};
  if (by || reason) flowLog(away, 'ถือว่าชำระแล้ว', by, reason);
  if (cash) {
    let ct = null;
    for (const s of Object.values(cash.state)) { ct = s.served.find(x => x.display === display && x.flowFrom); if (ct) break; }
    if (ct) {
      ct.flowDone = { at, how, end: away.endsAtCashier ? true : undefined };
      if (!away.endsAtCashier) ct.forwardedTo = { sysId: pharmId, name: pinfo.name || '', at };
      logMark(cash, display, { flowDone: ct.flowDone, fwdTo: away.endsAtCashier ? undefined : pinfo.name || '', fwdAt: away.endsAtCashier ? undefined : at });
    } else {
      // sent back / closed before the cashier called it: off the waiting list, but kept in the cashier's
      // "เรียกแล้ว" lists (marked ไม่ได้เรียก) so it shows under "ชำระแล้ว" and "เรียกแล้ววันนี้" — never announced
      const w = findWaiting(cash, display);
      if (w && w.t.flowFrom) {
        const [t0] = w.s.waiting.splice(w.i, 1);
        const flowDone = { at, how, end: away.endsAtCashier ? true : undefined };
        const closed = { ...t0, calledAt: at, _ts: Date.now(), notCalled: true, counterId: undefined,
          counterName: String(by || '').split(' · ').pop() || '', flowDone,
          forwardedTo: away.endsAtCashier ? undefined : { sysId: pharmId, name: pinfo.name || '', at } };
        w.s.served.unshift(closed);
        if (w.s.served.length > 40) w.s.served.pop();
        logCalled(cash, closed);
        logMark(cash, display, { notCalled: true, flowDone,
          fwdTo: away.endsAtCashier ? undefined : pinfo.name || '', fwdAt: away.endsAtCashier ? undefined : at });
      }
    }
    saveQueueState(cashId, cash);
  }
  if (!away.endsAtCashier) {
    const type = pharm.queueTypes.find(x => x.id === away.typeId) || pharm.queueTypes.find(x => x.prefix === away.prefix) || pharm.queueTypes[0];
    if (type) {
      initTypeState(pharm, type.id);
      const now = Date.now();
      // paid before the drug check (การเงินเรียกแบบ manual) → back at "รอตรวจสอบยา" until HOSxP records the check
      const unchecked = !away.rxCheckedAt && away.drugCount !== 0;
      const back = { ...away, typeId: type.id, typeName: type.name, color: type.color,
        flow: unchecked ? 'check' : 'ready', readyTs: unchecked ? undefined : now, readyAt: unchecked ? undefined : at, _ts: now,
        flowBack: { at, how, cashier: (systems.find(s => s.id === cashId) || {}).name || '' },
        fwdHops: [...ticketHops(away, pharmId), `${cashId}>${pharmId}`], forwardSkipped: true,
        cashierSysId: undefined, sentTs: undefined, sentAt: undefined, forwardedTo: undefined,
        calledAt: undefined, counterId: undefined, counterName: undefined, recalled: undefined, noShow: undefined };
      pharm.state[type.id].waiting.push(back);
      pharm.state[type.id].waiting.sort((a, b) => a._ts - b._ts);
    }
  }
  saveQueueState(pharmId, pharm);
  return true;
}

// what a call page needs to draw its lanes (null = this room takes no part in a flow)
function flowView(sysId) {
  const sys = getSys(sysId);
  if (!sys) return null;
  const cashId = flowCashierOf(sysId, sys), pharmacies = flowPharmaciesOf(sysId);
  if (!cashId && !pharmacies.length) return null;
  const name = id => (systems.find(s => s.id === id) || {}).name || '';
  const v = {};
  if (cashId) {
    const cash = getSys(cashId);
    v.pharmacy = { cashierSysId: cashId, cashierName: name(cashId), hos: sys.flowHos || null,
      away: (sys.flowAway || []).map(a => ({ ...a, at: awayStatus(cash, a.display) })) };
  }
  if (pharmacies.length) {
    // the pharmacies' money-related queue types (ไปการเงิน · ห้องตรวจ · สิทธิ) — the cashier filters its list by them
    // only the ones the pharmacy's ⚙ ออกคิว hands out now: ไปการเงิน (whole, or ยาน้อย / ยามาก when split),
    // ห้องตรวจที่เลือก when on, สิทธิที่เลือก when on — ไม่ผ่านการเงิน never comes here
    const inUse = (pharm, t) => {
      const im = pharm.issueMode || {}, pay = im.pay || {};
      if (im.mode !== 'pay') return false;
      if (t.payRule === 'dept')   return pay.deptOn === true && pay.deptRouteCheck !== false;
      if (t.payRule === 'pttype') return pay.ptOn === true;
      // split on: ยาน้อย / ยามาก, plus the single ไปการเงิน queue when visits under the ยาน้อย minimum still get it
      if (t.payRule === 'cash') return pay.drugOn === true && pay.drugCash !== false
        ? (!!t.drugSize || (Number(pay.drugMin) || 0) > 1) : !t.drugSize;
      return false;
    };
    const seen = new Set();
    const types = pharmacies.flatMap(id => getSys(id).queueTypes
      .filter(t => inUse(getSys(id), t))
      .map(t => ({ prefix: t.prefix, name: t.name, color: t.color, payRule: t.payRule, drugSize: t.drugSize || null })))
      .filter(t => !seen.has(t.prefix) && seen.add(t.prefix));
    v.cashier = { from: pharmacies.map(id => ({ id, name: name(id) })), types,
      hos: pharmacies.map(id => getSys(id).flowHos).find(h => h && !h.ok) || getSys(pharmacies[0]).flowHos || null };
  }
  return v;
}
function emitFlow(sysId) {
  const sys = getSys(sysId);
  if (!sys) return;
  io.to('sys-' + sysId).emit('flow_updated', { flow: flowView(sysId), typeWaiting: typeWaiting(sys), allWaiting: allWaiting(sys), allServed: allServed(sys) });
}

let flowBusy = false;
async function flowTick() {
  if (flowBusy) return;
  flowBusy = true;
  try {
    for (const info of systems) {
      const pharmId = info.id, pharm = getSys(pharmId);
      const cashId = flowCashierOf(pharmId, pharm);
      if (!cashId) continue;
      const cash = getSys(cashId);
      const checks = Object.values(pharm.state).flatMap(s => s.waiting).filter(t => t.flow === 'check' && t.vn);
      const called = (pharm.flowAway || []).filter(a => a.vn && awayStatus(cash, a.display).st === 'called');
      // every queue still on its way is asked about, so a HOSxP outage shows while any queue is in flight
      const vns = [...new Set([...checks, ...(pharm.flowAway || [])].map(t => String(t.vn || '').trim()).filter(Boolean))].slice(0, 300);
      if (!vns.length) { emitFlow(pharmId); continue; }
      const ph = vns.map(() => '?').join(',');
      let rx, rcpt, debt, drugs;
      const hadError = pharm.flowHos && !pharm.flowHos.ok;
      try {
        [rx, rcpt, debt, drugs] = await hosQuery([
          [`SELECT vn, MAX(rx_dispenser_datetime) AS at FROM rx_dispenser_detail WHERE rx_dispenser_type_id = 3 AND vn IN (${ph}) GROUP BY vn`, vns],
          [`SELECT DISTINCT vn FROM rcpt_print WHERE vn IN (${ph}) AND COALESCE(status, '') <> 'ABORT'`, vns],
          [`SELECT DISTINCT vn FROM rcpt_debt  WHERE vn IN (${ph}) AND COALESCE(status, '') <> 'ABORT'`, vns],
          [`SELECT vn, COUNT(DISTINCT icode) AS n FROM opitemrece WHERE vn IN (${ph}) AND icode LIKE '1%' GROUP BY vn`, vns],
        ]);
        pharm.flowHos = { ok: true, at: flowNow() };
      } catch (err) {
        pharm.flowHos = { ok: false, since: hadError ? pharm.flowHos.since : flowNow(), msg: String(err.message || err).slice(0, 160) };
        emitFlow(pharmId);
        if (!hadError) emitFlow(cashId);
        continue;
      }
      const key = v => String(v).trim();
      const rxAt = new Map(rx.map(r => [key(r.vn), flowHhmm(r.at)]));
      const nDrugs = new Map(drugs.map(r => [key(r.vn), Number(r.n) || 0]));
      const paid = new Map(debt.map(r => [key(r.vn), 'debt']));
      rcpt.forEach(r => paid.set(key(r.vn), 'receipt'));
      let changed = false;
      for (const t of checks) {
        const vn = key(t.vn), n = nDrugs.get(vn) || 0;
        if (!rxAt.has(vn) && n > 0) continue;   // drugs not checked yet
        // checked → decide ไปการเงิน / ไม่ผ่านการเงิน again on the latest items (เช็คซ้ำตอนตรวจยาเสร็จ)
        let route = null;
        // (a ticket already here with 0 drugs that must pay — staff picked it, or its drugs were cancelled — still goes to the cashier)
        if (!t.flowBack) try { const r = await payRouteFor(pharmId, pharm, vn);
          if (r.success && (r.route === 'cash' || r.route === 'free')) route = r.route;
          else if (r.success && r.noDrugs) route = 'cash'; } catch {}
        // no drugs at all: only a visit that must pay moves on (to the cashier, where it ends) — anything else is left to staff
        if (n === 0 && route !== 'cash' && !t.flowBack) continue;
        if (flowPass(pharmId, pharm, t.display, { route, drugCount: n, rxAt: rxAt.get(vn) })) changed = true;
      }
      for (const a of called) {
        const how = paid.get(key(a.vn));
        if (how && flowBack(pharmId, pharm, a.display, how)) changed = true;
      }
      if (changed) { saveQueueState(pharmId, pharm); saveQueueState(cashId, cash); }
      emitFlow(pharmId);
      if (changed || hadError) emitFlow(cashId);
    }
  } catch (err) {
    console.error('flowTick:', err.message);
  } finally {
    flowBusy = false;
  }
}
setInterval(flowTick, FLOW_TICK_MS);

// ปุ่มสำรอง (HOSxP down / data not in yet): staff move a queue by hand — a reason is required, and it is logged
app.post('/api/sys/:sysId/flow-action', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const b = req.body || {};
  const display = String(b.display || '').toUpperCase().trim(), reason = String(b.reason || '').trim();
  if (!reason) return res.json({ success: false, message: 'กรุณาระบุเหตุผล' });
  if (b.action === 'checked' || b.action === 'toCashier') {
    const cashId = flowCashierOf(sysId, sys);
    if (!cashId) return res.json({ success: false, message: 'ห้องนี้ไม่ได้เปิด "เดินคิวตามสถานะ HOSxP"' });
    const w = findWaiting(sys, display);
    if (!w || w.t.flow !== 'check') return res.json({ success: false, message: `ไม่พบคิว ${display} ในรายการรอตรวจสอบยา` });
    flowLog(w.t, b.action === 'checked' ? 'ถือว่าตรวจยาแล้ว' : 'ส่งไปการเงินเอง', b.by, reason);
    if (!flowPass(sysId, sys, display, { route: b.action === 'toCashier' ? 'cash' : null }))
      return res.json({ success: false, message: 'ส่งไปการเงินไม่สำเร็จ — ตรวจว่าห้องการเงินมีประเภทคิว' });
    saveQueueState(sysId, sys);
    emitFlow(sysId); emitFlow(cashId);
    return res.json({ success: true });
  }
  if (b.action === 'paid') {
    // from the pharmacy (its "อยู่ที่การเงิน" lane) or from the cashier (a called pharmacy queue)
    let pharmId = sysId;
    for (const s of Object.values(sys.state)) {
      const c = s.served.find(x => x.display === display && x.flowFrom) || s.waiting.find(x => x.display === display && x.flowFrom);
      if (c) { pharmId = c.flowFrom; break; }
    }
    const pharm = getSys(pharmId);
    const away = pharm && (pharm.flowAway || []).find(a => a.display === display);
    if (!away) return res.json({ success: false, message: `ไม่พบคิว ${display} ในรายการที่อยู่การเงิน` });
    const cashId = away.cashierSysId;
    // the cashier saw the receipt / debt slip in HOSxP but never called the queue — recorded as such
    const how = ['receipt', 'debt'].includes(b.how) ? b.how : 'manual';
    flowBack(pharmId, pharm, display, how, b.by, reason);
    emitFlow(pharmId); if (cashId) emitFlow(cashId);
    return res.json({ success: true, ended: !!away.endsAtCashier });
  }
  res.json({ success: false, message: 'ไม่รู้จักคำสั่งนี้' });
});

// ── Per-sys cashier settings ──────────────────────────────────────────────
app.get('/api/sys/:sysId/cashier-settings', requireSys, (req, res) => res.json(req.sys.cashierSettings));

app.post('/api/sys/:sysId/cashier-settings', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const flowWas = flowCashierOf(sysId, sys);
  Object.assign(sys.cashierSettings, req.body);
  saveJson(sys.cashierSettingsFile, sys.cashierSettings);
  io.to('sys-' + sysId).emit('cashier_settings_updated', sys.cashierSettings);
  const flowIs = flowCashierOf(sysId, sys);
  if (flowWas !== flowIs) {
    // flow switched off: queues held at "รอตรวจสอบยา" become ordinary waiting queues again
    if (!flowIs) {
      for (const s of Object.values(sys.state)) for (const t of s.waiting) if (t.flow === 'check') {
        delete t.flow;
        t.forwardSkipped = t.payRoute === 'free' ? true : undefined;
      }
      saveQueueState(sysId, sys);
    }
    for (const id of [sysId, flowWas, flowIs]) if (id) emitFlow(id);
    setImmediate(flowTick);
  }
  res.json({ success: true });
});

// ── Print config ──────────────────────────────────────────────────────────
app.get('/api/sys/:sysId/print-config', requireSys, (req, res) => res.json(req.sys.printConfig));

app.post('/api/sys/:sysId/print-config', requireSys, (req, res) => {
  const { sys, sysId } = req;
  Object.assign(sys.printConfig, req.body);
  saveJson(sys.printConfigFile, sys.printConfig);
  io.to('sys-' + sysId).emit('print_config_updated', sys.printConfig);
  res.json({ success: true, printConfig: sys.printConfig });
});

// ── CORS for local cross-origin print requests (client → localhost) ───────
function corsLocal(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
}

// ── Printer list (Windows) ────────────────────────────────────────────────
app.options('/api/printers', corsLocal);
app.get('/api/printers', corsLocal, (req, res) => {
  exec('powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"',
    { timeout: 6000, windowsHide: true }, (err, stdout) => {
    if (err) return res.json({ printers: [] });
    const printers = stdout.split('\n').map(p => p.trim()).filter(p => p.length > 0);
    res.json({ printers });
  });
});

// ── Direct print (server-side, no browser dialog) — shared with print-agent.js ──
app.post('/api/sys/:sysId/print-ticket', requireSys, (req, res) => {
  const cfg = req.sys.printConfig;
  if (!cfg.printerName) return res.json({ success: false, message: 'ไม่ได้เลือกเครื่องพิมพ์' });
  printSlip(cfg, req.body, cfg.printerName, (err, stderr) => {
    if (err) return res.json({ success: false, message: (stderr || err.message).trim() });
    res.json({ success: true });
  }, 15000);
});

// ── Local print (CORS — called from client machine's localhost) ───────────
app.options('/api/local-print', corsLocal);
app.post('/api/local-print', corsLocal, (req, res) => {
  const { printerName, sysId, ticket } = req.body;
  if (!printerName) return res.json({ success: false, message: 'ไม่ได้ระบุเครื่องพิมพ์' });
  const sys = getSys(Number(sysId) || 1);
  const cfg = sys ? { ...sys.printConfig, printerName } : { ...PRINT_CFG_DEFAULTS, printerName };
  printSlip(cfg, ticket || req.body, printerName, (err, stderr) => {
    if (err) return res.json({ success: false, message: (stderr || err.message).trim() });
    res.json({ success: true });
  }, 15000);
});

// ── Daily reset ───────────────────────────────────────────────────────────
function resetSys(sysId, sys) {
  for (const id of Object.keys(sys.state))
    sys.state[id] = { serial: 0, waiting: [], served: [], calledQueue: null };
  sys.noShows = []; sys.clearedNoShows = []; sys.deletedQueues = []; sys.issuedLog = []; sys.lastCalledByCounter = {}; sys.recentByCounter = {};
  sys.flowAway = []; sys.calledLog = [];
  try { fs.unlinkSync(path.join(sysDir(sysId), 'queue-state.json')); } catch {}
  io.to('sys-' + sysId).emit('queue_reset');
}
(function scheduleReset() {
  const now = new Date();
  const ms  = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;
  setTimeout(() => { systems.forEach(s => resetSys(s.id, sysData[s.id])); scheduleReset(); }, ms);
})();

// ── Patient lookup ────────────────────────────────────────────────────────
// age from patient.birthday — '45 ปี' / '3 ปี 2 เดือน' / '5 เดือน' (null when unknown)
function ageOf(b) {
  const d = b instanceof Date ? b : b ? new Date(String(b).slice(0, 10) + 'T00:00:00') : null;
  if (!d || isNaN(d)) return null;
  const now = new Date(); let m = (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth();
  if (now.getDate() < d.getDate()) m--;
  if (m < 0) return null;
  const y = Math.floor(m / 12), mm = m % 12;
  return y >= 6 ? y + ' ปี' : y ? y + ' ปี' + (mm ? ' ' + mm + ' เดือน' : '') : mm + ' เดือน';
}
app.post('/api/patient-lookup', requireApiToken, async (req, res) => {
  const { type, value, sysId: reqSysId, mode } = req.body;
  if (!value || !value.toString().trim()) return res.json({ success: false, message: 'กรุณาระบุข้อมูล' });
  const cfg = loadDbConfig();
  if (!cfg.host) {
    const val = value.toString().trim();
    if (mode === 'ipd') {
      return res.json({
        success: true,
        patient: {
          hn: (type === 'hn' || type === 'barcode') ? val : null,
          an: type === 'an' ? val : null,
          qn: null, vn: type === 'an' ? val : null, name: '',
          pttype: null, pttypeName: null, autoTypeId: null,
          vstdate: null, vsttime: null, mode: 'ipd',
        }
      });
    }
    return res.json({
      success: true,
      patient: {
        hn:         (type === 'hn' || type === 'barcode') ? val : null,
        qn:         type === 'qn' ? val : null,
        vn:         null,
        name:       '',
        pttype:     null,
        pttypeName: null,
        autoTypeId: null,
        vstdate:    null,
        vsttime:    null,
      }
    });
  }

  // Apply per-system barcode config
  const lc = (reqSysId && sysData[reqSysId]) ? sysData[reqSysId].lookupConfig : null;
  let val = value.toString().trim();
  if (lc) {
    if (lc.barcodePrefixLen > 0) val = val.slice(lc.barcodePrefixLen);
    if (lc.barcodeUseLen   > 0) val = val.slice(0, lc.barcodeUseLen);
  }

  // ── IPD mode: query ipt (inpatient) table ─────────────────────────────────
  if (mode === 'ipd') {
    // Search ipt by AN or HN regardless of which field the user typed into
    try {
      let row = null;
      if (isMysqlType(cfg.type)) {
        const mysql = require('mysql2/promise');
        const conn  = await mysql.createConnection({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectTimeout: 10000, charset: 'utf8mb4' });
      await conn.execute('SET NAMES utf8mb4');
        const [rows] = await conn.execute(
          `SELECT i.hn, i.an,
             CONCAT(IFNULL(pt.pname,''), IFNULL(pt.fname,''), ' ', IFNULL(pt.lname,'')) AS patient_name,
             p.name AS pttype_name, i.pttype, pt.birthday
           FROM ipt i
           LEFT JOIN patient pt ON pt.hn = i.hn
           LEFT JOIN pttype  p  ON p.pttype = i.pttype
           WHERE (i.confirm_discharge <> 'Y' OR i.confirm_discharge IS NULL) AND (i.an = ? OR i.hn = ?)
           ORDER BY CASE WHEN i.an = ? THEN 0 ELSE 1 END, i.an DESC LIMIT 1`,
          [val, val, val]
        );
        await conn.end();
        row = rows[0] || null;
      } else {
        const { Client } = require('pg');
        const client = new Client({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectionTimeoutMillis: 10000 });
        await client.connect();
        const result = await client.query(
          `SELECT i.hn, i.an,
             COALESCE(pt.pname,'') || COALESCE(pt.fname,'') || ' ' || COALESCE(pt.lname,'') AS patient_name,
             p.name AS pttype_name, i.pttype, pt.birthday
           FROM ipt i
           LEFT JOIN patient pt ON pt.hn = i.hn
           LEFT JOIN pttype  p  ON p.pttype = i.pttype
           WHERE (i.confirm_discharge <> 'Y' OR i.confirm_discharge IS NULL) AND (i.an = $1 OR i.hn = $1)
           ORDER BY CASE WHEN i.an = $1 THEN 0 ELSE 1 END, i.an DESC LIMIT 1`,
          [val]
        );
        await client.end();
        row = result.rows[0] || null;
      }
      if (!row) return res.json({ success: false, message: 'ไม่พบผู้ป่วยในที่ยังไม่จำหน่าย (AN/HN: ' + val + ')' });
      return res.json({
        success: true,
        patient: {
          hn:         row.hn,
          an:         row.an,
          qn:         null,
          vn:         row.an,
          name:       (row.patient_name || '').trim() || '(ไม่ระบุชื่อ)',
          pttype:     (row.pttype || '').trim() || null,
          pttypeName: (row.pttype_name || '').trim() || null,
          autoTypeId: null,
          vstdate:    null,
          vsttime:    null,
          mode:       'ipd',
          age:        ageOf(row.birthday),
        }
      });
    } catch (err) {
      return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
    }
  }

  // ── OPD mode (existing): query ovst with today's date ─────────────────────
  // Determine search column: use lookupConfig.barcodeField when type is 'barcode', else use explicit type
  const searchField = (type === 'barcode' && lc) ? (lc.barcodeField || 'hn')
                    : (type === 'hn' ? 'hn' : 'qn');
  try {
    let row = null;
    if (isMysqlType(cfg.type)) {
      const mysql = require('mysql2/promise');
      const conn  = await mysql.createConnection({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectTimeout: 10000, charset: 'utf8mb4' });
      await conn.execute('SET NAMES utf8mb4');
      const col   = searchField === 'hn' ? 'o.hn' : 'o.oqueue';
      const [rows] = await conn.execute(
        `SELECT o.hn, o.oqueue, o.vn, o.vstdate, o.vsttime,
           CONCAT(IFNULL(p.pname,''), IFNULL(p.fname,''), ' ', IFNULL(p.lname,'')) AS ptname,
           pt.name AS pttype_name, o.pttype, p.birthday
         FROM ovst o
         LEFT JOIN patient p  ON p.hn      = o.hn
         LEFT JOIN pttype  pt ON pt.pttype = o.pttype
         WHERE ${col} = ? AND o.vstdate = CURDATE()
         ORDER BY o.vn DESC LIMIT 1`,
        [val]
      );
      await conn.end();
      row = rows[0] || null;
    } else {
      const { Client } = require('pg');
      const client = new Client({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectionTimeoutMillis: 10000 });
      await client.connect();
      const col    = searchField === 'hn' ? 'o.hn' : 'o.oqueue';
      const result = await client.query(
        `SELECT o.hn, o.oqueue, o.vn, o.vstdate, o.vsttime,
           COALESCE(p.pname,'') || COALESCE(p.fname,'') || ' ' || COALESCE(p.lname,'') AS ptname,
           pt.name AS pttype_name, o.pttype, p.birthday
         FROM ovst o
         LEFT JOIN patient p  ON p.hn      = o.hn
         LEFT JOIN pttype  pt ON pt.pttype = o.pttype
         WHERE ${col} = $1 AND o.vstdate = CURRENT_DATE
         ORDER BY o.vn DESC LIMIT 1`,
        [val]
      );
      await client.end();
      row = result.rows[0] || null;
    }
    if (!row) return res.json({ success: false, message: 'ไม่พบ visit รับบริการในวันนี้' });

    // Pttype rule matching
    const pttype     = (row.pttype || '').trim();
    const pttypeName = (row.pttype_name || '').trim() || null;
    let autoTypeId   = null;
    if (lc && !lc.allowAllPtypes) {
      const rule = (lc.pttypeRules || []).find(r => r.enabled !== false && r.code === pttype);
      if (!rule) return res.json({ success: false, message: `สิทธิการรักษา "${pttype || pttypeName || 'ไม่ระบุ'}" ไม่ได้รับอนุญาตในระบบนี้` });
      autoTypeId = rule.autoTypeId || null;
    } else if (lc) {
      const rule = (lc.pttypeRules || []).find(r => r.enabled !== false && r.code === pttype);
      if (rule) autoTypeId = rule.autoTypeId || null;
    }

    res.json({
      success: true,
      patient: {
        hn:          row.hn,
        qn:          row.oqueue     || '-',
        vn:          row.vn         || null,
        name:        (row.ptname || '').trim() || '(ไม่ระบุชื่อ)',
        pttype,
        pttypeName,
        autoTypeId,
        vstdate:     row.vstdate,
        vsttime:     row.vsttime    || null,
        age:         ageOf(row.birthday),
      }
    });
  } catch (err) {
    res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
  }
});

// ── Patient drug/dispensing items for a visit (VN) ────────────────────────
app.post('/api/patient-drugs', requireApiToken, async (req, res) => {
  const { vn } = req.body || {};
  if (!vn) return res.json({ success: false, message: 'ไม่พบเลข VN' });
  const cfg = loadDbConfig();
  if (!cfg.host) return res.json({ success: false, message: 'ยังไม่ได้ตั้งค่าฐานข้อมูล' });
  try {
    let rows = [];
    if (isMysqlType(cfg.type)) {
      const mysql = require('mysql2/promise');
      const conn  = await mysql.createConnection({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectTimeout: 10000, charset: 'utf8mb4' });
      await conn.execute('SET NAMES utf8mb4');
      const [r] = await conn.execute(
        `SELECT o.vstdate, o.oqueue, o.hn, s.name AS drug_name,
           CONCAT(COALESCE(od.usage_line1,''),' ',COALESCE(od.usage_line2,''),' ',COALESCE(od.usage_line3,'')) AS usage_text,
           op.qty AS qty, op.sum_price AS price
         FROM ovst o
         LEFT JOIN opitemrece op ON op.vn = o.vn
         LEFT JOIN s_drugitems s ON s.icode = op.icode
         LEFT JOIN opi_dispense od ON od.hos_guid = op.hos_guid
         WHERE o.vn = ? AND op.icode LIKE '1%'`,
        [vn]
      );
      await conn.end();
      rows = r;
    } else {
      const { Client } = require('pg');
      const client = new Client({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectionTimeoutMillis: 10000 });
      await client.connect();
      const result = await client.query(
        `SELECT o.vstdate, o.oqueue, o.hn, s.name AS drug_name,
           CONCAT(COALESCE(od.usage_line1,''),' ',COALESCE(od.usage_line2,''),' ',COALESCE(od.usage_line3,'')) AS usage_text,
           op.qty AS qty, op.sum_price AS price
         FROM ovst o
         LEFT JOIN opitemrece op ON op.vn = o.vn
         LEFT JOIN s_drugitems s ON s.icode = op.icode
         LEFT JOIN opi_dispense od ON od.hos_guid = op.hos_guid
         WHERE o.vn = $1 AND op.icode LIKE '1%'`,
        [vn]
      );
      await client.end();
      rows = result.rows;
    }
    res.json({
      success: true,
      items: rows.map(r => ({
        drugName: (r.drug_name || '').trim() || null,
        usage:    (r.usage_text || '').replace(/\s+/g, ' ').trim() || null,
        qty:      r.qty,
        price:    r.price,
      }))
    });
  } catch (err) {
    res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
  }
});

// ── Drug item count per visit (distinct icode LIKE '1%') for the call page ─
// ── ผ่านการเงินแล้วหรือยัง: rcpt_print = ออกใบเสร็จแล้ว, rcpt_debt = ออกใบแจ้งหนี้แล้ว (status ABORT = ยกเลิก, not counted) ──
app.post('/api/rcpt-status', requireApiToken, async (req, res) => {
  const vns = [...new Set(((req.body || {}).vns || []).map(v => String(v).trim()).filter(Boolean))].slice(0, 200);
  if (!vns.length) return res.json({ success: true, status: {} });
  const ph = vns.map(() => '?').join(',');
  try {
    const [rcpt, debt, rx] = await hosQuery([
      [`SELECT DISTINCT vn FROM rcpt_print WHERE vn IN (${ph}) AND COALESCE(status, '') <> 'ABORT'`, vns],
      [`SELECT DISTINCT vn FROM rcpt_debt  WHERE vn IN (${ph}) AND COALESCE(status, '') <> 'ABORT'`, vns],
      // ตรวจยาแล้ว: HOSxP records the drug checker (rx_dispenser_type 3 = ผู้ตรวจสอบยา) per visit
      [`SELECT vn, MAX(rx_dispenser_datetime) AS at FROM rx_dispenser_detail WHERE rx_dispenser_type_id = 3 AND vn IN (${ph}) GROUP BY vn`, vns],
    ]);
    const has = rows => new Set(rows.map(r => String(r.vn).trim()));
    const r = has(rcpt), d = has(debt);
    const hhmm = v => { const t = v ? new Date(v) : null; return t && !isNaN(t) ? t.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : ''; };
    const chk = new Map(rx.map(x => [String(x.vn).trim(), hhmm(x.at)]));
    res.json({ success: true, status: Object.fromEntries(vns.map(v => [v, { receipt: r.has(v), debt: d.has(v), rxChecked: chk.has(v), rxCheckedAt: chk.get(v) || '' }])) });
  } catch (err) {
    res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
  }
});

// ── ยอดที่ต้องชำระ per OPD visit: SUM(opitemrece.sum_price) of the "ต้องจ่ายเงิน" payment codes (default 01, 03) ──
// codes: the pharmacy's ⚙ ออกคิว "ต้องจ่ายเงิน" codes when this is a cashier fed by a pharmacy, else this room's own
app.post('/api/sys/:sysId/pay-amounts', requireSys, async (req, res) => {
  const vns = [...new Set(((req.body || {}).vns || []).map(v => String(v).trim()).filter(Boolean))].slice(0, 200);
  if (!vns.length) return res.json({ success: true, amounts: {}, codes: [] });
  const src = flowPharmaciesOf(req.sysId).map(getSys).find(Boolean) || req.sys;
  const pay = (src.issueMode && src.issueMode.pay) || {};
  const codes = (pay.cashCodes && pay.cashCodes.length ? pay.cashCodes : ['01', '03']).map(String);
  const ph = a => a.map(() => '?').join(',');
  try {
    const [rows] = await hosQuery([[
      `SELECT vn, SUM(sum_price) AS total FROM opitemrece WHERE vn IN (${ph(vns)}) AND paidst IN (${ph(codes)}) GROUP BY vn`, [...vns, ...codes]]]);
    const amounts = Object.fromEntries(vns.map(v => [v, 0]));
    rows.forEach(r => { amounts[String(r.vn).trim()] = Math.round((Number(r.total) || 0) * 100) / 100; });
    res.json({ success: true, amounts, codes });
  } catch (err) {
    res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
  }
});

app.post('/api/drug-counts', requireApiToken, async (req, res) => {
  const vns = [...new Set(((req.body || {}).vns || []).map(v => String(v).trim()).filter(Boolean))].slice(0, 200);
  if (!vns.length) return res.json({ success: true, counts: {} });
  const cfg = loadDbConfig();
  if (!cfg.host) return res.json({ success: false, message: 'ยังไม่ได้ตั้งค่าฐานข้อมูล' });
  const sql = ph => `SELECT o.vn, COUNT(DISTINCT op.icode) AS n
         FROM ovst o
         JOIN opitemrece op ON op.vn = o.vn
         WHERE o.vn IN (${vns.map((_, i) => ph(i)).join(',')}) AND op.icode LIKE '1%'
         GROUP BY o.vn`;
  try {
    let rows = [];
    if (isMysqlType(cfg.type)) {
      const mysql = require('mysql2/promise');
      const conn  = await mysql.createConnection({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectTimeout: 10000, charset: 'utf8mb4' });
      const [r] = await conn.execute(sql(() => '?'), vns);
      await conn.end();
      rows = r;
    } else {
      const { Client } = require('pg');
      const client = new Client({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectionTimeoutMillis: 10000 });
      await client.connect();
      rows = (await client.query(sql(i => '$' + (i + 1)), vns)).rows;
      await client.end();
    }
    // visits with no drug rows are absent from the result → 0
    const counts = Object.fromEntries(vns.map(v => [v, 0]));
    rows.forEach(r => { counts[String(r.vn).trim()] = Number(r.n) || 0; });
    res.json({ success: true, counts });
  } catch (err) {
    res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
  }
});

// ── Dept → System mapping  (format: { depcode: [sysId, ...] }) ───────────
const DEPT_SYS_FILE = path.join(DATA_DIR, 'dept-systems.json');
function loadDeptSystems() {
  const raw = loadJson(DEPT_SYS_FILE, {});
  // migrate old format { depcode: sysId } → { depcode: [sysId] }
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = Array.isArray(v) ? v : (v ? [v] : []);
  }
  return out;
}
function saveDeptSystems(d) { saveJson(DEPT_SYS_FILE, d); }
// depcode → ห้องตรวจ name, remembered at login (select-dept) for labels
const DEPT_NAMES_FILE = path.join(DATA_DIR, 'dept-names.json');

function currentDbKey() {
  const cfg = loadDbConfig();
  // hashed: /api/systems is public, so don't expose the DB host
  return cfg.host ? crypto.createHash('md5').update(`${cfg.host}/${cfg.database}`).digest('hex').slice(0, 12) : '';
}

// ห้องตรวจ names straight from kskdepartment of the connected database
async function fetchDeptNames(codes) {
  const cfg = loadDbConfig();
  if (!cfg.host || !codes.length) return {};
  const out = {};
  if (isMysqlType(cfg.type)) {
    const mysql = require('mysql2/promise');
    const conn  = await mysql.createConnection({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectTimeout: 10000, charset: 'utf8mb4' });
    try {
      const [rows] = await conn.execute(`SELECT depcode, department FROM kskdepartment WHERE depcode IN (${codes.map(() => '?').join(',')})`, codes);
      rows.forEach(r => { out[r.depcode] = r.department; });
    } finally { await conn.end(); }
  } else {
    const { Client } = require('pg');
    const client = new Client({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectionTimeoutMillis: 10000 });
    await client.connect();
    try {
      const r = await client.query(`SELECT depcode, department FROM kskdepartment WHERE depcode = ANY($1)`, [codes]);
      r.rows.forEach(row => { out[row.depcode] = row.department; });
    } finally { await client.end(); }
  }
  return out;
}

// Forward targets offered in settings: systems a ห้องตรวจ created after login on the
// currently connected database, plus any already selected so they can still be unticked
app.get('/api/sys/:sysId/forward-candidates', requireSys, async (req, res) => {
  const { sysId } = req;
  const me = systems.find(s => s.id === sysId);
  const selected = (me && me.forwardTo) || [];
  const dbKey = currentDbKey();
  const deptSys = loadDeptSystems();
  const depts = {};
  for (const [code, ids] of Object.entries(deptSys))
    for (const id of ids) (depts[id] = depts[id] || []).push(code.trim());
  const pick = systems.filter(s => s.id !== sysId &&
    ((depts[s.id] && dbKey && s.db === dbKey) || selected.includes(s.id)));
  let names = loadJson(DEPT_NAMES_FILE, {});
  try {
    const codes = [...new Set(pick.flatMap(s => depts[s.id] || []))];
    names = { ...names, ...(await fetchDeptNames(codes)) };
  } catch {}  // DB unreachable → fall back to names remembered at login
  res.json(pick.map(s => ({
    ...s,
    depts: s.db === dbKey ? (depts[s.id] || []).map(code => ({ code, name: names[code] || '' })) : [],
    selected: selected.includes(s.id),
  })));
});
function addSysToDept(depcode, sysId) {
  const d = loadDeptSystems();
  if (!d[depcode]) d[depcode] = [];
  if (!d[depcode].includes(sysId)) d[depcode].push(sysId);
  saveDeptSystems(d);
}
function removeSysFromDepts(sysId) {
  const d = loadDeptSystems();
  for (const k of Object.keys(d)) d[k] = d[k].filter(id => id !== sysId);
  saveDeptSystems(d);
}

// ── Admin auth (protects DB connection settings) ──────────────────────────
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'adminqueue';
const adminSessions = {};

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || (req.body || {}).token || (req.query || {}).token;
  if (token && adminSessions[token]) return next();
  res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบผู้ดูแลระบบก่อน' });
}

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = crypto.randomBytes(32).toString('hex');
    adminSessions[token] = { loginAt: Date.now() };
    return res.json({ success: true, token });
  }
  res.json({ success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
});

app.post('/api/admin/logout', (req, res) => {
  const token = (req.body || {}).token;
  if (token) delete adminSessions[token];
  res.json({ success: true });
});

// ── DB Config & Auth ──────────────────────────────────────────────────────
const sessions = {};

app.get('/api/db-config', requireAdmin, (req, res) => {
  const cfg = loadDbConfig();
  res.json({
    type: cfg.type, host: cfg.host, port: cfg.port, database: cfg.database, username: cfg.username, password: cfg.password,
    hospitalCode: cfg.hospitalCode || '', apiToken: cfg.apiToken || ''
  });
});

app.post('/api/db-config/save', requireAdmin, (req, res) => {
  const { type, host, port, database, username, password, hospitalCode } = req.body;
  const cfg = loadDbConfig();
  saveJson(DB_CONFIG_FILE, {
    type: type || 'mysql', host: (host || '').trim(), port: Number(port) || 3306,
    database: (database || '').trim(), username: (username || '').trim(), password: password || '',
    hospitalCode: (hospitalCode != null ? String(hospitalCode).trim() : cfg.hospitalCode || ''),
    apiToken: cfg.apiToken || ''
  });
  res.json({ success: true });
});

// สร้าง API Token ใหม่ — ขึ้นต้นด้วยรหัสสถานพยาบาล ตามด้วยรหัส gen อีก 10 หลัก
app.post('/api/db-config/gen-token', requireAdmin, (req, res) => {
  const { hospitalCode } = req.body || {};
  const cfg  = loadDbConfig();
  const code = (hospitalCode != null ? String(hospitalCode).trim() : cfg.hospitalCode || '');
  if (!code) return res.json({ success: false, message: 'กรุณากรอกรหัสสถานพยาบาลก่อนสร้าง Token' });
  const apiToken = genApiToken(code);
  saveJson(DB_CONFIG_FILE, { ...cfg, hospitalCode: code, apiToken });
  res.json({ success: true, apiToken });
});

// Bootstrap endpoint — หน้าเว็บของระบบเองใช้ดึง token มาแนบกับ request /api/sys/* โดยอัตโนมัติ
// (ผู้ใช้ทั่วไปไม่เห็น ไม่ต้องกรอกเอง แต่ถ้า copy URL ไปยิงตรงใน Postman โดยไม่มี token จะถูกปฏิเสธ)
// The app's own pages call this with a Referer from this same server; Postman / curl / copied URLs send none.
// Sec-Fetch-Site is only sent by browsers to HTTPS or localhost (not to http://LAN-IP), so it is checked
// only when present. A logged-in session token is also accepted.
function isOwnPageRequest(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  const ref = req.headers['referer'] || '';
  try { return new URL(ref).host === req.headers.host; } catch { return false; }
}
app.get('/api/client-token', (req, res) => {
  const authTok = req.headers['x-auth-token'];
  if (!isOwnPageRequest(req) && !(authTok && sessions[authTok]))
    return res.status(403).json({ success: false, message: 'Forbidden' });
  const cfg = loadDbConfig();
  res.json({ token: cfg.apiToken || '' });
});

app.post('/api/db-config/test', requireAdmin, async (req, res) => {
  const { type, host, port, database, username, password } = req.body;
  try {
    if (isMysqlType(type)) {
      const mysql = require('mysql2/promise');
      const conn = await mysql.createConnection({ host, port: Number(port), database, user: username, password, connectTimeout: 10000, charset: 'utf8mb4' });
      await conn.execute('SET NAMES utf8mb4');
      await conn.end();
    } else {
      const { Client } = require('pg');
      const client = new Client({ host, port: Number(port), database, user: username, password, connectionTimeoutMillis: 10000 });
      await client.connect();
      await client.end();
    }
    res.json({ success: true, message: 'เชื่อมต่อสำเร็จ' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── DB table check & migrate ──────────────────────────────────────────────
const TABLE_NAMES = ['app_queue_opd', 'app_queue_events'];

async function checkTables(cfg) {
  const result = { app_queue_opd: false, app_queue_events: false };
  if (isMysqlType(cfg.type)) {
    const mysql = require('mysql2/promise');
    const conn  = await mysql.createConnection({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectTimeout: 10000, charset: 'utf8mb4' });
      await conn.execute('SET NAMES utf8mb4');
    const [rows] = await conn.execute(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('app_queue_opd','app_queue_events')`,
      [cfg.database]
    );
    await conn.end();
    rows.forEach(r => { result[r.TABLE_NAME] = true; });
  } else {
    const { Client } = require('pg');
    const client = new Client({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectionTimeoutMillis: 10000, query_timeout: 15000 });
    await client.connect();
    const { rows } = await client.query(
      `SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('app_queue_opd','app_queue_events')`
    );
    await client.end();
    rows.forEach(r => { result[r.table_name] = true; });
  }
  return result;
}

// ใช้ connection ที่ส่งมาจากฟอร์ม (หลังทดสอบเชื่อมต่อสำเร็จ) ถ้ามี — ไม่งั้นใช้ค่าที่บันทึกไว้
function connCfgFrom(req) {
  const b = req.body || {};
  if (!b.host) return loadDbConfig();
  return { type: b.type, host: b.host, port: b.port, database: b.database, username: b.username, password: b.password };
}

async function handleCheckTables(req, res) {
  const cfg = connCfgFrom(req);
  if (!cfg.host) return res.json({ success: false, message: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล', tables: { app_queue_opd: false, app_queue_events: false } });
  try {
    const tables = await checkTables(cfg);
    res.json({ success: true, tables });
  } catch (err) {
    res.json({ success: false, message: err.message, tables: { app_queue_opd: false, app_queue_events: false } });
  }
}
app.get('/api/db/check-tables', requireAdmin, handleCheckTables);
app.post('/api/db/check-tables', requireAdmin, handleCheckTables);

app.post('/api/db/migrate', requireAdmin, async (req, res) => {
  const cfg = connCfgFrom(req);
  if (!cfg.host) return res.json({ success: false, message: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล' });
  let step = 'connect';
  try {
    if (isMysqlType(cfg.type)) {
      const mysql = require('mysql2/promise');
      const conn  = await mysql.createConnection({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectTimeout: 10000, charset: 'utf8mb4', multipleStatements: true });
      await conn.execute('SET NAMES utf8mb4');
      await conn.execute(`CREATE TABLE IF NOT EXISTS app_queue_opd (
        id           INT          NOT NULL AUTO_INCREMENT,
        sys_id       INT          NOT NULL DEFAULT 1,
        service_date DATE,
        vn           VARCHAR(13),
        vstdate      DATE,
        vsttime      TIME,
        type_id      INT,
        type_name    VARCHAR(100),
        prefix       VARCHAR(10),
        ticket_no    INT,
        display      VARCHAR(20),
        hn           VARCHAR(20),
        qn           VARCHAR(20),
        patient_name VARCHAR(200),
        status       ENUM('waiting','called','noshow','completed','void') DEFAULT 'waiting',
        issued_at    DATETIME,
        called_at    DATETIME,
        counter_id   INT,
        counter_name VARCHAR(100),
        return_count INT          DEFAULT 0,
        noshow_at    DATETIME,
        created_at   DATETIME     DEFAULT CURRENT_TIMESTAMP,
        updated_at   DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await conn.execute(`CREATE TABLE IF NOT EXISTS app_queue_events (
        id           INT          NOT NULL AUTO_INCREMENT,
        ticket_id    INT,
        sys_id       INT          NOT NULL DEFAULT 1,
        service_date DATE,
        event_type   ENUM('issued','called','recalled','noshow','noshow_recalled','returned','completed','void'),
        counter_id   INT,
        counter_name VARCHAR(100),
        event_at     DATETIME     DEFAULT CURRENT_TIMESTAMP,
        meta         JSON,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      // Add UNIQUE index on id — ignore error if already exists
      for (const [tbl, idx] of [['app_queue_opd','uq_opd_id'],['app_queue_events','uq_evt_id']]) {
        try { await conn.execute(`ALTER TABLE ${tbl} ADD UNIQUE KEY ${idx} (id)`); } catch {}
      }
      // Add vn column if not exists
      try { await conn.execute(`ALTER TABLE app_queue_opd ADD COLUMN vn VARCHAR(13) AFTER service_date`); } catch {}
      await conn.end();
    } else {
      const { Client } = require('pg');
      const client = new Client({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectionTimeoutMillis: 10000, query_timeout: 15000 });
      console.log(`[migrate] เริ่ม migrate (${cfg.host}:${cfg.port}/${cfg.database})`);
      await client.connect();
      console.log('[migrate] connect สำเร็จ — กำลังสร้าง app_queue_opd');
      step = 'create app_queue_opd';
      await client.query(`CREATE TABLE IF NOT EXISTS app_queue_opd (
        id           SERIAL       NOT NULL,
        sys_id       INT          NOT NULL DEFAULT 1,
        service_date DATE,
        vn           VARCHAR(13),
        vstdate      DATE,
        vsttime      TIME,
        type_id      INT,
        type_name    VARCHAR(100),
        prefix       VARCHAR(10),
        ticket_no    INT,
        display      VARCHAR(20),
        hn           VARCHAR(20),
        qn           VARCHAR(20),
        patient_name VARCHAR(200),
        status       VARCHAR(20)  DEFAULT 'waiting',
        issued_at    TIMESTAMP,
        called_at    TIMESTAMP,
        counter_id   INT,
        counter_name VARCHAR(100),
        return_count INT          DEFAULT 0,
        noshow_at    TIMESTAMP,
        created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )`);
      console.log('[migrate] สร้าง app_queue_opd สำเร็จ — กำลังสร้าง app_queue_events');
      step = 'create app_queue_events';
      await client.query(`CREATE TABLE IF NOT EXISTS app_queue_events (
        id           SERIAL       NOT NULL,
        ticket_id    INT,
        sys_id       INT          NOT NULL DEFAULT 1,
        service_date DATE,
        event_type   VARCHAR(30),
        counter_id   INT,
        counter_name VARCHAR(100),
        event_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        meta         JSONB,
        PRIMARY KEY (id)
      )`);
      console.log('[migrate] สร้าง app_queue_events สำเร็จ — กำลังสร้าง index');
      step = 'create index';
      // Add UNIQUE index on id — ignore error if already exists
      for (const [tbl, idx] of [['app_queue_opd','uq_opd_id'],['app_queue_events','uq_evt_id']]) {
        try { await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON ${tbl} (id)`); } catch {}
      }
      console.log('[migrate] สร้าง index สำเร็จ — กำลัง alter เพิ่มคอลัมน์ vn');
      step = 'alter add column vn';
      // Add vn column if not exists
      try { await client.query(`ALTER TABLE app_queue_opd ADD COLUMN IF NOT EXISTS vn VARCHAR(13)`); } catch {}
      console.log('[migrate] alter สำเร็จ — ปิด connection');
      step = 'close connection';
      await client.end();
    }
    console.log('[migrate] กำลังตรวจสอบตาราง (checkTables)');
    step = 'checkTables';
    const tables = await checkTables(cfg);
    console.log('[migrate] เสร็จสมบูรณ์', tables);
    res.json({ success: true, tables });
  } catch (err) {
    console.error(`[migrate] ล้มเหลวที่ขั้นตอน "${step}":`, err.message);
    res.json({ success: false, message: `[${step}] ${err.message}`, step });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบ' });
  const cfg = loadDbConfig();
  if (!cfg.host) return res.json({ success: false, message: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล' });
  try {
    let officer = null;
    if (isMysqlType(cfg.type)) {
      const mysql = require('mysql2/promise');
      const conn = await mysql.createConnection({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectTimeout: 10000, charset: 'utf8mb4' });
      await conn.execute('SET NAMES utf8mb4');
      const [rows] = await conn.execute('SELECT officer_id,officer_name,officer_login_name,officer_login_password_md5 FROM officer WHERE officer_login_name = ? LIMIT 1', [username]);
      await conn.end();
      officer = rows[0] || null;
    } else {
      const { Client } = require('pg');
      const client = new Client({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectionTimeoutMillis: 10000 });
      await client.connect();
      const result = await client.query('SELECT officer_id,officer_name,officer_login_name,officer_login_password_md5 FROM officer WHERE officer_login_name = $1 LIMIT 1', [username]);
      await client.end();
      officer = result.rows[0] || null;
    }
    if (!officer) return res.json({ success: false, message: 'ไม่พบชื่อผู้ใช้งานนี้ในระบบ' });
    const inputMd5  = crypto.createHash('md5').update(password).digest('hex').toLowerCase();
    const storedMd5 = (officer.officer_login_password_md5 || '').trim().toLowerCase();
    if (inputMd5 !== storedMd5) return res.json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
    const token = crypto.randomBytes(32).toString('hex');
    sessions[token] = { username: officer.officer_login_name, officerId: officer.officer_id, loginAt: Date.now() };
    res.json({ success: true, token, officer: { name: officer.officer_name || officer.officer_login_name } });
  } catch (err) {
    res.json({ success: false, message: 'เชื่อมต่อฐานข้อมูลไม่สำเร็จ: ' + err.message });
  }
});

// ── BMS Session login (ดู BMS-SESSION-SPECIFICATION.md) ───────────────────
// รับ bms-session-id → ไปยืนยันตัวตนกับ HOSxP PasteJSON API → จับคู่ชื่อกับตาราง officer
// ในฐานข้อมูลที่ตั้งค่าไว้ → ถ้าเจอ ออก session token แบบเดียวกับ login ปกติ (ยังต้องเลือกห้องตรวจต่อ)
app.post('/api/auth/bms-login', async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.json({ success: false, message: 'ไม่พบ BMS Session ID' });
  const cfg = loadDbConfig();
  if (!cfg.host) return res.json({ success: false, message: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล' });

  let bmsData;
  try {
    const r = await fetch('https://hosxp.net/phapi/PasteJSON?Action=GET&code=' + encodeURIComponent(sessionId), { signal: AbortSignal.timeout(30000) });
    bmsData = await r.json();
  } catch (err) {
    return res.json({ success: false, message: 'ติดต่อ BMS Session Server ไม่สำเร็จ: ' + err.message });
  }
  if (bmsData.MessageCode === 500) return res.json({ success: false, message: 'BMS Session หมดอายุ กรุณาเข้าใหม่' });
  if (bmsData.MessageCode !== 200) return res.json({ success: false, message: bmsData.Message || 'BMS Session ไม่ถูกต้อง' });

  const userInfo = (bmsData.result || {}).user_info || {};
  const bmsName  = (userInfo.name || '').trim();
  if (!bmsName) return res.json({ success: false, message: 'BMS Session ไม่มีข้อมูลชื่อผู้ใช้งาน' });

  try {
    let officer = null;
    if (isMysqlType(cfg.type)) {
      const mysql = require('mysql2/promise');
      const conn = await mysql.createConnection({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectTimeout: 10000, charset: 'utf8mb4' });
      await conn.execute('SET NAMES utf8mb4');
      const [rows] = await conn.execute('SELECT officer_id,officer_name,officer_login_name FROM officer WHERE TRIM(officer_name) = TRIM(?) LIMIT 1', [bmsName]);
      await conn.end();
      officer = rows[0] || null;
    } else {
      const { Client } = require('pg');
      const client = new Client({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectionTimeoutMillis: 10000 });
      await client.connect();
      const result = await client.query("SELECT officer_id,officer_name,officer_login_name FROM officer WHERE TRIM(officer_name) = TRIM($1) LIMIT 1", [bmsName]);
      await client.end();
      officer = result.rows[0] || null;
    }
    if (!officer) return res.json({ success: false, message: `ไม่พบชื่อ "${bmsName}" ในระบบเจ้าหน้าที่ (officer) กรุณาติดต่อผู้ดูแลระบบ` });
    const token = crypto.randomBytes(32).toString('hex');
    sessions[token] = { username: officer.officer_login_name, officerId: officer.officer_id, loginAt: Date.now(), viaBms: true };
    res.json({ success: true, token, officer: { name: officer.officer_name || officer.officer_login_name } });
  } catch (err) {
    res.json({ success: false, message: 'เชื่อมต่อฐานข้อมูลไม่สำเร็จ: ' + err.message });
  }
});

app.post('/api/auth/verify', (req, res) => {
  const token = (req.body || {}).token || req.headers['x-auth-token'];
  if (token && sessions[token]) return res.json({ success: true, officer: sessions[token] });
  res.json({ success: false });
});

app.post('/api/auth/logout', (req, res) => {
  const token = (req.body || {}).token;
  if (token) delete sessions[token];
  res.json({ success: true });
});

// ── Officer departments ───────────────────────────────────────────────────
app.post('/api/officer/departments', async (req, res) => {
  const token = (req.body || {}).token;
  if (!token || !sessions[token]) return res.json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });
  const loginName = sessions[token].username;
  const cfg = loadDbConfig();
  if (!cfg.host) return res.json({ success: false, message: 'ยังไม่ได้ตั้งค่าฐานข้อมูล' });
  try {
    let rows = [];
    if (isMysqlType(cfg.type)) {
      const mysql = require('mysql2/promise');
      const conn  = await mysql.createConnection({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectTimeout: 10000, charset: 'utf8mb4' });
      await conn.execute('SET NAMES utf8mb4');
      const [r] = await conn.execute(
        `SELECT od.depcode, k.department
         FROM officer o
         LEFT JOIN officer_department od ON od.officer_id = o.officer_id
         LEFT JOIN kskdepartment k ON k.depcode = od.depcode
         WHERE o.officer_login_name = ?
         ORDER BY k.department`,
        [loginName]
      );
      await conn.end();
      rows = r;
    } else {
      const { Client } = require('pg');
      const client = new Client({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectionTimeoutMillis: 10000 });
      await client.connect();
      const result = await client.query(
        `SELECT od.depcode, k.department
         FROM officer o
         LEFT JOIN officer_department od ON od.officer_id = o.officer_id
         LEFT JOIN kskdepartment k ON k.depcode = od.depcode
         WHERE o.officer_login_name = $1
         ORDER BY k.department`,
        [loginName]
      );
      await client.end();
      rows = result.rows;
    }
    // ตัดแถวที่ officer ไม่มีห้องตรวจผูกไว้เลย (LEFT JOIN แล้วได้ NULL) ออก
    rows = rows.filter(r => r.depcode && r.department);
    res.json({ success: true, departments: rows.map(r => ({ depcode: r.depcode, name: r.department })) });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Select department (only sets session depcode — no auto-create) ────────
app.post('/api/auth/select-dept', (req, res) => {
  const { token, depcode, deptName } = req.body || {};
  if (!token || !sessions[token]) return res.json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });
  if (!depcode) return res.json({ success: false, message: 'กรุณาเลือกห้องตรวจ' });
  sessions[token].depcode  = depcode;
  sessions[token].deptName = deptName || depcode;
  if (deptName) {
    const names = loadJson(DEPT_NAMES_FILE, {});
    if (names[depcode] !== deptName) { names[depcode] = deptName; saveJson(DEPT_NAMES_FILE, names); }
  }
  res.json({ success: true, depcode, deptName: deptName || depcode });
});

// ── My systems (systems belonging to current user's dept) ─────────────────
app.post('/api/my-systems', (req, res) => {
  const token = (req.body || {}).token;
  if (!token || !sessions[token]) return res.json({ success: false, sysIds: [] });
  const depcode = sessions[token].depcode;
  if (!depcode) return res.json({ success: true, sysIds: [] });
  const deptSys = loadDeptSystems();
  const sysIds  = (deptSys[depcode] || []).filter(id => systems.find(s => s.id === id));
  res.json({ success: true, sysIds });
});

// ── Startup / auto-start control (Windows registry) ──────────────────────
const BAT_PATH = path.join(__dirname, 'start-server.bat');

app.get('/api/startup-status', (req, res) => {
  exec(
    `powershell -NoProfile -Command "if (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'QueueSystem' -ErrorAction SilentlyContinue) { '1' } else { '0' }"`,
    { timeout: 5000, windowsHide: true },
    (err, stdout) => res.json({ autoStart: stdout.trim() === '1' })
  );
});

app.post('/api/startup/set', (req, res) => {
  const enable = !!req.body.enable;
  const cmd = enable
    ? `powershell -NoProfile -Command "Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'QueueSystem' -Value '${BAT_PATH.replace(/'/g, "''")}'"`
    : `powershell -NoProfile -Command "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'QueueSystem' -ErrorAction SilentlyContinue"`;
  exec(cmd, { timeout: 5000, windowsHide: true }, err =>
    res.json({ success: !err, autoStart: enable })
  );
});

app.post('/api/server/restart', (req, res) => {
  res.json({ success: true });
  setTimeout(() => {
    const { spawn } = require('child_process');
    spawn('cmd', ['/c', 'start', '', BAT_PATH], { detached: true, stdio: 'ignore', shell: false }).unref();
  }, 300);
});

// ── ดาวน์โหลด Setup_Sound.exe ────────────────────────────────────────────
app.get('/download/Setup_Sound.exe', (req, res) => {
  const filePath = path.join(PUBLIC_DIR, 'Setup_Sound.exe');
  if (!fs.existsSync(filePath)) {
    return res.status(404).send(
      '<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>ไม่พบไฟล์</title>' +
      '<style>body{font-family:\'Segoe UI\',sans-serif;background:#0f1923;color:#fff;display:flex;' +
      'align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:16px}' +
      'h2{color:#ef5350}p{color:#90caf9;font-size:.9rem;text-align:center}' +
      'code{background:#1a2a3a;padding:4px 10px;border-radius:6px;font-size:.85rem;color:#80deea}</style></head>' +
      '<body><h2>ไม่พบไฟล์ Setup_Sound.exe</h2>' +
      '<p>กรุณาวาง <code>Setup_Sound.exe</code> ไว้ในโฟลเดอร์เดียวกับ QueueServer<br>' +
      'แล้วรีสตาร์ท QueueServer</p></body></html>'
    );
  }
  res.setHeader('Content-Disposition', 'attachment; filename="Setup_Sound.exe"');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(filePath);
});

// ── Server info (for multi-PC connection guide) ───────────────────────────
app.get('/api/server-info', (req, res) => {
  const nets = os.networkInterfaces();
  const ips  = [];
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({ iface: name, ip: iface.address });
      }
    }
  }
  res.json({ port: PORT, hostname: os.hostname(), ips });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const lanIps = [];
  for (const n of Object.values(nets)) {
    for (const i of n) { if (i.family === 'IPv4' && !i.internal) lanIps.push(i.address); }
  }
  console.log(`ระบบคิว  http://localhost:${PORT}`);
  if (lanIps.length) console.log(`LAN      http://${lanIps[0]}:${PORT}  (เปิดจากเครื่องอื่นบน LAN)`);
});
