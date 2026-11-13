/* decide.js — 决策：情境抽取 + 建议库 */
/* ==================== 决策：按情境分类 + 随机抽取 ==================== */
function timeSlot(){
  var h = new Date().getHours();
  if(h < 11) return 'morning';
  if(h < 15) return 'afternoon';
  if(h < 19) return 'evening';
  return 'night';
}
function suggestionDoneToday(id){
  var d = S.doneSugg[TODAY()] || {};
  return !!d[id];
}
/* 随机池：今天没勾的待办 + 建议库里开着、且今天没做过的 */
function buildCandidates(filterCat){
  var t0 = TODAY();
  var slot = timeSlot();
  var out = [];
  S.tasks.forEach(function(t){
    if(t.cat === CAT_ROUTINE) return;
    if(!taskVisible(t, t0) || isDone(t, t0)) return;
    if(filterCat && filterCat !== '全部'){
      if(filterCat === '待办'){ /* 允许 */ }
      else if(sgCatOfTask(t) !== filterCat) return;
    }
    out.push({
      key:'task:' + t.id, src:'task', ref:t,
      name:t.title, sub:'你清单里还没勾的', duration:t.duration || 0,
      catLabel: t.cat === CAT_MUST ? '待办 · 必须处理' : '待办 · 今天想完成',
      why:'', score: t.cat === CAT_MUST ? 6 : 3
    });
  });
  S.suggestions.forEach(function(sg){
    if(!sg.enabled) return;
    if(filterCat && filterCat !== '全部'){
      if(filterCat === '待办') return;
      if(sg.cat !== filterCat) return;
    }
    var tm = sg.times || ['any'];
    var sc = (tm.indexOf('any') >= 0 || tm.indexOf(slot) >= 0) ? 2 : -1;
    sc += (sg.priority || 1);
    if(suggestionDoneToday(sg.id)) sc -= 12;
    out.push({
      key:'sugg:' + sg.id, src:'sugg', ref:sg,
      name:sg.name, sub:sg.note || '', duration:sg.duration || 0, catLabel:sg.cat,
      why:'', score:sc
    });
  });
  return out;
}
function sgCatOfTask(t){ return t.cat === CAT_MUST ? '必须处理' : '今天想完成'; }

function randomPick(filterCat){
  var pool = buildCandidates(filterCat || '全部').filter(function(c){
    if(c.src === 'sugg' && !c.ref.random) return false;
    if(c.src === 'sugg' && suggestionDoneToday(c.ref.id)) return false;
    if(c.src === 'task' && isDone(c.ref, TODAY())) return false;
    return true;
  });
  if(!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

/* ---------- 决策页 UI ---------- */
var decState = { list:[], idx:0, mode:'scene', filter:'全部', scene:'' };
var libOpen = false;
var libQuery = '';

function renderScenes(){
  var box = $('sceneChips');
  if(box){
    box.innerHTML = '';
    SCENES.forEach(function(sc){
      var b = el('button','scene-card' + (decState.scene === sc.k ? ' on' : ''));
      b.innerHTML = '<div class="n">' + esc(sc.n) + '</div><div class="d">' + esc(sc.d) + '</div>';
      b.dataset.action = 'scene-full';
      b.dataset.k = sc.k;
      box.appendChild(b);
    });
  }
}

/* 选情境：列出绑在这个情境上的建议，并直接落到结果顶部 */
function chooseScene(k){
  decState.scene = k;
  decState.mode = 'scene';
  decState.list = [];
  renderScenes();
  renderSceneResult(k);
  var b = $('decResult');
  if(b){
    var y = b.getBoundingClientRect().top + window.scrollY - 14;
    window.scrollTo(0, Math.max(0, y));
    rvScan();
  }
}

function sceneSuggestions(k){
  var slot = timeSlot();
  var list = S.suggestions.filter(function(sg){
    return sg.enabled && (sg.scenes || []).indexOf(k) >= 0 && !suggestionDoneToday(sg.id);
  });
  list.sort(function(a,b){
    var at = ((a.times||[]).indexOf('any') >= 0 || (a.times||[]).indexOf(slot) >= 0) ? 1 : 0;
    var bt = ((b.times||[]).indexOf('any') >= 0 || (b.times||[]).indexOf(slot) >= 0) ? 1 : 0;
    return (bt - at) || ((b.priority||1) - (a.priority||1));
  });
  return list;
}

function renderSceneResult(k){
  var box = $('decResult');
  box.innerHTML = '';
  var head = el('div','sec');
  head.style.marginTop = '16px';
  head.innerHTML = '<span class="sec-t strong">' + esc(sceneName(k)) + ' · 可以做的事</span><span class="sec-line"></span>';
  box.appendChild(head);
  box.appendChild(el('div','scene-note','你选了「' + sceneName(k) + '」。下面这些绑在这个情境上，可以在建议库里改。'));

  var list = sceneSuggestions(k);
  if(!list.length){
    box.appendChild(el('div','empty','这个情境下还没有建议，或者今天都做过了。到建议库新建一条，勾上这个情境就行。'));
    return;
  }
  var card = el('div','card');
  card.style.padding = '2px 14px';
  list.slice(0, 6).forEach(function(sg){
    var item = el('div','scene-item');
    item.style.animation = 'decItem .8s var(--ease) both';
    item.style.animationDelay = (card.children.length * 0.04) + 's';
    var main = el('div','scene-main');
    main.appendChild(el('div','scene-t', sg.name));
    var d = el('div','scene-d');
    d.appendChild(el('span', null, sg.cat));
    if(sg.duration) d.appendChild(el('span', null, durText(sg.duration)));
    if(sg.note) d.appendChild(el('span', null, sg.note));
    main.appendChild(d);
    var acts = el('div','scene-acts');
    var go = el('button','btn p sm','现在开始');
    go.addEventListener('click', function(){ startPomo(suggPick(sg), go); });
    var add = el('button','btn o sm','加入待办');
    add.addEventListener('click', function(){ addAsTask(suggPick(sg), add); });
    acts.appendChild(go); acts.appendChild(add);
    item.appendChild(main); item.appendChild(acts);
    card.appendChild(item);
  });
  box.appendChild(card);
}
function suggPick(sg){
  return { key:'sugg:'+sg.id, src:'sugg', ref:sg, name:sg.name, sub:sg.note||'',
           duration:sg.duration||0, catLabel:sg.cat, why:'' };
}
function addAsTask(c, btnEl){
  S.tasks.push({
    id:uid('t'), title:c.name, cat:CAT_WANT, repeat:'once',
    due:'', duration:c.duration || 0, note:'', done:{}, createdAt:Date.now(),
    suggId: c.ref ? c.ref.id : ''
  });
  save();
  // 飞点：从按钮飞到底部「今日」入框
  var navBtn = document.querySelector('.nav button[data-page="pToday"]');
  if(navBtn && btnEl){
    flyDot(btnEl, navBtn, function(){
      navBtn.classList.add('pulse');
      setTimeout(function(){ navBtn.classList.remove('pulse'); }, 620);
    });
  }
  renderToday();
  if(btnEl){
    btnEl.textContent = '已加入';
    btnEl.disabled = true;
    setTimeout(function(){ if(btnEl){ btnEl.textContent = '加入待办'; btnEl.disabled = false; } }, 1400);
  }
  toast('已加入今日待办');
}

/* 飞点：一个小点从起点飞到终点（底部任务栏） */
function flyDot(fromEl, toEl, done){
  var a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
  var dot = document.createElement('div');
  dot.className = 'flydot';
  dot.style.left = (a.left + a.width / 2 - 6) + 'px';
  dot.style.top = (a.top + a.height / 2 - 6) + 'px';
  document.body.appendChild(dot);
  var dx = (b.left + b.width / 2) - (a.left + a.width / 2);
  var dy = (b.top + b.height / 2) - (a.top + a.height / 2);
  requestAnimationFrame(function(){
    dot.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(.4)';
    dot.style.opacity = '.1';
  });
  setTimeout(function(){
    dot.remove();
    if(done) done();
  }, 640);
}

/* ---------- 番茄钟：抽到之后开一个独立的计时框 ---------- */
var pomo = null;
/* 倒计时：≥1 小时用 HH:MM:SS，否则 MM:SS */
function fmtPomo(sec){
  sec = Math.max(0, Math.round(sec));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? (pad(h) + ':' + pad(m) + ':' + pad(s)) : (pad(m) + ':' + pad(s));
}
/* 一次决策 = 一条记录：duration 是计划秒数，actual 由计时结束时按实际秒数写回 */
function logDecision(c, planned){
  var rec = {
    id: uid('d'), date: TODAY(), ts: Date.now(),
    title: c.name, duration: Math.max(0, Math.round(planned || 0)), actual: 0,
    mode: decState.mode, input: decState.scene || '', src: c.src
  };
  S.decisionLog.push(rec);
  if(c.src === 'sugg' && c.ref){
    S.doneSugg[TODAY()] = S.doneSugg[TODAY()] || {};
    S.doneSugg[TODAY()][c.ref.id] = 1;
  }
  save();
  return rec.id;
}
/* ==================== 番茄钟 ====================
   浮窗：暂停 / 完成 / 取消（取消要先确认）；可进全屏专注；
   完成时原地收缩成小点，飞到今天的对应条目上打钩 —— 全程不换页。 */
var pomoLock = false;

/* 本次专注时长的唯一真源（总秒数）：预设/输入/条目配置都写它，startPomo 只读它 */
var pomoDraft = { duration: 1500 };
var POMO_PRESETS = [
  { s:60,   n:'1 分钟' }, { s:300,  n:'5 分钟' }, { s:900,  n:'15 分钟' },
  { s:1500, n:'25 分钟' }, { s:2700, n:'45 分钟' }
];
function setPomoDuration(sec){
  sec = Math.max(1, Math.round(+sec || 0));
  pomoDraft.duration = sec;
  return sec;
}
function pomoDurationOf(c){
  return (c && +c.duration > 0) ? Math.round(+c.duration) : 0;
}

/* ---------- 完成通知：只在计时自然归零时触发 ---------- */
var notifAsked = false;
var titleBase = null, titleTimer = null;
function pomoAskNotification(){
  if(notifAsked) return;                 /* 只在首次点「现在开始」时请求一次 */
  notifAsked = true;
  if(typeof Notification === 'undefined' || !Notification.requestPermission) return;
  try{
    if(Notification.permission === 'default'){
      var r = Notification.requestPermission();
      if(r && r.catch) r.catch(function(){});
    }
  }catch(e){}
}
function pomoTitleStop(){
  if(titleTimer){ clearInterval(titleTimer); titleTimer = null; }
  if(titleBase !== null){ document.title = titleBase; titleBase = null; }
  document.removeEventListener('visibilitychange', pomoTitleOnVisible);
  window.removeEventListener('focus', pomoTitleStop);
  document.removeEventListener('pointerdown', pomoTitleStop);
}
function pomoTitleOnVisible(){ if(!document.hidden) pomoTitleStop(); }
function pomoTitleFlash(){
  pomoTitleStop();
  titleBase = document.title;
  var on = false;
  titleTimer = setInterval(function(){
    on = !on;
    document.title = on ? ('✅ 完成了 - ' + titleBase) : titleBase;
  }, 900);
  document.addEventListener('visibilitychange', pomoTitleOnVisible);
  window.addEventListener('focus', pomoTitleStop);
  document.addEventListener('pointerdown', pomoTitleStop);
}
function pomoNotifyDone(name){
  var title = '番茄钟完成 · ' + name;
  if(typeof Notification !== 'undefined' && Notification.permission === 'granted'){
    try{
      var n = new Notification(title, { body:'时间到了，回来看看做完了没', tag:'pomo-done' });
      n.onclick = function(){ try{ window.focus(); }catch(e){} n.close(); };
      return;
    }catch(e){}
  }
  toast('时间到 · ' + name);
  pomoTitleFlash();                      /* 被拒 / 不支持 API 时的页面内兜底 */
}
/* 专注统计：按实际走过的秒数写回本次决策记录，不用预计值 */
function pomoFocusDone(logId, actual){
  if(!logId) return;
  var rec = byId(S.decisionLog, logId);
  if(!rec) return;
  rec.actual = Math.max(0, Math.round(actual || 0));
  save();
}

function pomoResetBtn(p){
  if(p && p.btnEl && p.btnEl.isConnected){
    p.btnEl.textContent = p.btnText || '现在开始';
    p.btnEl.disabled = false;
  }
}
function removePomo(){
  if(pomo && pomo.timer){ clearInterval(pomo.timer); pomo.timer = null; }
  var old = document.getElementById('pomoBox');
  if(old) old.remove();
  if(pomoFsEl()) pomoFsExit();
  document.body.classList.remove('pomo-on');
  pomoResetBtn(pomo);
  pomo = null;
  pomoLock = false;
}

/* ---------- 全屏 ---------- */
function pomoFsEl(){
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
/* 全屏用不了就退成「大浮窗」：同一个节点、同一段计时，只换尺寸和配色 */
function pomoBigOn(){
  var box = document.getElementById('pomoBox');
  if(!box || box.classList.contains('big')) return;
  box.classList.add('big');
  var ex = document.getElementById('pomoExit');
  if(ex) ex.textContent = '收起';
  toast('全屏用不了，已换成大窗口');
}
function pomoLeaveBig(){
  if(pomoFsEl()){ pomoFsExit(); return; }
  var box = document.getElementById('pomoBox');
  if(box && box.classList.contains('big')){
    box.classList.remove('big');
    var ex = document.getElementById('pomoExit');
    if(ex) ex.textContent = '退出全屏';
  }
}
function pomoFsEnter(){
  var box = document.getElementById('pomoBox');
  if(!box || box.classList.contains('big')) return;
  var req = box.requestFullscreen || box.webkitRequestFullscreen;
  if(!req || document.fullscreenEnabled === false){ pomoBigOn(); return; }
  try{
    var r = req.call(box);
    if(r && r.catch){
      r.catch(function(){ pomoBigOn(); });
    }else{
      /* 不返回 Promise 的老实现：等一下没真进全屏就退成大窗 */
      setTimeout(function(){
        if(!pomoFsEl() && document.getElementById('pomoBox')) pomoBigOn();
      }, 300);
    }
  }catch(e){ pomoBigOn(); }
}
function pomoFsExit(){
  var ex = document.exitFullscreen || document.webkitExitFullscreen;
  if(!ex) return;
  try{
    var r = ex.call(document);
    if(r && r.catch) r.catch(function(){});
  }catch(e){}
}

/* ---------- 动画小工具：只动 transform / opacity ---------- */
function pomoWait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
function pomoAnim(node, frames, opts){
  if(!node || !deckCanAnimate()) return Promise.resolve();
  return new Promise(function(res){
    var a = node.animate(frames, opts);
    a.onfinish = function(){ res(); };
    a.oncancel = function(){ res(); };
  });
}

function findTaskForPomo(name, suggId){
  var t0 = TODAY();
  var list = S.tasks.filter(function(t){
    if(isDone(t, t0)) return false;
    if(suggId && t.suggId === suggId) return true;
    return !suggId && t.title === name;
  });
  return list.length ? list[0] : null;
}

/* 落点：今天的条目行（优先落在小圆圈上）；今日页看不到就落到「今日」导航按钮 */
function pomoResolveTarget(p){
  var task = findTaskForPomo(p.name, p.suggId);
  var out = { task:task, row:null, needScroll:false };
  if(task && currentPage === 'pToday'){
    var row = document.querySelector('#taskWrap .task[data-tid="' + task.id + '"]');
    if(row && row.getBoundingClientRect().width > 0){
      out.row = row;
      var r = row.getBoundingClientRect();
      out.needScroll = r.top < 64 || r.bottom > window.innerHeight - 16;
      return out;
    }
  }
  var nb = document.querySelector('.nav button[data-page="pToday"]');
  var nr = nb ? nb.getBoundingClientRect() : null;
  out.x = nr ? nr.left + nr.width / 2 : window.innerWidth / 2;
  out.y = nr ? nr.top + nr.height / 2 : window.innerHeight - 54;
  return out;
}
function pomoDestPoint(target){
  if(target.row && target.row.isConnected){
    var ck = target.row.querySelector('.check');
    var r = ck ? ck.getBoundingClientRect() : target.row.getBoundingClientRect();
    if(r.width) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return { x: target.x, y: target.y };
}

/* 动画收尾才写状态：打钩 + 高亮脉冲 */
function pomoMarkDone(target){
  var task = target && target.task;
  if(!task){ toast('这一段做完了'); return; }
  var t0 = TODAY();
  if(!isDone(task, t0)){
    task.done = task.done || {};
    task.done[t0] = 1;
    task.doneTime = task.doneTime || {};
    task.doneTime[t0] = nowHHMM();
    save();
  }
  if(target.row && target.row.isConnected){
    var row = target.row;
    row.classList.add('done');
    var ck = row.querySelector('.check');
    if(ck) ck.classList.add('on');
    syncGroupHead(row.closest('.tcard'));
    row.classList.add('pomo-hit');
    setTimeout(function(){ if(row.isConnected) row.classList.remove('pomo-hit'); }, 260);
    toast('「' + task.title + '」已打钩');
  }else{
    var navBtn = document.querySelector('.nav button[data-page="pToday"]');
    if(navBtn){
      navBtn.classList.add('pulse');
      setTimeout(function(){ navBtn.classList.remove('pulse'); }, 620);
    }
    toast('「' + task.title + '」已打钩，回今日能看到');
  }
  renderRemind();
}

/* 完成：停表 → 内容淡出 → 收缩成点 → 飞向条目 → 打钩脉冲 → 小点淡出、浮窗收掉
   全屏里完成时先退全屏，等版面回到浮窗再量尺寸，不然起点会算在全屏坐标上 */
function finishPomo(){
  if(!pomo || pomoLock) return;
  pomoLock = true;
  var p = pomo;
  if(p.timer){ clearInterval(p.timer); p.timer = null; }
  p.running = false;
  pomoFocusDone(p.logId, p.total - p.left);   /* 手动完成按已走过的秒数记，自然归零就是整段 */
  var wasFs = !!pomoFsEl();
  if(wasFs) pomoFsExit();
  pomoWait(wasFs ? 240 : 0).then(function(){ pomoFlyOut(p); });
}

function pomoFlyOut(p){
  var box = document.getElementById('pomoBox');
  if(!box){ pomoMarkDone(pomoResolveTarget(p)); removePomo(); return; }
  if(!deckCanAnimate()){ pomoMarkDone(pomoResolveTarget(p)); removePomo(); return; }   /* 关掉动效的人直接结算 */

  var r0 = box.getBoundingClientRect();
  var cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
  var isBig = box.classList.contains('big');
  var shrink = isBig ? .16 : .3, fly = isBig ? .08 : .14;
  var target = pomoResolveTarget(p);
  box.style.animation = 'none';          /* 进场动画的 fill:both 会压住后面的 transform */
  box.style.willChange = 'transform, opacity';
  box.classList.add('finishing');

  /* 中途要是又开了新的计时（pomo 被换掉），这条链自己停下，别去动新浮窗 */
  var alive = function(){ return pomo === p; };

  pomoWait(170)                          /* 内容淡出，只剩色块 */
    .then(function(){
      if(!alive()) return;
      if(target.needScroll && target.row && target.row.scrollIntoView){
        target.row.scrollIntoView({ behavior:'smooth', block:'center' });
        return pomoWait(340);
      }
      return pomoWait(0);
    })
    .then(function(){
      if(!alive()) return;
      box.style.borderRadius = '50%';      /* 收缩的时候顺手变成圆的 */
      return pomoAnim(box, [{ transform:'scale(1)' }, { transform:'scale(' + shrink + ')' }],
        { duration:300, easing:'cubic-bezier(.4,0,.2,1)', fill:'forwards' });
    })
    .then(function(){
      if(!alive()) return;
      var dest = pomoDestPoint(target);
      var dx = dest.x - cx, dy = dest.y - cy;
      return pomoAnim(box, [
        { transform:'translate(0px,0px) scale(' + shrink + ')', opacity:1 },
        { transform:'translate(' + dx + 'px,' + dy + 'px) scale(' + fly + ')', opacity:.9 }
      ], { duration:400, easing:'cubic-bezier(.45,0,.2,1)', fill:'forwards' });
    })
    .then(function(){
      if(!alive()) return;
      pomoMarkDone(target);
      return pomoAnim(box, [{ opacity:.9 }, { opacity:0 }], { duration:160, easing:'linear', fill:'forwards' });
    })
    .then(function(){ if(alive()) removePomo(); });
}

/* 取消：确认后直接丢弃，不写任何记录 */
function cancelPomo(){
  if(!pomo || pomoLock) return;
  pomoLock = true;
  var logId = pomo.logId;
  var wasFs = !!pomoFsEl();
  if(wasFs) pomoFsExit();
  confirmBox('取消本次专注？', '本次时长不会计入统计。', function(){
    if(logId){
      S.decisionLog = S.decisionLog.filter(function(x){ return x.id !== logId; });
      save();
    }
    removePomo();
    toast('已取消，这次不计入');
  }, { okText:'确认取消', focusCancel:true });
  pomoLock = false;   /* 等她在弹窗里做决定，浮窗按钮先别锁死 */
}

function startPomo(c, btnEl){
  /* 条目自带的时长先灌进会话，之后一律只读 pomoDraft.duration，不再回退全局默认 */
  var fromItem = pomoDurationOf(c);
  if(fromItem) setPomoDuration(fromItem);
  var total = pomoDraft.duration;
  console.log('[番茄钟] 启动 ' + total + ' 秒 / ' + fmtPomo(total) + ' · ' + (c.name || ''));

  /* 记下按钮本来的字，取消/完成之后照着还原 */
  if(btnEl && !btnEl.dataset.on) btnEl.dataset.on = btnEl.textContent.trim();
  var btnText = btnEl ? (btnEl.dataset.on || '现在开始') : '';
  removePomo();
  pomo = { total: total, left: total, running: true, name: c.name,
           suggId: c.ref ? c.ref.id : '', btnEl: btnEl, btnText: btnText,
           logId: logDecision(c, total) };
  var box = el('div','pomo');
  box.id = 'pomoBox';
  box.innerHTML =
    '<div class="pomo-h"><span class="pomo-n" id="pomoName"></span>' +
      '<button class="pomo-ico" id="pomoFs" title="全屏专注">⛶</button>' +
      '<button class="pomo-ico wide" id="pomoExit" title="退出全屏">退出全屏</button>' +
    '</div>' +
    '<div class="pomo-t" id="pomoTime"></div>' +
    '<div class="pomo-bar"><i id="pomoBar" style="width:100%"></i></div>' +
    '<div class="pomo-acts">' +
      '<button class="pomo-btn" id="pomoPause">暂停</button>' +
      '<button class="pomo-btn p" id="pomoDone">完成</button>' +
      '<button class="pomo-btn ghost" id="pomoCancel">取消</button>' +
    '</div>';
  document.body.appendChild(box);
  document.body.classList.add('pomo-on');
  box.querySelector('#pomoName').textContent = c.name;
  box.querySelector('#pomoTime').textContent = fmtPomo(total);
  box.querySelector('#pomoTime').classList.toggle('long', total >= 3600);

  var tEl = box.querySelector('#pomoTime'), barEl = box.querySelector('#pomoBar');
  box.querySelector('#pomoPause').addEventListener('click', function(){
    if(!pomo || pomoLock) return;
    pomo.running = !pomo.running;
    this.textContent = pomo.running ? '暂停' : '继续';
  });
  box.querySelector('#pomoDone').addEventListener('click', finishPomo);
  box.querySelector('#pomoCancel').addEventListener('click', cancelPomo);
  box.querySelector('#pomoFs').addEventListener('click', pomoFsEnter);
  box.querySelector('#pomoExit').addEventListener('click', pomoLeaveBig);

  pomo.timer = setInterval(function(){
    if(!pomo || !pomo.running) return;
    pomo.left--;
    if(pomo.left <= 0){
      clearInterval(pomo.timer);
      pomo.timer = null;
      pomo.left = 0;
      pomo.running = false;
      tEl.textContent = fmtPomo(0);
      barEl.style.width = '0%';
      pomoNotifyDone(pomo.name);          /* 只在自然归零时通知，不阻塞下面的飞点动画 */
      setTimeout(function(){ if(pomo) finishPomo(); }, 1600);
      return;
    }
    tEl.textContent = fmtPomo(pomo.left);
    tEl.classList.toggle('long', pomo.left >= 3600);
    barEl.style.width = (pomo.left / pomo.total * 100).toFixed(1) + '%';
  }, 1000);

  toast('开始计时 ' + fmtPomo(total));
  pomoAskNotification();                /* 首次点「现在开始」时请求权限，用户手势内 */
  if(btnEl){ btnEl.textContent = '计时中'; }
}

/* ---------- 随机结果单卡 ---------- */
function renderDecisionResult(){
  var box = $('decResult');
  box.innerHTML = '';
  if(!decState.list.length) return;
  var c = decState.list[decState.idx % decState.list.length];
  var card = el('div','res');
  card.appendChild(el('div','res-k','随机抽到'));
  card.appendChild(el('div','res-t', c.name));
  if(c.sub) card.appendChild(el('div','res-d', c.sub));
  var meta = el('div','res-meta');
  if(c.catLabel) meta.appendChild(el('span','mtag', c.catLabel));
  if(c.duration) meta.appendChild(el('span','mtag', '大约 ' + durText(c.duration)));
  card.appendChild(meta);
  var acts = el('div','res-acts');
  var go = el('button','btn p','现在开始');
  go.addEventListener('click', function(){ startPomo(c, go); });
  var add = el('button','btn g','加入待办');
  add.addEventListener('click', function(){ addAsTask(c, add); });
  var again = el('button','btn o','换一个');
  again.addEventListener('click', function(){
    card.style.transition = 'opacity .45s var(--ease), transform .45s var(--ease)';
    card.style.opacity = '0';
    card.style.transform = 'translateY(-6px)';
    setTimeout(runRandom, 200);
  });
  acts.appendChild(go); acts.appendChild(add); acts.appendChild(again);
  card.appendChild(acts);
  box.appendChild(card);
}

function runRandom(){
  var p = randomPick(S.settings.randFilter);
  if(!p){ toast('清单里没有可抽的，先加几条待办'); return; }
  decState.mode = 'random';
  decState.list = [p]; decState.idx = 0;
  decState.filter = S.settings.randFilter;
  renderDecisionResult();
  setTimeout(function(){
    var b = $('decResult');
    if(b && b.scrollIntoView) b.scrollIntoView({ behavior:'smooth', block:'center' });
  }, 60);
}

/* ---------- 建议库 ---------- */
function libCats(){
  var set = {};
  S.suggestions.forEach(function(sg){ set[sg.cat] = 1; });
  return Object.keys(set);
}
function renderLib(){
  var fbox = $('libFilter');
  fbox.innerHTML = '';
  var cats = ['全部'].concat(libCats());
  cats.forEach(function(c){
    var b = el('button','chip' + (S.settings.libFilter === c ? ' on' : ''), c);
    b.addEventListener('click', function(){ S.settings.libFilter = c; save(); renderLib(); });
    fbox.appendChild(b);
  });

  var box = $('libWrap');
  box.innerHTML = '';
  var q = libQuery.trim().toLowerCase();
  var list = S.suggestions.filter(function(sg){
    if(S.settings.libFilter !== '全部' && sg.cat !== S.settings.libFilter) return false;
    if(!q) return true;
    var hay = [sg.name, sg.note || '', sg.cat, (sg.scenes||[]).map(sceneName).join(' ')].join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  });
  var total = list.length;
  if(!libOpen) list = list.slice(0, 6);
  if(!list.length){
    box.appendChild(el('div','empty', libQuery ? '没找到「' + libQuery + '」相关的建议。' : '这个分类下还没有建议，点「+ 新建」加一条。'));
    return;
  }
  list.forEach(function(sg){
    var item = el('div','lib-item' + (sg.enabled ? '' : ' off'));
    var h = el('div','lib-h');
    h.appendChild(el('div','lib-t', sg.name));
    var sw = el('button','sw' + (sg.enabled ? ' on' : ''));
    sw.title = sg.enabled ? '关掉' : '打开';
    sw.addEventListener('click', function(ev){
      ev.stopPropagation();
      sg.enabled = !sg.enabled; save(); renderLib();
    });
    h.appendChild(sw);
    item.appendChild(h);

    var d = el('div','lib-d');
    d.appendChild(el('span', null, sg.cat));
    if(sg.duration) d.appendChild(el('span', null, durText(sg.duration)));
    if(!sg.random) d.appendChild(el('span', null, '不参与随机'));
    if((sg.scenes||[]).length){
      d.appendChild(el('span', null, '情境：' + sg.scenes.map(sceneName).join('、')));
    }
    item.appendChild(d);
    item.addEventListener('click', function(){ openSuggEdit(sg); });
    box.appendChild(item);
  });

  if(total > 6){
    var more = el('button','tl-load', libOpen ? '收起' : ('展开全部 ' + total + ' 条'));
    more.style.margin = '10px 0 4px';
    more.addEventListener('click', function(){ libOpen = !libOpen; renderLib(); });
    box.appendChild(more);
  }
}
function openSuggEdit(sg){
  var isNew = !sg;
  var item = sg || { id: uid('s'), name:'', cat:'生活', duration:900, tags:[], scenes:[], times:['any'], priority:2, random:true, enabled:true, note:'' };
  var cats = ['身体','健身','学习','生活','心情','其它'].concat(libCats()).filter(function(v,i,a){ return a.indexOf(v) === i; });
  var sceneHtml = SCENES.map(function(sc){
    return '<button class="chip' + ((item.scenes||[]).indexOf(sc.k) >= 0 ? ' on' : '') + '" data-k="' + sc.k + '">' + sc.n + '</button>';
  }).join('');
  var body = openSheet(
    '<div class="shd"><div class="shd-t">' + (isNew ? '新建一条建议' : '改这条建议') + '</div>' +
    '<div class="shd-s">给它绑上情境，选那个情境时就会出现。</div></div>' +
    '<div class="field"><div class="field-l">做什么</div><input class="inp" id="sgN" maxlength="24" placeholder="写一件具体的事" value="' + esc(item.name) + '"></div>' +
    '<div class="field"><div class="field-l">分类</div><input class="inp" id="sgC" maxlength="8" list="libCatList" value="' + esc(item.cat) + '">' +
      '<datalist id="libCatList">' + cats.map(function(c){ return '<option value="' + esc(c) + '">'; }).join('') + '</datalist></div>' +
    '<div class="field"><div class="field-l">专注时长</div>' +
      '<div class="chips" id="sgQuick">' +
        POMO_PRESETS.map(function(p){ return '<button class="chip" data-s="' + p.s + '">' + p.n + '</button>'; }).join('') +
      '</div>' +
      '<div class="dur-row">' +
        '<input class="inp" id="sgM" type="number" inputmode="numeric" min="0" max="599" value="' + durParts(item.duration).m + '"><span>分</span>' +
        '<input class="inp" id="sgS" type="number" inputmode="numeric" min="0" max="59" value="' + durParts(item.duration).s + '"><span>秒</span>' +
      '</div></div>' +
    '<div class="field"><div class="field-l">什么时候适合</div><div class="chips" id="sgT">' +
      ['morning','afternoon','evening','night','any'].map(function(k){
        return '<button class="chip' + ((item.times||[]).indexOf(k) >= 0 ? ' on' : '') + '" data-k="' + k + '">' +
          ({morning:'上午',afternoon:'下午',evening:'傍晚',night:'夜里',any:'随时'})[k] + '</button>';
      }).join('') + '</div></div>' +
    '<div class="field"><div class="field-l">适用情境（可多选）</div><div class="chips" id="sgSc">' + sceneHtml + '</div></div>' +
    '<div class="field"><div class="field-l">一句话备注</div><input class="inp" id="sgX" maxlength="30" placeholder="具体怎么做" value="' + esc(item.note || '') + '"></div>' +
    '<div class="row" style="border-top:none;padding:4px 0 10px"><div class="row-main"><div class="row-t">参与随机抽取</div><div class="row-s">关掉就只在情境里看得到</div></div>' +
      '<div class="row-a"><button class="sw' + (item.random ? ' on' : '') + '" id="sgR"></button></div></div>' +
    '<div class="acts">' + (isNew ? '' : '<button class="btn d fx" id="sgDel">删除</button>') +
      '<button class="btn g" id="sgNo">取消</button><button class="btn p" id="sgOk">保存</button></div>'
  );
  var times = (item.times || []).slice();
  var scenes = (item.scenes || []).slice();

  /* 时长：预设和分秒输入都立刻写入会话 pomoDraft.duration，启动只读它 */
  var sgM = body.querySelector('#sgM'), sgS = body.querySelector('#sgS');
  var sgQuick = body.querySelectorAll('#sgQuick .chip');
  function markDur(sec){
    sgQuick.forEach(function(x){ x.classList.toggle('on', +x.dataset.s === sec); });
  }
  function syncDur(sec){
    var parts = durParts(sec);
    sgM.value = parts.m; sgS.value = parts.s;
    markDur(sec);
    setPomoDuration(Math.max(1, sec));
  }
  sgQuick.forEach(function(c){
    c.addEventListener('click', function(){ syncDur(+c.dataset.s); });
  });
  [sgM, sgS].forEach(function(inp){
    inp.addEventListener('input', function(){
      var sec = durFromInputs(sgM, sgS);
      markDur(sec);
      if(sec > 0) setPomoDuration(sec);
    });
  });
  markDur(Math.round(+item.duration || 0));

  body.querySelectorAll('#sgT .chip').forEach(function(c){
    c.addEventListener('click', function(){
      var k = c.dataset.k;
      if(k === 'any') times = times.indexOf('any') >= 0 ? [] : ['any'];
      else{
        var i = times.indexOf(k);
        if(i >= 0) times.splice(i,1); else times.push(k);
        times = times.filter(function(x){ return x !== 'any'; });
      }
      body.querySelectorAll('#sgT .chip').forEach(function(x){
        x.classList.toggle('on', times.indexOf(x.dataset.k) >= 0);
      });
    });
  });
  body.querySelectorAll('#sgSc .chip').forEach(function(c){
    c.addEventListener('click', function(){
      var k = c.dataset.k, i = scenes.indexOf(k);
      if(i >= 0) scenes.splice(i,1); else scenes.push(k);
      c.classList.toggle('on');
    });
  });
  body.querySelector('#sgNo').addEventListener('click', closeSheet);
  if(!isNew){
    body.querySelector('#sgDel').addEventListener('click', function(){
      confirmBox('删掉这条建议？', '它不会再出现在情境和随机里。', function(){
        S.suggestions = S.suggestions.filter(function(x){ return x.id !== item.id; });
        save(); closeSheet(); renderLib(); toast('已删除');
      });
    });
  }
  body.querySelector('#sgOk').addEventListener('click', function(){
    var n = body.querySelector('#sgN').value.trim();
    if(!n){ toast('写一下做什么'); return; }
    item.name = n;
    item.cat = body.querySelector('#sgC').value.trim() || '其它';
    item.duration = durFromInputs(body.querySelector('#sgM'), body.querySelector('#sgS'));
    if(item.duration) setPomoDuration(item.duration);
    item.note = body.querySelector('#sgX').value.trim();
    item.times = times.length ? times : ['any'];
    item.scenes = scenes;
    item.random = body.querySelector('#sgR').classList.contains('on');
    if(isNew){ item.enabled = true; item.priority = 2; item.tags = []; S.suggestions.push(item); }
    save(); closeSheet(); renderLib();
    if(decState.scene && decState.mode === 'scene' && currentPage === 'pDecide') renderSceneResult(decState.scene);
    toast('已保存');
  });
}

