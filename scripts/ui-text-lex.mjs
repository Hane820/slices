/* ui-text-lex.mjs — ui-text-check 的最小 JS 词法器（自包含，无依赖）
 *
 * 从 ui-text-check.mjs 抽出，便于单元测试（scripts/ui-text-lex.test.mjs）。
 * 产出 { t:'id'|'str'|'punc'|'num'|'regex', v, line, hasSubst?, quote? }
 *   - 跳过行注释与块注释（注释里的 U() 等伪调用不会产生 token）
 *   - 字符串保留「值」，模板字符串保留「是否有 ${} 插值」
 *   - 模板插值内部继续切 token（U() 写在 ${} 里也能被发现），支持嵌套模板
 *   - 正则字面量：按「前一个有意义 token」区分除法与正则位置；
 *     处理 \\ 转义与 [...] 字符类（类内 / 不终止）；flags 一并吃掉。
 *     修复背景：core.js:79 的 esc() —— /[&<>"']/g 里的引号曾把后续真实
 *     代码吞进字符串，导致该行之后所有调用无法识别（词法断裂）。
 */

export function lex(src) {
  const toks = [];
  let i = 0;
  let line = 1;
  let prevTok = null; /* 最近一个被输出的 token（空白/注释不产出 token） */
  const isIdStart = (c) => /[A-Za-z_$]/.test(c || '');
  const isIdPart = (c) => /[A-Za-z0-9_$]/.test(c || '');
  const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '&&=', '||=', '??=',
    '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '+=', '-=', '*=', '/=', '%=',
    '++', '--', '<<', '>>', '**'];
  /* 这些关键词后面允许出现正则字面量（否则 return /re/ 会被当成除法） */
  const REGEX_KEYWORDS = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'throw', 'case', 'do', 'else', 'yield', 'await',
  ]);

  const push = (t, v, ln, extra) => {
    const o = { t, v, line: ln === undefined ? line : ln };
    if (extra) Object.assign(o, extra);
    toks.push(o);
    prevTok = o;
    return o;
  };

  function readQuoted(quote) {
    const startLine = line;
    i += 1;
    let value = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        const n = src[i + 1];
        if (n === 'n') value += '\n';
        else if (n === 't') value += '\t';
        else if (n === '\n') line += 1;
        else if (n !== undefined) value += n;
        i += 2;
        continue;
      }
      if (c === quote) { i += 1; push('str', value, startLine, { quote, hasSubst: false }); return; }
      if (c === '\n') line += 1;      // 未闭合：容忍并继续，由后续检查报错
      value += c;
      i += 1;
    }
    push('str', value, startLine, { quote, hasSubst: false, unterminated: true });
  }

  function readTemplate() {
    const startLine = line;
    let partLine = startLine;
    i += 1;
    let value = '';
    let hasSubst = false;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        const n = src[i + 1];
        if (n !== undefined) value += n;
        if (n === '\n') line += 1;
        i += 2;
        continue;
      }
      if (c === '`') { i += 1; push('str', value, partLine, { quote: '`', hasSubst }); return; }
      if (c === '$' && src[i + 1] === '{') {
        hasSubst = true;
        push('str', value, partLine, { quote: '`', hasSubst: true });
        value = '';
        i += 2;
        push('punc', '{', line, { tpl: true });
        run(true);                          // 吃掉 ${ ... } 内部
        partLine = line;
        continue;
      }
      if (c === '\n') line += 1;
      value += c;
      i += 1;
    }
    push('str', value, partLine, { quote: '`', hasSubst });
  }

  /* 正则字面量。token 类型用独立的 'regex'：所有消费方按
     id/str/punc/num 过滤，未知类型天然被跳过，不会干扰下游判断。 */
  function readRegex() {
    const startLine = line;
    const startIdx = i;
    i += 1;
    let inClass = false;
    let terminated = false;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') break;                       // 未闭合：容忍，停在行尾
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        i += 1;
        while (i < src.length && isIdPart(src[i])) i += 1;  // flags：gimsuy 等
        terminated = true;
        break;
      }
      i += 1;
    }
    push('regex', src.slice(startIdx, i), startLine,
      terminated ? undefined : { unterminated: true });
  }

  function run(stopAtBrace) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '\n') { line += 1; i += 1; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line += 1; i += 1; }
        i += 2;
        continue;
      }
      if (c === '"' || c === "'") { readQuoted(c); continue; }
      if (c === '`') { readTemplate(); continue; }
      if (c === '/') {
        /* 除法还是正则：前一个 token 为 ) ] 或普通 id/数字/字符串 → 除法；
           其余（行首、运算符后、关键词后）→ 正则。 */
        const prev = prevTok;
        const regexAllowed = !prev ||
          (prev.t === 'punc' && prev.v !== ')' && prev.v !== ']') ||
          (prev.t === 'id' && REGEX_KEYWORDS.has(prev.v));
        if (regexAllowed) { readRegex(); continue; }
        /* 否则按标点走下面的通用分支（含 /=） */
      }
      if (stopAtBrace && c === '}' && depth === 0) {
        i += 1;
        push('punc', '}', line, { tpl: true });   // 保留右括号，保证 token 括号平衡
        return;
      }
      if (isIdStart(c)) {
        const s = i;
        while (i < src.length && isIdPart(src[i])) i += 1;
        push('id', src.slice(s, i));
        continue;
      }
      if (c >= '0' && c <= '9') {
        const s = i;
        while (i < src.length && /[0-9a-zA-Z._]/.test(src[i])) i += 1;
        push('num', src.slice(s, i));
        continue;
      }
      let p = null;
      for (const cand of PUNCT) { if (src.startsWith(cand, i)) { p = cand; break; } }
      if (!p) p = c;
      if (p === '{') depth += 1;
      else if (p === '}') depth -= 1;
      push('punc', p);
      i += p.length;
    }
  }

  run(false);
  return toks;
}
