#!/usr/bin/env node
/* scripts/ui-text-check.mjs — 静态 UI 文案完整性检查（只读，无依赖）
 *
 * 检查项：
 *   1. key 命名格式（模块.业务对象.用途，全小写）
 *   2. 重复 key（同一 key 被两个分组文件重复定义，后定义会被静默忽略）
 *   3. 无效引用（代码里 U('x') / data-i18n="x" 找不到定义）
 *   4. 未使用文案（定义了但没有任何引用）
 *   5. 插值参数不一致（模板里有 {name}，调用处没传）
 *   6. HTML 里仍用中文原文当 key（迁移进度提示）
 *
 * 用法：node scripts/ui-text-check.mjs [--strict]
 *   --strict 时「未使用」也算失败。默认只告警。
 * 没有接进 npm test：是否接入等确认，避免改动无关的测试配置。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CONFIG_DIR = path.join(ROOT, 'public/app/config');
const APP_DIR = path.join(ROOT, 'public/app');
const HTML = path.join(APP_DIR, 'index.html');
const LEGACY_EXCLUDE = new Set(['toast-text.js']);   // Toast 配置中心独立，不参与本检查

const NEW_KEY = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const STRICT = process.argv.includes('--strict');

const errors = [];
const warnings = [];

/* ---------- 1. 收集定义 ---------- */
const defs = new Map();   // key -> [{ file, line, text }]
const legacyCount = { total: 0 };

for (const name of fs.readdirSync(CONFIG_DIR).sort()) {
  if (!name.endsWith('.js') || LEGACY_EXCLUDE.has(name) || name === 'index.js') continue;
  const file = path.join(CONFIG_DIR, name);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = line.match(/^\s*'((?:[^'\\]|\\.)+)'\s*:\s*'((?:[^'\\]|\\.)*)'/);
    if (!m) return;
    const key = m[1];
    if (!NEW_KEY.test(key)) { legacyCount.total++; return; }
    if (!defs.has(key)) defs.set(key, []);
    defs.get(key).push({ file: 'config/' + name, line: i + 1, text: m[2] });
  });
}

/* ---------- 2. 引用 ---------- */
const refs = new Map();   // key -> [{ where, vars:[], raw }]
function addRef(key, where, vars, raw) {
  if (!refs.has(key)) refs.set(key, []);
  refs.get(key).push({ where, vars, raw });
}

const html = fs.readFileSync(HTML, 'utf8').split(/\r?\n/);
html.forEach((line, i) => {
  const re = /data-i18n="([^"]+)"/g;
  let m;
  while ((m = re.exec(line)) !== null) addRef(m[1], 'index.html:' + (i + 1), [], line.trim());
  const reCn = /data-i18n="([^"]*[\u4e00-\u9fa5][^"]*)"/g;
  while ((m = reCn.exec(line)) !== null) warnings.push('index.html:' + (i + 1) + ' 仍用中文当 key：' + m[1]);
});

for (const name of fs.readdirSync(APP_DIR).filter(f => f.endsWith('.js'))) {
  const file = path.join(APP_DIR, name);
  const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  src.forEach((line, i) => {
    const re = /(?:^|[^\w.$])(U|UH)\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const key = m[2];
      const tail = line.slice(m.index + m[0].length - 1);
      const vars = [];
      const obj = tail.match(/^\s*'[^']*'\s*,\s*\{([^}]*)\}/);
      if (obj) {
        const vre = /([A-Za-z0-9_]+)\s*:/g;
        let v;
        while ((v = vre.exec(obj[1])) !== null) vars.push(v[1]);
      }
      addRef(key, file.replace(ROOT + '/', '') + ':' + (i + 1), vars, line.trim());
    }
  });
}

/* ---------- 3. 判定 ---------- */
for (const [key, list] of defs) {
  if (list.length > 1) {
    errors.push('重复 key：' + key + ' → ' + list.map(d => d.file + ':' + d.line).join(' / '));
  }
  if (!refs.has(key)) warnings.push('未使用：' + key + '（' + list[0].file + ':' + list[0].line + '）');
}

for (const [key, list] of refs) {
  if (!defs.has(key)) {
    errors.push('无效引用：' + key + ' @ ' + list.map(r => r.where).join(', '));
    continue;
  }
  const placeholders = [];
  const pre = defs.get(key)[0].text.match(/\{([A-Za-z0-9_]+)\}/g) || [];
  pre.forEach(p => placeholders.push(p.slice(1, -1)));
  if (!placeholders.length) continue;
  for (const r of list) {
    if (!r.vars.length) {
      errors.push('插值缺失：' + key + ' 需要 {' + placeholders.join('},{') + '}，' + r.where + ' 没传参数');
      continue;
    }
    const miss = placeholders.filter(p => !r.vars.includes(p));
    if (miss.length) errors.push('插值缺失：' + key + ' 缺 ' + miss.map(x => '{' + x + '}').join('') + ' @ ' + r.where);
  }
}

/* ---------- 4. 报告 ---------- */
const newCount = defs.size;
console.log('[ui-text] 新 key 定义 ' + newCount + ' 个；旧中文 key ' + legacyCount.total + ' 条（迁移期保留）');
console.log('[ui-text] 引用点 ' + [...refs.values()].reduce((a, b) => a + b.length, 0) + ' 处');
if (errors.length) {
  console.log('[ui-text] 错误 ' + errors.length + ' 项：');
  errors.forEach(e => console.log('  - ' + e));
}
if (warnings.length) {
  console.log('[ui-text] 告警 ' + warnings.length + ' 项：');
  warnings.slice(0, 20).forEach(w => console.log('  - ' + w));
  if (warnings.length > 20) console.log('  …（其余 ' + (warnings.length - 20) + ' 项省略）');
}
const failed = errors.length > 0 || (STRICT && warnings.some(w => w.startsWith('未使用')));
console.log('[ui-text] ' + (failed ? 'FAIL' : 'OK') + '（错误 ' + errors.length + '，告警 ' + warnings.length + '）');
process.exit(failed ? 1 : 0);
