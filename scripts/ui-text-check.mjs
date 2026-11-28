#!/usr/bin/env node
/* scripts/ui-text-check.mjs — 静态 UI 文案完整性检查（只读，无依赖）
 *
 * 检查项（错误 = 退出码 1；告警 = 默认只打印，--strict 时「未使用」也算失败）：
 *   1. key 命名格式（模块.业务对象.用途）
 *   2. 重复 key（同一 key 被两个分组文件重复定义，运行期只保留先注册的）
 *   3. 无效引用（代码里 U('x') / data-i18n="x" 找不到定义）
 *   4. 未使用文案（定义了但没有任何引用）
 *   5. 插值参数不一致（模板里有 {name}，调用处没传）
 *   6. HTML 里仍用中文原文当 key（迁移进度提示）
 *   7. HTML 静态兜底文本 / 属性值 与 配置值不一致
 *   8. 首次替换时机：apply.js 必须排在所有「会注册文案」的 config/*.js 之后、
 *      core.js 与 boot.js 之前；index.js 里不允许出现 applyDom(document)
 *   9. U() 进入 innerHTML / outerHTML / insertAdjacentHTML（**跨行**分析整个赋值表达式）
 *  10. 动态 key（U(variable) / U('a.' + b) / U(`a.${b}`)）—— 规范禁止，按错误处理
 *
 * 解析方式：为了让双引号、模板字符串、注释里的假 key 都不再漏检/误检，
 * 本脚本自带一个最小词法器（约 100 行），按 token 判断，不再用「逐行正则 + 单引号」。
 *
 * 用法：
 *   node scripts/ui-text-check.mjs [--strict] [--root <目录>]
 *   --root 仅给测试用：在临时夹具目录上跑同一套规则（默认 process.cwd()）。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { lex } from './ui-text-lex.mjs';

const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict');
const rootArg = (() => {
  const i = argv.indexOf('--root');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--root='));
  return eq ? eq.slice('--root='.length) : null;
})();

const ROOT = path.resolve(rootArg || process.cwd());
const APP_DIR = path.join(ROOT, 'public/app');
const CONFIG_DIR = path.join(APP_DIR, 'config');
const HTML_PATH = path.join(APP_DIR, 'index.html');

const NEW_KEY = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

const errors = [];
const warnings = [];
const dynamicKeys = [];      // 规范禁止：必须阻断
const unverifiable = [];     // 无法静态判断的 HTML 写入（必须可见）

const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

/* 词法器已抽出至 scripts/ui-text-lex.mjs（含正则字面量支持，见该文件头注释） */
const isP = (t, v) => !!t && t.t === 'punc' && t.v === v;
const isId = (t, v) => !!t && t.t === 'id' && (v === undefined || t.v === v);

/* 从 start（指向 '{'）找到匹配的 '}' 下标 */
function matchBrace(toks, start) {
  let d = 0;
  for (let k = start; k < toks.length; k += 1) {
    const u = toks[k];
    if (u.t !== 'punc') continue;
    if (u.v === '{' || u.v === '(' || u.v === '[') d += 1;
    else if (u.v === '}' || u.v === ')' || u.v === ']') {
      d -= 1;
      if (d === 0) return k;
    }
  }
  return toks.length - 1;
}

/* 读取 ``U('k', { a: 1 })`` 里的参数名；返回 null 表示「看得见但不是对象字面量」 */
function readVars(toks, from) {
  if (!isP(toks[from], ',')) return [];            // 没有第二个参数
  let k = from + 1;
  if (!isP(toks[k], '{')) return null;             // 不是对象字面量 → 无法静态判断
  const end = matchBrace(toks, k);
  const vars = [];
  let d = 0;
  for (let j = k + 1; j < end; j += 1) {
    const u = toks[j];
    if (u.t === 'punc' && (u.v === '{' || u.v === '(' || u.v === '[')) d += 1;
    else if (u.t === 'punc' && (u.v === '}' || u.v === ')' || u.v === ']')) d -= 1;
    else if (d === 0 && u.t === 'id' && toks[j + 1] && isP(toks[j + 1], ':')) vars.push(u.v);
    else if (d === 0 && u.t === 'id' && toks[j + 1] && toks[j + 1].t === 'id' && toks[j + 1].v === 'as') {
      // TS 风格的陷阱：本仓库是纯 JS，这里只防御性占位
    }
  }
  return vars;
}

/* ============================================================================
 * 1. 真实脚本顺序（从 index.html 读，不维护第二份硬编码清单）
 * ========================================================================== */
const html = fs.readFileSync(HTML_PATH, 'utf8');
const htmlLines = html.split(/\r?\n/);
const lineOf = (idx) => html.slice(0, idx).split('\n').length;

const scriptSrcs = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
  .map((m) => (m[1] !== undefined ? m[1] : m[2]));
const configScripts = scriptSrcs.filter((s) => s.startsWith('config/'));

/* ============================================================================
 * 2. 在沙箱里按真实顺序加载，拿最终注册表
 * ========================================================================== */
function loadRegistry(scripts) {
  const win = {
    document: { readyState: 'complete', querySelectorAll: () => [], addEventListener() {} },
    location: { search: '' },
    console: { warn() {}, log() {} },
  };
  win.window = win;
  const ctx = vm.createContext(win);
  for (const rel of scripts) {
    const file = path.join(APP_DIR, rel);
    if (!fs.existsSync(file)) {
      err('脚本不存在：' + rel + '（index.html 引用了但磁盘上没有）');
      continue;
    }
    try {
      vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: rel });
    } catch (e) {
      err('加载失败：' + rel + ' → ' + e.message);
    }
  }
  return (win.OLText && win.OLText.messages) || {};
}

const registry = loadRegistry(configScripts.filter((s) => s !== 'config/apply.js'));
const definedKeys = Object.keys(registry);

/* ============================================================================
 * 3. 定义（按 token 解析 register 的对象字面量）
 * ========================================================================== */
const defs = new Map();     // key -> [{ file, line, text }]
let legacyCount = 0;
const configFiles = fs.readdirSync(CONFIG_DIR).filter((n) => n.endsWith('.js')).sort();
const configTokens = new Map();   // 文件名 -> tokens（后面的顺序检查复用）

for (const name of configFiles) {
  const src = fs.readFileSync(path.join(CONFIG_DIR, name), 'utf8');
  const toks = lex(src);
  configTokens.set(name, toks);
  if (name === 'index.js' || name === 'apply.js' || name === 'toast-text.js') continue;

  for (let i = 0; i < toks.length; i += 1) {
    if (!isId(toks[i], 'register')) continue;
    if (!isP(toks[i + 1], '(')) continue;

    /* 找 register(...) 里第一个处于「参数层」的对象字面量 */
    let start = -1;
    let paren = 0;
    for (let j = i + 2; j < toks.length; j += 1) {
      const u = toks[j];
      if (isP(u, '(')) paren += 1;
      else if (isP(u, ')')) { if (paren === 0) break; paren -= 1; }
      else if (isP(u, '{') && paren === 0) { start = j; break; }
    }
    if (start < 0) continue;

    const end = matchBrace(toks, start);
    let d = 0;
    for (let k = start + 1; k < end; k += 1) {
      const u = toks[k];
      if (u.t === 'punc' && (u.v === '{' || u.v === '(' || u.v === '[')) {
        /* 计算属性名 / 展开运算符：静态检查看不到 key，必须报出来而不是静默跳过 */
        if (u.v === '[' && d === 0 && (isP(toks[k - 1], '{') || isP(toks[k - 1], ','))) {
          err('定义使用了计算属性名，无法静态校验 @ config/' + name + ':' + u.line);
        }
        d += 1;
        continue;
      }
      if (u.t === 'punc' && (u.v === '}' || u.v === ')' || u.v === ']')) { d -= 1; continue; }
      if (u.t === 'punc' && u.v === '...' && d === 0) {
        warn('定义里使用了展开运算符，可能注册了无法静态校验的 key @ config/' + name + ':' + u.line);
        continue;
      }
      if (d !== 0 || u.t !== 'str') continue;
      if (!isP(toks[k + 1], ':')) continue;

      const valTok = toks[k + 2];
      if (!valTok || valTok.t !== 'str' || valTok.hasSubst) {
        if (REG_KEY_TEST(u.v)) {
          err('定义不是字符串字面量：' + u.v + ' @ config/' + name + ':' + u.line +
            '（无法静态比对，改成静态字符串或移出文案表）');
        }
        continue;
      }
      const key = u.v;
      if (!NEW_KEY.test(key)) { legacyCount += 1; continue; }
      if (!defs.has(key)) defs.set(key, []);
      defs.get(key).push({ file: 'config/' + name, line: u.line, text: valTok.v });
    }
  }
}

function REG_KEY_TEST(k) { return NEW_KEY.test(k); }

/* 磁盘上会注册文案、却没被 index.html 加载的模块 —— 必须报错 */
for (const name of configFiles) {
  if (name === 'index.js' || name === 'apply.js' || name === 'toast-text.js') continue;
  const toks = configTokens.get(name) || [];
  const registers = toks.some((t, i) => isId(t, 'register') && isP(toks[i + 1], '('));
  if (!registers) continue;
  if (!configScripts.includes('config/' + name)) {
    err('配置模块未在 index.html 中加载：config/' + name +
      '（它会注册文案，但页面永远不会执行到它）');
  }
}

/* ============================================================================
 * 4. 引用：HTML
 * ========================================================================== */
const refs = new Map();     // key -> [{ where, vars }]
function addRef(key, where, vars) {
  if (!refs.has(key)) refs.set(key, []);
  refs.get(key).push({ where, vars });
}

/* 解析一个开始标签的所有属性（支持无值属性、单双引号） */
function parseAttrs(rawTag) {
  const attrs = new Map();
  const body = rawTag.replace(/^<[a-zA-Z][\w-]*/, '').replace(/\/?>$/, '');
  const re = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : null));
    attrs.set(name, value);
  }
  return attrs;
}

const ATTR_IGNORE = new Set(['data-i18n', 'data-i18n-attr', 'data-i18n-skip-text']);
const htmlEls = [];

{
  const re = /data-i18n\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const key = m[1] !== undefined ? m[1] : m[2];
    const line = lineOf(m.index);
    const tagStart = html.lastIndexOf('<', m.index);
    const tagEnd = html.indexOf('>', m.index);
    const rawTag = html.slice(tagStart, tagEnd + 1);
    const tagName = ((/^<([a-zA-Z][\w-]*)/.exec(rawTag) || [])[1] || '').toLowerCase();
    const attrs = parseAttrs(rawTag);
    const skipText = attrs.has('data-i18n-skip-text');

    const rest = html.slice(tagEnd + 1);
    const closeAt = rest.indexOf('</' + tagName);
    const ltAt = rest.indexOf('<');
    const textEnd = closeAt >= 0 ? closeAt : (ltAt >= 0 ? ltAt : rest.length);
    const text = rest.slice(0, textEnd);

    /* 属性目标：data-i18n-attr="a,b" + data-i18n-<suffix> */
    const targets = [];
    const decl = attrs.get('data-i18n-attr');
    if (decl) decl.split(/[,\s]+/).filter(Boolean).forEach((a) => targets.push(a.trim()));
    for (const [name, value] of attrs) {
      if (!name.startsWith('data-i18n-') || ATTR_IGNORE.has(name)) continue;
      const suffix = name.slice('data-i18n-'.length);
      if (!suffix) continue;
      if (value !== null && value !== '' && value !== suffix) {
        err('属性目标值应留空或与后缀一致：index.html:' + line + ' ' + name + '="' + value + '"' +
          '（实际会被当作 ' + suffix + '，值是误导性的）');
      }
      targets.push(suffix);
    }

    htmlEls.push({ key, line, tagName, rawTag, attrs, text, skipText, nested: text.includes('<'), targets });
    addRef(key, 'index.html:' + line, []);

    if (/[\u4e00-\u9fa5]/.test(key)) warn('index.html:' + line + ' 仍用中文当 key：' + key);
  }
}

/* ============================================================================
 * 5. 引用：JS（token 解析，支持 ' " ` 三种写法）
 * ========================================================================== */
const appFiles = fs.readdirSync(APP_DIR).filter((f) => f.endsWith('.js'));

/* HTML 表达式里可以被认为是「不会产出未转义文本」的调用白名单 */
const HTML_CALL_WHITELIST = new Set([
  'UH', 'U', 'esc', 'escapeHtml', 'String', 'Number', 'Boolean', 'Date',
  'parseInt', 'parseFloat', 'encodeURIComponent', 'JSON', 'Math', 'Array', 'Object',
  'fmt', 'if', 'for', 'while', 'switch', 'catch', 'typeof', 'new', 'function', 'return',
]);

for (const name of appFiles) {
  const src = fs.readFileSync(path.join(APP_DIR, name), 'utf8');
  const toks = lex(src);

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.t !== 'id' || (t.v !== 'U' && t.v !== 'UH')) continue;
    /* 跳过对象属性 { U: ... } / { a: 1, U: ... }；
       三元表达式 cond ? U('a') : U('b') 的第二分支同样以 ':' 开头，
       但其 ':' 前是 ')' 或其他表达式结尾，不是对象字面量上下文，不可跳过。 */
    if (toks[i - 1] && isP(toks[i - 1], ':') &&
        toks[i - 2] && (isP(toks[i - 2], '{') || isP(toks[i - 2], ','))) continue;
    if (!isP(toks[i + 1], '(')) continue;

    const arg = toks[i + 2];
    const after = toks[i + 3];
    const isLiteral = !!arg && arg.t === 'str' && !arg.hasSubst && !arg.unterminated;
    /* 紧跟 ',' ')' '.' ';' '}' 才算「这个字符串就是整个 key」；
       '+' 表示字符串还在拼接里（U('a.' + b)）→ 动态 key。 */
    const endsThere = !after || isP(after, ',') || isP(after, ')') || isP(after, '.') ||
      isP(after, ';') || isP(after, '}');

    if (!isLiteral || !endsThere) {
      dynamicKeys.push({
        where: name + ':' + t.line,
        form: !isLiteral
          ? (arg && arg.t === 'str' ? '模板字符串插值' : (arg ? '非字面量参数（' + (arg.t === 'id' ? '变量' : '表达式') + '）' : '空参数'))
          : '字符串拼接',
      });
      continue;
    }

    const vars = readVars(toks, i + 3);
    addRef(arg.v, name + ':' + t.line, vars);
  }

  /* U()/UH() 的调用点（供 HTML 写入分析复用） */
  collectHtmlWrites(name, toks);
}

function collectHtmlWrites(name, toks) {
  const reported = new Set();
  const reportBare = (line, how, count) => {
    const id = name + ':' + line;
    if (reported.has(id)) return;
    reported.add(id);
    err('裸 U() ' + how + '（U 不转义，必须用 UH 或 textContent）@ ' + id +
      (count > 1 ? '（同一处出现 ' + count + ' 次）' : ''));
  };

  const readExpression = (start) => {
    let d = 0;
    for (let k = start; k < toks.length; k += 1) {
      const u = toks[k];
      if (u.t !== 'punc') continue;
      if (u.v === '(' || u.v === '[' || u.v === '{') d += 1;
      else if (u.v === ')' || u.v === ']' || u.v === '}') {
        if (d === 0) return { from: start, to: k };
        d -= 1;
      } else if ((u.v === ';' || u.v === ',') && d === 0) return { from: start, to: k };
    }
    return { from: start, to: toks.length };
  };

  const splitArgs = (start) => {
    const args = [];
    let d = 0;
    let from = start;
    for (let k = start; k < toks.length; k += 1) {
      const u = toks[k];
      if (u.t !== 'punc') continue;
      if (u.v === '(' || u.v === '[' || u.v === '{') d += 1;
      else if (u.v === ')' || u.v === ']' || u.v === '}') {
        if (d === 0) { args.push({ from, to: k }); return args; }
        d -= 1;
      } else if (u.v === ',' && d === 0) { args.push({ from, to: k }); from = k + 1; }
    }
    args.push({ from, to: toks.length });
    return args;
  };

  /* ---- 语句切片：跨行表达式在这里被当成一整段，而不是逐行看 ---- */
  const stmts = [];
  {
    let start = 0;
    let d = 0;
    for (let k = 0; k < toks.length; k += 1) {
      const u = toks[k];
      if (u.t !== 'punc') continue;
      if (u.v === '(' || u.v === '[') d += 1;
      else if (u.v === ')' || u.v === ']') d -= 1;
      else if (d === 0 && (u.v === ';' || u.v === '{' || u.v === '}')) {
        if (k > start) stmts.push([start, k]);
        start = k + 1;
      }
    }
    if (start < toks.length) stmts.push([start, toks.length]);
  }

  const bareUIn = (a, b) => {
    const hits = [];
    for (let k = a; k < b; k += 1) {
      if (isId(toks[k], 'U') && isP(toks[k + 1], '(')) hits.push(toks[k].line);
    }
    return hits;
  };

  /* ---- A. 直接写入：innerHTML / outerHTML / insertAdjacentHTML ---- */
  const analyze = (sink, range, atLine) => {
    const slice = toks.slice(range.from, range.to);
    const bare = [];
    const unknown = [];
    for (let k = 0; k < slice.length; k += 1) {
      const u = slice[k];
      if (u.t !== 'id') continue;
      if (!isP(slice[k + 1], '(')) continue;
      if (u.v === 'U') bare.push(u.line);
      else if (!HTML_CALL_WHITELIST.has(u.v) && !isP(slice[k - 1], '.')) unknown.push(u.v);
    }
    if (bare.length) { reportBare(atLine, '进入 ' + sink, bare.length); return; }
    /* 没有裸 U，但表达式里有认不出的函数调用 → 不能静态判断，必须报出来 */
    const hasUh = slice.some((u) => isId(u, 'UH'));
    if (unknown.length && !hasUh) {
      unverifiable.push({ where: name + ':' + atLine, sink, calls: [...new Set(unknown)].slice(0, 3) });
    }
  };

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.t === 'id' && (t.v === 'innerHTML' || t.v === 'outerHTML')) {
      const op = toks[i + 1];
      if (!(isP(op, '=') || isP(op, '+='))) continue;
      analyze(t.v, readExpression(i + 2), t.line);
      continue;
    }
    if (t.t === 'id' && t.v === 'insertAdjacentHTML' && isP(toks[i + 1], '(')) {
      const args = splitArgs(i + 2);
      if (args.length < 2) {
        unverifiable.push({ where: name + ':' + t.line, sink: 'insertAdjacentHTML', calls: ['(参数不足，无法判断)'] });
        continue;
      }
      analyze('insertAdjacentHTML', args[1], t.line);
    }
  }

  /* ---- B. 跨行拼接：语句里同时出现「HTML 字面量」和裸 U() ---- */
  const isHtmlLiteral = (t) => t.t === 'str' && /<\/?[a-zA-Z][^>]*>/.test(t.v);
  for (const [a, b] of stmts) {
    let hasHtmlLit = false;
    let hasInsert = false;
    for (let k = a; k < b; k += 1) {
      if (isHtmlLiteral(toks[k])) hasHtmlLit = true;
      if (isId(toks[k], 'insertAdjacentHTML')) hasInsert = true;
    }
    if (!hasHtmlLit || hasInsert) continue;    // insertAdjacentHTML 的参数已由 A 段检查，避免重复报
    const hits = bareUIn(a, b);
    if (hits.length) reportBare(hits[0], '拼进 HTML 字符串', hits.length);
  }

  /* ---- C. 一跳变量污染：html += ...U()... 之后 el.innerHTML = html ---- */
  const htmlVars = new Set();
  for (const [a, b] of stmts) {
    for (let k = a; k < b; k += 1) {
      if (!isId(toks[k]) || (toks[k].v !== 'innerHTML' && toks[k].v !== 'outerHTML')) continue;
      if (!(isP(toks[k + 1], '=') || isP(toks[k + 1], '+='))) continue;
      for (let j = k + 2; j < b; j += 1) {
        if (isId(toks[j]) && !isP(toks[j - 1], '.')) htmlVars.add(toks[j].v);
      }
    }
  }
  if (htmlVars.size) {
    for (const [a, b] of stmts) {
      if (!isId(toks[a]) || !htmlVars.has(toks[a].v)) continue;
      if (!(isP(toks[a + 1], '=') || isP(toks[a + 1], '+='))) continue;
      const hits = bareUIn(a, b);
      if (hits.length) reportBare(hits[0], '拼进 HTML 变量 ' + toks[a].v, hits.length);
    }
  }
}

/* ============================================================================
 * 6. 判定
 * ========================================================================== */
/* 6a. 重复 key */
for (const [key, list] of defs) {
  if (list.length > 1) {
    err('重复 key：' + key + ' → ' + list.map((d) => d.file + ':' + d.line).join(' / ') +
      '（运行期只保留先注册的）');
  }
}

/* 6b. 无效引用（动态 key 不进这张统计） */
for (const [key, list] of refs) {
  if (!(key in registry)) {
    err('无效引用：' + key + ' @ ' + list.map((r) => r.where).join(', '));
  }
}

/* 6c. 未使用 */
for (const key of definedKeys) {
  if (!refs.has(key)) {
    const d = defs.get(key);
    warn('未使用：' + key + (d ? '（' + d[0].file + ':' + d[0].line + '）' : ''));
  }
}

/* 6d. 插值一致性 */
for (const [key, list] of refs) {
  const tpl = registry[key];
  if (typeof tpl !== 'string') continue;
  const need = (tpl.match(/\{([A-Za-z0-9_]+)\}/g) || []).map((p) => p.slice(1, -1));
  if (!need.length) continue;
  for (const r of list) {
    if (r.vars === null) {
      warn('插值无法静态判断：' + key + ' 的调用参数不是对象字面量 @ ' + r.where);
      continue;
    }
    const miss = need.filter((p) => !r.vars.includes(p));
    if (miss.length) {
      err('插值缺失：' + key + ' 需要 ' + miss.map((x) => '{' + x + '}').join('') + ' @ ' + r.where);
    }
  }
}

/* 6e. HTML 兜底文本 / 属性 与 配置值一致 */
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
for (const el of htmlEls) {
  const value = registry[el.key];
  if (typeof value !== 'string') continue;          // 无效引用已在 6b 报过

  if (!el.skipText && el.tagName !== 'input' && !el.nested && norm(el.text) !== '') {
    if (norm(el.text) !== norm(value)) {
      err('兜底不一致：index.html:' + el.line + ' <' + el.tagName + '> ' + el.key +
        '  HTML=「' + norm(el.text) + '」 配置=「' + norm(value) + '」');
    }
  }

  for (const attr of el.targets) {
    if (!el.attrs.has(attr)) {
      err('属性缺失：index.html:' + el.line + ' 声明了 ' + attr + ' 但没有这个属性');
      continue;
    }
    const got = el.attrs.get(attr);
    if (got === null) {
      err('属性为空：index.html:' + el.line + ' ' + attr + ' 没有值，无法作为兜底比对');
      continue;
    }
    if (norm(got) !== norm(value)) {
      err('属性兜底不一致：index.html:' + el.line + ' ' + attr + '=「' + norm(got) +
        '」 配置=「' + norm(value) + '」');
    }
  }
}

/* 6f. 加载顺序（真实 HTML） */
{
  const applyIdx = scriptSrcs.indexOf('config/apply.js');
  if (applyIdx < 0) {
    err('缺少 config/apply.js：首次 DOM 替换没有明确执行点');
  } else {
    for (const s of configScripts) {
      if (s === 'config/apply.js') continue;
      const toks = configTokens.get(path.basename(s)) || [];
      const registers = toks.some((t, i) => isId(t, 'register') && isP(toks[i + 1], '('));
      if (!registers) continue;
      if (scriptSrcs.indexOf(s) > applyIdx) {
        err('加载顺序：' + s + ' 排在 config/apply.js 之后，它的文案不会参与首次替换');
      }
    }
    for (const must of ['core.js', 'boot.js']) {
      const idx = scriptSrcs.indexOf(must);
      if (idx < 0) {
        warn('index.html 未找到 ' + must + '，无法断言它晚于 apply.js');
      } else if (idx < applyIdx) {
        err('加载顺序：' + must + ' 早于 config/apply.js，业务渲染/启动会先于文案替换');
      }
    }
  }

  const idxFile = path.join(CONFIG_DIR, 'index.js');
  if (fs.existsSync(idxFile)) {
    const idxSrc = fs.readFileSync(idxFile, 'utf8');
    if (/applyDom\s*\(\s*document\s*\)/.test(idxSrc)) {
      err('config/index.js 里出现 applyDom(document)：注册未完成就替换会误报缺失 key');
    }
  }
}

/* ============================================================================
 * 7. 报告
 * ========================================================================== */
console.log('[ui-text] 新 key 定义 ' + definedKeys.length + ' 个；旧中文 key ' + legacyCount + ' 条（迁移期保留）');
console.log('[ui-text] 引用点 ' + [...refs.values()].reduce((a, b) => a + b.length, 0) + ' 处；' +
  'HTML 元素 ' + htmlEls.length + ' 个');

if (dynamicKeys.length) {
  err('动态 key（规范禁止，key 必须是静态字面量）共 ' + dynamicKeys.length + ' 处：' +
    dynamicKeys.slice(0, 10).map((d) => d.where + '（' + d.form + '）').join('；') +
    (dynamicKeys.length > 10 ? '；…其余 ' + (dynamicKeys.length - 10) + ' 处' : ''));
}

if (unverifiable.length) {
  warn('无法静态判断的 HTML 写入 ' + unverifiable.length + ' 处（需人工确认不会拼入裸 U()）：');
  unverifiable.slice(0, 10).forEach((u) => console.log('  ~ ' + u.where + ' ' + u.sink + ' ← ' + u.calls.join('/') + '(...)'));
  if (unverifiable.length > 10) console.log('  …（其余 ' + (unverifiable.length - 10) + ' 处省略）');
}

if (errors.length) {
  console.log('[ui-text] 错误 ' + errors.length + ' 项：');
  errors.forEach((e) => console.log('  - ' + e));
}
if (warnings.length) {
  console.log('[ui-text] 告警 ' + warnings.length + ' 项：');
  warnings.slice(0, 20).forEach((w) => console.log('  - ' + w));
  if (warnings.length > 20) console.log('  …（其余 ' + (warnings.length - 20) + ' 项省略）');
}

const failed = errors.length > 0 || (STRICT && warnings.some((w) => w.startsWith('未使用')));
console.log('[ui-text] ' + (failed ? 'FAIL' : 'OK') + '（错误 ' + errors.length + '，告警 ' + warnings.length + '）');
process.exit(failed ? 1 : 0);
