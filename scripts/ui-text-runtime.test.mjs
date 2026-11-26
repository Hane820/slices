/* scripts/ui-text-runtime.test.mjs — 静态 UI 文案引擎的运行时测试 + 检查脚本门禁测试
 *
 * 分两部分：
 *   A. 运行时：在 vm 沙箱里按 **index.html 的真实脚本顺序** 加载 config/*.js，断言真实实现。
 *      顺序不再硬编码，新增分组文件会自动进入测试（P2-4）。
 *   B. 门禁：在临时夹具目录里跑 scripts/ui-text-check.mjs，断言它**确实会失败**
 *      （跨行 HTML 注入、动态 key、加载顺序），以及不会误报正向写法。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const APP = path.join(process.cwd(), 'public/app');
const CHECKER = path.join(process.cwd(), 'scripts/ui-text-check.mjs');

/* ---------------- 真实脚本顺序（唯一来源：index.html） ---------------- */

const HTML_SRC = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');

function readConfigOrder() {
  const srcs = [...HTML_SRC.matchAll(/<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map((m) => (m[1] !== undefined ? m[1] : m[2]));
  return srcs
    .filter((s) => s.startsWith('config/'))
    .map((s) => path.basename(s))
    .filter((n) => n !== 'apply.js');
}

const CONFIG_ORDER = readConfigOrder();

/* ---------------- 最小假 DOM ---------------- */

const textNode = (v) => ({ nodeType: 3, nodeValue: v });

function makeEl({ tag = 'SPAN', text = '', attrs = {}, kids = null } = {}) {
  const el = {
    tagName: tag,
    nodeType: 1,
    children: [],
    childNodes: [],
    attrs: Object.assign({}, attrs),
    getAttribute(n) { return (n in this.attrs) ? this.attrs[n] : null; },
    hasAttribute(n) { return n in this.attrs; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    removeAttribute(n) { delete this.attrs[n]; }
  };
  Object.defineProperty(el, 'attributes', {
    get() { return Object.keys(this.attrs).map((k) => ({ name: k, value: this.attrs[k] })); }
  });
  Object.defineProperty(el, 'textContent', {
    get() { return this.childNodes.map((n) => n.nodeValue).join(''); },
    set(v) { this.childNodes = [textNode(String(v))]; this.children = []; }
  });
  if (kids) {
    el.childNodes = kids;
    el.children = kids.filter((k) => k.nodeType === 1);
  } else if (text) {
    el.textContent = text;
  }
  return el;
}

function makeDoc(els, readyState = 'loading') {
  const listeners = {};
  const doc = {
    readyState,
    addEventListener(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); },
    querySelectorAll() { return els; },
    fire(ev) { (listeners[ev] || []).forEach((cb) => cb()); }
  };
  return doc;
}

/* ---------------- 加载器 ---------------- */

function createApp({ els = [], search = '', readyState = 'loading' } = {}) {
  const doc = makeDoc(els, readyState);
  const warns = [];
  const win = {
    document: doc,
    location: { search },
    console: { warn: (...a) => warns.push(a.join(' ')), log() {} },
    WeakSet,
    Promise,
    JSON
  };
  win.window = win;
  const ctx = vm.createContext(win);
  const load = (rel) => vm.runInContext(fs.readFileSync(path.join(APP, rel), 'utf8'), ctx, { filename: rel });
  const loadGroups = () => CONFIG_ORDER.forEach((f) => load('config/' + f));
  return { win, ctx, doc, warns, load, loadGroups };
}

/* ---------------- U() / UH() ---------------- */

test('U 缺 key：返回可见标记，不返回空串', () => {
  const app = createApp();
  app.load('config/index.js');
  assert.equal(app.win.U('no.such.key'), '［缺少文案：no.such.key］');
});

test('U 缺 key：同一个 key 只告警一次，计数仍在累加', () => {
  const app = createApp({ search: '?ui-debug=1' });
  app.load('config/index.js');
  app.win.U('no.such.key');
  app.win.U('no.such.key');
  app.win.U('no.such.key');
  assert.equal(app.warns.length, 1, '三次调用只应告警一次');
  assert.equal(app.win.OLText.missing().counts.keys['no.such.key'], 3);
});

test('U 缺 vars：占位符不外泄，逐项给可见标记', () => {
  const app = createApp();
  app.load('config/index.js');
  app.win.OLText.register('t', { 't.msg': '逾期 {days} 天，{who} 该做' });
  assert.equal(app.win.U('t.msg'), '逾期 ［缺参数：days］ 天，［缺参数：who］ 该做');
  assert.equal(app.win.U('t.msg', { days: 3 }), '逾期 3 天，［缺参数：who］ 该做');
});

test('U vars 为 null / 空对象 / 非对象：同样按缺参处理', () => {
  const app = createApp();
  app.load('config/index.js');
  app.win.OLText.register('t', { 't.msg': '共 {n} 条' });
  for (const vars of [null, {}, 'oops', 42]) {
    const out = app.win.U('t.msg', vars);
    assert.equal(out, '共 ［缺参数：n］ 条', 'vars=' + JSON.stringify(vars));
  }
});

test('U 参数：0 保留，false / 数组 / 对象 / 函数 走可见标记', () => {
  const app = createApp();
  app.load('config/index.js');
  app.win.OLText.register('t', { 't.msg': '值 {v}' });
  assert.equal(app.win.U('t.msg', { v: 0 }), '值 0');
  assert.equal(app.win.U('t.msg', { v: -1 }), '值 -1');
  assert.equal(app.win.U('t.msg', { v: false }), '值 ［缺参数：v］');
  assert.equal(app.win.U('t.msg', { v: [1, 2] }), '值 ［缺参数：v］');
  assert.equal(app.win.U('t.msg', { v: { a: 1 } }), '值 ［缺参数：v］');
  assert.equal(app.win.U('t.msg', { v: () => 1 }), '值 ［缺参数：v］');
});

test('U 参数：同一占位符重复出现全部替换', () => {
  const app = createApp();
  app.load('config/index.js');
  app.win.OLText.register('t', { 't.msg': '{n} 天，还有 {n} 天' });
  assert.equal(app.win.U('t.msg', { n: 2 }), '2 天，还有 2 天');
});

test('U 参数值含 $ 与反斜杠：按字面量输出，不触发替换语义', () => {
  const app = createApp();
  app.load('config/index.js');
  app.win.OLText.register('t', { 't.msg': 'X{v}Y' });
  assert.equal(app.win.U('t.msg', { v: '$&\\1' }), 'X$&\\1Y');
});

test('UH：五个特殊字符全转义，配置值与参数都覆盖', () => {
  const app = createApp();
  app.load('config/index.js');
  app.win.OLText.register('t', { 't.msg': 'A&B "<b>" {v}' });
  assert.equal(app.win.UH('t.msg', { v: `'x'` }),
    'A&amp;B &quot;&lt;b&gt;&quot; &#39;x&#39;');
});

test('UH：参数注入标签被转义，不产生可执行标记', () => {
  const app = createApp();
  app.load('config/index.js');
  app.win.OLText.register('t', { 't.msg': 'hi {v}' });
  assert.equal(app.win.UH('t.msg', { v: '<img src=x onerror=alert(1)>' }),
    'hi &lt;img src=x onerror=alert(1)&gt;');
});

test('U 不走转义：配置值原样返回（供 textContent 使用）', () => {
  const app = createApp();
  app.load('config/index.js');
  app.win.OLText.register('t', { 't.msg': 'A&B<b>' });
  assert.equal(app.win.U('t.msg'), 'A&B<b>');
});

/* ---------------- register ---------------- */

test('register 重复注册同一 key：先注册的生效', () => {
  const app = createApp();
  app.load('config/index.js');
  app.win.OLText.register('g', { 'g.k': '第一次' });
  app.win.OLText.register('g', { 'g.k': '第二次' });
  assert.equal(app.win.U('g.k'), '第一次');
  assert.equal(app.win.OLText.data.g['g.k'], '第一次', 'OLText.data 与取值语义保持一致');
});

test('register 同组两次调用：合并而不是覆盖', () => {
  const app = createApp();
  app.load('config/index.js');
  app.win.OLText.register('g', { 'g.a': 'A' });
  app.win.OLText.register('g', { 'g.b': 'B' });
  assert.equal(app.win.U('g.a'), 'A');
  assert.equal(app.win.U('g.b'), 'B');
});

test('register 中文 key 进 legacy，text() 与 OLT 语义不变', () => {
  const app = createApp();
  app.load('config/index.js');
  app.win.OLText.register('g', { '取消': '取消' });
  assert.equal(app.win.OLText.text('取消'), '取消');
  assert.equal(app.win.OLText.text('没有这条'), '没有这条');
});

/* ---------------- applyDom ---------------- */

test('注册完成前不替换：只加载 index.js 时 DOM 不动', () => {
  const el = makeEl({ text: '今日待办', attrs: { 'data-i18n': 'today.section.tasks' } });
  const app = createApp({ els: [el] });
  app.load('config/index.js');
  assert.equal(el.textContent, '今日待办', 'index.js 不应自己触发替换');
});

test('注册完成后替换：apply.js 执行即完成首轮，无需等 DOMContentLoaded', () => {
  const el = makeEl({ text: '今日待办', attrs: { 'data-i18n': 'today.section.tasks' } });
  const app = createApp({ els: [el] });
  app.load('config/index.js');
  app.loadGroups();
  app.load('config/apply.js');
  assert.equal(el.textContent, '今日待办', '值相同，内容不变');
  assert.equal(app.win.OLText.missing().keys.length, 0, '不应有误报缺失');
});

test('缺 key 的节点保留 HTML 中文兜底，且不进 WeakSet（补配置后能再处理）', () => {
  const el = makeEl({ text: '原中文', attrs: { 'data-i18n': 'later.key' } });
  const app = createApp({ els: [el] });
  app.load('config/index.js');
  app.loadGroups();
  app.win.OLText.applyDom(app.doc);
  assert.equal(el.textContent, '原中文', '找不到 key 时必须保留原文');

  app.win.OLText.register('late', { 'later.key': '补上的文案' });
  app.win.OLText.applyDom(app.doc);
  assert.equal(el.textContent, '补上的文案', '缺 key 的节点不能被 WeakSet 永久跳过');
});

test('data-i18n-skip-text：只换属性，不动可见文本（#toTop 箭头）', () => {
  const el = makeEl({
    tag: 'BUTTON',
    text: '↑',
    attrs: {
      'data-i18n': 'common.a11y.backToTop',
      'data-i18n-skip-text': '',
      'data-i18n-aria-label': '',
      'aria-label': '回到顶端'
    }
  });
  const app = createApp({ els: [el] });
  app.load('config/index.js');
  app.loadGroups();
  app.win.OLText.applyDom(app.doc);
  assert.equal(el.textContent, '↑', '箭头不能被文案替换');
  assert.equal(el.attrs['aria-label'], '回到顶端');
  assert.equal(el.attrs['skip-text'], undefined, 'skip-text 不能被当成属性目标');
});

test('data-i18n-aria-label 不写值（裸属性）时确实替换 aria-label', () => {
  /* 与 index.html 的 #toTop 同形：裸属性 + skip-text + 原值与配置值不同。
     这条用例证明「属性值留空」不是靠 HTML 原值恰好相等蒙过去的。 */
  const el = makeEl({
    tag: 'BUTTON',
    text: '↑',
    attrs: {
      'data-i18n': 'common.a11y.backToTop',
      'data-i18n-skip-text': '',
      'data-i18n-aria-label': '',
      'aria-label': '旧标签·必须被替换'
    }
  });
  const app = createApp({ els: [el] });
  app.load('config/index.js');
  app.loadGroups();
  const configured = app.win.OLText.messages['common.a11y.backToTop'];
  assert.notEqual(el.attrs['aria-label'], configured, '前置条件：原值必须与配置值不同');

  app.win.OLText.applyDom(app.doc);

  assert.equal(el.textContent, '↑', '裸属性下箭头同样不能被替换');
  assert.equal(el.attrs['aria-label'], configured, '裸 data-i18n-aria-label 必须写入配置值');
  assert.equal(el.attrs['aria-label'].startsWith('［缺少文案'), false);
});


test('属性替换确实发生：HTML 原值与配置值不同，最终等于配置值', () => {
  const el = makeEl({
    tag: 'INPUT',
    attrs: {
      'data-i18n': 'decide.placeholder.librarySearch',
      'data-i18n-attr': 'placeholder',
      placeholder: '旧占位符·必须被替换'
    }
  });
  const app = createApp({ els: [el] });
  app.load('config/index.js');
  app.loadGroups();
  const configured = app.win.OLText.messages['decide.placeholder.librarySearch'];
  assert.notEqual(el.attrs.placeholder, configured, '前置条件：原值必须与配置值不同');

  app.win.OLText.applyDom(app.doc);

  assert.equal(el.attrs.placeholder, configured, '属性必须被替换成配置值');
  assert.equal(el.textContent, '', 'INPUT 不写文本');
});

test('嵌套子标签：只替换首段文本，子元素与结构保留', () => {
  const strong = makeEl({ tag: 'STRONG', text: '保留的强调文字' });
  const el = makeEl({
    tag: 'BUTTON',
    attrs: { 'data-i18n': 'today.section.tasks' },
    kids: [textNode('原始文本'), strong]
  });
  const app = createApp({ els: [el] });
  app.load('config/index.js');
  app.loadGroups();
  const configured = app.win.OLText.messages['today.section.tasks'];
  assert.notEqual(configured, '原始文本');

  app.win.OLText.applyDom(app.doc);

  assert.equal(el.childNodes[0].nodeValue, configured, '首个文本节点被替换');
  assert.equal(el.children.length, 1, '子元素仍在');
  assert.equal(el.children[0].tagName, 'STRONG');
  assert.equal(strong.textContent, '保留的强调文字', '子元素内部文字不变');
});

test('多属性替换：data-i18n-attr="title,aria-label" 两个属性都写入', () => {
  const el = makeEl({
    tag: 'BUTTON',
    attrs: {
      'data-i18n': 'common.a11y.backToTop',
      'data-i18n-attr': 'title,aria-label',
      title: '旧标题',
      'aria-label': '旧无障碍标签'
    }
  });
  const app = createApp({ els: [el] });
  app.load('config/index.js');
  app.loadGroups();
  const configured = app.win.OLText.messages['common.a11y.backToTop'];
  assert.notEqual(el.attrs.title, configured);
  assert.notEqual(el.attrs['aria-label'], configured);

  app.win.OLText.applyDom(app.doc);

  assert.equal(el.attrs.title, configured);
  assert.equal(el.attrs['aria-label'], configured);
});

test('幂等：JS 改过文案后，再次 applyDom 不覆盖', () => {
  const el = makeEl({ text: '今日待办', attrs: { 'data-i18n': 'today.section.tasks' } });
  const app = createApp({ els: [el] });
  app.load('config/index.js');
  app.loadGroups();
  app.win.OLText.applyDom(app.doc);

  el.textContent = 'JS 写入的动态值';
  app.win.OLText.applyDom(app.doc);
  app.doc.fire('DOMContentLoaded');
  assert.equal(el.textContent, 'JS 写入的动态值');
});

test('apply.js 的 DOMContentLoaded 补跑是幂等的', () => {
  const el = makeEl({ text: '今日待办', attrs: { 'data-i18n': 'today.section.tasks' } });
  const app = createApp({ els: [el] });
  app.load('config/index.js');
  app.loadGroups();
  app.load('config/apply.js');
  el.textContent = '动态值';
  app.doc.fire('DOMContentLoaded');
  assert.equal(el.textContent, '动态值');
});

test('旧接口 OLT 仍能命中 153 条中文 key', () => {
  const app = createApp();
  app.load('config/index.js');
  app.loadGroups();
  assert.equal(app.win.OLText.text('取消'), '取消');
  assert.equal(app.win.OLText.text('今日待办'), '今日待办');
  assert.equal(Object.keys(app.win.OLText.flat).length, 150, '旧中文 key 去重后 150 条（153 处定义，3 处重复同值）');
});

/* ============================================================================
 * 加载顺序：必须来自真实 HTML，而不是第二份硬编码清单
 * ========================================================================== */

test('配置顺序来自 index.html，且覆盖磁盘上所有会注册的模块', () => {
  const configDir = path.join(APP, 'config');
  const onDisk = fs.readdirSync(configDir)
    .filter((n) => n.endsWith('.js'))
    .filter((n) => n !== 'index.js' && n !== 'apply.js' && n !== 'toast-text.js')
    .filter((n) => /(^|[^\w$.])register\s*\(/.test(fs.readFileSync(path.join(configDir, n), 'utf8')));

  for (const name of onDisk) {
    assert.ok(CONFIG_ORDER.includes(name), 'index.html 未加载会注册文案的 config/' + name);
  }
  assert.ok(CONFIG_ORDER.indexOf('index.js') === 0, 'index.js 必须是第一个配置脚本');
});

/* ============================================================================
 * 门禁夹具：在临时目录里跑检查脚本，验证「该失败的会失败、不该报的不报」
 * ========================================================================== */

const BASE_FIXTURE = {
  'public/app/index.html': [
    '<!doctype html><html><body>',
    '<span data-i18n="one.a">甲</span>',
    '<script src="config/index.js"></script>',
    '<script src="config/one.js"></script>',
    '<script src="config/apply.js"></script>',
    '<script src="core.js"></script>',
    '<script src="boot.js"></script>',
    '<script src="app.js"></script>',
    '</body></html>'
  ].join('\n'),
  'public/app/config/index.js':
    '(function(g){var m=Object.create(null);' +
    'g.OLText={messages:m,register:function(c,o){Object.keys(o).forEach(function(k){if(!(k in m))m[k]=o[k];});}};' +
    '})(window);',
  'public/app/config/one.js': 'window.OLText.register(\'one\', { \'one.a\': \'甲\', \'one.b\': \'乙\' });',
  'public/app/config/apply.js': '/* 夹具：空 apply，用于满足顺序断言 */',
  'public/app/core.js': '',
  'public/app/boot.js': '',
  'public/app/app.js': ''
};

function runChecker(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-text-fixture-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    const r = spawnSync(process.execPath, [CHECKER, '--root', dir], { encoding: 'utf8' });
    return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const withApp = (appJs, extra = {}) => Object.assign({}, BASE_FIXTURE, { 'public/app/app.js': appJs }, extra);

test('夹具基线：干净代码应通过（0 错误）', () => {
  const r = runChecker(withApp('el.textContent = U(\'one.a\');'));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /错误 0/);
});

test('门禁：跨行 HTML 拼接 + 变量写入 innerHTML 必须失败', () => {
  const r = runChecker(withApp([
    'var html = \'\';',
    'html += \'<div>\' +',
    '  U(\'one.a\') +',
    '  \'</div>\';',
    'el.innerHTML = html;'
  ].join('\n')));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /裸 U\(\)/);
});

test('门禁：同一表达式里 UH 不能豁免裸 U', () => {
  const r = runChecker(withApp('el.innerHTML = UH(\'one.a\') + U(\'one.b\');'));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /裸 U\(\) 进入 innerHTML/);
});

test('门禁：insertAdjacentHTML 的跨行参数必须被检查', () => {
  const r = runChecker(withApp([
    'el.insertAdjacentHTML(\'beforeend\',',
    '  \'<div>\' + U(\'one.a\') + \'</div>\');'
  ].join('\n')));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /裸 U\(\) 进入 insertAdjacentHTML/);
});

test('门禁：outerHTML 赋值同样受限', () => {
  const r = runChecker(withApp('el.outerHTML = \'<b>\' + U(\'one.a\') + \'</b>\';'));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /裸 U\(\) 进入 outerHTML/);
});

test('正向：只用 UH 写 innerHTML 不报错', () => {
  const r = runChecker(withApp('el.innerHTML = UH(\'one.a\');'));
  assert.equal(r.code, 0, r.out);
});

test('正向：U() 结果经变量交给 textContent 不报错', () => {
  const r = runChecker(withApp([
    'var label = U(\'one.a\');',
    'el.textContent = label;'
  ].join('\n')));
  assert.equal(r.code, 0, r.out);
});

test('门禁：动态 key（拼接）必须失败，且不能误报为无效 key', () => {
  const r = runChecker(withApp('var n = 1; U(\'one.\' + n);'));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /动态 key/);
  assert.doesNotMatch(r.out, /无效引用：one\./, '不得把拼接片段当成普通 key');
});

test('门禁：动态 key（变量）必须失败', () => {
  const r = runChecker(withApp('var k = \'one.a\'; U(k);'));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /动态 key/);
});

test('门禁：动态 key（模板插值）必须失败', () => {
  const r = runChecker(withApp('var n = 1; U(`one.${n}`);'));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /动态 key/);
});

test('正向：双引号与无插值模板的静态 key 都能识别', () => {
  const r = runChecker(withApp('el.textContent = U("one.a") + U(`one.b`);'));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /引用点 3 处/, 'HTML 1 处 + JS 2 处');
});

test('解析：配置用双引号定义也能被识别（不再是漏检）', () => {
  const r = runChecker(withApp('el.textContent = U("one.a") + U("one.b");', {
    'public/app/config/one.js': 'window.OLText.register("one", { "one.a": "甲", "one.b": "乙" });'
  }));
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /未使用/);
});

test('门禁：boot.js 早于 apply.js 必须失败', () => {
  const html = BASE_FIXTURE['public/app/index.html']
    .replace('<script src="config/apply.js"></script>\n<script src="core.js"></script>\n<script src="boot.js"></script>',
      '<script src="boot.js"></script>\n<script src="config/apply.js"></script>\n<script src="core.js"></script>');
  const r = runChecker(withApp('', { 'public/app/index.html': html }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /boot\.js 早于 config\/apply\.js/);
});

test('门禁：配置脚本排在 apply.js 之后必须失败', () => {
  const html = BASE_FIXTURE['public/app/index.html']
    .replace('<script src="config/one.js"></script>', '')
    .replace('<script src="core.js"></script>',
      '<script src="core.js"></script>\n<script src="config/one.js"></script>');
  const r = runChecker(withApp('', { 'public/app/index.html': html }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /config\/one\.js 排在 config\/apply\.js 之后/);
});

test('门禁：新增注册文件但未在 HTML 加载必须失败', () => {
  const r = runChecker(withApp('', {
    'public/app/config/two.js': 'window.OLText.register(\'two\', { \'two.a\': \'丙\' });'
  }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /配置模块未在 index\.html 中加载：config\/two\.js/);
});

test('门禁：属性目标值写错（后缀与值不一致）必须失败', () => {
  const html = BASE_FIXTURE['public/app/index.html']
    .replace('<span data-i18n="one.a">甲</span>',
      '<span data-i18n="one.a" data-i18n-aria-label="title" aria-label="甲">甲</span>');
  const r = runChecker(withApp('', { 'public/app/index.html': html }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /属性目标值应留空或与后缀一致/);
});
