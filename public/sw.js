// Service worker for "ติดตั้งแอป" (PWA). The queue pages are live, so nothing is served from cache while the
// server can be reached — every request goes to the network. Only when the server is unreachable does a page
// navigation get a small "offline" page instead of the browser's error screen.
const OFFLINE = 'queue-offline-v1';
const OFFLINE_HTML = `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ระบบคิว — ออฟไลน์</title><style>body{font-family:'Sarabun','Segoe UI',sans-serif;background:#f2f4fa;color:#1b2545;display:flex;min-height:100vh;
align-items:center;justify-content:center;margin:0;text-align:center;padding:20px}.b{background:#fff;border-radius:18px;padding:28px 24px;max-width:420px;
box-shadow:0 8px 24px -12px rgba(27,37,69,.3)}h1{font-size:1.3rem;margin:10px 0}p{color:#65708c;line-height:1.6}button{margin-top:14px;border:none;
background:#f97316;color:#fff;font:inherit;font-weight:700;border-radius:12px;padding:12px 22px;cursor:pointer}</style></head><body><div class="b">
<div style="font-size:2.6rem">📡</div><h1>เชื่อมต่อเซิร์ฟเวอร์คิวไม่ได้</h1><p>ตรวจสอบว่าเครื่องนี้ต่อเครือข่ายของโรงพยาบาลอยู่<br>และเซิร์ฟเวอร์ระบบคิวเปิดอยู่</p>
<button onclick="location.reload()">⟳ ลองอีกครั้ง</button></div></body></html>`;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(OFFLINE).then(c => c.put('/__offline', new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== OFFLINE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;   // API calls, sockets, scripts: straight to the network, untouched
  e.respondWith(fetch(e.request).catch(() => caches.match('/__offline')));
});
