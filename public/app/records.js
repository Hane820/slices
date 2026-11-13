/* records.js — 记录：时间轴/月历/日期详情/健身 */
/* ==================== 记录：时间轴 ==================== */
function hhmmFromTs(ts){
  if(!ts) return '';
  try{ var d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }catch(e){ return ''; }
}
function dayRecord(key){
  var r = { key:key, groups:[], tags:[], workouts:[], studies:[], decs:[], plans:[], note:'', mark: markItems(key) };
  var t0 = key;
  // 待办
  var done = S.tasks.filter(function(t){ return isDone(t, t0); });
  done.forEach(function(t){ r.groups.push(t.title); });
  // 标签
  var cnt = {};
  S.tagLogs.forEach(function(l){ if(l.date === key) cnt[l.tagId] = (cnt[l.tagId]||0)+1; });
  Object.keys(cnt).forEach(function(id){
    var nm = '已删除';
    for(var i=0;i<S.tags.length;i++) if(S.tags[i].id === id) nm = S.tags[i].name;
    r.tags.push({ name:nm, n:cnt[id] });
  });
  r.workouts = S.workouts.filter(function(w){ return w.date === key; });
  r.studies = S.studyLogs.filter(function(x){ return x.date === key; });
  r.decs = S.decisionLog.filter(function(d){ return d.date === key; });
  r.note = (S.notes[key] || '').trim();
  r.plans = S.plans.filter(function(p){ return p.done && p.doneAt === key; }).map(function(p){ return p.title; });
  // 日志流：每条记录带 HH:MM（老数据没有时刻的排在后面，只显示类目）
  var entries = [];
  done.forEach(function(t){ entries.push({ time:(t.doneTime && t.doneTime[t0]) || '', text:t.title, kind:'任务' }); });
  S.plans.forEach(function(p){ if(p.done && p.doneAt === key) entries.push({ time:p.doneTime || '', text:p.title, kind:'计划' }); });
  S.tagLogs.forEach(function(l){
    if(l.date !== key) return;
    var nm = '已删除';
    for(var i=0;i<S.tags.length;i++) if(S.tags[i].id === l.tagId) nm = S.tags[i].name;
    entries.push({ time:hhmmFromTs(l.ts), text:nm, kind:'标签' });
  });
  r.workouts.forEach(function(w){
    entries.push({ time:(w.start || '').slice(0,5) || w.time || '', text:'训练' + (w.minutes ? ' ' + w.minutes + ' 分钟' : '') + ((w.parts && w.parts.length) ? ' · ' + w.parts.join('/') : ''), kind:'训练' });
  });
  r.studies.forEach(function(x){
    entries.push({ time:x.time || '', text:'学习 ' + (x.minutes || 0) + ' 分钟' + (x.what ? ' · ' + x.what : ''), kind:'学习' });
  });
  r.decs.forEach(function(dd){ entries.push({ time:hhmmFromTs(dd.ts), text:dd.title, kind:'定了' }); });
  S.itemLogs.forEach(function(l){
    if(l.date !== key) return;
    entries.push({ time:l.time || '', kind:'重点',
      text:focusLogText(l) +
        (itemWhat(l) ? ' · ' + itemWhat(l) : '') + (l.feel ? ' · ' + l.feel : '') });
  });
  S.flashes.forEach(function(f){
    if(f.date !== key || !(f.text || '').trim()) return;
    entries.push({ time:f.time || '', kind:'灵光', text:f.text });
  });
  entries.sort(function(a,b){ return (a.time || '99:99') < (b.time || '99:99') ? -1 : 1; });
  r.entries = entries;
  return r;
}
function allRecordDates(){
  var set = {};
  Object.keys(S.marks).forEach(function(k){ set[k] = 1; });
  Object.keys(S.notes).forEach(function(k){ if((S.notes[k]||'').trim()) set[k] = 1; });
  S.tasks.forEach(function(t){ for(var k in (t.done||{})) if(t.done[k] === 1) set[k] = 1; });
  S.tagLogs.forEach(function(l){ set[l.date] = 1; });
  S.workouts.forEach(function(w){ set[w.date] = 1; });
  S.studyLogs.forEach(function(x){ set[x.date] = 1; });
  S.itemLogs.forEach(function(l){ set[l.date] = 1; });
  S.flashes.forEach(function(f){ if((f.text || '').trim()) set[f.date] = 1; });
  S.decisionLog.forEach(function(d){ set[d.date] = 1; });
  S.plans.forEach(function(p){ if(p.done && p.doneAt) set[p.doneAt] = 1; });
  return Object.keys(set).sort(function(a,b){ return a < b ? 1 : -1; });
}
var tlCount = 7;
var tlMonth = '全部';

function recordSummary(r){
  var bits = [];
  if(r.groups.length) bits.push('完成 ' + r.groups.length + ' 件');
  if(r.plans && r.plans.length) bits.push('计划 ' + r.plans.join('、'));
  if(r.tags.length) bits.push(r.tags.map(function(t){ return t.name + '×' + t.n; }).join('、'));
  var wm = sum(r.workouts.map(function(w){ return w.minutes || 0; }));
  if(r.workouts.length) bits.push('训练 ' + (wm ? wm + ' 分钟' : r.workouts.map(function(w){ return (w.parts||[]).join('/'); }).join('，')));
  var sm = sum(r.studies.map(function(x){ return x.minutes || 0; }));
  if(sm) bits.push('学习 ' + sm + ' 分钟');
  var dayItems = S.itemLogs.filter(function(l){ return l.date === r.key; });
  if(dayItems.length){
    var allTime = dayItems.every(function(l){
      var owner = byId(S.settings.focusItems, l.itemId);
      return !owner || focusIsTime(owner);
    });
    bits.push(allTime ? ('重点 ' + sum(dayItems.map(function(l){ return l.minutes || 0; })) + ' 分钟') : ('重点 ' + dayItems.length + ' 条'));
  }
  var fn = S.flashes.filter(function(f){ return f.date === r.key && (f.text || '').trim(); }).length;
  if(fn) bits.push('灵光 ' + fn + ' 条');
  if(r.note) bits.push('手账');
  if(r.mark && r.mark.length) bits.push('标记 · ' + r.mark.map(function(it){ return penOf(it.penId).name; }).join('/'));
  return bits;
}
function renderTimeline(){
  var box = $('tlWrap');
  box.innerHTML = '';
  var all = allRecordDates();

  // 月份筛选
  var fbox = $('tlFilter');
  fbox.innerHTML = '';
  var months = [];
  all.forEach(function(k){
    var m = k.slice(0,7);
    if(months.indexOf(m) < 0) months.push(m);
  });
  months = months.slice(0, 6);
  var opts = [{ v:'全部', t:'全部' }];
  months.forEach(function(m){
    var y = m.slice(0,4), mm = +m.slice(5,7);
    opts.push({ v:m, t: (y === String(new Date().getFullYear()) ? '' : y.slice(2) + '年') + mm + ' 月' });
  });
  if(opts.length > 2){
    opts.forEach(function(o){
      var b = el('button','chip' + (tlMonth === o.v ? ' on' : ''), o.t);
      b.addEventListener('click', function(){ tlMonth = o.v; tlCount = 7; renderTimeline(); });
      fbox.appendChild(b);
    });
  }

  var dates = tlMonth === '全部' ? all : all.filter(function(k){ return k.slice(0,7) === tlMonth; });
  if(!dates.length){
    box.appendChild(el('div','empty','还没有记录。勾一个待办、写两句话，这里就会出现。'));
    $('tlMore').style.display = 'none';
    return;
  }
  var t0 = TODAY();
  dates.slice(0, tlCount).forEach(function(key, i){
    var r = dayRecord(key);
    var d = parse(key);
    var item = el('div','tl-item' + (key === t0 ? ' today' : ''));
    item.style.animation = 'page-entry .5s var(--ease) both';
    item.style.animationDelay = (i * 0.03) + 's';

    var head = el('div','tl-h');
    head.appendChild(el('div','tl-date', (d.getMonth()+1) + '.' + pad(d.getDate())));
    head.appendChild(el('div','tl-wd', weekdayCN(d)));
    var bits = recordSummary(r);
    head.appendChild(el('div','tl-n', bits.length + ' 项'));
    head.addEventListener('click', function(){ openDayDetail(key); });
    item.appendChild(head);

    var card = el('div','tl-card');
    var rows = [];
    if(r.mark && r.mark.length){
      rows.push(['那天', r.mark.map(function(it){ var p = penOf(it.penId); return (p.emoji ? p.emoji + ' ' : '') + p.name; }).join('、')]);
    }
    if(r.groups.length){
      rows.push(['做了', r.groups.slice(0, 6).join('、') + (r.groups.length > 6 ? ' 等 ' + r.groups.length + ' 件' : '')]);
    }
    if(r.plans && r.plans.length){
      rows.push(['计划', r.plans.join('、')]);
    }
    if(r.tags.length){
      rows.push(['标签', r.tags.map(function(t){ return t.name + ' ×' + t.n; }).join('、')]);
    }
    if(r.workouts.length){
      var wm = sum(r.workouts.map(function(w){ return w.minutes || 0; }));
      rows.push(['训练', (wm ? wm + ' 分钟 · ' : '') + r.workouts.map(function(w){ return (w.parts||[]).join('/') || '未记部位'; }).join('，')]);
    }
    if(sum(r.studies.map(function(x){ return x.minutes; }))){
      rows.push(['学习', sum(r.studies.map(function(x){ return x.minutes; })) + ' 分钟' +
        (r.studies.filter(function(x){ return x.what; }).length ? ' · ' + r.studies.filter(function(x){ return x.what; }).map(function(x){ return x.what; }).join('、') : '')]);
    }
    if(r.decs.length){
      rows.push(['定了', r.decs[r.decs.length-1].title]);
    }
    if(r.note){
      rows.push(['手账', r.note]);
    }
    if(!rows.length) rows.push(['那天', '还没有内容']);
    if(r.entries && r.entries.length){
      // 日志流：每条记录带 HH:MM；老数据没时刻的用类目名代替
      r.entries.forEach(function(en){
        var row = el('div','tl-row');
        row.appendChild(el('div','tl-k', en.time || en.kind));
        var v = el('div','tl-v');
        if(!en.time){
          var k = document.createElement('b');
          k.textContent = en.kind + ' · ';
          v.appendChild(k);
        }
        v.appendChild(document.createTextNode(en.text));
        row.appendChild(v);
        card.appendChild(row);
      });
      if(r.mark && r.mark.length){
        var mrow = el('div','tl-row');
        mrow.appendChild(el('div','tl-k','那天'));
        mrow.appendChild(el('div','tl-v', r.mark.map(function(it){ var p = penOf(it.penId); return (p.emoji ? p.emoji + ' ' : '') + p.name; }).join('、')));
        card.appendChild(mrow);
      }
      if(r.note){
        var nrow = el('div','tl-row');
        nrow.appendChild(el('div','tl-k','手账'));
        nrow.appendChild(el('div','tl-v', r.note));
        card.appendChild(nrow);
      }
    } else {
      rows.forEach(function(rw){
        var row = el('div','tl-row');
        row.appendChild(el('div','tl-k', rw[0]));
        var v = el('div','tl-v');
        v.textContent = rw[1];
        row.appendChild(v);
        card.appendChild(row);
      });
    }
    item.appendChild(card);
    box.appendChild(item);
  });

  $('tlMore').style.display = dates.length > tlCount ? 'block' : 'none';
  $('tlMore').textContent = '加载更早的记录（还有 ' + (dates.length - tlCount) + ' 天）';
}

/* ==================== 记录：月历 ==================== */
var vy = new Date().getFullYear(), vm = new Date().getMonth();
function penOf(id){
  for(var i=0;i<S.pens.length;i++) if(S.pens[i].id === id) return S.pens[i];
  return { color:'#B6CBA8', emoji:'', name:'未命名' };
}
/* 月历筛选：全部 / 待办 / 学习 / 健身 / 重点 / 标签 / 手账 / 标记 */
var MFILS = [
  ['all', '全部'], ['task', '待办'], ['study', '学习'], ['gym', '健身'],
  ['item', '重点'], ['tag', '标签'], ['note', '手账'], ['mark', '标记']
];
var mFil = 'all';
/* 某天在当前筛选下的记录条数（决定那天的深浅；0 = 不算记录过） */
function monthDayCount(key){
  var n = 0;
  if(mFil === 'all' || mFil === 'task') n += doneCountOn({ done: dayDoneMap(key) });
  if(mFil === 'all' || mFil === 'study') S.studyLogs.forEach(function(x){ if(x.date === key) n++; });
  if(mFil === 'all' || mFil === 'gym')   S.workouts.forEach(function(w){ if(w.date === key) n++; });
  if(mFil === 'all' || mFil === 'item')  S.itemLogs.forEach(function(l){ if(l.date === key) n++; });
  if(mFil === 'all' || mFil === 'tag')   S.tagLogs.forEach(function(l){ if(l.date === key) n++; });
  if((mFil === 'all' || mFil === 'note') && (S.notes[key] || '').trim()) n++;
  if(mFil === 'all' || mFil === 'mark')  n += markItems(key).length;
  return n;
}
function renderMonth(animate){
  var first = new Date(vy, vm, 1), startW = first.getDay();
  var days = new Date(vy, vm+1, 0).getDate();
  var cells = [];
  for(var i=0;i<startW;i++) cells.push(null);
  for(var d=1;d<=days;d++) cells.push(new Date(vy, vm, d));
  while(cells.length % 7) cells.push(null);

  /* 筛选豆 */
  var fbox = $('mFil');
  fbox.innerHTML = '';
  MFILS.forEach(function(f){
    var c = el('button', 'chip' + (mFil === f[0] ? ' on' : ''), f[1]);
    c.addEventListener('click', function(){
      if(mFil === f[0]) return;
      mFil = f[0];
      renderMonth(false);
    });
    fbox.appendChild(c);
  });

  /* 标记天数（只看荧光笔）与记录天数（跟筛选走） */
  var mkey0 = vy + '-' + pad(vm+1);
  var marked = 0, recorded = 0;
  for(var dk = 1; dk <= days; dk++){
    var k0 = mkey0 + '-' + pad(dk);
    if(markItems(k0).length) marked++;
    if(monthDayCount(k0) > 0) recorded++;
  }
  $('calTitle').textContent = vy + ' 年 ' + (vm+1) + ' 月';
  $('calMeta').textContent = recorded ? ('记录了 ' + recorded + ' 天') : '这个月还是空白的';

  var g = $('grid');
  g.innerHTML = '';
  var t0 = TODAY();
  cells.forEach(function(dt){
    var e = el('div','day');
    if(!dt){ e.classList.add('blank'); g.appendChild(e); return; }
    var key = fmt(dt), items = markItems(key);
    var n = monthDayCount(key);
    var showMarks = items.length && (mFil === 'all' || mFil === 'mark');
    if(showMarks){
      /* 荧光笔道压在数字后面，多支笔粗细交替 */
      e.appendChild(el('span','dnum', String(dt.getDate())));
      if(items.length === 1){
        var p0 = penOf(items[0].penId);
        if(p0.emoji) e.appendChild(el('span','emo', p0.emoji));
      }
      var sw = el('span','swipes');
      items.slice(0, 3).forEach(function(it, idx){
        var p = penOf(it.penId);
        var st = el('span','swipe');
        var size = items.length > 1 ? (idx % 2 === 0 ? 3 : 1) : (it.size || 2);
        st.classList.add('s' + size);
        st.style.background = p.color;
        st.style.transform = 'rotate(' + (idx % 2 ? 1.6 : -1.8) + 'deg)';
        sw.appendChild(st);
      });
      e.appendChild(sw);
    }else if(n > 0){
      /* 没贴荧光笔的日子：按记录条数淡淡上色，越多越深 */
      e.textContent = dt.getDate();
      e.style.background = 'rgba(' + themeRGB() + ',' + Math.min(.07 + n * .04, .18) + ')';
    }else{
      e.textContent = dt.getDate();
    }
    if(mFil !== 'all' && n === 0 && !showMarks) e.classList.add('dim');
    if(key === t0) e.classList.add('today');
    e.addEventListener('click', function(){
      e.style.transform = 'scale(.9)';
      setTimeout(function(){ e.style.transform = ''; }, 150);
      openDayDetail(key);
    });
    g.appendChild(e);
  });
  if(animate){ g.classList.remove('anim'); void g.offsetWidth; g.classList.add('anim'); }

  // 本月小结
  var mkey = vy + '-' + pad(vm+1);
  var doneTasks = 0, trainMin = 0;
  S.tasks.forEach(function(t){
    for(var dk in (t.done || {})) if(t.done[dk] === 1 && dk.slice(0,7) === mkey) doneTasks++;
  });
  S.workouts.forEach(function(w){ if(w.date.slice(0,7) === mkey) trainMin += (w.minutes || 0); });

  var mb = $('monthStats');
  mb.innerHTML = '';
  [['标记', marked + ' 天'], ['完成', doneTasks + ' 次'], ['训练', trainMin + ' 分钟']].forEach(function(pair){
    var c = el('div','gym-stat');
    c.appendChild(el('div','l', pair[0]));
    var v = el('div','v', pair[1].split(' ')[0]);
    v.appendChild(el('em', null, ' ' + pair[1].split(' ')[1]));
    c.appendChild(v);
    mb.appendChild(c);
  });

  renderHeat(mkey);
}
function heatScale(v, max){
  if(!v) return 0;
  if(!max) return 1;
  return clamp(Math.ceil(v / max * 4), 1, 4);
}
function renderHeat(mkey){
  var box = $('heatWrap');
  if(!box) return;
  box.innerHTML = '';
  var y = +mkey.slice(0,4), m = +mkey.slice(5,7) - 1;
  var startW = new Date(y, m, 1).getDay();
  var days = new Date(y, m + 1, 0).getDate();
  var wrap = el('div','heat-grid');

  heatCats().forEach(function(cat){
    var vals = [], max = 0, total = 0, filled = 0;
    for(var d = 1; d <= days; d++){
      var v = cat.get(mkey + '-' + pad(d)) || 0;
      vals[d] = v;
      if(v > 0){ filled++; total += v; }
      if(v > max) max = v;
    }
    var card = el('div','heat-card');
    var hd = el('div','heat-h');
    hd.appendChild(el('b','heat-n', cat.name));
    hd.appendChild(el('span','heat-v', filled ? (total + ' ' + cat.unit + ' · ' + filled + ' 天') : '还没有'));
    card.appendChild(hd);

    var grid = el('div','heat');
    for(var b = 0; b < startW; b++) grid.appendChild(el('div','hc blank'));
    for(var d2 = 1; d2 <= days; d2++){
      var c = el('div', 'hc lv' + heatScale(vals[d2] || 0, max), String(d2));
      c.title = (m + 1) + '月' + d2 + '日 · ' + (vals[d2] || 0) + ' ' + cat.unit;
      grid.appendChild(c);
    }
    card.appendChild(grid);
    wrap.appendChild(card);
  });

  box.appendChild(wrap);
  var lg = el('div','heat-legend');
  lg.appendChild(el('span','hl-t','少'));
  [0,1,2,3,4].forEach(function(lv){ lg.appendChild(el('span','hl-sw lv' + lv)); });
  lg.appendChild(el('span','hl-t','多'));
  box.appendChild(lg);
}

function dayDoneMap(key){
  var m = {};
  S.tasks.forEach(function(t){ if(isDone(t, key)) m[t.id] = 1; });
  return m;
}

/* itemWhat(l)：多选记录显示选中的标签，自填记录显示输入的文字 */
function itemWhat(l){
  return l.what || (l.tags || []).join(' / ');
}

/* ==================== 日期详情 ==================== */
function openDayDetail(key){
  var d = parse(key);
  var isToday = key === TODAY();
  var r = dayRecord(key);
  var sel = markItems(key).map(function(it){ return { penId: it.penId, size: it.size || 2 }; });

  var html = '<div class="shd"><div class="shd-t">' + (d.getMonth()+1) + ' 月 ' + d.getDate() + ' 日 · ' + weekdayCN(d) + '</div>' +
    '<div class="shd-s">' + (isToday ? '今天。' : '可以补标记，也可以看看那天做了什么。') + '</div></div>' +
    '<div class="field"><div class="field-l">这一天的标记（可以选好几个，点一下加入/取消）</div><div class="marklist chips" id="ddPens" style="overflow-x:auto;flex-wrap:nowrap;padding-bottom:4px"></div></div>' +
    '<div class="field" id="ddSelField" style="display:none"><div class="field-l">已选标记 · 选粗细</div><div id="ddSel"></div></div>' +
    '<div class="field"><div class="field-l">一句话</div><textarea class="ta" id="ddNote" style="min-height:74px" placeholder="那天过得怎么样">' + esc(S.notes[key] || '') + '</textarea></div>';

  var rows = [];
  if(r.groups.length) rows.push(['完成', r.groups.join('、')]);
  if(r.tags.length) rows.push(['标签', r.tags.map(function(t){ return t.name + ' ×' + t.n; }).join('、')]);
  if(r.workouts.length){
    var wm = sum(r.workouts.map(function(w){ return w.minutes||0; }));
    rows.push(['训练', (wm ? wm + ' 分钟' : '未记时长') + (r.workouts.map(function(w){ return (w.parts||[]).join('/'); }).filter(Boolean).length ? ' · ' + r.workouts.map(function(w){ return (w.parts||[]).join('/'); }).filter(Boolean).join('，') : '')]);
  }
  if(sum(r.studies.map(function(x){ return x.minutes; }))) rows.push(['学习', sum(r.studies.map(function(x){ return x.minutes; })) + ' 分钟']);
  var dayItems = S.itemLogs.filter(function(l){ return l.date === key; });
  if(dayItems.length){
    rows.push(['重点', dayItems.map(function(l){
      return focusLogText(l) + (itemWhat(l) ? ' · ' + itemWhat(l) : '');
    }).join('；')]);
  }
  var dayFl = S.flashes.filter(function(f){ return f.date === key && (f.text || '').trim(); });
  if(dayFl.length) rows.push(['灵光', dayFl.map(function(f){ return f.text; }).join('；')]);
  if(r.decs.length) rows.push(['当时定了', r.decs.map(function(x){ return x.title; }).join('；')]);

  if(rows.length){
    html += '<div class="field"><div class="field-l">那天做了什么</div><div class="card plain" style="padding:2px 13px" id="ddRows"></div></div>';
  }
  html += '<div class="acts">' + (sel.length ? '<button class="btn d fx" id="ddClear">擦掉标记</button>' : '') +
    '<button class="btn g" id="ddNo">关闭</button><button class="btn p" id="ddOk">保存</button></div>';

  var body = openSheet(html);
  if(rows.length){
    var rb = body.querySelector('#ddRows');
    rows.forEach(function(rw){
      var row = el('div','tl-row');
      row.appendChild(el('div','tl-k', rw[0]));
      row.appendChild(el('div','tl-v', rw[1]));
      rb.appendChild(row);
    });
  }

  // 标记选择
  var pbox = body.querySelector('#ddPens');
  var selBox = body.querySelector('#ddSel');
  var selField = body.querySelector('#ddSelField');
  function has(penId){
    for(var i = 0; i < sel.length; i++) if(sel[i].penId === penId) return true;
    return false;
  }
  function drawPens(){
    pbox.innerHTML = '';
    S.pens.forEach(function(p){
      var b = el('button','chip' + (has(p.id) ? ' on' : ''));
      b.style.display = 'inline-flex';
      b.style.alignItems = 'center';
      b.style.gap = '6px';
      b.innerHTML = '<span style="width:14px;height:14px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:8px;background:' +
        rgba(p.color,.6) + '">' + esc(p.emoji || '') + '</span>' + esc(p.name || '未命名');
      b.addEventListener('click', function(){
        if(has(p.id)){
          sel = sel.filter(function(it){ return it.penId !== p.id; });
        }else{
          if(sel.length >= 3){ toast('一天最多 3 个标记'); return; }
          sel.push({ penId: p.id, size: 2 });
        }
        drawPens(); drawSel();
      });
      pbox.appendChild(b);
    });
  }
  function drawSel(){
    selBox.innerHTML = '';
    selField.style.display = sel.length ? 'block' : 'none';
    sel.forEach(function(it, idx){
      var p = penOf(it.penId);
      var row = el('div','mksel');
      var dot = el('span','mksel-dot');
      dot.style.background = rgba(p.color, .85);
      row.appendChild(dot);
      row.appendChild(el('span','mksel-n', p.name || '未命名'));
      var sizes = el('span','mksel-sizes');
      [['细',1],['中',2],['粗',3]].forEach(function(sz){
        var sb = el('button', 'mksel-sz' + ((it.size || 2) === sz[1] ? ' on' : ''), sz[0]);
        sb.addEventListener('click', function(){ sel[idx].size = sz[1]; drawSel(); });
        sizes.appendChild(sb);
      });
      row.appendChild(sizes);
      var x = el('button','mksel-x','×');
      x.addEventListener('click', function(){ sel.splice(idx, 1); drawPens(); drawSel(); });
      row.appendChild(x);
      selBox.appendChild(row);
    });
  }
  drawPens(); drawSel();

  body.querySelector('#ddNo').addEventListener('click', closeSheet);
  body.querySelector('#ddOk').addEventListener('click', function(){
    var note = body.querySelector('#ddNote').value.trim();
    if(sel.length) S.marks[key] = { items: sel.slice(), updatedAt: Date.now() };
    else delete S.marks[key];
    if(note) S.notes[key] = note; else delete S.notes[key];
    save(); closeSheet();
    if(currentPage === 'pRecords') renderRecords();
    renderToday(); toast('已保存');
  });
  if(sel.length){
    body.querySelector('#ddClear').addEventListener('click', function(){
      delete S.marks[key];
      var note = body.querySelector('#ddNote').value.trim();
      if(note) S.notes[key] = note; else delete S.notes[key];
      save(); closeSheet();
      if(currentPage === 'pRecords') renderRecords();
      renderToday(); toast('标记擦掉了');
    });
  }
}

/* ==================== 记录：项目（跟今日重点联动） ==================== */
var itemSel = null;

function focusItemKind(it){
  return { key:'item', unit: focusUnit(it) };
}
function focusItemOf(id){
  var items = S.settings.focusItems || [];
  for(var i = 0; i < items.length; i++) if(items[i].id === id) return items[i];
  return null;
}
function focusItemCur(){
  var items = S.settings.focusItems || [];
  if(!items.length) return null;
  for(var i = 0; i < items.length; i++) if(items[i].id === itemSel) return items[i];
  itemSel = items[0].id;
  return items[0];
}
/* 把这个项目的记录统一成同一种形状，健身 / 学习 / 手账 / 手动计数共用一套展示 */
function focusItemLogs(it){
  var out = [];
  if(!it) return out;
  S.itemLogs.forEach(function(l){
    if(l.itemId !== it.id) return;
    out.push({ date: l.date, time: l.time || '', value: focusLogAmount(l, it),
      title: itemWhat(l) || '记了一次', sub: l.feel || '', ref: l, kind: 'item' });
  });
  return out.sort(function(a, b){ return (a.date + a.time) < (b.date + b.time) ? 1 : -1; });
}

function renderProject(){
  var it = focusItemCur();
  var cur = $('itemCur');
  if(cur){
    cur.innerHTML = '';
    cur.appendChild(el('span','ic-n', it ? it.text : '还没有项目'));
    cur.appendChild(el('span','ic-a','切换 ▾'));
  }
  var hint = $('itemHint');
  var st = $('itemStats');
  var card = $('itemChartCard');
  var listEl = $('itemList');
  var listT = $('itemListT');
  if(!st) return;
  st.innerHTML = '';
  card.innerHTML = '';
  listEl.innerHTML = '';
  if(listT) listT.textContent = '最近';

  if(!it){
    if(hint) hint.textContent = '还没有项目。去设置 → 今日重点加一条，这里会自动跟着出现。';
    return;
  }
  var kind = focusItemKind(it);
  var logs = focusItemLogs(it);
  var unit = kind.unit;
  var d0 = TODAY(), w0 = addDays(TODAY(), -6), l0 = addDays(TODAY(), -13);
  var todayV = 0, weekV = 0, twoV = 0, twoN = 0;
  logs.forEach(function(r){
    if(r.date === d0) todayV += r.value;
    if(r.date >= w0) weekV += r.value;
    if(r.date >= l0){ twoV += r.value; twoN++; }
  });
  [['今天', todayV], ['最近 7 天', weekV], ['近两周', twoV]].forEach(function(p){
    var c = el('div','gym-stat');
    c.appendChild(el('div','l', p[0]));
    var v = el('div','v', String(p[1]));
    v.appendChild(el('em', null, ' ' + unit));
    c.appendChild(v);
    st.appendChild(c);
  });

  // 近两周柱状图
  var days = [], max = 1;
  for(var i = 13; i >= 0; i--){
    var k = addDays(d0, -i), n = 0;
    logs.forEach(function(r){ if(r.date === k) n += r.value; });
    days.push({ k: k, n: n });
    if(n > max) max = n;
  }
  var chartEl = el('div','chart'), xEl = el('div','chart-x');
  days.forEach(function(d){
    var b = el('div','bar' + (d.n ? ' has' : '') + (d.k === d0 ? ' today' : ''));
    b.style.height = clamp(Math.round(d.n / max * 66) + 4, 3, 74) + 'px';
    b.title = (parse(d.k).getMonth() + 1) + '/' + parse(d.k).getDate() + ' · ' + d.n + ' ' + unit;
    chartEl.appendChild(b);
    xEl.appendChild(el('span', null, String(parse(d.k).getDate())));
  });
  card.appendChild(chartEl);
  card.appendChild(xEl);
  var cs = el('div', null, '近两周 ' + twoN + ' 次 · 合计 ' + twoV + ' ' + unit);
  cs.style.cssText = 'font-size:11px;color:var(--ink3);margin-top:9px';
  card.appendChild(cs);

  // 记录列表
  if(listT) listT.textContent = '最近' + it.text;
  var recent = logs.filter(function(r){ return r.date >= l0; });
  if(!recent.length){
    listEl.appendChild(el('div','empty','近两周还没有记录。'));
  }else{
    var cardEl = el('div','card plain');
    recent.slice(0, 24).forEach(function(r){
      var row = el('div','wk-item');
      var d = parse(r.date);
      row.appendChild(el('div','wk-d', (d.getMonth() + 1) + '/' + d.getDate()));
      var main = el('div','wk-main');
      main.appendChild(el('div','wk-t', r.title));
      var bits = [r.time, r.sub].filter(Boolean);
      if(bits.length) main.appendChild(el('div','wk-s', bits.join(' · ')));
      row.appendChild(main);
      var shown = '—';
      if(r.value){
        shown = focusIsTime(it) ? (fmtNum(r.value) + '′') : (fmtNum(r.value) + ' ' + focusUnit(it));
      }
      row.appendChild(el('div','wk-v', shown));
      row.addEventListener('click', function(){ openFocusLog(it, r.ref); });
      cardEl.appendChild(row);
    });
    listEl.appendChild(cardEl);
  }
  if(hint) hint.textContent = '点记录可以改或删';
}

function openItemPicker(){
  var items = S.settings.focusItems || [];
  var html = '<div class="shd"><div class="shd-t">看哪个项目</div>' +
    '<div class="shd-s">列表跟着「今日重点」走，在设置里增删改。</div></div>';
  if(!items.length){
    html += '<div class="empty">还没有项目。去设置 → 今日重点加一条。</div>';
  }else{
    html += '<div class="card" style="margin-bottom:14px">';
    items.forEach(function(it){
      html += '<div class="row" data-id="' + it.id + '">' +
        '<div class="row-main"><div class="row-t">' + esc(it.text) + '</div>' +
        '<div class="row-s">' + (focusHasGoal(it) ? focusGoalText(it) : '不设目标') + '</div></div>' +
        '<div class="row-a">' + (it.id === itemSel ? '正在看' : '') + '</div></div>';
    });
    html += '</div>';
  }
  html += '<div class="acts"><button class="btn g" id="ipNo">关掉</button></div>';
  var body = openSheet(html);
  body.querySelector('#ipNo').addEventListener('click', closeSheet);
  body.querySelectorAll('.row[data-id]').forEach(function(r){
    r.addEventListener('click', function(){
      itemSel = r.dataset.id;
      recordView = 'item';
      closeSheet();
      renderRecords();
    });
  });
}

function itemAddLog(){
  var it = focusItemCur();
  if(!it) return;
  openFocusLog(it);
}

function openWorkout(w, itemId){
  var isNew = !w;
  var item = w || { id: uid('w'), date: TODAY(), start:'', minutes:'', parts:[], kcal:'', note:'', itemId: itemId || '' };
  openLogSheet({
    title: isNew ? '记一次训练' : '改这次训练',
    sub: '时长必填，其它都可以留空。',
    date: item.date, time: item.start || '', minutes: item.minutes,
    minutesLabel: '时长（分钟，必填）',
    tagLabel: '练了什么（可多选）', tagOptions: PARTS, tags: item.parts,
    extra: { label: '消耗（千卡）', value: item.kcal, placeholder: '—' },
    note: item.note, noteLabel: '备注', notePlaceholder: '状态、重量、感觉',
    needMinutes: true, okText: '保存',
    onDelete: isNew ? null : function(){
      confirmBox('删掉这次训练？', '这条记录会消失，统计也会跟着变。', function(){
        S.workouts = S.workouts.filter(function(x){ return x.id !== item.id; });
        save(); closeSheet(); renderProject(); renderGoals(); renderRemind(); toast('已删除');
      });
    },
    onSave: function(d){
      item.date = d.date; item.start = d.time; item.minutes = d.minutes;
      item.parts = d.tags; item.kcal = d.extra; item.note = d.note;
      if(isNew) S.workouts.push(item);
      save(); closeSheet();
      if(currentPage === 'pRecords') renderProject();
      renderGoals(); renderRemind(); renderToday();
      toast('记下了 ' + d.minutes + ' 分钟');
    }
  });
}

/* ==================== 记录：学习 ==================== */
function renderRecords(){
  var v = recordView;
  $('vPlan').style.display = v === 'plan' ? 'block' : 'none';
  $('vTimeline').style.display = v === 'timeline' ? 'block' : 'none';
  $('vMonth').style.display = v === 'month' ? 'block' : 'none';
  $('vItem').style.display = v === 'item' ? 'block' : 'none';
  var bs = $('recSeg').querySelectorAll('button');
  for(var i=0;i<bs.length;i++) bs[i].classList.toggle('on', bs[i].dataset.v === v);
  if(v === 'plan') renderPlan();
  if(v === 'timeline') renderTimeline();
  if(v === 'month') renderMonth(true);
  if(v === 'item') renderProject();
}
var recordView = 'timeline';

