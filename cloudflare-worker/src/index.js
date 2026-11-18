/* 地球online — Cloudflare 云端备份 Worker（Task：云端备份后端）
 *
 * 职责边界：
 *   - 本地 IndexedDB 仍是唯一业务数据源；这里只托管「完整业务备份 JSON」。
 *   - 备份存私有 R2 桶（单对象 latest），不做多设备同步、不用 D1。
 *   - 身份认证用 Cloudflare Access JWT：真实密码学验签（JWKS + WebCrypto），
 *     绝不只解码 payload 就放行。
 *   - 不记录备份正文与认证凭据；日志只有方法 / 路径 / 状态码 / 字节数。
 *
 * API（全部要求 Access JWT）：
 *   GET  /api/backup/status  查询云端是否已有备份（不返回内容）
 *   PUT  /api/backup         上传完整业务备份（覆盖 latest）
 *   GET  /api/backup         下载完整业务备份
 *
 * 环境变量 / 绑定（wrangler.toml [vars]）：
 *   APP_ORIGIN       地球online站点来源，CORS 唯一白名单（如 https://liyuk.github.io）
 *   ACCESS_TEAM      Cloudflare Access 团队域（如 xxx.cloudflareaccess.com）
 *   AUD_TAG          Access 应用的 AUD（JWT aud 必须匹配）
 *   JWKS_URL         可选：JWKS 地址覆盖（本地测试用；默认按团队域拼接官方地址）
 *   MAX_BACKUP_BYTES 可选：备份大小上限（默认 20MB）
 *   BACKUP_BUCKET    R2 桶绑定（私有，不配置任何公开访问）
 */

const APP_NAME = 'earthonline';
const SUPPORTED_VERSION = 4;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const BACKUP_KEY = 'earthonline/backup-latest.json';
const JWKS_TTL_MS = 10 * 60 * 1000;
const EXP_LEEWAY_SEC = 60;

/* JWKS 进程内缓存（到期或 kid 未命中时重新拉取一次） */
let jwksCache = null;

function maxBytes(env) {
  var n = parseInt(env && env.MAX_BACKUP_BYTES, 10);
  return (Number.isFinite(n) && n > 0) ? n : DEFAULT_MAX_BYTES;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/* ==================== 日志（只记元信息，绝不记正文 / 凭据） ==================== */
function logLine(request, status, extra) {
  var url = new URL(request.url);
  var extraSafe = extra && typeof extra === 'string' ? extra : '';
  console.log('[backup] ' + request.method + ' ' + url.pathname + ' -> ' + status + extraSafe);
}

/* ==================== 响应辅助 ==================== */
function corsHeaders(env, origin) {
  if (!origin || !isAllowedOrigin(env, origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',  /* Access 会话 cookie 跨站 fetch 需要 */
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Cf-Access-Jwt-Assertion',
    'Access-Control-Max-Age': '86400'
  };
}

function isAllowedOrigin(env, origin) {
  return typeof env.APP_ORIGIN === 'string' && env.APP_ORIGIN.length > 0 && origin === env.APP_ORIGIN;
}

function jsonResp(env, request, body, status, extraHeaders) {
  var origin = request.headers.get('Origin') || '';
  var headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, extraHeaders || {});
  var cors = corsHeaders(env, origin);
  if (cors) Object.assign(headers, cors);
  logLine(request, status, body && body.stored ? (' (' + body.stored.size + 'B)') : '');
  return new Response(JSON.stringify(body), { status: status, headers: headers });
}

/* ==================== Base64URL / JWT ==================== */
function b64urlToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  var bin = atob(s);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s) {
  try { return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))); }
  catch (e) { return null; }
}

function extractToken(request) {
  var h = request.headers.get('Cf-Access-Jwt-Assertion');
  if (h && h.trim()) return h.trim();
  var cookie = request.headers.get('Cookie') || '';
  var m = /(?:^|;\s*)CF_Authorization=([^;\s]+)/.exec(cookie);
  return m ? m[1] : null;
}

async function loadJwks(env, force) {
  var now = Date.now();
  if (!force && jwksCache && (now - jwksCache.fetchedAt) < JWKS_TTL_MS) return jwksCache.keys;
  var url = env.JWKS_URL || ('https://' + env.ACCESS_TEAM + '/cdn-cgi/access/certs');
  var res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('jwks-fetch-failed:' + res.status);
  var data = await res.json();
  if (!isPlainObject(data) || !Array.isArray(data.keys) || !data.keys.length) {
    throw new Error('jwks-invalid');
  }
  jwksCache = { keys: data.keys, fetchedAt: now };
  return jwksCache.keys;
}

/* 真实验签：JWKS 公钥 + WebCrypto verify + iss/aud/exp 全部校验。
   返回 { ok:true, payload } 或 { ok:false, reason, serverSide? }。 */
async function verifyAccessJwt(token, env) {
  var parts = String(token).split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'token-malformed' };
  }
  var header = b64urlJson(parts[0]);
  var payload = b64urlJson(parts[1]);
  if (!isPlainObject(header) || !isPlainObject(payload)) {
    return { ok: false, reason: 'token-malformed' };
  }
  if (header.alg !== 'ES256' && header.alg !== 'RS256') {
    return { ok: false, reason: 'alg-unsupported' };
  }
  var nowSec = Date.now() / 1000;
  if (typeof payload.exp !== 'number' || payload.exp < nowSec - EXP_LEEWAY_SEC) {
    return { ok: false, reason: 'token-expired' };
  }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec + EXP_LEEWAY_SEC) {
    return { ok: false, reason: 'token-not-yet-valid' };
  }
  /* Cloudflare Access 官方 iss 为 https://<团队域>.cloudflareaccess.com（无尾斜杠），
     但部分版本/测试令牌带尾斜杠。只在这里做规范化，两边都接受；域名本身必须完全相等。 */
  function normIss(s) { return typeof s === 'string' ? s.replace(/\/+$/, '') : ''; }
  var iss = 'https://' + String(env.ACCESS_TEAM || '').replace(/\/+$/, '');
  if (!env.ACCESS_TEAM || normIss(payload.iss) !== iss) return { ok: false, reason: 'iss-mismatch' };
  var audOk = Array.isArray(payload.aud)
    ? payload.aud.indexOf(env.AUD_TAG) >= 0
    : payload.aud === env.AUD_TAG;
  if (!env.AUD_TAG || !audOk) return { ok: false, reason: 'aud-mismatch' };

  var keys = await loadJwks(env, false);
  var jwk = null;
  for (var i = 0; i < keys.length; i++) if (keys[i].kid === header.kid) { jwk = keys[i]; break; }
  if (!jwk) {
    keys = await loadJwks(env, true);       /* kid 未命中：强刷一次 JWKS */
    for (var j = 0; j < keys.length; j++) if (keys[j].kid === header.kid) { jwk = keys[j]; break; }
  }
  if (!jwk) return { ok: false, reason: 'kid-unknown' };

  var keyData = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  var sig = b64urlToBytes(parts[2]);
  var okSig = false;
  try {
    if (header.alg === 'ES256') {
      var key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      okSig = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, keyData);
    } else {
      var rkey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      okSig = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', rkey, sig, keyData);
    }
  } catch (e) {
    okSig = false;
  }
  if (!okSig) return { ok: false, reason: 'signature-invalid' };
  return { ok: true, payload: payload };
}

/* ==================== 备份信封校验 ==================== */
function validateBackupEnvelope(obj) {
  if (obj.app !== APP_NAME) return 'bad-app';
  if (obj.version !== SUPPORTED_VERSION) return 'bad-version';
  if (!isPlainObject(obj.data)) return 'bad-data';
  if ('exportedAt' in obj && typeof obj.exportedAt !== 'string') return 'bad-exported-at';
  return null;
}

function requireBucket(env) {
  if (!env.BACKUP_BUCKET || typeof env.BACKUP_BUCKET.put !== 'function') {
    throw new Error('bucket-not-bound');
  }
  return env.BACKUP_BUCKET;
}

/* ==================== 路由处理 ==================== */
async function handleStatus(request, env, origin) {
  var head;
  try {
    var bucket = requireBucket(env);
    head = await bucket.head(BACKUP_KEY);
  } catch (e) {
    return jsonResp(env, request, { ok: false, error: 'storage-error', message: 'R2 查询失败，状态未知' }, 500, null, origin);
  }
  if (!head) {
    return jsonResp(env, request, { ok: true, hasBackup: false }, 200, null, origin);
  }
  var meta = (head.customMetadata || {});
  return jsonResp(env, request, {
    ok: true,
    hasBackup: true,
    key: BACKUP_KEY,
    size: head.size,
    uploadedAt: meta.uploadedAt || (head.uploaded ? new Date(head.uploaded).toISOString() : null),
    version: meta.version ? parseInt(meta.version, 10) : null,
    exportedAt: meta.exportedAt || null
  }, 200, null, origin);
}

async function handlePut(request, env, origin) {
  var ct = request.headers.get('Content-Type') || '';
  if (ct.indexOf('application/json') < 0) {
    return jsonResp(env, request, { ok: false, error: 'bad-content-type', message: 'Content-Type 必须是 application/json' }, 415, null, origin);
  }
  var MAX = maxBytes(env);
  var cl = parseInt(request.headers.get('Content-Length') || '', 10);
  if (Number.isFinite(cl) && cl > MAX) {
    return jsonResp(env, request, { ok: false, error: 'too-large', message: '备份超过大小上限' }, 413, null, origin);
  }
  var text;
  try { text = await request.text(); }
  catch (e) {
    return jsonResp(env, request, { ok: false, error: 'bad-body', message: '请求体读取失败' }, 400, null, origin);
  }
  var bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX) {
    return jsonResp(env, request, { ok: false, error: 'too-large', message: '备份超过大小上限' }, 413, null, origin);
  }
  var obj;
  try { obj = JSON.parse(text); }
  catch (e) {
    return jsonResp(env, request, { ok: false, error: 'bad-json', message: '不是合法 JSON' }, 400, null, origin);
  }
  var bad = validateBackupEnvelope(obj);
  if (bad) {
    return jsonResp(env, request, { ok: false, error: bad, message: '备份格式或版本不对，已拒绝' }, 400, null, origin);
  }
  var uploadedAt = new Date().toISOString();
  var putResult;
  try {
    var bucket = requireBucket(env);
    putResult = await bucket.put(BACKUP_KEY, text, {
      customMetadata: {
        app: APP_NAME,
        version: String(SUPPORTED_VERSION),
        exportedAt: (typeof obj.exportedAt === 'string' ? obj.exportedAt : ''),
        uploadedAt: uploadedAt,
        size: String(bytes)
      }
    });
  } catch (e) {
    /* R2 故障：明确失败，绝不假报成功 */
    return jsonResp(env, request, { ok: false, error: 'storage-error', message: 'R2 写入失败，云端仍是上一次的备份' }, 502, null, origin);
  }
  if (!putResult || !putResult.uploaded) {
    return jsonResp(env, request, { ok: false, error: 'storage-error', message: 'R2 写入结果未确认，视为失败' }, 502, null, origin);
  }
  return jsonResp(env, request, {
    ok: true,
    stored: { key: BACKUP_KEY, size: bytes, uploadedAt: uploadedAt }
  }, 200, null, origin);
}

async function handleGet(request, env, origin) {
  var obj;
  try {
    var bucket = requireBucket(env);
    obj = await bucket.get(BACKUP_KEY);
  } catch (e) {
    return jsonResp(env, request, { ok: false, error: 'storage-error', message: 'R2 读取失败' }, 500, null, origin);
  }
  if (!obj) {
    return jsonResp(env, request, { ok: false, error: 'no-backup', message: '云端还没有备份' }, 404, null, origin);
  }
  var meta = (obj.customMetadata || {});
  var day = (meta.uploadedAt || (obj.uploaded ? new Date(obj.uploaded).toISOString() : new Date().toISOString())).slice(0, 10);
  logLine(request, 200, ' (' + (obj.size || 0) + 'B)');
  var headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': 'attachment; filename="earthonline-backup-' + day + '.json"',
    'Cache-Control': 'no-store',
    'ETag': obj.httpEtag || ''
  };
  /* 下载也必须带 CORS 头：浏览器端前端跨源 fetch 下载时同样要做 CORS 检查，
     否则即使认证和 R2 读取成功，响应也会被浏览器拦掉（与 PUT/status 保持一致）。 */
  var cors = corsHeaders(env, origin);
  if (cors) Object.assign(headers, cors);
  return new Response(obj.body, { status: 200, headers: headers });
}

/* ==================== 入口 ==================== */
async function handleRequest(request, env) {
  var url = new URL(request.url);
  var origin = request.headers.get('Origin') || '';
  var originAllowed = isAllowedOrigin(env, origin);

  if (request.method === 'OPTIONS') {
    if (!originAllowed) {
      return jsonResp(env, request, { ok: false, error: 'origin-forbidden', message: '来源不在允许列表' }, 403, null, origin);
    }
    logLine(request, 204);
    return new Response(null, { status: 204, headers: corsHeaders(env, origin) });
  }

  if (url.pathname !== '/api/backup' && url.pathname !== '/api/backup/status') {
    return jsonResp(env, request, { ok: false, error: 'not-found' }, 404, null, origin);
  }
  /* CORS 是浏览器侧约束：带了 Origin 就必须匹配站点来源 */
  if (origin && !originAllowed) {
    return jsonResp(env, request, { ok: false, error: 'origin-forbidden', message: '来源不在允许列表' }, 403, null, origin);
  }

  var token = extractToken(request);
  if (!token) {
    return jsonResp(env, request, { ok: false, error: 'unauthorized', reason: 'no-token' }, 401, null, origin);
  }
  var auth;
  try { auth = await verifyAccessJwt(token, env); }
  catch (e) {
    /* JWKS 拉取失败等服务侧问题：502，不当作未登录 */
    return jsonResp(env, request, { ok: false, error: 'auth-unavailable', message: '身份服务暂不可用，请重试' }, 502, null, origin);
  }
  if (!auth || !auth.ok) {
    return jsonResp(env, request, { ok: false, error: 'unauthorized', reason: (auth && auth.reason) || 'invalid' }, 401, null, origin);
  }

  if (url.pathname === '/api/backup/status') {
    if (request.method !== 'GET') {
      return jsonResp(env, request, { ok: false, error: 'method-not-allowed' }, 405, { 'Allow': 'GET' }, origin);
    }
    return handleStatus(request, env, origin);
  }
  if (url.pathname === '/api/backup') {
    if (request.method === 'PUT') return handlePut(request, env, origin);
    if (request.method === 'GET') return handleGet(request, env, origin);
    return jsonResp(env, request, { ok: false, error: 'method-not-allowed' }, 405, { 'Allow': 'GET, PUT' }, origin);
  }
  return jsonResp(env, request, { ok: false, error: 'not-found' }, 404, null, origin);
}

export default {
  fetch: function (request, env, ctx) {
    return handleRequest(request, env, ctx).catch(function (e) {
      /* 兜底：任何未预期异常都必须失败可见，不假报成功 */
      try { logLine(request, 500, ' (unhandled)'); } catch (e2) {}
      return jsonResp(env, request, { ok: false, error: 'internal-error' }, 500, null,
        request.headers.get('Origin') || '');
    });
  }
};
