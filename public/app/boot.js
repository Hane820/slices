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

/* ==================== 启动（Step 5A：IndexedDB 读取接入） ==================== */
/* 编排：打开库 → 查迁移状态 → 未迁移先迁移 → 已迁移从六表读回
   → 合并 legacyExtras → normalize → 渲染。
   业务写入仍走旧 save()（localStorage），租约写事务属 Step 5B：
   本阶段在 idb 模式下不调用 save()，normalize 的变化不落库，只标记。 */
var OLBoot = { mode: 'legacy', booted: false, normalizeChanged: false, blocked: false };

/* 启动阻断屏：数据库打不开 / 迁移受阻时，停止正常启动并给出明确信息。
   绝不静默退回 localStorage 继续写（两个数据源会分叉）。 */
function bootBlocked(title, detail){
  if(OLBoot.blocked || OLBoot.booted) return;
  OLBoot.blocked = true;
  console.error('[boot] ' + title + '：' + (detail || ''));
  var ov = document.createElement('div');
  ov.className = 'boot-block';
  ov.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:9999;'
    + 'background:#f6f5f0;color:#191918;display:flex;align-items:center;justify-content:center;padding:2rem;';
  var card = document.createElement('div');
  card.style.cssText = 'max-width:30rem;border:1px solid #d8d6cc;padding:2rem 2.2rem;background:#f6f5f0;';
  var h = document.createElement('h2');
  h.style.cssText = 'margin:0 0 .8rem;font-size:1.4rem;letter-spacing:-.02em;';
  h.textContent = title;
  var p = document.createElement('p');
  p.style.cssText = 'margin:0 0 1.4rem;color:#77766f;font-size:.92rem;line-height:1.6;word-break:break-all;';
  p.textContent = detail || '';
  var b = document.createElement('button');
  b.textContent = '刷新重试';
  b.style.cssText = 'padding:.6rem 1.2rem;border:1px solid #191918;background:none;color:#191918;cursor:pointer;font:inherit;';
  b.addEventListener('click', function(){ location.reload(); });
  card.appendChild(h); card.appendChild(p); card.appendChild(b);
  ov.appendChild(card);
  document.body.appendChild(ov);
}

/* legacyExtras 合并：未知顶层字段原键原值放回 S；__proto__ 走 defineOwn，
   已知业务字段一律不覆盖 */
function mergeRehydrated(rep){
  var base = defaults();
  deepMerge(base, rep.data);
  if(rep.extras && Array.isArray(rep.extras.keys) && rep.extras.keys.length){
    var val = rep.extras.value || {};
    for(var i = 0; i < rep.extras.keys.length; i++){
      var k = rep.extras.keys[i];
      if(!hasOwn(base, k)) defineOwn(base, k, val[k]);
    }
  }
  S = base;
  /* normalize 前后比对：有变化只标记（内存中的数据是新的），
     落库必须等 Step 5B 的租约写事务，这里不得直接写 */
  var before = '';
  try { before = JSON.stringify(S); } catch (e) {}
  normalize();
  try { OLBoot.normalizeChanged = JSON.stringify(S) !== before; } catch (e) { OLBoot.normalizeChanged = true; }
  if(OLBoot.normalizeChanged){
    console.info('[boot] normalize 改动了业务数据；本阶段不持久化，刷新后重新计算，落库属 Step 5B');
  }
}

function finishBoot(){
  applyTheme();
  renderHeader();
  renderAll();
  bindAppActions();
  $('randFilterBtn').textContent = S.settings.randFilter === '全部' ? '全部类型' : S.settings.randFilter;
  if(migrated){
    setTimeout(function(){ toast('已把旧版记录搬过来'); }, 800);
  }else if(!allRecordDates().length){
    setTimeout(function(){ toast('先勾掉一件小事试试'); }, 1000);
  }
  OLBoot.booted = true;
}

/* 旧路径：未迁移 / 无 IndexedDB / 全新用户。localStorage 仍是唯一真相 */
function bootLegacy(){
  OLBoot.mode = 'legacy';
  loadState();
  normalize();
  save();
  finishBoot();
}

function bootFromIdb(){
  OLMigrate.rehydrate().then(function(rep){
    if(OLBoot.blocked) return;
    if(!rep.ok){ bootBlocked('读取数据库失败', rep.message || rep.reason); return; }
    OLBoot.mode = 'idb';
    OLBoot.readMeta = rep.meta;
    mergeRehydrated(rep);
    finishBoot();
    showReadOnlyBanner();
  }, function(e){
    bootBlocked('读取数据库失败', (e && e.message) || String(e));
  });
}

/* 只读横幅：idb 模式下业务写入还没接入，常驻提示，避免「显示成功其实没保存」的误解 */
function showReadOnlyBanner(){
  if(document.getElementById('ol-readonly-bar')) return;
  var bar = document.createElement('div');
  bar.id = 'ol-readonly-bar';
  bar.setAttribute('role', 'status');
  bar.style.cssText = 'position:fixed;left:0;top:0;right:0;z-index:55;'
    + 'background:rgba(246,245,240,.94);color:#77766f;border-bottom:1px solid #d8d6cc;'
    + 'font:400 12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;'
    + 'letter-spacing:.04em;text-align:center;padding:6px 12px;pointer-events:none;';
  bar.textContent = '只读模式 · 数据已迁移到本地库，写入功能尚未接入，改动不会保存';
  document.body.appendChild(bar);
}

/* 另一标签页迁移中：轮询等待（迁移租约 20s + 心跳，40s 封顶） */
function waitMigration(){
  var tries = 0;
  (function poll(){
    OLMigrate.status().then(function(st){
      if(OLBoot.blocked || OLBoot.booted) return;
      if(st.mode === 'idb'){ bootFromIdb(); return; }
      if(st.mode === 'failed'){ bootBlocked('另一窗口迁移失败', '请稍后刷新重试'); return; }
      if(++tries > 40){ bootBlocked('等待迁移超时', '另一个窗口的迁移长时间未完成，请刷新重试'); return; }
      setTimeout(poll, 1000);
    }, function(){
      if(++tries > 40){ bootBlocked('等待迁移超时', '无法读取迁移状态'); return; }
      setTimeout(poll, 1000);
    });
  })();
}

/* 走一次真实迁移（run 内部先干跑，干跑不过不会写入）。失败即阻断，不退回旧路径 */
function tryMigrate(){
  OLMigrate.run({ confirm: true }).then(function(r){
    if(OLBoot.blocked || OLBoot.booted) return;
    if(r.ok){ bootFromIdb(); return; }
    if(r.reason === 'migration-busy'){ waitMigration(); return; }
    bootBlocked('数据迁移未完成',
      (r.reason || '') + (r.message ? '：' + r.message : '') +
      (r.blocked && r.blocked.length ? '｜原因 ' + r.blocked[0].code : ''));
  }, function(e){
    bootBlocked('数据迁移未完成', (e && e.message) || String(e));
  });
}

function startBoot(){
  /* 连 IndexedDB 都没有的旧浏览器：没有迁移目标，旧路径继续可用 */
  if(!window.OLDB || !OLDB.isSupported || !OLDB.isSupported()){
    bootLegacy();
    return;
  }
  OLDB.open().then(function(){
    return OLMigrate.status();
  }).then(function(st){
    if(OLBoot.blocked || OLBoot.booted) return;
    OLBoot.statusAtBoot = st;
    if(st.mode === 'idb'){ bootFromIdb(); return; }
    if(st.mode === 'in_progress'){ waitMigration(); return; }
    if(st.mode === 'failed'){ tryMigrate(); return; }   /* attempts<5 自动重试 */
    if(st.mode === 'unavailable'){ bootBlocked('数据库状态不可读', st.error || st.mode); return; }
    /* ls / unmigrated / unknown：库里没数据也没有旧数据 = 全新用户 */
    var markerDone = !!(st.marker && st.marker.state === 'done');
    var hasOld = false;
    try { hasOld = !!localStorage.getItem(KEY); } catch (e) {}
    if(!markerDone && !hasOld){ bootLegacy(); return; }
    tryMigrate();
  }, function(e){
    /* 打开失败：高版本占用 / 结构异常 / 被阻塞 —— 停止启动，不动任何数据 */
    bootBlocked('数据库无法打开', ((e && e.code) || '') + ((e && e.message) ? '：' + e.message : ''));
  });
}

startBoot();

