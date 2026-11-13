/* settings.js — 设置 */
/* ==================== 设置 ==================== */
function renderSettings(){
  // 提醒
  var rb = $('remindSet');
  rb.innerHTML = '';
  var r1 = el('div','row');
  var rm = el('div','row-main');
  rm.appendChild(el('div','row-t','首页提醒'));
  rm.appendChild(el('div','row-s','打开应用就能看到，关掉应用不会弹系统通知'));
  r1.appendChild(rm);
  var rsw = el('button','sw' + (S.settings.remind ? ' on' : ''));
  rsw.addEventListener('click', function(){ S.settings.remind = !S.settings.remind; save(); renderSettings(); renderRemind(); });
  r1.appendChild(rsw);
  rb.appendChild(r1);

  var isRest = S.restDays.indexOf(TODAY()) >= 0;
  var r2 = el('div','row');
  var r2m = el('div','row-main');
  r2m.appendChild(el('div','row-t','今天算休息日'));
  r2m.appendChild(el('div','row-s', isRest ? '今天不提醒，目标也不算数' : '想休息就打开，今天不会有提醒'));
  r2.appendChild(r2m);
  var r2s = el('button','sw' + (isRest ? ' on' : ''));
  r2s.addEventListener('click', function(){
    var t0 = TODAY();
    if(isRest) S.restDays = S.restDays.filter(function(d){ return d !== t0; });
    else S.restDays.push(t0);
    save(); renderSettings(); renderRemind(); toast(isRest ? '恢复提醒' : '今天好好休息');
  });
  r2.appendChild(r2s);
  rb.appendChild(r2);

  // 标记池
  var pp = $('penPool');
  pp.innerHTML = '';
  S.pens.forEach(function(p){
    var pill = el('div','pill');
    var dot = el('span','dotc');
    dot.style.background = rgba(p.color,.6);
    dot.textContent = p.emoji || '';
    pill.appendChild(dot);
    pill.appendChild(el('span', null, p.name || '未命名'));
    var x = el('button','x','×');
    x.addEventListener('click', function(ev){
      ev.stopPropagation();
      if(S.pens.length <= 1){ toast('至少留一个标记'); return; }
      confirmBox('删掉「' + (p.name||'未命名') + '」？', '用过这个标记的日期会变回空白。', function(){
        S.pens = S.pens.filter(function(y){ return y.id !== p.id; });
        for(var k in S.marks){ S.marks[k].items = (S.marks[k].items || []).filter(function(it){ return it.penId !== p.id; }); if(!S.marks[k].items.length) delete S.marks[k]; }
        save(); renderSettings(); toast('已删除');
      });
    });
    pill.appendChild(x);
    pill.addEventListener('click', function(){ openPenEdit(p); });
    pp.appendChild(pill);
  });
  var addP = el('button','pill add','+ 新标记');
  addP.addEventListener('click', function(){ openPenEdit(null); });
  pp.appendChild(addP);

  // 标签池
  var tp = $('tagPool');
  tp.innerHTML = '';
  S.tags.forEach(function(t){
    var pill = el('div','pill');
    pill.appendChild(el('span', null, t.name));
    var x = el('button','x','×');
    x.addEventListener('click', function(ev){
      ev.stopPropagation();
      confirmBox('删除标签「' + t.name + '」？', '之前的打卡记录会一起消失。', function(){
        S.tags = S.tags.filter(function(y){ return y.id !== t.id; });
        S.tagLogs = S.tagLogs.filter(function(l){ return l.tagId !== t.id; });
        save(); renderSettings(); toast('已删除');
      });
    });
    pill.appendChild(x);
    pill.addEventListener('click', function(){
      openModal({
        title:'改标签名', sub:'', input:true, value:t.name, placeholder:'标签名', okText:'保存',
        onOk:function(v){ t.name = v; save(); renderSettings(); toast('改好了'); }
      });
    });
    tp.appendChild(pill);
  });
  var addT = el('button','pill add','+ 新标签');
  addT.addEventListener('click', function(){
    openModal({
      title:'新建标签', sub:'点一下记一次，用来数频率', input:true, placeholder:'比如「晒了太阳」', okText:'加上',
      onOk:function(v){
        S.tags.push({ id: uid('tag'), name:v });
        save(); renderSettings(); renderTagsRow(); toast('标签已加上');
      }
    });
  });
  tp.appendChild(addT);

  // 插件：统一按 S.plugins 渲染；以后加插件只要在 defaultPlugins 里补一条
  var gl = $('pluginSet');
  gl.innerHTML = '';
  S.plugins.forEach(function(p){
    var r = el('div','row');
    var m = el('div','row-main');
    m.appendChild(el('div','row-t', p.name));
    m.appendChild(el('div','row-s', p.desc || ''));
    r.appendChild(m);
    var sw = el('button','sw' + (p.enabled ? ' on' : ''));
    sw.title = p.enabled ? '关掉' : '打开';
    r.appendChild(sw);
    r.addEventListener('click', function(){
      p.enabled = !p.enabled;
      save();
      renderSettings();
      renderToday();
      toast(p.enabled ? '「' + p.name + '」打开了' : '「' + p.name + '」关掉了');
    });
    gl.appendChild(r);
  });

  // 其它
  var ob = $('otherSet');
  ob.innerHTML = '';
  var rr = el('div','row');
  var rrm = el('div','row-main');
  rrm.appendChild(el('div','row-t','几点算新的一天'));
  rrm.appendChild(el('div','row-s','每天重复的清单在这个时间清零'));
  rr.appendChild(rrm);
  rr.appendChild(el('div','row-a', '凌晨 ' + S.settings.resetHour + ':00'));
  rr.addEventListener('click', function(){
    askNumber('几点算新的一天（0-6 点）', S.settings.resetHour, 0, 6, function(v){
      S.settings.resetHour = v; save(); renderSettings(); renderToday(); toast('改好了');
    });
  });
  ob.appendChild(rr);

  // 外观：主题色（莫兰迪预设）+ 全局字号（滑杆，自由选，不搞大中小）
  var lb = $('lookSet');
  lb.innerHTML = '';
  var THEME_LIST = [
    ['default', '灰绿', '#6F8F7E', '#FAF7F1'],
    ['mist', '雾霾蓝', '#61728D', '#F7F8FB'],
    ['clay', '陶土橘', '#B7715F', '#FAF5F1'],
    ['matcha', '抹茶绿', '#5C7561', '#F6FAF6'],
    ['lotus', '藕荷紫', '#8E7A8E', '#F9F7F9'],
    ['warm', '暖米灰', '#6A5D57', '#F9F6F3']
  ];
  var trow = el('div','row');
  var trowm = el('div','row-main');
  trowm.appendChild(el('div','row-t','主题色'));
  trowm.appendChild(el('div','row-s','莫兰迪色系，点一个全局换色'));
  trow.appendChild(trowm);
  lb.appendChild(trow);
  var tgrid = el('div','themes');
  THEME_LIST.forEach(function(t){
    var cur = (S.settings.theme || 'default') === t[0];
    var sw = el('button','theme-sw' + (cur ? ' on' : ''));
    sw.style.background = t[3];
    sw.innerHTML = '<i style="background:' + t[2] + '"></i><b>' + t[1] + '</b>' + (cur ? '<span class="ck">✓</span>' : '');
    sw.addEventListener('click', function(){
      if(S.settings.theme === t[0]) return;
      S.settings.theme = t[0];
      save(); applyTheme(); renderSettings();
      toast('换成「' + t[1] + '」了');
    });
    tgrid.appendChild(sw);
  });
  lb.appendChild(tgrid);
  var lrow = el('div','row');
  lrow.style.marginTop = '10px';
  var lrm = el('div','row-main');
  lrm.appendChild(el('div','row-t','字号'));
  lrm.appendChild(el('div','row-s','拖到喜欢的大小就行，全 App 一起变'));
  lrow.appendChild(lrm);
  var lval = el('div','row-a', Math.round((S.settings.uiScale || 1.12) * 100) + '%');
  lrow.appendChild(lval);
  lb.appendChild(lrow);
  var slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0.9'; slider.max = '1.5'; slider.step = '0.02';
  slider.value = String(S.settings.uiScale || 1.12);
  slider.style.cssText = 'width:100%;margin:10px 0 4px;accent-color:var(--sage);cursor:pointer';
  slider.addEventListener('input', function(){
    var v = Math.round(parseFloat(slider.value) * 100) / 100;
    S.settings.uiScale = v;
    applyUiScale();
    lval.textContent = Math.round(v * 100) + '%';
  });
  slider.addEventListener('change', function(){ save(); toast('字号记下了'); });
  lb.appendChild(slider);

  renderFocusSet();

  // 数据
  var db = $('dataSet');
  db.innerHTML = '';
  function dataRow(label, sub, fn){
    var r = el('div','row');
    var m = el('div','row-main');
    m.appendChild(el('div','row-t', label));
    if(sub) m.appendChild(el('div','row-s', sub));
    r.appendChild(m);
    r.appendChild(el('div','row-a','›'));
    r.addEventListener('click', fn);
    db.appendChild(r);
  }
  dataRow('导出 PDF 记录', '月历 + 时间轴 + 小结，打印或存成 PDF', openPdfPanel);
  dataRow('导出备份', '一个 JSON 文件，包含全部记录', exportJSON);
  dataRow('从备份恢复', '会先给你看摘要，再决定合并还是替换', importJSON);
  dataRow('清空全部数据', '不可恢复，请先导出', function(){
    confirmBox('清空全部数据？', '所有待办、标记、记录、训练都会消失，而且找不回来。', function(){
      S = defaults();
      normalize();
      save(); renderAll(); toast('已经清空了');
    });
  });
}

function askNumber(title, cur, min, max, cb){
  openModal({
    title: title, sub: min + ' 到 ' + max + ' 之间', input:true, value:String(cur), numeric:true, okText:'保存',
    onOk:function(v){
      var n = parseInt(v, 10);
      if(isNaN(n) || n < min || n > max){ toast('填 ' + min + ' 到 ' + max + ' 之间的数字'); return; }
      cb(n);
    }
  });
}

function openPenEdit(existing){
  var draft = existing
    ? { color: existing.color, emoji: existing.emoji || '', name: existing.name }
    : { color: COLORS[0], emoji: '', name: '' };   /* 新建默认无符号，可随时点选 */
  var body = openSheet(
    '<div class="shd"><div class="shd-t">' + (existing ? '改这个标记' : '新建一个标记') + '</div>' +
    '<div class="shd-s">下面的预览就是它在月历上的样子。</div></div>' +
    '<div class="pv-cell"><span class="pv-emo" id="pvEmo"></span><span class="pv-swipe" id="pvSwipe"></span><span class="pv-name" id="pvName"></span></div>' +
    '<div class="pv-sec">颜色</div><div class="swatches" id="swW"></div>' +
    '<div class="pv-sec">符号（可选）</div><div class="emos" id="emW"></div>' +
    '<div class="pv-sec">名字</div><input class="inp" id="penN" maxlength="6" placeholder="比如「有点累」" value="' + esc(draft.name) + '">' +
    '<div class="acts">' + (existing ? '<button class="btn d fx" id="penDel">删除</button>' : '') +
      '<button class="btn g" id="penNo">取消</button><button class="btn p" id="penOk">保存</button></div>'
  );
  /* 实时预览：模拟月历格子——色道压底、符号在上方、名字居中；无符号=纯色道 */
  function pv(){
    body.querySelector('#pvSwipe').style.background = draft.color;
    var emo = body.querySelector('#pvEmo');
    emo.textContent = draft.emoji || '';
    emo.style.display = draft.emoji ? 'block' : 'none';
    var name = body.querySelector('#penN').value.trim();
    body.querySelector('#pvName').textContent = name || (existing ? existing.name : '名字');
  }
  function drawSw(){
    var w = body.querySelector('#swW');
    w.innerHTML = '';
    COLORS.forEach(function(c){
      var sel = c === draft.color;
      var d = el('div','sw-c' + (sel ? ' sel' : ''));
      d.style.background = c;
      if(sel) d.style.boxShadow = '0 0 0 3px ' + rgba(c, .3);   /* 选中：2px 描边 + 浅色外圈 */
      d.addEventListener('click', function(){ draft.color = c; drawSw(); pv(); });
      w.appendChild(d);
    });
  }
  function drawEm(){
    var w = body.querySelector('#emW');
    w.innerHTML = '';
    /* 首位「无符号」：虚线圆圈 */
    var none = el('div','em none' + (draft.emoji ? '' : ' sel'));
    none.title = '无符号';
    none.addEventListener('click', function(){ draft.emoji = ''; drawEm(); pv(); });
    w.appendChild(none);
    EMOJIS.forEach(function(e){
      var d = el('div','em' + (e === draft.emoji ? ' sel' : ''), e);
      d.addEventListener('click', function(){ draft.emoji = e; drawEm(); pv(); });
      w.appendChild(d);
    });
  }
  var nameInp = body.querySelector('#penN');
  var okBtn = body.querySelector('#penOk');
  function syncOk(){ okBtn.disabled = !nameInp.value.trim(); }
  nameInp.addEventListener('input', function(){ syncOk(); pv(); });
  drawSw(); drawEm(); pv(); syncOk();
  body.querySelector('#penNo').addEventListener('click', closeSheet);
  if(existing){
    body.querySelector('#penDel').addEventListener('click', function(){
      if(S.pens.length <= 1){ toast('至少留一个标记'); return; }
      confirmBox('删掉这个标记？', '用过它的日期会变回空白。', function(){
        S.pens = S.pens.filter(function(y){ return y.id !== existing.id; });
        for(var k in S.marks){ S.marks[k].items = (S.marks[k].items || []).filter(function(it){ return it.penId !== existing.id; }); if(!S.marks[k].items.length) delete S.marks[k]; }
        save(); closeSheet(); renderSettings(); toast('已删除');
      });
    });
  }
  body.querySelector('#penOk').addEventListener('click', function(){
    var n = nameInp.value.trim();
    if(!n){ toast('给它起个名字'); return; }
    if(existing){
      existing.color = draft.color; existing.emoji = draft.emoji; existing.name = n;
    }else{
      S.pens.push({ id: uid('p'), color: draft.color, emoji: draft.emoji, name: n });
    }
    save(); closeSheet(); renderSettings(); toast('已保存');
  });
}


/* 今日重点：和首页、记录页「项目」共用同一份数据 */
function renderFocusSet(){
  var box = $('focusSet');
  if(!box) return;
  box.innerHTML = '';
  var list = S.settings.focusItems || [];

  var head = el('div','row');
  var hm = el('div','row-main');
  hm.appendChild(el('div','row-t','今日重点条目'));
  hm.appendChild(el('div','row-s','首页一行三张；「健身」「学习」是默认预设，可改可删'));
  head.appendChild(hm);
  var add = el('div','row-a','＋ 加一条');
  add.style.color = 'var(--sage-d)';
  add.addEventListener('click', function(){ openFocusEdit(null, true); });
  head.appendChild(add);
  box.appendChild(head);

  if(!list.length){
    box.appendChild(el('div','row-s','还没有条目，点右上角加一条。'));
    return;
  }

  list.forEach(function(it){
    var row = el('div','row');
    row.dataset.fid = it.id;
    var m = el('div','row-main');
    var t = el('div','row-t', it.text);
    m.appendChild(t);
    m.appendChild(el('div','row-s', (it.mode === 'multi' ? '多选' : '自填') + ' · ' + (focusHasGoal(it) ? focusGoalText(it) : '不设目标') + ' · 点开编辑'));
    row.appendChild(m);
    row.addEventListener('click', function(){ openFocusEdit(it, false); });
    box.appendChild(row);
  });
}

/* 一条重点的完整编辑：名字 / 输入方式（多选 chips / 自填文本）/ 每天目标（数字 + 单位，可不设） */
function openFocusEdit(it, isNew){
  var mode = (it && it.mode === 'multi') ? 'multi' : 'text';
  var opts = (it && it.mode === 'multi' && Array.isArray(it.options)) ? it.options.slice() : [];
  var lbl = it ? (it.label || '') : '';
  var phv = it ? (it.ph || '') : '';
  /* 目标状态：noGoal = 不设；unit 是当前单位，custom = 用的是自定义单位 */
  var hasGoal = it ? focusHasGoal(it) : true;
  var noGoal = !hasGoal;
  var unit = it ? focusUnit(it) : '分钟';
  var custom = FOCUS_UNITS.indexOf(unit) < 0;
  var goalVal = (it && it.goal && +it.goal.value > 0) ? +it.goal.value : 30;
  var html = '<div class="shd"><div class="shd-t">' + (isNew ? '加一条重点' : '改这条重点') + '</div>' +
    '<div class="shd-s">点首页这张卡记一次：计时类填分钟，计数类点一下 +1。</div></div>' +
    '<div class="field"><div class="field-l">名字</div><input class="inp" id="fxName" maxlength="20" placeholder="喝水 / 拉伸 / 背单词" value="' + esc(it ? it.text : '') + '"></div>' +
    '<div class="field"><div class="field-l">输入方式</div><div class="chips" id="fxMode">' +
      '<button class="chip' + (mode === 'multi' ? ' on' : '') + '" data-m="multi">多选</button>' +
      '<button class="chip' + (mode === 'text' ? ' on' : '') + '" data-m="text">自填</button>' +
    '</div></div>' +
    '<div id="fxModeBox"></div>' +
    '<div class="field"><div class="field-l">每天目标</div>' +
      '<div class="fx-goal-row">' +
        '<div class="fx-goal-main" id="fxGoalBox">' +
          '<input class="fx-num" id="fxGoal" type="number" inputmode="decimal" step="any" min="0" placeholder="—" value="' + fmtNum(goalVal) + '">' +
          '<span class="fx-unit"><select class="chip fx-unit-sel" id="fxUnitSel">' +
            FOCUS_UNITS.map(function(u){ return '<option value="' + u + '">' + u + '</option>'; }).join('') +
            '<option value="自定义">自定义</option>' +
          '</select></span>' +
          '<input class="fx-num fx-num-custom" id="fxUnitCustom" maxlength="4" placeholder="单位">' +
        '</div>' +
        '<button class="chip ghost fx-no-goal" id="fxNoGoal">不设目标</button>' +
      '</div>' +
    '</div>' +
    '<div class="acts"><button class="btn g" id="fxNo">取消</button><button class="btn p" id="fxOk">保存</button></div>' +
    (isNew ? '' : '<button class="fx-del" id="fxDel">删除此条目</button>');

  var body = openSheet(html);

  /* 模式专属配置区：multi = 选项编辑；text = 字段名 + 占位提示 */
  function renderModeBox(){
    var box = body.querySelector('#fxModeBox');
    if(mode === 'multi'){
      box.innerHTML = '<div class="field"><div class="field-l">选项（至少 1 个，点一下删掉）</div>' +
        '<div class="chips" id="fxOpts">' +
          opts.map(function(o, i){
            return '<button class="chip" data-i="' + i + '">' + esc(o) + '<span class="opt-x">×</span></button>';
          }).join('') +
        '</div>' +
        '<div class="opt-add"><input class="inp" id="fxOptIn" maxlength="8" placeholder="加一个选项，比如 跑步"><button class="btn g" id="fxOptAdd">加上</button></div>' +
      '</div>';
      box.querySelectorAll('#fxOpts .chip').forEach(function(c){
        c.addEventListener('click', function(){
          opts.splice(parseInt(c.dataset.i, 10), 1);
          renderModeBox();
        });
      });
      box.querySelector('#fxOptAdd').addEventListener('click', function(){
        var v = box.querySelector('#fxOptIn').value.trim();
        if(!v){ toast('写个选项名'); return; }
        if(opts.indexOf(v) >= 0){ toast('已经有这个选项了'); return; }
        opts.push(v);
        renderModeBox();
        var again = box.querySelector('#fxOptIn');
        if(again) again.focus();
      });
    }else{
      box.innerHTML = '<div class="field"><div class="field-l">字段名</div><input class="inp" id="fxLbl" maxlength="8" placeholder="比如 学了什么" value="' + esc(lbl) + '"></div>' +
        '<div class="field"><div class="field-l">占位提示</div><input class="inp" id="fxPh" maxlength="24" placeholder="输入框里的灰色提示，比如 高数 / 单词…" value="' + esc(phv) + '"></div>';
      body.querySelector('#fxLbl').addEventListener('input', function(){ lbl = this.value; });
      body.querySelector('#fxPh').addEventListener('input', function(){ phv = this.value; });
    }
  }
  renderModeBox();

  /* 每天目标：数字 + 单位下拉 + 不设目标，固定一行；切换只淡入淡出，不改行高 */
  var goalBox = body.querySelector('#fxGoalBox');
  var goalInp = body.querySelector('#fxGoal');
  var unitSel = body.querySelector('#fxUnitSel');
  var customInp = body.querySelector('#fxUnitCustom');
  var noBtn = body.querySelector('#fxNoGoal');
  var okBtn = body.querySelector('#fxOk');

  function goalValid(){
    if(noGoal) return { ok:true };
    var v = parseFloat(goalInp.value);
    var u = custom ? String(customInp.value || '').trim().slice(0, 4) : unitSel.value;
    if(!(v > 0)) return { ok:false, bad:'num' };
    if(!u) return { ok:false, bad:'unit' };
    return { ok:true };
  }
  function refreshOk(){
    var st = goalValid();
    okBtn.disabled = !st.ok;
    goalInp.classList.toggle('err', st.bad === 'num');
    customInp.classList.toggle('err', st.bad === 'unit');
  }
  function syncGoal(){
    unitSel.value = custom ? '自定义' : (FOCUS_UNITS.indexOf(unit) >= 0 ? unit : '分钟');
    goalBox.classList.toggle('off', noGoal);
    noBtn.classList.toggle('on', noGoal);
    customInp.classList.toggle('on', !noGoal && custom);
    customInp.value = custom ? (unit || '') : '';
    refreshOk();
  }

  unitSel.addEventListener('change', function(){
    noGoal = false;
    if(unitSel.value === '自定义'){
      custom = true;
      if(FOCUS_UNITS.indexOf(unit) >= 0) unit = '';
      syncGoal();
      customInp.focus();
    }else{
      custom = false;
      unit = unitSel.value;
      syncGoal();
    }
  });
  customInp.addEventListener('input', function(){
    unit = this.value.trim().slice(0, 4);
    refreshOk();
  });
  goalInp.addEventListener('input', refreshOk);
  noBtn.addEventListener('click', function(){
    noGoal = !noGoal;
    if(!noGoal && !unit) unit = '分钟';
    syncGoal();
  });
  syncGoal();

  /* 切换输入方式：有已填配置时先二次确认 */
  body.querySelectorAll('#fxMode .chip').forEach(function(c){
    c.addEventListener('click', function(){
      var m = c.dataset.m;
      if(m === mode) return;
      var dirty = (mode === 'multi') ? opts.length > 0 : !!(lbl.trim() || phv.trim());
      function doSwitch(){
        mode = m;
        if(mode === 'multi'){ opts = []; } else { lbl = ''; phv = ''; }
        body.querySelectorAll('#fxMode .chip').forEach(function(x){
          x.classList.toggle('on', x.dataset.m === mode);
        });
        renderModeBox();
      }
      if(dirty){
        confirmBox('切换输入方式？', '会清掉已填的' + (mode === 'multi' ? '选项' : '字段设置') + '。', doSwitch, { okText: '确定切换' });
      }else{
        doSwitch();
      }
    });
  });

  body.querySelector('#fxNo').addEventListener('click', closeSheet);
  body.querySelector('#fxOk').addEventListener('click', function(){
    var name = body.querySelector('#fxName').value.trim();
    if(!name){ toast('写个名字'); return; }
    if(mode === 'multi' && !opts.length){ toast('多选至少要有一个选项'); return; }
    var gu = String(unit || '').trim().slice(0, 4);
    var goal = null;
    if(!noGoal){
      var gv = parseFloat(goalInp.value);
      if(!(gv > 0)){ goalInp.classList.add('err'); goalInp.focus(); toast('目标写个大于 0 的数'); return; }
      if(!gu){ customInp.classList.add('err'); customInp.focus(); toast('写个单位名'); return; }
      goal = { value: Math.round(gv * 100) / 100, unit: gu };
    }
    var fields = (mode === 'multi')
      ? { mode:'multi', options: opts.slice(), label:'', ph:'' }
      : { mode:'text', options:[], label: lbl.trim(), ph: phv.trim() };
    if(isNew){
      S.settings.focusItems.push({ id: uid('fi'), text: name, goal: goal, unit: gu || '分钟', mode: fields.mode, options: fields.options, label: fields.label, ph: fields.ph });
    }else{
      it.text = name; it.goal = goal; it.unit = gu || '分钟';
      it.mode = fields.mode; it.options = fields.options; it.label = fields.label; it.ph = fields.ph;
    }
    save(); closeSheet(); renderFocusSet(); renderGoals(); renderRemind();
    if(currentPage === 'pRecords') renderProject();
    toast(isNew ? '加好了' : '改好了');
  });
  if(!isNew){
    body.querySelector('#fxDel').addEventListener('click', function(){
      var pos = S.settings.focusItems.indexOf(it);
      confirmBox('删除这条重点？', '删除「' + it.text + '」？此操作不可撤销。', function(){
        closeSheet();
        /* 行淡出 + 高度收起（0.2s），然后移除数据 */
        var row = document.querySelector('#focusSet .row[data-fid="' + it.id + '"]');
        if(row && deckCanAnimate()){
          row.style.transition = 'opacity .2s ease, max-height .2s ease, padding .2s ease';
          row.style.maxHeight = row.offsetHeight + 'px';
          row.style.overflow = 'hidden';
          requestAnimationFrame(function(){
            row.style.opacity = '0';
            row.style.maxHeight = '0';
            row.style.paddingTop = '0';
            row.style.paddingBottom = '0';
          });
        }
        setTimeout(function(){
          S.settings.focusItems = S.settings.focusItems.filter(function(x){ return x !== it; });
          save(); renderFocusSet(); renderGoals();
          if(currentPage === 'pRecords') renderProject();
          toast('已删除「' + it.text + '」', '撤销', function(){
            S.settings.focusItems.splice(Math.min(pos, S.settings.focusItems.length), 0, it);
            save(); renderFocusSet(); renderGoals();
            if(currentPage === 'pRecords') renderProject();
            toast('已恢复');
          });
        }, deckCanAnimate() ? 210 : 0);
      }, { okText: '确认删除' });
    });
  }
}
