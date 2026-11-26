/* config/diet.js — 饮食记录 */
/* 改右边的文字即可；左边是定位用的原文，不要改。 */
(function(){
  var T = window.OLText;
  if(!T || typeof T.register !== "function") return;

  T.register('diet', {
    '今天的记录见上面「今日饮食」，同样可以编辑删除。': '今天的记录见上面「今日饮食」，同样可以编辑删除。',
  });
})();
