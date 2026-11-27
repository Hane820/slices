/* auth-lifecycle.test.mjs — Phase Auth.2-R：认证失效语义专项回归
 *
 * 真实 auth.js + cloud-backup.js 源码在同一 vm context 运行：cloud-backup 的
 * classifyAuthFailure 走真实 OLAuth 分类器。网络/定时器/DOM/存储是可控替身，
 * 覆盖「只有明确 Session 失效才切 guest」的全部分支与异步竞态。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = path.join(ROOT, 'public', 'app');
const AUTH_SRC = fs.readFileSync(path.join(APP, 'auth.js'), 'utf8');
const CB_SRC = fs.readFileSync(path.join(APP, 'cloud-backup.js'), 'utf8');
const ID_SRC = fs.readFileSync(path.join(APP, 'identity.js'), 'utf8');

const USER = { space: 'local', dbName: 'earthonline', userId: 'u_1', email: 'a@example.com' };
const GUEST = { space: 'guest', dbName: 'earthonline-guest' };

function storage(init) {
  const map = new Map(Object.entries(init || {}));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get length() { return map.size; },
    key: (i) => Array.from(map.keys())[i] ?? null
  };
}

function makeHarness(record) {
  const timers = new Map();
  const intervals = new Map();
  const pending = [];
  const requests = [];
  let seq = 0;
  const ss = storage(record ? { 'earthonline-space': JSON.stringify(record) } : {});
  const ls = storage();
  const demotions = [];
  const win = {
    sessionStorage: ss, localStorage: ls,
    location: { protocol: 'https:', origin: 'https://slices0flife.me' },
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++seq; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
    addEventListener() {}, dispatchEvent() {},
    CustomEvent: function (t) { this.type = t; },
    fetch(url, init) {
      requests.push({ url, init });
      return new Promise((resolve) => {
        pending.push((resp) => resolve({
          ok: resp.ok !== false,
          status: resp.status || 200,
          text: () => Promise.resolve(resp.html !== undefined ? resp.html : JSON.stringify(resp.body || {}))
        }));
      });
    },
    buildBackupPayload: (data) => ({ app: 'earthonline', version: 4, data }),
    readExportSource: (done) => done({ tasks: [], marker: 'committed-only' }),
    bizWriteBlocked: () => true,
    S: { tasks: [] },
    document: { readyState: 'complete', addEventListener() {} },
    AbortController, Date, JSON, Math, encodeURIComponent,
    console: { log() {}, warn() {}, error() {} }
  };
  win.window = win;

  /* 真实 identity.js → 真实 auth.js → 真实 cloud-backup.js */
  vm.runInNewContext(ID_SRC, win);
  const origDemote = win.OLIdentity.demoteToGuest.bind(win.OLIdentity);
  win.OLIdentity.demoteToGuest = (reason) => { demotions.push(reason); return origDemote(reason); };
  vm.runInNewContext(AUTH_SRC, win);
  vm.runInNewContext(CB_SRC, win);

  let synced = 0;
  const origSync = win.OLCloudBackup.syncIdentity.bind(win.OLCloudBackup);
  win.OLCloudBackup.syncIdentity = () => { synced++; return origSync(); };

  const h = {
    win, timers, intervals, pending, requests, demotions,
    get synced() { return synced; },
    resolveNext(resp) {
      const r = pending.shift();
      assert.ok(r, '没有待解决的请求');
      r(resp || { ok: true, status: 200, body: { ok: true } });
    },
    fireNextTimer() {
      const first = timers.keys().next();
      if (first.done) return;
      const id = first.value; const fn = timers.get(id); timers.delete(id); fn();
    },
    timerCount() { return timers.size; },
    intervalCount() { return intervals.size; },
    settle: async () => { for (let i = 0; i < 6; i++) await delay(0); },
    setRecord(rec) {
      ss.setItem('earthonline-space', JSON.stringify(rec));
    }
  };
  return h;
}

async function startUser(h) {
  h.win.OLCloudBackup.syncIdentity();
  await h.settle();
  h.resolveNext({ ok: true, status: 200, body: { ok: true } }); /* status 查询 */
  await h.settle();
}

async function triggerUpload(h) {
  h.win.OLCloudBackup.markDirty('idb');
  h.fireNextTimer();
  await h.settle();
}

/* ---------------- 表格场景 ---------------- */

test('Session 已过期 / 已撤销：明确 code=session-invalid → 切 guest 并停调度', async () => {
  const h = makeHarness(USER);
  await startUser(h);
  assert.equal(h.win.OLIdentity.mode(), 'local');
  await triggerUpload(h);
  h.resolveNext({ ok: false, status: 401, body: { ok: false, error: 'unauthorized', code: 'session-invalid', reason: 'no-valid-session' } });
  await h.settle();
  assert.equal(h.win.OLIdentity.mode(), 'guest', '明确会话失效必须切 guest');
  assert.equal(h.demotions.length, 1);
  assert.ok(h.synced >= 2, '降级后必须重新同步停掉 user 调度');
  assert.equal(h.intervalCount(), 0, 'heartbeat 必须停止');
  assert.equal(h.win.OLIdentity.dbName(), 'earthonline-guest');
});

test('Session 缺失（旧码 no-session）：切 guest', async () => {
  const h = makeHarness(USER);
  await startUser(h);
  await triggerUpload(h);
  h.resolveNext({ ok: false, status: 401, body: { ok: false, error: 'no-session' } });
  await h.settle();
  assert.equal(h.win.OLIdentity.mode(), 'guest');
  assert.equal(h.demotions.length, 1);
});

test('有效 Session + 403 授权拒绝（access-denied）：保留 user', async () => {
  const h = makeHarness(USER);
  await startUser(h);
  await triggerUpload(h);
  h.resolveNext({ ok: false, status: 403, body: { ok: false, error: 'unauthorized', code: 'access-denied', reason: 'access-invalid' } });
  await h.settle();
  assert.equal(h.win.OLIdentity.mode(), 'local', '403 授权拒绝不得降级');
  assert.equal(h.demotions.length, 0);
  assert.equal(h.win.OLCloudBackup.snapshot().pending, true, '待备份必须保留');
});

test('有效 Session + CSRF 拒绝：保留 user', async () => {
  const h = makeHarness(USER);
  await startUser(h);
  await triggerUpload(h);
  h.resolveNext({ ok: false, status: 403, body: { ok: false, error: 'csrf-required' } });
  await h.settle();
  assert.equal(h.win.OLIdentity.mode(), 'local');
  assert.equal(h.demotions.length, 0);
  assert.equal(h.win.OLCloudBackup.snapshot().pending, true);
});

test('Cloudflare Access 拦截（HTML 登录页，无 JSON 码）：不误判为会话失效', async () => {
  const h = makeHarness(USER);
  await startUser(h);
  await triggerUpload(h);
  h.resolveNext({ ok: false, status: 200, html: '<html>Sign in with Cloudflare</html>' });
  await h.settle();
  assert.equal(h.win.OLIdentity.mode(), 'local', 'Access 登录页不得被当成会话失效');
  assert.equal(h.demotions.length, 0);
  assert.equal(h.win.OLCloudBackup.snapshot().pending, true);
});

test('网络断开（status 0 / network-error）：保留 user 与 pending', async () => {
  const h = makeHarness(USER);
  await startUser(h);
  await triggerUpload(h);
  h.resolveNext({ ok: false, status: 0, body: { ok: false, error: 'network-error' } });
  await h.settle();
  assert.equal(h.win.OLIdentity.mode(), 'local');
  assert.equal(h.demotions.length, 0);
  assert.equal(h.win.OLCloudBackup.snapshot().pending, true);
});

test('Worker 500：保留 user，不降级', async () => {
  const h = makeHarness(USER);
  await startUser(h);
  await triggerUpload(h);
  h.resolveNext({ ok: false, status: 500, body: { ok: false, error: 'storage-error' } });
  await h.settle();
  assert.equal(h.win.OLIdentity.mode(), 'local');
  assert.equal(h.demotions.length, 0);
  assert.equal(h.win.OLCloudBackup.snapshot().pending, true);
});

test('旧 user 请求延迟返回时身份已切换：不污染新身份，不触发降级', async () => {
  const h = makeHarness(USER);
  await startUser(h);
  await triggerUpload(h);
  /* 上传在途期间切到 guest（已落定记录） */
  h.setRecord(GUEST);
  h.win.OLCloudBackup.syncIdentity();
  await h.settle();
  /* 此刻才返回 session-invalid：不应降级（已是 guest），也不写状态 */
  h.resolveNext({ ok: false, status: 401, body: { ok: false, error: 'unauthorized', code: 'session-invalid' } });
  await h.settle();
  assert.equal(h.win.OLIdentity.mode(), 'guest');
  assert.equal(h.demotions.length, 0, '身份早已切换，陈旧响应不得再触发 demote');
  assert.equal(h.win.OLCloudBackup.snapshot().pending, false, 'guest 快照无待备份');
  assert.equal(h.win.OLCloudBackup.snapshot().lastError, '');
});

test('状态查询 403 也不降级：refreshStatus 路径同样走分类', async () => {
  const h = makeHarness(USER);
  h.win.OLCloudBackup.syncIdentity();
  await h.settle();
  h.resolveNext({ ok: false, status: 403, body: { ok: false, error: 'csrf-required' } });
  await h.settle();
  assert.equal(h.win.OLIdentity.mode(), 'local');
  assert.equal(h.demotions.length, 0);
  assert.ok(h.win.OLCloudBackup.snapshot().statusError, '状态错误应被记录但不降级');
});

test('真正 Session 失效后，后续 modify 不再排队上传（guest 门禁）', async () => {
  const h = makeHarness(USER);
  await startUser(h);
  await triggerUpload(h);
  h.resolveNext({ ok: false, status: 401, body: { ok: false, error: 'unauthorized', code: 'session-invalid' } });
  await h.settle();
  const callsBefore = h.requests.length;
  h.win.OLCloudBackup.markDirty('idb');
  h.fireNextTimer();
  await h.settle();
  assert.equal(h.requests.length, callsBefore, '切 guest 后 markDirty 不得再发起任何云端请求');
});
