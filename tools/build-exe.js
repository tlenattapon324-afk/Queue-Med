/**
 * Build QueueServer.exe / QueuePrintAgent.exe with the Queue-Med icon.
 *
 * rcedit cannot be run on a finished pkg exe — pkg appends the app payload to the end of the
 * binary and changing PE resources afterwards breaks it. Instead the icon is applied to a copy
 * of pkg's plain Node base binary, and pkg builds on top of that copy (PKG_NODE_PATH).
 *
 *   node tools/build-exe.js server
 *   node tools/build-exe.js agent
 */
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { need } = require('@yao-pkg/pkg-fetch');
const rcedit = require('rcedit');

const ROOT = path.join(__dirname, '..');
const TARGETS = {
  server: { entry: 'server.js',      out: 'dist/QueueServer.exe',     icon: 'assets/icons/app.ico',         desc: 'Queue-Med Server' },
  agent:  { entry: 'print-agent.js', out: 'dist/QueuePrintAgent.exe', icon: 'assets/icons/print-agent.ico', desc: 'Queue-Med Print Agent' },
};
const NODE_RANGE = 'node20';

(async () => {
  const t = TARGETS[process.argv[2]];
  if (!t) { console.error('usage: node tools/build-exe.js server|agent'); process.exit(1); }
  const version = require(path.join(ROOT, 'package.json')).version;

  // 1. pkg's unmodified Node base binary (downloaded to ~/.pkg-cache on first use)
  delete process.env.PKG_NODE_PATH;
  const base = await need({ nodeRange: NODE_RANGE, platform: 'win', arch: 'x64' });

  // 2. Icon + version info on a copy of it
  const iconBase = path.join(ROOT, '.pkg-icon-base', `${process.argv[2]}-${path.basename(base)}.exe`);
  fs.mkdirSync(path.dirname(iconBase), { recursive: true });
  fs.copyFileSync(base, iconBase);
  await rcedit(iconBase, {
    icon: path.join(ROOT, t.icon),
    'file-version': version, 'product-version': version,
    'version-string': { FileDescription: t.desc, ProductName: 'Queue-Med', CompanyName: 'Queue-Med', OriginalFilename: path.basename(t.out) },
  });

  // 3. pkg on top of the patched base
  const pkgBin = path.join(ROOT, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js');
  execFileSync(process.execPath, [pkgBin, t.entry, '--target', `${NODE_RANGE}-win-x64`, '--output', t.out, '--compress', 'GZip'],
               { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PKG_NODE_PATH: iconBase } });
  console.log(`built ${t.out} with ${t.icon}`);
})().catch(e => { console.error(e); process.exit(1); });
