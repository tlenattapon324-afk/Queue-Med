// ป้องกันการ copy URL ของ /api/sys/*, patient-lookup, patient-drugs ไปยิงตรงใน Postman
// สคริปต์นี้แนบ token ให้ทุก fetch() ไปยัง endpoint เหล่านี้โดยอัตโนมัติ — หน้าจอทำงานปกติ ไม่ต้องกรอกอะไรเอง
(function () {
  var PROTECTED = [/^\/api\/sys\//, /^\/api\/patient-lookup/, /^\/api\/patient-drugs/];
  var nativeFetch = window.fetch.bind(window);
  var tokenPromise = nativeFetch('/api/client-token')
    .then(function (r) { return r.json(); })
    .then(function (d) { return d.token || ''; })
    .catch(function () { return ''; });

  function needsToken(url) {
    try {
      var path = new URL(url, location.origin).pathname;
      return PROTECTED.some(function (re) { return re.test(path); });
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
