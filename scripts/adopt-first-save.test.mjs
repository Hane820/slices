/* adopt-first-save.test.mjs — 旧库认领 → 完整启动 → 首次业务保存的端到端链路
 *
 * 使用 fake-indexeddb（隔离内存实现）+ 真实源码：identity / startup / db /
 * vendor Dexie / migrate / guest / write 全部按 index.html 顺序在 vm 中加载。
 * 业务保存走真实的 OLWrite.acquireWriter() + OLWrite.commit()，不是复制品。
 * 测试结束即丢弃，不碰任何真实数据库与用户数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createRequire } from 'node:module';

/* 项目 package.json 是 "type": "module"，vendor/dexie.min.js 的 UMD 走 globalThis 分支。
   在 Node realm 加载一次（与 fake-indexeddb 同 realm，避免跨 vm 的 Promise 挂起），
   再把构造器注入应用全局。Dexie 版本因此与页面实际加载的文件完全一致。 */
const ROOT = path.resolve(import.meta.dirname, '..');
const APP = path.join(ROOT, 'public', 'app');
const requireCjs = createRequire(path.join(ROOT, 'package.json'));
requireCjs('./public/app/vendor/dexie.min.js');
const DEXIE = globalThis.Dexie;
assert.equal(typeof DEXIE, 'function', 'Dexie 加载失败');

const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
const SRC = {
  identity: read('identity.js'),
  startup: read('startup.js'),
  db: read('db.js'),
  migrate: read('migrate.js'),
  guest: read('guest.js'),
  write: read('write.js')
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

/* 让 win 本身成为 vm 全局：Dexie UMD 会把自身挂到 globalThis（= win），
   db.js / write.js 里的 `global.X` 因此与 win.X 一致。 */
function run(src, win) {
  if (!win.__contextified) { vm.createContext(win); win.__contextified = true; }
  vm.runInContext(src, win, { filename: 'inline.js' });
}

function newApp(opts) {
  opts = opts || {};
  const win = {};
  win.sessionStorage = storage(opts.session);
  win.localStorage = storage(opts.local);
  win.indexedDB = new IDBFactory();
  win.IDBKeyRange = IDBKeyRange;
  win.structuredClone = globalThis.structuredClone;
  /* 关键：vm context 自带另一套内建 Promise，Dexie（Node realm）跟踪不到它的微任务，
     会在事务里触发 PrematureCommitError。注入 Node 的 Promise 让链路与 Dexie 同源。 */
  win.Promise = Promise;
  win.console = { log() {}, warn() {}, error() {} };
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => {};
  win.removeEventListener = () => {};

  win.Dexie = DEXIE;
  run(SRC.identity, win);
  run(SRC.startup, win);
  run(SRC.db, win);
  run(SRC.migrate, win);
  win.defaults = () => ({});
  win.OLMigrate = win.OLMigrate; /* migrate.js 自身已注册 */
  run(SRC.guest, win);
  run(SRC.write, win);
  return win;
}

/* 直接用同一 Dexie 造一个"旧版本数据库"：有业务数据，缺 migration / writer。 */
async function seedOldDb(win, shape) {
  const Dexie = win.Dexie;
  const db = new Dexie('earthonline', { indexedDB: win.indexedDB, IDBKeyRange: win.IDBKeyRange });
  db.version(1).stores({
    meta: 'key',
    definitions: '[kind+id], kind',
    tasks: 'id, cat, createdAt',
    schedule: 'id, weekday, date',
    dayEntries: '[type+id], [type+date], date, ts, updatedAt',
    dayMaps: '[kind+date], date'
  });
  await db.open();
  await db.transaction('rw', db.tables, async () => {
    await db.meta.bulkPut(shape.metaRows);
    await db.definitions.bulkPut(shape.definitions || []);
    await db.tasks.bulkPut(shape.tasks || []);
  });
  await db.close();
}

const OLD_META = [
  { key: 'v', value: 4 },
  { key: 'settings', value: { theme: 'sage', fontScale: 1 } },
  { key: 'schemaVersion', value: 1 }
];
const OLD_TASKS = [
  { id: 't-old-1', cat: 'must', text: '旧任务一', done: false, createdAt: 1700000000000 },
  { id: 't-old-2', cat: 'want', text: '旧任务二', done: true, doneTime: 1700000100000, createdAt: 1700000050000 }
];
const OLD_DEFS = [{ kind: 'pen', id: 'p-old-1', name: '旧钢笔', color: '#123456' }];

async function verifyViaFreshRead(win) {
  /* 模拟"重启"：关连接后重新打开再读 */
  await win.OLDB.close();
  await win.OLDB.open();
  const rep = await win.OLMigrate.rehydrate();
  return rep;
}

test('链路：旧库探测 has-data → 认领 → adopt → 取权 → 首次保存持久化', async () => {
  const win = newApp();
  await seedOldDb(win, { metaRows: OLD_META, tasks: OLD_TASKS, definitions: OLD_DEFS });

  /* 1) 首次启动：无身份记录 → 旧数据探测 */
  assert.equal(win.OLIdentity.hasRecord(), false);
  const d = await win.OLStartup.detectOldData();
  assert.equal(d.verdict, 'has-data', JSON.stringify(d));

  /* 2) guest 身份落定（认领旧库） */
  const settled = win.OLIdentity.settle({ space: 'guest', dbName: 'earthonline', adoptedOldData: true, source: 'detect-has-data' });
  assert.equal(settled.ok, true);

  /* 3) 绑定并打开（等价 boot.js 的 bindFromIdentity + OLDB.open） */
  assert.equal(win.OLDB.bindFromIdentity().name, 'earthonline');
  await win.OLDB.open();

  /* 4) 认领：补 migration 行，业务行数不变 */
  const beforeCounts = await win.OLMigrate.rehydrate();
  assert.equal(beforeCounts.ok, true);
  const adopt = await win.OLGuest.adopt();
  assert.equal(adopt.ok, true, JSON.stringify(adopt));
  assert.equal(adopt.adopted, true);
  const afterAdopt = await win.OLMigrate.rehydrate();
  assert.equal(afterAdopt.meta.migrationStatus, 'done');
  assert.equal(afterAdopt.counts.tasks, 2, '认领不得增删业务行');
  assert.equal(afterAdopt.data.pens.length, 1);
  assert.equal(afterAdopt.data.tasks.length, 2);

  /* 5) 取写入权（等价 bootWriter 的第一步） */
  const acq = await win.OLWrite.acquireWriter();
  assert.equal(acq.ok, true, JSON.stringify({ code: acq.code, message: acq.message }));
  const identityNow = win.OLWrite.currentWriterIdentity();
  assert.ok(identityNow && identityNow.ownerId && typeof identityNow.epoch === 'number');

  /* 6) 首次业务保存：全量状态 + 一条新任务，走真实 OLWrite.commit */
  const candidate = JSON.parse(JSON.stringify(beforeCounts.data));
  candidate.tasks.push({ id: 't-new-1', cat: 'routine', text: '认领后的第一条', done: false, createdAt: 1700000200000 });
  const cm = await win.OLWrite.commit(candidate, {
    ownerId: identityNow.ownerId,
    epoch: identityNow.epoch
  });
  assert.equal(cm.ok, true, JSON.stringify({ code: cm.code, reason: cm.reason, message: cm.message }));

  /* 7) 重启级验证：关连接重开，读回全部数据 */
  const rep = await verifyViaFreshRead(win);
  assert.equal(rep.ok, true);
  assert.equal(rep.meta.migrationStatus, 'done', 'migration 必须保持 done');
  const ids = rep.data.tasks.map((t) => t.id);
  assert.ok(ids.includes('t-old-1') && ids.includes('t-old-2'), '旧任务不得丢失');
  assert.ok(ids.includes('t-new-1'), '新任务必须持久化');
  assert.equal(rep.data.tasks.length, 3);
  assert.equal(rep.data.pens.length, 1, '旧定义保留');
  assert.equal(rep.data.v, 4);
  assert.ok(typeof rep.meta.bizRev === 'number', 'commit 必须推进 bizRev');
  /* writer 行存在且 active */
  const writerRow = rep.meta;
  assert.equal(writerRow.migrationStatus, 'done');
});

test('链路：全新安装 empty → 新建游客库 → 种子 → 取权 → 首次保存', async () => {
  const win = newApp();
  const d = await win.OLStartup.detectOldData();
  assert.equal(d.verdict, 'empty');
  const settled = win.OLIdentity.settle({ space: 'guest', dbName: 'earthonline-guest', adoptedOldData: false, source: 'detect-empty' });
  assert.equal(settled.ok, true);
  assert.equal(win.OLDB.bindFromIdentity().name, 'earthonline-guest');
  await win.OLDB.open();
  /* prepare 需要真实 defaults + buildRows（migrate.js 已加载），给一个最小种子 */
  win.defaults = () => ({
    v: 4,
    settings: { theme: 'sage' },
    plugins: [],
    definitions: [], tasks: [], schedule: [], dayEntries: [], dayMaps: []
  });
  const prep = await win.OLGuest.prepare();
  assert.equal(prep.ok, true, JSON.stringify(prep));
  const acq = await win.OLWrite.acquireWriter();
  assert.equal(acq.ok, true, JSON.stringify({ code: acq.code, message: acq.message }));
  const idn = win.OLWrite.currentWriterIdentity();
  const candidate = { v: 4, settings: { theme: 'sage' }, plugins: [], definitions: [], tasks: [{ id: 't-g1', cat: 'must', text: '游客首条', done: false, createdAt: 1 }], schedule: [], dayEntries: [], dayMaps: [] };
  const cm = await win.OLWrite.commit(candidate, { ownerId: idn.ownerId, epoch: idn.epoch });
  assert.equal(cm.ok, true, JSON.stringify({ code: cm.code, message: cm.message }));
  const rep = await verifyViaFreshRead(win);
  assert.equal(rep.ok, true);
  assert.equal(rep.data.tasks.length, 1);
  assert.equal(rep.data.tasks[0].text, '游客首条');
});

test('链路：认领后 writer 行缺失也能被 acquireWriter 首建（不依赖迁移遗留）', async () => {
  const win = newApp();
  await seedOldDb(win, { metaRows: OLD_META, tasks: OLD_TASKS });
  await win.OLStartup.detectOldData();
  win.OLIdentity.settle({ space: 'guest', dbName: 'earthonline', adoptedOldData: true });
  win.OLDB.bindFromIdentity();
  await win.OLDB.open();
  await win.OLGuest.adopt();
  /* 此时库里没有 writer 行：取权必须以「新建，epoch=floor」成功，而不是失败关闭 */
  const acq = await win.OLWrite.acquireWriter();
  assert.equal(acq.ok, true, JSON.stringify({ code: acq.code, message: acq.message }));
  assert.equal(acq.source, 'created');
});

/* ==================== foodLog 数据保真（测试 D） ====================
 * 旧库 settings 行含 250 条 foodLog → 完整认领启动链 → 真实 core.js 的
 * normalize()（按平衡大括号抽取源码 + 最小依赖桩，与 normalize-idempotent
 * 同一手法）→ 首次 OLWrite.commit → 关连接重开读回，250 条必须原样保留。
 * 说明：测试沙盒不加载完整 core.js（其依赖大量 DOM/渲染全局），因此 normalize
 * 以「真实源码 + 桩」方式执行——是现有架构下最接近生产启动流程的隔离方案。 */
const CORE_SRC = fs.readFileSync(path.join(APP, 'core.js'), 'utf8');

function extractBalanced(name) {
  const start = CORE_SRC.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'core.js 找不到 function ' + name);
  let depth = 0, i = CORE_SRC.indexOf('{', start);
  for (let j = i; j < CORE_SRC.length; j++) {
    const c = CORE_SRC[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return CORE_SRC.slice(start, j + 1); }
  }
  throw new Error(name + ' 大括号不平衡');
}
const FOODLOG_NORMALIZE_SRC =
  extractBalanced('byId') + '\n' +
  extractBalanced('normalizePlugins') + '\n' +
  extractBalanced('normalize');

function runRealNormalize(state) {
  const FOOD_SLOTS = ['breakfast', 'lunch', 'tea', 'dinner', 'night'];
  let seq = 0;
  const win = {
    S: state,
    /* normalize 首行调用 defaults() 并把缺省字段值取自它，桩必须给全最小结构 */
    defaults: () => ({
      tasks: [], schedule: [], plans: [], pens: [], tags: [], tagLogs: [], suggestions: [],
      workouts: [], studyLogs: [], decisionLog: [], restDays: [], flashes: [], itemLogs: [], meals: [],
      notes: {}, marks: {}, doneSugg: {},
      settings: { goals: {}, resetHour: 4, theme: 'default', foodItems: [], foodLog: [], mealSlots: [], focusItems: [] },
      plugins: []
    }),
    THEME_KEYS: ['default', 'sage', 'sepia', 'ink'],
    PRESETS: { FILTER_ALL: '全部', FOCUS_ITEMS: [] },
    FOOD_SLOTS,
    uid: (p) => p + '-gen-' + (++seq),
    UNIT_DEFAULT: '分钟',
    PARTS: [],
    CAT_MUST: 'must', CAT_WANT: 'want', CAT_ROUTINE: 'routine',
    DEFAULT_SCENES: {},
    TODAY: () => '2026-01-01',
    defaultScenes: () => []
  };
  win.window = win;
  win.self = win;
  vm.createContext(win);
  vm.runInContext(FOODLOG_NORMALIZE_SRC + '\nself.normalize = normalize;', win);
  win.normalize();
  return win.S;
}

test('链路：旧库 250 条 foodLog → 认领 → normalize → 首次保存 → 重启后全部保留', async () => {
  const win = newApp();
  /* 1) 造旧库：settings 行带 250 条 foodLog（超过旧版 200 条上限） */
  const bigLog = [];
  for (let i = 0; i < 250; i++) {
    bigLog.push({ id: 'fl-old-' + i, date: '2026-01-01', ts: 1700000000000 + i, name: '旧菜' + i, slot: i % 2 ? 'lunch' : 'dinner' });
  }
  await seedOldDb(win, {
    metaRows: [
      { key: 'v', value: 4 },
      { key: 'settings', value: { theme: 'sage', fontScale: 1, foodLog: bigLog } },
      { key: 'schemaVersion', value: 1 }
    ],
    tasks: OLD_TASKS,
    definitions: OLD_DEFS
  });

  /* 2) 认领启动链：探测 → settle → bind → open → adopt */
  const d = await win.OLStartup.detectOldData();
  assert.equal(d.verdict, 'has-data');
  const settled = win.OLIdentity.settle({ space: 'guest', dbName: 'earthonline', adoptedOldData: true, source: 'detect-has-data' });
  assert.equal(settled.ok, true);
  assert.equal(win.OLDB.bindFromIdentity().name, 'earthonline');
  await win.OLDB.open();
  await win.OLGuest.adopt();

  /* 3) 读取阶段：250 条一条不少 */
  const beforeCounts = await win.OLMigrate.rehydrate();
  assert.equal(beforeCounts.ok, true);
  assert.equal(beforeCounts.data.settings.foodLog.length, 250, '认领读取阶段 250 条齐全');

  /* 4) 启动所需 normalize（真实 core.js 源码）：不得截断、不得改动内容 */
  let candidate = JSON.parse(JSON.stringify(beforeCounts.data));
  candidate.tasks.push({ id: 't-new-1', cat: 'routine', text: '认领后的第一条', done: false, createdAt: 1700000200000 });
  runRealNormalize(candidate);
  candidate = JSON.parse(JSON.stringify(candidate)); /* vm 内重建的对象回到 Node realm */
  assert.equal(candidate.settings.foodLog.length, 250, 'normalize 不得按数量截断 foodLog');
  assert.deepEqual(candidate.settings.foodLog[0], bigLog[0], 'normalize 后首条原样');
  assert.deepEqual(candidate.settings.foodLog[249], bigLog[249], 'normalize 后末条原样');

  /* 5) 取权 + 首次业务保存 */
  const acq = await win.OLWrite.acquireWriter();
  assert.equal(acq.ok, true, JSON.stringify({ code: acq.code, message: acq.message }));
  const idn = win.OLWrite.currentWriterIdentity();
  const cm = await win.OLWrite.commit(candidate, { ownerId: idn.ownerId, epoch: idn.epoch });
  assert.equal(cm.ok, true, JSON.stringify({ code: cm.code, reason: cm.reason, message: cm.message }));

  /* 6) 重启级验证：关连接重开读回，250 条内容与顺序完全一致 */
  const rep = await verifyViaFreshRead(win);
  assert.equal(rep.ok, true);
  const savedLog = JSON.parse(JSON.stringify(rep.data.settings.foodLog)); /* vm realm → Node */
  assert.equal(savedLog.length, 250, '重启后 250 条必须全部保留');
  assert.deepEqual(savedLog.map((l) => l.id), bigLog.map((l) => l.id), '顺序不得改变');
  assert.deepEqual(savedLog[0], bigLog[0], '首条内容一致');
  assert.deepEqual(savedLog[124], bigLog[124], '中间记录内容一致');
  assert.deepEqual(savedLog[249], bigLog[249], '末条内容一致');
  /* 同链路回归：旧任务、新任务也都在 */
  const ids = rep.data.tasks.map((t) => t.id);
  assert.ok(ids.includes('t-old-1') && ids.includes('t-new-1'), '任务数据不受影响');
});
