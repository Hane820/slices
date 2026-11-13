/* boot.js — renderAll + 事件绑定 + 启动 */
function applyUiScale(){
  document.documentElement.style.setProperty('--ui-scale', String(S.settings.uiScale || 1.12));
}
function renderAll(){
  applyUiScale();
  renderScenes();
  renderToday();
  renderLib();
  renderRecords();
  renderSettings();
  rvRefresh();
}

/* ==================== 事件绑定 ==================== */
bindOnce($('nav'), 'click', function(e){
  var b = e.target.closest('button');
  if(b) showPage(b.dataset.page);
});

$('addSch').addEventListener('click', openSchCreate);
var itemAddEl = $('itemAdd');
if(itemAddEl) itemAddEl.addEventListener('click', itemAddLog);
var itemCurEl = $('itemCur');
if(itemCurEl) itemCurEl.addEventListener('click', openItemPicker);
$('writeNote').addEventListener('click', function(){ openNote(TODAY()); });
$('goRecords').addEventListener('click', function(){ showPage('pRecords'); });

// 今日页
var goPlanEl = $('goPlanSec');
if(goPlanEl) goPlanEl.addEventListener('click', openPlanView);
// 灵光一闪：输入停顿后自动存
(function(){
  var ta = $('flashTa');
  if(!ta) return;
  ta.addEventListener('input', function(){
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function(){ saveFlash(); }, 900);
  });
  ta.addEventListener('blur', function(){ clearTimeout(flashTimer); saveFlash(); });
  $('flashSave').addEventListener('click', function(){
    clearTimeout(flashTimer);
    var had = ($('flashTa').value || '').trim();
    saveFlash();
    // 灵光一闪会进时间轴：飞一个小点到「记录」做引导
    if(had && typeof flyDot === 'function'){
      var navBtn = document.querySelector('.nav button[data-page="pRecords"]');
      if(navBtn){
        flyDot($('flashSave'), navBtn, function(){
          navBtn.classList.add('pulse');
          setTimeout(function(){ navBtn.classList.remove('pulse'); }, 620);
        });
      }
    }
    toast('记好了，时间轴里能看到');
  });
})();

// 决策页
$('randBtn').addEventListener('click', runRandom);
$('randFilterBtn').addEventListener('click', function(){
  var cats = ['全部','待办'].concat(libCats());
  var body = openSheet(
    '<div class="shd"><div class="shd-t">只从这个类型里抽</div></div>' +
    '<div class="chips" id="rfBox" style="margin-bottom:16px"></div>' +
    '<div class="acts"><button class="btn g" id="rfNo">关掉</button></div>'
  );
  var box = body.querySelector('#rfBox');
  cats.forEach(function(c){
    var b = el('button','chip' + (S.settings.randFilter === c ? ' on' : ''), c);
    b.addEventListener('click', function(){
      S.settings.randFilter = c; save();
      $('randFilterBtn').textContent = c === '全部' ? '全部类型' : c;
      closeSheet(); runRandom();
    });
    box.appendChild(b);
  });
  body.querySelector('#rfNo').addEventListener('click', closeSheet);
});
$('addLib').addEventListener('click', function(){ openSuggEdit(null); });
$('libSearch').addEventListener('input', function(){
  libQuery = this.value;
  libOpen = false;
  renderLib();
});

// 计划页
bindOnce($('planAddBtn'), 'click', addPlan);
bindOnce($('planInput'), 'keydown', function(e){
  if(e.key === 'Enter'){ e.preventDefault(); addPlan(); }
});
$('planToggleDone').addEventListener('click', function(){
  planShowDone = !planShowDone; renderPlan();
});

// PDF
$('pdfBtn').addEventListener('click', openPdfPanel);

// 回到顶端
(function(){
  var b = $('toTop');
  if(!b) return;
  b.addEventListener('click', function(){ window.scrollTo({ top: 0, behavior: 'smooth' }); });
  function upd(){ b.classList.toggle('on', window.scrollY > window.innerHeight * 0.6); }
  window.addEventListener('scroll', upd, { passive: true });
  setInterval(upd, 500);
  upd();
})();
$('pvClose').addEventListener('click', closePdf);
$('pvPrint').addEventListener('click', function(){ window.print(); });

// 记录页
$('recSeg').addEventListener('click', function(e){
  var b = e.target.closest('button');
  if(!b) return;
  if(b.dataset.v === 'item' && recordView === 'item'){ openItemPicker(); return; }
  recordView = b.dataset.v;
  renderRecords();
});
$('tlMore').addEventListener('click', function(){
  tlCount += 7;
  renderTimeline();
});
$('prevM').addEventListener('click', function(){ vm--; if(vm < 0){ vm = 11; vy--; } renderMonth(true); });
$('nextM').addEventListener('click', function(){ vm++; if(vm > 11){ vm = 0; vy++; } renderMonth(true); });
$('thisM').addEventListener('click', function(){
  var n = new Date(); vy = n.getFullYear(); vm = n.getMonth(); renderMonth(true);
});

// 设置页
$('addPen').addEventListener('click', function(){ openPenEdit(null); });
$('addTag').addEventListener('click', function(){
  openModal({
    title:'新建标签', sub:'点一下记一次，用来数频率', input:true, placeholder:'比如「晒了太阳」', okText:'加上',
    onOk:function(v){
      S.tags.push({ id: uid('tag'), name:v });
      save(); renderSettings(); toast('标签已加上');
    }
  });
});

// 遮罩关闭
bindOnce($('mask'), 'click', function(e){ if(e.target === $('mask')) closeSheet(); });
bindOnce($('modalMask'), 'click', function(e){
  if(e.target === $('modalMask') && !(modalCfg && modalCfg.lock)) closeModal();
});
bindOnce($('mCancel'), 'click', closeModal);
bindOnce($('mOk'), 'click', function(){
  var v = modalInput ? modalInput.value.trim() : null;
  if(modalCfg && modalCfg.input && !v){ toast('写点东西吧'); return; }
  var cb = modalCfg && modalCfg.onOk;
  closeModal();
  if(cb) cb(v);
});
/* Esc 关弹窗：绑在 document 上，键盘事件从焦点元素一路冒泡到这里 */
if(!window.__escBound){
  window.__escBound = 1;
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape'){ closeModal(); closeSheet(); closePdf(); }
  });
}

/* ==================== 启动 ==================== */
loadState();
normalize();
applyTheme();
save();
renderHeader();
renderAll();
bindAppActions();
$('randFilterBtn').textContent = S.settings.randFilter === '全部' ? '全部类型' : S.settings.randFilter;

if(migrated){
  setTimeout(function(){ toast('已把旧版记录搬过来'); }, 800);
}else if(!allRecordDates().length){
  setTimeout(function(){ toast('先勾掉一件小事试试'); }, 1000);
}

