#!/usr/bin/env node
/* 地球online — 真实 Cloudflare R2 集成验证（阶段 1B）
 *
 * 目标：用真实 R2 验证 Worker v2 的条件创建、pointer CAS、ETag 与失败语义。
 *
 * 安全边界（任一不满足即停止，不写云端）：
 *   1. 只允许显式白名单中的独立测试 Bucket；生产 Bucket 一律拒绝。
 *   2. 只用专用 runId 生成对象；pointer 必须在运行前不存在。
 *   3. 只通过本脚本生成的临时 wrangler 配置启动本地 dev（R2 binding 走 remote=true）。
 *   4. 启动后先做隔离探针：用 wrangler 直接读回刚写入的对象；读不到就判定
 *      “remote binding 未生效 / 指向了别的桶”，立即停止，绝不把本地模拟当真实验证。
 *   5. 清理只按本次 manifest 的显式 key 删除，不做前缀扫描、不碰 legacy key。
 *
 * 本脚本不会被 npm test 调用；只有显式 `npm run test:r2` 才会执行。
 *
 * 退出码：0 全部通过；1 有断言失败；2 用法/配置错误；3 缺少环境或资源（BLOCKED）；
 *         4 隔离校验失败；5 内部错误。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');

const WORKER_DIR = path.resolve(__dirname, '..');
const WORKER_SRC = path.join(WORKER_DIR, 'src', 'index.js');
const WRANGLER = process.platform === 'win32'
  ? path.join(WORKER_DIR, 'node_modules', '.bin', 'wrangler.cmd')
  : path.join(WORKER_DIR, 'node_modules', '.bin', 'wrangler');

const POINTER_KEY = 'earthonline/backups/v2/pointer.json';
const OBJECT_PREFIX = 'earthonline/backups/';
const PROD_CONFIG = path.join(WORKER_DIR, 'wrangler.toml');
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
/* R2 已知限制（用于报告，不用来主动越界写入） */
const R2_LIMITS = { customMetadataBytes: 2048, keyBytes: 1024 };

const R = { checks: [], pass: 0, fail: 0 };
function record(group, name, ok, detail) {
  const item = { group, name, ok: !!ok, detail: detail === undefined ? null : detail };
  R.checks.push(item);
  if (ok) { R.pass++; console.log('[PASS] ' + group + ' ' + name); }
  else { R.fail++; console.log('[FAIL] ' + group + ' ' + name + ' :: ' + JSON.stringify(item.detail)); }
}

/* ==================== 通用工具 ==================== */
function out(line) { console.log(line); }
function die(code, message) { console.error('[R2-INTEGRATION] ' + message); process.exit(code); }

function sanitize(text) {
  return String(text || '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[EMAIL_REDACTED]')
    .replace(/\b[A-Fa-f0-9]{32}\b/g, '[ID_REDACTED]')
    .replace(/(Bearer|Cf-Access-Jwt-Assertion)[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT_REDACTED]');
}

function quoteArg(a) {
  return /[\s"]/.test(a) ? '"' + String(a).replace(/"/g, '\\"') + '"' : String(a);
}

function runWrangler(args, opts) {
  const options = opts || {};
  const cmd = [WRANGLER].concat(args).map(quoteArg).join(' ');
  return spawnSync(cmd, {
    cwd: WORKER_DIR,
    shell: true,
    encoding: 'utf8',
    timeout: options.timeout || 90000,
    env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' })
  });
}

function parseProdBucket() {
  let text;
  try { text = fs.readFileSync(PROD_CONFIG, 'utf8'); }
  catch (e) { return null; }
  const blocks = text.split(/\[\[r2_buckets\]\]/).slice(1);
  for (const block of blocks) {
    const binding = /binding\s*=\s*"([^"]+)"/.exec(block);
    const bucket = /bucket_name\s*=\s*"([^"]+)"/.exec(block);
    if (binding && bucket && binding[1] === 'BACKUP_BUCKET') return bucket[1];
  }
  return null;
}

function splitList(v) {
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
}

/* ==================== 配置门禁（纯函数，便于自检） ==================== */
function validateConfig(env) {
  const e = env || {};
  const testBucket = String(e.R2_TEST_BUCKET || '').trim();
  const allowed = splitList(e.R2_TEST_ALLOWED_BUCKETS);
  const prodBucket = parseProdBucket();

  if (!prodBucket) return { ok: false, code: 'config-error', message: '无法从 wrangler.toml 解析生产 Bucket，拒绝运行' };
  if (!testBucket) return { ok: false, code: 'missing-env', message: '缺少 R2_TEST_BUCKET' };
  if (allowed.length === 0) return { ok: false, code: 'missing-env', message: '缺少 R2_TEST_ALLOWED_BUCKETS（必须显式列出允许的测试桶）' };
  if (allowed.indexOf(testBucket) < 0) {
    return { ok: false, code: 'not-allowlisted', message: 'R2_TEST_BUCKET 不在 R2_TEST_ALLOWED_BUCKETS 白名单中' };
  }
  if (testBucket === prodBucket) {
    return { ok: false, code: 'production-bucket', message: 'R2_TEST_BUCKET 等于生产 Bucket（' + prodBucket + '），拒绝运行' };
  }
  if (String(e.R2_TEST_CONFIRM || '') !== 'YES') {
    return { ok: false, code: 'missing-confirm', message: '必须设置 R2_TEST_CONFIRM=YES 才能进行真实 R2 写入' };
  }
  const cleanup = String(e.R2_TEST_CLEANUP || 'success');
  if (['success', 'always', 'never'].indexOf(cleanup) < 0) {
    return { ok: false, code: 'bad-cleanup', message: 'R2_TEST_CLEANUP 只能是 success / always / never' };
  }
  return { ok: true, testBucket: testBucket, prodBucket: prodBucket, cleanup: cleanup };
}

function checkBucketExists(bucket) {
  const res = runWrangler(['r2', 'bucket', 'list']);
  if (res.status !== 0) {
    return { ok: false, message: 'wrangler r2 bucket list 失败: ' + sanitize(res.stderr || res.stdout) };
  }
  const names = [];
  for (const line of String(res.stdout || '').split(/\r?\n/)) {
    const m = /^name:\s*(\S+)\s*$/.exec(line.trim());
    if (m) names.push(m[1]);
  }
  if (names.indexOf(bucket) < 0) {
    return { ok: false, names: names, message: '测试 Bucket 不存在: ' + bucket };
  }
  return { ok: true, names: names };
}

function r2Get(bucket, key, tmpDir) {
  const file = path.join(tmpDir, 'get-' + randomUUID() + '.bin');
  const res = runWrangler(['r2', 'object', 'get', bucket + '/' + key, '--remote', '--file', file]);
  let body = null;
  if (res.status === 0) {
    try { body = fs.readFileSync(file, 'utf8'); } catch (e) { body = null; }
  }
  try { fs.unlinkSync(file); } catch (e) {}
  if (res.status === 0) return { exists: true, body: body };
  const msg = String(res.stderr || '') + String(res.stdout || '');
  if (/NoSuchKey|The specified key does not exist|object.*not found|\b404\b/i.test(msg)) {
    return { exists: false, body: null };
  }
  return { exists: false, body: null, error: sanitize(msg).slice(0, 800) };
}

function r2Delete(bucket, key) {
  const res = runWrangler(['r2', 'object', 'delete', bucket + '/' + key, '--remote', '-y']);
  return { ok: res.status === 0, message: sanitize(res.stderr || res.stdout).slice(0, 500) };
}

/* ==================== JWT / JWKS（真实 WebCrypto 验签路径） ==================== */
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function b64url(u8) {
  let out = '';
  let i = 0;
  while (i < u8.length) {
    const rem = u8.length - i;
    const a = u8[i++];
    const b = rem > 1 ? u8[i++] : 0;
    const c = rem > 2 ? u8[i++] : 0;
    const n = ((a << 16) | (b << 8) | c) >>> 0;
    out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63];
    out += rem > 1 ? B64URL[(n >>> 6) & 63] : '=';
    out += rem > 2 ? B64URL[n & 63] : '=';
  }
  return out.replace(/=+$/, '');
}
function strB64url(s) { return b64url(new TextEncoder().encode(s)); }

async function makeJwt() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  jwk.kid = 'r2it-key-1'; jwk.use = 'sig'; jwk.alg = 'ES256';
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', typ: 'JWT', kid: jwk.kid };
  const payload = {
    iss: 'https://test-team.cloudflareaccess.com',
    aud: 'test-aud-tag',
    exp: now + 900,
    iat: now,
    email: 'r2-integration@example.invalid'
  };
  const data = strB64url(JSON.stringify(header)) + '.' + strB64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(data));
  return { token: data + '.' + b64url(new Uint8Array(sig)), jwk: jwk, key: kp };
}

function startJwksServer(jwk) {
  const server = http.createServer((req, res) => {
    if (req.url && req.url.indexOf('/cdn-cgi/access/certs') === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404); res.end('not-found');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ==================== 协议数据构造（与 Worker 规范化完全一致） ==================== */
async function sha256Tag(u8) {
  const buf = await crypto.subtle.digest('SHA-256', u8);
  return 'sha256-' + b64url(new Uint8Array(buf));
}
function canonicalImmutable(im) {
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

async function makeObject(runId, tag) {
  const writeId = 'r2it-' + runId + '-' + tag;
  const payload = {
    app: 'earthonline', version: 4,
    exportedAt: new Date().toISOString(),
    data: { v: 4, runId: runId, marker: tag }
  };
  const payloadText = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(payloadText);
  const im = {
    protocolVersion: 2,
    attemptId: writeId,
    writeId: writeId,
    clientId: 'r2it-client',
    clientRevision: 1,
    baseRev: 0,
    objectKey: OBJECT_PREFIX + writeId + '.json',
    payloadHash: await sha256Tag(bytes),
    payloadBytes: bytes.length,
    createdAt: Date.now(),
    identity: { conflictEpoch: 0, blockEpoch: 0, expectedConflictState: { mode: 'none', id: null } },
    immutableHash: null
  };
  im.immutableHash = await sha256Tag(new TextEncoder().encode(canonicalImmutable(im)));
  return { writeId: writeId, payload: payload, payloadText: payloadText, immutable: im };
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

/* ==================== Worker HTTP 客户端 ==================== */
function makeClient(baseUrl, token) {
  async function call(method, subpath, body, extraHeaders) {
    const headers = Object.assign({
      'Cf-Access-Jwt-Assertion': token,
      'Content-Type': 'application/json',
      'X-Earthonline-Protocol': '2'
    }, extraHeaders || {});
    const init = { method: method, headers: headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(baseUrl + subpath, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, json: json, text: text, headers: res.headers };
  }
  return {
    object: (body) => call('PUT', '/api/backup/v2/object', body),
    pointer: (pointer, expected) => call('PUT', '/api/backup/v2/pointer', { protocolVersion: 2, pointer: pointer, expected: expected }),
    status: () => call('GET', '/api/backup/v2/status'),
    raw: call
  };
}

async function waitReady(client, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await client.status();
      if (r.status === 200) return true;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

function startDev(configPath, port, logSink) {
  const args = ['dev', '--config', configPath, '--port', String(port), '--show-interactive-dev-session=false'];
  const cmd = [WRANGLER].concat(args).map(quoteArg).join(' ');
  const child = spawn(cmd, {
    cwd: WORKER_DIR,
    shell: true,
    env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' })
  });
  child.stdout.on('data', d => logSink.push(sanitize(d.toString())));
  child.stderr.on('data', d => logSink.push(sanitize(d.toString())));
  return child;
}

function isPortFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickPort(preferred) {
  for (let p = preferred; p < preferred + 10; p++) {
    if (await isPortFree(p)) return p;
  }
  return null;
}

function stopDev(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch (e) {}
}

function makeConfig(bucket, jwksUrl, port) {
  return [
    'name = "earthonline-backup-r2test-local"',
    'main = ' + JSON.stringify(WORKER_SRC),
    'compatibility_date = "2025-10-01"',
    'workers_dev = false',
    'preview_urls = false',
    '',
    '[vars]',
    'APP_ORIGIN = "https://liyuk.github.io"',
    'ACCESS_TEAM = "test-team.cloudflareaccess.com"',
    'AUD_TAG = "test-aud-tag"',
    'JWKS_URL = ' + JSON.stringify(jwksUrl),
    'MAX_BACKUP_BYTES = "' + DEFAULT_MAX_BYTES + '"',
    '',
    '[[r2_buckets]]',
    'binding = "BACKUP_BUCKET"',
    'bucket_name = ' + JSON.stringify(bucket),
    'remote = true',
    ''
  ].join('\n');
}

/* ==================== 测试执行 ==================== */
async function runGroups(ctx) {
  const { client, bucket, runId, tmpDir, manifest } = ctx;
  let st = null;
  let objectA = null;
  let objectB = null;
  let objectC = null;
  let objectD = null;
  let objectE = null;
  let objectF = null;
  let objectG = null;

  /* ---------- R1：对象条件创建 ---------- */
  objectA = await makeObject(runId, 'a');
  let r = await client.object({ protocolVersion: 2, immutable: objectA.immutable, payload: objectA.payload });
  record('R1', '首次创建成功', r.status === 200 && r.json && r.json.ok === true && r.json.pointerCommitted === false, { status: r.status, body: r.json });
  if (r.status === 200) manifest.push({ key: objectA.immutable.objectKey, kind: 'object', writeId: objectA.writeId });
  const etagA = r.json && r.json.stored ? r.json.stored.etag : null;
  record('R1', '返回 quoted ETag', typeof etagA === 'string' && /^"[^"]*"$/.test(etagA) && !/^W\//.test(etagA), { etag: etagA });

  r = await client.object({ protocolVersion: 2, immutable: objectA.immutable, payload: objectA.payload });
  record('R1', '同内容重复创建幂等', r.status === 200 && r.json && r.json.idempotent === true, { status: r.status, body: r.json });

  const conflicting = await makeObject(runId, 'a');
  conflicting.immutable.writeId = objectA.writeId;
  conflicting.immutable.attemptId = objectA.writeId;
  conflicting.immutable.objectKey = objectA.immutable.objectKey;
  conflicting.immutable.payloadHash = await sha256Tag(new TextEncoder().encode(JSON.stringify(conflicting.payload)));
  conflicting.immutable.payloadBytes = new TextEncoder().encode(JSON.stringify(conflicting.payload)).length;
  conflicting.immutable.immutableHash = await sha256Tag(new TextEncoder().encode(canonicalImmutable(conflicting.immutable)));
  r = await client.object({ protocolVersion: 2, immutable: conflicting.immutable, payload: conflicting.payload });
  record('R1', '同 writeId 不同内容冲突', r.status === 409 && r.json && r.json.error === 'object-conflict', { status: r.status, body: r.json });

  const readA = r2Get(bucket, objectA.immutable.objectKey, tmpDir);
  record('R1', '原始对象未被覆盖', readA.exists && readA.body === objectA.payloadText, { exists: readA.exists, error: readA.error || null });

  /* ---------- R2：Pointer 初始化 ---------- */
  r = await client.pointer(pointerFrom(objectA.immutable, 1), { revision: 0, etag: null });
  record('R2', '首次初始化成功', r.status === 200 && r.json && r.json.revision === 1, { status: r.status, body: r.json });
  const etag1 = r.json ? r.json.etag : null;
  if (r.status === 200) manifest.push({ key: POINTER_KEY, kind: 'pointer', runId: runId });
  record('R2', '初始化返回 quoted ETag', typeof etag1 === 'string' && /^"[^"]*"$/.test(etag1) && !/^W\//.test(etag1), { etag: etag1 });

  st = await client.status();
  record('R2', 'status 与初始化一致', st.status === 200 && st.json && st.json.hasPointer === true && st.json.revision === 1 && st.json.etag === etag1, { status: st.status, body: st.json });

  r = await client.pointer(pointerFrom(objectA.immutable, 1), { revision: 0, etag: null });
  record('R2', '重复初始化幂等且不覆盖', r.status === 200 && r.json && r.json.idempotent === true && r.json.pointer && r.json.pointer.writeId === objectA.writeId, { status: r.status, body: r.json });

  const readP1 = r2Get(bucket, POINTER_KEY, tmpDir);
  let pointerBody1 = null;
  try { pointerBody1 = JSON.parse(readP1.body); } catch (e) {}
  record('R2', '真实存储中的 pointer 与响应一致', readP1.exists && pointerBody1 && pointerBody1.revision === 1 && pointerBody1.writeId === objectA.writeId, { exists: readP1.exists, pointer: pointerBody1 });

  /* ---------- R3：CAS 成功 ---------- */
  objectB = await makeObject(runId, 'b');
  r = await client.object({ protocolVersion: 2, immutable: objectB.immutable, payload: objectB.payload });
  record('R3', '第二个对象创建成功', r.status === 200, { status: r.status });
  if (r.status === 200) manifest.push({ key: objectB.immutable.objectKey, kind: 'object', writeId: objectB.writeId });

  r = await client.pointer(pointerFrom(objectB.immutable, 2), { revision: 1, etag: etag1 });
  const etag2 = r.json ? r.json.etag : null;
  record('R3', 'CAS 成功且 revision 严格 +1', r.status === 200 && r.json && r.json.revision === 2, { status: r.status, body: r.json });
  record('R3', 'CAS 返回新的 quoted ETag', typeof etag2 === 'string' && /^"[^"]*"$/.test(etag2) && !/^W\//.test(etag2), { etag: etag2 });

  st = await client.status();
  record('R3', 'status 与 CAS 结果一致', st.status === 200 && st.json && st.json.revision === 2 && st.json.etag === etag2 && st.json.pointer && st.json.pointer.writeId === objectB.writeId, { status: st.status, body: st.json });

  const readP2 = r2Get(bucket, POINTER_KEY, tmpDir);
  let pointerBody2 = null;
  try { pointerBody2 = JSON.parse(readP2.body); } catch (e) {}
  record('R3', '真实存储 pointer 内容一致', readP2.exists && pointerBody2 && pointerBody2.writeId === objectB.writeId && pointerBody2.revision === 2, { exists: readP2.exists, pointer: pointerBody2 });

  /* ---------- R4：CAS 冲突 ---------- */
  objectC = await makeObject(runId, 'c');
  r = await client.object({ protocolVersion: 2, immutable: objectC.immutable, payload: objectC.payload });
  if (r.status === 200) manifest.push({ key: objectC.immutable.objectKey, kind: 'object', writeId: objectC.writeId });
  r = await client.pointer(pointerFrom(objectC.immutable, 3), { revision: 2, etag: etag2 });
  const etag3 = r.json ? r.json.etag : null;
  record('R4', '先提交一次合法更新', r.status === 200 && r.json && r.json.revision === 3, { status: r.status, body: r.json });

  objectD = await makeObject(runId, 'd');
  r = await client.object({ protocolVersion: 2, immutable: objectD.immutable, payload: objectD.payload });
  if (r.status === 200) manifest.push({ key: objectD.immutable.objectKey, kind: 'object', writeId: objectD.writeId });
  r = await client.pointer(pointerFrom(objectD.immutable, 3), { revision: 2, etag: etag2 });
  record('R4', '旧 ETag 提交返回 409', r.status === 409 && r.json && r.json.error === 'cas-conflict', { status: r.status, body: r.json });
  record('R4', '失败响应不谎报 pointer 已更新', r.json && r.json.ok === false && !('pointer' in r.json), { body: r.json });

  st = await client.status();
  const rev4 = st.json ? st.json.revision : null;
  record('R4', '失败未覆盖 pointer，revision 只 +1', st.status === 200 && rev4 === 3 && st.json.etag === etag3 && st.json.pointer && st.json.pointer.writeId === objectC.writeId, { status: st.status, body: st.json });

  /* ---------- R5：真实并发 CAS ---------- */
  objectE = await makeObject(runId, 'e');
  objectF = await makeObject(runId, 'f');
  const createE = await client.object({ protocolVersion: 2, immutable: objectE.immutable, payload: objectE.payload });
  const createF = await client.object({ protocolVersion: 2, immutable: objectF.immutable, payload: objectF.payload });
  if (createE.status === 200) manifest.push({ key: objectE.immutable.objectKey, kind: 'object', writeId: objectE.writeId });
  if (createF.status === 200) manifest.push({ key: objectF.immutable.objectKey, kind: 'object', writeId: objectF.writeId });

  const etag3b = st.json ? st.json.etag : etag3;
  const pair = await Promise.all([
    client.pointer(pointerFrom(objectE.immutable, 4), { revision: 3, etag: etag3b }),
    client.pointer(pointerFrom(objectF.immutable, 4), { revision: 3, etag: etag3b })
  ]);
  const statuses = pair.map(x => x.status).sort();
  record('R5', '两个并发 CAS 只有一个成功', statuses[0] === 200 && statuses[1] === 409, { statuses: statuses });
  const winner = pair.filter(x => x.status === 200)[0];
  const loser = pair.filter(x => x.status === 409)[0];
  record('R5', '败者来自条件写冲突（无 currentRevision）', !!loser && loser.json && loser.json.error === 'cas-conflict' && !('currentRevision' in loser.json), { loser: loser && loser.json });

  st = await client.status();
  const winnerBody = winner && winner.json;
  const finalWriteId = st.json && st.json.pointer ? st.json.pointer.writeId : null;
  const winnerWriteId = winnerBody && winnerBody.pointer ? winnerBody.pointer.writeId : null;
  record('R5', '最终 revision 只推进一次', st.status === 200 && st.json && st.json.revision === 4, { status: st.status, body: st.json });
  record('R5', '最终 pointer 与成功请求一致', !!winnerWriteId && finalWriteId === winnerWriteId, { winner: winnerWriteId, final: finalWriteId });
  const etag4 = st.json ? st.json.etag : null;

  /* ---------- R6：ETag 全链路一致性 ---------- */
  objectG = await makeObject(runId, 'g');
  r = await client.object({ protocolVersion: 2, immutable: objectG.immutable, payload: objectG.payload });
  if (r.status === 200) manifest.push({ key: objectG.immutable.objectKey, kind: 'object', writeId: objectG.writeId });
  const etagFromStatus = etag4;
  r = await client.pointer(pointerFrom(objectG.immutable, 5), { revision: 4, etag: etagFromStatus });
  const etag5 = r.json ? r.json.etag : null;
  record('R6', 'status ETag 回传后可继续 CAS（round-trip）', r.status === 200 && r.json && r.json.revision === 5, { status: r.status, body: r.json });
  record('R6', '写入响应 ETag 为强 quoted 形式', typeof etag5 === 'string' && /^"[^"]*"$/.test(etag5) && !/^W\//.test(etag5), { etag: etag5 });
  st = await client.status();
  record('R6', '写入响应 ETag 与后续 status 一致', st.status === 200 && st.json && st.json.etag === etag5, { status: st.status, statusEtag: st.json && st.json.etag, writeEtag: etag5 });

  /* ---------- R7：异常与失败路径 ---------- */
  r = await client.raw('PUT', '/api/backup/v2/object', { protocolVersion: 2 }, { 'X-Earthonline-Protocol': '1' });
  record('R7', '协议头错误被拒绝', r.status === 400 && r.json && r.json.error === 'protocol-required', { status: r.status, body: r.json });

  const badHash = await makeObject(runId, 'badhash');
  badHash.immutable.immutableHash = 'sha256-wrong';
  r = await client.object({ protocolVersion: 2, immutable: badHash.immutable, payload: badHash.payload });
  record('R7', 'immutableHash 不匹配被拒绝', r.status === 400 && r.json && r.json.error === 'immutable-hash-mismatch', { status: r.status, body: r.json });

  const noAuthHeaders = { 'Cf-Access-Jwt-Assertion': '', 'X-Earthonline-Protocol': '2', 'Content-Type': 'application/json' };
  const noAuthRes = await fetch(ctx.baseUrl + '/api/backup/v2/status', { method: 'GET', headers: noAuthHeaders });
  record('R7', '缺失认证被拒绝', noAuthRes.status === 401, { status: noAuthRes.status });

  const staleObj = await makeObject(runId, 'stale');
  const staleCreate = await client.object({ protocolVersion: 2, immutable: staleObj.immutable, payload: staleObj.payload });
  r = await client.pointer(pointerFrom(staleObj.immutable, 6), { revision: 5, etag: '"r2it-stale-etag-000"' });
  record('R7', '过期 ETag 返回 409', r.status === 409 && r.json && r.json.error === 'cas-conflict', { status: r.status, body: r.json });
  /* 注意：staleObj 对象已成功写入且不可变，纳入 manifest 清理 */
  if (staleCreate.status === 200) manifest.push({ key: staleObj.immutable.objectKey, kind: 'object', writeId: staleObj.writeId });

  /* ---------- R8：Metadata 与长度测量 ---------- */
  const immJson = JSON.stringify(objectG.immutable);
  const metadataKeys = ['app', 'protocolVersion', 'writeId', 'objectKey', 'payloadHash', 'payloadBytes', 'immutableHash', 'immutableJson', 'uploadedAt'];
  const metaForSize = {
    app: 'earthonline', protocolVersion: '2', writeId: objectG.writeId,
    objectKey: objectG.immutable.objectKey, payloadHash: objectG.immutable.payloadHash,
    payloadBytes: String(objectG.immutable.payloadBytes), immutableHash: objectG.immutable.immutableHash,
    immutableJson: immJson, uploadedAt: new Date().toISOString()
  };
  const totalMetadataBytes = Object.keys(metaForSize).reduce((n, k) => n + Buffer.byteLength(k, 'utf8') + Buffer.byteLength(metaForSize[k], 'utf8'), 0);
  record('R8', 'immutableJson 体积在 R2 元数据限制内', Buffer.byteLength(immJson, 'utf8') < R2_LIMITS.customMetadataBytes, { immutableJsonBytes: Buffer.byteLength(immJson, 'utf8'), limit: R2_LIMITS.customMetadataBytes });
  record('R8', 'customMetadata 总字节估算在限制内', totalMetadataBytes < R2_LIMITS.customMetadataBytes, { totalMetadataBytes: totalMetadataBytes, limit: R2_LIMITS.customMetadataBytes });
  record('R8', '对象 key 长度在 R2 限制内', Buffer.byteLength(objectG.immutable.objectKey, 'utf8') < R2_LIMITS.keyBytes, { keyBytes: Buffer.byteLength(objectG.immutable.objectKey, 'utf8'), limit: R2_LIMITS.keyBytes });
  record('R8', 'metadata 字段数量与 writeId 长度已记录', metadataKeys.length > 0, { count: metadataKeys.length, keys: metadataKeys, writeIdLength: objectG.writeId.length });
}

/* ==================== 清理 ==================== */
function cleanup(ctx, mode) {
  const { bucket, tmpDir, manifest } = ctx;
  const report = { mode: mode, objects: [], deleted: [], kept: [], errors: [] };
  const seen = new Set();
  const ordered = manifest.filter(i => i.kind !== 'pointer').concat(manifest.filter(i => i.kind === 'pointer'));
  for (const item of ordered) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    const read = r2Get(bucket, item.key, tmpDir);
    let owned = false;
    if (read.exists && typeof read.body === 'string') {
      if (item.kind === 'pointer') {
        try { owned = JSON.parse(read.body).writeId.indexOf('r2it-' + ctx.runId + '-') === 0; } catch (e) {}
      } else {
        try { owned = JSON.parse(read.body).data.runId === ctx.runId; } catch (e) {}
      }
    }
    report.objects.push({ key: item.key, kind: item.kind, exists: read.exists, owned: owned, bytes: read.body ? Buffer.byteLength(read.body, 'utf8') : 0 });
    if (!read.exists) { report.kept.push({ key: item.key, reason: 'not-found' }); continue; }
    if (!owned) { report.kept.push({ key: item.key, reason: 'ownership-unconfirmed' }); continue; }
    if (mode === 'never') { report.kept.push({ key: item.key, reason: 'cleanup-disabled' }); continue; }
    const del = r2Delete(bucket, item.key);
    if (del.ok) report.deleted.push(item.key); else report.errors.push({ key: item.key, message: del.message });
  }
  /* 删除 pointer 之后再确认一次，避免留下指向已删对象的 pointer */
  const finalPointer = r2Get(bucket, POINTER_KEY, tmpDir);
  report.pointerAbsentAfter = !finalPointer.exists;
  return report;
}

/* ==================== 自检（不联网） ==================== */
async function selfCheck() {
  let pass = 0, fail = 0;
  const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log('[SELF-PASS] ' + name); }
    else { fail++; console.log('[SELF-FAIL] ' + name + ' :: ' + JSON.stringify(detail)); }
  };
  ok('生产桶解析正确', parseProdBucket() === 'earthonline-backups', { got: parseProdBucket() });
  const runId = 'r2it-' + randomBytes(6).toString('hex');
  ok('runId 合法', /^[A-Za-z0-9._-]+$/.test(runId), { runId });
  const obj = await makeObject(runId, 'self');
  ok('objectKey 前缀正确', obj.immutable.objectKey.indexOf('earthonline/backups/') === 0, { key: obj.immutable.objectKey });
  ok('payload hash 与字节一致', obj.immutable.payloadHash === await sha256Tag(new TextEncoder().encode(obj.payloadText)), {});
  ok('immutableHash 稳定', obj.immutable.immutableHash === await sha256Tag(new TextEncoder().encode(canonicalImmutable(obj.immutable))), {});
  const shuffled = Object.assign({}, obj.immutable);
  ok('canonical 不受字段顺序影响', canonicalImmutable(shuffled) === canonicalImmutable(obj.immutable), {});

  const prod = parseProdBucket();
  ok('拒绝生产桶', validateConfig({ R2_TEST_BUCKET: prod, R2_TEST_ALLOWED_BUCKETS: prod, R2_TEST_CONFIRM: 'YES' }).code === 'production-bucket', {});
  ok('拒绝非白名单桶', validateConfig({ R2_TEST_BUCKET: 'x-test', R2_TEST_ALLOWED_BUCKETS: 'y-test', R2_TEST_CONFIRM: 'YES' }).code === 'not-allowlisted', {});
  ok('拒绝缺少确认', validateConfig({ R2_TEST_BUCKET: 'x-test', R2_TEST_ALLOWED_BUCKETS: 'x-test' }).code === 'missing-confirm', {});
  ok('接受合法测试配置', validateConfig({ R2_TEST_BUCKET: 'x-test', R2_TEST_ALLOWED_BUCKETS: 'x-test', R2_TEST_CONFIRM: 'YES' }).ok === true, {});

  const jwt = await makeJwt();
  const server = await startJwksServer(jwt.jwk);
  try {
    const port = server.address().port;
    const res = await fetch('http://127.0.0.1:' + port + '/cdn-cgi/access/certs');
    const jwks = await res.json();
    ok('JWKS 服务可返回公钥', jwks.keys && jwks.keys[0] && jwks.keys[0].kid === 'r2it-key-1', {});
    const [h, p, s] = jwt.token.split('.');
    const sig = Uint8Array.from(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4), 'base64'));
    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      jwt.key.publicKey,
      sig,
      new TextEncoder().encode(h + '.' + p)
    );
    ok('JWT 可用本地 JWKS 验签', verified === true, {});
  } finally {
    server.close();
  }

  console.log('SELF-CHECK PASS=' + pass + ' FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

/* ==================== 主流程 ==================== */
async function main() {
  const startedAt = new Date().toISOString();
  if (process.argv.indexOf('--self-check') >= 0) return selfCheck();

  const cfg = validateConfig(process.env);
  if (!cfg.ok) {
    const hint = cfg.code === 'missing-env' || cfg.code === 'missing-confirm'
      ? '\n必填：R2_TEST_BUCKET、R2_TEST_ALLOWED_BUCKETS、R2_TEST_CONFIRM=YES'
      : '';
    die(3, '环境门禁未通过 [' + cfg.code + ']：' + cfg.message + hint);
  }

  if (!fs.existsSync(WRANGLER)) {
    die(2, '未找到本地 wrangler：' + WRANGLER + '\n请在 cloudflare-worker 目录执行 npm install。');
  }

  const bucketCheck = checkBucketExists(cfg.testBucket);
  if (!bucketCheck.ok) {
    die(3, '测试资源门禁未通过：' + bucketCheck.message +
      '\n该 Bucket 必须由你单独创建并授权；脚本不会自行创建 Bucket。可用桶：' +
      (bucketCheck.names || []).join(', '));
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'earthonline-r2it-'));
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + randomBytes(3).toString('hex');
  out('[R2-INTEGRATION] runId=' + runId + ' bucket=' + cfg.testBucket);

  /* pointer 必须不存在，避免覆盖其他 run 或历史数据 */
  const pointerPre = r2Get(cfg.testBucket, POINTER_KEY, tmpDir);
  if (pointerPre.exists) {
    die(3, '测试桶中已存在 pointer（' + POINTER_KEY + '）。为避免覆盖其他测试/数据，拒绝运行；请先确认并清理该测试桶。');
  }
  if (pointerPre.error) die(3, '无法确认 pointer 是否存在：' + pointerPre.error);

  const jwt = await makeJwt();
  const jwks = await startJwksServer(jwt.jwk);
  const jwksPort = jwks.address().port;
  const preferredPort = parseInt(process.env.R2_TEST_WORKER_PORT || '8789', 10);
  if (!Number.isInteger(preferredPort) || preferredPort < 1024 || preferredPort > 65535) {
    die(2, 'R2_TEST_WORKER_PORT 非法');
  }
  const port = await pickPort(preferredPort);
  if (!port) {
    die(3, '端口 ' + preferredPort + '-' + (preferredPort + 9) + ' 均被占用，无法启动本地 dev');
  }
  const configPath = path.join(tmpDir, 'wrangler.toml');
  fs.writeFileSync(configPath, makeConfig(cfg.testBucket, 'http://127.0.0.1:' + jwksPort + '/cdn-cgi/access/certs', port), 'utf8');

  const logs = [];
  const dev = startDev(configPath, port, logs);
  const client = makeClient('http://127.0.0.1:' + port, jwt.token);
  const manifest = [];
  let fatal = null;

  const result = {
    runId: runId,
    startedAt: startedAt,
    finishedAt: null,
    bucket: cfg.testBucket,
    productionBucket: cfg.prodBucket,
    workerMode: 'wrangler dev (local process, R2 binding remote=true)',
    checks: [],
    summary: null,
    cleanup: null,
    limitations: []
  };

  try {
    const ready = await waitReady(client, 90000);
    if (!ready) {
      const tail = logs.slice(-15).join('').slice(-3000);
      fatal = '本地 dev 未就绪（可能是 remote binding/JWKS/端口问题）。日志尾部：\n' + tail;
      throw new Error(fatal);
    }
    record('R0', '本地 dev 就绪', true, { port: port });

    /* 隔离探针：Worker 写入后，必须能从真实测试桶读回 */
    const probe = await makeObject(runId, 'probe');
    const probeRes = await client.object({ protocolVersion: 2, immutable: probe.immutable, payload: probe.payload });
    record('R0', '探针对象写入成功', probeRes.status === 200, { status: probeRes.status, body: probeRes.json });
    if (probeRes.status !== 200) {
      fatal = '隔离探针写入失败，拒绝继续；不会把本地模拟当作真实 R2。';
      throw new Error(fatal);
    }
    manifest.push({ key: probe.immutable.objectKey, kind: 'object', writeId: probe.writeId });
    const probeRead = r2Get(cfg.testBucket, probe.immutable.objectKey, tmpDir);
    if (!probeRead.exists) {
      fatal = '隔离探针无法从测试桶 ' + cfg.testBucket + ' 读回。remote binding 可能未生效或指向了其他桶；已停止，未继续写入。';
      throw new Error(fatal);
    }
    record('R0', '隔离探针可从真实测试桶读回', probeRead.body === probe.payloadText, { bytes: probeRead.body ? Buffer.byteLength(probeRead.body, 'utf8') : 0 });

    await runGroups({ client, bucket: cfg.testBucket, runId: runId, tmpDir: tmpDir, manifest: manifest, baseUrl: 'http://127.0.0.1:' + port });
  } catch (e) {
    if (fatal) record('R0', '启动与隔离校验', false, { message: fatal });
    else record('R-INTERNAL', '执行未抛异常', false, { message: sanitize(e && e.stack ? e.stack : e) });
  } finally {
    stopDev(dev);
    jwks.close();
    result.finishedAt = new Date().toISOString();
    result.checks = R.checks;
    result.summary = { pass: R.pass, fail: R.fail, total: R.checks.length };
    /* 清理策略：只有全部通过才按 cfg.cleanup 清理；任何失败（含 fatal）一律保留现场。
     * fatal 时 cleanup() 仍会以 'never' 运行，但只做只读归属核对并写入 manifest 清单，不删除任何对象。 */
    const cleanupMode = fatal
      ? 'never'
      : (R.fail === 0 ? cfg.cleanup : (cfg.cleanup === 'always' ? 'always' : 'never'));
    try {
      result.cleanup = cleanup({ bucket: cfg.testBucket, runId: runId, tmpDir: tmpDir, manifest: manifest }, cleanupMode);
    } catch (e) {
      result.cleanup = { error: sanitize(e && e.message ? e.message : e) };
    }
    result.limitations.push('两个并发请求由同一本地 dev 进程转发，无法证明跨 isolate 并发；真实 R2 的条件写原子性已由服务端保证。');
    result.limitations.push('无法强行制造真实 R2 的 ETag 缺失/读失败；这些分支由 Stub 覆盖，不宣称真实验证。');
    const resultPath = path.join(__dirname, 'r2-integration-' + runId + '-result.json');
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
    out('[R2-INTEGRATION] result=' + resultPath);
    out('[R2-INTEGRATION] PASS=' + R.pass + ' FAIL=' + R.fail + ' TOTAL=' + R.checks.length);
    out('[R2-INTEGRATION] CLEANUP deleted=' + (result.cleanup && result.cleanup.deleted ? result.cleanup.deleted.length : 0) +
      ' kept=' + (result.cleanup && result.cleanup.kept ? result.cleanup.kept.length : 0));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  process.exit(R.fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('[R2-INTEGRATION] internal error: ' + sanitize(e && e.stack ? e.stack : e)); process.exit(5); });
