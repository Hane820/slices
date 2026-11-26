/* guest-space.test.mjs — 空间隔离与游客种子初始化的单元/静态验证（不需要浏览器）
 *
 * 覆盖：
 *   1. identity.js：默认 local、进入/退出游客、库名切换、记录损坏时 fail-closed 到 guest、
 *      且绝不读写 localStorage（用会抛错的 getter 证明）。
 *   2. guest.js 守卫：库名不是 earthonline-guest 时 prepare/clear 一律拒绝，且不会删库。
 *   3. guest.js 种子：首次初始化、幂等、结构异常/写入失败/半初始化状态的处理，
 *      以及 OLMigrate.buildRows 返回 { rows, issues } 这一形状（seed-failed 回归用例）。
 *   4. 静态断言：正式库键与网络出口不被游客代码触碰。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = path.join(ROOT, 'public', 'app');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');

const IDENTITY_SRC = read('identity.js');
const GUEST_SRC = read('guest.js');

function makeStorage(init) {
  const map = new Map(Object.entries(init || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    get length() { return map.size; },
    key: (i) => Array.from(map.keys())[i] ?? null
  };
}

function loadIdentity(opts) {
  opts = opts || {};
  const win = {};
  win.sessionStorage = opts.sessionBroken
    ? { getItem() { throw new Error('sessionStorage denied'); } }
    : makeStorage(opts.session);
  /* 身份模块只该用 sessionStorage：任何 localStorage 访问都让测试直接失败 */
  Object.defineProperty(win, 'localStorage', {
    get() { throw new Error('identity.js 不应访问 localStorage'); }
  });
  vm.runInNewContext(IDENTITY_SRC, { window: win });
  return win;
}

test('identity: 没有记录时默认 local，库名是正式库', () => {
  const win = loadIdentity();
  assert.equal(win.OLIdentity.mode(), 'local');
  assert.equal(win.OLIdentity.isGuest(), false);
  assert.equal(win.OLIdentity.dbName(), 'earthonline');
});

test('identity: 进入游客后切到独立库，退出后回到正式库', () => {
  const win = loadIdentity();
  assert.equal(win.OLIdentity.enterGuest(), true);
  assert.equal(win.OLIdentity.mode(), 'guest');
  assert.equal(win.OLIdentity.dbName(), 'earthonline-guest');
  assert.notEqual(win.OLIdentity.dbName(), win.OLIdentity.FORMAL_DB);
  assert.equal(win.OLIdentity.leaveGuest(), true);
  assert.equal(win.OLIdentity.mode(), 'local');
});

test('identity: 记录损坏时 fail-closed 到 guest，不打开正式库', () => {
  const win = loadIdentity({ session: { 'earthonline-space': 'GUEST??' } });
  assert.equal(win.OLIdentity.mode(), 'guest');
  assert.equal(win.OLIdentity.dbName(), 'earthonline-guest');
});

test('identity: 显式写成 local 时仍是正式库', () => {
  const win = loadIdentity({ session: { 'earthonline-space': 'local' } });
  assert.equal(win.OLIdentity.mode(), 'local');
});

test('identity: sessionStorage 被禁用时不抛错，也不会误进游客空间', () => {
  const win = loadIdentity({ sessionBroken: true });
  assert.equal(win.OLIdentity.mode(), 'local');
  assert.equal(win.OLIdentity.enterGuest(), false);
});

/* ---------------- 假的 Dexie：够用就好，重点是事务回滚与表计数 ---------------- */

function makeFakeDb(opts) {
  opts = opts || {};
  const state = {
    meta: new Map(),
    t: { definitions: [], tasks: [], schedule: [], dayEntries: [], dayMaps: [] }
  };
  const snap = () => ({
    meta: new Map(state.meta),
    t: Object.fromEntries(Object.entries(state.t).map(([k, v]) => [k, v.slice()]))
  });
  const restore = (s) => { state.meta = s.meta; state.t = s.t; };

  function table(name) {
    const isMeta = name === 'meta';
    return {
      count: () => Promise.resolve(isMeta ? state.meta.size : state.t[name].length),
      get: (k) => Promise.resolve(isMeta ? state.meta.get(k) : null),
      put: (row) => {
        if (opts.failOn === name + ':put') return Promise.reject(new Error('AbortError: put failed'));
        if (isMeta) state.meta.set(row.key, row);
        return Promise.resolve();
      },
      bulkPut: (rows) => {
        if (opts.failOn === name) return Promise.reject(new Error('QuotaExceededError: bulkPut failed'));
        rows.forEach((r) => { if (isMeta) state.meta.set(r.key, r); else state.t[name].push(r); });
        return Promise.resolve();
      }
    };
  }

  const db = {
    meta: table('meta'),
    definitions: table('definitions'),
    tasks: table('tasks'),
    schedule: table('schedule'),
    dayEntries: table('dayEntries'),
    dayMaps: table('dayMaps'),
    transaction: (mode, ...rest) => {
      const cb = rest.pop();
      const before = snap();
      let ret;
      try { ret = cb(); } catch (e) { restore(before); return Promise.reject(e); }
      return Promise.resolve(ret).catch((e) => { restore(before); throw e; });
    }
  };
  return { db, state };
}

function loadGuest(opts) {
  opts = opts || {};
  const logs = [];
  const fake = opts.db ? { db: opts.db, state: opts.state } : makeFakeDb(opts.fakeOpts);
  const win = {
    OLDB: { NAME: opts.dbName || 'earthonline-guest', instance: () => fake.db, close: () => Promise.resolve() },
    OLMigrate: {
      SCHEMA_VERSION: 1,
      buildRows: opts.buildRows || (() => { throw new Error('buildRows 未注入'); })
    },
    defaults: () => ({ v: 4, settings: {}, plugins: [], tasks: [], pens: [], tags: [], suggestions: [], scenes: [] }),
    indexedDB: { deleteDatabase() { throw new Error('不该走到删库'); } }
  };
  vm.runInNewContext(GUEST_SRC, {
    window: win,
    console: { error: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), log() {} }
  });
  return { win, logs, state: fake.state };
}

const SEED_ROWS = {
  meta: [{ key: 'v', value: 4 }, { key: 'settings', value: {} }, { key: 'plugins', value: [] }],
  definitions: [{ kind: 'pen', id: 'p1' }, { kind: 'tag', id: 't1' }],
  tasks: [{ id: 't1', cat: '家常', createdAt: 1 }],
  schedule: [],
  dayEntries: [],
  dayMaps: []
};
const goodBuildRows = () => ({ rows: JSON.parse(JSON.stringify(SEED_ROWS)), issues: [] });

test('guest: 库名是正式库时 prepare / clear 拒绝，且不删库', async () => {
  const { win } = loadGuest({ dbName: 'earthonline', buildRows: goodBuildRows });
  assert.equal(win.OLGuest.isGuestDb(), false);
  const p = await win.OLGuest.prepare();
  assert.equal(p.ok, false);
  assert.equal(p.reason, 'not-guest-db');
  const c = await win.OLGuest.clear();
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'not-guest-db');
});

test('guest: 空库首次初始化成功，写入种子与完成标记', async () => {
  const { win, state } = loadGuest({ buildRows: goodBuildRows });
  const r = await win.OLGuest.prepare();
  assert.equal(r.ok, true);
  assert.equal(r.seeded, true);
  assert.equal(state.meta.get('schemaVersion').value, 1);
  assert.equal(state.meta.get('migration').status, 'done');
  assert.equal(state.t.definitions.length, 2);
  assert.equal(state.t.tasks.length, 1);
});

test('guest: 重复 prepare 不再灌种子（幂等）', async () => {
  const { win, state } = loadGuest({ buildRows: goodBuildRows });
  assert.equal((await win.OLGuest.prepare()).seeded, true);
  const second = await win.OLGuest.prepare();
  assert.equal(second.ok, true);
  assert.equal(second.seeded, false);
  assert.equal(state.t.definitions.length, 2, '第二次不应重复 bulkPut');
});

test('guest: buildRows 返回 { rows, issues } 时能正确取到表（seed-failed 回归用例）', async () => {
  /* 若代码把 buildRows 的返回值当表映射用，这里会因 rows.meta === undefined 抛 .length 错误 */
  const { win, state } = loadGuest({ buildRows: () => ({ rows: JSON.parse(JSON.stringify(SEED_ROWS)), issues: [] }) });
  const r = await win.OLGuest.prepare();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(state.t.definitions.length, 2);
});

test('guest: buildRows 缺表时给出明确错误，且不写完成标记', async () => {
  const broken = () => {
    const rows = JSON.parse(JSON.stringify(SEED_ROWS));
    delete rows.dayMaps;
    return { rows, issues: [] };
  };
  const { win, state } = loadGuest({ buildRows: broken });
  const r = await win.OLGuest.prepare();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'buildrows-missing-table');
  assert.match(r.message, /dayMaps/);
  assert.equal(state.meta.has('schemaVersion'), false);
  assert.equal(state.meta.has('migration'), false);
});

test('guest: buildRows 返回值形状不对时给出明确错误', async () => {
  const { win } = loadGuest({ buildRows: () => SEED_ROWS });
  const r = await win.OLGuest.prepare();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'buildrows-invalid');
});

test('guest: 写入中途失败 → 事务回滚，不留完成标记', async () => {
  const { win, state } = loadGuest({ buildRows: goodBuildRows, fakeOpts: { failOn: 'tasks' } });
  const r = await win.OLGuest.prepare();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'seed-failed');
  assert.equal(state.meta.has('schemaVersion'), false, '失败不得写入 schemaVersion');
  assert.equal(state.meta.has('migration'), false, '失败不得写入 migration 完成行');
  assert.equal(state.t.definitions.length, 0, '已写入的表必须回滚');
});

test('guest: 已有数据但缺完成标记 → 不覆盖，报 incomplete', async () => {
  const fake = makeFakeDb();
  fake.state.t.definitions.push({ kind: 'pen', id: 'user-owned' });
  const { win } = loadGuest({ db: fake.db, state: fake.state, buildRows: goodBuildRows });
  const r = await win.OLGuest.prepare();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'incomplete-guest-db');
  assert.equal(fake.state.t.definitions.length, 1);
  assert.equal(fake.state.t.definitions[0].id, 'user-owned', '已有数据一个字都不能动');
  assert.equal(fake.state.meta.has('migration'), false);
});

/* 真实依赖的契约用例：用真的 presets.js / migrate.js / core.js，而不是桩。
   目的：锁住 OLMigrate.buildRows() 返回 { rows, issues } 这个形状，以及 defaults()
   能被建行成六张表——上一版 seed-failed 就是这里对不上。 */
function makeDomStub() {
  const el = () => ({
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {}, setAttribute() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    innerHTML: '', textContent: '', dataset: {}
  });
  const doc = {
    readyState: 'complete', body: el(), documentElement: el(),
    createElement: el, querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, getElementById() { return null; }
  };
  const win = {
    document: doc, navigator: { userAgent: 'node' }, location: { reload() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {}, setTimeout, clearTimeout
  };
  win.window = win;
  return win;
}

test('契约：真实 defaults() + 真实 buildRows() 能建出六张表的行', () => {
  const ctx = vm.createContext(makeDomStub());
  for (const f of ['presets.js', 'identity.js', 'migrate.js', 'core.js']) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  const r = vm.runInContext(`(function(){
    var built = OLMigrate.buildRows(defaults());
    var rows = built.rows;
    return {
      shape: Object.keys(built).sort(),
      tables: ['meta','definitions','tasks','schedule','dayEntries','dayMaps'].map(function(k){
        return Array.isArray(rows[k]) ? rows[k].length : -1;
      }),
      issues: built.issues.length,
      hasPayload: rows.meta.map(function(x){ return x.key; }).join(',')
    };
  })()`, ctx);

  assert.equal(r.shape.join(','), 'issues,rows', 'buildRows 必须返回 { rows, issues }');
  assert.ok(r.tables.every((n) => n >= 0), '六张表都必须是数组：' + r.tables.join(','));
  assert.ok(r.tables[1] > 0, '定义表应有种子（笔/标签/建议/情境）');
  assert.equal(r.issues, 0);
  assert.equal(r.hasPayload, 'v,settings,plugins');
});

test('静态：guest.js 不引用正式库的存储键、不读 localStorage 业务数据', () => {
  assert.equal(/['"]earthonline-v4['"]/.test(GUEST_SRC), false);
  assert.equal(/getItem\s*\(/.test(GUEST_SRC), false);
});

test('静态：guest.js 不含任何网络调用', () => {
  assert.equal(/\bfetch\s*\(/.test(GUEST_SRC), false);
  assert.equal(/XMLHttpRequest|sendBeacon/.test(GUEST_SRC), false);
});

test('静态：db.js 通过身份模块取库名，且只认两个库名', () => {
  const db = read('db.js');
  assert.match(db, /OLIdentity\.dbName\(\)/);
  assert.match(db, /earthonline-guest/);
});

test('静态：cloud-backup 的四个真实出口都挂了游客门禁', () => {
  const src = read('cloud-backup.js');
  const calls = src.match(/if\(guestBlocked\(\)\)/g) || [];
  assert.ok(calls.length >= 4, 'init/markDirty/backupNow/refreshStatus 都要有门禁，实际 ' + calls.length);
});

test('静态：boot.js 游客分支不回退 legacy，也不调用迁移', () => {
  const boot = read('boot.js');
  const guestFn = boot.slice(boot.indexOf('function bootGuest()'), boot.indexOf('function startBoot()'));
  assert.ok(guestFn.length > 0);
  assert.equal(/bootLegacy\(\)/.test(guestFn), false);
  assert.equal(/OLMigrate\.(run|status)\(/.test(guestFn), false);
});
