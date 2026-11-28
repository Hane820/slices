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

  /* ===== 英文语义 key · 记录 / 月历 / 时间轴（第一批迁移：index.html 静态文案） ===== */
  T.register('records', {
    'records.page.title': '生活记录',
    'records.page.subtitle': '往前是计划，往后是记录。',
    'records.empty.main': '还没有记录。勾一个待办、写两句话，这里就会出现。',
    'records.empty.recent': '近两周还没有记录。',
    'records.label.thatDay': '那天',
    'records.label.note': '手账',
    'records.legend.less': '少',
    'records.legend.more': '多',
    'records.action.toggle': '切换 ▾',
    'records.action.exportPdf': '导出 PDF ↗',
    'records.tab.plan': '计划',
    'records.tab.timeline': '时间轴',
    'records.tab.month': '月历',
    'records.tab.item': '项目',
    'records.tab.diet': '饮食',
    'records.field.date': '给哪一天',
    'records.placeholder.planInput': '那天要做什么',
    'records.section.plans': '定好的事',
    'records.action.loadMore': '加载更早的记录',
    'records.action.thisMonth': '今',
    'records.hint.heatLegend': '颜色越深，那天记的东西越多。点上面的类型可以只看某几类。',
    'records.section.heatmap': '热力图',
    'records.hint.mark': '点日期可以标记这一天，也能看到那天做了什么。',
    'records.filter.recent2w': '近两周',
    'records.section.recent': '最近',
  });
})();
