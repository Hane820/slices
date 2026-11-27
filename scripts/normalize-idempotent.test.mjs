/* normalize-idempotent.test.mjs — 启动数据规范化的幂等性验证（隔离内存）
 *
 * 从 core.js 中按平衡大括号抽取真实的 normalize() 函数源码，在 vm 里配最小
 * 依赖桩运行：第一次模拟旧格式数据（缺 id、非法值、超长列表），断言它会被
 * 规范化；第二次运行必须零改动（幂等）。全程纯内存，不碰任何数据库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'app', 'core.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf('function ' + name + '(){');
  assert.ok(start >= 0, '找不到 function ' + name);
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(name + ' 大括号不平衡');
}

const NORMALIZE_SRC = extractFn('normalize');
const NORMALIZE_PLUGINS_SRC = extractFn2('normalizePlugins');

function extractFn2(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '找不到 function ' + name);
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(name + ' 大括号不平衡');
}

const THEME_KEYS = ['default', 'sage', 'sepia', 'ink'];
const FILTER_ALL = '全部';
const FOOD_SLOTS = ['breakfast', 'lunch', 'tea', 'dinner', 'night'];
const UNIT_DEFAULT = '分钟';
const PARTS = ['胸', '背', '腿'];
let seq = 0;
const uid = (p) => p + '-gen-' + (++seq);
const defaults = () => ({
  tasks: [], schedule: [], plans: [], pens: [], tags: [], tagLogs: [], suggestions: [],
  workouts: [], studyLogs: [], decisionLog: [], restDays: [], flashes: [], itemLogs: [], meals: [],
  notes: {}, marks: {}, doneSugg: {},
  settings: {
    goals: {}, resetHour: 4, theme: 'default', libFilter: FILTER_ALL, randFilter: FILTER_ALL,
    foodItems: [], foodLog: [], mealSlots: ['早餐', '午餐'], focusItems: []
  },
  plugins: []
});

/* normalize 依赖的其它 core 内部函数/常量：byId 抽真源码，其余给行为等价的最小桩 */
const BYID_SRC = extractFn2('byId');

function runNormalize(state) {
  const win = {
    S: state, defaults,
    THEME_KEYS, PRESETS: { FILTER_ALL, FOCUS_ITEMS: [{ id: 'fi-study', text: '学习', mode: 'count', unit: '分钟' }] },
    FOOD_SLOTS, uid, UNIT_DEFAULT, PARTS,
    CAT_MUST: 'must', CAT_WANT: 'want', CAT_ROUTINE: 'routine',
    DEFAULT_SCENES: {},
    TODAY: () => '2026-01-01',
    defaultScenes: () => []
  };
  win.window = win;
  win.self = win;
  vm.createContext(win);
  vm.runInContext(
    BYID_SRC + '\n' + NORMALIZE_PLUGINS_SRC + '\n' + NORMALIZE_SRC +
    '\nself.normalize = normalize; self.normalizePlugins = normalizePlugins;', win);
  win.normalize();
  return win.S;
}

test('normalize：旧格式数据首次运行会被规范化（补 id / 修非法值）', () => {
  const old = defaults();
  old.settings.theme = '不存在的主题';
  old.settings.resetHour = '9';                     /* 非数字 */
  old.settings.foodItems = [
    { name: '  番茄炒蛋  ', cat: '家常菜', slots: ['breakfast', '不存在的槽'], enabled: true },
    { noName: true },                                 /* 非法项：应被丢弃 */
    null
  ];
  old.settings.foodLog = [
    { date: '2026-01-01', name: '面', slot: 'lunch' },  /* 缺 id → 补 */
    { bad: true }                                      /* 非法项：应被丢弃 */
  ];
  old.settings.mealSlots = ['  早餐 ', '早餐', '', 123, '午餐', '下午茶', '晚餐', '夜宵', '加餐', '第九个'];
  const before = JSON.stringify(old);
  const after = runNormalize(old);

  assert.notEqual(JSON.stringify(after), before, '旧格式必须被规范化');
  assert.equal(after.settings.theme, 'default', '非法主题回退 default');
  assert.equal(after.settings.resetHour, 4, '非法 resetHour 回退 4');
  assert.equal(after.settings.foodItems.length, 1, '非法菜单项被丢弃');
  assert.equal(after.settings.foodItems[0].name, '番茄炒蛋', '菜单名 trim');
  assert.equal(after.settings.foodItems[0].slots.join(','), 'breakfast', '非法餐次槽被过滤');
  assert.ok(after.settings.foodItems[0].id.startsWith('fd-'), '补 id');
  assert.equal(after.settings.foodLog.length, 1, '非法 foodLog 项被丢弃');
  assert.ok(after.settings.foodLog[0].id.startsWith('fl-'), '补 id');
  assert.equal(after.settings.mealSlots.length <= 8, true, 'mealSlots 截到 8 个');
  assert.equal(after.settings.mealSlots.includes('早餐'), true);
});

test('normalize：第二次运行零改动（幂等）', () => {
  const old = defaults();
  old.settings.theme = 'sage';
  old.settings.foodItems = [{ name: '粥', slots: ['any'] }];
  old.settings.foodLog = [{ date: '2026-01-02', name: '饭', slot: 'dinner' }];
  old.settings.mealSlots = ['午餐'];
  old.tasks = [{ id: 't1', cat: 'must', text: 'x' }];
  old.marks = { '2026-01-02': { items: [{ penId: 'p1' }, { bad: true }] } };

  const once = runNormalize(JSON.parse(JSON.stringify(old)));
  const snap1 = JSON.stringify(once);
  const twice = runNormalize(JSON.parse(JSON.stringify(once)));
  const snap2 = JSON.stringify(twice);
  assert.equal(snap2, snap1, '第二次 normalize 不得再改动数据（幂等）');

  /* 修改面证据：tasks 首次运行会补齐 done/repeat/duration 字段（不删、不改已有值） */
  const t = twice.tasks[0];
  assert.equal(t.id, 't1');
  assert.equal(t.cat, 'must');
  assert.deepEqual(t.done, {});
  assert.equal(t.repeat, 'once');
  assert.equal(t.duration, 0);
  assert.equal(twice.marks['2026-01-02'].items.length, 1, 'marks.items 过滤非法项');
});

test('normalize：foodLog 250 条全部保留（数据保真，不按数量截断）', () => {
  const old = defaults();
  old.settings.foodLog = [];
  for (let i = 0; i < 250; i++) {
    old.settings.foodLog.push({ id: 'fl-' + i, date: '2026-01-01', ts: 1000 + i, name: '第' + i + '条', slot: i % 2 ? 'lunch' : 'dinner' });
  }
  const after = runNormalize(old);
  const log = JSON.parse(JSON.stringify(after.settings.foodLog)); /* vm realm 对象 → Node 原型 */
  assert.equal(log.length, 250, '250 条必须全部保留，不得截断');
  assert.equal(log[0].id, 'fl-0');
  assert.deepEqual(
    log[0], { id: 'fl-0', date: '2026-01-01', ts: 1000, name: '第0条', slot: 'dinner' },
    '首条内容原样保留');
  assert.deepEqual(
    log[124], { id: 'fl-124', date: '2026-01-01', ts: 1124, name: '第124条', slot: 'dinner' },
    '中间记录内容原样保留');
  assert.deepEqual(
    log[249], { id: 'fl-249', date: '2026-01-01', ts: 1249, name: '第249条', slot: 'lunch' },
    '末条内容原样保留');
  assert.deepEqual(
    log.map((l) => l.id),
    old.settings.foodLog.map((l) => l.id),
    '原始顺序不得改变');
});

test('normalize：foodLog 500 条全部保留', () => {
  const old = defaults();
  old.settings.foodLog = [];
  for (let i = 0; i < 500; i++) {
    old.settings.foodLog.push({ id: 'fl-' + i, date: '2026-01-01', ts: i, name: '菜' + i, slot: '' });
  }
  const after = runNormalize(old);
  assert.equal(after.settings.foodLog.length, 500, '500 条必须全部保留');
  assert.equal(after.settings.foodLog[0].name, '菜0', '首条保留');
  assert.equal(after.settings.foodLog[499].name, '菜499', '末条保留');
});

test('normalize：超 200 条 foodLog 连续两次运行零改动（幂等）', () => {
  const old = defaults();
  old.settings.foodLog = [];
  for (let i = 0; i < 260; i++) {
    old.settings.foodLog.push({ id: 'fl-' + i, date: '2026-01-01', ts: i, name: '第' + i + '条', slot: 'lunch' });
  }
  const once = runNormalize(JSON.parse(JSON.stringify(old)));
  const snap1 = JSON.stringify(once);
  const twice = runNormalize(JSON.parse(JSON.stringify(once)));
  const snap2 = JSON.stringify(twice);
  assert.equal(snap2, snap1, '第二次 normalize 不得再改动数据（幂等）');
  assert.equal(twice.settings.foodLog.length, 260, '两次运行后 260 条仍然全部保留');
});

test('normalize：空清单回退默认，用户删光的菜单不会被种子塞回', () => {
  const old = defaults();
  old.settings.foodItems = [];
  old.settings.mealSlots = [];
  const after = runNormalize(old);
  assert.deepEqual(after.settings.foodItems, [], 'foodItems 空清单保留（不塞回种子）');
  assert.deepEqual(after.settings.mealSlots, ['早餐', '午餐'], 'mealSlots 空清单回退默认');
});
