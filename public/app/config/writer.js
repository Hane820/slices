/* config/writer.js — 本地库连接 / 只读横幅 */
/* 改右边的文字即可；左边是定位用的原文，不要改。 */
(function(){
  var T = window.OLText;
  if(!T || typeof T.register !== "function") return;

  T.register('writer', {
  });
})();
