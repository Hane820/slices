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
      save(function(){ toast('标签已加上'); }); renderSettings();
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
  if(typeof setWriterBanner === 'function') setWriterBanner('正在连接本地库：写入将在写入权就绪后开放', false);

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
        setWriterBanner('写入权未就绪（' + w.code + '）· 当前只读'
          + (w.nextRetryAt ? '，稍后自动重试' : ''), true);
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
        setWriterBanner('写入权未就绪（' + w.code + '）· 当前只读', r && r.code !== 'retry-cancelled');
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
        if(typeof setWriterBanner === 'function') setWriterBanner('写入权未续期（' + w.code + '）· 当前只读', true);
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
        setWriterBanner('写入尚未开放（' + ((act && act.code) || 'unknown') + '）· 当前只读', true);
      }
      return r;
    }, function(){
      if(round !== w._round) return r;
      w.code = (r.code || 'writer') + '+heartbeat-start-threw';
      w.writeState = 'heartbeat-start-threw';
      if(typeof setWriterBanner === 'function') setWriterBanner('写入权未续期（' + w.code + '）· 当前只读', true);
      return r;
    });
  }, function(e){
    if(round !== w._round) return { ok:false, code:'stale-round' };
    w.retryActive = false;
    w.code = (e && e.code) || 'writer-acquire-threw';
    w.writeState = 'writer-acquire-threw';
    if(typeof setWriterBanner === 'function') setWriterBanner('写入权未就绪（' + w.code + '）· 当前只读', true);
    return { ok:false, code:w.code };
  });
}

/* 手动重试入口（横幅按钮 / 控制台 / 测试）。
   若旧页因 writer 变化丢失写入权：取回新 writer 后先从库里重读 S，
   再 completeRehydrate() 读取最新 bizRev 基线，最后才恢复队列。
   期间队列保持 stopped，save() 一律拒绝，旧快照不会被提交。 */
OLBoot.retryWriter = function(){
  if(!OLBoot.booted || OLBoot.blocked){
    return Promise.resolve({ ok:false, code:'writer-not-ready', reason:'boot-not-ready' });
  }
  if(typeof OLWrite !== 'object' || !OLWrite || typeof OLWrite.acquireWriterWithRetry !== 'function'){
    return Promise.resolve({ ok:false, code:'write-module-missing' });
  }
  var Q = window.OLCommitQueue;
  var before = (Q && typeof Q.status === 'function') ? Q.status() : null;

  function rehydrateAndComplete(){
    return OLMigrate.rehydrate().then(function(rep){
      if(!rep || !rep.ok) return { ok:false, code:'rehydrate-failed', reason:(rep && rep.reason) || 'unknown' };
      mergeRehydrated(rep);
      finishBoot();
      return Q.completeRehydrate().then(function(cr){
        return { ok:!!(cr && cr.ok), code:(cr && cr.code) || 'rehydrate-complete', rev:(cr && cr.rev) };
      });
    });
  }

  return Promise.resolve(bootWriter()).then(function(r){
    if(!(r && r.ok)) return r;
    if(!Q || !before || before.state === 'idle') return r;

    /* 失权后：先显式结束保留的旧 job（不重放），再按 writer 是否变化决定是否重建 */
    if(before.state === 'recovering'){
      return Q.resolve({ action:'discard' }).then(function(dr){
        var st = Q.status();
        if(st.state === 'stopped' && st.stopReason === 'rehydrate-required'){
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
    + 'background:rgba(246,245,240,.94);color:#77766f;border-bottom:1px solid #d8d6cc;'
    + 'font:400 12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;'
    + 'letter-spacing:.04em;text-align:center;padding:6px 12px;pointer-events:none;';
  var txt = document.createElement('span');
  txt.className = 'ol-ro-text';
  txt.textContent = '正在连接本地库：写入将在写入权就绪后开放';
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
    setWriterBanner('写入权已失效（' + code + '）· 当前只读', true);
  });
}


/* 更新只读横幅：text 为当前状态，canRetry 为是否显示「重试」按钮。
   按钮是唯一的手动恢复入口，点击后重新走 bootWriter；重试进行中隐藏按钮。 */
function setWriterBanner(text, canRetry){
  var bar = document.getElementById('ol-readonly-bar');
  if(!bar) return false;
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
      btn.style.cssText = 'pointer-events:auto;margin-left:10px;border:1px solid #c9c6ba;'
        + 'background:#fff;color:#4a4943;border-radius:100px;'
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

