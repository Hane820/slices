/* config/records.js — 记录页与 PDF */
/* 改右边的文字即可；左边是定位用的原文，不要改。 */
(function(){
  var T = window.OLText;
  if(!T || typeof T.register !== "function") return;

  T.register('records', {
    '切换 ▾': '切换 ▾',
    '多': '多',
    '少': '少',
    '手账': '手账',
    '近两周还没有记录。': '近两周还没有记录。',
    '还没有记录。勾一个待办、写两句话，这里就会出现。': '还没有记录。勾一个待办、写两句话，这里就会出现。',
    '那天': '那天',
  });
})();
