/* config/decision.js — 决策页 */
/* 改右边的文字即可；左边是定位用的原文，不要改。 */
(function(){
  var T = window.OLText;
  if(!T || typeof T.register !== "function") return;

  T.register('decide', {
    '管理情景': '管理情景',
    '完成': '完成',
    '自定义': '自定义',
    '还没有情景': '还没有情景',
    '新建情景': '新建情景',
    '系统': '系统',
    '停用': '停用',
    '编辑': '编辑',
    '不参与随机': '不参与随机',
    '今天吃了': '今天吃了',
    '加入待办': '加入待办',
    '就吃这个': '就吃这个',
    '换一个': '换一个',
    '现在开始': '现在开始',
    '这个情境下还没有建议，或者今天都做过了。到建议库新建一条，勾上这个情境就行。': '这个情境下还没有建议，或者今天都做过了。到建议库新建一条，勾上这个情境就行。',
    '随机抽到': '随机抽到',
  });

  /* ===== 英文语义 key · 决策页 / 吃什么（第一批迁移：index.html 静态文案） ===== */
  T.register('decide', {
    'decide.action.backToday': '← 返回今日',
    'decide.page.title': '现在做什么',
    'decide.page.subtitle': '想不清楚的时候，让它替你挑一件。',
    'decide.tab.do': '做什么',
    'decide.tab.eat': '吃什么',
    'decide.section.scene': '你现在是什么情况',
    'decide.action.customScene': '自定义',
    'decide.action.random': '随便抽一件',
    'decide.action.filterAll': '全部类型',
    'decide.section.library': '建议库',
    'decide.placeholder.librarySearch': '找一下，比如 下课',
    'decide.hint.library': '每条建议可以绑几个情境，选了才会出现在上面。开关决定它参不参与随机抽取。',
    'decide.section.eatScene': '现在这个饭点，想吃什么',
    'decide.action.randomEat': '随便抽一个',
    'decide.section.menu': '我的菜单',
    'decide.hint.menu': '每道菜可以勾几个饭点，抽的时候只从对得上的里出。今天已经记过的先跳过，都吃过了才会重复。',
  });
})();
