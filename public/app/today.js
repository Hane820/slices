/* today.js — 今日：提醒/待办/重点/计划/日程/学习/汇总/标签速记 */
/* ==================== 今日：提醒 ==================== */
function minutesWorkout(date){
  return sum(S.workouts.filter(function(w){ return w.date === date; }).map(function(w){ return w.minutes || 0; }));
}
function minutesStudy(date){
  return sum(S.studyLogs.filter(function(l){ return l.date === date; }).map(function(l){ return l.minutes || 0; }));
}
function renderRemind(){
  var box = $('remindWrap');
  box.innerHTML = '';
  if(!S.settings.remind) return;
  var t0 = TODAY();
  if(S.restDays.indexOf(t0) >= 0) return;
  if(S.settings.remindDismissed === t0) return;

  var g = S.settings.goals;
  var lines = [];
  var wm = minutesWorkout(t0);
  if(wm < (g.trainMin || 0) && (g.trainMin || 0) > 0){
    lines.push({ t:'今天还没有健身记录，要不要安排 ' + g.trainMin + ' 分钟？', a:'去记录', act:'gym' });
  }
  if((g.studyMin || 0) > 0 && minutesStudy(t0) < g.studyMin){
    lines.push({ t:'今天学了 ' + minutesStudy(t0) + ' 分钟，离 ' + g.studyMin + ' 还差一点。', a:'加时间', act:'study' });
  }
  if(!lines.length) return;

  var wrap = el('div','remind');
  lines.slice(0,2).forEach(function(l){
    var row = el('div','remind-line');
    var sp = el('span', null, l.t);
    var a = el('button','remind-act', l.a);
    a.addEventListener('click', function(){
      if(l.act === 'gym') openWorkout(null);
      if(l.act === 'study') openStudy();
      if(l.act === 'note') openNote(t0);
    });
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
  if(t.repeat === 'daily') return true;
  if(isDone(t, t0)) return true;
  // 一次性任务：只要以前完成过就不再出现
  return doneCountOn(t) === 0;
}
function tasksOf(cat, t0){
  return S.tasks.filter(function(t){
    return t.cat === cat && taskVisible(t, t0) && !isSkipped(t, t0);
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
  var total = 0, doneN = 0;
  [CAT_MUST, CAT_WANT, CAT_ROUTINE].forEach(function(cat){
    var list = tasksOf(cat, t0);
    total += list.length;
    doneN += list.filter(function(t){ return isDone(t, t0); }).length;
  });

  var foldEl = $('foldTasks');
  if(foldEl){
    foldEl.textContent = S.settings.tasksFold ? '展开 ▾' : '收起 ▴';
    foldEl.style.display = total ? '' : 'none';
  }
  $('toggleDone').textContent = S.settings.showDone ? '隐藏已完成' : '显示已完成';

  // 折叠：三张卡叠成一摞，只露顶边，点一下展开
  if(S.settings.tasksFold && total){
    box.appendChild(buildTaskDeck(t0));
    return;
  }

  var due = buildDuePlanGroup();
  if(due){
    var dueCard = el('div','card tcard');
    dueCard.dataset.cat = 'due';
    dueCard.appendChild(due);
    box.appendChild(dueCard);
  }
  [CAT_MUST, CAT_WANT, CAT_ROUTINE].forEach(function(cat){
    box.appendChild(buildTaskCard(cat, t0));
  });

  if(pluginOn('tags')){
    var tagCard = el('div','card tagcard');
    tagCard.appendChild(buildTagFoot());
    box.appendChild(tagCard);
  }

  // 刚从牌堆展开：卡片从堆叠状态弹回原位
  if(justUnfolded){
    justUnfolded = false;
    var dealt = box.querySelectorAll('.tcard, .tagcard');
    var firstR = dealt.length ? dealt[0].getBoundingClientRect() : null;
    for(var i = 0; i < dealt.length; i++){
      (function(el2, i){
        if(deckCanAnimate() && firstR){
          var r = el2.getBoundingClientRect();
          var a = el2.animate([
            { transform: deckTransform(i, firstR.left - r.left, firstR.top - r.top), opacity: i === 0 ? 1 : 0.85 },
            { transform: 'none', opacity: 1 }
          ], { duration: 430 + i * 60, delay: i * 35, easing: DECK_EASE, fill: 'backwards' });
          a.onfinish = function(){ a.cancel(); };
        }else{
          el2.classList.add('deal');
          el2.style.animationDelay = (i * 55) + 'ms';
        }
      })(dealt[i], i);
    }
  }
}

/* 一个分类 = 一张卡 */
function buildTaskCard(cat, t0){
  var card = el('div','card tcard');
  card.dataset.cat = cat;
  var list = tasksOf(cat, t0);

  var head = el('div','th');
  head.appendChild(el('div','th-n', CAT_LABEL[cat]));
  var doneN = list.filter(function(t){ return isDone(t, t0); }).length;
  head.appendChild(el('div','th-c', list.length ? doneN + '/' + list.length : ''));
  var all = el('button','allbtn' + (list.length && doneN === list.length ? ' on' : ''));
  all.title = '这一组全勾上';
  all.dataset.action = 'group-all';
  head.appendChild(all);
  card.appendChild(head);

  var shown = list.filter(function(t){ return S.settings.showDone || !isDone(t, t0); });
  if(!shown.length){
    var hint = '这一组都做完了';
    if(!list.length){
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
  return card;
}

/* 输入行只是投影：没有闭包、没有监听、没有焦点副作用 */
function buildInlineAdd(st){
  var wrap = el('div','inline-add');
  var inp = document.createElement('input');
  inp.id = 'taskInlineInput';
  inp.type = 'text';
  inp.maxLength = 30;
  inp.value = st.value || '';
  inp.placeholder = st.cat === CAT_ROUTINE ? '每天要做的事' : '要做什么';
  var ok = el('button','ok','加上');
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
  if(t.due && cat === CAT_MUST) metaBits.push({ txt: dueText(t), cls:'due' });
  if(cat === CAT_ROUTINE && t.repeat === 'daily') metaBits.push({ txt:'每天', cls:'' });
  if(t.duration) metaBits.push({ txt: durText(t.duration), cls:'' });
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

/* 折叠态：一张汇总卡 + 后面两层真实卡片（stylekit card-stack 公式） */
var justUnfolded = false;
function buildTaskDeck(t0){
  var deck = el('div','deck');
  deck.appendChild(el('div','deck-l l2'));
  deck.appendChild(el('div','deck-l l1'));
  var card = el('div','card tcard top');
  card.dataset.action = 'deck-open';
  var visible = S.tasks.filter(function(t){ return taskVisible(t, t0) && !isSkipped(t, t0); });
  [CAT_MUST, CAT_WANT, CAT_ROUTINE].forEach(function(cat){
    var list = visible.filter(function(t){ return t.cat === cat; });
    var head = el('div','th');
    head.appendChild(el('div','th-n', CAT_LABEL[cat]));
    var dn = list.filter(function(t){ return isDone(t, t0); }).length;
    head.appendChild(el('div','th-c', list.length ? dn + '/' + list.length : ''));
    card.appendChild(head);
  });
  card.appendChild(el('div','empty','点一下展开，回到今天的事'));
  deck.appendChild(card);
  return deck;
}
function unfoldTasks(){
  S.settings.tasksFold = false;
  justUnfolded = true;
  save();
  renderTasks();
}

/* 卡片堆叠的统一参数（收拢 / 摊开共用一套公式） */
var DECK_EASE = 'cubic-bezier(.16,1,.3,1)';
function deckTransform(i, dx, dy){
  return 'translate(' + (dx + i * 6) + 'px,' + (dy + i * 10) + 'px) scale(' + (1 - i * 0.05) + ') rotate(' + (i * 1.5) + 'deg)';
}
function deckCanAnimate(){
  return !!(window.Element && Element.prototype.animate) &&
    !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/* 重算某张卡的计数和全勾按钮 */
function syncGroupHead(card){
  if(!card || !card.dataset.cat || card.dataset.cat === 'due') return;
  var cat = card.dataset.cat, t0 = TODAY();
  var list = tasksOf(cat, t0);
  var doneN = list.filter(function(t){ return isDone(t, t0); }).length;
  var cnt = card.querySelector('.th-c');
  if(cnt) cnt.textContent = list.length ? doneN + '/' + list.length : '';
  var all = card.querySelector('.allbtn');
  if(all) all.classList.toggle('on', !!list.length && doneN === list.length);
}

function buildTagFoot(){
  var t0 = TODAY();
  var foot = el('div','tagfoot');
  foot.appendChild(el('div','tf-l','标签'));

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
  renderRecent();
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
  var list = tasksOf(cat, t0);
  if(!list.length){ toast('这里还没有条目'); return; }
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
  toast(allDone ? '这一组已取消' : '这一组都勾完了');
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
    S.tasks.push({
      id: uid('t'), title:v, cat:st.cat,
      repeat: st.cat === CAT_ROUTINE ? 'daily' : 'once',
      due:'', duration:0, done:{}, createdAt: Date.now()
    });
    save();
  }
  /* 加完留一个空输入行，连着加第二条第三条；不再靠 DOM 残留来「保持焦点」 */
  taskUI.inline = { cat:st.cat, value:'' };
  renderTasks();
  focusTaskInput();
  if(v) toast(st.cat === CAT_ROUTINE ? '已加入每天重复' : '已加入今天');
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
function toggleDoneFilter(){
  S.settings.showDone = !S.settings.showDone;
  save();
  renderTasks();
}
function toggleTasksFold(){
  if(S.settings.tasksFold){ unfoldTasks(); return; }
  var box = $('taskWrap');
  var cards = [];
  box.querySelectorAll('.tcard, .tagcard').forEach(function(c){ cards.push(c); });
  S.settings.tasksFold = true;
  save();
  if(deckCanAnimate() && cards.length){
    var first = cards[0].getBoundingClientRect();
    cards.forEach(function(c, i){
      var r = c.getBoundingClientRect();
      c.style.zIndex = String(20 - i);
      c.style.position = 'relative';
      var a = c.animate([
        { transform:'none', opacity:1 },
        { transform: deckTransform(i, first.left - r.left, first.top - r.top), opacity: i === 0 ? 1 : 0.82 }
      ], { duration:420 + i * 40, easing:DECK_EASE, fill:'forwards' });
      a.onfinish = function(){ a.cancel(); };
    });
    setTimeout(renderTasks, 470);
  }else{
    renderTasks();
  }
  var sec = $('toggleDone').closest('.sec');
  if(sec) window.scrollTo({ top: sec.getBoundingClientRect().top + window.scrollY - 8, behavior:'smooth' });
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
    case 'go-decide':     showPage('pDecide'); return;
    case 'go-home':       showPage('pToday'); return;
    case 'scene-full':    chooseScene(hit.dataset.k); return;
    case 'add-open':      openInline(hit.dataset.cat); return;
    case 'add-ok':        commitInline(); return;
    case 'add-cancel':    cancelInline(); return;
    case 'toggle-done':   toggleDoneFilter(); return;
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
    '<div class="shd-s">' + (t.cat === CAT_ROUTINE ? '每天重复，' + S.settings.resetHour + ' 点清零' : '一次性任务') + '</div></div>' +
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
  row('编辑', '改名字、时长、备注', function(){ closeSheet(); setTimeout(function(){ openTaskEdit(t); }, 180); });
  if(t.cat !== CAT_ROUTINE){
    row('延期到明天', '不改内容，只往后推一天', function(){
      if(t.due) t.due = addDays(t.due, 1);
      else t.due = addDays(TODAY(), 1);
      save(); closeSheet(); renderTasks(); toast('已推到明天');
    });
  }else{
    row('今天跳过', '今天不显示这条，明天照常', function(){
      t.done[TODAY()] = 2; save(); closeSheet(); renderTasks(); toast('今天跳过这条');
    });
  }
  row('删除', '删掉之后找不回来', function(){
    confirmBox('删掉「' + t.title + '」？', '这条会从清单里消失，历史记录保留。', function(){
      S.tasks = S.tasks.filter(function(x){ return x.id !== t.id; });
      save(); closeSheet(); renderTasks(); toast('已删除');
    });
  }, true);
}

function openTaskEdit(t){
  var body = openSheet(
    '<div class="shd"><div class="shd-t">编辑这条</div></div>' +
    '<div class="field"><div class="field-l">内容</div><input class="inp" id="teTitle" maxlength="30" value="' + esc(t.title) + '"></div>' +
    '<div class="field"><div class="field-l">分类</div><select class="sel" id="teCat">' +
      '<option value="must">必须处理</option><option value="want">今天想完成</option><option value="routine">每天重复</option>' +
    '</select></div>' +
    '<div class="field"><div class="field-l">截止日期（只有「必须处理」用得上）</div><input class="inp" id="teDue" type="date" value="' + esc(t.due || '') + '"></div>' +
    '<div class="field"><div class="field-l">专注时长</div><div class="dur-row">' +
      '<input class="inp" id="teMin" type="number" inputmode="numeric" min="0" max="599" value="' + durParts(t.duration).m + '"><span>分</span>' +
      '<input class="inp" id="teSec" type="number" inputmode="numeric" min="0" max="59" value="' + durParts(t.duration).s + '"><span>秒</span>' +
    '</div></div>' +
    '<div class="field"><div class="field-l">备注</div><input class="inp" id="teNote" maxlength="30" value="' + esc(t.note || '') + '"></div>' +
    '<div class="acts"><button class="btn g" id="teNo">取消</button><button class="btn p" id="teOk">保存</button></div>'
  );
  body.querySelector('#teCat').value = t.cat;
  body.querySelector('#teNo').addEventListener('click', closeSheet);
  body.querySelector('#teOk').addEventListener('click', function(){
    var v = body.querySelector('#teTitle').value.trim();
    if(!v){ toast('写点内容'); return; }
    t.title = v;
    t.cat = body.querySelector('#teCat').value;
    t.due = body.querySelector('#teDue').value || '';
    t.duration = durFromInputs(body.querySelector('#teMin'), body.querySelector('#teSec'));
    t.note = body.querySelector('#teNote').value.trim();
    if(t.cat !== CAT_ROUTINE && !t.repeat) t.repeat = 'once';
    save(); closeSheet(); renderTasks(); toast('改好了');
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
  return '<div class="goal-l">' + esc(it.text) + '</div>' +
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
  if(!items.length){
    box.appendChild(el('div','empty','今日重点都删掉了，去设置里加一条。'));
    return;
  }
  items.forEach(function(it){
    var b = el('button','goal' + (focusHasGoal(it) ? '' : ' free'));
    b.dataset.iid = it.id;
    b.dataset.action = 'goal-open';
    b.innerHTML = goalCardHtml(it);
    box.appendChild(b);
  });
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
  toast(it.text + ' 记了 1 ' + focusUnit(it), '撤销', function(){
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
        save(); closeSheet(); renderGoals(); renderRemind();
        if(currentPage === 'pRecords') renderProject();
        toast('删掉了');
      });
    },
    onSave: function(d){
      rec.date = d.date; rec.time = d.time; rec.minutes = d.minutes; rec.feel = d.note;
      if(isMulti){ rec.tags = d.tags || []; rec.what = ''; }
      else { rec.what = d.tagFree || ''; rec.tags = []; }
      if(isNew) S.itemLogs.push(rec);
      save(); closeSheet(); renderGoals(); renderRemind();
      if(currentPage === 'pRecords') renderProject();
      toast('记了 ' + fmtNum(d.minutes) + ' 分钟');
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
        save(); closeSheet(); renderGoals(); renderRemind();
        if(currentPage === 'pRecords') renderProject();
        toast('删掉了');
      });
    },
    onSave: function(d){
      rec.date = d.date; rec.time = d.time;
      rec.count = d.minutes; rec.minutes = 0; rec.feel = d.note;
      if(isMulti){ rec.tags = d.tags || []; rec.what = ''; }
      else { rec.what = d.tagFree || ''; rec.tags = []; }
      if(isNew) S.itemLogs.push(rec);
      save(); closeSheet(); renderGoals(); renderRemind();
      if(currentPage === 'pRecords') renderProject();
      toast('记了 ' + fmtNum(d.minutes) + ' ' + unit);
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
  save();
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

/* 首页「接下来」 */
function renderUpcoming(){
  var box = $('upcomingWrap');
  if(!box) return;
  box.innerHTML = '';
  var t0 = TODAY();
  var list = planSorted().filter(function(p){ return !p.done && p.date > t0; }).slice(0, 3);
  if(!list.length){
    var e = el('div','empty','后面还没定事情。晚上可以先把明天写下来。');
    e.addEventListener('click', openPlanView);
    box.appendChild(e);
    return;
  }
  list.forEach(function(p){
    var row = el('div','up-row');
    row.appendChild(el('div','up-d', countdownText(p.date)));
    row.appendChild(el('div','up-t', p.title));
    row.appendChild(el('div','up-a','›'));
    row.addEventListener('click', openPlanView);
    box.appendChild(row);
  });
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
    box.appendChild(el('div','empty','还没有定过计划。选好日期，在下面输入一行就行。'));
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
          save(); renderPlan(); renderUpcoming(); renderTasks(); toast('已删除');
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
  if(!v){ toast('写一下要做什么'); inp.focus(); return; }
  S.plans.push({
    id: uid('pl'), date: planDateDraft, title: v,
    note:'', done:false, createdAt: Date.now()
  });
  save();
  inp.value = '';
  renderPlan(); renderUpcoming(); renderTasks();
  toast('加到 ' + countdownText(planDateDraft));
}
function togglePlanDone(p){
  p.done = !p.done;
  if(p.done){ p.doneAt = TODAY(); p.doneTime = nowHHMM(); } else { delete p.doneAt; delete p.doneTime; }
  save();
  renderPlan(); renderUpcoming(); renderTasks(); renderRecent();
  toast(p.done ? '做完了' : '放回来了');
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
  body.querySelector('#peNo').addEventListener('click', closeSheet);
  body.querySelector('#peDel').addEventListener('click', function(){
    confirmBox('删掉这条计划？', '找不回来了。', function(){
      S.plans = S.plans.filter(function(y){ return y.id !== p.id; });
      save(); closeSheet(); renderPlan(); renderUpcoming(); renderTasks(); toast('已删除');
    });
  });
  body.querySelector('#peOk').addEventListener('click', function(){
    var t = body.querySelector('#peTitle').value.trim();
    if(!t){ toast('写一下做什么'); return; }
    p.date = body.querySelector('#peDate').value || p.date;
    p.title = t;
    p.note = body.querySelector('#peNote').value.trim();
    save(); closeSheet(); renderPlan(); renderUpcoming(); renderTasks(); toast('改好了');
  });
}

/* 到期或逾期的计划，进今天的清单 */
function buildDuePlanGroup(){
  var t0 = TODAY();
  var list = S.plans.filter(function(p){ return !p.done && p.date <= t0; });
  if(!list.length) return null;
  var group = el('div','tgroup');
  var head = el('div','th');
  head.appendChild(el('div','th-n','今天到期'));
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
    save(); closeSheet(); renderTasks(); renderUpcoming(); renderPlan(); toast('推到明天了');
  });
  row('编辑', '改日期、内容和备注', function(){ closeSheet(); setTimeout(function(){ openPlanEdit(p); }, 180); });
  row('删除', '删掉之后找不回来', function(){
    confirmBox('删掉「' + p.title + '」？', '这条计划会消失。', function(){
      S.plans = S.plans.filter(function(y){ return y.id !== p.id; });
      save(); closeSheet(); renderTasks(); renderUpcoming(); renderPlan(); toast('已删除');
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
        save(); closeSheet(); renderToday(); toast('已删除');
      });
    });
  }
  body.querySelector('#seOk').addEventListener('click', function(){
    var title = body.querySelector('#seT').value.trim();
    if(!title){ toast('写一下是什么'); return; }
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
    save(); closeSheet(); renderToday(); toast('已保存');
  });
}
function todayReal(){ return fmt(new Date()); }
function openSchCreate(){ openSchEdit(null); }

/* ==================== 学习 / 备注 ==================== */
function openStudy(itemId){
  var t0 = TODAY();
  openLogSheet({
    title: '记一点学习',
    sub: '今天已经记了 ' + minutesStudy(t0) + ' 分钟。',
    date: t0, time: nowHHMM(), minutes: '',
    minutesLabel: '时长（分钟，必填）',
    tagLabel: '学了什么', tagFree: true, tagPlaceholder: '高数 / 单词…（可留空）',
    note: '', noteLabel: '备注', notePlaceholder: '记一句，可留空',
    needMinutes: true, okText: '记上',
    onSave: function(d){
      S.studyLogs.push({ id: uid('st'), date: d.date, minutes: d.minutes, time: d.time || nowHHMM(), what: d.tagFree, note: d.note, itemId: itemId || '' });
      save(); closeSheet();
      renderGoals(); renderRemind();
      if(currentPage === 'pRecords') renderProject();
      toast('记了 ' + d.minutes + ' 分钟');
    }
  });
}

function openNote(dateKey){
  var d = parse(dateKey);
  var isToday = dateKey === TODAY();
  openLogSheet({
    title: isToday ? '今天的手账' : (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日的手账',
    sub: '两三句话就够，不用写得完整。',
    date: dateKey, time: null, minutes: false, lockDate: true,
    note: S.notes[dateKey] || '', noteArea: true, noteLabel: '今天怎么样了',
    notePlaceholder: '今天怎么样了？', okText: '记下',
    onSave: function(dt){
      if(dt.note) S.notes[dateKey] = dt.note; else delete S.notes[dateKey];
      save(); closeSheet(); renderGoals(); renderRemind();
      if(currentPage === 'pRecords') renderRecords();
      toast(dt.note ? '已记下' : '清空了');
    }
  });
}

/* ==================== 今日汇总渲染 ==================== */
var recentCount = 3;
function renderRecent(){
  var box = $('recentWrap');
  box.innerHTML = '';
  var dates = allRecordDates().slice(0, 3);
  if(!dates.length){
    box.appendChild(el('div','empty','还没有记录。勾掉一条待办，这里就有痕迹了。'));
    return;
  }
  dates.forEach(function(k){
    var d = parse(k);
    var r = dayRecord(k);
    var row = el('div','rec');
    row.appendChild(el('div','rec-d', (d.getMonth()+1) + '/' + d.getDate()));
    var bits = recordSummary(r);
    row.appendChild(el('div','rec-t', bits.length ? bits.join(' · ') : '还没有内容'));
    row.addEventListener('click', function(){ openDayDetail(k); });
    box.appendChild(row);
  });
}

function renderToday(){
  renderHeader();
  renderRemind();
  renderTasks();
  renderGoals();
  renderUpcoming();
  renderSchedule();
  renderFlashes();
  renderRecent();
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
        save(); draw(); renderRecent();
        var r = b.getBoundingClientRect();
        floatText('+1', r.left + r.width/2, r.top - 4);
      });
      row.appendChild(b);
    });
    var add = el('button','chip ghost','+ 新标签');
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

