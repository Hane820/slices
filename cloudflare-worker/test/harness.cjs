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

const WORKER_SRC = path.join(__dirname, '..', 'src', 'index.js');

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

/* 内存 R2 桩：实现 Worker 用到的 put/get/head 语义，可注入故障 */
function makeR2Stub() {
  const store = new Map();
  const stub = {
    failMode: null,
    async put(key, value, opts) {
      if (stub.failMode === 'put' || stub.failMode === 'all') throw new Error('r2-unavailable');
      const bytes = new TextEncoder().encode(value).length;
      store.set(key, { value: value, bytes: bytes, opts: opts || {}, uploaded: new Date() });
      return { uploaded: new Date() };
    },
    async get(key) {
      if (stub.failMode === 'get' || stub.failMode === 'all') throw new Error('r2-unavailable');
      const o = store.get(key);
      if (!o) return null;
      return {
        body: o.value,
        size: o.bytes,
        uploaded: o.uploaded,
        httpEtag: '"stub-etag"',
        customMetadata: o.opts.customMetadata || {},
        bodyUsed: false
      };
    },
    async head(key) {
      if (stub.failMode === 'head' || stub.failMode === 'all') throw new Error('r2-unavailable');
      const o = store.get(key);
      if (!o) return null;
      return { size: o.bytes, uploaded: o.uploaded, customMetadata: o.opts.customMetadata || {} };
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

  const LOG_SINK = { current: null };  /* F 组：跨 call() 收集 Worker 日志 */
  function call(path, opts) {
    const req = new Request('https://backup.example.com' + path, opts || { method: 'GET' });
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => { const line = a.map(String).join(' '); logs.push(line); if (LOG_SINK.current) LOG_SINK.current.push(line); };
    return worker.fetch(req, env, {}).finally(() => { console.log = origLog; return logs; })
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
        [204, 'GET, PUT, OPTIONS', 'Content-Type, Cf-Access-Jwt-Assertion', 'true']);
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
  if (R.fail > 0) process.exit(1);
}

main().catch(e => { console.error('MAIN', e); process.exit(1); });
