/* config/pdf.js — PDF 报告预览条（#printView 顶部）
 * 左边是语义 key（不要改），右边是屏幕上显示的文字（要改就改这里）。
 * 第一批只登记预览条；报告正文的 pdf.* 文案在批次六随 core.js 一起迁入。 */
(function(){
  var T = window.OLText;
  if(!T || typeof T.register !== "function") return;

  T.register('pdf', {
    'pdf.bar.hint': '打印预览 · 在打印窗口选「存储为 PDF」',
    'pdf.bar.print': '打印 / 存 PDF',
  });
})();
