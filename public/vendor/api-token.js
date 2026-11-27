// ป้องกันการ copy URL ของ API ไปยิงตรงใน Postman — server ตอบเฉพาะ request ที่มี X-Queue-Token
// สคริปต์นี้แนบ token ให้ทุก fetch() ไปยัง endpoint ที่ป้องกันไว้โดยอัตโนมัติ — หน้าจอทำงานปกติ ไม่ต้องกรอกอะไรเอง
// token ได้จาก /api/client-token ซึ่ง server ให้เฉพาะหน้าเว็บของระบบเอง (same-origin) หรือผู้ที่ login แล้ว
(function () {
  var PROTECTED = [/^\/api\/sys\//, /^\/api\/patient-lookup/, /^\/api\/patient-drugs/, /^\/api\/drug-counts/, /^\/api\/rcpt-status/, /^\/api\/systems/,
                   /^\/api\/server\/restart/, /^\/api\/startup\/set/, /^\/api\/global-config/, /^\/api\/local-print/, /^\/api\/agent\//];
  var nativeFetch = window.fetch.bind(window);
  var authToken = '';
  try { authToken = sessionStorage.getItem('authToken') || ''; } catch (e) {}
  var tokenPromise = nativeFetch('/api/client-token', { headers: authToken ? { 'X-Auth-Token': authToken } : {} })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (d) { return d.token || ''; })
    .catch(function () { return ''; });

  function needsToken(url) {
    try {
      var u = new URL(url, location.origin);
      return u.origin === location.origin && PROTECTED.some(function (re) { return re.test(u.pathname); });
    } catch (e) { return false; }
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!needsToken(url)) return nativeFetch(input, init);
    return tokenPromise.then(function (token) {
      var opts = Object.assign({}, init);
      opts.headers = Object.assign({}, (init && init.headers) || {}, token ? { 'X-Queue-Token': token } : {});
      return nativeFetch(input, opts);
    });
  };

  // Print Agent on this machine — through the queue server (/api/agent/... → <this PC's IP>:3001), because
  // Chrome blocks a LAN page from calling http://localhost directly. If the server can't reach the agent
  // (older agent without the firewall rule), the direct localhost call is tried as before.
  window.agentFetch = function (path, init) {
    return window.fetch('/api/agent' + path, init).then(function (r) {
      // 404 = a queue server older than the relay; 502/504 = the server could not reach this PC's agent
      if (r.status !== 404 && r.status !== 502 && r.status !== 504) return r;
      return nativeFetch('http://localhost:3001' + path, init).catch(function () { return r; });
    }, function (err) {
      if (err && err.name === 'AbortError' || err && err.name === 'TimeoutError') throw err;
      return nativeFetch('http://localhost:3001' + path, init);
    });
  };
})();
