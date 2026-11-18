/* config/index.js — 地球online 文案配置入口（基础设施）
 * ============================================================================
 * 这是「固定界面文案」的唯一来源。想改界面上的字，编辑同目录的分组文件即可，
 * 改完刷新页面生效，不用碰业务代码，也不用重新构建。
 *
 * 目录结构（按功能分组，找起来快）：
 *   common.js      通用词、导航、页脚
 *   home.js        首页（待办 / 重点 / 日程 / 随手记）
 *   decision.js    决策页
 *   records.js     记录页
 *   settings.js    设置页
 *   diet.js        饮食记录
 *   backup.js      备份 / 配置文件导入导出
 *   messages.js    操作反馈、空状态、错误、弹窗
 *   plugins.js     插件名称与说明
 *   writer.js      本地库连接 / 只读横幅
 *
 * 文件里都是「原文: 显示文字」。左边是程序里原来的字（用来定位，别改），
 * 右边是屏幕上真正显示的（想改就改这里）。
 *
 * 技术约定（不用关心，保证不会出错）：
 * - 配置缺失或不加载时，程序自动显示原文，不会崩、不影响离线运行。
 * - 用户数据（情景、标签、笔记、饮食记录）和偏好（主题、重置时间等）仍在
 *   IndexedDB 里，不放这里。
 */
(function (global) {
  'use strict';

  var data = Object.create(null);
  var flat = Object.create(null);

  /* 分组文件调用：OLText.register('common', { ... }) */
  function register(cat, group) {
    if (!group || typeof group !== 'object') return;
    data[cat] = group;
    Object.keys(group).forEach(function (k) {
      if (!(k in flat)) flat[k] = group[k];
    });
  }

  /* t(原文)：查到配置就返回显示文字，查不到原样返回。core.js 的 OLT() 调它。 */
  function text(s) {
    if (typeof s !== 'string') return s;
    return (s in flat) ? flat[s] : s;
  }

  /* 把页面里标了 data-i18n 的静态文字换成配置文字（只动自己的第一个文本节点）。 */
  function applyDom(root) {
    var scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
    var nodes = scope.querySelectorAll('[data-i18n]');
    var changed = 0;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute && el.getAttribute('data-i18n');
      if (!key || !(key in flat)) continue;
      var val = flat[key];
      if (val === key) continue;
      for (var j = 0; j < el.childNodes.length; j++) {
        var n = el.childNodes[j];
        if (n.nodeType === 3 && n.nodeValue.replace(/^\s+|\s+$/g, '') === key) {
          n.nodeValue = n.nodeValue.replace(key, val);
          changed++;
          break;
        }
      }
    }
    return changed;
  }

  global.OLText = {
    data: data,
    flat: flat,
    register: register,
    text: text,
    applyDom: applyDom
  };

  function bootApply() {
    try { applyDom(document); } catch (e) { /* 配置问题绝不影响启动 */ }
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bootApply);
    } else {
      bootApply();
    }
  }
})(window);
