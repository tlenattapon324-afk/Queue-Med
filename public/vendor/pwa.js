// "⬇ ติดตั้งแอป" for the issuing (queue.html) and calling (cashier.html) pages.
// Adds the page's own manifest (it opens straight to this page + room), registers the service worker and puts an
// install button in the top menu. When the browser offers its install prompt the button uses it; otherwise
// (iPhone, or a LAN address over plain http) it shows how to add the page to the home screen on that device.
(function () {
  const page = /cashier\.html/.test(location.pathname) ? 'cashier' : 'queue';
  const sys = new URLSearchParams(location.search).get('sys') || '';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  const head = document.head;
  const add = (tag, attrs) => { const el = document.createElement(tag); Object.assign(el, attrs); head.appendChild(el); return el; };
  add('link', { rel: 'manifest', href: `/manifest.webmanifest?page=${page}${sys ? '&sys=' + encodeURIComponent(sys) : ''}` });
  add('meta', { name: 'theme-color', content: '#1e2a5a' });
  add('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' });
  add('meta', { name: 'mobile-web-app-capable', content: 'yes' });
  add('meta', { name: 'apple-mobile-web-app-title', content: page === 'cashier' ? 'เรียกคิว' : 'ออกคิว' });
  if (!document.querySelector('link[rel="apple-touch-icon"]')) add('link', { rel: 'apple-touch-icon', href: '/app-icon.png' });

  if ('serviceWorker' in navigator && window.isSecureContext)
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});

  const css = document.createElement('style');
  css.textContent = `
    .pwa-btn{display:inline-flex;align-items:center;gap:5px;height:32px;padding:0 12px;border-radius:10px;border:1.5px solid #f97316;background:#fff;
      color:#c2410c;font:inherit;font-size:.8rem;font-weight:700;cursor:pointer;white-space:nowrap;margin-left:6px}
    .pwa-btn:hover{background:#f97316;color:#fff}
    .pwa-ov{position:fixed;inset:0;z-index:9999;background:rgba(27,37,69,.55);display:none;align-items:center;justify-content:center;padding:14px}
    .pwa-ov.show{display:flex}
    .pwa-box{background:#fff;color:#1b2545;border-radius:20px;max-width:520px;width:100%;max-height:92vh;overflow:auto;padding:20px 22px;
      font-family:'Sarabun','Prompt','Segoe UI',sans-serif;box-shadow:0 30px 70px -20px rgba(0,0,0,.5)}
    .pwa-box h3{display:flex;align-items:center;gap:10px;font-size:1.2rem;margin:0 0 4px}
    .pwa-box h3 img{width:40px;height:40px;border-radius:10px}
    .pwa-sub{color:#65708c;font-size:.92rem;margin-bottom:12px}
    .pwa-step{border:1px solid #e2e6f0;border-radius:14px;padding:10px 14px;margin-bottom:8px}
    .pwa-step.me{border-color:#f97316;background:#fff7ed}
    .pwa-step > b{display:block;margin-bottom:2px}
    .pwa-step span b{display:inline}
    .pwa-step span{color:#3b4456;font-size:.92rem;line-height:1.55}
    .pwa-warn{background:#fee2e2;color:#991b1b;border-radius:12px;padding:10px 14px;font-size:.92rem;line-height:1.5;margin-bottom:10px}
    .pwa-ios{margin:0 0 6px;padding:0;list-style:none;counter-reset:s}
    .pwa-ios li{counter-increment:s;position:relative;padding:10px 12px 10px 48px;border:1.5px solid #fdba74;background:#fff7ed;border-radius:14px;margin-bottom:8px;line-height:1.55;font-size:1rem}
    .pwa-ios li::before{content:counter(s);position:absolute;left:12px;top:10px;width:26px;height:26px;border-radius:50%;background:#f97316;color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center}
    .pwa-ios small{color:#65708c}
    .pwa-share{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:1.5px solid #1d4ed8;color:#1d4ed8;border-radius:7px;font-size:.9rem;vertical-align:middle}
    .pwa-note{background:#fff6dc;color:#8a5a00;border-radius:12px;padding:10px 14px;font-size:.86rem;line-height:1.55;margin:10px 0}
    .pwa-row{display:flex;gap:8px;margin-top:12px}
    .pwa-row button{flex:1;border:none;border-radius:12px;padding:11px;font:inherit;font-weight:700;cursor:pointer}
    .pwa-copy{background:#eef0ff;color:#3730a3}
    .pwa-close{background:#1e2a5a;color:#fff}`;
  head.appendChild(css);

  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; });
  window.addEventListener('appinstalled', () => { deferred = null; const b = document.getElementById('pwaBtn'); if (b) b.remove(); });

  function guide() {
    const ua = navigator.userAgent, ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
    const android = /Android/i.test(ua), mobile = ios || android;
    const appName = page === 'cashier' ? 'เรียกคิว' : 'ออกคิว';
    let ov = document.getElementById('pwaOv');
    if (!ov) { ov = document.createElement('div'); ov.className = 'pwa-ov'; ov.id = 'pwaOv'; document.body.appendChild(ov);
      ov.addEventListener('click', e => { if (e.target === ov) ov.classList.remove('show'); }); }
    const step = (me, title, text) => `<div class="pwa-step${me ? ' me' : ''}"><b>${title}</b><span>${text}</span></div>`;
    // iPhone / iPad: a page cannot install itself — the steps for this browser only, numbered, with where its share button is
    const iosBrowser = /CriOS/.test(ua) ? 'Chrome' : /EdgiOS/.test(ua) ? 'Edge' : /FxiOS/.test(ua) ? 'Firefox' : 'Safari';
    const shareAt = iosBrowser === 'Safari' ? 'แถบเครื่องมือ<b>ด้านล่าง</b> (ตรงกลาง)' : '<b>มุมขวาของช่องที่อยู่ด้านบน</b> (ข้างชื่อเว็บ)';
    const iosSteps = `<ol class="pwa-ios">
        <li>กด <b>ปิด</b> ที่ท้ายหน้าต่างนี้</li>
        <li>แตะ<b>ไอคอนแชร์</b> <span class="pwa-share">⬆</span> (สี่เหลี่ยมมีลูกศรชี้ขึ้น) ที่ ${shareAt}</li>
        <li>เลื่อนลงแล้วแตะ <b>"เพิ่มไปยังหน้าจอโฮม"</b> (Add to Home Screen)<br><small>ไม่เห็นเมนูนี้? แตะ "แก้ไขการทำงาน" ท้ายรายการ หรือคัดลอกลิงก์ไปเปิดใน Safari</small></li>
        <li>ตั้งชื่อ แล้วแตะ <b>เพิ่ม</b> — ไอคอนจะขึ้นบนหน้าจอโฮม</li>
      </ol>`;
    ov.innerHTML = `<div class="pwa-box">
      <h3><img src="/app-icon.png" alt="">ติดตั้ง "${appName}" ลงเครื่อง</h3>
      <div class="pwa-sub">เปิดจากไอคอนบนหน้าจอได้เลย — เข้าหน้านี้ของห้องนี้ทันที ไม่ต้องพิมพ์ที่อยู่</div>
      ${ios ? `<div class="pwa-warn">หน้านี้เป็น<b>วิธีทำ</b> — iPhone ไม่ให้หน้าเว็บติดตั้งเอง ต้องทำจากเมนูของเบราว์เซอร์ (${iosBrowser})</div>${iosSteps}` : `
      ${step(android, '📱 Android (Chrome)', 'แตะ <b>⋮</b> มุมขวาบน → <b>"ติดตั้งแอป"</b> หรือ <b>"เพิ่มลงในหน้าจอหลัก"</b> → ยืนยัน')}
      ${step(false, '🍎 iPhone / iPad', 'แตะปุ่ม <b>แชร์ ⬆</b> ของเบราว์เซอร์ → <b>"เพิ่มไปยังหน้าจอโฮม"</b> → <b>เพิ่ม</b>')}
      ${step(!mobile, '💻 คอมพิวเตอร์ (Chrome / Edge)', 'คลิกไอคอน <b>⊕ ติดตั้ง</b> ท้ายช่องที่อยู่ หรือ <b>⋮ / …</b> → <b>"ติดตั้งแอป"</b> / <b>"Apps → Install this site as an app"</b>')}`}
      ${window.isSecureContext ? '' : `<div class="pwa-note">ℹ เครื่องนี้เปิดผ่าน <b>${location.host}</b> แบบ http — Android / iPhone จะเพิ่มเป็น<b>ทางลัดบนหน้าจอหลัก</b>
        (กดแล้วเปิดหน้านี้ทันที) · ถ้าต้องการให้เปิดเป็นหน้าต่างแอปแยกเต็มรูปแบบ ต้องเปิดระบบคิวผ่าน https</div>`}
      <div class="pwa-row"><button class="pwa-copy" id="pwaCopy">🔗 คัดลอกลิงก์หน้านี้</button><button class="pwa-close" id="pwaClose">ปิด</button></div>
    </div>`;
    ov.querySelector('#pwaClose').onclick = () => ov.classList.remove('show');
    ov.querySelector('#pwaCopy').onclick = async e => {
      const t = location.href;
      try { await navigator.clipboard.writeText(t); } catch (er) { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
      e.target.textContent = '✓ คัดลอกแล้ว';
    };
    ov.classList.add('show');
  }

  function addButton() {
    if (standalone || document.getElementById('pwaBtn')) return;   // already running as the installed app
    const nav = document.querySelector('nav');
    if (!nav) return;
    const b = document.createElement('button');
    b.id = 'pwaBtn'; b.type = 'button'; b.className = 'pwa-btn';
    b.title = 'ติดตั้งหน้านี้เป็นแอปบนเครื่อง / มือถือ';
    b.textContent = '⬇ ติดตั้งแอป';
    b.onclick = async () => {
      if (deferred) {
        deferred.prompt();
        const r = await deferred.userChoice.catch(() => null);
        if (r && r.outcome === 'accepted') b.remove();
        deferred = null;
      } else guide();
    };
    const before = nav.querySelector('.btn-logout');
    before ? nav.insertBefore(b, before) : nav.appendChild(b);
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', addButton) : addButton();
})();
