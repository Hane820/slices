/* cloud-backup-space.test.mjs — 云端备份的空间门禁与身份切换隔离（不需要浏览器）
 *
 * 用真实的 cloud-backup.js 源码，在 vm 里配可控的 fetch / 定时器 / localStorage /
 * OLIdentity：
 *   1. guest：init / markDirty / backupNow / refreshStatus 全部不发请求、不写待备份、
 *      快照里不存在 pending 与 unauthorized；
 *   2. 刷新后即使 localStorage 残留旧身份的 pending/失败，guest 也不启动、不展示；
 *   3. user（local）：syncIdentity 后才启动状态查询，保存触发合并上传、成功后状态正确、
 *      失败保留待备份并可重试；
 *   4. 上传期间身份切换：响应结果被丢弃，不会写成新身份的状态；
 *   5. guest → user / user → guest 的定时器启停与旧任务隔离。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = path.join(ROOT, 'public', 'app');
const SRC = fs.readFileSync(path.join(APP, 'cloud-backup.js'), 'utf8');

const STATE_KEY = 'earthonline-cloud-backup-v1';
const LEASE_KEY = 'earthonline-cloud-backup-lease';

function makeStorage(init) {
  const map = new Map(Object.entries(init || {}));
  const reads = [];
  return {
    map, reads,
    getItem(k) { reads.push(k); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] ?? null; }
  };
}

function makeNode(tag, cls, text) {
  return {
    tag, cls: cls || '', text: text || '', children: [], style: {}, dataset: {},
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {},
    set innerHTML(v) { if (v === '') this.children.length = 0; }
  };
}

const GUEST = null;
const ADOPTED_GUEST = { space: 'guest', dbName: 'earthonline', adoptedOldData: true };
const USER = { space: 'local', dbName: 'earthonline' };

function makeHarness(opts) {
  opts = opts || {};
  const timers = new Map();
  const intervals = new Map();
  let seq = 0;
  const calls = [];
  const pending = [];
  const storage = makeStorage(opts.local);
  const identity = { record: opts.record === undefined ? GUEST : opts.record };
  const listeners = {};
  const harness = { calls, timers, intervals, storage, identity, listeners, pending };

  function fakeSetTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, ms }); return id; }
  function fakeClearTimeout(id) { timers.delete(id); }
  function fakeSetInterval(fn, ms) { const id = ++seq; intervals.set(id, { fn, ms }); return id; }
  function fakeClearInterval(id) { intervals.delete(id); }

  function nextTimer() {
    const first = timers.keys().next();
    if (first.done) return null;
    const id = first.value;
    const t = timers.get(id);
    timers.delete(id);
    t.fn();
    return t;
  }
  harness.fireNextTimer = nextTimer;
  harness.fireAllTimers = (limit) => {
    let n = limit || 20;
    while (timers.size && n-- > 0) nextTimer();
  };
  harness.resolveNext = (resp) => {
    const r = pending.shift();
    assert.ok(r, '没有待解决的请求');
    r(resp || { ok: true, status: 200, body: { ok: true } });
  };
  harness.resolveAll = (resp) => { while (pending.length) harness.resolveNext(resp); };

  const win = {
    OLIdentity: { record: () => identity.record },
    localStorage: storage,
    fetch(url) {
      calls.push(url);
      return new Promise((resolve) => {
        pending.push((resp) => resolve({
          ok: resp.ok !== false,
          status: resp.status || 200,
          text: () => Promise.resolve(JSON.stringify(resp.body || {}))
        }));
      });
    },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
    addEventListener(type, fn) { listeners[type] = fn; },
    dispatchEvent() {},
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    buildBackupPayload: (data) => ({ app: 'earthonline', version: 4, data }),
    bizWriteBlocked: () => true,
    readExportSource: (done) => done({ tasks: [], marker: 'committed-only' }),
    S: { tasks: [] },
    console: { log() {}, warn() {}, error() {} },
    Date, JSON, Math, encodeURIComponent
  };
  win.window = win;
  win.document = { readyState: 'complete', addEventListener() {} };

  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'cloud-backup.js' });
  harness.win = win;
  harness.api = win.OLCloudBackup;
  harness.setIdentity = (rec) => { identity.record = rec; };
  harness.settle = async (rounds) => {
    const n = rounds || 6;
    for (let i = 0; i < n; i++) await delay(0);
  };
  return harness;
}

const flush = (h) => h.settle();

test('guest：首次进入不发任何云端请求，快照无待备份 / 无失败', async () => {
  const h = makeHarness({ record: GUEST });
  await flush(h);
  assert.equal(h.calls.length, 0, 'guest 不得请求 status 或 backup');
  const snap = h.api.snapshot();
  assert.equal(snap.status, 'disabled');
  assert.equal(snap.enabled, false);
  assert.equal(snap.pending, false);
  assert.equal(snap.uploading, false);
  assert.equal(snap.lastError, '');
  assert.equal(snap.lastSuccessAt, null);
  assert.equal(h.storage.map.has(STATE_KEY), false, 'guest 不得写云端待备份状态');
  assert.equal(h.storage.map.has(LEASE_KEY), false);
  assert.equal(h.storage.reads.includes(STATE_KEY), false, 'guest 连待备份状态都不读');
});

test('guest：修改数据不产生上传、不标记待备份', async () => {
  const h = makeHarness({ record: GUEST });
  h.api.markDirty('idb');
  h.api.markDirty('idb');
  await flush(h);
  assert.equal(h.calls.length, 0);
  assert.equal(h.api.snapshot().pending, false);
  assert.equal(h.timers.size, 0, 'guest 不得排任何上传定时器');
  assert.equal(h.storage.map.has(STATE_KEY), false);
});

test('guest：刷新后即使残留旧身份 pending/unauthorized 也不启动、不展示', async () => {
  const h = makeHarness({
    record: GUEST,
    local: {
      [STATE_KEY]: JSON.stringify({
        pending: true, seq: 7, dirtyAt: 1,
        lastSuccessAt: '2026-01-01T00:00:00.000Z',
        lastError: 'unauthorized', lastFailureAt: 2
      }),
      [LEASE_KEY]: JSON.stringify({ tabId: 'old-tab', at: Date.now() })
    }
  });
  await flush(h);
  assert.equal(h.calls.length, 0, '刷新后的 guest 不得补传、不得查状态');
  assert.equal(h.timers.size, 0);
  const snap = h.api.snapshot();
  assert.equal(snap.pending, false);
  assert.equal(snap.lastError, '', 'guest 不得展示 unauthorized');
  assert.equal(snap.lastSuccessAt, null);
  assert.equal(h.storage.map.get(STATE_KEY).includes('unauthorized'), true, '旧状态只是不展示，不篡改用户存储');
});

test('guest：认领旧库的 guest（dbName=earthonline）同样被门禁拦住', async () => {
  const h = makeHarness({ record: ADOPTED_GUEST });
  h.api.markDirty('idb');
  const r = await h.api.refreshStatus();
  assert.equal(r, null);
  assert.equal(h.api.backupNow(), false);
  await flush(h);
  assert.equal(h.calls.length, 0, '认领旧库仍是 guest，不得上传');
});

test('user：syncIdentity 后才查状态；保存触发合并上传并正确更新状态', async () => {
  const h = makeHarness({ record: USER });
  assert.equal(h.calls.length, 0, 'init 不直接开跑，等启动层确认');
  h.api.syncIdentity();
  await flush(h);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0], /\/api\/backup\/status$/);
  h.resolveNext({ ok: true, body: { ok: true, hasBackup: false } });
  await flush(h);

  h.api.markDirty('idb');
  h.api.markDirty('idb');
  h.api.markDirty('idb');
  assert.equal(h.timers.size, 1, '连续修改只保留一个防抖定时器');
  h.fireNextTimer();
  await flush(h);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1], /\/api\/backup$/);
  h.resolveNext({ ok: true, body: { ok: true, stored: { uploadedAt: '2026-11-27T10:00:00.000Z' } } });
  await flush(h);

  const snap = h.api.snapshot();
  assert.equal(snap.status, 'synced');
  assert.equal(snap.pending, false);
  assert.equal(snap.lastSuccessAt, '2026-11-27T10:00:00.000Z');
  assert.equal(snap.lastError, '');
  assert.equal(h.storage.map.get(STATE_KEY).includes('"pending":false'), true);
});

test('user：上传中再次修改，成功后仍保留待备份并继续上传最新数据', async () => {
  const h = makeHarness({ record: USER });
  h.api.syncIdentity();
  await flush(h);
  h.resolveNext({ ok: true, body: { ok: true } });
  await flush(h);

  h.api.markDirty('idb');
  h.fireNextTimer();
  await flush(h);
  assert.match(h.calls[1], /\/api\/backup$/);

  /* 上传还没返回时又改了一次 */
  h.api.markDirty('idb');
  assert.equal(h.api.snapshot().pending, true);
  h.resolveNext({ ok: true, body: { ok: true, stored: { uploadedAt: '2026-11-27T10:01:00.000Z' } } });
  await flush(h);

  assert.equal(h.api.snapshot().pending, true, '上传期间的新修改不能被成功响应吞掉');
  assert.equal(h.timers.size, 1, '应安排下一次上传');
  h.fireNextTimer();
  await flush(h);
  assert.equal(h.calls.length, 3, '第二次上传必须发生');
  h.resolveNext({ ok: true, body: { ok: true, stored: { uploadedAt: '2026-11-27T10:02:00.000Z' } } });
  await flush(h);
  assert.equal(h.api.snapshot().pending, false);
});

test('user：上传失败保留待备份，重试成功后恢复', async () => {
  const h = makeHarness({ record: USER });
  h.api.syncIdentity();
  await flush(h);
  h.resolveNext({ ok: true, body: { ok: true } });
  await flush(h);

  h.api.markDirty('idb');
  h.fireNextTimer();
  await flush(h);
  h.resolveNext({ ok: false, status: 500, body: { ok: false, error: 'server-error' } });
  await flush(h);

  let snap = h.api.snapshot();
  assert.equal(snap.pending, true, '失败不得丢待备份');
  assert.match(snap.lastError, /server-error/);
  assert.equal(h.timers.size, 1, '普通失败后应有延迟重试');

  h.fireNextTimer();
  await flush(h);
  assert.equal(h.calls.length, 3);
  h.resolveNext({ ok: true, body: { ok: true, stored: { uploadedAt: '2026-11-27T11:00:00.000Z' } } });
  await flush(h);

  snap = h.api.snapshot();
  assert.equal(snap.pending, false);
  assert.equal(snap.lastError, '', '重试成功后旧失败信息必须清掉');
  assert.equal(snap.status, 'synced');
});

test('user：401 不做快速重试，但保留待备份并在下次修改后重试', async () => {
  const h = makeHarness({ record: USER });
  h.api.syncIdentity();
  await flush(h);
  h.resolveNext({ ok: true, body: { ok: true } });
  await flush(h);

  h.api.markDirty('idb');
  h.fireNextTimer();
  await flush(h);
  h.resolveNext({ ok: false, status: 401, body: { ok: false, error: 'unauthorized' } });
  await flush(h);

  const snap = h.api.snapshot();
  assert.equal(snap.pending, true, '401 也不得丢待备份');
  assert.match(snap.lastError, /unauthorized/);
  assert.equal(h.timers.size, 0, '401 不应立即安排重试，避免反复撞校验');

  /* 下一次真实修改会重新排队，并在会话恢复后成功 */
  h.api.markDirty('idb');
  assert.equal(h.timers.size, 1);
  h.fireNextTimer();
  await flush(h);
  assert.equal(h.calls.length, 3);
  h.resolveNext({ ok: true, body: { ok: true, stored: { uploadedAt: '2026-11-27T13:00:00.000Z' } } });
  await flush(h);
  assert.equal(h.api.snapshot().pending, false);
  assert.equal(h.api.snapshot().lastError, '');
});

test('user → guest：定时器全停；切换后的响应不写成游客状态', async () => {
  const h = makeHarness({ record: USER });
  h.api.syncIdentity();
  await flush(h);
  h.resolveNext({ ok: true, body: { ok: true } });
  await flush(h);

  h.api.markDirty('idb');
  h.fireNextTimer();
  await flush(h);
  assert.match(h.calls[1], /\/api\/backup$/);

  /* 上传中切回游客 */
  h.setIdentity(GUEST);
  h.api.syncIdentity();
  assert.equal(h.timers.size, 0, '切换后旧定时器必须清掉');
  assert.equal(h.intervals.size, 0, '游客不得保留心跳');

  h.resolveNext({ ok: true, body: { ok: true, stored: { uploadedAt: '2026-11-27T12:00:00.000Z' } } });
  await flush(h);

  const snap = h.api.snapshot();
  assert.equal(snap.status, 'disabled');
  assert.equal(snap.pending, false);
  assert.equal(snap.lastSuccessAt, null, '游客不得继承上传成功的状态');

  /* 切回 user：此前保留的 pending 应被重新接管（旧任务不丢） */
  h.setIdentity(USER);
  h.api.syncIdentity();
  await flush(h);
  assert.match(h.calls[2], /\/api\/backup\/status$/, '回到 user 才重新查状态');
  assert.equal(h.timers.size, 1, 'pending 应安排补传');
  h.fireNextTimer();
  await flush(h);
  assert.match(h.calls[3], /\/api\/backup$/, '待备份在身份恢复后仍会上传');
});

test('guest → user：登录前不排队，切换后才启动 user 备份', async () => {
  const h = makeHarness({ record: GUEST });
  h.api.markDirty('idb');
  h.api.markDirty('idb');
  await flush(h);
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 0);

  h.setIdentity(USER);
  h.api.syncIdentity();
  await flush(h);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0], /\/api\/backup\/status$/);

  h.api.markDirty('idb');
  h.fireNextTimer();
  await flush(h);
  assert.match(h.calls[1], /\/api\/backup$/);
});

test('静态：身份门禁在真实执行入口（run）也生效，不靠 UI 隐藏', () => {
  assert.match(SRC, /function run\(reason\)\{\s*\/\*[\s\S]*?\*\/\s*if\(guestBlocked\(\)\) return false;/);
  assert.match(SRC, /syncIdentity:syncIdentity/);
  assert.match(SRC, /identityKey\(\) === owner/);
});

test('静态：启动完成（finishBoot）后才按身份启动备份，init 不直接开跑', () => {
  const boot = fs.readFileSync(path.join(APP, 'boot.js'), 'utf8');
  const start = boot.indexOf('function finishBoot()');
  assert.ok(start >= 0);
  const body = boot.slice(start, boot.indexOf('\n}', start) + 2);
  assert.match(body, /OLCloudBackup\.syncIdentity\(\)/, '启动完成后必须按当前身份同步备份状态');
  assert.equal(/refreshStatus\(|backupNow\(/.test(body), false, '启动出口不得直接触发上传');
  const initBody = SRC.slice(SRC.indexOf('function init()'), SRC.indexOf('window.OLCloudBackup'));
  assert.match(initBody, /attachListeners\(\)/);
  assert.equal(/refreshStatus\(|schedule\(/.test(initBody), false, 'init 不应自行查状态或排上传');
});

test('静态：前端不伪造 Access 凭证、不打印备份内容', () => {
  assert.equal(/Cf-Access-Jwt-Assertion|CF_Authorization/.test(SRC), false, '前端不得伪造 Access 凭证');
  assert.equal(/document\.cookie|localStorage\.setItem\(['"]CF_/.test(SRC), false);
  assert.equal(/console\.(log|info|warn|error)\([^)]*body/.test(SRC), false, '不得把备份内容写进日志');
});

/* ---------------- 设置页渲染：guest / user 两种身份的真实文案与操作 ---------------- */

const SETTINGS_SRC = fs.readFileSync(path.join(APP, 'settings.js'), 'utf8');

function extractFn(name) {
  const start = SETTINGS_SRC.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'settings.js 找不到 ' + name);
  let depth = 0, i = SETTINGS_SRC.indexOf('{', start);
  for (let j = i; j < SETTINGS_SRC.length; j++) {
    const c = SETTINGS_SRC[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return SETTINGS_SRC.slice(start, j + 1); }
  }
  throw new Error(name + ' 大括号不平衡');
}

function collectText(n, out) {
  out = out || [];
  if (!n) return out;
  if (n.text) out.push(n.text);
  (n.children || []).forEach((c) => collectText(c, out));
  return out;
}
function collectTags(n, out) {
  out = out || [];
  if (!n) return out;
  out.push(n.tag + (n.cls ? '.' + n.cls.split(' ').join('.') : ''));
  (n.children || []).forEach((c) => collectTags(c, out));
  return out;
}

function renderSettingsFn(fnName, identityRecord, snapshot) {
  const box = makeNode('div', 'card plain');
  const opened = [];
  const win = {
    OLIdentity: {
      record: () => identityRecord,
      isGuest: () => !identityRecord || identityRecord.space === 'guest'
    },
    OLCloudBackup: { snapshot: () => snapshot, refreshStatus() {}, backupNow() { return true; } },
    OLGuest: { clear: () => Promise.resolve({ ok: true }) },
    location: { reload() {} },
    openModal: (cfg) => opened.push(cfg),
    confirmBox: (title) => opened.push({ title }),
    openLoginSheet: () => opened.push({ sheet: true }),
    logoutUser: () => opened.push({ logout: true }),
    $: () => box,
    el: (tag, cls, text) => makeNode(tag, cls, text),
    OLT: (s) => s,
    toastCfg() {}
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(extractFn(fnName) + '\nwindow.__fn = ' + fnName + ';', win);
  win.__fn();
  return { box, texts: collectText(box), tags: collectTags(box), opened };
}

test('设置页·guest：云端备份区只有未启用说明，没有待备份、失败或立即备份按钮', () => {
  const r = renderSettingsFn('renderCloudSet', GUEST, { status: 'disabled', enabled: false, pending: false, uploading: false });
  const text = r.texts.join(' | ');
  assert.match(text, /当前为游客空间，云端备份尚未启用/);
  assert.match(text, /登录后可开启自动云端备份/);
  assert.equal(/待备份/.test(text), false);
  assert.equal(/立即备份/.test(text), false);
  assert.equal(/刷新云端状态/.test(text), false);
  assert.equal(/unauthorized/.test(text), false);
});

test('设置页·guest：空间区显示游客空间、数据在本机、登录入口与重置，且不再出现「游客体验」', () => {
  const r = renderSettingsFn('renderGuestSet', GUEST, {});
  const text = r.texts.join(' | ');
  assert.match(text, /当前空间：游客空间/);
  assert.match(text, /数据只保存在这台设备/);
  assert.match(text, /登录 \/ 开启云端备份/);
  assert.match(text, /登录/);
  assert.match(text, /重置游客数据/);
  assert.equal(/游客体验/.test(text), false, '演示入口不再冒充空间身份');
  assert.equal(/不会上传/.test(text), true);
});

test('设置页·user：显示用户空间、自动备份已启用、退出登录；不编造账号', () => {
  const r = renderSettingsFn('renderGuestSet', USER, {});
  const text = r.texts.join(' | ');
  assert.match(text, /当前空间：用户空间/);
  assert.match(text, /已启用（自动）/);
  assert.match(text, /退出登录/);
  assert.match(text, /账号信息暂不可用/);
  assert.equal(/@/.test(text), false, '没有账号数据时不得编造邮箱');
});

test('设置页·user：备份区显示自动备份、状态、成功时间、失败信息与刷新入口', () => {
  const r = renderSettingsFn('renderCloudSet', USER, {
    enabled: true, status: 'pending', pending: true, uploading: false,
    lastSuccessAt: null, lastError: 'unauthorized', serverHasBackup: false, serverUploadedAt: null
  });
  const text = r.texts.join(' | ');
  assert.match(text, /自动云端备份/);
  assert.match(text, /已启用/);
  assert.match(text, /当前备份状态/);
  assert.match(text, /待备份/);
  assert.match(text, /最近成功备份时间/);
  assert.match(text, /最近一次上传失败/);
  assert.match(text, /待备份数据已保留/);
  assert.match(text, /刷新云端状态/);
  assert.match(text, /不提供实时双向同步/);
  assert.ok(r.tags.includes('button.btn.g.sm'), '刷新按钮存在');
});
