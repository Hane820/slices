/* ui-text-lex.test.mjs — ui-text-lex.mjs 词法器回归测试
 *
 * 背景：core.js:79 的 esc() —— replace(/[&<>"']/g, ...) 正则字面量里
 * 的引号曾被旧词法器当成字符串起点，吞掉后续真实代码，导致该行之后
 * 的所有 U()/UH()/OLT() 调用无法识别（core.js 全部调用集中在 79 行后，
 * 12 处只识别到 1 处，且是第 7 行的函数定义）。
 *
 * 测试验证实际提取出的调用及 key，而不只验证不抛异常。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lex } from './ui-text-lex.mjs';

/* 复刻 ui-text-check.mjs 主循环的调用提取：id(U|UH|OLT) + '(' + 静态字符串字面量 */
function extractCalls(src) {
  const toks = lex(src);
  const out = [];
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.t !== 'id' || !['U', 'UH', 'OLT'].includes(t.v)) continue;
    if (!(toks[i + 1] && toks[i + 1].t === 'punc' && toks[i + 1].v === '(')) continue;
    const arg = toks[i + 2];
    const after = toks[i + 3];
    if (!arg || arg.t !== 'str' || arg.hasSubst || arg.unterminated) continue;
    if (after && !['(',')','.',',',';','}'].includes(after.v)) continue;
    out.push({ fn: t.v, key: arg.v, line: t.line });
  }
  return out;
}

test('场景1：core.js esc() 断裂场景——正则含双引号+单引号，其后调用仍被识别', () => {
  const src = [
    "function esc(t){",
    "  return String(t == null ? '' : t).replace(/[&<>\"']/g, function(c){",
    "    return map[c];",
    "  });",
    "}",
    "var a = UH('common.picker.timeTitle');",
    "var b = OLT('选择时间');",
  ].join('\n');
  const calls = extractCalls(src);
  assert.deepEqual(calls, [
    { fn: 'UH', key: 'common.picker.timeTitle', line: 6 },
    { fn: 'OLT', key: '选择时间', line: 7 },
  ]);
});

test('场景2：字符串中的引号与反斜杠转义', () => {
  const toks = lex(String.raw`var s = 'it\'s a \n test \\ end'; var t = "say \"hi\"";`);
  const strs = toks.filter((t) => t.t === 'str');
  assert.equal(strs[0].v, "it's a \n test \\ end");
  assert.equal(strs[1].v, 'say "hi"');
  // 转义没有让后续 token 错乱
  assert.ok(toks.some((t) => t.t === 'id' && t.v === 't'));
});

test('场景3：模板字符串普通文本与转义反引号', () => {
  const toks = lex('var s = `hello world`;');
  const s = toks.find((t) => t.t === 'str');
  assert.equal(s.quote, '`');
  assert.equal(s.hasSubst, false);
  assert.equal(s.v, 'hello world');
  // 源码里的 \\`（转义反引号）不终止模板
  const withEsc = 'var s = `a\\`b` + U(\'x.y\');';
  const t2 = lex(withEsc).find((t) => t.t === 'str' && t.quote === '`');
  assert.equal(t2.v, 'a`b');
  assert.deepEqual(extractCalls(withEsc), [{ fn: 'U', key: 'x.y', line: 1 }]);
});

test('场景4：模板插值 ${...} 内的 U() 调用被识别，插值内引号不破坏外层', () => {
  const src = 'el.innerHTML = `<b>${U(\'today.label.dueToday\')} ${x ? "是" : "否"}</b>`;';
  const calls = extractCalls(src);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, 'today.label.dueToday');
  // 模板被切成 3 段：<b> 、 两段插值之间的 ' ' 、 </b>
  const tplParts = lex(src).filter((t) => t.t === 'str' && t.quote === '`');
  assert.deepEqual(tplParts.map((t) => t.v), ['<b>', ' ', '</b>']);
});

test('场景5：嵌套模板字符串——内层插值中的调用也被识别', () => {
  const src = "var s = `a${ `b${ U('decide.result.label') }c` }d`;";
  const calls = extractCalls(src);
  assert.deepEqual(calls, [{ fn: 'U', key: 'decide.result.label', line: 1 }]);
});

test('场景6：行注释与块注释中的伪调用不产生引用', () => {
  const src = [
    "// U('fake.line') 和 UH('fake.block') 都是注释",
    "/* U('fake.block2') */",
    "var a = U('real.key'); // U('fake.trailing')",
  ].join('\n');
  const calls = extractCalls(src);
  assert.deepEqual(calls, [{ fn: 'U', key: 'real.key', line: 3 }]);
});

test('场景7：正则含引号、斜杠、方括号——扫描不错乱', () => {
  const src = [
    "var re1 = /['\"]/;",
    "var re2 = /a\\/b[)]/g;",
    "var re3 = /\\d{4}-\\d{2}/.exec(s);",
    "var ok = U('common.action.confirm');",
  ].join('\n');
  const calls = extractCalls(src);
  assert.deepEqual(calls, [{ fn: 'U', key: 'common.action.confirm', line: 4 }]);
  const toks = lex(src);
  assert.ok(toks.some((t) => t.t === 'regex' && t.v.startsWith("/['\"]")));
  assert.ok(toks.some((t) => t.t === 'regex' && t.v.startsWith('/a\\/b')));
});

test('场景8：除法不被误判为正则（prev 为 ) ] id 数字 字符串）', () => {
  const src = [
    "var a = (x + y) / 2 / z;",
    "var b = arr[0] / 4;",
    "var c = n / 60 + ' 分钟';",
    "var d = U('records.legend.less');",
  ].join('\n');
  const toks = lex(src);
  assert.ok(!toks.some((t) => t.t === 'regex'), '不应产生 regex token');
  assert.deepEqual(extractCalls(src), [{ fn: 'U', key: 'records.legend.less', line: 4 }]);
});

test('场景9：关键词后的正则（return /re/）不被当成除法', () => {
  const src = "function f(s){ return /^\\d+$/.test(s); } var e = U('x.y');";
  const toks = lex(src);
  assert.ok(toks.some((t) => t.t === 'regex'));
  assert.deepEqual(extractCalls(src), [{ fn: 'U', key: 'x.y', line: 1 }]);
});

test('场景10：字符串里的伪调用不产生引用', () => {
  const src = "var s = \"U('fake.inStr')\"; var t = 'UH(\\'fake.inStr2\\')';";
  assert.deepEqual(extractCalls(src), []);
});

test('场景11：混合语法文件扫描到文件末尾（token 覆盖全部行）', () => {
  const src = [
    "/* 头注释 U('fake.header') */",
    "function esc(t){ return String(t).replace(/[&<>\"']/g, function(c){ return c; }); }",
    "var a = `x${ U('a.b') }y`;",
    "// U('fake.line')",
    "var re = /(['\"])[^\\1]*\\1/;",
    "if (a) { s.innerHTML = UH('c.d'); } else { s.textContent = U('e.f'); }",
    "var last = n / 2; // 尾行 U('fake.last')",
  ].join('\n');
  const toks = lex(src);
  const maxLine = Math.max(...toks.map((t) => t.line));
  assert.equal(maxLine, 7, '扫描必须到达文件最后一行');
  const keys = extractCalls(src).map((c) => c.key);
  assert.deepEqual(keys, ['a.b', 'c.d', 'e.f']);
});

test('场景12（集成）：真实 core.js 全文——所有 UH 调用可被识别', () => {
  const core = readFileSync(new URL('../public/app/core.js', import.meta.url), 'utf8');
  const calls = extractCalls(core);
  const uhCalls = calls.filter((c) => c.fn === 'UH');
  // 当前 core.js 实际 UH 调用共 11 处（1015-1140 行），修复前识别为 0
  assert.equal(uhCalls.length, 11);
  assert.ok(uhCalls.every((c) => c.key.startsWith('common.')));
});
