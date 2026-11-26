/* config/index.js — 地球online 静态 UI 文案注册表
 * ============================================================================
 * 两套并存的查找方式（迁移期）：
 *
 * 1) 新：英文语义 key（本文件起主导作用）
 *      U('today.section.tasks')               → '今日待办'
 *      U('today.task.due.overdue', {days:3})  → '逾期 3 天'
 *      UH('today.task.due.overdue', {days:3}) → 已 HTML 转义的同一句话
 *    key 形如 模块.业务对象.用途，与文件路径、中文原文都无关，改文案不用改 key。
 *
 * 2) 旧：中文原文当 key（OLT() 仍在用，迁移期保留）
 *      OLT('取消') → 查 legacy 表，查不到就原样返回
 *    旧机制一条都不删：现在仍有 800 多处调用依赖它，等分批迁移完再统一退役。
 *
 * 页面里的静态文字：
 *      <span data-i18n="today.section.tasks">今日待办</span>
 *    HTML 里的中文是兜底；注册表可用且能查到 key 时，用 textContent 覆盖成配置值。
 *    配置缺失、脚本没加载、key 写错，页面显示的都是原中文 —— 不会闪 key，也不会白屏。
 *
 * 属性文案（placeholder / aria-label 等，同样只走属性赋值，不当 HTML）：
 *      <input placeholder="找一下，比如 下课"
 *             data-i18n="decide.placeholder.librarySearch" data-i18n-attr="placeholder">
 *      <button aria-label="回到顶端" data-i18n="common.a11y.backToTop"
 *              data-i18n-aria-label="aria-label">
 *
 * 诊断：地址栏带 ?ui-debug=1 时，缺失的 key、缺失的插值参数会在控制台各警告一次，
 *       并可通过 OLText.missing() 取出。普通用户控制台保持安静。
 *
 * 分组文件里两种写法都接受，register() 按 key 形态自动分流：
 *      T.register('today', { 'today.section.tasks': '今日待办' });  // 新 key
 *      T.register('common', { '取消': '取消' });                     // 旧中文 key
 */
(function (global) {
  'use strict';

  /* 英文语义 key：小写字母开头，至少两段，段间用点分隔；段内允许 camelCase
     （today.section.tasks / today.action.hideDone / common.a11y.backToTop） */
  var NEW_KEY = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

  var groups = Object.create(null);    /* 旧结构：分组 -> 原始 map（OLText.data 形状不变） */
  var legacy = Object.create(null);    /* 旧机制：中文原文 -> 显示文字 */
  var messages = Object.create(null);  /* 新机制：英文 key -> 中文 */

  /* ---------- 注册 ---------- */

  function register(cat, group) {
    if (!group || typeof group !== 'object') return;
    /* 同一个分组的第二个 map 合并进来：分组文件可以先放旧中文 key、再放新英文 key，
       两批都保留在 OLText.data 里，不会被后一次注册覆盖掉。 */
    var bucket = groups[cat] || (groups[cat] = Object.create(null));
    Object.keys(group).forEach(function (k) {
      bucket[k] = group[k];
      if (NEW_KEY.test(k)) {
        if (!(k in messages)) messages[k] = group[k];
      } else if (!(k in legacy)) {
        legacy[k] = group[k];
      }
    });
  }

  /* ---------- 旧接口 ---------- */

  /* OLT() 调这里：中文原文进，显示文字出；没有配置就原样返回。 */
  function text(s) {
    if (typeof s !== 'string') return s;
    return (s in legacy) ? legacy[s] : s;
  }

  /* ---------- 新接口 ---------- */

  function has(key) {
    return typeof key === 'string' && (key in messages);
  }

  /* {name} 插值：只认已知参数名，undefined/null/对象一律置空，避免 [object Object] */
  function fmt(tpl, vars) {
    if (typeof tpl !== 'string') return '';
    if (!vars) return tpl;
    return tpl.replace(/\{([A-Za-z0-9_]+)\}/g, function (whole, name) {
      var v = vars[name];
      if (v === undefined || v === null) { noteMissingVar(name); return ''; }
      if (typeof v === 'object') { noteMissingVar(name); return ''; }
      return String(v);
    });
  }

  /* U(key)：纯文本。缺 key 返回空串并（调试模式）告警，绝不把 key 显示到界面上。 */
  function U(key, vars) {
    if (!(key in messages)) {
      noteMissingKey(key);
      return '';
    }
    return fmt(messages[key], vars);
  }

  var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return ESCAPES[c]; });
  }

  /* UH(key)：要拼进 HTML 字符串时用。整句（含插值结果）一起转义，
     所以配置值和参数都不可能变成标签或属性。 */
  function UH(key, vars) {
    return escapeHtml(U(key, vars));
  }

  /* ---------- 诊断（默认静默） ---------- */

  var debug = false;
  try {
    debug = typeof location !== 'undefined' && /[?&]ui-debug=1(&|$)/.test(location.search);
  } catch (e) { debug = false; }

  var missingKeys = [];
  var missingVars = [];

  function noteMissingKey(key) {
    if (missingKeys.indexOf(key) >= 0) return;
    missingKeys.push(key);
    if (debug && typeof console !== 'undefined' && console.warn) {
      console.warn('[ui-text] 缺少文案 key：' + key);
    }
  }

  function noteMissingVar(name) {
    if (missingVars.indexOf(name) >= 0) return;
    missingVars.push(name);
    if (debug && typeof console !== 'undefined' && console.warn) {
      console.warn('[ui-text] 缺少插值参数：{' + name + '}');
    }
  }

  /* ---------- DOM 替换（只处理静态 HTML；动态节点由 U() 负责） ----------
   * 时序：config/* 是 <body> 末尾的第一组脚本，执行时页面标记已经全部解析完，
   * 而 boot.js 要到更后面才 renderAll()。所以这里在脚本加载时立刻替换一次，
   * 而不是等 DOMContentLoaded —— 否则会把 JS 已经写好的动态文字（例如
   * 「加载更早的记录（还有 3 天）」）盖回静态文案。
   * WeakSet 记录已处理的元素：之后的 DOMContentLoaded 补跑是幂等的，
   * 已经被 JS 改过、或已替换过的节点不会被二次覆盖。 */

  var applied = (typeof WeakSet === 'function') ? new WeakSet() : null;

  function targetAttrs(el) {
    var list = [];
    var attrs = el.attributes || [];
    for (var i = 0; i < attrs.length; i++) {
      var name = attrs[i].name;
      if (name === 'data-i18n') continue;
      if (name === 'data-i18n-attr') {
        attrs[i].value.split(/[,\s]+/).forEach(function (a) { if (a) list.push(a); });
        continue;
      }
      if (name.indexOf('data-i18n-') === 0) list.push(name.slice('data-i18n-'.length));
    }
    return list;
  }

  /* 元素里还有子标签时，只替换第一段纯文本，保留 <b> 之类的结构 */
  function replaceFirstTextNode(el, value) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && n.nodeValue.replace(/^\s+|\s+$/g, '') !== '') {
        n.nodeValue = value;
        return true;
      }
    }
    return false;
  }

  function replaceText(el, value) {
    if (el.children && el.children.length) return replaceFirstTextNode(el, value);
    if (el.textContent === value) return false;
    el.textContent = value;              /* 只赋文本，不碰 innerHTML */
    return true;
  }

  function applyDom(root) {
    var scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
    var nodes = scope.querySelectorAll('[data-i18n]');
    var changed = 0;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute && el.getAttribute('data-i18n');
      if (!key) continue;
      if (applied && applied.has(el)) continue;      /* 只替换一次，之后交给 JS */

      var value = null;
      if (key in messages) value = messages[key];
      else if (key in legacy) value = legacy[key];
      else { noteMissingKey(key); continue; }   /* 查不到就保留 HTML 原文 */

      if (applied) applied.add(el);

      /* 纯属性元素（input）没有文本可换，跳过文本赋值 */
      var isInput = el.tagName === 'INPUT';
      if (!isInput && replaceText(el, value)) changed++;

      var attrs = targetAttrs(el);
      for (var j = 0; j < attrs.length; j++) {
        if (el.getAttribute(attrs[j]) !== value) {
          el.setAttribute(attrs[j], value);    /* 属性赋值，不当 HTML 解析 */
          changed++;
        }
      }
    }
    return changed;
  }

  global.OLText = {
    data: groups,
    flat: legacy,
    messages: messages,
    register: register,
    text: text,
    has: has,
    U: U,
    UH: UH,
    fmt: fmt,
    escapeHtml: escapeHtml,
    applyDom: applyDom,
    missing: function () { return { keys: missingKeys.slice(), vars: missingVars.slice() }; },
    isDebug: function () { return debug; }
  };

  /* 业务代码直接用 U()/UH()，不必每次写 OLText.U */
  global.U = U;
  global.UH = UH;

  function bootApply() {
    try { applyDom(document); } catch (e) { /* 文案问题绝不影响启动 */ }
  }

  /* 立刻执行一次（此时 body 标记已解析完、业务脚本还没跑）；
     DOMContentLoaded 再补一次，覆盖极端情况下后插入的静态节点。 */
  if (typeof document !== 'undefined') {
    bootApply();
    if (document.readyState === 'loading' && document.addEventListener) {
      document.addEventListener('DOMContentLoaded', bootApply);
    }
  }
})(window);
