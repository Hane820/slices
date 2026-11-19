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
    toast(OLT('记好了，时间轴里能看到'));
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

// 吃什么：分段切换 / 抽一个 / 新建一道菜
if($('decSeg')){
  $('decSeg').addEventListener('click', function(e){
    var b = e.target.closest('button');
    if(b) switchDecideTab(b.dataset.tab);
  });
}
if($('eatRandBtn')) $('eatRandBtn').addEventListener('click', runEatPick);
if($('eatAdd')) $('eatAdd').addEventListener('click', function(){ openFoodEdit(null); });

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
      save(function(){ toast(OLT('标签已加上')); }); renderSettings();
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
  if(modalCfg && modalCfg.input && !v){ toast(OLT('写点东西吧')); return; }
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
   Step 5B-3：业务 save() 已接入 OLCommitQueue；idb 模式下只有 bootWriter
   完整成功（acquire + heartbeat + 受控开放写入）后才允许业务提交，
   任何初始化失败都保持 readOnly，normalize 的变化仍只标记不落库。 */
var OLBoot = { mode: 'legacy', booted: false, normalizeChanged: false, blocked: false,
  /* Step 5B-1：writer 生命周期基础接入的可观测状态（只读诊断，不构成写入授权）。
     acquired/heartbeat 是【派生快照】：读取时实时从 OLWrite 的真实租约状态计算，
     心跳失败 / versionchange 失权后自动变 false，绝不停留在历史获取结果。
     真实写入权一律以 OLWrite.hasWriterLease()/writerLost() 为准；wired 恒 false。 */
  writer: null };
/* writer 状态：acquired/heartbeat 为 getter（实时派生），code/ownerId/epoch 为最近一次获取结果诊断。 */
(function initWriterState(){
  var st = { code:'not-started', ownerId:null, epoch:null, _started:false };
  Object.defineProperty(st, 'acquired', {
    enumerable:true, configurable:false,
    get: function(){
      return !!(window.OLWrite && typeof OLWrite.hasWriterLease==='function' && OLWrite.hasWriterLease());
    }
  });
  Object.defineProperty(st, 'heartbeat', {
    enumerable:true, configurable:false,
    get: function(){
      /* write.js 心跳失败/失权都会 clearHeartbeatTimer + HELD=null/LOST=true；
         故"心跳在运行"等价于"当前持有且未失权"，无法从历史赋值推断。 */
      return !!(window.OLWrite && typeof OLWrite.hasWriterLease==='function'
                && OLWrite.hasWriterLease()
                && typeof OLWrite.writerLost==='function' && !OLWrite.writerLost());
    }
  });
  OLBoot.writer = st;
})();

/* 启动阻断屏：数据库打不开 / 迁移受阻时，停止正常启动并给出明确信息。
   绝不静默退回 localStorage 继续写（两个数据源会分叉）。 */
function bootBlocked(title, detail){
  if(OLBoot.blocked || OLBoot.booted) return;
  OLBoot.blocked = true;
  console.error('[boot] ' + title + '：' + (detail || ''));
  var ov = document.createElement('div');
  ov.className = 'boot-block';
  ov.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:9999;'
    + 'background:var(--paper2);color:var(--ink);display:flex;align-items:center;justify-content:center;padding:2rem;';
  var card = document.createElement('div');
  card.style.cssText = 'max-width:30rem;border:1px solid var(--line);padding:2rem 2.2rem;background:var(--paper);';
  var h = document.createElement('h2');
  h.style.cssText = 'margin:0 0 .8rem;font-size:1.4rem;letter-spacing:-.02em;';
  h.textContent = title;
  var p = document.createElement('p');
  p.style.cssText = 'margin:0 0 1.4rem;color:var(--ink2);font-size:.92rem;line-height:1.6;word-break:break-all;';
  p.textContent = detail || '';
  var b = document.createElement('button');
  b.textContent = '刷新重试';
  b.style.cssText = 'padding:.6rem 1.2rem;border:1px solid var(--ink);background:none;color:var(--ink);cursor:pointer;font:inherit;';
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
    setTimeout(function(){ toast(OLT('已把旧版记录搬过来')); }, 800);
  }else if(!allRecordDates().length){
    setTimeout(function(){ toast(OLT('先勾掉一件小事试试')); }, 1000);
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

/* Step 5B-1 / 5B-3 / 5B-5：writer 生命周期接入 + 写入受控开放 + 有限退避重试
   - 取权走 acquireWriterWithRetry（1s/2s/4s），每轮绑定轮次令牌与页面生命周期代次；
     pagehide / versionchange / 再次点击重试都会让旧轮次结果作废，绝不延迟激活；
   - acquire 成功 → 设置 HELD/LOST=false，再启动心跳续期；心跳失败 / DB 不可用 →
     write.js 内部统一失权收口（清 HELD、关 WIRED、记原因），本函数只记录可观测状态；
   - 只有 acquire + heartbeat 都成功后，才调用 OLWrite.activateWrites() 受控开放业务写入；
   - 失败时保持 wired=false、status().readOnly=true，横幅显示原因并提供「重试」按钮；
   - 运行期 writer 失权由队列 fatal 触发横幅重新出现，手动重试时先重建内存再恢复队列。 */
function bootWriter(){
  if(OLBoot.blocked){
    OLBoot.writer.code = 'boot-blocked';
    return Promise.resolve({ ok:false, code:'boot-blocked' });
  }
  /* write.js 未加载 / 依赖不全：失败关闭，保持只读，不误报可写 */
  if(!window.OLWrite || typeof OLWrite.acquireWriterWithRetry !== 'function'){
    OLBoot.writer.code = 'write-module-missing';
    OLBoot.writer.writeState = 'write-module-missing';
    if(typeof setWriterBanner === 'function') setWriterBanner('写入模块不可用 · 当前只读', false);
    return Promise.resolve({ ok:false, code:'write-module-missing' });
  }
  var w = OLBoot.writer;
  /* 轮次令牌：任何一次新的 bootWriter / 手动重试都会让旧一轮的异步结果作废，
     旧结果不得覆盖新状态，也不得启动心跳或开放写入。 */
  w._round = (w._round || 0) + 1;
  var round = w._round;
  var gen = (typeof OLWrite.lifecycleState === 'function') ? OLWrite.lifecycleState().gen : 0;

  w.retryActive = true; w.retryAttempt = 0; w.nextRetryAt = 0;
  w.writeState = 'writer-acquiring';
  if(typeof setWriterBanner === 'function') setWriterBanner('正在连接本地库，请稍候…', false);

  return OLWrite.acquireWriterWithRetry({}, function(r, meta){
    /* 旧轮次的尝试回调直接忽略，避免覆盖新一轮诊断状态 */
    if(round !== w._round) return;
    w.retryAttempt = (meta && meta.attempt) || 0;
    w.code = (r && r.code) || 'writer-acquire-failed';
    w.retryActive = !!(r && !r.ok);
    var rs = (typeof OLWrite.writerRetryState === 'function') ? OLWrite.writerRetryState() : null;
    w.nextRetryAt = (rs && rs.nextAt) || 0;
    if(!(r && r.ok)){
      w.writeState = 'writer-retry';
      if(typeof setWriterBanner === 'function'){
        setWriterBanner('请勿多开标签页：当前只读'
          + (w.nextRetryAt ? '，稍后自动重试' : ''), true, w.code);
      }
    }
  }).then(function(r){
    if(round !== w._round) return r;          /* 旧一轮结果：丢弃 */
    w.retryActive = false; w.nextRetryAt = 0;
    var alive = (typeof OLWrite.isLifecycleCurrent === 'function')
      ? OLWrite.isLifecycleCurrent(gen) : true;
    if(!(r && r.ok) || !alive){
      w.code = (r && r.ok) ? 'lifecycle-ended' : ((r && r.code) || 'writer-acquire-failed');
      w.ownerId = null; w.epoch = null;
      w.writeState = (r && r.code === 'retry-cancelled') ? 'writer-retry-cancelled' : 'writer-retry-exhausted';
      if(typeof setWriterBanner === 'function'){
        setWriterBanner('请勿多开标签页：当前只读', r && r.code !== 'retry-cancelled', w.code);
      }
      return r;
    }
    w.code = r.code;
    w.ownerId = r.ownerId; w.epoch = r.epoch;
    w.writeState = 'writer-acquired';
    /* 取得写入权后才续期。默认周期由 write.js 决定（10000ms，含 [1000,2^31-1] 校验）。 */
    return OLWrite.startHeartbeat().then(function(h){
      if(round !== w._round) return r;
      if(!(h && h.ok)){
        w.code = (r.code || 'writer') + '+heartbeat-not-started';
        w.writeState = 'heartbeat-not-started';
        if(typeof setWriterBanner === 'function') setWriterBanner('请勿多开标签页：当前只读（写入未续期）', true, w.code);
        return r;
      }
      /* acquire + heartbeat 都成功后才受控开放业务写入 */
      if(typeof OLWrite.activateWrites !== 'function'){
        w.writeState = 'write-activate-missing';
        return r;
      }
      var act = OLWrite.activateWrites();
      w.writeState = (act && act.code) || 'write-activate-failed';
      if(act && act.ok){
        var bar = document.getElementById('ol-readonly-bar');
        if(bar && bar.parentNode) bar.parentNode.removeChild(bar);
      }else if(typeof setWriterBanner === 'function'){
        setWriterBanner('请勿多开标签页：当前只读（写入未开放）', true, (act && act.code) || 'unknown');
      }
      return r;
    }, function(){
      if(round !== w._round) return r;
      w.code = (r.code || 'writer') + '+heartbeat-start-threw';
      w.writeState = 'heartbeat-start-threw';
      if(typeof setWriterBanner === 'function') setWriterBanner('请勿多开标签页：当前只读（写入未续期）', true, w.code);
      return r;
    });
  }, function(e){
    if(round !== w._round) return { ok:false, code:'stale-round' };
    w.retryActive = false;
    w.code = (e && e.code) || 'writer-acquire-threw';
    w.writeState = 'writer-acquire-threw';
    if(typeof setWriterBanner === 'function') setWriterBanner('请勿多开标签页：当前只读', true, w.code);
    return { ok:false, code:w.code };
  });
}

/* 5B-5-R：恢复入口安全与内存数据保护（闭包私有，不暴露可伪造标志）。
   - 恢复凭据由队列 resolve({discard/recapture}) 的 writerChanged 分支内部签发、
     随结果返回；本 IIFE 闭包持有待消费凭据，队列按引用核对、一次成功即消费。
     凭据不挂在 window 可枚举属性上，外部无法伪造、重放或跨轮次使用。
   - retryWriter 重建路径在替换全局 S 之前先快照旧内存；重建后若与旧内存
     不一致（本页有未提交修改），不静默丢弃：保留副本并提示用户
     「恢复我的修改 / 放弃副本」，由用户显式决定；绝不自动把旧快照写回数据库。
   - 语义不变：discard 只结算队列里的保留 job；「放弃本次提交 ≠ 撤销内存修改」，
     用户主动「放弃副本」才真正丢弃。 */
(function(){
  var PENDING_CRED = null;     /* 队列签发、待消费的恢复凭据（闭包私有） */
  var UNSAVED = null;          /* { snapshot, base, recoveredRemote, rev, at } 重建前的内存副本及其可信基线 */
  var BASE = null;             /* 本页最后一次可信的完整基线（boot 重建 / 每次确认提交后的库状态） */
  var MERGE_JOB_ID = null;     /* keep 合并结果对应的队列 job id；提交期间用户新保存会形成后续 job */
  var MERGE_PERSISTED = false; /* 合并 job 已确认持久化；其后的"排空成功"事件才清 UNSAVED */

  function snap(v) {
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; }
  }

  /* 键序无关的规范化 JSON：比较重建前后内存是否分叉，避免误报 */
  function canonJSON(v) {
    if (v === null || typeof v !== 'object') return String(JSON.stringify(v));
    if (Array.isArray(v)) return '[' + v.map(canonJSON).join(',') + ']';
    var ks = Object.keys(v).sort(), out = [];
    for (var i = 0; i < ks.length; i++) out.push(JSON.stringify(ks[i]) + ':' + canonJSON(v[ks[i]]));
    return '{' + out.join(',') + '}';
  }
  function jeq(a, b) { return canonJSON(a) === canonJSON(b); }

  var origMergeRehydrated = mergeRehydrated;
  mergeRehydrated = function (rep) {
    origMergeRehydrated(rep);
    var c = snap(S);
    if (c) BASE = c;
  };

  /* 基线追踪：
     - mergeRehydrated 后 S == 库内状态 → BASE = S 副本（boot 与恢复重建都经过这里）；
     - 每次确认提交成功 → BASE = 队列 committedSnapshot（库此刻 == 该快照）。
   UNSAVED 清除条件（Task 5B-5-R2 补充验证）：
     - 合并 job 本身已确认持久化（MERGE_PERSISTED），且
     - 队列完全排空（无在途 / 待提交 / 恢复保留 job）。
   合并提交期间用户又保存的新修改会成为后续 job；若在合并 job 成功时就清副本，
   后续 job 一旦失败并发生刷新，新修改将无处可寻——因此必须等最后一个
   成功事件同时满足两个条件才清除。失败 / fatal 保留副本与追踪，重试成功
   且排空后仍会走到清除分支。 */
  if (window.OLCommitQueue && typeof OLCommitQueue.onResult === 'function') {
    OLCommitQueue.onResult(function (ev) {
      if (!ev) return;
      if (ev.type === 'success') {
        var ss = OLCommitQueue.snapshot();
        if (ss && ss.committedSnapshot) BASE = ss.committedSnapshot;
        if (MERGE_JOB_ID && ev.jobId === MERGE_JOB_ID) MERGE_PERSISTED = true;
        if (UNSAVED && MERGE_PERSISTED) {
          var st = OLCommitQueue.status();
          var drained = !!st && st.state === 'idle' &&
            !st.inFlight && !st.pending && !st.recoveringJob;
          if (drained) { MERGE_JOB_ID = null; MERGE_PERSISTED = false; UNSAVED = null; }
        }
      }
      /* failure / fatal：UNSAVED 与合并追踪原样保留 */
    });
  }

  function preserveUnsaved(preS, rev, localBase) {
    if (UNSAVED || !preS) return false;
    try { UNSAVED = { snapshot: preS, base: localBase || null, recoveredRemote: null, rev: rev, at: Date.now() }; return true; }
    catch (e) { return false; }
  }

  function takeCredential() { var c = PENDING_CRED; PENDING_CRED = null; return c; }

  function rehydrateAndComplete() {
    var cred = takeCredential();
    if (!cred) return Promise.resolve({ ok:false, code:'rehydrate-credential-missing' });
    /* 重建前先快照当前内存 S 与当时可信基线：discard 只结算队列 job，
       用户未提交的修改仍在 S 里，三方合并以本页最后同步点为 base。 */
    var preS = null, localBase = BASE;
    try { preS = JSON.parse(JSON.stringify(S)); } catch (e) { preS = null; }
    return OLMigrate.rehydrate().then(function(rep){
      if(!rep || !rep.ok){
        PENDING_CRED = cred;               /* 失败不吞凭据，下次重试直接复用 */
        return { ok:false, code:'rehydrate-failed', reason:(rep && rep.reason) || 'unknown' };
      }
      /* rep.meta.bizRev 与六表数据来自同一个只读事务：凭据据此绑定重建基线 */
      var mergedRev = (rep.meta && typeof rep.meta.bizRev === 'number') ? rep.meta.bizRev : null;
      mergeRehydrated(rep);
      var diverged = true;
      if (preS) { try { diverged = canonJSON(preS) !== canonJSON(S); } catch (e) { diverged = true; } }
      if (diverged) preserveUnsaved(preS, mergedRev, localBase);
      finishBoot();
      return OLCommitQueue.completeRehydrate(cred, mergedRev).then(function(cr){
        if (cr && cr.ok) {
          if (UNSAVED && !UNSAVED.recoveredRemote) UNSAVED.recoveredRemote = snap(S);
          if (diverged) notifyUnsaved();
          return { ok:true, code:'rehydrate-complete', rev:cr.rev, unsavedKept:diverged };
        }
        if (cr && (cr.code === 'rehydrate-stale-writer-changed' || cr.code === 'rehydrate-stale-rev-changed')) {
          /* 恢复期间 writer / 版本又变化：队列已签发新一轮凭据，下次重试直接重建 */
          PENDING_CRED = cr.credential || null;
          return { ok:false, code:cr.code, detail:cr.detail };
        }
        return { ok:!!(cr && cr.ok), code:(cr && cr.code) || 'rehydrate-complete', rev:(cr && cr.rev) };
      });
    });
  }

  function notifyUnsaved() {
    try {
      toast('本页有未保存的修改，已保留副本，没有自动覆盖最新数据', [
        { label:'恢复我的修改', cb:function(){ OLBoot.keepUnsavedSnapshot(); } },
        { label:'放弃副本', cb:function(){ OLBoot.discardUnsavedSnapshot(); } }
      ]);
    } catch (e) {}
  }

  OLBoot.retryWriter = function(){
    if(!OLBoot.booted || OLBoot.blocked){
      return Promise.resolve({ ok:false, code:'writer-not-ready', reason:'boot-not-ready' });
    }
    if(typeof OLWrite !== 'object' || !OLWrite || typeof OLWrite.acquireWriterWithRetry !== 'function'){
      return Promise.resolve({ ok:false, code:'write-module-missing' });
    }
    var Q = window.OLCommitQueue;
    var before = (Q && typeof Q.status === 'function') ? Q.status() : null;

    return Promise.resolve(bootWriter()).then(function(r){
      if(!(r && r.ok)) return r;
      if(!Q || !before || before.state === 'idle') return r;

      /* 失权后：先显式结束保留的旧 job（不重放），再按 writer 是否变化决定是否重建 */
      if(before.state === 'recovering'){
        return Q.resolve({ action:'discard' }).then(function(dr){
          var st = Q.status();
          if(st.state === 'stopped' && st.stopReason === 'rehydrate-required'){
            /* 只有真实走过 discard 流程才能拿到队列内部签发的凭据 */
            if(!(dr && dr.rehydrateCredential)) return { ok:false, code:'rehydrate-credential-missing' };
            PENDING_CRED = dr.rehydrateCredential;
            return rehydrateAndComplete();
          }
          if(!(dr && dr.ok)) return dr || { ok:false, code:'discard-failed' };
          return { ok:true, code:'queue-discarded', action:'discard' };
        });
      }
      if(before.state === 'stopped' && before.stopReason === 'rehydrate-required'){
        return rehydrateAndComplete();
      }
      return r;
    });
  };

  /* 用户对保留副本的显式选择：保留（用旧内存整体入队提交）或放弃 */
  OLBoot.hasUnsavedSnapshot = function(){ return !!UNSAVED; };
  /* ---------- 5B-5-R2：三方合并保留未提交修改 ----------
     base  = 本页最后同步点（UNSAVED.base，来自确认提交快照或上次重建）
     local = UNSAVED.snapshot（失权时的旧内存，含未提交修改）
     remote= 重新取权后从库内新读的最新状态
     只合并差异记录；同记录双方改且内容不同 → 冲突，逐条由用户选择，
     未解决前不提交；提交前再次核对基线，变化则重新读取合并。 */
  var ARRAY_BY_ID = ['tasks','plans','pens','tags','suggestions','tagLogs',
                     'workouts','studyLogs','decisionLog','flashes','itemLogs',
                     'plugins'];
  var MAP_BY_KEY = { notes:'date', marks:'date', doneSugg:'date' };

  function buildRemoteView(rep) {
    var view = defaults();
    deepMerge(view, rep.data);
    if(rep.extras && Array.isArray(rep.extras.keys) && rep.extras.keys.length){
      var val = rep.extras.value || {};
      for(var i = 0; i < rep.extras.keys.length; i++){
        var k = rep.extras.keys[i];
        if(!hasOwn(view, k)) defineOwn(view, k, val[k]);
      }
    }
    return view;
  }

  function mapById(arr) {
    var m = {};
    (Array.isArray(arr) ? arr : []).forEach(function(x, i){
      if(x && typeof x === 'object' && x.id !== undefined && x.id !== null && !(x.id in m)) m[x.id] = x;
    });
    return m;
  }

  /* 记录级三方合并（id 集合语义，含删除）：null/undefined 表示「不存在」。
     同一 id 双方改动内容不同 → 冲突，占位放 base（或 local 双方新增时），绝不静默覆盖。 */
  function mergeById(b, l, r, owner, conflicts) {
    var bm = mapById(b), lm = mapById(l), rm = mapById(r);
    var ids = {}, order = [];
    function reg(m){ Object.keys(m).forEach(function(id){ if(!(id in ids)){ ids[id] = true; order.push(id); } }); }
    reg(bm); reg(lm); reg(rm);
    var out = [];
    order.forEach(function(id){
      var bv = (id in bm) ? bm[id] : undefined,
          lv = (id in lm) ? lm[id] : undefined,
          rv = (id in rm) ? rm[id] : undefined;
      if (jeq(lv, bv)) { if (rv !== undefined) out.push(rv); }                 /* local 未变 → remote（含删除） */
      else if (jeq(rv, bv)) { if (lv !== undefined) out.push(lv); }           /* remote 未变 → local（含删除） */
      else if (jeq(lv, rv)) { out.push(lv); }                                 /* 双方相同修改 */
      else if (bv === undefined) {                                            /* 双方新增且内容不同 */
        conflicts.push({ owner:owner, key:id, kind:'added-both', base:null, local:lv, remote:rv });
        out.push(lv);                                                         /* 占位：解决后由选择覆盖 */
      } else if (lv === undefined) {                                          /* local 删除 vs remote 修改 */
        conflicts.push({ owner:owner, key:id, kind:'delete-vs-modify', base:bv, local:null, remote:rv });
        out.push(rv);                                                         /* 占位 */
      } else if (rv === undefined) {                                          /* remote 删除 vs local 修改 */
        conflicts.push({ owner:owner, key:id, kind:'modify-vs-delete', base:bv, local:lv, remote:null });
        out.push(lv);                                                         /* 占位 */
      } else {                                                                /* 双方修改同一记录 */
        conflicts.push({ owner:owner, key:id, kind:'modify-modify', base:bv, local:lv, remote:rv });
        out.push(lv);                                                         /* 占位 */
      }
    });
    return out;
  }

  /* 键值集合三方合并（notes/marks/doneSugg：{日期: 值}） */
  function mergeByMap(b, l, r, owner, conflicts) {
    var out = {};
    var keys = {}, order = [];
    function reg(o){ (o && typeof o === 'object') && Object.keys(o).forEach(function(k){ if(!(k in keys)){ keys[k] = true; order.push(k); } }); }
    reg(b); reg(l); reg(r);
    order.forEach(function(k){
      var bv = (b && b[k] !== undefined) ? b[k] : undefined,
          lv = (l && l[k] !== undefined) ? l[k] : undefined,
          rv = (r && r[k] !== undefined) ? r[k] : undefined;
      if (jeq(lv, bv)) { if (rv !== undefined) out[k] = rv; }
      else if (jeq(rv, bv)) { if (lv !== undefined) out[k] = lv; }
      else if (jeq(lv, rv)) { out[k] = lv; }
      else {
        conflicts.push({ owner:owner, key:k, kind: (lv === undefined ? 'delete-vs-modify' : rv === undefined ? 'modify-vs-delete' : bv === undefined ? 'added-both' : 'modify-modify'),
                         base:bv, local:lv, remote:rv });
        if (lv !== undefined) out[k] = lv; else if (rv !== undefined) out[k] = rv;
      }
    });
    return out;
  }

  /* restDays：日期字符串集合三方合并 */
  function mergeByValue(b, l, r, owner, conflicts) {
    var out = {}, keys = {}, order = [];
    function reg(a){ (Array.isArray(a) ? a : []).forEach(function(v){ var k = String(v); if(!(k in keys)){ keys[k] = true; order.push(k); } }); }
    reg(b); reg(l); reg(r);
    order.forEach(function(k){
      var has = function(a){ return Array.isArray(a) && a.indexOf(k) >= 0; };
      var bh = has(b), lh = has(l), rh = has(r);
      if (lh === bh) { if (rh) out[k] = k; }
      else if (rh === bh) { if (lh) out[k] = k; }
      else if (lh === rh) { if (lh) out[k] = k; }
      else {
        conflicts.push({ owner:owner, key:k, kind: (lh ? 'add-add' : bh ? 'delete-vs-add' : 'add-vs-delete'),
                         base: bh ? k : null, local: lh ? k : null, remote: rh ? k : null });
        if (lh) out[k] = k; else if (rh) out[k] = k;
      }
    });
    return Object.keys(out).sort().map(function(k){ return out[k]; });
  }

  /* settings：标量字段逐个三方；foodItems/focusItems 按 id 合并；goals 逐字段 */
  function mergeSettings(b, l, r, conflicts, pfx) {
    pfx = pfx || 'settings';
    var out = {};
    var keys = {}, order = [];
    function reg(o){ (o && typeof o === 'object') && Object.keys(o).forEach(function(k){ if(!(k in keys)){ keys[k] = true; order.push(k); } }); }
    reg(b); reg(l); reg(r);
    order.forEach(function(k){
      var bv = b ? b[k] : undefined, lv = l ? l[k] : undefined, rv = r ? r[k] : undefined;
      if (k === 'foodItems' || k === 'focusItems') { out[k] = mergeById(bv, lv, rv, pfx + '.' + k, conflicts); return; }
      if (k === 'goals') { out[k] = mergeSettings(bv, lv, rv, conflicts, pfx + '.goals'); return; }
      if (jeq(lv, bv)) { out[k] = rv; }
      else if (jeq(rv, bv)) { out[k] = lv; }
      else if (jeq(lv, rv)) { out[k] = lv; }
      else {
        conflicts.push({ owner:pfx + '.' + k, key:k, kind:'field', base:bv, local:lv, remote:rv });
        out[k] = lv;
      }
    });
    return out;
  }

  function merge3(base, local, remote) {
    var conflicts = [], out = {};
    var keys = {}, order = [];
    function reg(o){ (o && typeof o === 'object') && Object.keys(o).forEach(function(k){ if(!(k in keys)){ keys[k] = true; order.push(k); } }); }
    reg(base); reg(local); reg(remote);
    order.forEach(function(k){
      var bv = base ? base[k] : undefined, lv = local ? local[k] : undefined, rv = remote ? remote[k] : undefined;
      if (k === 'settings') { out[k] = mergeSettings(bv, lv, rv, conflicts); return; }
      if (k === 'notes' || k === 'marks' || k === 'doneSugg') { out[k] = mergeByMap(bv, lv, rv, k, conflicts); return; }
      if (k === 'restDays') { out[k] = mergeByValue(bv, lv, rv, k, conflicts); return; }
      if (ARRAY_BY_ID.indexOf(k) >= 0 && k !== 'restDaysSets') { out[k] = mergeById(bv, lv, rv, k, conflicts); return; }
      /* 标量 / 未知键：整体三方 */
      if (jeq(lv, bv)) { out[k] = rv; }
      else if (jeq(rv, bv)) { out[k] = lv; }
      else if (jeq(lv, rv)) { out[k] = lv; }
      else {
        conflicts.push({ owner:k, key:null, kind:'field', base:bv, local:lv, remote:rv });
        out[k] = lv;
      }
    });
    return { value: out, conflicts: conflicts };
  }

  function applyResolutions(value, conflicts, choices) {
    conflicts.forEach(function(c, i){
      var pick = choices[i] === 'remote' ? c.remote : c.local;
      if (c.owner === 'notes' || c.owner === 'marks' || c.owner === 'doneSugg') {
        if (!value[c.owner] || typeof value[c.owner] !== 'object') value[c.owner] = {};
        if (pick === undefined) delete value[c.owner][c.key]; else value[c.owner][c.key] = pick;
        return;
      }
      if (c.owner === 'restDays') {
        var arr = Array.isArray(value.restDays) ? value.restDays : [];
        var pos = arr.indexOf(c.key);
        if (pick === undefined || pick === null) { if (pos >= 0) arr.splice(pos, 1); }
        else if (pos < 0) arr.push(c.key);
        value.restDays = arr;
        return;
      }
      var parts = c.owner.split('.');
      var tgt = value;
      for (var j = 0; j < parts.length - 1; j++) {
        if (!tgt[parts[j]] || typeof tgt[parts[j]] !== 'object' || Array.isArray(tgt[parts[j]])) tgt[parts[j]] = {};
        tgt = tgt[parts[j]];
      }
      var leaf = parts[parts.length - 1];
      if (c.kind === 'field') {
        if (pick === undefined) delete tgt[leaf]; else tgt[leaf] = pick;
        return;
      }
      if (!Array.isArray(tgt[leaf])) tgt[leaf] = [];
      applyToList(tgt[leaf], c.key, pick);
    });
  }
  function applyToList(arr, id, pick) {
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].id === id) { arr.splice(i, 1); break; }
    }
    if (pick !== undefined && pick !== null) arr.push(pick);
  }

  /* 冲突解决面板：逐条展示双方内容，全部明确选择后才允许继续提交 */
  function openConflictSheet(conflicts, onDone) {
    var choices = {};
    var html = '<div class="shd"><div class="shd-t">合并冲突（' + conflicts.length + ' 条）</div>' +
      '<div class="shd-s">同一内容本机与最新数据都有改动。逐条选择保留哪一份；全部选择后才会写入。</div></div>';
    conflicts.forEach(function(c, i){
      function brief(v){ if(v === undefined || v === null) return '（已删除 / 无）';
        var s = JSON.stringify(v); return s.length > 120 ? s.slice(0, 117) + '…' : s; }
      html += '<div class="field" style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">' +
        '<div class="field-l">' + esc(c.owner + (c.key !== null && c.key !== undefined ? ' · ' + c.key : '')) + '（' + esc(c.kind) + '）</div>' +
        '<div style="font:400 11px/1.6 ui-monospace,Menlo,monospace;color:var(--ink2);word-break:break-all">本机：' + esc(brief(c.local)) + '</div>' +
        '<div style="font:400 11px/1.6 ui-monospace,Menlo,monospace;color:var(--ink2);word-break:break-all">最新：' + esc(brief(c.remote)) + '</div>' +
        '<div class="chips" id="cfChips' + i + '">' +
        '<button class="chip" id="cfL' + i + '">保留本机</button>' +
        '<button class="chip" id="cfR' + i + '">用最新</button>' +
        '</div></div>';
    });
    html += '<div class="chips" style="margin-top:16px">' +
      '<button class="chip" id="cfDone">完成合并</button>' +
      '<button class="chip" id="cfCancel">取消</button></div>';
    var body = openSheet(html);
    function refresh() {
      conflicts.forEach(function(c, i){
        var l = body.querySelector('#cfL' + i), r = body.querySelector('#cfR' + i);
        if (!l || !r) return;
        l.className = 'chip' + (choices[i] === 'local' ? ' on' : '');
        r.className = 'chip' + (choices[i] === 'remote' ? ' on' : '');
      });
      var done = body.querySelector('#cfDone');
      if (done) done.style.opacity = (Object.keys(choices).length === conflicts.length) ? '1' : '.4';
    }
    conflicts.forEach(function(c, i){
      var bl = body.querySelector('#cfL' + i), br = body.querySelector('#cfR' + i);
      if (bl) bl.addEventListener('click', function(){ choices[i] = 'local'; refresh(); });
      if (br) br.addEventListener('click', function(){ choices[i] = 'remote'; refresh(); });
    });
    var cancel = body.querySelector('#cfCancel');
    if (cancel) cancel.addEventListener('click', function(){ closeSheet(); });
    var done = body.querySelector('#cfDone');
    if (done) done.addEventListener('click', function(){
      if (Object.keys(choices).length !== conflicts.length) return;
      closeSheet();
      onDone(choices);
    });
    refresh();
  }

  OLBoot.keepUnsavedSnapshot = function(){
    if(!UNSAVED) return Promise.resolve({ ok:false, code:'no-unsaved-snapshot' });
    if(!BASE || !UNSAVED.base) return Promise.resolve({ ok:false, code:'no-trusted-base' });
    var Q = window.OLCommitQueue, W = window.OLWrite;
    if(!Q || !W || typeof W.readBizRev !== 'function' || typeof Q.enqueue !== 'function'){
      return Promise.resolve({ ok:false, code:'write-not-ready' });
    }
    var st = Q.status();
    if(st.state !== 'idle') return Promise.resolve({ ok:false, code:'queue-not-ready', state:st.state });
    var local = UNSAVED.snapshot;

    function commitMerged(value, revRemote, round) {
      return W.readBizRev().then(function(r){
        if(!(r && r.ok && typeof r.rev === 'number')) return { ok:false, code:'baseline-unavailable' };
        if(r.rev !== revRemote){
          /* 基线在合并后又变化：作废本次合并结果，重新读取并合并（不直接提交旧结果） */
          if(round < 2) return attempt(round + 1);
          return { ok:false, code:'remote-active', detail:{ mergedRev:revRemote, currentRev:r.rev } };
        }
        var applied = snap(value);
        if(!applied) return { ok:false, code:'merge-apply-failed' };
        S = applied;
        if(typeof normalize === 'function') normalize();
        if(typeof renderAll === 'function') renderAll();
        var saved = save(function(){});          /* 走串行队列：writer fencing + bizRev CAS + 原子事务 */
        if(!saved){ MERGE_JOB_ID = null; MERGE_PERSISTED = false; return { ok:false, code:'enqueue-failed' }; }
        /* keep 入口时队列 idle，save 同步入队的唯一 job 就是合并结果本身；
           提交期间用户新保存会产生后续 job，success 事件按 job id 区分归属，
           UNSAVED 等最后一个相关提交成功且队列排空后才清除。 */
        var st2 = Q.status();
        MERGE_JOB_ID = (st2.inFlight && st2.inFlight.id) || (st2.pending && st2.pending.id) ||
                       (st2.recoveringJob && st2.recoveringJob.id) || null;
        MERGE_PERSISTED = false;
        return { ok:true, code:'merge-enqueued', rev:revRemote };
        /* UNSAVED 在 success 事件里满足"合并已持久化 + 队列排空"才清除；
           事务失败副本保留，local 始终可找回 */
      });
    }
    function attempt(round) {
      return OLMigrate.rehydrate().then(function(rep){
        if(!rep || !rep.ok) return { ok:false, code:'rehydrate-failed', reason:(rep && rep.reason) || 'unknown' };
        var revRemote = (rep.meta && typeof rep.meta.bizRev === 'number') ? rep.meta.bizRev : null;
        if(revRemote === null) return { ok:false, code:'remote-rev-missing' };
        var remote = buildRemoteView(rep);
        var m;
        if(UNSAVED.recoveredRemote){
          /* 先吸收恢复之后用户新做的内存修改，再并入失权期间的本地修改 */
          var step1 = merge3(UNSAVED.recoveredRemote, snap(S), remote);
          if(step1.conflicts.length) return { ok:false, code:'merge-conflicts', phase:'memory', conflicts:step1.conflicts };
          m = merge3(UNSAVED.base, local, step1.value);
        } else {
          return { ok:false, code:'merge-base-missing' };   /* 无可信重建基线：失败关闭，保留副本 */
        }
        if(m.conflicts.length){
          openConflictSheet(m.conflicts, function(choices){
            var resolved = snap(m.value);
            applyResolutions(resolved, m.conflicts, choices);
            commitMerged(resolved, revRemote, round).then(function(res){
              if(res && res.ok) toast(OLT('修改已合并并提交'));
              else bizSaveFailed((res && res.code) || 'merge-commit-failed', [], null, true);
            });
          });
          return { ok:false, code:'merge-conflicts', count:m.conflicts.length, conflicts:m.conflicts };
        }
        return commitMerged(m.value, revRemote, round);
      });
    }
    return attempt(0);
  };
  OLBoot.discardUnsavedSnapshot = function(){
    if(!UNSAVED) return { ok:false, code:'no-unsaved-snapshot' };
    UNSAVED = null;
    return { ok:true, code:'unsaved-discarded' };
  };
})();

function bootFromIdb(){
  OLMigrate.rehydrate().then(function(rep){
    if(OLBoot.blocked) return;
    if(!rep.ok){ bootBlocked('读取数据库失败', rep.message || rep.reason); return; }
    OLBoot.mode = 'idb';
    OLBoot.readMeta = rep.meta;
    mergeRehydrated(rep);
    finishBoot();
    showReadOnlyBanner();
    watchWriterFatal();               /* 运行期失权时重新显示带「重试」的横幅 */
    bootWriter();                     /* 取权 + 心跳 + 受控开放写入；失败保持只读 */
  }, function(e){
    bootBlocked('读取数据库失败', (e && e.message) || String(e));
  });
}

/* 只读横幅：idb 模式下写入未就绪时常驻提示，避免「显示成功其实没保存」的误解。
   文本与重试按钮由 setWriterBanner() 更新；成功开放写入后整条移除。 */
function showReadOnlyBanner(){
  if(document.getElementById('ol-readonly-bar')) return;
  var bar = document.createElement('div');
  bar.id = 'ol-readonly-bar';
  bar.setAttribute('role', 'status');
  bar.style.cssText = 'position:fixed;left:0;top:0;right:0;z-index:55;'
    + 'background:var(--bg);color:var(--ink2);border-bottom:1px solid var(--line);'
    + 'font:400 12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;'
    + 'letter-spacing:.04em;text-align:center;padding:6px 12px;pointer-events:none;';
  var txt = document.createElement('span');
  txt.className = 'ol-ro-text';
  txt.textContent = '正在连接本地库，请稍候…';
  bar.appendChild(txt);
  document.body.appendChild(bar);
}

/* 运行期失权：队列进入 fatal/recovering 时，重新显示带「重试」的只读横幅。
   只处理 writer-* 错误；其余 fatal（如 stale-state）仍走原有 resolve 出口。 */
function watchWriterFatal(){
  if(OLBoot._writerWatch) return;
  if(!window.OLCommitQueue || typeof OLCommitQueue.onResult !== 'function') return;
  OLBoot._writerWatch = true;
  OLCommitQueue.onResult(function(ev){
    if(!ev || ev.type !== 'fatal') return;
    var code = ev.code || ev.stopReason || '';
    if(!/^writer-/.test(code)) return;
    OLBoot.writer.code = code;
    OLBoot.writer.writeState = 'writer-lost';
    showReadOnlyBanner();
    setWriterBanner('请勿多开标签页：当前只读（写入已失效）', true, code);
  });
}


/* 更新只读横幅：text 为当前状态，canRetry 为是否显示「重试」按钮。
   按钮是唯一的手动恢复入口，点击后重新走 bootWriter；重试进行中隐藏按钮。 */
function setWriterBanner(text, canRetry, tech){
  var bar = document.getElementById('ol-readonly-bar');
  if(!bar) return false;
  /* 技术诊断码只进 tooltip，不进主文案：普通用户看到的是「请勿多开标签页」，
     需要排查时把鼠标停在横幅上即可看到原始 code（自动化测试也读这个属性）。 */
  if(tech) bar.title = String(tech); else bar.removeAttribute('title');
  var txt = bar.querySelector ? bar.querySelector('.ol-ro-text') : null;
  if(!txt){
    bar.textContent = '';
    txt = document.createElement('span');
    txt.className = 'ol-ro-text';
    bar.appendChild(txt);
  }
  txt.textContent = text || '';
  var btn = document.getElementById('ol-writer-retry');
  if(canRetry){
    if(!btn){
      btn = document.createElement('button');
      btn.id = 'ol-writer-retry';
      btn.type = 'button';
      btn.textContent = '重试';
      btn.style.cssText = 'pointer-events:auto;margin-left:10px;border:1px solid var(--line);'
        + 'background:var(--paper);color:var(--ink);border-radius:100px;'
        + 'font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;'
        + 'padding:5px 12px;cursor:pointer;';
      btn.addEventListener('click', function(){
        if(typeof OLBoot.retryWriter === 'function') OLBoot.retryWriter();
      });
      bar.appendChild(btn);
    }
    btn.style.display = '';
  }else if(btn){
    btn.style.display = 'none';
  }
  return true;
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

