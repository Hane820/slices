/* ==================== 饮食记录（插件） ====================
   记每天吃了什么、吃了多少、什么时候吃，并按实际进食时间计算
   每日进食窗口，辅助观察饮食规律。

   边界：
   - 数据存顶层 S.meals（dayEntries type=meal），业务数据；写入一律走
     save() → OLCommitQueue → OLWrite.commit，不碰 localStorage；
   - 插件关闭（pluginOn('diet')）只隐藏入口，数据保留；
   - 只改 S.meals 与 settings.mealSlots，不碰其他业务数据；
   - 进食窗口 ≠ 摄入热量；不做热量/营养/健康推断，不评价达标；
   - 未完成的禁食间隔不算已完成结果（「距上一顿」标明实时估算）；
   - 跨午夜按实际时间戳计算；业务日期遵循 bizDate() 规则，进食时间原样保留。 */

var dietState = { histDate: null };
var dietForm = { slot: null, foods: [{ name:'', portion:'' }, { name:'', portion:'' }], note: '' };

function dietSlots(){
  var s = (S.settings && S.settings.mealSlots) || [];
  return s.length ? s : ['早餐', '午餐', '晚餐', '加餐'];
}

/* ---------- 数据与计算 ---------- */

function dietDayRecords(date){
  return (S.meals || []).filter(function(m){ return m && m.date === date; })
    .sort(function(a, b){
      return (a.ts || 0) - (b.ts || 0) || String(a.id).localeCompare(String(b.id));
    });
}
function dietValidTs(m){ return !!(m && typeof m.ts === 'number' && m.ts > 0); }
function dietHm(ts){
  var d = new Date(ts);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function dietDur(ms){
  var min = Math.round(ms / 60000);
  var h = Math.floor(min / 60), mm = min % 60;
  if(h <= 0) return mm + '分钟';
  return h + '小时' + pad(mm) + '分';
}
/* 业务日期 + HH:MM → 实际时间戳。resetHour 之前的钟点归属下一个日历日，
   与 bizDate() 的归属规则互为逆运算；跨午夜不出现负数或错日。 */
function dietTsFromDate(date, hm){
  var p = String(hm || '').split(':');
  var h = +p[0], mi = +p[1];
  if(!(h >= 0 && h < 24) || !(mi >= 0 && mi < 60)) return 0;
  var y = +date.slice(0, 4), mo = +date.slice(5, 7) - 1, da = +date.slice(8, 10);
  if(isNaN(y) || isNaN(mo) || isNaN(da)) return 0;
  if(h < (+S.settings.resetHour || 0)) da += 1;
  return new Date(y, mo, da, h, mi, 0, 0).getTime();
}
/* 业务日期 D 的起点（日历 D 的 resetHour 时刻），用于把时钟时间折算成相对分钟 */
function dietDayStartTs(date){
  var y = +date.slice(0, 4), mo = +date.slice(5, 7) - 1, da = +date.slice(8, 10);
  return new Date(y, mo, da, (+S.settings.resetHour || 0), 0, 0, 0).getTime();
}
function dietShiftDate(date, delta){
  var y = +date.slice(0, 4), mo = +date.slice(5, 7) - 1, da = +date.slice(8, 10);
  var d = new Date(y, mo, da);
  d.setDate(d.getDate() + delta);
  return fmt(d);
}
function dietSlotNow(){
  var h = new Date().getHours(), s = dietSlots();
  function pick(i){ return s[Math.min(i, s.length - 1)] || s[0] || '加餐'; }
  if(h >= 5 && h < 11) return pick(0);
  if(h >= 11 && h < 15) return pick(1);
  if(h >= 15 && h < 18) return pick(s.length > 3 ? 3 : s.length - 1);
  if(h >= 18 && h < 22) return pick(2);
  return pick(s.length > 3 ? 3 : s.length - 1);
}
/* 当日汇总。无效时间戳的记录不计入时间计算，数量单独暴露。 */
function dietSummary(date){
  var all = dietDayRecords(date);
  var recs = all.filter(dietValidTs);
  var first = recs.length ? recs[0] : null;
  var last = recs.length ? recs[recs.length - 1] : null;
  var windowMs = (recs.length >= 2) ? (last.ts - first.ts) : null;
  var gaps = [];
  for(var i = 1; i < recs.length; i++){
    gaps.push({ from: recs[i - 1].ts, to: recs[i].ts, ms: recs[i].ts - recs[i - 1].ts });
  }
  var sinceLastMs = null;
  if(last && last.ts <= Date.now()) sinceLastMs = Date.now() - last.ts;
  return {
    date: date, all: all, records: recs, invalidCount: all.length - recs.length,
    first: first, last: last, windowMs: windowMs, gaps: gaps, sinceLastMs: sinceLastMs,
    complete: invalidCountZero(all) && recs.length > 0
  };
  function invalidCountZero(list){
    for(var j = 0; j < list.length; j++) if(!dietValidTs(list[j])) return false;
    return true;
  }
}

/* ---------- 增删改（全部走 save() 串行队列） ---------- */

function dietPush(fields, onDone){
  var time = fields.time || nowHHMM();
  var ts = dietTsFromDate(TODAY(), time);
  var rec = {
    id: uid('m'),
    date: TODAY(),
    ts: ts,
    slot: fields.slot || dietSlotNow(),
    foods: fields.foods || [],
    note: fields.note || ''
  };
  S.meals.push(rec);
  normalize();
  var ok = save(function(){ if(onDone) onDone(rec, true); });
  if(!ok && onDone) onDone(rec, false);   /* 入队失败：内存保留，失败出口照常提示 */
  return ok;
}
function dietUpdate(id, fields, onDone){
  var rec = byId(S.meals, id);
  if(!rec){ if(onDone) onDone(false); return false; }
  if(fields.time){
    var ts = dietTsFromDate(rec.date, fields.time);
    if(ts > 0) rec.ts = ts;
  }
  if(fields.slot !== undefined) rec.slot = fields.slot;
  if(fields.foods) rec.foods = fields.foods;
  if(fields.note !== undefined) rec.note = fields.note;
  normalize();
  var ok = save(function(){ if(onDone) onDone(true); });
  if(!ok && onDone) onDone(false);
  return ok;
}
function dietRemove(id, onDone){
  var before = S.meals.length;
  S.meals = S.meals.filter(function(m){ return m.id !== id; });
  if(S.meals.length === before){ if(onDone) onDone(false); return false; }
  var ok = save(function(){ if(onDone) onDone(true); });
  if(!ok && onDone) onDone(false);
  return ok;
}
/* 快速复制上一餐的食物内容（今天最后一餐；没有就取最近一天有食物的记录） */
function dietCopyLastFoods(){
  var recs = dietDayRecords(TODAY()).filter(function(m){ return m.foods && m.foods.length; });
  if(recs.length) return JSON.parse(JSON.stringify(recs[recs.length - 1].foods));
  recs = (S.meals || []).filter(function(m){ return m.foods && m.foods.length; })
    .sort(function(a, b){ return (b.ts || 0) - (a.ts || 0); });
  return recs.length ? JSON.parse(JSON.stringify(recs[0].foods)) : null;
}

/* ---------- 最近 7 天统计 ----------
   只统计「已结束且无异常记录」的日子（今天未结束不进平均）；
   平均进食窗口还需要当天 ≥2 条有效记录；异常记录从不静默纳入。 */
function dietStats7(){
  var today = TODAY();
  var days = [];
  var b = bizDate();
  for(var i = 6; i >= 0; i--){
    var x = new Date(b.getFullYear(), b.getMonth(), b.getDate());
    x.setDate(x.getDate() - i);
    days.push(fmt(x));
  }
  var per = days.map(function(ds){
    var s = dietSummary(ds);
    var startTs = dietDayStartTs(ds);
    return {
      date: ds,
      count: s.records.length,
      invalid: s.invalidCount,
      first: s.first ? dietHm(s.first.ts) : null,
      last: s.last ? dietHm(s.last.ts) : null,
      window: s.windowMs,
      ended: ds < today,
      usable: (ds < today) && s.invalidCount === 0 && s.records.length > 0,
      firstMin: s.first ? (s.first.ts - startTs) / 60000 : null,
      lastMin: s.last ? (s.last.ts - startTs) / 60000 : null
    };
  });
  function avg(list, f){
    if(!list.length) return null;
    var t = 0;
    list.forEach(function(x){ t += f(x); });
    return t / list.length;
  }
  function minToClock(min){
    if(min === null) return null;
    /* firstMin/lastMin 相对业务日起点（resetHour）计量，显示时加回起点钟点 */
    var total = Math.round(min) + (+S.settings.resetHour || 0) * 60;
    var h = Math.floor(total / 60) % 24, mm = total % 60;
    return pad(h) + ':' + pad(mm);
  }
  var usable = per.filter(function(x){ return x.usable; });
  var winDays = usable.filter(function(x){ return x.window !== null; });
  return {
    days: per,
    avgWindowMs: winDays.length ? Math.round(avg(winDays, function(x){ return x.window; })) : null,
    avgFirst: minToClock(avg(usable.filter(function(x){ return x.firstMin !== null; }), function(x){ return x.firstMin; })),
    avgLast: minToClock(avg(usable.filter(function(x){ return x.lastMin !== null; }), function(x){ return x.lastMin; })),
    completeDays: usable.length,
    windowDays: winDays.length
  };
}

/* ---------- 渲染（记录页「饮食」分段） ---------- */

function dietFoodsText(rec){
  return (rec.foods || []).map(function(f){
    return esc(f.name) + (f.portion ? '<span class="diet-pt">' + esc(f.portion) + '</span>' : '');
  }).join('、') || '<span class="diet-none">没填食物</span>';
}
function dietSummaryLine(s){
  if(s.invalidCount > 0) return '<span class="diet-warn">' + s.invalidCount + ' 条记录时间无效，未计入时间统计</span>';
  if(!s.records.length) return '这天没有进食记录';
  var out = '第一顿 ' + dietHm(s.first.ts) + ' · 最后一顿 ' + dietHm(s.last.ts) + ' · 进食窗口 ' +
    (s.windowMs !== null ? dietDur(s.windowMs) : '—（只有一餐）');
  if(s.gaps.length){
    out += '<br>间隔 ' + s.gaps.map(function(g){ return dietDur(g.ms); }).join(' / ');
  }
  return out;
}

function renderDiet(){
  if(!pluginOn('diet')) return;
  var today = TODAY();
  if(!dietState.histDate) dietState.histDate = today;
  if(dietState.histDate > today) dietState.histDate = today;
  var tsum = dietSummary(today);
  var wrap = $('vDiet');
  wrap.innerHTML = '';

  /* 1. 今日概览 */
  var ov = el('div', 'card plain diet-ov');
  ov.innerHTML =
    '<div class="diet-ov-grid">' +
      '<div><div class="diet-k">第一顿</div><div class="diet-v">' + (tsum.first ? dietHm(tsum.first.ts) : '—') + '</div></div>' +
      '<div><div class="diet-k">最后一顿</div><div class="diet-v">' + (tsum.last ? dietHm(tsum.last.ts) : '—') + '</div></div>' +
      '<div><div class="diet-k">进食窗口</div><div class="diet-v">' + (tsum.windowMs !== null ? dietDur(tsum.windowMs) : '—') + '</div></div>' +
    '</div>' +
    (tsum.sinceLastMs !== null
      ? '<div class="diet-live">距上一顿约 ' + dietDur(tsum.sinceLastMs) + '（实时估算，吃过下一顿才会确认完整间隔）</div>'
      : '') +
    (tsum.invalidCount > 0
      ? '<div class="diet-warn">今天有 ' + tsum.invalidCount + ' 条记录时间无效，未计入以上计算</div>' : '') +
    '<div class="diet-tip">只做作息观察：进食窗口不等于摄入热量，也不构成健康建议。</div>';
  wrap.appendChild(ov);

  /* 2. 今日饮食 */
  var secT = el('div', 'sec');
  secT.innerHTML = '<span class="sec-t">今日饮食</span><span class="sec-line"></span><span class="sec-a" id="dietSlotsBtn">餐次</span>';
  wrap.appendChild(secT);
  var list = el('div', 'card plain diet-list');
  if(!tsum.all.length){
    list.innerHTML = '<div class="diet-none">今天还没记，下面随手添一条。</div>';
  } else {
    tsum.all.forEach(function(m){
      var row = el('div', 'diet-row');
      row.innerHTML =
        '<div class="diet-row-m">' +
          '<div class="diet-row-t"><b>' + esc(m.slot || '未分餐次') + '</b> ' + (dietValidTs(m) ? dietHm(m.ts) : '<span class="diet-warn">时间无效</span>') + '</div>' +
          '<div class="diet-row-f">' + dietFoodsText(m) + '</div>' +
          (m.note ? '<div class="diet-row-n">' + esc(m.note) + '</div>' : '') +
        '</div>' +
        '<div class="diet-row-a"><span class="diet-act" data-edit="' + esc(m.id) + '">编辑</span><span class="diet-act" data-del="' + esc(m.id) + '">删除</span></div>';
      list.appendChild(row);
    });
  }
  wrap.appendChild(list);
  list.addEventListener('click', function(e){
    var t = e.target.closest ? e.target.closest('.diet-act') : null;
    if(!t) return;
    if(t.dataset.edit) dietOpenEdit(t.dataset.edit);
    if(t.dataset.del){
      confirmBox('删除这条进食记录？', '记录会从存档里删掉，不影响其他数据。', function(){
        dietRemove(t.dataset.del, function(ok){
          if(ok) toast('删掉了');
          renderDiet();
        });
      });
    }
  });

  /* 3. 添加进食 */
  var addC = el('div', 'sec');
  addC.innerHTML = '<span class="sec-t">添加进食</span><span class="sec-line"></span><span class="sec-a" id="dietCopyBtn">复制上一餐</span>';
  wrap.appendChild(addC);
  var form = el('div', 'card plain diet-form');
  form.innerHTML =
    '<div class="diet-frow"><div class="field-l">时间</div><input class="inp diet-time" id="dietTime" type="time" value="' + nowHHMM() + '"></div>' +
    '<div class="diet-frow"><div class="field-l">餐次</div><div class="chips diet-slots" id="dietSlotChips"></div></div>' +
    '<div class="diet-frow"><div class="field-l">吃了什么（份量可空）</div><div id="dietFoodRows"></div>' +
      '<div class="diet-addfood" id="dietAddFoodRow">+ 再吃一样</div></div>' +
    '<div class="diet-frow"><div class="field-l">备注（可选）</div><input class="inp" id="dietNote" maxlength="60" placeholder="比如：和朋友一起吃的"></div>' +
    '<div class="diet-btns"><button class="ok" id="dietSave">记下这一餐</button></div>';
  wrap.appendChild(form);

  function renderSlotChips(){
    var chips = form.querySelector('#dietSlotChips');
    chips.innerHTML = '';
    if(!dietForm.slot || dietSlots().indexOf(dietForm.slot) < 0) dietForm.slot = dietSlotNow();
    dietSlots().forEach(function(s){
      var c = el('button', 'chip' + (dietForm.slot === s ? ' on' : ''), s);
      c.addEventListener('click', function(){ dietForm.slot = s; renderSlotChips(); });
      chips.appendChild(c);
    });
  }
  function renderFoodRows(){
    var box = form.querySelector('#dietFoodRows');
    box.innerHTML = '';
    dietForm.foods.forEach(function(f, i){
      var r = el('div', 'diet-food');
      var name = el('input', 'inp diet-food-n');
      name.placeholder = '食物';
      name.maxLength = 40;
      name.value = f.name;
      name.addEventListener('input', function(){ dietForm.foods[i].name = name.value; });
      var pt = el('input', 'inp diet-food-p');
      pt.placeholder = '份量（可空）';
      pt.maxLength = 20;
      pt.value = f.portion;
      pt.addEventListener('input', function(){ dietForm.foods[i].portion = pt.value; });
      var x = el('span', 'diet-food-x', '×');
      x.addEventListener('click', function(){
        if(dietForm.foods.length > 1){ dietForm.foods.splice(i, 1); renderFoodRows(); }
      });
      r.appendChild(name); r.appendChild(pt); r.appendChild(x);
      box.appendChild(r);
    });
  }
  renderSlotChips();
  renderFoodRows();
  form.querySelector('#dietAddFoodRow').addEventListener('click', function(){
    if(dietForm.foods.length < 8){ dietForm.foods.push({ name:'', portion:'' }); renderFoodRows(); }
  });
  addC.querySelector('#dietCopyBtn').addEventListener('click', function(){
    var foods = dietCopyLastFoods();
    if(!foods){ toast('还没有可复制的一餐'); return; }
    dietForm.foods = foods.map(function(f){ return { name:f.name, portion:f.portion || '' }; });
    if(dietForm.foods.length < 8) dietForm.foods.push({ name:'', portion:'' });
    renderFoodRows();
    toast('上一餐的食物填好了');
  });
  secT.querySelector('#dietSlotsBtn').addEventListener('click', dietOpenSlots);
  form.querySelector('#dietSave').addEventListener('click', function(){
    var time = form.querySelector('#dietTime').value;
    var note = form.querySelector('#dietNote').value.trim();
    var foods = dietForm.foods.map(function(f){
      return { name: (f.name || '').trim(), portion: (f.portion || '').trim() };
    }).filter(function(f){ return f.name; });
    if(!foods.length && !note){ toast('吃的东西写一样就行，份量可以空着'); return; }
    dietPush({ time: time, slot: dietForm.slot, foods: foods, note: note }, function(rec, ok){
      if(ok) toast('记下了');
      else bizSaveFailed('save-enqueue-failed', saveRecoveryActions(window.OLCommitQueue));
      dietForm.foods = [{ name:'', portion:'' }, { name:'', portion:'' }];
      dietForm.note = '';
      dietForm.slot = null;
      renderDiet();
    });
  });

  /* 4. 历史与统计 */
  var hSec = el('div', 'sec');
  hSec.innerHTML = '<span class="sec-t">历史与统计</span><span class="sec-line"></span>';
  wrap.appendChild(hSec);
  var hist = el('div', 'card plain diet-hist');
  var hs = dietSummary(dietState.histDate);
  hist.innerHTML =
    '<div class="diet-hnav"><button class="diet-nav" id="dietPrev">‹</button>' +
      '<div class="diet-hdate">' + dietState.histDate + (dietState.histDate === today ? '（今天）' : '') + '</div>' +
      '<button class="diet-nav" id="dietNext">›</button></div>' +
    '<div class="diet-hsum">' + dietSummaryLine(hs) + '</div>';
  if(hs.all.length && dietState.histDate !== today){
    hs.all.forEach(function(m){
      var row = el('div', 'diet-row');
      row.innerHTML =
        '<div class="diet-row-m">' +
          '<div class="diet-row-t"><b>' + esc(m.slot || '未分餐次') + '</b> ' + (dietValidTs(m) ? dietHm(m.ts) : '<span class="diet-warn">时间无效</span>') + '</div>' +
          '<div class="diet-row-f">' + dietFoodsText(m) + '</div>' +
          (m.note ? '<div class="diet-row-n">' + esc(m.note) + '</div>' : '') +
        '</div>' +
        '<div class="diet-row-a"><span class="diet-act" data-edit="' + esc(m.id) + '">编辑</span><span class="diet-act" data-del="' + esc(m.id) + '">删除</span></div>';
      hist.appendChild(row);
    });
  } else if(dietState.histDate === today && hs.all.length){
    hist.appendChild(el('div', 'diet-hist-more', '今天的记录见上面「今日饮食」，同样可以编辑删除。'));
  }
  wrap.appendChild(hist);
  hist.addEventListener('click', function(e){
    var t = e.target.closest ? e.target.closest('.diet-act') : null;
    if(t && t.dataset.edit) dietOpenEdit(t.dataset.edit);
    if(t && t.dataset.del){
      confirmBox('删除这条进食记录？', '记录会从存档里删掉，不影响其他数据。', function(){
        dietRemove(t.dataset.del, function(ok){
          if(ok) toast('删掉了');
          renderDiet();
        });
      });
    }
  });
  hist.querySelector('#dietPrev').addEventListener('click', function(){
    dietState.histDate = dietShiftDate(dietState.histDate, -1);
    renderDiet();
  });
  hist.querySelector('#dietNext').addEventListener('click', function(){
    if(dietState.histDate >= today){ toast('已经是最新的那天了'); return; }
    dietState.histDate = dietShiftDate(dietState.histDate, 1);
    renderDiet();
  });

  var stats = dietStats7();
  var st = el('div', 'card plain diet-stats');
  var dayChips = stats.days.map(function(d){
    return '<span class="diet-day' + (d.invalid ? ' diet-day-bad' : '') + '">' +
      esc(d.date.slice(5)) + ' ' + d.count + '餐' + (d.invalid ? '!' : '') + '</span>';
  }).join('');
  st.innerHTML =
    '<div class="diet-k">最近 7 天（只统计已结束且无异常的日子）</div>' +
    '<div class="diet-stats-g">' +
      '<div><span class="diet-k">平均进食窗口</span><span class="diet-v">' + (stats.avgWindowMs !== null ? dietDur(stats.avgWindowMs) : '—') + '</span></div>' +
      '<div><span class="diet-k">平均第一顿</span><span class="diet-v">' + (stats.avgFirst || '—') + '</span></div>' +
      '<div><span class="diet-k">平均最后一顿</span><span class="diet-v">' + (stats.avgLast || '—') + '</span></div>' +
      '<div><span class="diet-k">完整记录天数</span><span class="diet-v">' + stats.completeDays + ' / 7</span></div>' +
    '</div>' +
    '<div class="diet-days">' + dayChips + '</div>' +
    '<div class="diet-tip">带 ! 的那天有无效记录，未纳入平均；进食窗口只是作息观察，不构成健康建议。</div>';
  wrap.appendChild(st);
}

/* ---------- 编辑弹层 ---------- */

function dietOpenEdit(id){
  var rec = byId(S.meals, id);
  if(!rec) return;
  var foods = (rec.foods || []).map(function(f){ return { name:f.name, portion:f.portion || '' }; });
  if(!foods.length) foods = [{ name:'', portion:'' }];
  var slots = dietSlots();
  var chips = slots.map(function(s){
    return '<button class="chip diet-eslot' + (rec.slot === s ? ' on' : '') + '" data-s="' + esc(s) + '">' + esc(s) + '</button>';
  }).join('');
  var rows = foods.map(function(f, i){
    return '<div class="diet-food" data-i="' + i + '">' +
      '<input class="inp diet-food-n" value="' + esc(f.name) + '" placeholder="食物" maxlength="40">' +
      '<input class="inp diet-food-p" value="' + esc(f.portion) + '" placeholder="份量（可空）" maxlength="20">' +
      '</div>';
  }).join('');
  var body = openSheet(
    '<div class="shd"><div class="shd-t">编辑这条进食</div>' +
    '<div class="shd-s">' + esc(rec.date) + '</div></div>' +
    '<div class="field-l">时间</div><input class="inp" id="deTime" type="time" value="' + (dietValidTs(rec) ? dietHm(rec.ts) : nowHHMM()) + '">' +
    '<div class="field-l">餐次</div><div class="chips" id="deSlots">' + chips + '</div>' +
    '<div class="field-l">吃了什么</div><div id="deFoods">' + rows + '</div>' +
    '<div class="diet-addfood" id="deAddFood">+ 再吃一样</div>' +
    '<div class="field-l">备注</div><input class="inp" id="deNote" value="' + esc(rec.note) + '" maxlength="60">' +
    '<div class="shBtn"><button class="btn" id="deNo">取消</button><button class="btn g" id="deOk">保存</button></div>'
  );
  var curSlot = rec.slot;
  body.querySelector('#deSlots').addEventListener('click', function(e){
    var b = e.target.closest ? e.target.closest('.diet-eslot') : null;
    if(!b) return;
    curSlot = b.dataset.s;
    body.querySelectorAll('.diet-eslot').forEach(function(x){ x.classList.toggle('on', x.dataset.s === curSlot); });
  });
  function collectFoods(){
    var out = [];
    body.querySelectorAll('.diet-food').forEach(function(r){
      var name = r.querySelector('.diet-food-n').value.trim();
      if(name) out.push({ name: name, portion: r.querySelector('.diet-food-p').value.trim() });
    });
    return out;
  }
  body.querySelector('#deAddFood').addEventListener('click', function(){
    var box = body.querySelector('#deFoods');
    var r = el('div', 'diet-food');
    r.innerHTML = '<input class="inp diet-food-n" placeholder="食物" maxlength="40">' +
      '<input class="inp diet-food-p" placeholder="份量（可空）" maxlength="20">';
    box.appendChild(r);
  });
  body.querySelector('#deNo').addEventListener('click', closeSheet);
  body.querySelector('#deOk').addEventListener('click', function(){
    var fs = collectFoods();
    if(!fs.length && !body.querySelector('#deNote').value.trim()){ toast('吃的东西写一样就行'); return; }
    dietUpdate(id, {
      time: body.querySelector('#deTime').value,
      slot: curSlot,
      foods: fs,
      note: body.querySelector('#deNote').value.trim()
    }, function(ok){
      closeSheet();
      if(ok) toast('改好了');
      else bizSaveFailed('save-enqueue-failed', saveRecoveryActions(window.OLCommitQueue));
      renderDiet();
    });
  });
}

/* ---------- 餐次自定义弹层 ---------- */

function dietOpenSlots(){
  function draw(){
    var rows = dietSlots().map(function(s, i){
      return '<div class="diet-slotrow"><span>' + esc(s) + '</span>' +
        (dietSlots().length > 1 ? '<span class="diet-act" data-i="' + i + '">删除</span>' : '') + '</div>';
    }).join('');
    var body = openSheet(
      '<div class="shd"><div class="shd-t">餐次</div><div class="shd-s">早餐、午餐、晚餐、加餐都能改</div></div>' +
      '<div id="dsList">' + rows + '</div>' +
      '<div class="inline-add"><input class="inp" id="dsNew" maxlength="8" placeholder="新餐次，比如：下午茶">' +
      '<button class="ok" id="dsAdd">加上</button></div>' +
      '<div class="shBtn"><button class="btn g" id="dsDone">好了</button></div>'
    );
    body.querySelector('#dsList').addEventListener('click', function(e){
      var t = e.target.closest ? e.target.closest('.diet-act') : null;
      if(!t) return;
      S.settings.mealSlots.splice(+t.dataset.i, 1);
      save(function(){}, { highFrequency:true });
      draw();
    });
    body.querySelector('#dsAdd').addEventListener('click', function(){
      var v = body.querySelector('#dsNew').value.trim();
      if(!v){ toast('写个名字'); return; }
      if(dietSlots().indexOf(v) >= 0){ toast('已经有这个餐次了'); return; }
      if(dietSlots().length >= 8){ toast('餐次最多 8 个'); return; }
      S.settings.mealSlots.push(v);
      save(function(){}, { highFrequency:true });
      draw();
    });
    body.querySelector('#dsDone').addEventListener('click', function(){
      closeSheet();
      renderDiet();
    });
  }
  draw();
}
