/**
 * Google Translate TTS with offline fallback.
 *
 *  online  → whole sentence from Google (most natural), cached in data/tts-cache
 *  offline → the sentence is built from Google voice clips, one per word:
 *              - tts-clips/   bundled with the installer (tools/make-tts-clips.js)
 *              - data/tts-cache/  words learned while online (e.g. counter names)
 *
 * All files use the same key: md5(lang + '|' + text) + '.mp3'
 */
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// Words that make up every announcement — bundled so the voice works with no internet
const DIGIT_WORDS  = ['ศูนย์','หนึ่ง','สอง','สาม','สี่','ห้า','หก','เจ็ด','แปด','เก้า'];
const LETTER_WORDS = ['เอ','บี','ซี','ดี','อี','เอฟ','จี','เอช','ไอ','เจ','เค','แอล','เอ็ม',
                      'เอ็น','โอ','พี','คิว','อาร์','เอส','ที','ยู','วี','ดับเบิลยู','เอ็กซ์','วาย','แซด'];
const PHRASE_WORDS = ['ขอเชิญ','หมายเลข','ที่ช่องบริการ','ช่องบริการ','ช่อง','ที่','ห้อง','โต๊ะ','จุด',
                      'ทับ','เปิดเสียงแล้ว','ชำระเงิน','การเงิน','ห้องยา','รับยา','เวชระเบียน','คัดกรอง','ตรวจ'];
const BUNDLED_WORDS = [...PHRASE_WORDS, ...LETTER_WORDS, ...DIGIT_WORDS];

const keyOf = (lang, text) => crypto.createHash('md5').update(lang + '|' + text).digest('hex');

// Google returns MP3 frames, sometimes behind an ID3v2 tag — strip it so clips can be joined
function stripId3(buf) {
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
    return buf.subarray(10 + size);
  }
  return buf;
}

// "ขอเชิญ หมายเลข เอ, ศูนย์, หนึ่ง ที่ช่องบริการ ชำระเงิน ช่อง 1" → words; digits become Thai digit words
function tokenize(text) {
  return String(text).split(/[\s,]+/).filter(Boolean)
    .flatMap(w => /^\d+$/.test(w) ? [...w].map(d => DIGIT_WORDS[+d]) : [w]);
}

function createTts({ appDir, cacheDir }) {
  const clipsDir = path.join(appDir, 'tts-clips');
  fs.mkdirSync(cacheDir, { recursive: true });

  const findFile = (lang, text) => {
    const name = keyOf(lang, text) + '.mp3';
    for (const dir of [cacheDir, clipsDir]) {
      const f = path.join(dir, name);
      if (fs.existsSync(f)) return f;
    }
    return null;
  };

  async function fetchGoogle(lang, text, timeoutMs = 6000) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${encodeURIComponent(lang)}&client=tw-ob`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Referer': 'https://translate.google.com/',
      },
    });
    if (!res.ok) throw new Error('google tts http ' + res.status);
    return Buffer.from(await res.arrayBuffer());
  }

  // Cached → Google (and cache it). Throws when offline and not cached.
  async function getAudio(lang, text) {
    const f = findFile(lang, text);
    if (f) return { buf: fs.readFileSync(f), source: 'cache' };
    const buf = await fetchGoogle(lang, text);
    fs.writeFile(path.join(cacheDir, keyOf(lang, text) + '.mp3'), buf, () => {});
    return { buf, source: 'google' };
  }

  // Offline: join the Google clips of each word. Words without a clip are skipped.
  function composeFromClips(lang, text) {
    const words = tokenize(text);
    const parts = [], missing = [];
    for (const w of words) {
      const f = findFile(lang, w);
      if (f) parts.push(stripId3(fs.readFileSync(f))); else missing.push(w);
    }
    return parts.length ? { buf: Buffer.concat(parts), missing } : null;
  }

  // While online, fetch clips for words we don't have yet (e.g. counter names) so they work offline later
  async function learnWords(lang, texts) {
    const words = [...new Set(texts.flatMap(tokenize))].filter(w => !findFile(lang, w));
    let learned = 0;
    for (const w of words) {
      try {
        const buf = await fetchGoogle(lang, w);
        fs.writeFileSync(path.join(cacheDir, keyOf(lang, w) + '.mp3'), buf);
        learned++;
      } catch { break; } // offline — try again next time
    }
    return learned;
  }

  return { getAudio, composeFromClips, learnWords, fetchGoogle, clipsDir };
}

module.exports = { createTts, BUNDLED_WORDS, keyOf, tokenize, stripId3 };
