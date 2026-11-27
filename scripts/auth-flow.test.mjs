/* auth-flow.test.mjs — Phase Auth 前端闭环：真实 auth.js / identity.js /
 * settings.js 源码在 vm 中运行，只有网络、DOM 与存储是替身。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = path.join(ROOT, 'public', 'app');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
const IDENTITY_SRC = read('identity.js');
const AUTH_SRC = read('auth.js');
const SETTINGS_SRC = read('settings.js');
const BOOT_SRC = read('boot.js');

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

function loadIdentity(init) {
  const win = { sessionStorage: storage(init), localStorage: storage() };
  win.window = win;
  vm.runInNewContext(IDENTITY_SRC, { window: win });
  return win;
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body))
  };
}

function loadAuth(win, replies) {
  const calls = [];
  let i = 0;
  const ctx = {
    window: win,
    location: win.location,
    OLIdentity: win.OLIdentity,
    OLCloudBackup: win.OLCloudBackup,
    CustomEvent: function (type) { this.type = type; },
    localStorage: win.localStorage,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const r = replies[i++] || response(500, { ok: false, error: 'auth-error' });
      if (typeof r === 'function') return r(url, init);
      return r;
    },
    setTimeout, clearTimeout, AbortController,
    console: { log() {}, warn() {}, error() {} }
  };
  vm.runInNewContext(AUTH_SRC, ctx);
  return calls;
}

const flush = async () => { for (let i = 0; i < 4; i++) await delay(0); };

/* ---------------- 同源 API ---------------- */

test('同源端点：http(s) 页面请求 /api/*，不再依赖跨站 workers.dev', async () => {
  const win = loadIdentity();
  win.location = { protocol: 'https:', origin: 'https://slices0flife.me' };
  const calls = loadAuth(win, [response(202, { ok: true })]);
  await win.OLAuth.requestCode('same@example.com');
  assert.equal(calls[0].url, 'https://slices0flife.me/api/auth/code');
  assert.equal(calls[0].init.credentials, 'include');
});

test('静态：cloud-backup 同样优先同源 origin，dev 回退仅用于 file://', () => {
  const cb = read('cloud-backup.js');
  assert.match(cb, /location\.origin/);
  assert.match(cb, /earthonline-backup\.1317746169\.workers\.dev/);
  assert.equal(/Cf-Access-Jwt-Assertion/.test(cb), false);
});

/* ---------------- 客户端请求契约 ---------------- */

test('auth.js：请求带 X-Earthonline-Auth 与 credentials，验证码不写前端存储', async () => {
  const win = loadIdentity();
  const calls = loadAuth(win, [response(202, { ok: true, resendAfter: 60 })]);
  const r = await win.OLAuth.requestCode('a@example.com');
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/auth\/code$/);
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].init.headers['X-Earthonline-Auth'], '1');
  assert.equal(JSON.parse(calls[0].init.body).email, 'a@example.com');
  assert.equal(win.localStorage.length, 0, '前端不得存 token 或验证码');
  assert.equal(win.OLIdentity.mode(), 'guest', '发码成功绝不等于登录成功');
});

test('auth.js：网络中断返回明确错误，不伪装成功', async () => {
  const win = loadIdentity();
  loadAuth(win, [async () => { throw new Error('offline'); }]);
  const r = await win.OLAuth.session();
  assert.equal(r.ok, false);
  assert.equal(r.error, 'network-error');
  assert.equal(win.OLIdentity.mode(), 'guest');
});

test('静态：cloud-backup 只在明确 Session 失效时降级，不靠 401/403 状态码', () => {
  const cb = read('cloud-backup.js');
  assert.match(cb, /err\.authClass = classifyAuthFailure/);
  assert.match(cb, /cls === 'session-invalid'\) handleAuthFailure/);
  assert.match(cb, /OLAuth\.markSessionInvalid/);
  /* 不得再出现旧的按状态码一刀切 */
  assert.equal(/status === 401 \|\| r\.res\.status === 403/.test(cb), false);
  assert.equal(/e\.auth\) handleAuthFailure\(\)/.test(cb), false);
});

test('分类：auth.js 明确区分会话失效 / 授权拒绝 / 网络 / 状态不明', async () => {
  const win = loadIdentity();
  loadAuth(win, []);
  const c = win.OLAuth.classifyAuthFailure;
  assert.equal(c({ status: 0, error: 'network-error', body: {} }), 'transient');
  assert.equal(c({ status: 503, body: { error: 'auth-unavailable' } }), 'transient');
  assert.equal(c({ status: 401, body: { error: 'unauthorized', code: 'session-invalid' } }), 'session-invalid');
  assert.equal(c({ status: 401, body: { error: 'unauthorized', reason: 'no-valid-session' } }), 'session-invalid');
  assert.equal(c({ status: 401, body: { error: 'no-session' } }), 'session-invalid');
  assert.equal(c({ status: 403, body: { error: 'origin-forbidden', code: 'access-denied' } }), 'auth-denied');
  assert.equal(c({ status: 403, body: { error: 'csrf-required' } }), 'auth-denied');
  assert.equal(c({ status: 401, body: { error: 'unauthorized', code: 'access-denied' } }), 'auth-denied');
  assert.equal(c({ status: 200, body: {} }), 'unknown');
});

test('markSessionInvalid：只有明确会话失效的响应才允许降级', () => {
  const win = loadIdentity({ 'earthonline-space': JSON.stringify(USER) });
  let synced = 0;
  win.OLCloudBackup = { syncIdentity: () => { synced++; } };
  loadAuth(win, []);
  assert.equal(win.OLIdentity.mode(), 'local');
  /* 403 / CSRF / 网络：调用被拒，身份保持 user */
  assert.equal(win.OLAuth.markSessionInvalid({ status: 403, body: { error: 'origin-forbidden' } }), false);
  assert.equal(win.OLAuth.markSessionInvalid({ status: 0, error: 'network-error', body: {} }), false);
  assert.equal(win.OLIdentity.mode(), 'local', '授权/网络失败不得降级');
  assert.equal(synced, 0);
  /* 明确会话失效：降级并停调度 */
  assert.equal(win.OLAuth.markSessionInvalid({ status: 401, body: { error: 'unauthorized', code: 'session-invalid' } }), true);
  assert.equal(win.OLIdentity.isGuest(), true);
  assert.equal(synced, 1);
});

/* ---------------- 身份切换 ---------------- */

test('身份：只有服务端 Session 验证成功后才切 user；失败保留 guest', async () => {
  const win = loadIdentity();
  const calls = loadAuth(win, [
    response(202, { ok: true }),
    response(200, { ok: true, user: { id: 'u_1' } }),
    response(200, { ok: true, user: { id: 'u_1', emailMasked: 'a***@example.com' }, expiresAt: 1 })
  ]);
  await win.OLAuth.requestCode('a@example.com');
  assert.equal(win.OLIdentity.mode(), 'guest');

  const bad = await win.OLAuth.verifyCode('a@example.com', '000000');
  /* 第二条回复是成功；这里只验证"发码后未自动切换" */
  assert.equal(bad.ok, true);
  assert.equal(win.OLIdentity.mode(), 'guest', 'verify 返回成功但尚未读取 session，不提前切换');

  const s = await win.OLAuth.session();
  assert.equal(s.ok, true);
  assert.ok(s.body && s.body.user, '服务端身份在 body.user 中');
  const entered = win.OLIdentity.enterUser({ userId: s.body.user.id, email: s.body.user.emailMasked, source: 'auth-session' });
  assert.equal(entered.ok, true);
  assert.equal(win.OLIdentity.mode(), 'local');
  assert.equal(win.OLIdentity.dbName(), 'earthonline');
  assert.equal(win.OLIdentity.record().email, 'a***@example.com');
  assert.equal(calls.length, 3);
});

test('Session 失效：markSessionInvalid 回到 guest 并停 user 备份调度', () => {
  const win = loadIdentity({ 'earthonline-space': JSON.stringify(USER) });
  let synced = 0;
  win.OLCloudBackup = { syncIdentity: () => { synced++; } };
  loadAuth(win, []);
  assert.equal(win.OLIdentity.mode(), 'local');
  assert.equal(win.OLAuth.markSessionInvalid(), true);
  assert.equal(win.OLIdentity.isGuest(), true, '401 后不得继续视为 user');
  assert.equal(synced, 1, '备份调度器必须按新身份重新同步');
  assert.equal(win.OLIdentity.dbName(), 'earthonline-guest', '回到 guest 库');
  assert.equal(win.localStorage.length, 0, '只改身份记录，不删任何本地数据');
});

test('身份：退出恢复登录前的游客库（含认领旧库），不删除本地数据', () => {
  const win = loadIdentity({ 'earthonline-space': JSON.stringify({ space: 'guest', dbName: 'earthonline', adoptedOldData: true, source: 'detect-has-data' }) });
  const entered = win.OLIdentity.enterUser({ userId: 'u_1', email: 'a***@example.com' });
  assert.equal(entered.ok, true);
  assert.equal(win.OLIdentity.dbName(), 'earthonline');
  const out = win.OLIdentity.demoteToGuest('logout');
  assert.equal(out.ok, true);
  assert.equal(win.OLIdentity.isGuest(), true);
  assert.equal(win.OLIdentity.dbName(), 'earthonline', '认领的旧库入口必须恢复');
  assert.equal(win.OLIdentity.record().adoptedOldData, true);
});

/* ---------------- 设置页登录界面（真实 renderGuestSet / openLoginSheet） ---------------- */

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

function makeNode(cls, text) {
  return {
    cls: cls || '', text: text || '', children: [], style: {}, dataset: {}, value: '',
    handlers: {},
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { this.handlers[t] = fn; },
    get textContent() { return this.text; },
    set textContent(v) { this.text = String(v); },
    set innerHTML(v) { if (v === '') this.children.length = 0; }
  };
}
function allText(n, out) {
  out = out || [];
  if (!n) return out;
  if (n.text) out.push(n.text);
  (n.children || []).forEach((c) => allText(c, out));
  return out;
}

function renderGuest(identity, stub) {
  const box = makeNode('card plain');
  const ctx = {
    window: { OLIdentity: identity, OLCloudBackup: { snapshot: () => ({ enabled: false, status: 'disabled' }) } },
    OLIdentity: identity,
    OLCloudBackup: { snapshot: () => ({ enabled: false, status: 'disabled' }) },
    $: () => box,
    el: (tag, cls, text) => makeNode(cls, text),
    OLT: (s) => s,
    toastCfg() {}, confirmBox() {},
    openLoginSheet: () => { stub.opened = (stub.opened || 0) + 1; }
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(extractFn('renderGuestSet') + '\nwindow.__fn = renderGuestSet;', ctx);
  ctx.window.__fn();
  return { box, texts: allText(box) };
}

const GUEST = null;
const USER = { space: 'local', dbName: 'earthonline', userId: 'u_1', email: 'a***@example.com' };

test('设置页 guest：登录入口可见且点击进入真实登录 Sheet', () => {
  const win = loadIdentity();
  win.OLAuth = { requestCode() {}, verifyCode() {}, session() {}, logout() {} };
  const stub = {};
  const r = renderGuest(win.OLIdentity, stub);
  assert.equal(r.texts.includes('登录 / 开启云端备份'), true);
  assert.equal(r.texts.some((t) => t && t.includes('游客数据不会自动上传或合并')), true);
  const row = r.box.children.find((c) => allText(c).includes('登录 / 开启云端备份'));
  assert.ok(row && row.handlers.click, '登录入口必须可点');
  row.handlers.click();
  assert.equal(stub.opened, 1);
});

test('登录 Sheet：发码只进入第二步；服务端 Session 成功后才切 user', async () => {
  const win = loadIdentity();
  const replies = [
    response(202, { ok: true, resendAfter: 60 }),
    response(200, { ok: true, user: { id: 'u_1' } }),
    response(200, { ok: true, user: { id: 'u_1', emailMasked: 'a***@example.com' } })
  ];
  loadAuth(win, replies);
  const overrides = { reloads: 0, synced: 0 };
  const nodes = {};
  function node(id) {
    if (!nodes[id]) nodes[id] = makeNode('', '');
    return nodes[id];
  }
  const sheet = makeNode('sheetBody');
  sheet.querySelector = (sel) => node(sel.replace('#', ''));
  const ctx = {
    window: win,
    openSheet: () => sheet,
    closeSheet() {},
    openModal: (cfg) => { overrides.modal = cfg; },
    OLAuth: win.OLAuth, OLIdentity: win.OLIdentity,
    OLCloudBackup: { syncIdentity: () => { overrides.synced++; } },
    location: { reload: () => { overrides.reloads++; } },
    OLT: (s) => s,
    setTimeout, clearTimeout, AbortController, console
  };
  vm.createContext(ctx);
  ctx.OLAuth = win.OLAuth;
  ctx.window.OLCloudBackup = ctx.OLCloudBackup;
  vm.runInContext(extractFn('authErrorText') + '\n' + extractFn('openLoginSheet') + '\nwindow.__fn = openLoginSheet;', ctx);
  ctx.window.__fn();

  node('authEmail').value = 'a@example.com';
  await node('authSend').handlers.click.call(makeNode());
  await flush();
  assert.equal(node('authStep2').style.display, 'block', '发码成功只进入第二步');
  assert.equal(win.OLIdentity.mode(), 'guest', '发码成功不得切换身份');

  node('authCode').value = '123456';
  await node('authVerify').handlers.click.call(makeNode());
  await flush();
  assert.equal(win.OLIdentity.mode(), 'local', 'Session 验证成功后才进入 user');
  assert.equal(overrides.synced, 1, '进入 user 后同步备份调度器');
  assert.equal(overrides.reloads, 1);
});

test('登录 Sheet：验码失败仍保留 guest，不启动备份调度', async () => {
  const win = loadIdentity();
  loadAuth(win, [response(202, { ok: true }), response(400, { ok: false, error: 'code-invalid' })]);
  const nodes = {};
  function node(id) { if (!nodes[id]) nodes[id] = makeNode(); return nodes[id]; }
  const sheet = makeNode('sheetBody');
  sheet.querySelector = (sel) => node(sel.replace('#', ''));
  const ctx = {
    window: win, openSheet: () => sheet, closeSheet() {}, openModal() {},
    OLAuth: win.OLAuth, OLIdentity: win.OLIdentity, OLCloudBackup: { syncIdentity: () => { ctx.synced = (ctx.synced || 0) + 1; } },
    location: { reload() { ctx.reloaded = true; } },
    OLT: (s) => s, setTimeout, clearTimeout, AbortController, console
  };
  vm.createContext(ctx);
  ctx.OLAuth = win.OLAuth;
  ctx.window.OLCloudBackup = ctx.OLCloudBackup;
  vm.runInContext(extractFn('authErrorText') + '\n' + extractFn('openLoginSheet') + '\nwindow.__fn = openLoginSheet;', ctx);
  ctx.window.__fn();
  node('authEmail').value = 'a@example.com';
  await node('authSend').handlers.click.call(makeNode());
  await flush();
  node('authCode').value = '000000';
  await node('authVerify').handlers.click.call(makeNode());
  await flush();
  assert.equal(win.OLIdentity.mode(), 'guest');
  assert.match(node('authMsg').text, /验证码不对/);
  assert.equal(ctx.synced || 0, 0);
  assert.equal(!!ctx.reloaded, false);
});

test('退出：失败保持 user 状态；成功后才 demote 并停备份', async () => {
  const win = loadIdentity({ 'earthonline-space': JSON.stringify(USER) });
  const calls = loadAuth(win, [response(503, { ok: false, error: 'auth-unavailable' })]);
  /* 第一次：失败 */
  const modal = [];
  const ctx = {
    window: win, OLAuth: win.OLAuth, OLIdentity: win.OLIdentity,
    OLCloudBackup: { syncIdentity() { ctx.synced = (ctx.synced || 0) + 1; } },
    location: { reload() { ctx.reloaded = true; } },
    openModal: (cfg) => modal.push(cfg), OLT: (s) => s
  };
  vm.createContext(ctx);
  ctx.window.OLCloudBackup = ctx.OLCloudBackup;
  vm.runInContext(extractFn('logoutUser') + '\nwindow.__fn = logoutUser;', ctx);
  ctx.window.__fn();
  await flush();
  assert.equal(win.OLIdentity.mode(), 'local', '退出失败不得伪装成功');
  assert.equal(modal.length, 1);
  assert.equal(ctx.reloaded, undefined);

  /* 第二次：成功 */
  calls.push({ url: 'unused' }); /* 保留调用记录，不改行为 */
  const okCtx = {
    window: win, OLAuth: win.OLAuth, OLIdentity: win.OLIdentity,
    OLCloudBackup: { syncIdentity() { okCtx.synced = (okCtx.synced || 0) + 1; } },
    location: { reload() { okCtx.reloaded = true; } },
    openModal() {}, OLT: (s) => s
  };
  /* 用直接返回成功的 auth 客户端替换第二个回复 */
  win.OLAuth.logout = async () => ({ ok: true, status: 204, body: {}, error: '' });
  vm.createContext(okCtx);
  okCtx.window.OLCloudBackup = okCtx.OLCloudBackup;
  vm.runInContext(extractFn('logoutUser') + '\nwindow.__fn = logoutUser;', okCtx);
  okCtx.window.__fn();
  await flush();
  assert.equal(win.OLIdentity.isGuest(), true);
  assert.equal(okCtx.synced, 1);
  assert.equal(okCtx.reloaded, true);
});

/* ---------------- 静态契约 ---------------- */

test('静态：boot 在 user 身份下先验证 Session；只有明确失效才降级', () => {
  assert.match(BOOT_SRC, /userLooksSignedIn\(continueAfterIdentity\)/);
  assert.match(BOOT_SRC, /id\.demoteToGuest\(/);
  assert.match(BOOT_SRC, /OLAuth\.classifyAuthFailure/);
  assert.match(BOOT_SRC, /cls === 'session-invalid'/);
  assert.match(BOOT_SRC, /cls === 'transient'/);
  assert.match(BOOT_SRC, /会话状态无法确认/);
  assert.match(BOOT_SRC, /OLCloudBackup\.syncIdentity\(\)/);
});

test('静态：前端不存 token、不伪造 Access 凭证、不写死验证码', () => {
  assert.equal(/Cf-Access-Jwt-Assertion/.test(AUTH_SRC), false);
  assert.equal(/CO_Authorization/.test(AUTH_SRC), false);
  assert.equal(/setItem\([^)]*(token|code|session)/i.test(AUTH_SRC), false);
  assert.equal(/123456|000000/.test(AUTH_SRC), false);
  assert.match(AUTH_SRC, /credentials: 'include'/);
});
