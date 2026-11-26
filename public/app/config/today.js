/* config/today.js — 今日页（分区标题、入口按钮、激励文案）
 * 左边是语义 key（不要改），右边是屏幕上显示的文字（要改就改这里）。
 * 第一批只登记 index.html 里用到的 key；批次三里 JS 渲染的文案再往这里补。
 * 旧的 config/home.js 仍按中文 key 管理首页其余文案，等批次三统一并入本文件。 */
(function(){
  var T = window.OLText;
  if(!T || typeof T.register !== "function") return;

  T.register('today', {
    'today.greeting.morning': '早上好',
    'today.section.tasks': '今日待办',
    'today.action.hideDone': '隐藏已完成',
    'today.section.focus': '今日重点',
    'today.section.schedule': '今天的安排',
    'today.section.decideDo': '不知道做什么',
    'today.action.goDecide': '帮你决策 →',
    'today.section.decideEat': '不知道吃什么',
    'today.action.goEat': '帮我选 →',
    'today.section.upcoming': '接下来',
    'today.action.goPlan': '去计划 ↗',
    'today.section.recent': '最近',
    'today.action.writeNote': '写手账',
    'today.action.allRecords': '全部记录',
    'today.section.flash': '灵光一闪',
    'today.hint.flash': '随手写，松手自动存',
    'today.action.saveFlash': '记下来',
  });
})();
