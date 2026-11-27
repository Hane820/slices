/* Task：云端备份 Worker 专项测试（完全隔离，纯 Node，不启动 wrangler）
 *
 * 隔离手段：
 *   - R2 用内存桩实现（put/get/head，可注入故障），绝不触碰任何真实桶；
 *   - Access JWT 用真实 ES256/RS256 密钥对 + 本地 JWKS HTTP 服务，
 *     Worker 走真实 WebCrypto 验签路径；
 *   - 直接调用 Worker 的 fetch(request, env)，无网络、无部署；
 *   - 不 import 任何应用代码，IndexedDB / 业务库零接触。
 *
 * 覆盖：未认证拒绝 / 合法上传下载一致性 / 非法 JSON·格式·超大文件 / R2 故障不假报成功 /
 *      CORS 白名单 / 状态接口 / 方法限制 / 日志隐私 / 业务库零引用。 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const WORKER_SRC = path.join(__dirname, '..', 'src', 'index.js');

/* ==================== M1：进程内唯一的 console.log 包装 ====================
 * 绝不在每次请求里替换/恢复全局 console.log。异步上下文内写请求自己的日志数组，
 * 无上下文时走原生输出，保证并发结束后 [FAIL] / PASS= / TOTAL= 仍可见。 */
const LOG_ALS = new AsyncLocalStorage();
const NATIVE_LOG = console.log.bind(console);
const NATIVE_SINK = { current: null };   /* 测试用：捕获“无上下文”的原生输出 */
const LOG_SINK = { current: null };      /* F 组：跨 call() 收集 Worker 日志 */

console.log = (...args) => {
  const line = args.map(String).join(' ');
  const requestLogs = LOG_ALS.getStore();
  if (requestLogs) {
    requestLogs.push(line);
    if (LOG_SINK.current) LOG_SINK.current.push(line);
    return;
  }
  if (NATIVE_SINK.current) { NATIVE_SINK.current.push(line); return; }
  NATIVE_LOG(...args);
};

const R = { checks: [], pass: 0, fail: 0, fatal: null };
function check(n, c, d) {
  const ok = !!c;
  R.checks.push({ name: n, ok, detail: d });
  if (ok) R.pass++; else { R.fail++; console.log('[FAIL] ' + n + ' :: ' + JSON.stringify(d).slice(0, 600)); }
}
function eq(n, a, b) { check(n, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b }); }

/* ==================== 基础工具 ==================== */
function bytesToB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function strToB64url(s) {
  return bytesToB64url(new TextEncoder().encode(s));
}

/* ---------- ETag 语法与比较（严格按 RFC 语义） ----------
 * quoted entity-tag：可选 W/ 前缀 + 双引号包裹；裸 token 只允许出现在 R2Conditional
 * 的 etagMatches/etagDoesNotMatch（官方字段为不带引号的 etag）。 */
const QUOTED_TAG = /^(W\/)?"([\x21\x23-\x7E]*)"$/;

function parseHttpTag(value, label) {
  if (typeof value !== 'string') throw new Error(label + '-type-invalid');
  const m = QUOTED_TAG.exec(value);
  if (!m) throw new Error(label + '-format-invalid');
  return { weak: !!m[1], value: m[2] };
}

function parseConditionalTag(value) {
  if (typeof value !== 'string') throw new Error('conditional-etag-type-invalid');
  const weak = /^W\//.test(value);
  let v = weak ? value.slice(2) : value;
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1);
  return { weak: weak, value: v };
}

/* If-Match：强比较，弱 ETag 永不匹配。 */
function strongEqual(a, b) {
  return !!a && !!b && !a.weak && !b.weak && a.value === b.value;
}

/* 可复位的写屏障：arm 后，指定 key 的前 N 个 put 都会停在条件判断之前，
 * 从而保证并发请求都已经读取过同一份快照后才进入条件写。超时会自动放行。 */
function makePutGate() {
  let key = null;
  let count = 0;
  let arrived = 0;
  let resolveAll = null;
  let timer = null;
  let timedOut = false;
  let all = Promise.resolve();
  return {
    arm(targetKey, expected, timeoutMs) {
      key = targetKey;
      count = expected;
      arrived = 0;
      timedOut = false;
      all = new Promise(function (resolve) { resolveAll = resolve; });
      timer = setTimeout(function () { timedOut = true; resolveAll(); }, timeoutMs || 3000);
    },
    async pass(targetKey) {
      if (!key || targetKey !== key) return;
      arrived++;
      if (arrived >= count) resolveAll();
      await all;
      if (arrived >= count) { clearTimeout(timer); key = null; }
    },
    get timedOut() { return timedOut; },
    get armed() { return key !== null; },
    abort() {
      if (key) { clearTimeout(timer); key = null; }
      if (resolveAll) resolveAll();
    }
  };
}

/* 内存 R2 桩：按 Cloudflare Workers R2 API 语义模拟 put/get/head。
 *   - onlyIf 仅支持 Headers(If-Match / If-None-Match) 或 R2Conditional 的四个官方字段；
 *   - 未知字段 / 错误类型 fail closed（抛错），条件不满足时 put() 返回 null（不抛）；
 *   - etag 不带引号、httpEtag 带引号，与真实 R2Object 一致；
 *   - 条件判断与写入在同一个同步临界区内完成（内部没有 await 让出事件循环）。
 * 仍然只是逻辑桩：真实 R2 的跨实例原子性必须在隔离桶中另行验证。 */
function makeR2Stub() {
  const store = new Map();
  let etagSeq = 0;
  const CONDITIONAL_FIELDS = new Set(['etagMatches', 'etagDoesNotMatch', 'uploadedBefore', 'uploadedAfter']);

  function readOnlyIf(onlyIf) {
    if (onlyIf === undefined || onlyIf === null) return null;
    if (typeof Headers !== 'undefined' && onlyIf instanceof Headers) {
      const out = {};
      const im = onlyIf.get('If-Match');
      const inm = onlyIf.get('If-None-Match');
      if (im !== null) out.ifMatch = im === '*' ? '*' : { kind: 'header', value: im };
      if (inm !== null) out.ifNoneMatch = inm === '*' ? '*' : { kind: 'header', value: inm };
      return out;
    }
    if (typeof onlyIf === 'object' && !Array.isArray(onlyIf)) {
      for (const k of Object.keys(onlyIf)) {
        if (!CONDITIONAL_FIELDS.has(k)) throw new Error('unsupported-onlyIf-field:' + k);
      }
      const out = {};
      if (onlyIf.etagMatches !== undefined) {
        if (typeof onlyIf.etagMatches !== 'string') throw new Error('etagMatches-type-invalid');
        out.ifMatch = { kind: 'conditional', value: onlyIf.etagMatches };
      }
      if (onlyIf.etagDoesNotMatch !== undefined) {
        if (typeof onlyIf.etagDoesNotMatch !== 'string') throw new Error('etagDoesNotMatch-type-invalid');
        out.ifNoneMatch = { kind: 'conditional', value: onlyIf.etagDoesNotMatch };
      }
      if (onlyIf.uploadedBefore !== undefined) {
        if (!(onlyIf.uploadedBefore instanceof Date)) throw new Error('uploadedBefore-type-invalid');
        out.uploadedBefore = onlyIf.uploadedBefore;
      }
      if (onlyIf.uploadedAfter !== undefined) {
        if (!(onlyIf.uploadedAfter instanceof Date)) throw new Error('uploadedAfter-type-invalid');
        out.uploadedAfter = onlyIf.uploadedAfter;
      }
      return out;
    }
    throw new Error('invalid-onlyIf');
  }

  function conditionHolds(existing, cond) {
    const cur = existing ? parseHttpTag(existing.httpEtag, 'stored-etag') : null;
    if (cond.ifMatch !== undefined) {
      if (!existing) return false;
      if (cond.ifMatch !== '*') {
        const want = cond.ifMatch.kind === 'header'
          ? parseHttpTag(cond.ifMatch.value, 'if-match')
          : parseConditionalTag(cond.ifMatch.value);
        if (!strongEqual(cur, want)) return false;
      }
    }
    if (cond.ifNoneMatch !== undefined) {
      if (!existing) return true;
      if (cond.ifNoneMatch === '*') return false;
      const want = cond.ifNoneMatch.kind === 'header'
        ? parseHttpTag(cond.ifNoneMatch.value, 'if-none-match')
        : parseConditionalTag(cond.ifNoneMatch.value);
      /* If-None-Match 使用弱比较：忽略 W/ 前缀。 */
      if (cur.value === want.value) return false;
    }
    if (cond.uploadedBefore && existing && !(existing.uploaded < cond.uploadedBefore)) return false;
    if (cond.uploadedAfter && existing && !(existing.uploaded > cond.uploadedAfter)) return false;
    return true;
  }

  const stub = {
    failMode: null,
    /* 注入用：模拟 Worker 读后、put 前的竞态，令指定 key 的条件写返回 null。 */
    nullConditionalKey: null,
    /* 注入用：写入照常发生，但 put() 返回值缺少 ETag。 */
    suppressPutEtag: false,
    /* 注入用：get()/head() 返回的对象缺少 ETag。 */
    suppressGetEtag: false,
    /* 注入用：get()/head() 返回弱 ETag（真实 R2 不会这样做，用于 fail-closed 验证）。 */
    weakEtagReads: false,
    putGate: makePutGate(),
    async put(key, value, opts) {
      if (stub.failMode === 'put' || stub.failMode === 'all') throw new Error('r2-unavailable');
      const options = opts || {};
      const cond = readOnlyIf(options.onlyIf);
      /* 屏障只作用于被 arm 的 key；普通测试不受影响，超时会自动放行。 */
      await stub.putGate.pass(key);
      const existing = store.get(key);
      /* 同步临界区：条件判断与写入之间没有任何 await。 */
      if (cond && (stub.nullConditionalKey === key || !conditionHolds(existing, cond))) return null;
      const etag = 'stub-etag-' + (++etagSeq);
      const httpEtag = '"' + etag + '"';
      const bytes = new TextEncoder().encode(value).length;
      const uploaded = new Date();
      store.set(key, {
        value: value, bytes: bytes, opts: options, uploaded: uploaded,
        etag: etag, httpEtag: httpEtag
      });
      if (stub.suppressPutEtag) return { uploaded: uploaded };
      return { uploaded: uploaded, etag: etag, httpEtag: httpEtag };
    },
    async get(key) {
      if (stub.failMode === 'get' || stub.failMode === 'all') throw new Error('r2-unavailable');
      const o = store.get(key);
      if (!o) return null;
      let httpEtag = o.httpEtag;
      let etag = o.etag;
      if (stub.suppressGetEtag) { httpEtag = undefined; etag = undefined; }
      else if (stub.weakEtagReads) { httpEtag = 'W/' + o.httpEtag; etag = 'W/' + o.etag; }
      return {
        body: o.value,
        size: o.bytes,
        uploaded: o.uploaded,
        httpEtag: httpEtag,
        etag: etag,
        customMetadata: o.opts.customMetadata || {},
        text: async () => o.value,
        bodyUsed: false
      };
    },
    async head(key) {
      if (stub.failMode === 'head' || stub.failMode === 'all') throw new Error('r2-unavailable');
      const o = store.get(key);
      if (!o) return null;
      let httpEtag = o.httpEtag;
      let etag = o.etag;
      if (stub.suppressGetEtag) { httpEtag = undefined; etag = undefined; }
      else if (stub.weakEtagReads) { httpEtag = 'W/' + o.httpEtag; etag = 'W/' + o.etag; }
      return { size: o.bytes, uploaded: o.uploaded, httpEtag: httpEtag, etag: etag, customMetadata: o.opts.customMetadata || {} };
    },
    keys() { return Array.from(store.keys()); }
  };
  return stub;
}

/* 本地 JWKS 服务（Worker 真实走 fetch + 缓存 + kid 未命中强刷路径） */
function makeJwksServer(keysRef) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ keys: keysRef.slice() }));
  });
  return server;
}

const envBase = (r2, jwksUrl) => ({
  BACKUP_BUCKET: r2,
  /* 仅旧协议回归测试：Access-only 兼容路径。生产配置严禁开启。 */
  ALLOW_LEGACY_ACCESS_BACKUP: 'true',
  APP_ORIGIN: 'https://liyuk.github.io',
  ACCESS_TEAM: 'test-team.cloudflareaccess.com',
  AUD_TAG: 'test-aud-tag',
  JWKS_URL: jwksUrl,
  MAX_BACKUP_BYTES: 1024 * 1024
});

const ORIGIN = 'https://liyuk.github.io';
const BACKUP_BODY_TEMPLATE = JSON.stringify({
  app: 'earthonline', version: 4,
  exportedAt: '2026-11-18T08:00:00.000Z',
  data: { v: 4, tasks: [{ id: 't1', title: '测试任务', cat: 'want', done: {}, createdAt: 1 }], notes: {}, pens: [{ id: 'p1', color: '#112233', emoji: '🌿', name: '测试笔' }] }
});
const BACKUP_BODY = BACKUP_BODY_TEMPLATE;
const BODY2 = BACKUP_BODY_TEMPLATE.replace('2026-11-18T08:00:00.000Z', '2026-11-18T09:00:00.000Z');

async function main() {
  const { default: worker } = await import('file:///' + WORKER_SRC.replace(/\\/g, '/'));

  /* ES256 密钥对 + JWKS */
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  pubJwk.kid = 'test-key-1'; pubJwk.use = 'sig'; pubJwk.alg = 'ES256';
  const jwksKeys = [pubJwk];
  const jwksServer = makeJwksServer(jwksKeys);
  await new Promise(r => jwksServer.listen(0, '127.0.0.1', r));
  const jwksPort = jwksServer.address().port;

  const r2 = makeR2Stub();
  const env = envBase(r2, 'http://127.0.0.1:' + jwksPort + '/cdn-cgi/access/certs');

  async function signToken(claims, headerExtra) {
    const header = Object.assign({ alg: 'ES256', typ: 'JWT', kid: 'test-key-1' }, headerExtra || {});
    const h = strToB64url(JSON.stringify(header));
    const p = strToB64url(JSON.stringify(claims));
    const data = new TextEncoder().encode(h + '.' + p);
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data);
    return h + '.' + p + '.' + bytesToB64url(new Uint8Array(sig));
  }
  function claims(over) {
    const now = Math.floor(Date.now() / 1000);
    return Object.assign({ iss: 'https://test-team.cloudflareaccess.com/', aud: 'test-aud-tag', exp: now + 300, email: 'someone@example.com' }, over || {});
  }
  const goodToken = await signToken(claims());

  /* ============ v2 测试辅助（与 Worker/core 的规范化定义一致） ============ */
  async function sha256TagU8(u8) {
    const buf = await crypto.subtle.digest('SHA-256', u8);
    return 'sha256-' + bytesToB64url(new Uint8Array(buf));
  }
  function canonicalImmutableHarness(im) {
    const e = im.identity.expectedConflictState;
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
  async function immutableHashHarness(im) {
    return sha256TagU8(new TextEncoder().encode(canonicalImmutableHarness(im)));
  }
  async function makeObjectRequest(marker, overrides) {
    const over = overrides || {};
    const writeId = over.writeId || randomUUID();
    const payload = {
      app: 'earthonline', version: 4,
      exportedAt: '2026-11-25T00:00:00.000Z',
      data: { v: 4, marker: marker }
    };
    const payloadText = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(payloadText);
    const im = {
      protocolVersion: 2,
      attemptId: writeId,
      writeId: writeId,
      clientId: over.clientId || 'v2-client',
      clientRevision: over.clientRevision === undefined ? 1 : over.clientRevision,
      baseRev: over.baseRev === undefined ? 0 : over.baseRev,
      objectKey: 'earthonline/backups/' + writeId + '.json',
      payloadHash: 'sha256-pending',
      payloadBytes: bytes.length,
      createdAt: over.createdAt || 1764000000000,
      identity: {
        conflictEpoch: over.conflictEpoch === undefined ? 0 : over.conflictEpoch,
        blockEpoch: over.blockEpoch === undefined ? 0 : over.blockEpoch,
        expectedConflictState: over.expectedConflictState || { mode: 'none', id: null }
      },
      immutableHash: 'sha256-pending'
    };
    im.payloadHash = await sha256TagU8(bytes);
    for (const key of Object.keys(over)) {
      if (key === 'immutableHash') continue;
      if (key !== 'writeId' && key !== 'clientId' && key !== 'clientRevision' && key !== 'baseRev' &&
          key !== 'createdAt' && key !== 'conflictEpoch' && key !== 'blockEpoch' &&
          key !== 'expectedConflictState') im[key] = over[key];
    }
    im.immutableHash = await immutableHashHarness(im);
    if (Object.prototype.hasOwnProperty.call(over, 'immutableHash')) im.immutableHash = over.immutableHash;
    return { protocolVersion: 2, immutable: im, payload: payload, payloadText: payloadText };
  }
  function pointerFrom(im, revision) {
    return {
      protocolVersion: 2,
      revision: revision,
      writeId: im.writeId,
      objectKey: im.objectKey,
      payloadHash: im.payloadHash,
      payloadBytes: im.payloadBytes,
      immutableHash: im.immutableHash,
      clientId: im.clientId,
      clientRevision: im.clientRevision,
      baseRev: im.baseRev,
      createdAt: im.createdAt
    };
  }
  function v2Opts(method, body, extraHeaders) {
    const headers = Object.assign({
      'Cf-Access-Jwt-Assertion': goodToken,
      'Content-Type': 'application/json',
      'X-Earthonline-Protocol': '2',
      'Origin': ORIGIN
    }, extraHeaders || {});
    const opts = { method: method, headers: headers };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return opts;
  }
  function newV2Env() {
    const r2 = makeR2Stub();
    return { r2: r2, env: envBase(r2, 'http://127.0.0.1:' + jwksPort + '/cdn-cgi/access/certs') };
  }
  async function putObject(targetEnv, body) {
    return call('/api/backup/v2/object', v2Opts('PUT', body), targetEnv);
  }
  async function putPointer(targetEnv, pointer, expected) {
    return call('/api/backup/v2/pointer', v2Opts('PUT', {
      protocolVersion: 2, pointer: pointer, expected: expected
    }), targetEnv);
  }
  async function v2Status(targetEnv) {
    return call('/api/backup/v2/status', v2Opts('GET'), targetEnv);
  }

  function call(path, opts, targetEnv) {
    const req = new Request('https://backup.example.com' + path, opts || { method: 'GET' });
    const logs = [];
    /* 日志上下文随异步链传播；不替换、不恢复全局 console.log。 */
    return LOG_ALS.run(logs, () => worker.fetch(req, targetEnv || env, {}))
      .then(async res => ({ res, logs, text: await res.text() }));
  }

  try {
    /* ============ A：未认证 / 坏 Token 一律拒绝 ============ */
    {
      let r = await call('/api/backup/status');
      eq('A1 无 Token 401', [r.res.status, JSON.parse(r.text).error], [401, 'unauthorized']);
      r = await call('/api/backup/status', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': 'not.a.jwt' } });
      eq('A2 畸形 Token 401', [r.res.status, JSON.parse(r.text).reason], [401, 'token-malformed']);
      r = await call('/api/backup', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': goodToken.slice(0, -3) + 'xyz' } });
      eq('A3 篡改签名 401', [r.res.status, JSON.parse(r.text).reason], [401, 'signature-invalid']);
      r = await call('/api/backup/status', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': await signToken(claims({ aud: 'other-app' })) } });
      eq('A4 aud 不匹配 401', [r.res.status, JSON.parse(r.text).reason], [401, 'aud-mismatch']);
      r = await call('/api/backup/status', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': await signToken(claims({ exp: Math.floor(Date.now() / 1000) - 600 })) } });
      eq('A5 过期 Token 401', [r.res.status, JSON.parse(r.text).reason], [401, 'token-expired']);
      r = await call('/api/backup/status', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': await signToken(claims({ iss: 'https://evil.example.com/' })) } });
      eq('A6 iss 不匹配 401', [r.res.status, JSON.parse(r.text).reason], [401, 'iss-mismatch']);
      r = await call('/api/backup/status', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': await signToken(claims(), { alg: 'none' }) } });
      eq('A7 alg=none 401', [r.res.status, JSON.parse(r.text).reason], [401, 'alg-unsupported']);
      /* 只解码不验签的实现会放过这条：payload 合法但签名来自另一把钥匙 */
      const wrongKp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const h = strToB64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'test-key-1' }));
      const p = strToB64url(JSON.stringify(claims()));
      const badSig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, wrongKp.privateKey, new TextEncoder().encode(h + '.' + p));
      r = await call('/api/backup/status', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': h + '.' + p + '.' + bytesToB64url(new Uint8Array(badSig)) } });
      eq('A8 他人私钥签名 401', [r.res.status, JSON.parse(r.text).reason], [401, 'signature-invalid']);
      r = await call('/api/backup/status', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': await signToken(claims(), { kid: 'no-such-key' }) } });
      eq('A9 未知 kid 401（触发 JWKS 强刷后仍拒）', [r.res.status, JSON.parse(r.text).reason], [401, 'kid-unknown']);
      /* Cloudflare Access 官方 iss 无尾斜杠：必须放行；带尾斜杠的旧式令牌也仍放行（goodToken 已覆盖） */
      r = await call('/api/backup/status', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': await signToken(claims({ iss: 'https://test-team.cloudflareaccess.com' })) } });
      eq('A10 官方无尾斜杠 iss 放行（200）；A1 带尾斜杠仍放行', r.res.status, 200);
      r = await call('/api/backup/status', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': await signToken(claims({ iss: 'https://test-team.cloudflareaccess.com.evil.com' })) } });
      eq('A11 相似但不同的域名仍拒绝（iss-mismatch）', [r.res.status, JSON.parse(r.text).reason], [401, 'iss-mismatch']);
    }

    /* ============ H：CORS 白名单与方法限制 ============ */
    {
      let r = await call('/api/backup/status', { method: 'GET', headers: { 'Origin': 'https://evil.example.com', 'Cf-Access-Jwt-Assertion': goodToken } });
      eq('H1 非白名单 Origin 403 且不带 CORS 头', [r.res.status, r.res.headers.get('Access-Control-Allow-Origin')], [403, null]);
      r = await call('/api/backup/status', { method: 'GET', headers: { 'Origin': ORIGIN, 'Cf-Access-Jwt-Assertion': goodToken } });
      eq('H2 白名单 Origin 放行且带 CORS 头', [r.res.status, r.res.headers.get('Access-Control-Allow-Origin')], [200, ORIGIN]);
      r = await call('/api/backup', { method: 'OPTIONS', headers: { 'Origin': 'https://evil.example.com', 'Access-Control-Request-Method': 'PUT' } });
      eq('H3 预检：非白名单 403', r.res.status, 403);
      r = await call('/api/backup', { method: 'OPTIONS', headers: { 'Origin': ORIGIN, 'Access-Control-Request-Method': 'PUT' } });
      eq('H4 预检：白名单 204 且允许 PUT 与 JWT 头',
        [r.res.status, r.res.headers.get('Access-Control-Allow-Methods'), r.res.headers.get('Access-Control-Allow-Headers'),
         r.res.headers.get('Access-Control-Allow-Credentials')],
        [204, 'GET, PUT, OPTIONS', 'Content-Type, Cf-Access-Jwt-Assertion, X-Earthonline-Protocol, X-Earthonline-Auth', 'true']);
      r = await call('/api/backup', { method: 'DELETE', headers: { 'Cf-Access-Jwt-Assertion': goodToken } });
      eq('H5 DELETE 405', r.res.status, 405);
      r = await call('/api/other', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': goodToken } });
      eq('H6 未知路径 404', r.res.status, 404);
      r = await call('/api/backup/status', { method: 'GET' }); // 无 Origin（curl 场景）：CORS 不适用，认证照常
      eq('H7 无 Origin 请求按认证判定（401，而非 403）', r.res.status, 401);
    }

    /* ============ B：合法上传 → 状态 → 下载一致性 ============ */
    {
      let r = await call('/api/backup/status', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': goodToken } });
      eq('B1 初始状态：云端无备份', [r.res.status, JSON.parse(r.text).hasBackup], [200, false]);
      r = await call('/api/backup', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': goodToken } });
      eq('B2 无备份时下载 404', [r.res.status, JSON.parse(r.text).error], [404, 'no-backup']);

      r = await call('/api/backup', {
        method: 'PUT', headers: { 'Cf-Access-Jwt-Assertion': goodToken, 'Content-Type': 'application/json', 'Origin': ORIGIN },
        body: BACKUP_BODY
      });
      const putBody = JSON.parse(r.text);
      eq('B3 上传成功', [r.res.status, putBody.ok, putBody.stored.size],
        [200, true, new TextEncoder().encode(BACKUP_BODY).length]);
      eq('B4 R2 中恰好一个对象（私有桶单对象 latest）', r2.keys(), ['earthonline/backup-latest.json']);

      r = await call('/api/backup/status', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': goodToken, 'Origin': ORIGIN } });
      const st = JSON.parse(r.text);
      eq('B5 状态：有备份、大小一致、版本正确',
        [st.ok, st.hasBackup, st.size, st.version], [true, true, new TextEncoder().encode(BACKUP_BODY).length, 4]);
      check('B6 uploadedAt 存在', typeof st.uploadedAt === 'string' && st.uploadedAt.length > 0, st);

      r = await call('/api/backup', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': goodToken, 'Origin': ORIGIN } });
      check('B7 下载内容与上传内容逐字节一致', r.text === BACKUP_BODY, { len: r.text.length });
      eq('B8 下载为附件 + no-store',
        [r.res.headers.get('Content-Disposition').indexOf('attachment; filename="earthonline-backup-') === 0,
         r.res.headers.get('Cache-Control')], [true, 'no-store']);
      eq('B8b 下载也带 CORS 头（前端跨源 fetch 能读到响应）',
        [r.res.headers.get('Access-Control-Allow-Origin'), r.res.headers.get('Access-Control-Allow-Credentials')],
        [ORIGIN, 'true']);

      /* 覆盖 latest：再传一份不同的合法备份 */
      const BODY2 = BACKUP_BODY.replace('2026-11-18T08:00:00.000Z', '2026-11-18T09:00:00.000Z');
      await call('/api/backup', { method: 'PUT', headers: { 'Cf-Access-Jwt-Assertion': goodToken, 'Content-Type': 'application/json' }, body: BODY2 });
      r = await call('/api/backup', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': goodToken } });
      check('B9 再上传覆盖 latest，下载得到最新内容', r.text === BODY2, true);
      eq('B10 仍是单对象', r2.keys().length, 1);
    }

    /* ============ C：非法 JSON / 错误格式 / 超大文件 ============ */
    {
      const put = (body, extraHeaders) => call('/api/backup', {
        method: 'PUT', headers: Object.assign({ 'Cf-Access-Jwt-Assertion': goodToken, 'Content-Type': 'application/json' }, extraHeaders || {}), body
      });
      let r = await put('这不是JSON');
      eq('C1 非法 JSON 400', [r.res.status, JSON.parse(r.text).error], [400, 'bad-json']);
      r = await put(JSON.stringify({ app: 'other-app', version: 4, data: {} }));
      eq('C2 app 不符 400', [r.res.status, JSON.parse(r.text).error], [400, 'bad-app']);
      r = await put(JSON.stringify({ app: 'earthonline', version: 3, data: {} }));
      eq('C3 版本不支持 400', [r.res.status, JSON.parse(r.text).error], [400, 'bad-version']);
      r = await put(JSON.stringify({ app: 'earthonline', version: 4, data: 'not-object' }));
      eq('C4 data 非对象 400', [r.res.status, JSON.parse(r.text).error], [400, 'bad-data']);
      r = await put(JSON.stringify({ app: 'earthonline', version: 4 }));
      eq('C5 缺 data 400', [r.res.status, JSON.parse(r.text).error], [400, 'bad-data']);
      r = await put(JSON.stringify({ app: 'earthonline', version: 4, data: {}, exportedAt: 123 }));
      eq('C6 exportedAt 类型 400', [r.res.status, JSON.parse(r.text).error], [400, 'bad-exported-at']);
      r = await put(BACKUP_BODY, { 'Content-Type': 'text/plain' });
      eq('C7 Content-Type 非 JSON 415', [r.res.status, JSON.parse(r.text).error], [415, 'bad-content-type']);
      const big = 'x'.repeat(1024 * 1024 + 10);
      r = await put(big);
      eq('C8 超大文件 413', [r.res.status, JSON.parse(r.text).error], [413, 'too-large']);
      /* 失败的 PUT 不得破坏云端已有备份 */
      r = await call('/api/backup', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': goodToken } });
      check('C9 校验失败后云端备份完好（未被部分写入）', r.text === BODY2, true);
      r = await call('/api/backup/status', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': goodToken } });
      eq('C10 状态仍指向最近一次成功备份', JSON.parse(r.text).hasBackup, true);
    }

    /* ============ D：R2 故障不假报成功 ============ */
    {
      r2.failMode = 'put';
      let r = await call('/api/backup', { method: 'PUT', headers: { 'Cf-Access-Jwt-Assertion': goodToken, 'Content-Type': 'application/json' }, body: BACKUP_BODY });
      const pb = JSON.parse(r.text);
      eq('D1 R2 写入故障 → 502 明确失败', [r.res.status, pb.ok, pb.error], [502, false, 'storage-error']);
      r2.failMode = 'head';
      r = await call('/api/backup/status', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': goodToken } });
      eq('D2 R2 查询故障 → 500 明确失败（不报 hasBackup:false 假象）',
        [r.res.status, JSON.parse(r.text).ok, JSON.parse(r.text).error], [500, false, 'storage-error']);
      r2.failMode = 'get';
      r = await call('/api/backup', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': goodToken } });
      eq('D3 R2 读取故障 → 500 明确失败', [r.res.status, JSON.parse(r.text).error], [500, 'storage-error']);
      r2.failMode = 'all';
      r = await call('/api/backup', {
        method: 'PUT', headers: { 'Cf-Access-Jwt-Assertion': goodToken, 'Content-Type': 'application/json' }, body: BACKUP_BODY
      });
      eq('D4 故障期间上传不成功也不崩溃', [r.res.status, JSON.parse(r.text).ok], [502, false]);
      r2.failMode = null;
      r = await call('/api/backup/status', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': goodToken } });
      eq('D5 故障恢复后服务正常', [r.res.status, JSON.parse(r.text).hasBackup], [200, true]);
    }

    /* ============ E：RS256 兼容 ============ */
    {
      const rkp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
      const rjwk = await crypto.subtle.exportKey('jwk', rkp.publicKey);
      rjwk.kid = 'rsa-1'; rjwk.use = 'sig'; rjwk.alg = 'RS256';
      jwksKeys.push(rjwk);
      const hh = strToB64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'rsa-1' }));
      const pp = strToB64url(JSON.stringify(claims()));
      const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', rkp.privateKey, new TextEncoder().encode(hh + '.' + pp));
      const r = await call('/api/backup/status', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': hh + '.' + pp + '.' + bytesToB64url(new Uint8Array(sig)) } });
      eq('E1 RS256 Token 亦可通过真实验签', r.res.status, 200);
    }

    /* ============ F：日志隐私 ============ */
    {
      const allLogs = [];
      LOG_SINK.current = allLogs;
      try {
        await call('/api/backup', { method: 'PUT', headers: { 'Cf-Access-Jwt-Assertion': goodToken, 'Content-Type': 'application/json' }, body: BACKUP_BODY });
        await call('/api/backup', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': goodToken } });
        await call('/api/backup/status', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': 'BADTOKEN' } });
      } finally { LOG_SINK.current = null; }
      const joined = allLogs.join('\n');
      check('F1 日志不含 Token', joined.indexOf(goodToken) < 0 && joined.indexOf('BADTOKEN') < 0, joined);
      check('F2 日志不含备份正文片段', joined.indexOf('测试任务') < 0 && joined.indexOf('BIZMARK') < 0, joined);
      check('F3 日志格式为 方法/路径/状态/字节数', /^\[backup\] (GET|PUT|OPTIONS) \/api\/backup(\/status)? -> \d+( \(\d+B\))?$/.test(allLogs[0]), allLogs[0]);
    }

    /* ============ G：Worker 与业务库零耦合 ============ */
    {
      const src = fs.readFileSync(WORKER_SRC, 'utf8');
      check('G1 Worker 源码不引用 IndexedDB / Dexie / localStorage',
        ['indexedDB', 'Dexie', 'localStorage'].every(k => src.indexOf(k) < 0), true);
      check('G2 Worker 不 import 任何应用模块', src.indexOf('import ') === -1 || /import\s*$/.test('') || src.match(/^import\s/m) === null, true);
      check('G3 不记录凭据相关变量值（Cf-Access 只作头部名出现，恰好两处：CORS 声明 + 读取）',
        (src.match(/Cf-Access-Jwt-Assertion/g) || []).length === 2, true);
    }

    /* ============ M1：并发日志隔离与原生输出 ============ */
    {
      const logEnv = newV2Env().env;
      const pair = await Promise.all([
        call('/api/backup/status', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': goodToken } }),
        call('/api/backup/v2/status', v2Opts('GET'), logEnv)
      ]);
      const v1r = pair[0];
      const v2r = pair[1];
      check('M1a 并发请求日志各自隔离，不串线',
        v1r.logs.length > 0 && v2r.logs.length > 0 &&
        v1r.logs.every(l => l.indexOf('/api/backup/v2/') < 0) &&
        v2r.logs.every(l => l.indexOf('/api/backup/v2/status') >= 0) &&
        v1r.logs.some(l => l.indexOf('GET /api/backup/status -> 200') >= 0),
        { v1: v1r.logs, v2: v2r.logs });
      check('M1b 并发结束后没有残留日志上下文', LOG_ALS.getStore() === undefined,
        { hasStore: !!LOG_ALS.getStore() });
      NATIVE_SINK.current = [];
      console.log('M1-probe');
      const probe = NATIVE_SINK.current.slice();
      NATIVE_SINK.current = null;
      eq('M1c 无请求上下文的日志仍走原生输出（PASS/FAIL/TOTAL 可见）', probe, ['M1-probe']);
    }

    /* ============ V：v2 pointer / immutable object / CAS ============ */
    {
      const s = newV2Env();
      const v2Env = s.env;
      const r2v2 = s.r2;

      let r = await putObject(v2Env, await makeObjectRequest('unused'));
      eq('V0 无协议头请求不得进入 v2 对象接口', await (async () => {
        const noProto = await call('/api/backup/v2/object', {
          method: 'PUT',
          headers: { 'Cf-Access-Jwt-Assertion': goodToken, 'Content-Type': 'application/json', 'Origin': ORIGIN },
          body: '{}'
        }, v2Env);
        return [noProto.res.status, JSON.parse(noProto.text).error];
      })(), [400, 'protocol-required']);

      /* legacy 写入先放到同一隔离桶里，用来验证 v2 不覆盖它 */
      r = await call('/api/backup', {
        method: 'PUT',
        headers: { 'Cf-Access-Jwt-Assertion': goodToken, 'Content-Type': 'application/json', 'Origin': ORIGIN },
        body: BACKUP_BODY
      }, v2Env);
      eq('V1 legacy v1 上传成功', r.res.status, 200);

      let st = await v2Status(v2Env);
      eq('V2 初始无 v2 pointer', [st.res.status, JSON.parse(st.text).hasPointer], [200, false]);

      const reqA = await makeObjectRequest('A');
      r = await putObject(v2Env, reqA);
      const objectBody = JSON.parse(r.text);
      eq('V3 不可变对象写入成功但不等于 pointer 提交', [r.res.status, objectBody.pointerCommitted], [200, false]);
      check('V3b 对象写入使用隔离 key', r2v2.keys().indexOf(reqA.immutable.objectKey) >= 0, r2v2.keys());
      const objA = await r2v2.get(reqA.immutable.objectKey);
      check('V3c Stub ETag 格式与真实 R2 一致（etag 无引号 / httpEtag 有引号）',
        /^stub-etag-\d+$/.test(objA.etag) && objA.httpEtag === '"' + objA.etag + '"',
        { etag: objA.etag, httpEtag: objA.httpEtag });

      r = await putObject(v2Env, reqA);
      eq('V4 重复对象写入幂等', [r.res.status, JSON.parse(r.text).idempotent], [200, true]);

      /* 同一 objectKey（同 writeId）不同内容：必须冲突，不能覆盖不可变对象 */
      const reqADiff = await makeObjectRequest('A-different', { writeId: reqA.immutable.writeId });
      r = await putObject(v2Env, reqADiff);
      eq('V4b 相同 writeId 不同内容返回对象冲突', [r.res.status, JSON.parse(r.text).error], [409, 'object-conflict']);
      const afterDiff = await r2v2.get(reqA.immutable.objectKey);
      check('V4c 冲突后不可变对象未被覆盖', (await afterDiff.text()) === reqA.payloadText, { len: (await afterDiff.text()).length });

      const badImmutable = await makeObjectRequest('bad-immutable', { immutableHash: 'sha256-wrong' });
      r = await putObject(v2Env, badImmutable);
      eq('V5 immutableHash 不匹配被拒绝', [r.res.status, JSON.parse(r.text).error], [400, 'immutable-hash-mismatch']);

      const badPayload = await makeObjectRequest('bad-payload', { payloadHash: 'sha256-wrong' });
      r = await putObject(v2Env, badPayload);
      eq('V5b payloadHash 不匹配被拒绝', [r.res.status, JSON.parse(r.text).error], [400, 'payload-hash-mismatch']);

      /* Stub 自身语义：只接受官方条件字段；条件失败返回 null，不抛异常 */
      const scratchR2 = newV2Env().r2;
      const scratchKey = 'test/scratch-' + randomUUID();
      let rejected = false;
      try { await scratchR2.put(scratchKey, 'v', { onlyIf: { ifMatch: '"x"' } }); }
      catch (e) { rejected = /unsupported-onlyIf-field/.test(e.message); }
      check('V5c Stub 拒绝非官方 onlyIf 字段（fail closed）', rejected, { rejected });
      const scratchFirst = await scratchR2.put(scratchKey, 'v1');
      const scratchMatch = await scratchR2.put(scratchKey, 'v2', { onlyIf: { etagMatches: scratchFirst.etag } });
      check('V5d Stub 支持官方 etagMatches 条件写', !!scratchMatch && scratchMatch.etag !== scratchFirst.etag, { scratchMatch });
      eq('V5e Stub 条件不满足返回 null（不抛异常）',
        await scratchR2.put(scratchKey, 'v3', { onlyIf: { etagMatches: scratchFirst.etag } }), null);
      const createKey = 'test/create-' + randomUUID();
      check('V5f Stub 支持 Headers If-None-Match:* 创建',
        !!(await scratchR2.put(createKey, 'v', { onlyIf: new Headers({ 'If-None-Match': '*' }) })), true);
      eq('V5g 已存在对象用 If-None-Match:* 写入返回 null',
        await scratchR2.put(createKey, 'v', { onlyIf: new Headers({ 'If-None-Match': '*' }) }), null);
      const workerSrc = fs.readFileSync(WORKER_SRC, 'utf8');
      check('V5h Worker 源码不再使用 ifMatch / ifNoneMatch 条件字段',
        !/ifMatch|ifNoneMatch/.test(workerSrc), true);

      r = await putPointer(v2Env, pointerFrom(reqA.immutable, 1), { revision: 0, etag: null });
      const pointer1 = JSON.parse(r.text);
      eq('V6 首次 pointer 初始化成功', [r.res.status, pointer1.revision, pointer1.idempotent], [200, 1, false]);
      check('V6b pointer 使用独立 key', r2v2.keys().indexOf('earthonline/backups/v2/pointer.json') >= 0, r2v2.keys());
      const stInit = JSON.parse((await v2Status(v2Env)).text);
      eq('V6c 写入响应 ETag 与 status ETag 一致且带引号', stInit.etag, pointer1.etag);
      check('V6d ETag 为 HTTP 引号形式', /^"stub-etag-\d+"$/.test(pointer1.etag), pointer1.etag);

      r = await putPointer(v2Env, pointerFrom(reqA.immutable, 1), { revision: 0, etag: null });
      eq('V7 已存在 pointer 时重复初始化幂等', [r.res.status, JSON.parse(r.text).idempotent], [200, true]);

      /* protocol-less 的 v1 请求不能改 v2 pointer */
      r = await call('/api/backup', {
        method: 'PUT',
        headers: { 'Cf-Access-Jwt-Assertion': goodToken, 'Content-Type': 'application/json', 'Origin': ORIGIN },
        body: BODY2
      }, v2Env);
      eq('V8 protocol-less v1 PUT 仍成功', r.res.status, 200);
      st = await v2Status(v2Env);
      const afterLegacy = JSON.parse(st.text);
      eq('V8b protocol-less 请求未修改 v2 pointer', [afterLegacy.revision, afterLegacy.etag], [1, pointer1.etag]);

      r = await call('/api/backup', { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': goodToken } }, v2Env);
      check('V9 v2 操作未覆盖 legacy 对象', r.text === BODY2, { len: r.text.length });

      /* 正常 CAS：rev1 -> rev2 */
      const reqB = await makeObjectRequest('B');
      await putObject(v2Env, reqB);
      r = await putPointer(v2Env, pointerFrom(reqB.immutable, 2), { revision: 1, etag: pointer1.etag });
      const pointer2 = JSON.parse(r.text);
      eq('V10 CAS 正常成功', [r.res.status, pointer2.revision], [200, 2]);

      /* 旧版本 CAS 失败且 pointer 不变：用一个不同目标的 rev2 请求，避免命中幂等分支 */
      const reqStale = await makeObjectRequest('stale');
      await putObject(v2Env, reqStale);
      r = await putPointer(v2Env, pointerFrom(reqStale.immutable, 2), { revision: 1, etag: pointer1.etag });
      eq('V11 CAS 旧版本不匹配', [r.res.status, JSON.parse(r.text).error], [409, 'cas-conflict']);
      st = await v2Status(v2Env);
      const afterStale = JSON.parse(st.text);
      eq('V11b CAS 失败时 pointer 保持原值', [afterStale.revision, afterStale.etag], [2, pointer2.etag]);

      /* 两个并发 CAS：只有一个成功 */
      const reqC = await makeObjectRequest('C');
      const reqD = await makeObjectRequest('D');
      await putObject(v2Env, reqC);
      await putObject(v2Env, reqD);
      const casPair = await Promise.all([
        putPointer(v2Env, pointerFrom(reqC.immutable, 3), { revision: 2, etag: pointer2.etag }),
        putPointer(v2Env, pointerFrom(reqD.immutable, 3), { revision: 2, etag: pointer2.etag })
      ]);
      const casStatuses = casPair.map(x => x.res.status).sort();
      eq('V12 两个并发 CAS 只有一个成功', casStatuses, [200, 409]);
      st = await v2Status(v2Env);
      eq('V12b 并发 CAS 后 revision 只推进一次', JSON.parse(st.text).revision, 3);

      /* ETag 完整 round-trip：写入响应 -> status -> 客户端回传 -> CAS -> status */
      const reqRT = await makeObjectRequest('roundtrip');
      await putObject(v2Env, reqRT);
      const stRT = JSON.parse((await v2Status(v2Env)).text);
      r = await putPointer(v2Env, pointerFrom(reqRT.immutable, stRT.revision + 1),
        { revision: stRT.revision, etag: stRT.etag });
      const rtResp = JSON.parse(r.text);
      eq('V10b ETag round-trip：status ETag 回传后 CAS 成功',
        [r.res.status, rtResp.revision], [200, stRT.revision + 1]);
      const stRT2 = JSON.parse((await v2Status(v2Env)).text);
      eq('V10c CAS 响应 ETag 与后续 status ETag 一致', stRT2.etag, rtResp.etag);

      /* writeId 不匹配（模拟对象 metadata 被篡改） */
      const reqE = await makeObjectRequest('E');
      await putObject(v2Env, reqE);
      const objE = await r2v2.get(reqE.immutable.objectKey);
      const badMeta = Object.assign({}, objE.customMetadata, { writeId: 'other-id' });
      await r2v2.put(reqE.immutable.objectKey, reqE.payloadText, { customMetadata: badMeta });
      const current = JSON.parse((await v2Status(v2Env)).text);
      r = await putPointer(v2Env, pointerFrom(reqE.immutable, current.revision + 1),
        { revision: current.revision, etag: current.etag });
      eq('V13 writeId 不匹配被拒绝', [r.res.status, JSON.parse(r.text).error], [409, 'write-id-mismatch']);

      /* 对象写成功但 pointer 更新失败 */
      const reqF = await makeObjectRequest('F');
      r = await putObject(v2Env, reqF);
      eq('V14 对象已成功写入', r.res.status, 200);
      const beforeFailedPointer = JSON.parse((await v2Status(v2Env)).text);
      r = await putPointer(v2Env, pointerFrom(reqF.immutable, beforeFailedPointer.revision + 1),
        { revision: beforeFailedPointer.revision, etag: '"stub-etag-nope"' });
      eq('V14b pointer 更新失败', [r.res.status, JSON.parse(r.text).error], [409, 'cas-conflict']);
      const failResp = JSON.parse(r.text);
      check('V14d 失败响应不含成功标记或 pointer', failResp.ok === false && !('pointer' in failResp), failResp);
      eq('V14e 对象写入响应明确 pointerCommitted:false',
        JSON.parse((await putObject(v2Env, reqF)).text).pointerCommitted, false);
      const afterFailedPointer = JSON.parse((await v2Status(v2Env)).text);
      eq('V14c 对象成功但 pointer 失败时不改变 pointer',
        [afterFailedPointer.revision, afterFailedPointer.etag],
        [beforeFailedPointer.revision, beforeFailedPointer.etag]);
    }

    /* 两个并发初始化：空 pointer 下只能有一个成功 */
    {
      const s = newV2Env();
      const req1 = await makeObjectRequest('init-1');
      const req2 = await makeObjectRequest('init-2');
      await putObject(s.env, req1);
      await putObject(s.env, req2);
      const pair = await Promise.all([
        putPointer(s.env, pointerFrom(req1.immutable, 1), { revision: 0, etag: null }),
        putPointer(s.env, pointerFrom(req2.immutable, 1), { revision: 0, etag: null })
      ]);
      const statuses = pair.map(x => x.res.status).sort();
      eq('V15 两个并发初始化只有一个成功', statuses, [200, 409]);
      const st2 = await v2Status(s.env);
      eq('V15b 并发初始化后 revision=1', JSON.parse(st2.text).revision, 1);
    }

    /* ============ V16：put() -> null 必须被当作条件写失败（不依赖异常模拟） ============ */
    {
      const s = newV2Env();
      const r2n = s.r2;
      const envn = s.env;
      const POINTER_KEY = 'earthonline/backups/v2/pointer.json';

      const reqObj = await makeObjectRequest('null-object');
      r2n.nullConditionalKey = reqObj.immutable.objectKey;
      let r = await putObject(envn, reqObj);
      eq('V16 对象条件写返回 null → 409 object-conflict',
        [r.res.status, JSON.parse(r.text).error], [409, 'object-conflict']);
      check('V16b 冲突后对象未落盘', r2n.keys().indexOf(reqObj.immutable.objectKey) < 0, r2n.keys());
      eq('V16c 冲突后仍无 pointer', JSON.parse((await v2Status(envn)).text).hasPointer, false);

      r2n.nullConditionalKey = null;
      r = await putObject(envn, reqObj);
      eq('V16d 注入解除后对象可正常写入', r.res.status, 200);
      const objectEtag = JSON.parse(r.text).stored.etag;
      r = await putPointer(envn, pointerFrom(reqObj.immutable, 1), { revision: 0, etag: null });
      const initResp = JSON.parse(r.text);
      eq('V16e pointer 初始化成功', [r.res.status, initResp.revision], [200, 1]);

      const reqCas = await makeObjectRequest('null-pointer');
      await putObject(envn, reqCas);
      r2n.nullConditionalKey = POINTER_KEY;  /* 模拟 Worker 读后、put 前发生竞态 */
      r = await putPointer(envn, pointerFrom(reqCas.immutable, 2), { revision: 1, etag: initResp.etag });
      eq('V16f pointer 条件写返回 null → 409 cas-conflict',
        [r.res.status, JSON.parse(r.text).error], [409, 'cas-conflict']);
      const afterNull = JSON.parse((await v2Status(envn)).text);
      eq('V16g null 后 pointer 保持原值与原 ETag', [afterNull.revision, afterNull.etag], [1, initResp.etag]);

      r2n.nullConditionalKey = null;
      r = await putPointer(envn, pointerFrom(reqCas.immutable, 2), { revision: 1, etag: initResp.etag });
      eq('V16h 同一请求在注入解除后 CAS 成功', [r.res.status, JSON.parse(r.text).revision], [200, 2]);

      /* ETag 格式不一致必须 fail closed */
      r = await putPointer(envn, pointerFrom(reqCas.immutable, 3), { revision: 2, etag: 'stub-etag-unquoted' });
      eq('V16i 未加引号的 ETag 被拒绝', [r.res.status, JSON.parse(r.text).error], [400, 'bad-expected']);
      r = await putPointer(envn, pointerFrom(reqCas.immutable, 3), { revision: 2, etag: 'W/strong-smuggling' });
      eq('V16j 非法弱 ETag 被拒绝', [r.res.status, JSON.parse(r.text).error], [400, 'bad-expected']);
      const finalSt = JSON.parse((await v2Status(envn)).text);
      eq('V16k 格式非法请求不推进 revision', finalSt.revision, 2);
      check('V16l 对象写入 ETag 与 pointer/ status 均为同一引号格式',
        /^"stub-etag-\d+"$/.test(objectEtag) && /^"stub-etag-\d+"$/.test(finalSt.etag),
        { objectEtag, pointerEtag: finalSt.etag });

      /* protocol-less v1 请求只访问 legacy 路径 */
      r = await call('/api/backup', {
        method: 'PUT',
        headers: { 'Cf-Access-Jwt-Assertion': goodToken, 'Content-Type': 'application/json' },
        body: BODY2
      }, envn);
      eq('V16m protocol-less v1 PUT 仍成功且只写 legacy', r.res.status, 200);
      check('V16n v1 请求未新增 v2 对象或改变 pointer key',
        r2n.keys().indexOf('earthonline/backup-latest.json') >= 0 &&
        r2n.keys().indexOf(POINTER_KEY) >= 0 && r2n.keys().length === 4,
        r2n.keys());
      const afterV1 = JSON.parse((await v2Status(envn)).text);
      eq('V16o v1 请求后 pointer 未变', [afterV1.revision, afterV1.etag], [2, finalSt.etag]);
    }

    /* ============ W：Stub 严格 ETag 语义（quoted / weak / 比较方向） ============ */
    {
      const r2s = makeR2Stub();
      const key = 'test/etag-' + randomUUID();
      const first = await r2s.put(key, 'v1');
      check('W0 Stub 生成强 quoted httpEtag 与裸 etag',
        first.httpEtag === '"' + first.etag + '"' && !/^W\//.test(first.etag), first);

      const matched = await r2s.put(key, 'v2', { onlyIf: new Headers({ 'If-Match': first.httpEtag }) });
      check('W1 合法 quoted ETag 可通过 If-Match 强比较', !!matched, { matched });

      const current = await r2s.get(key);
      let unquotedError = null;
      try {
        await r2s.put(key, 'v3', { onlyIf: new Headers({ 'If-Match': current.etag }) });
      } catch (e) { unquotedError = e.message; }
      check('W2 未加引号的 If-Match 被 fail closed 拒绝',
        unquotedError === 'if-match-format-invalid', { unquotedError });

      const weakMatch = await r2s.put(key, 'v4', { onlyIf: new Headers({ 'If-Match': 'W/' + current.httpEtag }) });
      eq('W3 弱 ETag 不能通过 If-Match 强比较', weakMatch, null);

      const weakNoneMatch = await r2s.put(key, 'v5', { onlyIf: new Headers({ 'If-None-Match': 'W/' + current.httpEtag }) });
      eq('W4 If-None-Match 弱比较：弱 quoted ETag 命中也拒绝', weakNoneMatch, null);

      const otherNoneMatch = await r2s.put(key, 'v6', { onlyIf: new Headers({ 'If-None-Match': '"other-etag"' }) });
      check('W5 If-None-Match 不匹配时允许写入', !!otherNoneMatch, { otherNoneMatch });

      const createKey = 'test/etag-create-' + randomUUID();
      const created = await r2s.put(createKey, 'v', { onlyIf: new Headers({ 'If-None-Match': '*' }) });
      const createdAgain = await r2s.put(createKey, 'v', { onlyIf: new Headers({ 'If-None-Match': '*' }) });
      check('W6 If-None-Match:* 仍表示仅创建', !!created && createdAgain === null, { created, createdAgain });
    }

    /* ============ C：确定性并发（put 屏障保证两个请求都通过预读后才进入条件写） ============ */
    {
      const POINTER_KEY = 'earthonline/backups/v2/pointer.json';
      const s = newV2Env();
      const req1 = await makeObjectRequest('gate-init-1');
      const req2 = await makeObjectRequest('gate-init-2');
      await putObject(s.env, req1);
      await putObject(s.env, req2);

      s.r2.putGate.arm(POINTER_KEY, 2, 3000);
      const pair = await Promise.all([
        putPointer(s.env, pointerFrom(req1.immutable, 1), { revision: 0, etag: null }),
        putPointer(s.env, pointerFrom(req2.immutable, 1), { revision: 0, etag: null })
      ]);
      s.r2.putGate.abort();

      eq('C1 屏障下并发初始化只有一个成功', pair.map(x => x.res.status).sort(), [200, 409]);
      check('C1b 屏障确实等到两个写请求（未超时）', s.r2.putGate.timedOut === false,
        { timedOut: s.r2.putGate.timedOut });
      const initLoser = pair.filter(x => x.res.status === 409).map(x => JSON.parse(x.text));
      eq('C1c 失败请求返回 cas-conflict', initLoser.map(b => [b.ok, b.error]), [[false, 'cas-conflict']]);
      check('C1f 失败来自条件写返回 null（而非预读比较）',
        !('currentRevision' in initLoser[0]), initLoser[0]);
      const initWinner = pair.filter(x => x.res.status === 200).map(x => JSON.parse(x.text))[0];
      const st1 = JSON.parse((await v2Status(s.env)).text);
      eq('C1d revision 只推进一次', st1.revision, 1);
      eq('C1e 最终 pointer 与成功请求一致', st1.pointer.writeId, initWinner.pointer.writeId);
    }
    {
      const POINTER_KEY = 'earthonline/backups/v2/pointer.json';
      const s = newV2Env();
      const base = await makeObjectRequest('gate-base');
      await putObject(s.env, base);
      const init = await putPointer(s.env, pointerFrom(base.immutable, 1), { revision: 0, etag: null });
      const p1 = JSON.parse(init.text);
      eq('C2a 基线 pointer 初始化成功', [init.res.status, p1.revision], [200, 1]);

      const left = await makeObjectRequest('gate-left');
      const right = await makeObjectRequest('gate-right');
      await putObject(s.env, left);
      await putObject(s.env, right);

      s.r2.putGate.arm(POINTER_KEY, 2, 3000);
      const pair = await Promise.all([
        putPointer(s.env, pointerFrom(left.immutable, 2), { revision: 1, etag: p1.etag }),
        putPointer(s.env, pointerFrom(right.immutable, 2), { revision: 1, etag: p1.etag })
      ]);
      s.r2.putGate.abort();

      eq('C2b 屏障下并发 CAS 只有一个成功', pair.map(x => x.res.status).sort(), [200, 409]);
      check('C2c 屏障确实等到两个写请求（未超时）', s.r2.putGate.timedOut === false,
        { timedOut: s.r2.putGate.timedOut });
      const casLoser = pair.filter(x => x.res.status === 409).map(x => JSON.parse(x.text))[0];
      eq('C2d 失败请求返回 cas-conflict 且 ok:false', [casLoser.ok, casLoser.error], [false, 'cas-conflict']);
      check('C2g 失败来自条件写返回 null（而非预读比较）',
        !('currentRevision' in casLoser), casLoser);
      const casWinner = pair.filter(x => x.res.status === 200).map(x => JSON.parse(x.text))[0];
      const st2 = JSON.parse((await v2Status(s.env)).text);
      eq('C2e revision 只推进一次', st2.revision, 2);
      eq('C2f 最终 pointer 与成功请求一致', st2.pointer.writeId, casWinner.pointer.writeId);
    }

    /* ============ E：ETag 缺失与弱 ETag 的 Worker 边界 ============ */
    {
      const s = newV2Env();
      const req = await makeObjectRequest('etag-missing-object');
      s.r2.suppressPutEtag = true;
      let r = await putObject(s.env, req);
      eq('E1 对象写成功但缺 ETag → 502 不报成功',
        [r.res.status, JSON.parse(r.text).ok, JSON.parse(r.text).error], [502, false, 'storage-error']);
      check('E1b 对象实际已落盘（与真实写入一致）',
        s.r2.keys().indexOf(req.immutable.objectKey) >= 0, s.r2.keys());
      s.r2.suppressPutEtag = false;

      r = await putPointer(s.env, pointerFrom(req.immutable, 1), { revision: 0, etag: null });
      const p1 = JSON.parse(r.text);
      eq('E2 pointer 初始化成功', [r.res.status, p1.revision], [200, 1]);

      const req2 = await makeObjectRequest('etag-missing-pointer');
      await putObject(s.env, req2);
      s.r2.suppressPutEtag = true;
      r = await putPointer(s.env, pointerFrom(req2.immutable, 2), { revision: 1, etag: p1.etag });
      const e3 = JSON.parse(r.text);
      eq('E3 pointer 写成功但缺 ETag → 502 不报 pointer 更新成功', [r.res.status, e3.ok, e3.error], [502, false, 'storage-error']);
      check('E3b 失败响应不含 pointer / revision', !('pointer' in e3) && !('revision' in e3), e3);
      s.r2.suppressPutEtag = false;
      const stAfter = JSON.parse((await v2Status(s.env)).text);
      eq('E3c pointer 实际已写入，状态与存储一致', stAfter.revision, 2);

      s.r2.suppressGetEtag = true;
      r = await v2Status(s.env);
      eq('E4 status 读到缺 ETag 的 pointer → 502 fail closed',
        [r.res.status, JSON.parse(r.text).ok, JSON.parse(r.text).error], [502, false, 'storage-error']);
      s.r2.suppressGetEtag = false;

      s.r2.weakEtagReads = true;
      r = await v2Status(s.env);
      eq('E5 status 读到弱 ETag → 502 fail closed',
        [r.res.status, JSON.parse(r.text).error], [502, 'storage-error']);
      s.r2.weakEtagReads = false;

      r = await putPointer(s.env, pointerFrom(req2.immutable, 3), { revision: 2, etag: 'W/"stub-etag-1"' });
      eq('E6 expected.etag 为弱 ETag 时 400 拒绝',
        [r.res.status, JSON.parse(r.text).error], [400, 'bad-expected']);

      r = await v2Status(s.env);
      eq('E7 清除注入后 status 恢复正常', [r.res.status, JSON.parse(r.text).hasPointer], [200, true]);
    }
  } catch (e) {
    R.fatal = String((e && e.stack) || e);
    console.log('FATAL ' + R.fatal);
  } finally {
    jwksServer.close();
  }

  R.pass = R.checks.filter(c => c.ok).length;
  R.fail = R.checks.filter(c => !c.ok).length;
  R.total = R.checks.length;
  fs.writeFileSync(path.join(__dirname, 'c2-cloud-backup-result.json'), JSON.stringify(R, null, 1));
  console.log('PASS=' + R.pass + ' FAIL=' + R.fail + ' TOTAL=' + R.total);
  if (R.fail > 0 || R.fatal) process.exit(1);
}

main().catch(e => { console.error('MAIN', e); process.exit(1); });
