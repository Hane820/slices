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
/* v2 与 v1 完全隔离：pointer / immutable object 使用独立 key，不触碰 legacy latest。 */
const V2_PROTOCOL = 2;
const V2_PROTOCOL_HEADER = 'X-Earthonline-Protocol';
const V2_POINTER_KEY = 'earthonline/backups/v2/pointer.json';
const V2_OBJECT_PREFIX = 'earthonline/backups/';
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
    'Access-Control-Allow-Headers': 'Content-Type, Cf-Access-Jwt-Assertion, X-Earthonline-Protocol',
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
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function b64urlEncode(u8) {
  var out = '';
  var i = 0;
  while (i < u8.length) {
    var rem = u8.length - i;
    var a = u8[i++];
    var b = rem > 1 ? u8[i++] : 0;
    var c = rem > 2 ? u8[i++] : 0;
    var n = ((a << 16) | (b << 8) | c) >>> 0;
    out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63];
    out += rem > 1 ? B64URL[(n >>> 6) & 63] : '=';
    out += rem > 2 ? B64URL[n & 63] : '=';
  }
  return out.replace(/=+$/, '');
}

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

/* ==================== v2 协议校验与规范化 ====================
 * 与 public/app/backup-v2-core.js 保持同一套字段、键序和 hash 定义。
 * 这里不读写业务库，也不复用客户端状态。 */
const V2_IMMUTABLE_KEYS = [
  'protocolVersion', 'attemptId', 'writeId', 'clientId', 'clientRevision',
  'baseRev', 'objectKey', 'payloadHash', 'payloadBytes', 'createdAt',
  'identity', 'immutableHash'
];
const V2_IDENTITY_KEYS = ['conflictEpoch', 'blockEpoch', 'expectedConflictState'];
const V2_EXPECTED_KEYS = ['mode', 'id'];
const V2_POINTER_KEYS = [
  'protocolVersion', 'revision', 'writeId', 'objectKey', 'payloadHash',
  'payloadBytes', 'immutableHash', 'clientId', 'clientRevision', 'baseRev',
  'createdAt'
];

function assertExactKeys(obj, keys, label) {
  for (var k of Object.keys(obj)) if (keys.indexOf(k) < 0) throw new Error(label + '-extra-key');
  for (var key of keys) if (!Object.prototype.hasOwnProperty.call(obj, key)) throw new Error(label + '-missing-key');
}

function v2ObjectKeyOf(writeId) {
  if (typeof writeId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(writeId)) throw new Error('write-id-invalid');
  return V2_OBJECT_PREFIX + writeId + '.json';
}

function parseV2Immutable(im, requireHash) {
  if (!isPlainObject(im)) throw new Error('immutable-shape-invalid');
  assertExactKeys(im, V2_IMMUTABLE_KEYS, 'immutable');
  if (im.protocolVersion !== V2_PROTOCOL) throw new Error('immutable-protocol-invalid');
  if (typeof im.writeId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(im.writeId)) throw new Error('immutable-write-id-invalid');
  if (im.attemptId !== im.writeId) throw new Error('attempt-id-mismatch');
  if (typeof im.clientId !== 'string' || !im.clientId) throw new Error('immutable-client-id-invalid');
  if (!Number.isInteger(im.clientRevision) || im.clientRevision < 0) throw new Error('immutable-client-revision-invalid');
  if (!Number.isInteger(im.baseRev) || im.baseRev < 0) throw new Error('immutable-base-rev-invalid');
  if (im.objectKey !== v2ObjectKeyOf(im.writeId)) throw new Error('immutable-object-key-invalid');
  if (typeof im.payloadHash !== 'string' || im.payloadHash.indexOf('sha256-') !== 0) throw new Error('immutable-payload-hash-invalid');
  if (!Number.isInteger(im.payloadBytes) || im.payloadBytes < 0) throw new Error('immutable-payload-bytes-invalid');
  if (!Number.isInteger(im.createdAt)) throw new Error('immutable-created-at-invalid');

  var id = im.identity;
  if (!isPlainObject(id)) throw new Error('immutable-identity-invalid');
  assertExactKeys(id, V2_IDENTITY_KEYS, 'identity');
  if (!Number.isInteger(id.conflictEpoch) || id.conflictEpoch < 0) throw new Error('immutable-identity-invalid');
  if (!Number.isInteger(id.blockEpoch) || id.blockEpoch < 0) throw new Error('immutable-identity-invalid');
  var e = id.expectedConflictState;
  if (!isPlainObject(e)) throw new Error('expected-conflict-state-invalid');
  assertExactKeys(e, V2_EXPECTED_KEYS, 'expected-conflict-state');
  if (e.mode !== 'none' && e.mode !== 'present') throw new Error('expected-conflict-state-invalid');
  if (e.mode === 'present') {
    if (typeof e.id !== 'string' || !e.id) throw new Error('expected-conflict-id-invalid');
  } else if (e.id !== null) {
    throw new Error('expected-conflict-id-invalid');
  }
  if (requireHash && (typeof im.immutableHash !== 'string' || im.immutableHash.indexOf('sha256-') !== 0)) {
    throw new Error('immutable-hash-invalid');
  }
  return im;
}

function canonicalV2Immutable(im) {
  parseV2Immutable(im, false);
  var e = im.identity.expectedConflictState;
  return JSON.stringify({
    protocolVersion: im.protocolVersion,
    attemptId: im.attemptId,
    writeId: im.writeId,
    clientId: im.clientId,
    clientRevision: im.clientRevision,
    baseRev: im.baseRev,
    objectKey: im.objectKey,
    payloadHash: im.payloadHash,
    payloadBytes: im.payloadBytes,
    createdAt: im.createdAt,
    identity: {
      conflictEpoch: im.identity.conflictEpoch,
      blockEpoch: im.identity.blockEpoch,
      expectedConflictState: { mode: e.mode, id: e.mode === 'present' ? e.id : null }
    }
  });
}

async function sha256Tag(u8) {
  var buf = await crypto.subtle.digest('SHA-256', u8);
  return 'sha256-' + b64urlEncode(new Uint8Array(buf));
}

async function immutableHashOf(im) {
  return sha256Tag(new TextEncoder().encode(canonicalV2Immutable(im)));
}

function parseV2Pointer(p) {
  if (!isPlainObject(p)) throw new Error('pointer-shape-invalid');
  assertExactKeys(p, V2_POINTER_KEYS, 'pointer');
  if (p.protocolVersion !== V2_PROTOCOL) throw new Error('pointer-protocol-invalid');
  if (!Number.isInteger(p.revision) || p.revision < 1) throw new Error('pointer-revision-invalid');
  if (typeof p.writeId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(p.writeId)) throw new Error('pointer-write-id-invalid');
  if (p.objectKey !== v2ObjectKeyOf(p.writeId)) throw new Error('pointer-object-key-invalid');
  if (typeof p.payloadHash !== 'string' || p.payloadHash.indexOf('sha256-') !== 0) throw new Error('pointer-payload-hash-invalid');
  if (!Number.isInteger(p.payloadBytes) || p.payloadBytes < 0) throw new Error('pointer-payload-bytes-invalid');
  if (typeof p.immutableHash !== 'string' || p.immutableHash.indexOf('sha256-') !== 0) throw new Error('pointer-immutable-hash-invalid');
  if (typeof p.clientId !== 'string' || !p.clientId) throw new Error('pointer-client-id-invalid');
  if (!Number.isInteger(p.clientRevision) || p.clientRevision < 0) throw new Error('pointer-client-revision-invalid');
  if (!Number.isInteger(p.baseRev) || p.baseRev < 0) throw new Error('pointer-base-rev-invalid');
  if (!Number.isInteger(p.createdAt)) throw new Error('pointer-created-at-invalid');
  return p;
}

function canonicalV2Pointer(p) {
  parseV2Pointer(p);
  return JSON.stringify({
    protocolVersion: p.protocolVersion,
    revision: p.revision,
    writeId: p.writeId,
    objectKey: p.objectKey,
    payloadHash: p.payloadHash,
    payloadBytes: p.payloadBytes,
    immutableHash: p.immutableHash,
    clientId: p.clientId,
    clientRevision: p.clientRevision,
    baseRev: p.baseRev,
    createdAt: p.createdAt
  });
}

function pointerMatchesImmutable(p, im) {
  return p.writeId === im.writeId && p.objectKey === im.objectKey &&
    p.payloadHash === im.payloadHash && p.payloadBytes === im.payloadBytes &&
    p.immutableHash === im.immutableHash && p.clientId === im.clientId &&
    p.clientRevision === im.clientRevision && p.baseRev === im.baseRev &&
    p.createdAt === im.createdAt;
}

function isPreconditionFailure(e) {
  if (!e) return false;
  if (e.name === 'R2PreconditionError' || e.code === 'precondition-failed') return true;
  return /precondition|conditional|if-match|if-none-match/i.test(String(e.message || ''));
}

function requireBucket(env) {
  if (!env.BACKUP_BUCKET || typeof env.BACKUP_BUCKET.put !== 'function') {
    throw new Error('bucket-not-bound');
  }
  return env.BACKUP_BUCKET;
}

async function readR2Object(obj) {
  if (!obj) return null;
  if (typeof obj.text === 'function') return obj.text();
  if (typeof obj.body === 'string') return obj.body;
  if (obj.body && typeof obj.body.arrayBuffer === 'function') {
    return new TextDecoder().decode(await obj.body.arrayBuffer());
  }
  return null;
}

/* ETag 统一契约（status / 对象写入 / pointer 写入 / 客户端回传 expected.etag 完全一致）：
 *   - 只接受强 quoted entity-tag；R2 的 httpEtag/etag 不会是弱 ETag，
 *     若遇到 W/ 前缀一律视为不可用（fail closed），绝不把弱 ETag 当强 ETag 使用；
 *   - 优先 httpEtag；httpEtag 存在但格式非法时 fail closed，不静默回退；
 *   - 仅当没有 httpEtag 时才使用 R2 的 etag（不带引号）并补引号。 */
function isStrongQuotedEtag(s) {
  return typeof s === 'string' && /^"[^"]*"$/.test(s);
}

function etagOf(obj) {
  if (!obj) return null;
  var http = obj.httpEtag;
  if (typeof http === 'string' && http.length > 0) {
    return isStrongQuotedEtag(http) ? http : null;
  }
  var raw = obj.etag;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (isStrongQuotedEtag(raw)) return raw;
  /* 弱 ETag（W/ + quoted 或裸 W/ 值）不可用于 If-Match 强比较，直接判为不可用。 */
  if (/^W\//.test(raw)) return null;
  if (/[\s"]/.test(raw)) return null;
  return '"' + raw + '"';
}

/* Workers R2 onlyIf 只接受 R2Conditional 字段或 Headers。
 * 这里统一使用 Headers 形式，避免 unsupported field 被运行时忽略成无条件写。 */
function v2CreateOnlyIf() {
  return new Headers({ 'If-None-Match': '*' });
}

function v2MatchOnlyIf(quotedEtag) {
  if (!isStrongQuotedEtag(quotedEtag)) throw new Error('etag-format-invalid');
  return new Headers({ 'If-Match': quotedEtag });
}

function v2Fail(env, request, origin, status, error, message, extra) {
  return jsonResp(env, request, Object.assign({ ok: false, error: error, message: message || error }, extra || {}), status, null, origin);
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

/* ==================== v2 路由：不可变对象与 pointer CAS ==================== */
async function readV2JsonBody(request, env, origin) {
  var ct = request.headers.get('Content-Type') || '';
  if (ct.indexOf('application/json') < 0) {
    return { error: v2Fail(env, request, origin, 415, 'bad-content-type', 'Content-Type 必须是 application/json') };
  }
  var MAX = maxBytes(env);
  var cl = parseInt(request.headers.get('Content-Length') || '', 10);
  if (Number.isFinite(cl) && cl > MAX) {
    return { error: v2Fail(env, request, origin, 413, 'too-large', '请求超过大小上限') };
  }
  var text;
  try { text = await request.text(); }
  catch (e) { return { error: v2Fail(env, request, origin, 400, 'bad-body', '请求体读取失败') }; }
  var bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX) return { error: v2Fail(env, request, origin, 413, 'too-large', '请求超过大小上限') };
  var obj;
  try { obj = JSON.parse(text); }
  catch (e) { return { error: v2Fail(env, request, origin, 400, 'bad-json', '不是合法 JSON') }; }
  if (!isPlainObject(obj)) return { error: v2Fail(env, request, origin, 400, 'bad-body', '请求体必须是对象') };
  return { obj: obj, text: text, bytes: bytes };
}

/* 写入不可变对象。成功只代表对象已落盘，不代表 pointer 已提交。 */
async function handleV2ObjectPut(request, env, origin) {
  var parsed = await readV2JsonBody(request, env, origin);
  if (parsed.error) return parsed.error;
  var body = parsed.obj;
  if (body.protocolVersion !== V2_PROTOCOL) {
    return v2Fail(env, request, origin, 400, 'bad-protocol', 'protocolVersion 必须为 2');
  }
  var im;
  try { im = parseV2Immutable(body.immutable, true); }
  catch (e) { return v2Fail(env, request, origin, 400, 'bad-immutable', e.message); }

  try {
    if (await immutableHashOf(im) !== im.immutableHash) {
      return v2Fail(env, request, origin, 400, 'immutable-hash-mismatch', 'immutableHash 与字段不一致');
    }
  } catch (e) {
    return v2Fail(env, request, origin, 400, 'bad-immutable', e.message);
  }

  if (!isPlainObject(body.payload)) {
    return v2Fail(env, request, origin, 400, 'bad-payload', '缺少 payload');
  }
  var envelopeError = validateBackupEnvelope(body.payload);
  if (envelopeError) return v2Fail(env, request, origin, 400, envelopeError, 'payload 信封不合法');

  var payloadText;
  try { payloadText = JSON.stringify(body.payload); }
  catch (e) { return v2Fail(env, request, origin, 400, 'bad-payload', 'payload 无法序列化'); }
  var payloadBytes = new TextEncoder().encode(payloadText);
  if (payloadBytes.length > maxBytes(env)) {
    return v2Fail(env, request, origin, 413, 'too-large', '备份超过大小上限');
  }
  var payloadHash = await sha256Tag(payloadBytes);
  if (payloadHash !== im.payloadHash) {
    return v2Fail(env, request, origin, 400, 'payload-hash-mismatch', 'payload 字节哈希与 immutable 不一致');
  }
  if (payloadBytes.length !== im.payloadBytes) {
    return v2Fail(env, request, origin, 400, 'payload-size-mismatch', 'payload 字节数与 immutable 不一致');
  }

  var bucket = requireBucket(env);
  var existing;
  try { existing = await bucket.get(im.objectKey); }
  catch (e) { return v2Fail(env, request, origin, 502, 'storage-error', 'R2 读取失败'); }
  if (existing) {
    var oldText = await readR2Object(existing);
    var oldMeta = existing.customMetadata || {};
    var sameBody = oldText !== null && await sha256Tag(new TextEncoder().encode(oldText)) === im.payloadHash;
    if (oldMeta.writeId === im.writeId && oldMeta.immutableHash === im.immutableHash && sameBody) {
      var idempotentEtag = etagOf(existing);
      if (!idempotentEtag) {
        return v2Fail(env, request, origin, 502, 'storage-error', 'R2 未返回可用 ETag，对象状态不可用');
      }
      return jsonResp(env, request, {
        ok: true, idempotent: true, pointerCommitted: false,
        stored: { objectKey: im.objectKey, writeId: im.writeId, size: im.payloadBytes, etag: idempotentEtag }
      }, 200, null, origin);
    }
    return v2Fail(env, request, origin, 409, 'object-conflict', 'objectKey 已存在不同内容');
  }

  var uploadedAt = new Date().toISOString();
  var putResult;
  try {
    putResult = await bucket.put(im.objectKey, payloadText, {
      onlyIf: v2CreateOnlyIf(),
      customMetadata: {
        app: APP_NAME,
        protocolVersion: String(V2_PROTOCOL),
        writeId: im.writeId,
        objectKey: im.objectKey,
        payloadHash: im.payloadHash,
        payloadBytes: String(im.payloadBytes),
        immutableHash: im.immutableHash,
        immutableJson: JSON.stringify(im),
        uploadedAt: uploadedAt
      }
    });
  } catch (e) {
    if (isPreconditionFailure(e)) return v2Fail(env, request, origin, 409, 'object-conflict', '对象创建条件未满足');
    return v2Fail(env, request, origin, 502, 'storage-error', 'R2 写入失败');
  }
  /* 真实 Workers R2 条件写失败返回 null（不抛异常）；必须当作冲突，绝不报告写入成功。 */
  if (putResult === null) {
    return v2Fail(env, request, origin, 409, 'object-conflict', '对象创建条件写未满足');
  }
  var objectEtag = etagOf(putResult);
  if (!objectEtag) {
    return v2Fail(env, request, origin, 502, 'storage-error', 'R2 未返回可用 ETag，禁止继续提交 pointer');
  }
  return jsonResp(env, request, {
    ok: true, idempotent: false, pointerCommitted: false,
    stored: { objectKey: im.objectKey, writeId: im.writeId, size: im.payloadBytes, etag: objectEtag }
  }, 200, null, origin);
}

/* pointer 条件更新：expected.etag === null 表示只允许首次初始化。 */
async function handleV2PointerPut(request, env, origin) {
  var parsed = await readV2JsonBody(request, env, origin);
  if (parsed.error) return parsed.error;
  var body = parsed.obj;
  if (body.protocolVersion !== V2_PROTOCOL) {
    return v2Fail(env, request, origin, 400, 'bad-protocol', 'protocolVersion 必须为 2');
  }
  var pointer;
  try { pointer = parseV2Pointer(body.pointer); }
  catch (e) { return v2Fail(env, request, origin, 400, 'bad-pointer', e.message); }

  var expected = body.expected;
  if (!isPlainObject(expected) || !Number.isInteger(expected.revision) || expected.revision < 0 ||
      !(expected.etag === null || isStrongQuotedEtag(expected.etag))) {
    return v2Fail(env, request, origin, 400, 'bad-expected', 'expected 必须包含 revision 与强 quoted HTTP ETag（或 null）');
  }
  if (pointer.revision !== expected.revision + 1) {
    return v2Fail(env, request, origin, 409, 'revision-mismatch', 'revision 必须是 expected.revision + 1',
      { expectedRevision: expected.revision, pointerRevision: pointer.revision });
  }

  var bucket = requireBucket(env);
  var currentObj;
  try { currentObj = await bucket.get(V2_POINTER_KEY); }
  catch (e) { return v2Fail(env, request, origin, 502, 'storage-error', 'R2 读取失败'); }

  var currentPointer = null;
  var currentEtag = null;
  if (currentObj) {
    var currentText = await readR2Object(currentObj);
    currentEtag = etagOf(currentObj);
    try { currentPointer = parseV2Pointer(JSON.parse(currentText)); }
    catch (e) { return v2Fail(env, request, origin, 409, 'pointer-corrupt', '现有 pointer 无法解析'); }
    if (canonicalV2Pointer(currentPointer) === canonicalV2Pointer(pointer) && currentPointer.revision === pointer.revision) {
      if (!currentEtag) {
        return v2Fail(env, request, origin, 502, 'storage-error', 'R2 未返回可用 ETag，pointer 状态不可用');
      }
      return jsonResp(env, request, {
        ok: true, idempotent: true,
        pointer: currentPointer, revision: currentPointer.revision, etag: currentEtag
      }, 200, null, origin);
    }
    if (currentEtag !== expected.etag || currentPointer.revision !== expected.revision) {
      return v2Fail(env, request, origin, 409, 'cas-conflict', 'pointer 条件版本不匹配',
        { currentRevision: currentPointer.revision, currentEtag: currentEtag });
    }
  } else {
    if (expected.etag !== null || expected.revision !== 0) {
      return v2Fail(env, request, origin, 409, 'cas-conflict', 'pointer 不存在，但期望版本不是初始值',
        { currentRevision: null, currentEtag: null });
    }
  }

  var immutableObj;
  try { immutableObj = await bucket.get(pointer.objectKey); }
  catch (e) { return v2Fail(env, request, origin, 502, 'storage-error', 'R2 读取失败'); }
  if (!immutableObj) return v2Fail(env, request, origin, 409, 'immutable-not-found', 'pointer 指向的不可变对象不存在');

  var immutableText = await readR2Object(immutableObj);
  var meta = immutableObj.customMetadata || {};
  if (meta.writeId !== pointer.writeId) return v2Fail(env, request, origin, 409, 'write-id-mismatch', '不可变对象 writeId 不匹配');
  if (typeof immutableText !== 'string' || await sha256Tag(new TextEncoder().encode(immutableText)) !== pointer.payloadHash) {
    return v2Fail(env, request, origin, 409, 'payload-hash-mismatch', '不可变对象字节哈希与 pointer 不一致');
  }
  if (new TextEncoder().encode(immutableText).length !== pointer.payloadBytes) {
    return v2Fail(env, request, origin, 409, 'payload-size-mismatch', '不可变对象字节数与 pointer 不一致');
  }

  var storedImmutable;
  try {
    if (typeof meta.immutableJson !== 'string') throw new Error('immutable-metadata-missing');
    storedImmutable = parseV2Immutable(JSON.parse(meta.immutableJson), true);
  } catch (e) {
    return v2Fail(env, request, origin, 409, 'immutable-metadata-invalid', e.message);
  }
  if (await immutableHashOf(storedImmutable) !== pointer.immutableHash) {
    return v2Fail(env, request, origin, 409, 'immutable-hash-mismatch', 'pointer immutableHash 与对象不一致');
  }
  if (!pointerMatchesImmutable(pointer, storedImmutable)) {
    return v2Fail(env, request, origin, 409, 'immutable-field-mismatch', 'pointer 字段与不可变对象不一致');
  }

  var onlyIf;
  try {
    onlyIf = expected.etag === null ? v2CreateOnlyIf() : v2MatchOnlyIf(expected.etag);
  } catch (e) {
    return v2Fail(env, request, origin, 400, 'bad-expected', 'expected.etag 格式非法');
  }
  var putResult;
  try {
    putResult = await bucket.put(V2_POINTER_KEY, JSON.stringify(pointer), {
      onlyIf: onlyIf,
      customMetadata: {
        app: APP_NAME,
        protocolVersion: String(V2_PROTOCOL),
        revision: String(pointer.revision),
        writeId: pointer.writeId,
        immutableHash: pointer.immutableHash,
        payloadHash: pointer.payloadHash
      }
    });
  } catch (e) {
    if (isPreconditionFailure(e)) return v2Fail(env, request, origin, 409, 'cas-conflict', 'pointer 条件写入未满足');
    return v2Fail(env, request, origin, 502, 'storage-error', 'R2 写入失败');
  }
  /* 真实 Workers R2 条件写失败返回 null；不得报告 pointer 已更新。 */
  if (putResult === null) {
    return v2Fail(env, request, origin, 409, 'cas-conflict', 'pointer 条件写未满足');
  }
  var pointerEtag = etagOf(putResult);
  if (!pointerEtag) {
    return v2Fail(env, request, origin, 502, 'storage-error', 'R2 未返回可用 ETag，pointer 状态未知');
  }
  return jsonResp(env, request, {
    ok: true, idempotent: false,
    pointer: pointer, revision: pointer.revision, etag: pointerEtag
  }, 200, null, origin);
}

async function handleV2Status(request, env, origin) {
  var bucket = requireBucket(env);
  var obj;
  try { obj = await bucket.get(V2_POINTER_KEY); }
  catch (e) { return v2Fail(env, request, origin, 502, 'storage-error', 'R2 读取失败'); }
  if (!obj) return jsonResp(env, request, { ok: true, hasPointer: false }, 200, null, origin);
  var text = await readR2Object(obj);
  var pointer;
  try { pointer = parseV2Pointer(JSON.parse(text)); }
  catch (e) { return v2Fail(env, request, origin, 409, 'pointer-corrupt', '现有 pointer 无法解析'); }
  var statusEtag = etagOf(obj);
  if (!statusEtag) {
    return v2Fail(env, request, origin, 502, 'storage-error', 'R2 未返回可用 ETag，pointer 状态不可用');
  }
  return jsonResp(env, request, {
    ok: true, hasPointer: true, pointer: pointer,
    revision: pointer.revision, etag: statusEtag
  }, 200, null, origin);
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

  var V2_PATHS = {
    '/api/backup/v2/object': true,
    '/api/backup/v2/pointer': true,
    '/api/backup/v2/status': true
  };
  var isV2Path = !!V2_PATHS[url.pathname];
  var isLegacyPath = url.pathname === '/api/backup' || url.pathname === '/api/backup/status';
  if (!isV2Path && !isLegacyPath) {
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

  if (isV2Path) {
    var protocolHeader = (request.headers.get(V2_PROTOCOL_HEADER) || '').trim();
    if (protocolHeader !== String(V2_PROTOCOL)) {
      return v2Fail(env, request, origin, 400, 'protocol-required', 'v2 请求必须显式声明协议版本');
    }
    if (url.pathname === '/api/backup/v2/status') {
      if (request.method !== 'GET') {
        return jsonResp(env, request, { ok: false, error: 'method-not-allowed' }, 405, { 'Allow': 'GET' }, origin);
      }
      return handleV2Status(request, env, origin);
    }
    if (url.pathname === '/api/backup/v2/object') {
      if (request.method !== 'PUT') {
        return jsonResp(env, request, { ok: false, error: 'method-not-allowed' }, 405, { 'Allow': 'PUT' }, origin);
      }
      return handleV2ObjectPut(request, env, origin);
    }
    if (request.method !== 'PUT') {
      return jsonResp(env, request, { ok: false, error: 'method-not-allowed' }, 405, { 'Allow': 'PUT' }, origin);
    }
    return handleV2PointerPut(request, env, origin);
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
