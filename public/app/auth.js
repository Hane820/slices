/* auth.js — 应用自有认证客户端（只负责网络与错误归一化，不保存 token）
 *
 * Session 只存在于服务端 HttpOnly Cookie；本模块不读、不写、不缓存任何验证码或 token。
 * 所有请求都带 X-Earthonline-Auth（CSRF 自定义头）+ credentials:'include'。
 */
(function(){
  /* 生产走同源 /api/*（站点路由到 Worker）。本地 file:// 打开时回退到开发 Worker。 */
  var DEV_ENDPOINT = 'https://earthonline-backup.1317746169.workers.dev';
  function defaultEndpoint(){
    try {
      if(typeof location !== 'undefined' && /^https?:$/.test(location.protocol) && location.origin) return location.origin;
    } catch(e){}
    return DEV_ENDPOINT;
  }
  var ENDPOINT_KEY = 'earthonline-auth-endpoint';
  var AUTH_HEADER = 'X-Earthonline-Auth';
  var LOGOUT_TIMEOUT_MS = 10000;

  function endpoint(){
    try {
      var v = localStorage.getItem(ENDPOINT_KEY);
      if(v && /^https?:\/\//.test(v)) return v.replace(/\/$/, '');
    } catch(e){}
    return defaultEndpoint();
  }

  function normalize(res, body){
    var error = (body && (body.error || body.message)) || ('http-' + res.status);
    return {
      ok: !!res.ok && (!body || body.ok !== false),
      status: res.status,
      body: body || {},
      error: res.ok ? '' : error
    };
  }

  function call(path, opts){
    opts = opts || {};
    var init = {
      method: opts.method || 'GET',
      credentials: 'include',
      headers: Object.assign({ 'Content-Type':'application/json' }, opts.headers || {})
    };
    init.headers[AUTH_HEADER] = '1';
    if(opts.body !== undefined) init.body = JSON.stringify(opts.body);
    if(opts.signal){
      init.signal = opts.signal;
    }
    return fetch(endpoint() + path, init)
      .then(function(res){
        return res.text().then(function(text){
          var body = null;
          try { body = text ? JSON.parse(text) : null; } catch(e){}
          return normalize(res, body);
        });
      })
      .catch(function(e){
        if(e && e.name === 'AbortError') return { ok:false, status:0, body:{}, error:'offline' };
        return { ok:false, status:0, body:{}, error:'network-error' };
      });
  }

  function requestCode(email){
    return call('/api/auth/code', { method:'POST', body:{ email:email } });
  }
  function verifyCode(email, code){
    return call('/api/auth/verify', { method:'POST', body:{ email:email, code:code } });
  }
  function session(){
    return call('/api/auth/session', { method:'GET' });
  }
  function logout(){
    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = controller ? setTimeout(function(){ controller.abort(); }, LOGOUT_TIMEOUT_MS) : null;
    return call('/api/auth/logout', { method:'POST', signal:controller && controller.signal })
      .then(function(r){
        if(timer) clearTimeout(timer);
        return r;
      });
  }
  function logoutAll(){
    return call('/api/auth/logout-all', { method:'POST' });
  }

  /* 认证失败分类（机器可读错误码优先，绝不只看 HTTP 状态）：
     - session-invalid：仅应用 Session 明确缺失/过期/撤销，才允许自动 demote guest；
     - transient：网络中断 / 超时 / 5xx / 身份服务不可用，保留 user + pending；
     - auth-denied：403 / CSRF / Origin / 权限不足 / Access JWT 拒绝，保留 user；
     - access-blocked：Cloudflare Access 登录页（HTML，无 JSON 码），保留 user；
     - unknown：状态不明，保守保留 user（不伪装退出成功）。
     r 形如 { status, body, error }（来自 OLAuth.call 或 cloud-backup 的 parseResponse）。 */
  function classifyAuthFailure(r){
    var status = r && r.status;
    var body = (r && r.body) || {};
    var code = body.code || '';
    var err = body.error || (r && r.error) || '';
    var reason = body.reason || '';

    /* 1) 网络层 / 服务故障：不得当作会话失效 */
    if(status === 0 || err === 'offline' || err === 'network-error') return 'transient';
    if((typeof status === 'number' && status >= 500) ||
       err === 'auth-unavailable' || err === 'storage-error') return 'transient';

    /* 2) 明确会话失效：服务端机器可读码。兼容旧 Worker 的 reason='no-valid-session'
          （该语义码专指应用 Session 缺失/过期/撤销，不是裸状态码）。 */
    if(code === 'session-invalid' || err === 'no-session') return 'session-invalid';
    if(code !== 'access-denied' && err === 'unauthorized' && reason === 'no-valid-session') return 'session-invalid';

    /* 3) 授权 / CSRF / Access JWT 拒绝：一律保留 user */
    if(status === 403) return 'auth-denied';
    if(code === 'access-denied' || err === 'origin-forbidden' || err === 'csrf-required' ||
       err === 'account-disabled' || err === 'access-denied' ||
       err === 'unauthorized') return 'auth-denied';

    /* 4) 其余（含 HTML 登录页、状态不明）：保守保留 user */
    return 'unknown';
  }

  /* 只有明确会话失效才允许 demote；调用方传入响应时先分类，防止误用。
     只改本机“已确认身份”，不删本地数据，并让备份调度器按 guest 门禁停下。 */
  function markSessionInvalid(result){
    if(result && classifyAuthFailure(result) !== 'session-invalid') return false;
    var changed = false;
    try {
      if(window.OLIdentity && typeof OLIdentity.demoteToGuest === 'function'){
        var r = OLIdentity.demoteToGuest('session-expired');
        changed = !!(r && r.ok);
      }
    } catch(e){}
    if(changed){
      try {
        if(window.OLCloudBackup && typeof OLCloudBackup.syncIdentity === 'function') OLCloudBackup.syncIdentity();
      } catch(e){}
      try { window.dispatchEvent(new CustomEvent('earthonline-auth-invalid')); } catch(e){}
    }
    return changed;
  }

  window.OLAuth = {
    AUTH_HEADER: AUTH_HEADER,
    requestCode: requestCode,
    verifyCode: verifyCode,
    session: session,
    logout: logout,
    logoutAll: logoutAll,
    classifyAuthFailure: classifyAuthFailure,
    markSessionInvalid: markSessionInvalid
  };
})();
