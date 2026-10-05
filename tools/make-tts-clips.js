/**
 * Download the Google Translate TTS clips bundled with the installer (tts-clips/),
 * so announcements still use the Google voice when the server has no internet.
 *
 *   node tools/make-tts-clips.js
 */
const fs   = require('fs');
const path = require('path');
const { createTts, BUNDLED_WORDS, keyOf } = require('../tts-voice');

const ROOT = path.join(__dirname, '..');
const OUT  = path.join(ROOT, 'tts-clips');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const tts = createTts({ appDir: ROOT, cacheDir: path.join(ROOT, 'data', 'tts-cache') });
  const manifest = {};
  for (const word of BUNDLED_WORDS) {
    const file = keyOf('th', word) + '.mp3';
    if (!fs.existsSync(path.join(OUT, file))) {
      fs.writeFileSync(path.join(OUT, file), await tts.fetchGoogle('th', word, 15000));
      await new Promise(r => setTimeout(r, 250)); // be gentle with Google
    }
    manifest[word] = file;
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`${Object.keys(manifest).length} clips in ${path.relative(ROOT, OUT)}`);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
