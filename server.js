const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const crypto  = require('crypto');
const { exec } = require('child_process');
const { printSlip } = require('./slip-print');

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

  const state = {};
  queueTypes.forEach(t => { state[t.id] = { serial: 0, waiting: [], served: [], calledQueue: null }; });

  sysData[sysId] = {
    queueTypes, counters, displayConfig, printConfig, screenConfig, lookupConfig, displaySettings, cashierSettings,
    typesFile, ctrsFile, displayFile, printConfigFile, screenConfigFile, lookupConfigFile, displaySettingsFile, cashierSettingsFile,
    nextTypeId:          Math.max(0, ...queueTypes.map(t => t.id)) + 1,
    nextCounterId:       Math.max(0, ...counters.map(c => c.id))   + 1,
    state,
    noShows:             [],
    clearedNoShows:      [],
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
    sys.lastCalledByCounter = saved.lastCalledByCounter || {};
    sys.recentByCounter     = saved.recentByCounter     || {};
  } catch {}
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
io.on('connection', socket => {
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
  if (depcode) addSysToDept(depcode, sys.id);
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

app.post('/api/sys/:sysId/queue-types', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const { name, prefix, color, forMode } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'ต้องระบุชื่อประเภทคิว' });
  const p = (prefix || '').toUpperCase().trim();
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
    const p = prefix.toUpperCase().trim();
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
app.post('/api/sys/:sysId/get-serial', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const { typeId, hn, qn, patientName, pttypeName, vn, vstdate, vsttime, mode, an } = req.body;
  const type = sys.queueTypes.find(t => t.id === Number(typeId));
  if (!type) return res.status(400).json({ success: false, message: 'ระบุประเภทคิวไม่ถูกต้อง' });
  initTypeState(sys, type.id);
  const s = sys.state[type.id];
  s.serial += 1;
  const ticket = {
    number:      s.serial,
    display:     type.prefix + String(s.serial).padStart(3, '0'),
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
  s.waiting.push(ticket);
  saveQueueState(sysId, sys);
  dbIssueTicket(sysId, ticket);
  io.to('sys-' + sysId).emit('queue_issued', { ticket, typeWaiting: typeWaiting(sys), allWaiting: allWaiting(sys) });
  res.json({ success: true, ticket });
});

function doCall(sys, sysId, ticket, s, counterId) {
  let counter = sys.counters.find(c => c.id === Number(counterId));
  if (!counter && sys.counters.length) counter = sys.counters[0]; // fallback to first counter
  const called  = {
    ...ticket,
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
    if (sys.recentByCounter[called.counterId].length > 5) sys.recentByCounter[called.counterId].pop();
  }
  broadcastCall(sysId, sys, called);
  saveQueueState(sysId, sys);
  dbCallTicket(sysId, called);
  return called;
}

app.post('/api/sys/:sysId/call-next', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const typeId    = req.body.typeId    ? Number(req.body.typeId)    : null;
  const counterId = req.body.counterId ? Number(req.body.counterId) : null;
  let ticket = null, s = null;
  if (typeId) {
    s = sys.state[typeId];
    if (!s || !s.waiting.length) return res.json({ success: false, message: 'ไม่มีคิวรอในประเภทนี้' });
    s.waiting.sort((a, b) => a._ts - b._ts);
    ticket = s.waiting.shift();
  } else {
    const all = allWaiting(sys);
    if (!all.length) return res.json({ success: false, message: 'ไม่มีคิวรอ' });
    ticket = all[0];
    s = sys.state[ticket.typeId];
    const idx = s.waiting.findIndex(t => t.display === ticket.display);
    if (idx !== -1) s.waiting.splice(idx, 1);
  }
  res.json({ success: true, calledQueue: doCall(sys, sysId, ticket, s, counterId) });
});

app.post('/api/sys/:sysId/call-number', requireSys, (req, res) => {
  const { sys, sysId } = req;
  const input     = (req.body.display || '').trim();
  const upper     = input.toUpperCase();
  const counterId = req.body.counterId ? Number(req.body.counterId) : null;
  for (const s of Object.values(sys.state)) {
    const idx = s.waiting.findIndex(t =>
      t.display === upper ||
      (t.qn && String(t.qn).trim() === input)
    );
    if (idx !== -1) {
      const [ticket] = s.waiting.splice(idx, 1);
      return res.json({ success: true, calledQueue: doCall(sys, sysId, ticket, s, counterId) });
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
        _ts:         ticket.issuedTs || ticket._ts,
        returned:    true,
        returnedAt:  new Date().toLocaleTimeString('th-TH'),
        returnCount: (ticket.returnCount || 0) + 1,
        calledAt:    undefined,
        counterId:   undefined,
        counterName: undefined,
      };
      s.waiting.push(restored);
      s.waiting.sort((a, b) => a._ts - b._ts);
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
      s.waiting.splice(idx, 1);
      saveQueueState(sysId, sys);
      io.to('sys-' + sysId).emit('queue_deleted_waiting', {
        display,
        typeWaiting: typeWaiting(sys),
        allWaiting:  allWaiting(sys),
      });
      return res.json({ success: true });
    }
  }
  res.json({ success: false, message: 'ไม่พบคิวนี้ในรายการรอ' });
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
    if (sys.recentByCounter[recalled.counterId].length > 5) sys.recentByCounter[recalled.counterId].pop();
  }
  broadcastCall(sysId, sys, recalled);
  recalled.recalled = true;
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
    if (sys.recentByCounter[recalled.counterId].length > 5) sys.recentByCounter[recalled.counterId].pop();
  }
  broadcastCall(sysId, sys, recalled);
  saveQueueState(sysId, sys);
  dbCallTicket(sysId, recalled);
  io.to('sys-' + sysId).emit('noshow_recalled', { display, noShows: sys.noShows.slice(0, 40) });
  res.json({ success: true, calledQueue: recalled });
});

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
    noShows:             sys.noShows.slice(0, 40),
    clearedNoShows:      (sys.clearedNoShows || []).slice(0, 40),
    lastCalledByCounter: sys.lastCalledByCounter,
    recentByCounter:     sys.recentByCounter,
    displayConfig:       sys.displayConfig,
    displaySettings:     sys.displaySettings,
    printConfig:         sys.printConfig,
    screenConfig:        sys.screenConfig,
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

// ── Google Translate TTS proxy (with disk cache) ───────────────────────────
const TTS_CACHE_DIR = path.join(DATA_DIR, 'tts-cache');
if (!fs.existsSync(TTS_CACHE_DIR)) fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });

app.get('/api/tts', async (req, res) => {
  const text = (req.query.text || '').toString().trim().slice(0, 200);
  const lang = ((req.query.lang || 'th').toString().match(/^[a-zA-Z-]+$/) || ['th'])[0];
  if (!text) return res.status(400).json({ error: 'missing text' });

  const key = crypto.createHash('md5').update(lang + '|' + text).digest('hex');
  const cacheFile = path.join(TTS_CACHE_DIR, key + '.mp3');

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'public, max-age=2592000');

  if (fs.existsSync(cacheFile)) {
    fs.createReadStream(cacheFile).pipe(res);
    return;
  }

  try {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${encodeURIComponent(lang)}&client=tw-ob`;
    const gRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Referer': 'https://translate.google.com/'
      }
    });
    if (!gRes.ok) throw new Error('google tts http ' + gRes.status);
    const buf = Buffer.from(await gRes.arrayBuffer());
    fs.writeFile(cacheFile, buf, () => {});
    res.end(buf);
  } catch (e) {
    console.error('TTS proxy error:', e.message);
    res.status(502).json({ error: 'tts_failed' });
  }
});

// ── Per-sys cashier settings ──────────────────────────────────────────────
app.get('/api/sys/:sysId/cashier-settings', requireSys, (req, res) => res.json(req.sys.cashierSettings));

app.post('/api/sys/:sysId/cashier-settings', requireSys, (req, res) => {
  const { sys, sysId } = req;
  Object.assign(sys.cashierSettings, req.body);
  saveJson(sys.cashierSettingsFile, sys.cashierSettings);
  io.to('sys-' + sysId).emit('cashier_settings_updated', sys.cashierSettings);
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
  sys.noShows = []; sys.clearedNoShows = []; sys.lastCalledByCounter = {}; sys.recentByCounter = {};
  try { fs.unlinkSync(path.join(sysDir(sysId), 'queue-state.json')); } catch {}
  io.to('sys-' + sysId).emit('queue_reset');
}
(function scheduleReset() {
  const now = new Date();
  const ms  = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;
  setTimeout(() => { systems.forEach(s => resetSys(s.id, sysData[s.id])); scheduleReset(); }, ms);
})();

// ── Patient lookup ────────────────────────────────────────────────────────
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
             p.name AS pttype_name, i.pttype
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
             p.name AS pttype_name, i.pttype
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
           pt.name AS pttype_name, o.pttype
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
           pt.name AS pttype_name, o.pttype
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
app.get('/api/client-token', (req, res) => {
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
    const r = await fetch('https://hosxp.net/phapi/PasteJSON?Action=GET&code=' + encodeURIComponent(sessionId));
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

// ── DEBUG (ลบออกหลังแก้ไขเสร็จ) ────────────────────────────────────────────
app.post('/api/debug/hash-check', async (req, res) => {
  const { username, password } = req.body;
  const cfg = loadDbConfig();
  try {
    let officer = null;
    if (isMysqlType(cfg.type)) {
      const mysql = require('mysql2/promise');
      const conn = await mysql.createConnection({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectTimeout: 10000, charset: 'utf8mb4' });
      await conn.execute('SET NAMES utf8mb4');
      const [rows] = await conn.execute('SELECT officer_login_name, officer_login_password_md5 FROM officer WHERE officer_login_name = ? LIMIT 1', [username]);
      await conn.end();
      officer = rows[0] || null;
    } else {
      const { Client } = require('pg');
      const client = new Client({ host: cfg.host, port: Number(cfg.port), database: cfg.database, user: cfg.username, password: cfg.password, connectionTimeoutMillis: 10000 });
      await client.connect();
      const result = await client.query('SELECT officer_login_name, officer_login_password_md5 FROM officer WHERE officer_login_name = $1 LIMIT 1', [username]);
      await client.end();
      officer = result.rows[0] || null;
    }
    if (!officer) return res.json({ found: false, message: 'ไม่พบ username นี้' });
    const stored  = officer.officer_login_password_md5 || '';
    const computed = crypto.createHash('md5').update(password).digest('hex');
    res.json({
      found:          true,
      stored_hash:    stored,
      stored_length:  stored.length,
      computed_md5:   computed,
      match:          computed.toLowerCase() === stored.trim().toLowerCase(),
    });
  } catch (err) {
    res.json({ error: err.message });
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
