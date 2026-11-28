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
    'today.section.recent': '最近',
    'today.action.writeNote': '写手账',
    'today.action.allRecords': '全部记录',
    'today.section.flash': '灵光一闪',
    'today.hint.flash': '随手写，松手自动存',
    'today.action.saveFlash': '记下来',
  });

  /* ===== 英文语义 key · 今日页（第二批迁移：JS 渲染文案） ===== */
  T.register('today', {
    'today.empty.tasksExpand': '点一下展开，回到今天的事',
    'today.empty.focusEmpty': '今日重点都删掉了，去设置里加一条。',
    'today.empty.planEmpty': '还没有定过计划。选好日期，在下面输入一行就行。',
    'today.label.dueToday': '今天到期',
    'today.remind.planPrefix': '今天的安排：',
    'today.action.goPlanShort': '去计划',
    'today.card.tasks': '待办事项',
    'today.empty.tasks': '还没有待办，点下面加一条。',
    'today.placeholder.task': '要做什么',
    'today.empty.recordsEmpty': '还没有记录。勾掉一条待办，这里就有痕迹了。',
  });
})();
