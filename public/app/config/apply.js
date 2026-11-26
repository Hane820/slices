/* config/apply.js — 首次 DOM 文案替换
 * ============================================================================
 * 为什么单独一个文件：
 *   分组文案是同步脚本，注册完成是确定的事实；但 index.js 执行时注册表还是空的。
 *   如果把替换写在 index.js 里，就会出现「空注册表先跑一遍」——93 个节点全部落空、
 *   89 个真实 key 被误报成缺失，而且这批节点没进 WeakSet，
 *   等到 DOMContentLoaded 再跑时反而会把 boot 已经写好的动态文字盖回静态文案。
 *   所以替换放在「所有分组注册完之后」这个确定的位置上，不靠 setTimeout 猜时序。
 *
 * 位置要求：
 *   必须排在 index.html 里所有 config/*.js 之后（最后一个分组是 writer.js），
 *   且在 core.js / boot.js 之前。检查脚本会校验这个顺序。
 *
 * 幂等：
 *   applyDom 内部用 WeakSet 标记「已成功替换」的节点，DOMContentLoaded 的补跑
 *   只处理新增节点，不会覆盖业务 JS 写入的动态文字。
 */
(function (global) {
  var T = global.OLText;
  if (!T || typeof T.applyDom !== 'function') return;

  function pass(where) {
    try {
      T.applyDom(document);
    } catch (e) {
      /* 文案问题绝不影响启动；但不静默 —— 调试模式下留一条痕迹 */
      if (typeof console !== 'undefined' && console.warn &&
          typeof T.isDebug === 'function' && T.isDebug()) {
        console.warn('[ui-text] applyDom 失败（' + where + '）：' + (e && e.message ? e.message : e));
      }
    }
  }

  pass('boot');

  /* 兜底补跑：正常情况下此时全页已是替换后的文本，补跑不会再改动任何节点；
     只有「替换之后才出现的静态节点」（例如服务端注入的片段）会被补上。 */
  if (typeof document !== 'undefined' && document.readyState === 'loading' &&
      typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', function () { pass('dom-ready'); });
  }
})(window);
