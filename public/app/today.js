/* today.js — 今日：提醒/待办/重点/计划/日程/汇总/标签速记 */
/* ==================== 今日：提醒 ====================
   提醒内容来自计划安排（S.plans）：当天及以前到期、尚未完成的计划。
   不读健身/学习统计、不混入普通待办；无符合条件的计划时整个区域不渲染。 */
function duePlansToday(){
  var t0 = TODAY();
  return planSorted().filter(function(p){ return !p.done && p.date <= t0; });
}
function renderRemind(){
  var box = $('remindWrap');
  if(!box) return;
  box.innerHTML = '';
  var t0 = TODAY();
  if(S.settings.remindDismissed === t0) return;
  var list = duePlansToday();
  if(!list.length) return;

  var wrap = el('div','remind');
  list.slice(0,2).forEach(function(p){
    var row = el('div','remind-line');
    var sp = el('span', null, U('today.remind.planPrefix') + p.title);
    var a = el('button','remind-act', U('today.action.goPlanShort'));
    a.addEventListener('click', openPlanView);
    row.appendChild(sp); row.appendChild(a);
    wrap.appendChild(row);
  });
  var x = el('button','remind-x','×');
  x.title = '今天不再提醒';
  x.addEventListener('click', function(){
    S.settings.remindDismissed = t0; save(); renderRemind();
  });
  var first = wrap.firstChild;
  first.appendChild(x);
  box.appendChild(wrap);
}

/* ==================== 今日：待办 ====================
   taskUI.inline 是「正在加一条」的唯一真源；DOM 只是它的投影。
   renderTasks() 只负责照着 state 重建 DOM 和 data-action，不绑事件、不管焦点、不调别的 render。 */
var taskUI = { inline: null };     // null 或 { cat, value }
var taskBlurTimer = null;
var APP_BOUND = false;

function taskVisible(t, t0){
  if(t.archived) return false;
  if(isRoutineTask(t)) return taskOnDay(t, t0);   // 重复项：到日子就出现，勾选按天记
  if(isDone(t, t0)) return true;
  // 一次性任务：只要以前完成过就不再出现
  return doneCountOn(t) === 0;
}
/* 重复任务：daily = 每天；weekly = 只在选中的星期几出现 */
function isRoutineTask(t){
  return t.repeat === 'daily' || t.repeat === 'weekly';
}
function taskOnDay(t, date){
  if(t.repeat === 'daily') return true;
  if(t.repeat === 'weekly'){
    if(!Array.isArray(t.weekdays) || !t.weekdays.length) return false;
    return t.weekdays.indexOf(parse(date).getDay()) >= 0;
  }
  return true;
}
var WEEK_CN = ['日','一','二','三','四','五','六'];
/* 星期文案用静态 key 取（动态 key 规范不允许） */
function weekName(d){
  if(d === 0) return U('common.weekday.sun');
  if(d === 1) return U('common.weekday.mon');
  if(d === 2) return U('common.weekday.tue');
  if(d === 3) return U('common.weekday.wed');
  if(d === 4) return U('common.weekday.thu');
  if(d === 5) return U('common.weekday.fri');
  return U('common.weekday.sat');
}
function weekLabel(t){
  if(t.repeat === 'daily') return U('today.repeat.daily');
  if(t.repeat === 'weekly'){
    var wd = (Array.isArray(t.weekdays) ? t.weekdays : []).slice().sort();
    if(!wd.length) return U('today.repeat.weekly');
    return U('today.repeat.weekPrefix') + wd.map(function(n){ return WEEK_CN[n]; }).join('、');
  }
  return '';
}
function tasksOf(cat, t0){
  return S.tasks.filter(function(t){
    /* 'today' = 合并视图：旧分类字段原样保留，只是不再分开展示 */
    return (cat === 'today' || t.cat === cat) && taskVisible(t, t0) && !isSkipped(t, t0);
  });
}
/* 合并视图里「普通待办」= 不含重复项；重复项单独成排 */
function tasksOfPlain(cat, t0){
  return tasksOf(cat, t0).filter(function(t){ return !isRoutineTask(t); });
}
function tasksOfRoutine(t0){
  return S.tasks.filter(function(t){
    return isRoutineTask(t) && taskVisible(t, t0) && !isSkipped(t, t0);
  });
}
function dueText(t){
  if(!t.due) return '';
  var d = diffDays(t.due, TODAY());
  if(d < 0) return '逾期 ' + Math.abs(d) + ' 天';
  if(d === 0) return '今天到期';
  if(d === 1) return '明天到期';
  return (parse(t.due).getMonth()+1) + '月' + parse(t.due).getDate() + '日到期';
}

function renderTasks(){
  var box = $('taskWrap');
  rvMarkKeep(box);
  box.innerHTML = '';
  var t0 = TODAY();

  /* 折叠态与展开态共用同一批节点：这里只按当前状态生成静态结构，
     折叠/展开动作本身不再重建 DOM，改由 setDeckFold 做双向插值。 */
  box.appendChild(buildTaskDeck(t0));
}

/* 一个分类 = 一张卡 */
function buildTaskCard(cat, t0){
  var card = el('div','card tcard');
  card.dataset.cat = cat;
  var list = tasksOfPlain(cat, t0);

  var head = el('div','th');
  head.appendChild(el('div','th-n', cat === 'today' ? U('today.card.tasks') : CAT_LABEL[cat]));
  var doneN = list.filter(function(t){ return isDone(t, t0); }).length;
  head.appendChild(el('div','th-c', list.length ? doneN + '/' + list.length : ''));
  var all = el('button','allbtn' + (list.length && doneN === list.length ? ' on' : ''));
  all.title = '这一组全勾上';
  all.dataset.action = 'group-all';
  head.appendChild(all);
  card.appendChild(head);

  /* 隐藏已完成入口已移除：全部显示，但未完成的排前面、已完成的沉到下面。
     用稳定排序，组内保持原有先后顺序。 */
  var shown = list.slice().sort(function(a, b){
    return (isDone(a, t0) ? 1 : 0) - (isDone(b, t0) ? 1 : 0);
  });
  if(!shown.length){
    var hint = cat === 'today' ? U('today.empty.tasks') : '这一组都做完了';
    if(!list.length && cat !== 'today'){
      hint = cat === CAT_MUST ? '没有赶时间的事' : (cat === CAT_WANT ? '今天还没想好要做什么' : '还没有每天要做的事');
    }
    card.appendChild(el('div','empty', hint));
  }
  shown.forEach(function(t){ card.appendChild(buildTaskRow(t, cat)); });

  if(taskUI.inline && taskUI.inline.cat === cat) card.appendChild(buildInlineAdd(taskUI.inline));
  var add = el('div','addline');
  add.dataset.action = 'add-open';
  add.dataset.cat = cat;
  add.innerHTML = '<b>+</b> 加一条';
  card.appendChild(add);

  /* 每天都显示的那一排：重复项单独成段，和普通待办分开 */
  if(cat === 'today') card.appendChild(buildRoutineSection(t0));
  return card;
}

/* 每日重复区：标题 + 各条重复 + 自己的「加一条」 */
function buildRoutineSection(t0){
  var list = tasksOfRoutine(t0);
  var sec = el('div','routine-sec');

  var head = el('div','routine-head');
  head.appendChild(el('div','routine-t', U('today.section.routine')));
  var doneN = list.filter(function(t){ return isDone(t, t0); }).length;
  head.appendChild(el('div','routine-c', list.length ? doneN + '/' + list.length : ''));
  sec.appendChild(head);

  if(!list.length){
    sec.appendChild(el('div','routine-empty', U('today.empty.routine')));
  }
  list.slice().sort(function(a, b){
    return (isDone(a, t0) ? 1 : 0) - (isDone(b, t0) ? 1 : 0);
  }).forEach(function(t){ sec.appendChild(buildTaskRow(t, CAT_ROUTINE)); });

  if(taskUI.inline && taskUI.inline.cat === CAT_ROUTINE) sec.appendChild(buildInlineAdd(taskUI.inline));
  var add = el('div','addline routine-add');
  add.dataset.action = 'add-open';
  add.dataset.cat = CAT_ROUTINE;
  add.innerHTML = '<b>+</b> ' + UH('today.action.addRoutine');
  sec.appendChild(add);
  return sec;
}

/* 输入行只是投影：没有闭包、没有监听、没有焦点副作用 */
function buildInlineAdd(st){
  var wrap = el('div','inline-add');
  var inp = document.createElement('input');
  inp.id = 'taskInlineInput';
  inp.type = 'text';
  inp.maxLength = 30;
  inp.value = st.value || '';
  inp.placeholder = U('today.placeholder.task');
  var ok = el('button','ok',U('common.action.add'));
  ok.dataset.action = 'add-ok';
  var no = el('button','no','×');
  no.dataset.action = 'add-cancel';
  wrap.appendChild(inp); wrap.appendChild(ok); wrap.appendChild(no);
  return wrap;
}

/* 一条待办的行；勾选只改这一行，不重画整张卡 */
function buildTaskRow(t, cat){
  var t0 = TODAY();
  var done = isDone(t, t0);
  var row = el('div','task' + (done ? ' done' : ''));
  row.dataset.tid = t.id;
  row.dataset.action = 'task-toggle';
  var ck = el('div','check' + (done ? ' on' : ''));
  var main = el('div','task-main');
  main.appendChild(el('div','task-t', t.title));

  var metaBits = [];
  /* 截止日期与时长都只属于一次性任务：重复项每天都来，两者都没有去处，不占位 */
  if(t.due && !isRoutineTask(t)) metaBits.push({ txt: dueText(t), cls:'due' });
  var wl = weekLabel(t);
  if(wl) metaBits.push({ txt: wl, cls:'rep' });
  if(t.duration && !isRoutineTask(t)) metaBits.push({ txt: durText(t.duration), cls:'' });
  if(t.note) metaBits.push({ txt: t.note, cls:'' });
  if(metaBits.length){
    var m = el('div','task-m');
    metaBits.forEach(function(b){
      var s = el('span', b.cls || null, b.txt);
      m.appendChild(s);
    });
    main.appendChild(m);
  }

  var more = el('button','task-more','⋯');
  more.title = '更多';
  more.dataset.action = 'task-more';

  row.appendChild(ck); row.appendChild(main); row.appendChild(more);
  return row;
}

/* 卡片堆叠：展开态与折叠态共用同一批持久节点。
   .deck[data-fold] 同时承载两种静态视觉（层参数只写在 today.css，避免两套来源竞争）；
   切换只改状态 + 用 WAAPI 从当前视觉值插值到目标静态值，不再销毁 DOM 重建。 */
var DECK_MS = 1200;
var DECK_EASE = 'cubic-bezier(.22,1,.36,1)';
var DECK_ANIM_PROPS = ['transform','opacity','height','paddingTop','paddingBottom','marginTop','borderTopWidth','borderBottomWidth'];
function deckCanAnimate(){
  return !!(window.Element && Element.prototype.animate) &&
    !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/* 持久 DOM：主卡 + 两张装饰底牌始终存在，内容视图用 opacity/height 切换 */
function buildTaskDeck(t0){
  var deck = el('div','deck');
  deck.dataset.fold = S.settings.tasksFold ? '1' : '0';
  deck.appendChild(deckBackCard('l2'));
  deck.appendChild(deckBackCard('l1'));

  var stage = el('div','deck-stage');
  var due = buildDuePlanGroup();
  if(due){
    var dueCard = el('div','card tcard');
    dueCard.dataset.cat = 'due';
    dueCard.appendChild(due);
    stage.appendChild(dueCard);
  }

  /* 主卡：折叠态只显示 .deck-peek，展开态只显示 .card-body；两视图常驻同一节点 */
  var main = buildTaskCard('today', t0);
  main.classList.add('main');
  main.dataset.action = 'deck-open';
  var body = el('div','card-body');
  var head = main.firstChild;
  Array.prototype.slice.call(main.children).forEach(function(ch){
    if(ch !== head) body.appendChild(ch);
  });
  main.appendChild(body);
  var peek = el('div','deck-peek');
  peek.appendChild(el('div','deck-peek-in', U('today.empty.tasksExpand')));
  main.appendChild(peek);

  stage.appendChild(main);
  if(pluginOn('tags')){
    var tagCard = el('div','card tagcard');
    tagCard.appendChild(buildTagFoot());
    stage.appendChild(tagCard);
  }
  deck.appendChild(stage);

  /* 卡片上边缘书签：点一下展开 / 收起，始终常驻不随动画重建 */
  var bm = el('button','deck-bookmark');
  bm.dataset.action = 'fold-tasks';
  bm.setAttribute('aria-label', S.settings.tasksFold ? '展开待办' : '收起待办');
  bm.textContent = S.settings.tasksFold ? '▾' : '▴';
  deck.appendChild(bm);

  return deck;
}
function deckBackCard(k){
  var d = el('div','deck-l ' + k);
  d.setAttribute('aria-hidden','true');
  return d;
}

/* 双向状态切换：
   1) 在改状态前快照当前视觉值（含被中断动画的中间帧）；
   2) 取消旧动画（cancel 后回到当前 data-fold 的 CSS 静态，视觉不变）；
   3) 切 data-fold，让 CSS 成为唯一目标状态；
   4) WAAPI 从快照插值到新 CSS 静态，末帧 cancel 后与静态完全一致。 */
var deckAnims = null;
function deckVisual(n){
  var cs = getComputedStyle(n), v = {};
  DECK_ANIM_PROPS.forEach(function(p){ v[p] = cs[p]; });
  return v;
}
function setDeckFold(toFold){
  var box = $('taskWrap');
  var deck = box && box.querySelector('.deck');
  if(!deck) return;
  var want = toFold ? '1' : '0';
  if(deck.dataset.fold === want) return;

  var nodes = [].slice.call(deck.querySelectorAll('.deck-l.l1, .deck-l.l2, .deck-stage > .card, .card-body, .deck-peek'));
  var before = nodes.map(deckVisual);

  if(deckAnims){ deckAnims.forEach(function(a){ a.cancel(); }); deckAnims = null; }

  deck.dataset.fold = want;
  S.settings.tasksFold = toFold;
  save();
  var bm = deck.querySelector('.deck-bookmark');
  if(bm){
    bm.textContent = toFold ? '▾' : '▴';
    bm.setAttribute('aria-label', toFold ? '展开待办' : '收起待办');
  }

  if(!deckCanAnimate()) return;

  var after = nodes.map(deckVisual);
  /* 每批动画各自持有一份数组；settle 只回收自己那一批，
     避免连点时上一批的 finished 回调把刚创建的新动画取消掉。 */
  var batch = nodes.map(function(n, i){
    return n.animate([before[i], after[i]], { duration: DECK_MS, easing: DECK_EASE, fill: 'both' });
  });
  deckAnims = batch;
  var settle = function(){
    if(deckAnims !== batch) return;
    batch.forEach(function(a){ a.cancel(); });
    deckAnims = null;
  };
  var last = batch[batch.length - 1];
  if(last && last.finished && typeof last.finished.then === 'function') last.finished.then(settle, settle);
  else if(last) last.onfinish = settle;
  else settle();
}
function unfoldTasks(){ setDeckFold(false); }

/* 重算某张卡的计数和全勾按钮（重复项有自己的一行计数） */
function syncGroupHead(card){
  if(!card || !card.dataset.cat || card.dataset.cat === 'due') return;
  var cat = card.dataset.cat, t0 = TODAY();
  var list = tasksOfPlain(cat, t0);
  var doneN = list.filter(function(t){ return isDone(t, t0); }).length;
  var cnt = card.querySelector('.th-c');
  if(cnt) cnt.textContent = list.length ? doneN + '/' + list.length : '';
  var all = card.querySelector('.allbtn');
  if(all) all.classList.toggle('on', !!list.length && doneN === list.length);

  var rc = card.querySelector('.routine-c');
  if(rc){
    var rl = tasksOfRoutine(t0);
    var rd = rl.filter(function(t){ return isDone(t, t0); }).length;
    rc.textContent = rl.length ? rd + '/' + rl.length : '';
  }
}

function buildTagFoot(){
  var t0 = TODAY();
  var foot = el('div','tagfoot');
  foot.appendChild(el('div','tf-l',U('common.noun.tag')));

  var counts = {};
  S.tagLogs.forEach(function(l){ if(l.date === t0) counts[l.tagId] = (counts[l.tagId]||0)+1; });

  S.tags.slice(0, 4).forEach(function(t){
    var b = el('button','chip' + (counts[t.id] ? ' on' : ''));
    b.dataset.tag = t.id;
    b.dataset.action = 'tag-quick';
    b.innerHTML = esc(t.name) + (counts[t.id] ? '<b>+' + counts[t.id] + '</b>' : '');
    foot.appendChild(b);
  });

  var add = el('button','tf-add','＋');
  add.title = '全部标签 / 新建';
  add.dataset.action = 'tags-sheet';
  foot.appendChild(add);
  return foot;
}
/* 点一下标签就记一次；数字从 S.tagLogs 现算，不依赖闭包里的旧计数 */
function tagQuick(b){
  var id = b.dataset.tag, t0 = TODAY();
  var tag = byId(S.tags, id);
  if(!tag) return;
  S.tagLogs.push({ id: uid('l'), tagId: id, date: t0, ts: Date.now() });
  save();
  var n = 0;
  S.tagLogs.forEach(function(l){ if(l.date === t0 && l.tagId === id) n++; });
  b.className = 'chip on';
  b.innerHTML = esc(tag.name) + '<b>+' + n + '</b>';
  var r = b.getBoundingClientRect();
  floatText('+1', r.left + r.width/2, r.top - 2);
  buzz();
}

function toggleTask(t, row){
  var t0 = TODAY();
  if(isDone(t, t0)){ delete t.done[t0]; if(t.doneTime) delete t.doneTime[t0]; }
  else { t.done[t0] = 1; t.doneTime = t.doneTime || {}; t.doneTime[t0] = nowHHMM(); }
  save(); buzz();
  // 只更新被点的那一行：完成 = 划删除线留在原地，不消失
  if(row){
    var done = isDone(t, t0);
    row.classList.toggle('done', done);
    row.querySelector('.check').classList.toggle('on', done);
    syncGroupHead(row.closest('.tcard'));
  }else{
    renderTasks();
  }
  renderRemind();
}
function toggleAll(cat, card){
  var t0 = TODAY();
  var list = tasksOfPlain(cat === 'today' ? 'today' : cat, t0);
  if(!list.length){ toastCfg('focusEmptyHint'); return; }
  var allDone = list.every(function(t){ return isDone(t, t0); });
  list.forEach(function(t){
    if(allDone){ delete t.done[t0]; if(t.doneTime) delete t.doneTime[t0]; }
    else { t.done[t0] = 1; t.doneTime = t.doneTime || {}; t.doneTime[t0] = nowHHMM(); }
  });
  save(); buzz();
  // 只更新这一组里的行，完成的留原地划删除线
  if(card){
    card.querySelectorAll('.task').forEach(function(row){
      var tid = row.dataset.tid;
      var t = null;
      for(var i = 0; i < list.length; i++) if(list[i].id === tid) t = list[i];
      if(!t) return;
      var done = isDone(t, t0);
      row.classList.toggle('done', done);
      row.querySelector('.check').classList.toggle('on', done);
    });
    syncGroupHead(card);
  }else{
    renderTasks();
  }
  renderRemind();
  toastCfg(allDone ? 'taskGroupCancelled' : 'taskGroupAllDone');
}

/* ---------- 输入行的动作：改 state → render → （按需）聚焦 ---------- */
/* 焦点管理只在这里做，且只在用户主动动作之后调用；render 里绝不碰焦点 */
function focusTaskInput(){
  var inp = document.getElementById('taskInlineInput');
  if(inp && document.activeElement !== inp) inp.focus();
}
function openInline(cat){
  clearTimeout(taskBlurTimer);
  if(taskUI.inline && taskUI.inline.cat === cat){ focusTaskInput(); return; }
  taskUI.inline = { cat:cat, value:'' };
  renderTasks();
  focusTaskInput();
}
function commitInline(){
  clearTimeout(taskBlurTimer);
  var st = taskUI.inline;
  if(!st) return;
  var v = String(st.value || '').trim();
  if(v){
    var cat = st.cat === 'today' ? CAT_WANT : st.cat;
    S.tasks.push({
      id: uid('t'), title:v, cat:cat,
      repeat: cat === CAT_ROUTINE ? 'daily' : 'once',
      due:'', duration:0, done:{}, createdAt: Date.now()
    });
    save(function(){ toastCfg(cat === CAT_ROUTINE ? 'taskAddedRoutine' : 'taskAddedTodayList'); });
  }
  /* 加完留一个空输入行，连着加第二条第三条；不再靠 DOM 残留来「保持焦点」 */
  taskUI.inline = { cat:st.cat, value:'' };
  renderTasks();
  focusTaskInput();
}
/* silent = 只摘掉输入行（点击别处时用，避免整卡重渲染打断勾选动画） */
function cancelInline(silent){
  clearTimeout(taskBlurTimer);
  if(!taskUI.inline) return;
  taskUI.inline = null;
  var row = document.querySelector('#taskWrap .inline-add');
  if(silent){
    if(row) row.remove();
  }else{
    renderTasks();
  }
}
function toggleTasksFold(){
  /* 收拢 / 展开走同一套双向状态机，不因方向不同而重建 DOM */
  setDeckFold(!S.settings.tasksFold);
}

/* ==================== 单一事件委托 ====================
   document 上每种事件只绑一次；按钮统一 data-action，closest 分发。
   内容怎么重建、页面怎么切，监听都在；render 不绑事件、不碰焦点。 */
function onAppClick(e){
  var hit = e.target.closest && e.target.closest('[data-action]');
  /* 点输入行以外的地方就收起它：不依赖 focus/blur 事件是否真的派发，
     手机上键盘弹起、指针中断也不会再把输入行卡住 */
  if(taskUI.inline && !(e.target.closest && e.target.closest('.inline-add'))) cancelInline(true);
  if(!hit) return;
  var a = hit.dataset.action, t, p, card, row;

  switch(a){
    case 'go-home':       showPage('pToday'); return;
    case 'scene-full':    chooseScene(hit.dataset.k); return;
    case 'add-open':      openInline(hit.dataset.cat); return;
    case 'add-ok':        commitInline(); return;
    case 'add-cancel':    cancelInline(); return;
    case 'fold-tasks':    toggleTasksFold(); return;
    case 'deck-open':     unfoldTasks(); return;
    case 'tags-sheet':    openTagsSheet(); return;
    case 'tag-quick':     tagQuick(hit); return;
    case 'group-all':
      card = hit.closest('.tcard');
      if(card && card.dataset.cat) toggleAll(card.dataset.cat, card);
      return;
    case 'task-toggle':
      t = byId(S.tasks, hit.dataset.tid);
      if(t) toggleTask(t, hit);
      return;
    case 'task-more':
      row = hit.closest('.task');
      t = row && byId(S.tasks, row.dataset.tid);
      if(t) openTaskActions(t);
      return;
    case 'due-toggle':
      row = hit.closest('.task');
      p = row && byId(S.plans, row.dataset.pid);
      if(p) togglePlanDone(p);
      return;
    case 'due-more':
      row = hit.closest('.task');
      p = row && byId(S.plans, row.dataset.pid);
      if(p) openPlanActions(p);
      return;
    case 'goal-open':
      t = byId(S.settings.focusItems, hit.dataset.iid);
      if(t) tapFocusItem(t, hit);
      return;
    case 'goal-edit':
      t = byId(S.settings.focusItems, hit.dataset.iid);
      if(t) openFocusEdit(t, false);
      return;
    case 'goal-new':
      openFocusEdit(null, true);
      return;
    case 'lib-fold':      toggleLibFold(hit); return;
    case 'menu-fold':     toggleMenuFold(hit); return;
  }
}
/* 打字只改 state，不重渲染，光标不跳 */
function onAppInput(e){
  if(e.target.id === 'taskInlineInput' && taskUI.inline) taskUI.inline.value = e.target.value;
}
function onAppKeydown(e){
  if(e.key === 'Escape' && typeof pomoLeaveBig === 'function') pomoLeaveBig();
  if(e.target.id !== 'taskInlineInput' || !taskUI.inline) return;
  if(e.key === 'Enter'){ e.preventDefault(); commitInline(); }
  if(e.key === 'Escape'){ e.preventDefault(); cancelInline(); }
}
/* 点「加上 / ×」时别让输入框先失焦，blur 就不会抢在 click 前面 */
function onAppPointerDown(e){
  if(e.target.closest && e.target.closest('[data-action="add-ok"],[data-action="add-cancel"]')) e.preventDefault();
}
/* 焦点真的离开输入行：100ms debounce 后收起，不自动提交、不写数据 */
function onAppFocusOut(e){
  if(e.target.id !== 'taskInlineInput' || !taskUI.inline) return;
  if(e.target.isConnected === false) return;   /* 提交后旧输入框被移除时冒出来的失焦，不算 */
  clearTimeout(taskBlurTimer);
  taskBlurTimer = setTimeout(function(){
    var inp = document.getElementById('taskInlineInput');
    if(!taskUI.inline) return;
    if(inp && document.activeElement === inp) return;
    cancelInline(true);
  }, 100);
}
function bindAppActions(){
  if(APP_BOUND) return;
  APP_BOUND = true;
  document.addEventListener('click', onAppClick);
  document.addEventListener('input', onAppInput);
  document.addEventListener('keydown', onAppKeydown);
  document.addEventListener('pointerdown', onAppPointerDown, true);
  document.addEventListener('focusout', onAppFocusOut);
}

function openTaskActions(t){
  var body = openSheet(
    '<div class="shd"><div class="shd-t">' + esc(t.title) + '</div>' +
    '<div class="shd-s">' + (isRoutineTask(t) ? weekLabel(t) + '，' + S.settings.resetHour + ' 点清零' : '一次性任务') + '</div></div>' +
    '<div class="card plain" style="padding:0 14px" id="taAct"></div>'
  );
  var box = body.querySelector('#taAct');
  function row(label, sub, fn, danger){
    var r = el('div','row');
    var m = el('div','row-main');
    m.appendChild(el('div','row-t', label));
    if(sub) m.appendChild(el('div','row-s', sub));
    r.appendChild(m);
    r.appendChild(el('div','row-a','›'));
    if(danger) r.querySelector('.row-t').style.color = 'var(--clay)';
    r.addEventListener('click', fn);
    box.appendChild(r);
    return r;
  }
  row('编辑', '改名字、重复方式、时长、备注', function(){ closeSheet(); setTimeout(function(){ openTaskEdit(t); }, 180); });
  if(!isRoutineTask(t)){
    row('延期到明天', '不改内容，只往后推一天', function(){
      if(t.due) t.due = addDays(t.due, 1);
      else t.due = addDays(TODAY(), 1);
      save(function(){ toastCfg('taskPostponed'); }); closeSheet(); renderTasks();
    });
  }else if(taskOnDay(t, TODAY())){
    row('今天跳过', '今天不显示这条，下次照常', function(){
      t.done[TODAY()] = 2; save(function(){ toastCfg('taskSkippedToday'); }); closeSheet(); renderTasks();
    });
  }
  row('删除', '删掉之后找不回来', function(){
    confirmBox('删掉「' + t.title + '」？', '这条会从清单里消失，历史记录保留。', function(){
      S.tasks = S.tasks.filter(function(x){ return x.id !== t.id; });
      save(function(){ toastCfg('taskDeleted'); }); closeSheet(); renderTasks();
    });
  }, true);
}

function openTaskEdit(t){
  var rep = (t.repeat === 'daily' || t.repeat === 'weekly') ? t.repeat : 'once';
  var wds = (Array.isArray(t.weekdays) ? t.weekdays.slice() : []);
  var body = openSheet(
    '<div class="shd"><div class="shd-t">编辑这条</div></div>' +
    '<div class="field"><div class="field-l">内容</div><input class="inp" id="teTitle" maxlength="30" value="' + esc(t.title) + '"></div>' +
    '<div class="field"><div class="field-l">重复</div>' +
      '<div class="chips" id="teRep">' +
        '<button class="chip" data-r="once">' + UH('today.repeat.once') + '</button>' +
        '<button class="chip" data-r="daily">' + UH('today.repeat.daily') + '</button>' +
        '<button class="chip" data-r="weekly">' + UH('today.repeat.weekly') + '</button>' +
      '</div>' +
      '<div class="chips" id="teWds"></div>' +
    '</div>' +
    '<div class="field" id="teDueF"><div class="field-l">截止日期</div><input class="inp" id="teDue" type="date" value="' + esc(t.due || '') + '"></div>' +
    '<div class="field" id="teDurF"><div class="field-l">专注时长</div><div class="dur-row">' +
      '<input class="inp" id="teMin" type="number" inputmode="numeric" min="0" max="599" value="' + durParts(t.duration).m + '"><span>分</span>' +
      '<input class="inp" id="teSec" type="number" inputmode="numeric" min="0" max="59" value="' + durParts(t.duration).s + '"><span>秒</span>' +
    '</div></div>' +
    '<div class="field"><div class="field-l">备注</div><input class="inp" id="teNote" maxlength="30" value="' + esc(t.note || '') + '"></div>' +
    '<div class="acts"><button class="btn g" id="teNo">取消</button><button class="btn p" id="teOk">保存</button></div>'
  );

  /* 重复方式：不重复 / 每天 / 每周（选星期几） */
  var repBox = body.querySelector('#teRep');
  var wdBox = body.querySelector('#teWds');
  var durField = body.querySelector('#teDurF');
  var dueField = body.querySelector('#teDueF');
  function paintRep(){
    [].forEach.call(repBox.children, function(b){
      b.classList.toggle('on', b.dataset.r === rep);
    });
    wdBox.innerHTML = '';
    wdBox.style.display = rep === 'weekly' ? '' : 'none';
    /* 截止日期、专注时长都只对一次性任务有意义：
       - 时长：一次性任务会进决策页抽取池，作为番茄钟计划时长
       - 截止：重复项每天都会来，没有「什么时候到期」这回事
       重复项不进抽取池，这两个字段都不会被任何地方读取，所以直接不显示。 */
    var once = rep === 'once';
    if(dueField) dueField.style.display = once ? '' : 'none';
    if(durField) durField.style.display = once ? '' : 'none';
    if(rep !== 'weekly') return;
    for(var i = 0; i < 7; i++){
      (function(d){
        var b = el('button','chip' + (wds.indexOf(d) >= 0 ? ' on' : ''), weekName(d));
        b.dataset.wd = String(d);
        b.addEventListener('click', function(){
          var k = wds.indexOf(d);
          if(k >= 0) wds.splice(k, 1); else wds.push(d);
          paintRep();
        });
        wdBox.appendChild(b);
      })(i);
    }
  }
  repBox.addEventListener('click', function(e){
    var b = e.target.closest && e.target.closest('[data-r]');
    if(!b) return;
    rep = b.dataset.r;
    if(rep === 'weekly' && !wds.length) wds = [parse(TODAY()).getDay()];
    paintRep();
  });
  paintRep();

  if(window.OLDatePicker) OLDatePicker.attach(body.querySelector('#teDue'), { allowEmpty: true });
  body.querySelector('#teNo').addEventListener('click', closeSheet);
  body.querySelector('#teOk').addEventListener('click', function(){
    var v = body.querySelector('#teTitle').value.trim();
    if(!v){ toastCfg('contentEmpty'); return; }
    t.title = v;
    /* 截止日期与时长只有一次性任务会用到；重复项不写，避免留下读不到的死数据 */
    t.due = rep === 'once' ? (body.querySelector('#teDue').value || '') : '';
    /* 时长只有一次性任务会用到（决策页抽取 → 番茄钟计划时长）；重复项不写 */
    t.duration = rep === 'once' ? durFromInputs(body.querySelector('#teMin'), body.querySelector('#teSec')) : 0;
    t.note = body.querySelector('#teNote').value.trim();

    if(rep === 'weekly' && !wds.length) wds = [parse(TODAY()).getDay()];
    if(rep === 'once'){
      t.repeat = 'once';
      delete t.weekdays;
      if(t.cat === CAT_ROUTINE){
        /* 从重复改回一次性：清掉旧的按天完成记录，否则会被当成「早就做完」隐藏 */
        t.cat = CAT_WANT; t.done = {}; t.doneTime = {};
      }
    }else{
      t.repeat = rep;
      t.cat = CAT_ROUTINE;
      if(rep === 'weekly') t.weekdays = wds.slice().sort();
      else delete t.weekdays;
    }
    save(function(){ toastCfg('taskEdited'); }); closeSheet(); renderTasks();
  });
}

/* ==================== 今日：重点 ==================== */
function focusTarget(it){
  return focusHasGoal(it) ? +it.goal.value : 0;
}
/* 一张重点卡的内部结构：名字 / 累计值 /（有目标才有）进度条 + 目标行 */
function goalCardHtml(it){
  var v = focusSum(it, TODAY());
  var unit = focusUnit(it);
  var has = focusHasGoal(it);
  /* 第一行 = 名字 + 右上角书签。书签是卡片的子节点（不是兄弟），
     所以卡片缩放 / 动画时它天然跟着走，不需要额外同步位置。 */
  return '<div class="goal-head">' +
      '<div class="goal-l">' + esc(it.text) + '</div>' +
      '<button class="goal-bm" data-action="goal-edit" data-iid="' + esc(it.id) + '"' +
        ' aria-label="' + UH('today.action.editFocus') + ' ' + esc(it.text) + '"' +
        ' title="' + UH('today.action.editFocus') + '"></button>' +
    '</div>' +
    '<div class="goal-v' + (v ? '' : ' dim') + '">' + fmtNum(v) + '<em>' + esc(unit) + '</em></div>' +
    (has
      ? '<div class="goal-bar"><i style="width:' + clamp(Math.round(v / focusTarget(it) * 100), 0, 100) + '%"></i></div>' +
        '<div class="goal-sub">' + esc(focusGoalText(it)) + '</div>'
      : '');
}
function renderGoals(){
  var box = $('goalWrap');
  rvMarkKeep(box);
  box.innerHTML = '';
  var items = S.settings.focusItems || [];

  /* 卡片内部右上角有书签按钮，所以卡片本身用 div（按钮里不能嵌按钮），
     点击行为仍靠 data-action 委托，跟原来一致。 */
  items.forEach(function(it){
    var b = el('div','goal' + (focusHasGoal(it) ? '' : ' free'));
    b.dataset.iid = it.id;
    b.dataset.action = 'goal-open';
    b.setAttribute('role', 'button');
    b.setAttribute('tabindex', '0');
    b.innerHTML = goalCardHtml(it);
    box.appendChild(b);
  });

  /* 末尾常驻「新建」卡：把设置页那套自定义搬到当前界面 */
  var add = el('button','goal goal-add');
  add.dataset.action = 'goal-new';
  add.innerHTML = '<div class="goal-plus">+</div><div class="goal-add-t">' + UH('today.action.addFocus') + '</div>';
  box.appendChild(add);
}

/* 点今日重点：计时类开记录表单；计数类直接 +1（再点一下就是 2 杯） */
function tapFocusItem(it, node){
  if(focusIsTime(it)){ openFocusLog(it); return; }
  var rec = { id: uid('il'), itemId: it.id, date: TODAY(), time: nowHHMM(), minutes: 0, count: 1, what:'', feel:'', tags:[] };
  S.itemLogs.push(rec);
  save();
  if(node && node.isConnected){
    if(node.getBoundingClientRect){
      var r = node.getBoundingClientRect();
      floatText('+1', r.right - 30, r.top + 34);
    }
    node.innerHTML = goalCardHtml(it);   /* 只重画这一张，连点也不抖 */
    var v = node.querySelector('.goal-v');
    if(v){ v.classList.remove('bump'); void v.offsetWidth; v.classList.add('bump'); }
  }else{
    renderGoals();
  }
  buzz();
  renderRemind();
  if(currentPage === 'pRecords') renderProject();
  toastCfg('focusPlusOne', { name: it.text, unit: focusUnit(it) }, '撤销', function(){
    S.itemLogs = S.itemLogs.filter(function(x){ return x.id !== rec.id; });
    save();
    renderGoals(); renderRemind();
    if(currentPage === 'pRecords') renderProject();
  });
}

/* 点今日重点 → 填一条记录。multi 模式 = chips 多选（同健身表单）；text 模式 = 单行文本（同学习表单）
   计数类条目走 openCountLog，数量按「几杯/几次」填，存的是 count */
function openFocusLog(it, log){
  if(!focusIsTime(it)){ openCountLog(it, log); return; }
  var isNew = !log;
  var isMulti = it.mode === 'multi';
  var rec = log || { id: uid('il'), itemId: it.id, date: TODAY(), time: nowHHMM(), minutes:'', what:'', feel:'', tags:[] };
  var cfg = {
    title: (isNew ? '记一次 · ' : '改这条 · ') + it.text,
    sub: focusUnit(it) === '小时' ? '填分钟就行，卡片会按小时显示。' : '多久、做了什么，感觉随口写一句就行。',
    date: rec.date, time: rec.time, minutes: rec.minutes,
    minutesLabel: '几分钟',
    noteLabel: '感觉', note: rec.feel, notePlaceholder: '做完什么感觉，可留空',
    needMinutes: true, okText: isNew ? '记上' : '保存',
    onDelete: isNew ? null : function(){
      confirmBox('删掉这条记录？', '这条会消失，那天的统计也跟着变。', function(){
        S.itemLogs = S.itemLogs.filter(function(x){ return x.id !== rec.id; });
        save(function(){ toastCfg('itemLogDeleted'); }); closeSheet(); renderGoals(); renderRemind();
        if(currentPage === 'pRecords') renderProject();
      });
    },
    onSave: function(d){
      rec.date = d.date; rec.time = d.time; rec.minutes = d.minutes; rec.feel = d.note;
      if(isMulti){ rec.tags = d.tags || []; rec.what = ''; }
      else { rec.what = d.tagFree || ''; rec.tags = []; }
      if(isNew) S.itemLogs.push(rec);
      save(function(){ toastCfg('focusSavedMinutes', { minutes: fmtNum(d.minutes), unit: OLToastText.text('分钟') }); }); closeSheet(); renderGoals(); renderRemind();
      if(currentPage === 'pRecords') renderProject();
    }
  };
  if(isMulti){
    cfg.tagLabel = it.label || '做了什么（可多选）';
    cfg.tagOptions = (it.options && it.options.length) ? it.options : ['记了一笔'];
    cfg.tags = rec.tags || [];
  }else{
    cfg.tagLabel = it.label || '做了什么';
    cfg.tagFree = true;
    cfg.tagValue = rec.what || '';
    cfg.tagPlaceholder = it.ph || '跑步 / 背单词…（可留空）';
  }
  openLogSheet(cfg);
}

/* 计数类条目（次/杯/页/个/自定义）：记的是数量，不是分钟 */
function openCountLog(it, log){
  var isNew = !log;
  var unit = focusUnit(it);
  var isMulti = it.mode === 'multi';
  var rec = log || { id: uid('il'), itemId: it.id, date: TODAY(), time: nowHHMM(), minutes: 0, count: 1, what:'', feel:'', tags:[] };
  var cfg = {
    title: (isNew ? '记一次 · ' : '改这条 · ') + it.text,
    sub: '一次算 1 ' + unit + '，数字改大就是这次记好几个。',
    date: rec.date, time: rec.time, minutes: rec.count,
    minutesLabel: '几' + unit,
    quick: [1, 2, 3, 5], quickUnit: unit, quickLabel: '快捷数量',
    noteLabel: '感觉', note: rec.feel, notePlaceholder: '做完什么感觉，可留空',
    needMinutes: true, needMsg: '填一下数量', okText: isNew ? '记上' : '保存',
    onDelete: isNew ? null : function(){
      confirmBox('删掉这条记录？', '这条会消失，那天的统计也跟着变。', function(){
        S.itemLogs = S.itemLogs.filter(function(x){ return x.id !== rec.id; });
        save(function(){ toastCfg('itemLogDeleted'); }); closeSheet(); renderGoals(); renderRemind();
        if(currentPage === 'pRecords') renderProject();
      });
    },
    onSave: function(d){
      rec.date = d.date; rec.time = d.time;
      rec.count = d.minutes; rec.minutes = 0; rec.feel = d.note;
      if(isMulti){ rec.tags = d.tags || []; rec.what = ''; }
      else { rec.what = d.tagFree || ''; rec.tags = []; }
      if(isNew) S.itemLogs.push(rec);
      save(function(){ toastCfg('focusSavedMinutes', { minutes: fmtNum(d.minutes), unit: unit }); }); closeSheet(); renderGoals(); renderRemind();
      if(currentPage === 'pRecords') renderProject();
    }
  };
  if(isMulti){
    cfg.tagLabel = it.label || '做了什么（可多选）';
    cfg.tagOptions = (it.options && it.options.length) ? it.options : ['记了一笔'];
    cfg.tags = rec.tags || [];
  }else{
    cfg.tagLabel = it.label || '做了什么';
    cfg.tagFree = true;
    cfg.tagValue = rec.what || '';
    cfg.tagPlaceholder = it.ph || '可留空';
  }
  openLogSheet(cfg);
}

/* 灵光一闪：今日大文本域，随手写自动存；下方列出前几天的 */
var flashTimer = null;
function todayFlash(){
  var list = S.flashes.filter(function(f){ return f.date === TODAY(); });
  return list.length ? list[0] : null;
}
function renderFlashes(){
  var ta = $('flashTa');
  if(!ta) return;
  var cur = todayFlash();
  ta.value = cur ? cur.text : '';
  var listBox = $('flashList');
  listBox.innerHTML = '';
  var others = S.flashes.filter(function(f){ return f.date !== TODAY() && (f.text || '').trim(); })
    .sort(function(a,b){ return (a.date + (a.time||'')) < (b.date + (b.time||'')) ? 1 : -1; }).slice(0, 5);
  others.forEach(function(f){
    var row = el('div','flash-item');
    row.appendChild(el('div','flash-d', f.date.slice(5).replace('-', '.') + (f.time ? ' ' + f.time : '')));
    row.appendChild(el('div','flash-t', f.text));
    listBox.appendChild(row);
  });
}
function saveFlash(){
  var ta = $('flashTa');
  if(!ta) return;
  var v = ta.value.trim();
  var cur = todayFlash();
  if(!v){
    if(cur){ S.flashes = S.flashes.filter(function(f){ return f.id !== cur.id; }); save(); renderFlashes(); }
    return;
  }
  if(cur){ cur.text = v; cur.time = nowHHMM(); }
  else S.flashes.push({ id: uid('fl'), date: TODAY(), time: nowHHMM(), text: v });
  save(null, { highFrequency:true });   /* 输入停顿自动存：走高频通道 */
  renderFlashes();
}

/* ==================== 计划 / 倒计时 ==================== */
var planDateDraft = addDays(TODAY(), 1);
var planShowDone = false;

function countdownText(key){
  var d = diffDays(key, TODAY());
  if(d < 0) return '已过 ' + (-d) + ' 天';
  if(d === 0) return '就是今天';
  if(d === 1) return '明天';
  if(d === 2) return '后天';
  return '还有 ' + d + ' 天';
}
function planSorted(){
  return S.plans.slice().sort(function(a,b){
    if(a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}
function openPlanView(){
  showPage('pRecords');
  recordView = 'plan';
  renderRecords();
  window.scrollTo(0, 0);
}

/* 计划页 */
function renderPlan(){
  var q = $('planQuick');
  q.innerHTML = '';
  [[1,'明天'],[3,'3 天后'],[7,'7 天后']].forEach(function(pair){
    var b = el('button','chip' + (planDateDraft === addDays(TODAY(), pair[0]) ? ' on' : ''), pair[1]);
    b.addEventListener('click', function(){
      planDateDraft = addDays(TODAY(), pair[0]);
      renderPlan();
    });
    q.appendChild(b);
  });
  var dc = $('planDate');
  dc.value = planDateDraft;
  dc.onchange = function(){ planDateDraft = this.value || addDays(TODAY(), 1); renderPlan(); };

  var box = $('planList');
  box.innerHTML = '';
  var list = planSorted().filter(function(p){ return planShowDone || !p.done; });
  $('planToggleDone').textContent = planShowDone ? '隐藏已完成' : '显示已完成';
  if(!list.length){
    box.appendChild(el('div','empty',U('today.empty.planEmpty')));
    return;
  }
  var byDate = {}, order = [];
  list.forEach(function(p){
    if(!byDate[p.date]){ byDate[p.date] = []; order.push(p.date); }
    byDate[p.date].push(p);
  });
  order.forEach(function(key){
    var d = parse(key);
    var g = el('div','pd-group');
    var h = el('div','pd-h');
    h.appendChild(el('div','pd-d', (d.getMonth()+1) + ' 月 ' + d.getDate() + ' 日'));
    h.appendChild(el('div','pd-w', weekdayCN(d)));
    h.appendChild(el('div','pd-c', countdownText(key)));
    g.appendChild(h);
    var card = el('div','pd-card');
    byDate[key].forEach(function(p){
      var row = el('div','pd-row' + (p.done ? ' is-done' : ''));
      var ck = el('div','pd-check');
      ck.addEventListener('click', function(ev){ ev.stopPropagation(); togglePlanDone(p); });
      row.appendChild(ck);
      var main = el('div','pd-main');
      main.appendChild(el('div','pd-t', p.title));
      if(p.note) main.appendChild(el('div','pd-n', p.note));
      row.appendChild(main);
      var x = el('button','pd-x','×');
      x.addEventListener('click', function(ev){
        ev.stopPropagation();
        confirmBox('删掉「' + p.title + '」？', '这条计划会消失。', function(){
          S.plans = S.plans.filter(function(y){ return y.id !== p.id; });
          save(function(){ toastCfg('planDeleted'); }); renderPlan(); renderTasks(); renderRemind();
        });
      });
      row.appendChild(x);
      row.addEventListener('click', function(){ openPlanEdit(p); });
      card.appendChild(row);
    });
    g.appendChild(card);
    box.appendChild(g);
  });
}
function addPlan(){
  var inp = $('planInput');
  var v = inp.value.trim();
  if(!v){ toastCfg('planTextRequired'); inp.focus(); return; }
  S.plans.push({
    id: uid('pl'), date: planDateDraft, title: v,
    note:'', done:false, createdAt: Date.now()
  });
  save(function(){ toastCfg('planAdded', { date: countdownText(planDateDraft) }); });
  inp.value = '';
  renderPlan(); renderTasks(); renderRemind();
}
function togglePlanDone(p){
  p.done = !p.done;
  if(p.done){ p.doneAt = TODAY(); p.doneTime = nowHHMM(); } else { delete p.doneAt; delete p.doneTime; }
  save(function(){ toastCfg(p.done ? 'planDone' : 'planUndone'); });
  renderPlan(); renderTasks(); renderRemind();
}
function openPlanEdit(p){
  var body = openSheet(
    '<div class="shd"><div class="shd-t">改这条计划</div></div>' +
    '<div class="field"><div class="field-l">哪一天</div><input class="inp" id="peDate" type="date" value="' + esc(p.date) + '"></div>' +
    '<div class="field"><div class="field-l">做什么</div><input class="inp" id="peTitle" maxlength="30" value="' + esc(p.title) + '"></div>' +
    '<div class="field"><div class="field-l">备注</div><input class="inp" id="peNote" maxlength="30" placeholder="可留空" value="' + esc(p.note || '') + '"></div>' +
    '<div class="acts"><button class="btn d fx" id="peDel">删除</button>' +
      '<button class="btn g" id="peNo">取消</button><button class="btn p" id="peOk">保存</button></div>'
  );
  if(window.OLDatePicker) OLDatePicker.attach(body.querySelector('#peDate'), { allowEmpty: false });
  body.querySelector('#peNo').addEventListener('click', closeSheet);
  body.querySelector('#peDel').addEventListener('click', function(){
    confirmBox('删掉这条计划？', '找不回来了。', function(){
      S.plans = S.plans.filter(function(y){ return y.id !== p.id; });
      save(function(){ toastCfg('planDeleted'); }); closeSheet(); renderPlan(); renderTasks(); renderRemind();
    });
  });
  body.querySelector('#peOk').addEventListener('click', function(){
    var t = body.querySelector('#peTitle').value.trim();
    if(!t){ toastCfg('planTextRequired'); return; }
    p.date = body.querySelector('#peDate').value || p.date;
    p.title = t;
    p.note = body.querySelector('#peNote').value.trim();
    save(function(){ toastCfg('planEdited'); }); closeSheet(); renderPlan(); renderTasks(); renderRemind();
  });
}

/* 到期或逾期的计划，进今天的清单 */
function buildDuePlanGroup(){
  var t0 = TODAY();
  var list = S.plans.filter(function(p){ return !p.done && p.date <= t0; });
  if(!list.length) return null;
  var group = el('div','tgroup');
  var head = el('div','th');
  head.appendChild(el('div','th-n',U('today.label.dueToday')));
  head.appendChild(el('div','th-c', list.length + ' 件'));
  group.appendChild(head);
  list.forEach(function(p){
    var row = el('div','task');
    row.dataset.pid = p.id;
    row.dataset.action = 'due-toggle';
    row.appendChild(el('div','check'));
    var main = el('div','task-main');
    main.appendChild(el('div','task-t', p.title));
    var meta = el('div','task-m');
    var late = diffDays(p.date, t0);
    meta.appendChild(el('span','due', late < 0 ? ('逾期 ' + (-late) + ' 天') : '今天'));
    if(p.note) meta.appendChild(el('span', null, p.note));
    main.appendChild(meta);
    var more = el('button','task-more','⋯');
    more.title = '更多';
    more.dataset.action = 'due-more';
    row.appendChild(main); row.appendChild(more);
    group.appendChild(row);
  });
  return group;
}
function openPlanActions(p){
  var body = openSheet(
    '<div class="shd"><div class="shd-t">' + esc(p.title) + '</div>' +
    '<div class="shd-s">定在 ' + esc(p.date) + ' · ' + countdownText(p.date) + '</div></div>' +
    '<div class="card plain" id="paAct" style="padding:0 14px"></div>'
  );
  var box = body.querySelector('#paAct');
  function row(label, sub, fn, danger){
    var r = el('div','row');
    var m = el('div','row-main');
    m.appendChild(el('div','row-t', label));
    if(sub) m.appendChild(el('div','row-s', sub));
    r.appendChild(m);
    r.appendChild(el('div','row-a','›'));
    if(danger) r.querySelector('.row-t').style.color = 'var(--clay)';
    r.addEventListener('click', fn);
    box.appendChild(r);
  }
  row('推到明天', '不改内容，只换一天', function(){
    p.date = addDays(TODAY(), 1);
    save(function(){ toastCfg('taskPostponed'); }); closeSheet(); renderTasks(); renderPlan(); renderRemind();
  });
  row('编辑', '改日期、内容和备注', function(){ closeSheet(); setTimeout(function(){ openPlanEdit(p); }, 180); });
  row('删除', '删掉之后找不回来', function(){
    confirmBox('删掉「' + p.title + '」？', '这条计划会消失。', function(){
      S.plans = S.plans.filter(function(y){ return y.id !== p.id; });
      save(function(){ toastCfg('planDeleted'); }); closeSheet(); renderTasks(); renderPlan(); renderRemind();
    });
  }, true);
}

/* ==================== 今日：日程 ==================== */
function todaySchedule(){
  var d = new Date();
  var wd = d.getDay();
  var rk = realToday();
  return S.schedule.filter(function(s){
    if(s.date) return s.date === rk;
    return s.weekday != null && +s.weekday === wd;
  }).sort(function(a,b){ return (a.start||'').localeCompare(b.start||''); });
}
function renderSchedule(){
  var box = $('schWrap');
  box.innerHTML = '';
  var list = todaySchedule();
  if(!list.length){
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  var nowMin = new Date().getHours()*60 + new Date().getMinutes();
  var nextIdx = -1;
  for(var i=0;i<list.length;i++){
    var s = list[i], st = hhmmToMin(s.start);
    if(st >= nowMin){ nextIdx = i; break; }
  }
  list.forEach(function(s, i){
    var row = el('div','sch' + (i === nextIdx ? ' next' : ''));
    var t = el('div','sch-time', (s.start||'--:--') + '\n' + (s.end||''));
    t.style.whiteSpace = 'pre-line';
    var main = el('div','sch-main');
    var ti = el('div','sch-t');
    if(i === nextIdx){ var dot = el('span','now-dot'); ti.appendChild(dot); }
    ti.appendChild(document.createTextNode(s.title));
    main.appendChild(ti);
    var sub = [];
    if(s.place) sub.push(s.place);
    if(i === nextIdx){
      var left = hhmmToMin(s.start) - nowMin;
      if(left > 0) sub.push('还有 ' + (left >= 60 ? Math.floor(left/60) + ' 小时 ' + (left%60) + ' 分' : left + ' 分钟'));
      else sub.push('就是现在');
    }
    if(sub.length) main.appendChild(el('div','sch-p', sub.join(' · ')));
    row.appendChild(t); row.appendChild(main);
    row.addEventListener('click', function(){ openSchEdit(s); });
    box.appendChild(row);
  });
}
function hhmmToMin(s){
  if(!s) return 0;
  var p = String(s).split(':');
  return (+p[0] || 0)*60 + (+p[1] || 0);
}
function openSchEdit(s){
  var isNew = !s;
  var item = s || { id: uid('s'), title:'', weekday:null, date:todayReal(), start:'08:00', end:'', place:'', note:'' };
  var body = openSheet(
    '<div class="shd"><div class="shd-t">' + (isNew ? '加一条安排' : '改这条安排') + '</div>' +
    '<div class="shd-s">只写今天的，或者设成每周固定。</div></div>' +
    '<div class="field"><div class="field-l">做什么</div><input class="inp" id="seT" maxlength="24" placeholder="比如：高数课" value="' + esc(item.title) + '"></div>' +
    '<div class="field"><div class="field-l">重复方式</div><select class="sel" id="seRep">' +
      '<option value="week">每周固定（按星期）</option><option value="date">只这一次（按日期）</option></select></div>' +
    '<div class="field" id="seWdWrap"><div class="field-l">星期几</div><select class="sel" id="seWd">' +
      '<option value="1">周一</option><option value="2">周二</option><option value="3">周三</option><option value="4">周四</option>' +
      '<option value="5">周五</option><option value="6">周六</option><option value="0">周日</option></select></div>' +
    '<div class="field" id="seDateWrap" style="display:none"><div class="field-l">日期</div><input class="inp" id="seDate" type="date" value="' + esc(item.date || todayReal()) + '"></div>' +
    '<div class="row2"><div class="field"><div class="field-l">开始</div><input class="inp" id="seStart" type="time" value="' + esc(item.start || '') + '"></div>' +
    '<div class="field"><div class="field-l">结束</div><input class="inp" id="seEnd" type="time" value="' + esc(item.end || '') + '"></div></div>' +
    '<div class="field"><div class="field-l">地点</div><input class="inp" id="sePlace" maxlength="20" placeholder="可留空" value="' + esc(item.place || '') + '"></div>' +
    '<div class="acts">' + (isNew ? '' : '<button class="btn d fx" id="seDel">删除</button>') +
    '<button class="btn g" id="seNo">取消</button><button class="btn p" id="seOk">保存</button></div>'
  );
  var rep = body.querySelector('#seRep');
  if(window.OLTimePicker){
    OLTimePicker.attach(body.querySelector('#seStart'), { allowEmpty: true });
    OLTimePicker.attach(body.querySelector('#seEnd'), { allowEmpty: true });
    OLDatePicker.attach(body.querySelector('#seDate'), { allowEmpty: false });
  }
  rep.value = item.weekday != null && !item.date ? 'week' : (isNew ? 'week' : 'date');
  if(item.weekday == null && item.date) rep.value = 'date';
  function syncRep(){
    var v = rep.value;
    body.querySelector('#seWdWrap').style.display = v === 'week' ? 'block' : 'none';
    body.querySelector('#seDateWrap').style.display = v === 'date' ? 'block' : 'none';
  }
  if(item.weekday != null) body.querySelector('#seWd').value = String(item.weekday);
  rep.addEventListener('change', syncRep); syncRep();

  body.querySelector('#seNo').addEventListener('click', closeSheet);
  if(!isNew){
    body.querySelector('#seDel').addEventListener('click', function(){
      confirmBox('删掉这条安排？', '只是不再显示，已经过去的记录不受影响。', function(){
        S.schedule = S.schedule.filter(function(x){ return x.id !== item.id; });
        save(function(){ toastCfg('ideaDeleted'); }); closeSheet(); renderToday();
      });
    });
  }
  body.querySelector('#seOk').addEventListener('click', function(){
    var title = body.querySelector('#seT').value.trim();
    if(!title){ toastCfg('ideaTextRequired'); return; }
    item.title = title;
    item.start = body.querySelector('#seStart').value;
    item.end = body.querySelector('#seEnd').value;
    item.place = body.querySelector('#sePlace').value.trim();
    if(rep.value === 'week'){
      item.weekday = parseInt(body.querySelector('#seWd').value, 10);
      item.date = '';
    }else{
      item.date = body.querySelector('#seDate').value || todayReal();
      item.weekday = null;
    }
    if(isNew) S.schedule.push(item);
    save(function(){ toastCfg('ideaSaved'); }); closeSheet(); renderToday();
  });
}
function todayReal(){ return fmt(new Date()); }
function openSchCreate(){ openSchEdit(null); }

/* ==================== 今日汇总渲染 ==================== */
function renderToday(){
  renderHeader();
  renderRemind();
  renderTasks();
  renderGoals();
  renderSchedule();
  renderFlashes();
}

/* ==================== 标签速记（今日页） ==================== */
function openTagsSheet(){
  var t0 = TODAY();
  var body = openSheet(
    '<div class="shd"><div class="shd-t">标签速记</div><div class="shd-s">点一下记一次，可以连续点。</div></div>' +
    '<div class="chips" id="tgRow" style="margin-bottom:6px"></div>' +
    '<div style="font-size:10.5px;color:var(--ink3);margin-top:14px;line-height:1.6">标签在设置里能加、能改名，也能删掉。</div>' +
    '<div class="acts" style="margin-top:14px"><button class="btn g" id="tgDone">好了</button></div>'
  );
  var row = body.querySelector('#tgRow');
  var cnt = {};
  S.tagLogs.forEach(function(l){ if(l.date === t0) cnt[l.tagId] = (cnt[l.tagId]||0)+1; });
  function draw(){
    row.innerHTML = '';
    S.tags.forEach(function(t){
      var b = el('button','chip' + (cnt[t.id] ? ' on' : ''));
      b.textContent = t.name + (cnt[t.id] ? ' +' + cnt[t.id] : '');
      b.addEventListener('click', function(){
        S.tagLogs.push({ id: uid('l'), tagId: t.id, date: t0, ts: Date.now() });
        cnt[t.id] = (cnt[t.id]||0)+1;
        save(); draw();
        var r = b.getBoundingClientRect();
        floatText('+1', r.left + r.width/2, r.top - 4);
      });
      row.appendChild(b);
    });
    var add = el('button','chip ghost',U('common.action.newTag'));
    add.addEventListener('click', function(){
      openModal({
        title:'新建标签', sub:'', input:true, placeholder:'标签名', okText:'加上',
        onOk:function(v){
          S.tags.push({ id: uid('tag'), name:v });
          save(); draw(); renderSettings();
        }
      });
    });
    row.appendChild(add);
  }
  draw();
  body.querySelector('#tgDone').addEventListener('click', closeSheet);
}
function renderTagsRow(){ /* 占位：标签行在抽屉里 */ }

