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

const allElements = [];
function makeEl(tag = 'DIV', text = '') {
  const e = {
    tagName: tag, children: [], childNodes: [], dataset: {}, style: {},
    _classes: new Set(),
    setAttribute() {},
    attrs: {},
    appendChild(c) {
      // 真实 DOM：appendChild 会把节点从原父节点移走
      for (const parent of allElements) {
        const i = parent.children.indexOf(c);
        if (i >= 0) parent.children.splice(i, 1);
      }
      this.children.push(c);
      return c;
    },
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
  e.classList = {
    add: (...cs) => cs.forEach((c) => e._classes.add(c)),
    remove: (...cs) => cs.forEach((c) => e._classes.delete(c)),
    toggle: (c, on) => { if (on === undefined) e._classes.has(c) ? e._classes.delete(c) : e._classes.add(c); else on ? e._classes.add(c) : e._classes.delete(c); },
    contains: (c) => e._classes.has(c),
  };
  if (text) e.textContent = text;
  allElements.push(e);
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
    el: (tag, cls, txt) => { const e = makeEl(tag, txt || ''); if (cls) String(cls).split(/\s+/).forEach((c) => e.classList.add(c)); return e; },
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
  const walk = (nodes) => nodes.flatMap((n) => [n, ...walk(n.children || [])]);
  const cards = walk(els.taskWrap.children).filter((c) =>
    c.classList.contains('card') && c.dataset && c.dataset.cat === 'today');
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

/* ---------- 卡片堆叠动画（沿 Z 轴重排） ---------- */

test('卡片堆叠：Z 轴参数与 CSS 层定义一致（12/24px、.96/.92、.7/.4）', () => {
  const js = fs.readFileSync(path.join(APP, 'today.js'), 'utf8');
  const css = fs.readFileSync(path.join(APP, 'today.css'), 'utf8');
  assert.ok(js.includes('var DECK_MS = 400;'), '动画时长统一 400ms');
  assert.ok(js.includes('cubic-bezier(.22,1,.36,1)'), '缓动曲线与参考一致');
  assert.ok(css.includes('transform:translateY(-12px) scale(.96);opacity:.7'), 'CSS 第二层');
  assert.ok(css.includes('transform:translateY(-24px) scale(.92);opacity:.4'), 'CSS 第三层');
  assert.ok(css.includes('cubic-bezier(.22,1,.36,1)'), 'CSS 缓动曲线需匹配 JS');
});

test('卡片堆叠：收拢/展开同一入口，不重建 DOM、无硬编码延时', () => {
  const js = fs.readFileSync(path.join(APP, 'today.js'), 'utf8');
  const fold = js.slice(js.indexOf('function toggleTasksFold()'), js.indexOf('/* ==================== 单一事件委托'));
  assert.ok(fold.includes('setDeckFold(!S.settings.tasksFold)'), '收拢/展开必须共用状态机');
  assert.ok(!fold.includes('renderTasks()'), '方向切换不得重建 DOM');
  assert.ok(!fold.includes('setTimeout'), '禁止固定延时');
  assert.ok(!js.includes('setTimeout(renderTasks'), '全文件禁止延时重建');
  const machine = js.slice(js.indexOf('function setDeckFold('), js.indexOf('function unfoldTasks()'));
  assert.ok(!machine.includes('getBoundingClientRect'), '不得做跨参照系换算');
  assert.ok(machine.includes('deck.dataset.fold = want'), '由 data-fold 驱动 CSS 静态目标');
  assert.ok(machine.includes('nodes.map(deckVisual)'), '起点取当前视觉值（含中断中间帧）');
  assert.ok(machine.includes('a.cancel()'), '旧动画先取消');
  assert.ok(machine.includes('fill: \'both\''), '双向 fill 保证首末帧');
});

test('卡片堆叠：setDeckFold 从当前视觉状态插值到目标，末帧 cancel 与静态一致', () => {
  const src = fs.readFileSync(path.join(APP, 'today.js'), 'utf8');
  const start = src.indexOf('var deckAnims = null;');
  const end = src.indexOf('function unfoldTasks()', start);
  const machine = src.slice(start, end);
  // 快照 -> 取消 -> 切状态 -> 读目标 -> 动画 -> finished 后 cancel
  assert.ok(machine.indexOf('nodes.map(deckVisual)') < machine.indexOf('deck.dataset.fold = want'),
    '必须在改状态前快照当前视觉');
  assert.ok(machine.indexOf('a.cancel()') < machine.indexOf('deck.dataset.fold = want'),
    '必须在切状态前取消旧动画');
  assert.ok(machine.includes('var after = nodes.map(deckVisual)'), '目标取新 CSS 静态值');
  assert.ok(machine.includes('n.animate([before[i], after[i]]'), '单条插值 from=当前 to=静态');
  assert.ok(machine.includes('last.finished.then(settle, settle)'), '由动画完成事件收口');
  assert.ok(machine.includes('duration: DECK_MS, easing: DECK_EASE'), '统一时长与缓动');
});

test('卡片堆叠：持久 DOM 含主卡、两张装饰底牌与两视图，折叠态不换节点', () => {
  const { S, els, run } = loadToday();
  run('renderTasks()');
  const deck = els.taskWrap.children.find((c) => c.dataset && 'fold' in c.dataset);
  assert.ok(deck, '存在持久 .deck 容器');
  assert.equal(deck.dataset.fold, '0', '初始为展开态');
  const walk = (nodes) => nodes.flatMap((n) => [n, ...walk(n.children || [])]);
  const all = walk([deck]);
  const mains = all.filter((n) => n.classList.contains('main') && n.classList.contains('card'));
  assert.equal(mains.length, 1, '只有一个持久主卡节点');
  const backs = all.filter((n) => n.classList.contains('deck-l'));
  assert.equal(backs.length, 2, '两张装饰底牌常驻');
  assert.ok(backs.every((n) => n.children.length === 0), '装饰底牌不含业务内容');
  assert.ok(all.some((n) => n.classList.contains('deck-peek')), '折叠提示视图常驻 DOM');
  assert.ok(all.some((n) => n.classList.contains('card-body')), '展开内容视图常驻 DOM');
  assert.equal(S.settings.tasksFold, false);
});

test('卡片堆叠：移动端取消重叠，prefers-reduced-motion 关闭动画', () => {
  const css = fs.readFileSync(path.join(APP, 'today.css'), 'utf8');
  assert.ok(/@media\(max-width:640px\)\{[\s\S]*?\.deck-l\{display:none\}/.test(css), '移动端隐藏堆叠层');
  assert.ok(/@media\(prefers-reduced-motion:reduce\)\{[\s\S]*?animation:none/.test(css), '减少动态效果时关闭动画');
});

test('卡片堆叠：运行时双向插值——起点取当前帧、终点取目标静态、结束 cancel', () => {
  const src = fs.readFileSync(path.join(APP, 'today.js'), 'utf8');
  const start = src.indexOf('var DECK_MS = 400;');
  const end = src.indexOf('function unfoldTasks()', start);
  const machine = src.slice(start, end);

  const anims = [];
  let cancels = 0;
  const makeNode = (name) => ({
    name,
    animate(frames, opt) {
      anims.push({ name, from: frames[0], to: frames[1], opt });
      return { finished: Promise.resolve(), cancel() { cancels++; } };
    },
  });
  const l1 = makeNode('l1'), body = makeNode('body');
  const deck = {
    dataset: { fold: '0' },
    querySelectorAll: () => [l1, body], // 两个节点足够验证插值
  };
  // computed 随 data-fold 变化，模拟 CSS 规则；中间帧用 animate 桩覆盖
  const staticFor = (n) => deck.dataset.fold === '1'
    ? { transform: 'matrix(.96,0,0,.96,0,-12)', opacity: '0.7', height: '40px' }
    : { transform: 'none', opacity: '1', height: '100px' };
  const ctx = {
    console, DECK_MS: 400, DECK_EASE: 'cubic-bezier(.22,1,.36,1)',
    DECK_ANIM_PROPS: ['transform', 'opacity', 'height'],
    getComputedStyle: () => staticFor(),
    Element: { prototype: { animate() {} } },
    S: { settings: { tasksFold: false } }, save() {},
    document: { getElementById: () => ({ textContent: '' }) },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(machine + '\n$ = function(){ return globalThis.wrap; };', ctx);
  ctx.wrap = { querySelector: () => deck };

  vm.runInContext('setDeckFold(true)', ctx);
  assert.equal(deck.dataset.fold, '1', '状态切到折叠');
  assert.equal(ctx.S.settings.tasksFold, true, '业务状态同步');
  assert.equal(anims.length, 2, '两节点都参与插值');
  assert.equal(anims[0].from.opacity, '1', '起点 = 旧静态（展开）');
  assert.equal(anims[0].to.opacity, '0.7', '终点 = 新静态（折叠第二层）');
  assert.equal(anims[0].opt.duration, 400);
  assert.equal(anims[0].opt.easing, 'cubic-bezier(.22,1,.36,1)');
  assert.equal(anims[0].opt.fill, 'both');

  // 动画中途反向：current 被 animate 覆盖为新值，起点必须来自该中间帧而非旧静态
  const mid = { transform: 'matrix(.98,0,0,.98,0,-6)', opacity: '0.85', height: '70px' };
  ctx.getComputedStyle = () => mid;
  vm.runInContext('setDeckFold(false)', ctx);
  assert.equal(deck.dataset.fold, '0', '反向切回展开');
  assert.equal(anims.length, 4, '第二段动画启动');
  assert.equal(anims[2].from.opacity, '0.85', '反向起点 = 动画中间帧，不瞬移');
  assert.equal(anims[2].to.opacity, '0.85', '桩 computed 固定时终点等于当前（真实浏览器按 data-fold 变化）');
  assert.ok(cancels >= 2, '旧动画在切状态前被取消');
});
