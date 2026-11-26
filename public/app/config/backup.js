/* config/backup.js — 备份与配置文件 */
/* 改右边的文字即可；左边是定位用的原文，不要改。 */
(function(){
  var T = window.OLText;
  if(!T || typeof T.register !== "function") return;

  T.register('backup', {
    '导出 PDF ↗': '导出 PDF ↗',
    '数据只存在这个浏览器里。清缓存、换设备或误删都可能丢掉，建议偶尔导出一次备份。': '数据只存在这个浏览器里。清缓存、换设备或误删都可能丢掉，建议偶尔导出一次备份。',
  });
})();
