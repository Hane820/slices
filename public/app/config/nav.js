/* config/nav.js — 导航（底部四个入口）
 * 左边是语义 key（不要改），右边是屏幕上显示的文字（要改就改这里）。
 * 新增于「静态 UI 文案中心」第一批迁移；与 toast-text.js 无任何关系。 */
(function(){
  var T = window.OLText;
  if(!T || typeof T.register !== "function") return;

  T.register('nav', {
    'nav.today': '今日',
    'nav.decide': '决策',
    'nav.records': '记录',
    'nav.settings': '设置',
  });
})();
