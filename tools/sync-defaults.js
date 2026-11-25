/**
 * Copy this machine's settings (data/) into dist/data-defaults, so a fresh install starts with
 * the same rooms, screens and settings.
 *
 *   node tools/sync-defaults.js
 *
 * Left out on purpose:
 *   db-config.json    — HOSxP / database login (the installer is published; set it after install)
 *   queue-state.json  — today's live queues
 *   *.log, tts-cache/ — runtime files
 */
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC  = path.join(ROOT, 'data');
const DEST = path.join(ROOT, 'dist', 'data-defaults');
const SKIP_FILES = new Set(['db-config.json', 'queue-state.json']);
const SKIP_DIRS  = new Set(['tts-cache']);

function list(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...list(dir, r)); }
    else if (e.name.endsWith('.json') && !SKIP_FILES.has(e.name)) out.push(r);
  }
  return out;
}

if (!fs.existsSync(SRC)) { console.error('no data/ folder'); process.exit(1); }
const files = list(SRC);
// every file must be valid JSON — a half-written settings file must never ship
for (const f of files) JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));

// replace the old defaults (only .json files inside dist/data-defaults are removed)
if (fs.existsSync(DEST)) for (const f of list(DEST)) fs.unlinkSync(path.join(DEST, f));
for (const f of files) {
  fs.mkdirSync(path.dirname(path.join(DEST, f)), { recursive: true });
  fs.copyFileSync(path.join(SRC, f), path.join(DEST, f));
}
// display-default.json: only the screen look, as build-exe.js writes it
const def = path.join(SRC, 'display-default.json');
if (fs.existsSync(def)) {
  const { cfg, theme } = JSON.parse(fs.readFileSync(def, 'utf8'));
  fs.writeFileSync(path.join(DEST, 'display-default.json'), JSON.stringify({ cfg, theme }, null, 2));
}
// empty sys-N folders left behind by rooms that no longer exist
for (const e of fs.readdirSync(DEST, { withFileTypes: true }))
  if (e.isDirectory() && !fs.readdirSync(path.join(DEST, e.name)).length) fs.rmdirSync(path.join(DEST, e.name));

console.log(`data-defaults: ${files.length} settings files copied (db-config, queue-state, logs, tts-cache left out)`);
