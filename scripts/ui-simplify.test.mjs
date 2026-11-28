/* ui-simplify.test.mjs — 首页与设置 UI 精简改造的行为回归测试
 * 在 vm 沙箱里加载真实 public/app/today.js，用最小 DOM 桩验证：
 * 计划提醒规则、待办合并的数据零迁移、旧入口移除、主题固定等。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const APP = path.join(process.cwd(), 'public/app');
const T0 = '2026-11-28';
const FALLBACK = {
  'today.remind.planPrefix': '今天的安排：',
  'today.action.goPlanShort': '去计划',
  'today.card.tasks': '待办事项',
  'today.empty.tasks': '还没有待办，点下面加一条。',
  'today.placeholder.task': '要做什么',
  'common.action.collapse': '收起 ▴',
  'common.action.expand': '展开 ▾',
};

function makeEl(tag = 'DIV', text = '') {
  const e = {
    tagName: tag, children: [], childNodes: [], dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    closest() { return null; },
    get textContent() { return this.childNodes.map((n) => String(n)).join(''); },
    set textContent(v) { this.childNodes = [String(v)]; this.children = []; },
    get firstChild() { return this.children[0] || null; },
    get innerHTML() { return this._html || ''; },
    set innerHTML(v) { this._html = String(v); this.children = []; this.childNodes = []; },
  };
  if (text) e.textContent = text;
  return e;
}

function loadToday(stateOverrides = {}) {
  const S = Object.assign({
    tasks: [], plans: [], restDays: [], schedule: [], tagLogs: [], tags: [], flashes: [],
    settings: {
      remindDismissed: '', goals: { trainMin: 30, studyMin: 40 }, showDone: true,
      tasksFold: false, focusItems: [], libFilter: '全部',
    },
    workouts: [], studyLogs: [], doneSugg: {}, suggestions: [],
  }, stateOverrides);
  const els = {
    remindWrap: makeEl(), taskWrap: makeEl(), toggleDone: makeEl(), foldTasks: makeEl(),
  };
  const ctx = {
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, RegExp,
    setTimeout: () => 0, clearTimeout: () => {},
    CAT_MUST: 'must', CAT_WANT: 'want', CAT_ROUTINE: 'routine',
    CAT_LABEL: { must: '必须处理', want: '今天想完成', routine: '每天重复' },
    S, window: {}, document: { getElementById: (id) => els[id] || null, createElement: (tag) => makeEl(tag) },
    TODAY: () => T0,
    addDays: (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); },
    U: (k) => FALLBACK[k] || k,
    el: (tag, cls, txt) => makeEl(tag, txt || ''),
    $: (id) => els[id] || null,
    isDone: (t, d) => !!(t.done && t.done[d]),
    isSkipped: (t, d) => !!(t.done && t.done[d] === 2),
    doneCountOn: () => 0,
    byId: (list, id) => (list || []).find((x) => x.id === id) || null,
    uid: (p) => p + '-' + Math.random().toString(36).slice(2, 8),
    sum: (a) => a.reduce((x, y) => x + y, 0),
    save: () => {}, toastCfg: () => {}, esc: (s) => String(s), rvMarkKeep: () => {},
    buzz: () => {},
    openPlanView: () => {}, pluginOn: () => false, fmt: (d) => String(d),
    parse: (d) => new Date(d + 'T00:00:00Z'),
    diffDays: (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000),
    durText: (n) => String(n), weekdayCN: () => '', nowHHMM: () => '12:00',
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(APP, 'today.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'today.js' });
  return { ctx, S, els, run: (code) => vm.runInContext(code, ctx) };
}

/* 把 vm realm 的对象转成普通 JS 再断言（跨 realm deepEqual 会失败） */
const plain = (v) => JSON.parse(JSON.stringify(v));

test('提醒：没有计划时整个区域不渲染', () => {
  const { els, run } = loadToday();
  run('renderRemind()');
  assert.equal(els.remindWrap.children.length, 0);
});

test('提醒：当天及以前未完成计划显示，完成/未来计划不显示', () => {
  const { els, run } = loadToday({
    plans: [
      { id: 'p1', date: T0, title: '写周报', done: false },
      { id: 'p2', date: '2026-11-20', title: '交保险', done: false },
      { id: 'p3', date: T0, title: '已完成计划', done: true },
      { id: 'p4', date: '2026-12-01', title: '未来计划', done: false },
    ],
  });
  run('renderRemind()');
  const wrap = els.remindWrap.children[0];
  assert.ok(wrap, '应生成提醒区域');
  const text = JSON.stringify(wrap.children.map((c) => c.children.map((k) => k.childNodes)));
  assert.ok(text.includes('写周报') && text.includes('交保险'), '实际提醒文本: ' + text);
  assert.ok(!text.includes('已完成计划') && !text.includes('未来计划'));
  assert.ok(text.includes('今天的安排：'));
});

test('提醒：休息日与当天关闭都抑制提醒；旧健身学习提醒不再出现', () => {
  const a = loadToday({
    plans: [{ id: 'p1', date: T0, title: '计划A', done: false }],
    restDays: [T0],
    workouts: [{ date: T0, minutes: 1 }],
    studyLogs: [{ date: T0, minutes: 1 }],
  });
  a.run('renderRemind()');
  assert.equal(a.els.remindWrap.children.length, 0, '休息日不渲染');

  const b = loadToday({
    plans: [{ id: 'p1', date: T0, title: '计划A', done: false }],
    settings: { remindDismissed: T0, goals: { trainMin: 30, studyMin: 40 }, showDone: true, tasksFold: false },
    workouts: [{ date: T0, minutes: 1 }], studyLogs: [{ date: T0, minutes: 1 }],
  });
  b.run('renderRemind()');
  assert.equal(b.els.remindWrap.children.length, 0, '当天已关闭不渲染');

  const c = loadToday({
    plans: [{ id: 'p1', date: T0, title: '计划A', done: false }],
    workouts: [{ date: T0, minutes: 1 }], studyLogs: [{ date: T0, minutes: 1 }],
  });
  c.run('renderRemind()');
  const text = JSON.stringify(c.els.remindWrap.children[0].children.map((x) => x.children.map((k) => k.childNodes)));
  assert.ok(!text.includes('健身') && !text.includes('学了'), '旧健康统计提醒不得出现');
});

test('待办合并：旧三分类数据全部保留、ID/完成状态不变，且只生成一张卡', () => {
  const { S, els, run } = loadToday({
    tasks: [
      { id: 't1', title: '必须项', cat: 'must', repeat: 'once', done: {}, createdAt: 1 },
      { id: 't2', title: '想做项', cat: 'want', repeat: 'once', done: { [T0]: 1 }, createdAt: 2 },
      { id: 't3', title: '每天项', cat: 'routine', repeat: 'daily', done: {}, createdAt: 3 },
    ],
  });
  const ids = run("tasksOf('today', TODAY()).map(t => t.id).join(',')");
  assert.equal(ids, 't1,t2,t3');
  run('renderTasks()');
  const cards = els.taskWrap.children.filter((c) => c.dataset && c.dataset.cat === 'today');
  assert.equal(cards.length, 1, '只有一个合并待办卡');
  assert.equal(plain(S.tasks).length, 3, '没有重复插入');
  assert.equal(S.tasks.find((t) => t.id === 't2').done[T0], 1, '完成状态保留');
  assert.ok(!run('JSON.stringify(S)').includes('"cat":"today"'), '未把合并视图写成新分类字段');
});

test('待办合并：新增走 want 分类，勾选保留原 ID', () => {
  const { S, run } = loadToday();
  run("taskUI.inline = { cat: 'today', value: '新待办' }; commitInline();");
  assert.equal(S.tasks.length, 1);
  assert.equal(S.tasks[0].cat, 'want');
  assert.equal(S.tasks[0].repeat, 'once');
  const id = S.tasks[0].id;
  run('toggleTask(S.tasks[0], null)');
  assert.equal(S.tasks[0].id, id);
  assert.equal(S.tasks[0].done[T0], 1);
  run('toggleTask(S.tasks[0], null)');
  assert.ok(!S.tasks[0].done[T0]);
});

test('三跳转入口：HTML 与事件分发中均不存在', () => {
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  for (const token of ['go-decide', 'go-eat', 'goPlanSec', 'eatSec', '帮你决策', '帮我选', '去计划 ↗']) {
    assert.ok(!html.includes(token), 'HTML 残留: ' + token);
  }
  const js = fs.readFileSync(path.join(APP, 'today.js'), 'utf8');
  assert.ok(!js.includes("case 'go-decide'") && !js.includes("case 'go-eat'"));
});

test('建议库：默认折叠容器与切换函数存在，展开文案为静态 key', () => {
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  assert.ok(html.includes('id="libBody" style="display:none"'));
  assert.ok(html.includes('data-action="lib-fold"'));
  const js = fs.readFileSync(path.join(APP, 'decide.js'), 'utf8');
  assert.ok(js.includes('var libFoldOpen = false;'));
  assert.ok(js.includes("U('common.action.collapse')") && js.includes("U('common.action.expand')"));
  assert.ok(!js.includes("U(libFoldOpen ?"), '禁止动态 key');
});

test('我的菜单：默认折叠容器与切换函数存在，展开文案为静态 key', () => {
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  assert.ok(html.includes('id="menuBody" style="display:none"'));
  assert.ok(html.includes('data-action="menu-fold"'));
  const js = fs.readFileSync(path.join(APP, 'decide.js'), 'utf8');
  assert.ok(js.includes('var menuFoldOpen = false;'));
  assert.ok(!js.includes("U(menuFoldOpen ?"), '禁止动态 key');
  const today = fs.readFileSync(path.join(APP, 'today.js'), 'utf8');
  assert.ok(today.includes("case 'menu-fold':"), '事件分发必须接上菜单折叠');
});

test('我的菜单：toggleMenuFold 正确切换 menuBody 显示与静态文案', () => {
  const src = fs.readFileSync(path.join(APP, 'decide.js'), 'utf8');
  const start = src.indexOf('var menuFoldOpen = false;');
  const end = src.indexOf('var sceneEditMode', start);
  assert.ok(start >= 0 && end > start, '找不到 menuFold 代码块');
  const body = makeEl();
  const btn = makeEl();
  const ctx = {
    document: { getElementById: (id) => (id === 'menuBody' ? body : id === 'menuFold' ? btn : null) },
    U: (k) => (FALLBACK[k] || k),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + '\nwindow.toggleMenuFold = toggleMenuFold;', ctx);
  assert.equal(body.style.display, undefined, '初始未设置 display（由 HTML 默认 none）');
  ctx.toggleMenuFold(btn);
  assert.equal(body.style.display, '', '第一次展开');
  assert.equal(btn.textContent, FALLBACK['common.action.collapse']);
  ctx.toggleMenuFold(btn);
  assert.equal(body.style.display, 'none', '第二次收起');
  assert.equal(btn.textContent, FALLBACK['common.action.expand']);
});

test('主题：固定橘子汽水，旧主题设置不再影响显示', () => {
  const core = fs.readFileSync(path.join(APP, 'core.js'), 'utf8');
  const css = fs.readFileSync(path.join(APP, 'base.css'), 'utf8');
  assert.ok(css.includes('--sage:#C1795C'), '根变量必须是橘子汽水主色');
  assert.ok(!/html\.theme-(mist|clay|matcha|lotus|warm)\s*\{/.test(css), '其他主题块已删除');
  const ctx = { S: { settings: { theme: 'lotus' } } };
  vm.createContext(ctx);
  vm.runInContext(core.match(/function themeRGB\(\)\{[\s\S]*?\}/)[0], ctx);
  assert.equal(vm.runInContext('themeRGB()', ctx), '193,121,92');
  assert.ok(!/S\.settings\.theme/.test(core.match(/function applyTheme\(\)\{[\s\S]*?\}/)[0]), 'applyTheme 不读取旧设置');
});
