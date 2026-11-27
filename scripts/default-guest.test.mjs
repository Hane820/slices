/* default-guest.test.mjs — 默认游客入口与三个 P0 的回归测试
 *
 * 全部在 vm 里加载真实源码（identity.js / startup.js / db.js / guest.js），
 * 不复制生产实现。浏览器 API 用最小假件；不碰 IndexedDB、不发请求、不写文件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = path.join(ROOT, 'public', 'app');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
const SRC = {
  identity: read('identity.js'),
  startup: read('startup.js'),
  db: read('db.js'),
  guest: read('guest.js'),
  boot: read('boot.js'),
  cloud: read('cloud-backup.js'),
  migrate: read('migrate.js'),
  html: read('index.html')
};

function storage(init) {
  const map = new Map(Object.entries(init || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get length() { return map.size; },
    key: (i) => Array.from(map.keys())[i] ?? null
  };
}

function run(src, win, extra) {
  vm.runInNewContext(src, Object.assign({ window: win, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Promise }, extra || {}));
}

/* ---------------- 身份：默认游客、认领、不覆盖 ---------------- */

test('首次启动：无身份记录时 mode=guest，库名是 earthonline-guest', () => {
  const win = {};
  win.sessionStorage = storage();
  run(SRC.identity, win);
  assert.equal(win.OLIdentity.hasRecord(), false);
  assert.equal(win.OLIdentity.mode(), 'guest');
  assert.equal(win.OLIdentity.dbName(), 'earthonline-guest');
});

test('旧数据认领：settle 写入 adoptedOldData，库名指向旧库', () => {
  const win = {};
  win.sessionStorage = storage();
  run(SRC.identity, win);
  const r = win.OLIdentity.settle({ space: 'guest', dbName: 'earthonline', adoptedOldData: true, source: 'detect-has-data' });
  assert.equal(r.ok, true);
  assert.equal(win.OLIdentity.record().space, 'guest');
  assert.equal(win.OLIdentity.record().dbName, 'earthonline');
  assert.equal(win.OLIdentity.record().adoptedOldData, true);
  /* 二次 settle 不得覆盖 */
  assert.equal(win.OLIdentity.settle({ space: 'local', dbName: 'earthonline' }).reason, 'already-settled');
  assert.equal(win.OLIdentity.mode(), 'guest');
});

test('已有正式身份不被默认游客逻辑改写（已有 user/local identity 不切换）', () => {
  const win = {};
  win.sessionStorage = storage({ 'earthonline-space': 'local' });
  run(SRC.identity, win);
  assert.equal(win.OLIdentity.mode(), 'local');
  assert.equal(win.OLIdentity.dbName(), 'earthonline');
  assert.equal(win.OLIdentity.settle({ space: 'guest', dbName: 'earthonline-guest' }).ok, false);
});

/* ---------------- 旧数据探测：只判断、不建库 ---------------- */

function fakeIdb(names, dbInfo) {
  return {
    databases: () => Promise.resolve(names.map((n) => ({ name: n }))),
    open(name) {
      const req = {};
      Promise.resolve().then(() => {
        if (!dbInfo || !dbInfo.present) { if (req.onerror) req.onerror({ target: req }); return; }
        const store = (n) => ({
          count() { const r = {}; Promise.resolve().then(() => { r.result = (dbInfo.counts || {})[n] || 0; r.onsuccess && r.onsuccess(); }); return r; },
          get(k) { const r = {}; Promise.resolve().then(() => { r.result = k === 'schemaVersion' ? { value: 1 } : undefined; r.onsuccess && r.onsuccess(); }); return r; }
        });
        req.result = {
          objectStoreNames: dbInfo.tables || ['meta', 'definitions', 'tasks', 'schedule', 'dayEntries', 'dayMaps'],
          transaction: () => ({ objectStore: store }),
          close() {}
        };
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
}

function loadStartup(win) {
  run(SRC.startup, win);
  return win.OLStartup;
}

test('探测：没有 databases() 且旧键无数据 → unknown，不新建空库', async () => {
  const win = { indexedDB: {}, localStorage: storage() };
  const d = await loadStartup(win).detectOldData();
  assert.equal(d.verdict, 'unknown');
});

test('探测：确认无旧库且无旧键 → empty', async () => {
  const win = { indexedDB: fakeIdb([]), localStorage: storage() };
  const d = await loadStartup(win).detectOldData();
  assert.equal(d.verdict, 'empty');
});

test('探测：旧键有存档但无库 → has-data（认领）', async () => {
  const win = { indexedDB: fakeIdb([]), localStorage: storage({ 'earthonline-v4': JSON.stringify({ tasks: [1] }) }) };
  const d = await loadStartup(win).detectOldData();
  assert.equal(d.verdict, 'has-data');
  assert.equal(d.detectedBy, 'localStorage');
});

test('探测：旧库存在且有数据 → has-data，且不写任何业务行', async () => {
  const win = { indexedDB: fakeIdb(['earthonline'], { present: true, counts: { tasks: 3, definitions: 2 } }), localStorage: storage() };
  const d = await loadStartup(win).detectOldData();
  assert.equal(d.verdict, 'has-data');
  assert.equal(d.detectedBy, 'idb');
  assert.equal(d.reason, 'old-db-has-rows');
});

test('探测：旧库存在但六表为空 → empty（不是覆盖现场）', async () => {
  const win = { indexedDB: fakeIdb(['earthonline'], { present: true, counts: {} }), localStorage: storage() };
  const d = await loadStartup(win).detectOldData();
  assert.equal(d.verdict, 'empty');
});

/* ---------------- P0-2：库名在身份落定后才绑定 ---------------- */

function loadDb(win) {
  win.indexedDB = win.indexedDB || fakeIdb([]);
  win.Dexie = function Dexie(name) { this.name = name; };
  win.IDBKeyRange = function () {};
  run(SRC.db, win);
  return win.OLDB;
}

test('P0-2：身份未落定时 bindFromIdentity 失败，instance 明确抛错', () => {
  const win = {};
  win.sessionStorage = storage();
  const db = loadDb(win);
  const bound = db.bindFromIdentity();
  assert.equal(bound.ok, false);
  assert.equal(bound.reason, 'identity-not-settled');
  /* 未绑定时库名必须是 null，绝不能回落到 'earthonline' */
  assert.equal(db.status().name, null);
  assert.match(SRC.db, /if \(!currentDbName\(\)\)/, '打开前必须有未绑定保护');
});

test('P0-2：settle 之后才绑定，库名来自记录，不回落到正式库', () => {
  const win = {};
  win.sessionStorage = storage();
  run(SRC.identity, win);
  const db = loadDb(win);
  assert.equal(db.bindFromIdentity().name, 'earthonline-guest');
  assert.equal(db.NAME, 'earthonline-guest');
  assert.equal(db.status().name, 'earthonline-guest');
});

test('P0-2：显式 local 身份绑定正式库（不猜、不回落）', () => {
  const win = {};
  win.sessionStorage = storage({ 'earthonline-space': 'local' });
  run(SRC.identity, win);
  const db = loadDb(win);
  assert.equal(db.bindFromIdentity().name, 'earthonline');
});

/* ---------------- P0-1 / P0-3：migration 行与库存在性 ---------------- */

function fakeAdoptDb(opts) {
  const meta = new Map(opts.meta || []);
  const tables = ['definitions', 'tasks', 'schedule', 'dayEntries', 'dayMaps'];
  const stores = { meta: {
    get: (k) => Promise.resolve(meta.get(k)),
    put: (r) => { meta.set(r.key, r); return Promise.resolve(); }
  } };
  tables.forEach((n) => {
    stores[n] = { get: () => Promise.resolve(null), put: () => Promise.resolve(), bulkPut: () => Promise.resolve(), count: () => Promise.resolve(0) };
  });
  return {
    meta: stores.meta,
    transaction(type, ...args) {
      const fn = args[args.length - 1];
      return Promise.resolve().then(fn);
    },
    ...stores,
    _meta: meta
  };
}

test('P0-1：认领旧库补写 migration=done/phase=adopted-old，业务数据不变', async () => {
  const win = {};
  win.sessionStorage = storage();
  win.indexedDB = {};
  win.localStorage = storage();
  run(SRC.identity, win);
  win.OLIdentity.settle({ space: 'guest', dbName: 'earthonline', adoptedOldData: true, source: 'detect-has-data' });
  /* migrate.js 先于 guest.js 加载，生产里这个依赖已满足；测试把桩挂在 window 上 */
  win.defaults = () => ({});
  win.OLMigrate = { SCHEMA_VERSION: 1 };
  run(SRC.guest, win);
  /* 用假 OLDB 满足 isGuestDb()/instance() */
  const fakeDb = fakeAdoptDb({ meta: [['schemaVersion', { key: 'schemaVersion', value: 1 }]] });
  win.OLDB = { NAME: 'earthonline', instance: () => fakeDb };
  assert.equal(win.OLGuest.isAdopted(), true);
  assert.equal(win.OLGuest.isGuestDb(), true);
  const r = await win.OLGuest.adopt();
  assert.equal(r.ok, true);
  assert.equal(r.adopted, true);
  assert.equal(fakeDb._meta.get('migration').status, 'done');
  assert.equal(fakeDb._meta.get('migration').phase, 'adopted-old');
  assert.equal(fakeDb._meta.get('schemaVersion').value, 1, '已有 schemaVersion 不得被改写');
});

test('P0-1：认领时遇到未完成的 migration 不签字、直接失败', async () => {
  const win = {};
  win.sessionStorage = storage();
  run(SRC.identity, win);
  win.OLIdentity.settle({ space: 'guest', dbName: 'earthonline', adoptedOldData: true });
  run(SRC.guest, win, { defaults: () => ({}) });
  const fakeDb = fakeAdoptDb({ meta: [['migration', { key: 'migration', status: 'in_progress' }]] });
  win.OLDB = { NAME: 'earthonline', instance: () => fakeDb };
  const r = await win.OLGuest.adopt();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'migration-not-done');
  assert.equal(fakeDb._meta.get('migration').status, 'in_progress');
});

test('P0-1：正式迁移写事务在收尾把 migration 置为 done', () => {
  assert.match(SRC.migrate, /m\.status\s*=\s*'done'/);
  assert.match(SRC.migrate, /m\.phase\s*=\s*'finalizing'/);
});

test('P0-3：已有身份时先只读校验库存在性，库缺失走阻断而非 open', () => {
  const boot = SRC.boot;
  const start = boot.slice(boot.indexOf('function startBoot()'));
  assert.match(start, /OLDB\.exists\(\)/);
  assert.match(start, /ex !== 'yes'/);
  assert.match(start, /身份指向的数据库不存在/);
  /* 该分支必须 return，不能落到 bootGuest/open */
  const blockedAt = start.indexOf('身份指向的数据库不存在');
  const guestAt = start.indexOf('bootGuest()', blockedAt);
  const returnAt = start.indexOf('return;', blockedAt);
  assert.ok(returnAt > 0 && returnAt < guestAt, '阻断后必须立即返回');
});

/* ---------------- 游客离线与云端隔离 ---------------- */

test('旧身份入口守卫：已是 guest（含认领）时 enterGuest 拒绝，认领记录不被覆盖', () => {
  const win = {};
  win.sessionStorage = storage();
  run(SRC.identity, win);
  win.OLIdentity.settle({ space: 'guest', dbName: 'earthonline', adoptedOldData: true });
  assert.equal(win.OLIdentity.enterGuest(), false, '认领状态下再点「游客体验」必须被拒绝');
  assert.equal(win.OLIdentity.record().dbName, 'earthonline', '记录保持指向认领库');
  assert.equal(win.OLIdentity.record().adoptedOldData, true);
  /* leaveGuest 无调用方（settings 旧入口只用 enterGuest），保留但行为=回到默认游客 */
  assert.equal(typeof win.OLIdentity.leaveGuest, 'function');
});

test('旧身份入口守卫：无记录时 enterGuest 仍可用（兼容旧调用方）', () => {
  const win = {};
  win.sessionStorage = storage();
  run(SRC.identity, win);
  assert.equal(win.OLIdentity.enterGuest(), true);
  assert.equal(win.OLIdentity.mode(), 'guest');
});

test('startup.js 与 guest.js 不发任何网络请求', () => {
  for (const name of ['startup', 'guest']) {
    assert.equal(/\bfetch\s*\(/.test(SRC[name]), false, name + '.js 不应发请求');
    assert.equal(/XMLHttpRequest|sendBeacon|WebSocket/.test(SRC[name]), false);
  }
});

test('cloud-backup 的游客门禁覆盖全部入口，默认游客不会启动上传', () => {
  const calls = SRC.cloud.match(/if\(guestBlocked\(\)\)/g) || [];
  assert.ok(calls.length >= 4, 'run/markDirty/backupNow/refreshStatus/startUser 都要有门禁，实际 ' + calls.length);
  /* 门禁只认身份模块的已落定记录：显式 local 才允许，其余（含认领旧库的 guest）一律拒绝 */
  assert.match(SRC.cloud, /OLIdentity\.record\(\)/);
  assert.match(SRC.cloud, /space !== 'local'/);
  assert.match(SRC.cloud, /syncIdentity:syncIdentity/);
  /* 默认没身份 = 游客，判定为 true */
  const win = {};
  win.sessionStorage = storage();
  run(SRC.identity, win);
  assert.equal(win.OLIdentity.isGuest(), true);
});

test('入口顺序：startup.js 在 identity.js 之后、db.js 之前', () => {
  const ids = [...SRC.html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  const a = ids.indexOf('identity.js'), b = ids.indexOf('startup.js'), c = ids.indexOf('db.js');
  assert.ok(a >= 0 && b > a && c > b, `实际顺序 ${a}/${b}/${c}`);
});
