// ป้องกันการ copy URL ของ API ไปยิงตรงใน Postman — server ตอบเฉพาะ request ที่มี X-Queue-Token
// สคริปต์นี้แนบ token ให้ทุก fetch() ไปยัง endpoint ที่ป้องกันไว้โดยอัตโนมัติ — หน้าจอทำงานปกติ ไม่ต้องกรอกอะไรเอง
// token ได้จาก /api/client-token ซึ่ง server ให้เฉพาะหน้าเว็บของระบบเอง (same-origin) หรือผู้ที่ login แล้ว
(function () {
  var PROTECTED = [/^\/api\/sys\//, /^\/api\/patient-lookup/, /^\/api\/patient-drugs/, /^\/api\/drug-counts/, /^\/api\/rcpt-status/, /^\/api\/systems/,
                   /^\/api\/server\/restart/, /^\/api\/startup\/set/, /^\/api\/global-config/, /^\/api\/local-print/];
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
})();
