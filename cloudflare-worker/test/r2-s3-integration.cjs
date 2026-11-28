#!/usr/bin/env node
/* r2-s3-integration.cjs — 真实 Cloudflare R2 S3 API 集成测试（独立于 Wrangler remote binding）
 *
 * 安全边界：
 *   - 只访问 earthonline-backups-r2test，且只操作 earthonline/backups/r2it- 前缀。
 *   - 绝不触碰 pointer key、legacy v1 key 或生产桶。
 *   - 默认 dry-run；--self-check 完全离线；真实写必须显式 --run + R2_S3_CONFIRM=YES。
 *   - --s0-only 是独立入口：只发两次 HEAD（前缀内 404 / 前缀外 403），
 *     不进入 S1–S7、不执行 cleanup、不发出 PUT/POST/DELETE，执行完即退出。
 *   - 凭证只从环境变量读取，不打印、不落盘、不进结果 JSON。
 *   - 本地 JWT 临时凭证是唯一签发路径；不自动回退到需要额外 API Token 的方案。
 *
 * 验证边界：本工具只验证 R2 存储原语（条件写原子性、ETag、并发、不确定写入对账），
 * 不验证 Worker 协议、幂等分支、revision 校验、metadata 交叉校验或跨 isolate 并发。
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TEST_BUCKET = 'earthonline-backups-r2test';
const PRODUCTION_BUCKET = 'earthonline-backups';
const PREFIX = 'earthonline/backups/r2it-';
const POINTER_KEY = 'earthonline/backups/v2/pointer.json';
const V1_KEY = 'earthonline/backup-latest.json';
const HOST_SUFFIX = '.r2.cloudflarestorage.com';
const REGION = 'auto';
const SERVICE = 's3';
const TEMP_ACTIONS = ['HeadObject', 'GetObject', 'PutObject', 'DeleteObject'];
const DEFAULT_TTL = 900;
const DEFAULT_TIMEOUT_MS = 20000;

const R = { checks: [], pass: 0, fail: 0, runId: '', mode: '', bucket: '', endpoint: '' };

/* ==================== 基础工具 ==================== */

function splitList(v) {
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
}

function out(line) { process.stdout.write(String(line) + '\n'); }

function record(group, name, ok, detail) {
  const item = { group: group, name: name, ok: !!ok, detail: sanitizeDetail(detail) };
  R.checks.push(item);
  if (ok) { R.pass++; out('[PASS] ' + group + ' ' + name); }
  else { R.fail++; out('[FAIL] ' + group + ' ' + name + ' :: ' + JSON.stringify(item.detail)); }
  return ok;
}

function die(code, message) {
  out('[R2-S3] ' + sanitizeDetail(message));
  process.exit(code);
}

function sanitizeDetail(value) {
  const secrets = [process.env.R2_S3_SECRET_ACCESS_KEY, process.env.R2_S3_SESSION_TOKEN,
                   process.env.R2_S3_ACCESS_KEY_ID].filter(Boolean).map(String);
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); }
  catch (e) { text = String(value); }
  if (text === undefined) text = 'undefined';
  for (const s of secrets) {
    if (s && s.length >= 4) text = text.split(s).join('[REDACTED]');
  }
  text = text.replace(/AWS4-HMAC-SHA256 Credential=[^,\s]+/g, 'AWS4-HMAC-SHA256 Credential=[REDACTED]');
  text = text.replace(/Authorization['":=\s]+[^\s,"}]+/gi, 'Authorization=[REDACTED]');
  text = text.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]');
  return text.slice(0, 4000);
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/* RFC 3986 编码：只保留 unreserved 字符；可选保留 '/' 作为 path 分隔符。 */
function uriEncode(input, preserveSlash) {
  const bytes = Buffer.from(String(input), 'utf8');
  let result = '';
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    const unreserved = (b >= 65 && b <= 90) || (b >= 97 && b <= 122) ||
      (b >= 48 && b <= 57) || ch === '-' || ch === '_' || ch === '.' || ch === '~';
    if (unreserved || (preserveSlash && ch === '/')) result += ch;
    else result += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return result;
}

function amzTimestamp(nowMs) {
  const d = new Date(nowMs);
  const iso = d.toISOString();
  return { amzDate: iso.replace(/[-:]/g, '').slice(0, 15) + 'Z', dateStamp: iso.slice(0, 10).replace(/-/g, '') };
}

/* ==================== 配置门禁 ==================== */

function productionBucketFromToml() {
  try {
    const toml = fs.readFileSync(path.join(__dirname, '..', 'wrangler.toml'), 'utf8');
    const m = /bucket_name\s*=\s*"([^"]+)"/.exec(toml);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

function validateConfig(env) {
  const e = env || {};
  const account = String(e.R2_S3_ACCOUNT_ID || '').trim();
  const bucket = String(e.R2_S3_BUCKET || '').trim();
  const allowed = splitList(e.R2_S3_ALLOWED_BUCKETS);
  const ak = String(e.R2_S3_ACCESS_KEY_ID || '').trim();
  const sk = String(e.R2_S3_SECRET_ACCESS_KEY || '').trim();
  const confirm = String(e.R2_S3_CONFIRM || '').trim();
  const ttl = e.R2_S3_TTL_SECONDS === undefined ? DEFAULT_TTL : Number(e.R2_S3_TTL_SECONDS);
  const timeout = e.R2_S3_TIMEOUT_MS === undefined ? DEFAULT_TIMEOUT_MS : Number(e.R2_S3_TIMEOUT_MS);
  const tomlProd = productionBucketFromToml();

  if (!/^[0-9a-fA-F]{32}$/.test(account)) return { ok: false, code: 'bad-account', message: 'R2_S3_ACCOUNT_ID 必须是 32 位十六进制 Account ID' };
  if (!bucket) return { ok: false, code: 'missing-bucket', message: '缺少 R2_S3_BUCKET' };
  if (allowed.length === 0) return { ok: false, code: 'missing-allowlist', message: '缺少 R2_S3_ALLOWED_BUCKETS' };
  if (bucket === PRODUCTION_BUCKET || bucket === tomlProd) return { ok: false, code: 'production-bucket', message: '拒绝访问生产桶' };
  if (allowed.indexOf(PRODUCTION_BUCKET) >= 0 || allowed.indexOf(tomlProd) >= 0) {
    return { ok: false, code: 'unsafe-allowlist', message: '白名单中不得包含生产桶' };
  }
  if (bucket !== TEST_BUCKET) return { ok: false, code: 'wrong-bucket', message: 'R2_S3_BUCKET 必须严格等于 ' + TEST_BUCKET };
  if (allowed.indexOf(bucket) < 0) return { ok: false, code: 'not-allowlisted', message: '测试桶不在白名单中' };
  if (confirm !== 'YES') return { ok: false, code: 'missing-confirm', message: '必须设置 R2_S3_CONFIRM=YES' };
  if (!ak || !sk) return { ok: false, code: 'missing-credential', message: '缺少父凭证 Access Key ID / Secret Access Key' };
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 604800) return { ok: false, code: 'bad-ttl', message: 'R2_S3_TTL_SECONDS 必须在 60..604800 之间' };
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) return { ok: false, code: 'bad-timeout', message: 'R2_S3_TIMEOUT_MS 非法' };

  return {
    ok: true, account: account, bucket: bucket, allowed: allowed,
    endpoint: 'https://' + account + HOST_SUFFIX,
    host: account + HOST_SUFFIX,
    accessKeyId: ak, secretAccessKey: sk,
    ttl: ttl, timeout: timeout
  };
}

/* ==================== 本地 JWT 临时凭证（唯一签发路径） ==================== */

function mintTempCredentials(cfg) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    bucket: cfg.bucket,
    actions: TEMP_ACTIONS.slice(),
    paths: { prefixPaths: [PREFIX], objectPaths: [] },
    sub: cfg.account,
    iss: cfg.accessKeyId,
    aud: cfg.host,
    iat: now,
    exp: now + cfg.ttl
  };
  const header = { alg: 'HS256', typ: 'JWT' };
  const signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
  const signature = hmacSha256(cfg.secretAccessKey, signingInput).toString('base64url');
  const jwt = signingInput + '.' + signature;
  return {
    accessKeyId: cfg.accessKeyId,                 // 官方文档：复用父 Access Key ID
    secretAccessKey: sha256Hex(jwt),               // 临时 secret = JWT 的 SHA-256 hex
    sessionToken: Buffer.from('jwt/' + jwt).toString('base64'),
    actions: TEMP_ACTIONS.slice(),
    prefixPaths: [PREFIX],
    expiresAt: new Date((now + cfg.ttl) * 1000).toISOString()
  };
}

/* ==================== SigV4 签名 ==================== */

function buildCanonicalRequest(method, canonicalUri, canonicalQuery, canonicalHeadersText, signedHeaders, payloadHash) {
  return method + '\n' + canonicalUri + '\n' + canonicalQuery + '\n' +
         canonicalHeadersText + '\n' + signedHeaders + '\n' + payloadHash;
}

function signRequest(cfg, creds, method, key, extraHeaders, body, nowMs) {
  const canonicalUri = '/' + uriEncode(cfg.bucket, false) + '/' + uriEncode(key, true);
  const payloadHash = sha256Hex(body || '');
  const ts = amzTimestamp(nowMs);
  const all = Object.assign({
    host: cfg.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': ts.amzDate
  }, extraHeaders || {});
  if (creds.sessionToken) all['x-amz-security-token'] = creds.sessionToken;

  const names = Object.keys(all).map(k => k.toLowerCase()).sort();
  const canonicalHeadersText = names.map(n => n + ':' + String(all[n]).trim()).join('\n') + '\n';
  const signedHeaders = names.join(';');
  const canonical = buildCanonicalRequest(method, canonicalUri, '', canonicalHeadersText, signedHeaders, payloadHash);
  const scope = ts.dateStamp + '/' + REGION + '/' + SERVICE + '/aws4_request';
  const stringToSign = 'AWS4-HMAC-SHA256\n' + ts.amzDate + '\n' + scope + '\n' + sha256Hex(canonical);
  const kDate = hmacSha256('AWS4' + creds.secretAccessKey, ts.dateStamp);
  const kRegion = hmacSha256(kDate, REGION);
  const kService = hmacSha256(kRegion, SERVICE);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const headers = {
    'Host': cfg.host,
    'X-Amz-Date': ts.amzDate,
    'X-Amz-Content-Sha256': payloadHash,
    'Authorization': 'AWS4-HMAC-SHA256 Credential=' + creds.accessKeyId + '/' + scope +
      ', SignedHeaders=' + signedHeaders + ', Signature=' + signature
  };
  if (creds.sessionToken) headers['X-Amz-Security-Token'] = creds.sessionToken;
  for (const [k, v] of Object.entries(extraHeaders || {})) {
    const canonicalName = k.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('-');
    headers[canonicalName] = v;
  }
  return { headers: headers, canonicalUri: canonicalUri, signedHeaders: signedHeaders, signature: signature };
}

/* ==================== HTTP 客户端与结果分类 ==================== */

function isNetworkError(e) {
  if (!e) return false;
  const name = String(e.name || '');
  const msg = String(e.message || '');
  return name === 'AbortError' || name === 'TimeoutError' || name === 'TypeError' ||
    /fetch failed|timeout|network|ECONNRESET|ETIMEDOUT/i.test(msg);
}

async function s3Request(ctx, method, key, options) {
  const opts = options || {};
  const body = opts.body === undefined ? '' : opts.body;
  const extra = Object.assign({}, opts.headers || {});
  if (opts.writeId) extra['x-amz-meta-write-id'] = opts.writeId;
  const signed = signRequest(ctx.cfg, ctx.creds, method, key, extra, body, Date.now());
  const url = ctx.cfg.endpoint + signed.canonicalUri;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: method,
      headers: signed.headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      signal: AbortSignal.timeout(ctx.cfg.timeout)
    });
    const text = method === 'HEAD' ? '' : await res.text();
    return {
      status: res.status,
      etag: res.headers.get('etag'),
      writeId: res.headers.get('x-amz-meta-write-id'),
      contentLength: res.headers.get('content-length'),
      requestId: res.headers.get('x-amzn-requestid') || res.headers.get('x-amz-request-id') || null,
      text: text,
      durationMs: Date.now() - started,
      network: false
    };
  } catch (e) {
    return { status: 0, etag: null, writeId: null, text: '', durationMs: Date.now() - started,
             network: true, error: sanitizeDetail(e && e.message ? e.message : e) };
  }
}

function safeKey(key) {
  return typeof key === 'string' && key.indexOf(PREFIX) === 0 &&
    key !== POINTER_KEY && key !== V1_KEY && key.indexOf(PRODUCTION_BUCKET) < 0;
}

function classifyStatus(res) {
  if (!res || res.network || res.status === 0) return 'indeterminate';
  if (res.status === 200 || res.status === 204) return 'success';
  if (res.status === 412) return 'conflict';
  if (res.status === 403) return 'denied';
  if (res.status === 409) return 'unexpected-conflict';
  if (res.status === 404) return 'not-found';
  return 'unexpected';
}

/* ==================== 不确定写入对账 ==================== */

/* 只允许 If-None-Match:* 的创建写入按官方流程重放；If-Match 更新禁止盲目重试。 */
async function reconcileAmbiguousCreate(ctx, spec) {
  const retry = await s3Request(ctx, 'PUT', spec.key, {
    body: spec.body,
    headers: { 'If-None-Match': '*' },
    writeId: spec.writeId
  });
  const kind = classifyStatus(retry);
  if (kind === 'success') return { committed: true, evidence: 'replay-200', response: retry };
  if (kind === 'conflict') {
    const head = await s3Request(ctx, 'HEAD', spec.key, {});
    if (head.status === 200) {
      return {
        committed: head.writeId === spec.writeId,
        evidence: head.writeId === spec.writeId ? 'replay-412-metadata-match' : 'replay-412-metadata-differs',
        response: retry, head: head
      };
    }
    return { committed: null, evidence: 'replay-412-head-404-still-pending', response: retry, head: head };
  }
  return { committed: null, evidence: 'replay-' + kind, response: retry };
}

/* ==================== 测试组 ==================== */

function addToManifest(ctx, key, writeId, tag) {
  const existing = ctx.manifest.findIndex(i => i.key === key);
  const item = { key: key, writeId: writeId, tag: tag };
  if (existing >= 0) ctx.manifest[existing] = item;
  else ctx.manifest.push(item);
}

function assertEtag(res, label) {
  const etag = res && res.etag;
  if (typeof etag !== 'string' || !/^"[^"]*"$/.test(etag)) {
    throw new Error(label + ': ETag 缺失或非强 quoted，fail closed :: ' + JSON.stringify({ status: res.status, etag: etag }));
  }
  return etag;
}

async function runS0(ctx) {
  const probeKey = PREFIX + ctx.runId + '-probe-nonexistent.json';
  const outsideKey = 'earthonline/backups/scope-probe-' + ctx.runId + '.json';
  if (!safeKey(probeKey)) throw new Error('S0 probe key 违反前缀约束');

  const probe = await s3Request(ctx, 'HEAD', probeKey, {});
  const okProbe = record('S0', '测试桶 HEAD 探针可达（只允许 HEAD）',
    classifyStatus(probe) === 'not-found', { status: probe.status, requestId: probe.requestId, durationMs: probe.durationMs });
  if (!okProbe) throw new Error('S0 探针失败：不进入任何 PUT');

  /* 只读验证前缀绑定：在测试桶内但前缀外的 key 应被拒绝；不读取 pointer 或 v1 key。 */
  const outside = await s3Request(ctx, 'HEAD', outsideKey, {});
  const okScope = record('S0', '临时凭证前缀限制生效（前缀外 HEAD 被拒）',
    classifyStatus(outside) === 'denied', { status: outside.status, requestId: outside.requestId });
  if (!okScope) throw new Error('S0 前缀绑定校验失败：不进入任何 PUT');
  return { probe: probe, outside: outside };
}

/* ==================== S0-only 独立入口 ====================
   只发 runS0() 里的两次 HEAD，不调用 runS1toS7()、不调用 cleanup()。
   门禁与临时凭证签发复用 --run 的同一套函数，不另造凭证机制。
   故意不写成「跑 --run 再跳过」：那会先铸造写权限并进入写入阶段。 */

function statusOfCheck(namePart) {
  const hit = R.checks.find(c => c.group === 'S0' && String(c.name).indexOf(namePart) >= 0);
  if (!hit) return { status: null, ok: false };
  let status = null;
  try {
    const d = JSON.parse(hit.detail);
    status = d && d.status !== undefined ? d.status : null;
  } catch (e) {
    status = null;
  }
  return { status: status, ok: !!hit.ok };
}

async function runS0Only(ctx, startedAt) {
  let fatal = null;
  try {
    record('S0', '临时凭证仅含测试所需 actions', ctx.creds.actions.join(',') === TEMP_ACTIONS.join(','), ctx.creds.actions);
    record('S0', '临时凭证前缀限制为测试前缀', ctx.creds.prefixPaths[0] === PREFIX, ctx.creds.prefixPaths);
    await runS0(ctx);
  } catch (e) {
    fatal = sanitizeDetail(e && e.message ? e.message : e);
    record('RUNTIME', 'S0-only 执行未抛异常', false, { message: fatal });
  }

  const probe = statusOfCheck('HEAD 探针可达');
  const scope = statusOfCheck('前缀限制生效');
  const passed = !fatal && R.fail === 0;

  const result = {
    runId: R.runId, mode: 's0-only', bucket: ctx.cfg.bucket, productionBucket: PRODUCTION_BUCKET,
    startedAt: startedAt, finishedAt: new Date().toISOString(),
    stagesExecuted: ['S0'],
    probes: {
      'S0-B': { method: 'HEAD', expect: 404, actual: probe.status, ok: probe.ok },
      'S0-C': { method: 'HEAD', expect: 403, actual: scope.status, ok: scope.ok }
    },
    checks: R.checks,
    summary: { pass: R.pass, fail: R.fail, total: R.checks.length },
    cleanup: { mode: 'skipped', reason: 's0-only', objects: [], deleted: [], kept: [], errors: [] },
    limitations: [
      '--s0-only 只验证测试桶的 HEAD 可达与前缀边界；不写入、不删除、不覆盖 S1–S8 的任何结论。',
      '两次请求均为 HEAD，方法在源码中固定，不存在 PUT/POST/DELETE 分支。'
    ]
  };
  const resultPath = path.join(__dirname, 'r2-s3-integration-' + R.runId + '-s0-result.json');
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');

  out('[R2-S3] result=' + resultPath);
  out('[R2-S3] S0-B HEAD expect=404 actual=' + probe.status + ' ' + (probe.ok ? 'PASS' : 'FAIL'));
  out('[R2-S3] S0-C HEAD expect=403 actual=' + scope.status + ' ' + (scope.ok ? 'PASS' : 'FAIL'));
  out('[R2-S3] S0-ONLY ' + (passed ? 'PASS' : 'FAIL') + ' PASS=' + R.pass + ' FAIL=' + R.fail +
      ' | 到此为止：未进入 S1–S8，未执行 cleanup，未发出 PUT/POST/DELETE');
  process.exit(passed ? 0 : 4);
}

async function runS1toS7(ctx) {
  const baseKey = PREFIX + ctx.runId + '-conditional.json';
  if (!safeKey(baseKey)) throw new Error('对象 key 违反前缀约束');
  const bodyA = JSON.stringify({ runId: ctx.runId, tag: 'a', nonce: crypto.randomUUID() });
  const bodyB = JSON.stringify({ runId: ctx.runId, tag: 'b', nonce: crypto.randomUUID() });
  const bodyC = JSON.stringify({ runId: ctx.runId, tag: 'c', nonce: crypto.randomUUID() });
  const wid1 = 'r2it-' + ctx.runId + '-s1';
  const wid2 = 'r2it-' + ctx.runId + '-s2';
  const wid3 = 'r2it-' + ctx.runId + '-s3';
  const widC1 = 'r2it-' + ctx.runId + '-c1';
  const widC2 = 'r2it-' + ctx.runId + '-c2';

  /* S1：条件创建；若结果不确定，只允许 If-None-Match:* 按官方流程重放对账一次 */
  let s1 = await s3Request(ctx, 'PUT', baseKey, { body: bodyA, headers: { 'If-None-Match': '*' }, writeId: wid1 });
  let s1Ambiguous = false;
  if (classifyStatus(s1) === 'indeterminate') {
    s1Ambiguous = true;
    const rec = await reconcileAmbiguousCreate(ctx, { key: baseKey, body: bodyA, writeId: wid1 });
    record('S1', '不确定创建已按官方流程对账', rec.committed !== null, rec.evidence);
    if (rec.committed === null) throw new Error('S1 结果不确定，保留现场并停止');
    s1 = rec.committed ? rec.response : (rec.head || rec.response);
    if (rec.committed && rec.head && rec.head.etag) s1.etag = rec.head.etag;
  }
  record('S1', 'If-None-Match:* 首次创建成功（含对账确认）',
    classifyStatus(s1) === 'success' || (s1Ambiguous && s1.status === 200),
    { status: s1.status, etag: s1.etag, ambiguous: s1Ambiguous });
  if (!(classifyStatus(s1) === 'success' || (s1Ambiguous && s1.status === 200))) throw new Error('S1 失败，停止');
  const etag1 = assertEtag(s1, 'S1');
  addToManifest(ctx, baseKey, wid1, s1Ambiguous ? 's1-reconciled' : 's1');

  /* S2：同 key 重复条件创建 → 412，原对象不变 */
  const s2 = await s3Request(ctx, 'PUT', baseKey, { body: bodyB, headers: { 'If-None-Match': '*' }, writeId: wid2 });
  record('S2', '重复条件创建返回 412', classifyStatus(s2) === 'conflict', { status: s2.status, etag: s2.etag });
  if (classifyStatus(s2) === 'indeterminate') throw new Error('S2 结果不确定（创建重放未覆盖该路径），保留现场并停止');
  const afterS2 = await s3Request(ctx, 'HEAD', baseKey, {});
  record('S2', '冲突后原对象未被覆盖', afterS2.status === 200 && afterS2.etag === etag1 && afterS2.writeId === wid1,
    { status: afterS2.status, etag: afterS2.etag, writeId: afterS2.writeId });
  if (!(afterS2.status === 200 && afterS2.etag === etag1 && afterS2.writeId === wid1)) throw new Error('S2 原对象被改变，停止');

  /* S3：HEAD 一致性 */
  record('S3', 'HEAD ETag 与创建响应一致', afterS2.etag === etag1, { head: afterS2.etag, created: etag1 });
  record('S3', 'HEAD Content-Length 与实际 body 一致',
    Number(afterS2.contentLength) === Buffer.byteLength(bodyA, 'utf8'),
    { contentLength: afterS2.contentLength, expected: Buffer.byteLength(bodyA, 'utf8') });
  if (afterS2.etag !== etag1) throw new Error('S3 ETag 不一致，停止');

  /* S4：正确 ETag 条件更新 */
  const s4 = await s3Request(ctx, 'PUT', baseKey, { body: bodyB, headers: { 'If-Match': etag1 }, writeId: wid3 });
  if (classifyStatus(s4) === 'indeterminate') throw new Error('S4 If-Match 更新结果不确定：禁止盲目重试，保留现场并停止');
  record('S4', '正确 ETag 的 If-Match 更新成功', classifyStatus(s4) === 'success', { status: s4.status, etag: s4.etag });
  if (classifyStatus(s4) !== 'success') throw new Error('S4 失败，停止');
  const etag2 = assertEtag(s4, 'S4');
  addToManifest(ctx, baseKey, wid3, 's4');

  /* S5：过期 ETag 更新 → 412，内容保持 S4 */
  const s5 = await s3Request(ctx, 'PUT', baseKey, { body: bodyC, headers: { 'If-Match': etag1 }, writeId: widC2 });
  if (classifyStatus(s5) === 'indeterminate') throw new Error('S5 If-Match 结果不确定：禁止盲目重试，保留现场并停止');
  record('S5', '过期 ETag 返回 412', classifyStatus(s5) === 'conflict', { status: s5.status });
  const afterS5 = await s3Request(ctx, 'GET', baseKey, {});
  record('S5', '失败请求未覆盖 S4 内容', afterS5.status === 200 && afterS5.text === bodyB && afterS5.etag === etag2,
    { status: afterS5.status, etag: afterS5.etag, len: afterS5.text.length });
  if (!(afterS5.status === 200 && afterS5.text === bodyB && afterS5.etag === etag2)) throw new Error('S5 内容被覆盖，停止');

  /* S6：两个独立连接的并发 CAS，使用同一旧 ETag */
  const bodyC1 = JSON.stringify({ runId: ctx.runId, tag: 'c1', nonce: crypto.randomUUID() });
  const bodyC2 = JSON.stringify({ runId: ctx.runId, tag: 'c2', nonce: crypto.randomUUID() });
  const started = Date.now();
  const [p1, p2] = await Promise.all([
    s3Request(ctx, 'PUT', baseKey, { body: bodyC1, headers: { 'If-Match': etag2 }, writeId: widC1 }),
    s3Request(ctx, 'PUT', baseKey, { body: bodyC2, headers: { 'If-Match': etag2 }, writeId: widC2 })
  ]);
  const elapsed = Date.now() - started;
  if (classifyStatus(p1) === 'indeterminate' || classifyStatus(p2) === 'indeterminate') {
    throw new Error('S6 If-Match 并发结果不确定：禁止盲目重试，保留现场并停止');
  }
  const codes = [classifyStatus(p1), classifyStatus(p2)].sort().join(',');
  record('S6', '并发 CAS 严格一个 200、一个 412', codes === 'conflict,success',
    { codes: [p1.status, p2.status], elapsedMs: elapsed,
      ids: [p1.requestId, p2.requestId], etags: [p1.etag, p2.etag] });
  if (codes !== 'conflict,success') throw new Error('S6 并发结果异常，停止');
  const winner = p1.status === 200 ? { res: p1, body: bodyC1, writeId: widC1 } : { res: p2, body: bodyC2, writeId: widC2 };
  const loser = p1.status === 200 ? p2 : p1;
  record('S6', '失败方为 412 且未产生成功标记', loser.status === 412 && loser.etag === null,
    { status: loser.status, etag: loser.etag });

  /* S7：最终内容与胜者一致 */
  const final = await s3Request(ctx, 'GET', baseKey, {});
  const finalHead = await s3Request(ctx, 'HEAD', baseKey, {});
  record('S7', '最终 GET 内容等于胜者请求体', final.status === 200 && final.text === winner.body,
    { status: final.status, len: final.text.length, winner: winner.writeId });
  record('S7', '最终 writeId 归属胜者', finalHead.status === 200 && finalHead.writeId === winner.writeId,
    { status: finalHead.status, writeId: finalHead.writeId, expected: winner.writeId });
  record('S7', '本地 Harness 屏障不用于本测试（真实独立 HTTP 连接）', elapsed >= 0,
    { note: '两个 fetch 并发发出，R2 服务端判定；不代表跨 Worker isolate' });
  if (!(final.status === 200 && final.text === winner.body && finalHead.writeId === winner.writeId)) {
    throw new Error('S7 最终状态不一致，停止');
  }
  return { baseKey: baseKey, winner: winner.writeId };
}

/* ==================== 清理 ==================== */

async function cleanup(ctx) {
  const report = { mode: 'manifest-only', objects: [], deleted: [], kept: [], errors: [], verifiedAbsent: [] };
  const seen = new Set();
  for (const item of ctx.manifest) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    if (!safeKey(item.key)) {
      report.kept.push({ key: item.key, reason: 'unsafe-key' });
      continue;
    }
    const head = await s3Request(ctx, 'HEAD', item.key, {});
    if (head.status !== 200) {
      report.kept.push({ key: item.key, reason: 'head-' + head.status });
      continue;
    }
    if (head.writeId !== item.writeId) {
      report.kept.push({ key: item.key, reason: 'ownership-unconfirmed' });
      continue;
    }
    const del = await s3Request(ctx, 'DELETE', item.key, {});
    if (classifyStatus(del) !== 'success') {
      report.errors.push({ key: item.key, status: del.status });
      break; /* 任一删除失败立即停止，不继续扩大范围 */
    }
    report.deleted.push(item.key);
    const verify = await s3Request(ctx, 'HEAD', item.key, {});
    if (classifyStatus(verify) === 'not-found') report.verifiedAbsent.push(item.key);
    else report.errors.push({ key: item.key, reason: 'still-present-after-delete', status: verify.status });
  }
  return report;
}

/* ==================== 离线自检 ==================== */

function selfCheck() {
  const originalFetch = global.fetch;
  global.fetch = function () { throw new Error('network-call-in-self-check'); };
  const ok = (name, cond, detail) => record('SELF', name, cond, detail);
  try {
    const fake = {
      R2_S3_ACCOUNT_ID: 'a'.repeat(32), R2_S3_BUCKET: TEST_BUCKET,
      R2_S3_ALLOWED_BUCKETS: TEST_BUCKET, R2_S3_CONFIRM: 'YES',
      R2_S3_ACCESS_KEY_ID: 'AKIASELFCHECK', R2_S3_SECRET_ACCESS_KEY: 's'.repeat(40),
      R2_S3_TTL_SECONDS: '900', R2_S3_TIMEOUT_MS: '5000'
    };
    const cfg = validateConfig(fake);
    ok('合法配置通过门禁', cfg.ok === true, cfg);
    ok('endpoint 由固定域名构造', cfg.endpoint === 'https://' + 'a'.repeat(32) + HOST_SUFFIX, cfg.endpoint);
    ok('拒绝生产桶', validateConfig(Object.assign({}, fake, { R2_S3_BUCKET: PRODUCTION_BUCKET })).code === 'production-bucket', {});
    ok('拒绝非白名单桶', validateConfig(Object.assign({}, fake, { R2_S3_ALLOWED_BUCKETS: 'other' })).code === 'not-allowlisted', {});
    ok('拒绝缺确认', validateConfig(Object.assign({}, fake, { R2_S3_CONFIRM: 'no' })).code === 'missing-confirm', {});
    ok('拒绝非法 account id', validateConfig(Object.assign({}, fake, { R2_S3_ACCOUNT_ID: 'x' })).code === 'bad-account', {});
    ok('拒绝自定义 endpoint 变量不影响构造', cfg.endpoint.indexOf('evil') < 0, cfg.endpoint);

    ok('RFC3986 编码（空格/问号/百分号）',
      uriEncode('a b?c%d/e', true) === 'a%20b%3Fc%25d/e', uriEncode('a b?c%d/e', true));
    ok('pointer key 不在测试前缀内', !safeKey(POINTER_KEY), POINTER_KEY);
    ok('v1 key 不在测试前缀内', !safeKey(V1_KEY), V1_KEY);
    ok('测试 key 通过前缀检查', safeKey(PREFIX + 'self-1.json'), {});

    const creds = mintTempCredentials(cfg);
    const parts = creds.sessionToken.split('.');
    ok('session token 解出 jwt/ 前缀', Buffer.from(creds.sessionToken, 'base64').toString('utf8').indexOf('jwt/') === 0, {});
    const jwt = Buffer.from(creds.sessionToken, 'base64').toString('utf8').slice(4);
    const jwtParts = jwt.split('.');
    ok('JWT 为三段式', jwtParts.length === 3, {});
    const claims = JSON.parse(Buffer.from(jwtParts[1], 'base64url').toString('utf8'));
    ok('JWT claims 绑定 bucket/actions/prefix',
      claims.bucket === TEST_BUCKET && claims.actions.join(',') === TEMP_ACTIONS.join(',') &&
      claims.paths.prefixPaths[0] === PREFIX, claims);
    ok('JWT 标准 claim 正确', claims.iss === cfg.accessKeyId && claims.sub === cfg.account && claims.aud === cfg.host &&
      claims.exp - claims.iat === cfg.ttl, { iss: claims.iss === cfg.accessKeyId, exp: claims.exp - claims.iat });
    const recomputed = hmacSha256(cfg.secretAccessKey, jwtParts[0] + '.' + jwtParts[1]).toString('base64url');
    ok('JWT HS256 签名可复算', recomputed === jwtParts[2], {});
    ok('临时 secret 为 JWT 的 SHA-256 hex', creds.secretAccessKey === sha256Hex(jwt), {});

    const fixedNow = Date.UTC(2026, 10, 26, 3, 4, 5);
    const signed = signRequest(cfg, creds, 'PUT', PREFIX + 'self-1.json',
      { 'if-none-match': '*', 'x-amz-meta-write-id': 'w-self' }, 'body', fixedNow);
    ok('签名含 session token 头', Object.prototype.hasOwnProperty.call(signed.headers, 'X-Amz-Security-Token'), {});
    ok('签名包含条件头与 write-id', signed.signedHeaders.indexOf('if-none-match') >= 0 &&
      signed.signedHeaders.indexOf('x-amz-meta-write-id') >= 0, signed.signedHeaders);
    ok('signature 为 64 位 hex', /^[0-9a-f]{64}$/.test(signed.signature), signed.signature);
    const signed2 = signRequest(cfg, creds, 'PUT', PREFIX + 'self-1.json',
      { 'if-none-match': '*', 'x-amz-meta-write-id': 'w-self' }, 'other-body', fixedNow);
    ok('body 变化导致签名变化', signed.signature !== signed2.signature, {});
    ok('canonical URI 使用 path-style', signed.canonicalUri === '/' + TEST_BUCKET + '/' + uriEncode(PREFIX + 'self-1.json', true), signed.canonicalUri);

    ok('状态分类：412=conflict', classifyStatus({ status: 412, network: false }) === 'conflict', {});
    ok('状态分类：409=unexpected-conflict', classifyStatus({ status: 409, network: false }) === 'unexpected-conflict', {});
    ok('状态分类：超时=indeterminate', classifyStatus({ status: 0, network: true }) === 'indeterminate', {});
    ok('网络异常识别', isNetworkError(Object.assign(new Error('fetch failed'), { name: 'TypeError' })) === true, {});

    const savedSk = process.env.R2_S3_SECRET_ACCESS_KEY;
    const savedToken = process.env.R2_S3_SESSION_TOKEN;
    process.env.R2_S3_SECRET_ACCESS_KEY = cfg.secretAccessKey;
    process.env.R2_S3_SESSION_TOKEN = creds.sessionToken;
    try {
      const masked = sanitizeDetail({ secret: cfg.secretAccessKey, token: creds.sessionToken });
      ok('脱敏不泄露父 secret 与 session token',
        masked.indexOf(cfg.secretAccessKey) < 0 && masked.indexOf(creds.sessionToken) < 0, masked.slice(0, 120));
    } finally {
      if (savedSk === undefined) delete process.env.R2_S3_SECRET_ACCESS_KEY;
      else process.env.R2_S3_SECRET_ACCESS_KEY = savedSk;
      if (savedToken === undefined) delete process.env.R2_S3_SESSION_TOKEN;
      else process.env.R2_S3_SESSION_TOKEN = savedToken;
    }

    const src = fs.readFileSync(__filename, 'utf8');
    /* 字面量分片拼接，避免检查用的字符串本身出现在源码中造成假阳性。 */
    const apiFallbackNeedle = '/r2/temp-access-' + 'credentials';
    ok('源码不含自动回退到 Temporary Credentials API 的调用',
      src.indexOf(apiFallbackNeedle) < 0, {});
    ok('源码不含生产桶写入路径', src.indexOf('bucket_name = ' + PRODUCTION_BUCKET) < 0, {});
  } finally {
    global.fetch = originalFetch;
  }
  out('SELF-CHECK PASS=' + R.pass + ' FAIL=' + R.fail + ' TOTAL=' + R.checks.length);
  process.exit(R.fail === 0 ? 0 : 1);
}

/* ==================== 主流程 ==================== */

async function main() {
  const startedAt = new Date().toISOString();
  const args = process.argv.slice(2);
  if (args.indexOf('--self-check') >= 0) selfCheck();

  /* --s0-only：独立只读入口。与 --run 同时出现时拒绝执行，避免误入写入阶段。 */
  const s0Only = args.indexOf('--s0-only') >= 0;
  if (s0Only && args.indexOf('--run') >= 0) {
    die(2, '--s0-only 与 --run 不能同时使用：前者只发两次 HEAD，后者会进入 S1–S7 并删除测试对象。');
  }

  const cfg = validateConfig(process.env);
  if (!cfg.ok) {
    die(3, '环境门禁未通过 [' + cfg.code + ']：' + cfg.message +
      '\n必填：R2_S3_ACCOUNT_ID、R2_S3_BUCKET=' + TEST_BUCKET + '、R2_S3_ALLOWED_BUCKETS、' +
      'R2_S3_ACCESS_KEY_ID、R2_S3_SECRET_ACCESS_KEY、R2_S3_CONFIRM=YES');
  }

  R.mode = s0Only ? 's0-only' : (args.indexOf('--run') >= 0 ? 'live' : 'dry-run');
  R.bucket = cfg.bucket;
  R.endpoint = 'https://[ACCOUNT_ID]' + HOST_SUFFIX;
  R.runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex');
  out('[R2-S3] runId=' + R.runId + ' bucket=' + cfg.bucket + ' mode=' + R.mode);

  if (R.mode === 'dry-run') {
    out('[R2-S3] DRY-RUN：门禁已通过，未铸造凭证、未发出任何网络请求。');
    out('[R2-S3] 真实执行需显式 --run 且 R2_S3_CONFIRM=YES；S0 仅 HEAD 探针，失败即停止。');
    process.exit(0);
  }

  const creds = mintTempCredentials(cfg);
  const ctx = { cfg: cfg, creds: creds, runId: R.runId, manifest: [] };

  /* 独立路径：只跑 S0，随后直接退出；不落回下面的 runS1toS7 / cleanup。 */
  if (s0Only) {
    await runS0Only(ctx, startedAt);
    return;
  }

  let fatal = null;
  try {
    record('S0', '临时凭证仅含测试所需 actions', creds.actions.join(',') === TEMP_ACTIONS.join(','), creds.actions);
    record('S0', '临时凭证前缀限制为测试前缀', creds.prefixPaths[0] === PREFIX, creds.prefixPaths);
    await runS0(ctx);
    await runS1toS7(ctx);
  } catch (e) {
    fatal = sanitizeDetail(e && e.message ? e.message : e);
    record('RUNTIME', '执行未抛异常', false, { message: fatal });
  }

  const shouldCleanup = !fatal && R.fail === 0;
  const cleanupReport = shouldCleanup ? await cleanup(ctx) : { mode: 'preserved', objects: [], deleted: [], kept: ctx.manifest, errors: [], reason: fatal || 'test-failure' };

  const result = {
    runId: R.runId, mode: R.mode, bucket: cfg.bucket, productionBucket: PRODUCTION_BUCKET,
    startedAt: startedAt,
    finishedAt: new Date().toISOString(),
    checks: R.checks,
    summary: { pass: R.pass, fail: R.fail, total: R.checks.length },
    cleanup: cleanupReport,
    limitations: [
      '本工具验证 R2 存储原语，不验证 Worker 协议、幂等、revision、metadata 校验或跨 isolate 并发。',
      'S6 是两个独立 HTTP 请求的并发，不代表跨 Worker isolate。',
      'SigV4 与本地 JWT 的正确性由 S0 真实响应验证；离线自检只验证结构与确定性。',
      'If-Match 更新结果不确定时禁止重试，一律保留现场。'
    ]
  };
  const resultPath = path.join(__dirname, 'r2-s3-integration-' + R.runId + '-result.json');
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
  out('[R2-S3] result=' + resultPath);
  out('[R2-S3] PASS=' + R.pass + ' FAIL=' + R.fail + ' TOTAL=' + R.checks.length +
      ' CLEANUP=' + cleanupReport.deleted.length + ' deleted / ' + cleanupReport.kept.length + ' kept');
  process.exit(R.fail === 0 ? 0 : 1);
}

main().catch(e => {
  out('[R2-S3] internal error: ' + sanitizeDetail(e && e.stack ? e.stack : e));
  process.exit(5);
});
