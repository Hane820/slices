/* config/messages.js — 已迁移到 toast-text.js
 *
 * 原来本文件集中管理 Toast 操作反馈文案。
 * 现已全部迁移到同目录的 toast-text.js（唯一可编辑数据源），
 * 该文件还额外提供 {name}/{minutes} 等占位符模板，业务代码不再拼接固定文字。
 *
 * 要改 Toast 提示文字，请编辑 config/toast-text.js，不要改这里。
 * 本文件保留为空壳，仅为兼容既有的 config 加载顺序；不影响任何功能。
 */
(function(){
  var T = window.OLText;
  if(!T || typeof T.register !== "function") return;
  T.register('messages', {});
})();
