/* core.js — 常量/工具/数据/导航/头部/通用面板·弹窗/导入导出/PDF */
/* ==================== 常量 ==================== */
var KEY = 'earthonline-v4';
var OLD = 'earthonline-v3';

var COLORS = ['#B6CBA8','#A8C0D8','#E8CEA8','#C9BFDA','#E5B3AC','#A8CFC5','#D8C3A5','#C4C9A8','#B8C4D9','#D9BFBF'];
var EMOJIS = ['🌿','✨','☁','☾','〰','✓','♡','★','🌙','☀','🌧','🍂','🌸','🕯','💧','🔥'];
var PARTS  = ['胸','背','腿','肩','手臂','核心','有氧','拉伸','休息'];

/* 情境：点一个，就列出绑在这个情境上的建议。不猜用户写了什么。 */
var SCENES = [
  {k:'afterclass', n:'下课后',       d:'刚下课，还没安排'},
  {k:'noclass',    n:'没课',         d:'一整块空时间'},
  {k:'tired',      n:'有点累',       d:'做不动大事'},
  {k:'nofuel',     n:'不想动',       d:'什么都不想开始'},
  {k:'bored',      n:'有点无聊',     d:'想找点事做'},
  {k:'meal',       n:'刚吃完饭',     d:'饭后这一会儿'},
  {k:'move',       n:'想动一动',     d:'想练或出门'},
  {k:'study',      n:'想学点东西',   d:'有心思看书'},
  {k:'beforebed',  n:'睡前',         d:'该收尾了'},
  {k:'lost',       n:'不知道做什么', d:'你替我定'}
];
function sceneName(k){
  for(var i=0;i<SCENES.length;i++) if(SCENES[i].k === k) return SCENES[i].n;
  return k;
}
var DEFAULT_SCENES = {
  s1:['bored','tired','meal'],
  s2:['move','noclass'],
  s3:['tired','move','beforebed'],
  s4:['tired','nofuel','beforebed'],
  s5:['afterclass','study'],
  s6:['study','bored','beforebed'],
  s7:['beforebed','lost'],
  s8:['bored','lost'],
  s9:['lost','noclass'],
  s10:['afterclass','tired'],
  s11:['tired','nofuel','meal'],
  s12:['bored','lost','beforebed'],
  s13:['beforebed','bored'],
  s14:['afterclass','beforebed'],
  s15:['nofuel','tired'],
  s16:['afterclass','noclass']
};

var CAT_MUST='must', CAT_WANT='want', CAT_ROUTINE='routine';
var CAT_LABEL = {};
CAT_LABEL[CAT_MUST] = '必须处理';
CAT_LABEL[CAT_WANT] = '今天想完成';
CAT_LABEL[CAT_ROUTINE] = '每天重复';

/* ==================== 工具 ==================== */
function pad(n){ return n < 10 ? '0' + n : '' + n; }
function fmt(d){ return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()); }
function parse(s){ var p = String(s).split('-'); return new Date(+p[0], +p[1]-1, +p[2]); }
function addDays(s, n){ var d = parse(s); d.setDate(d.getDate()+n); return fmt(d); }
function nowHHMM(){ var d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
/* 一天可以有多个标记（荧光笔），每个带粗细 size 1~3 */
function markItems(key){
  var m = S.marks[key];
  if(!m) return [];
  if(Array.isArray(m.items)) return m.items;
  if(m.penId) return [{ penId: m.penId, size: 2 }];
  return [];
}
function diffDays(a, b){ return Math.round((parse(a) - parse(b)) / 86400000); }
function uid(p){ return (p||'x') + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function $(id){ return document.getElementById(id); }
function esc(t){
  return String(t == null ? '' : t).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function rgba(hex, a){
  var n = parseInt(String(hex).slice(1), 16);
  return 'rgba(' + ((n>>16)&255) + ',' + ((n>>8)&255) + ',' + (n&255) + ',' + a + ')';
}
function el(tag, cls, txt){
  var e = document.createElement(tag);
  if(cls) e.className = cls;
  if(txt != null) e.textContent = txt;
  return e;
}
function sum(arr){ var s = 0; for(var i=0;i<arr.length;i++) s += (+arr[i] || 0); return s; }
/* ---------- 今日重点的度量：目标 {value, unit} 或 null ----------
   计时类（分钟/小时）记分钟数，展示时按单位换算；计数类（次/杯/页/个/自定义）一次记 1。 */
var FOCUS_UNITS = ['分钟', '小时', '次', '杯', '页', '个'];
var FOCUS_TIME_UNITS = ['分钟', '小时'];
function focusUnit(it){
  if(!it) return '分钟';
  var g = it.goal;
  if(g && g.unit) return g.unit;
  return it.unit || '分钟';      /* 不设目标时单位仍留在条目上，值才不会忽然变回分钟 */
}
function focusHasGoal(it){
  var g = it && it.goal;
  return !!(g && +g.value > 0);
}
function focusIsTime(it){ return FOCUS_TIME_UNITS.indexOf(focusUnit(it)) >= 0; }
function toHours(min){ return Math.round((+min || 0) / 6) / 10; }
function fmtNum(n){
  n = +n || 0;
  return Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : n.toFixed(1);
}
/* 时长在所有数据里统一存「总秒数」。展示：整分钟说「N 分钟」，有零头说「N 分 S 秒」 */
function durText(sec){
  sec = Math.max(0, Math.round(+sec || 0));
  if(!sec) return '';
  if(sec % 60 === 0) return (sec / 60) + ' 分钟';
  var m = Math.floor(sec / 60);
  return (m ? m + ' 分 ' : '') + (sec % 60) + ' 秒';
}
function durParts(sec){
  sec = Math.max(0, Math.round(+sec || 0));
  return { m: Math.floor(sec / 60), s: sec % 60 };
}
function durFromInputs(mEl, sEl){
  var m = clamp(parseInt(mEl && mEl.value, 10) || 0, 0, 599);
  var s = clamp(parseInt(sEl && sEl.value, 10) || 0, 0, 59);
  return m * 60 + s;
}
/* 目标行文案：有目标「目标 3 杯」，没目标返回空串 */
function focusGoalText(it){
  if(!focusHasGoal(it)) return '';
  return '目标 ' + fmtNum(it.goal.value) + ' ' + it.goal.unit;
}
/* 一条记录折算成这个条目自己的单位 */
function focusLogAmount(l, it){
  if(it && focusIsTime(it)){
    var m = l.minutes || 0;
    return focusUnit(it) === '小时' ? toHours(m) : m;
  }
  if(!it) return l.minutes || 0;
  return l.count || 0;
}
/* 某条目某天累计（展示单位） */
function focusSum(it, dateKey){
  var min = 0, cnt = 0;
  S.itemLogs.forEach(function(l){
    if(l.itemId !== it.id || l.date !== dateKey) return;
    min += l.minutes || 0;
    cnt += l.count || 0;
  });
  if(focusIsTime(it)) return focusUnit(it) === '小时' ? toHours(min) : min;
  return cnt;
}
/* 一条记录读成一句话：健身 30 分钟 / 喝水 2 杯 */
function focusLogText(l){
  var it = byId(S.settings.focusItems, l.itemId);
  if(!it) return l.count ? (fmtNum(l.count) + ' 次') : (fmtNum(l.minutes || 0) + ' 分钟');
  return it.text + ' ' + fmtNum(focusLogAmount(l, it)) + ' ' + focusUnit(it);
}
function byId(list, id){
  if(!list || !id) return null;
  for(var i = 0; i < list.length; i++) if(list[i] && list[i].id === id) return list[i];
  return null;
}
/* 只绑一次：同一个元素同一类事件重复绑会被这里挡掉 */
function bindOnce(node, type, fn, key){
  if(!node) return false;
  var flag = 'bound' + type + (key || '');
  if(node.dataset[flag]) return false;
  node.dataset[flag] = '1';
  node.addEventListener(type, fn);
  return true;
}
/* 插件开关：名字和说明以代码里的清单为准，存档只记开没开 */
function pluginOn(id){
  var p = byId(S.plugins, id);
  return !!(p && p.enabled);
}
function normalizePlugins(list, defs){
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function(p){
    if(!p || typeof p.id !== 'string') return;
    var def = byId(defs, p.id);
    if(!def || byId(out, p.id)) return;      /* 代码里已删掉的插件、重复项都不留 */
    out.push({ id:p.id, name:def.name, desc:def.desc, enabled:p.enabled === true });
  });
  defs.forEach(function(def){
    if(byId(out, def.id)) return;
    out.push({ id:def.id, name:def.name, desc:def.desc, enabled:def.enabled === true });
  });
  return out;
}
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function weekdayCN(d){ return ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()]; }

function toast(msg, act, cb){
  var t = $('toast');
  t.innerHTML = esc(msg) + (act ? ' <button class="t-act" id="tAct">' + esc(act) + '</button>' : '');
  t.style.pointerEvents = act ? 'auto' : 'none';
  if(act){
    $('tAct').addEventListener('click', function(ev){
      ev.stopPropagation();
      t.classList.remove('on');
      if(cb) cb();
    });
  }
  t.classList.add('on');
  clearTimeout(window.__tt);
  window.__tt = setTimeout(function(){ t.classList.remove('on'); }, act ? 3200 : 1700);
}
function floatText(txt, x, y){
  var f = el('div','float',txt);
  f.style.left = x + 'px'; f.style.top = y + 'px';
  document.body.appendChild(f);
  setTimeout(function(){ if(f.parentNode) f.parentNode.removeChild(f); }, 950);
}
function buzz(){ if(navigator.vibrate) try{ navigator.vibrate(8); }catch(e){} }

/* ==================== 数据 ==================== */
function defaultPens(){
  return [
    {id:'p1', color:'#B6CBA8', emoji:'🌿', name:'平稳'},
    {id:'p2', color:'#A8C0D8', emoji:'✨', name:'不错'},
    {id:'p3', color:'#E8CEA8', emoji:'☁',  name:'有点累'}
  ];
}
function defaultTags(){
  return ['少刷手机','散步','喝了水','认真一会儿','晚睡了'].map(function(n,i){
    return {id:'tag'+i, name:n};
  });
}
function defaultSuggestions(){
  return [
    {id:'s1',  name:'出去走 20 分钟',        cat:'身体', duration:1200, tags:['bored','tired','quiet'],   times:['afternoon','evening'], priority:2, random:true, enabled:true, note:'不带手机，绕一圈就回来'},
    {id:'s2',  name:'练一组力量',            cat:'健身', duration:2400, tags:['train','fresh'],           times:['afternoon','evening'], priority:3, random:true, enabled:true, note:'主项 4 组，练完拉伸'},
    {id:'s3',  name:'拉伸 10 分钟',          cat:'健身', duration:600, tags:['tired','sore','train'],    times:['evening','night'],     priority:2, random:true, enabled:true, note:'肩颈和腿后侧'},
    {id:'s4',  name:'洗澡，把自己收拾干净',  cat:'身体', duration:1200, tags:['tired','empty','low'],     times:['evening','night'],     priority:3, random:true, enabled:true, note:'洗完就算今天完成了一件事'},
    {id:'s5',  name:'补今天没听懂的那一点',  cat:'学习', duration:1200, tags:['study','postclass'],       times:['afternoon','evening'], priority:3, random:true, enabled:true, note:'只弄一个点，不铺开'},
    {id:'s6',  name:'看 20 分钟书',          cat:'学习', duration:1200, tags:['study','bored','quiet'],   times:['afternoon','night'],   priority:2, random:true, enabled:true, note:'纸质书，手机放远'},
    {id:'s7',  name:'写 10 分钟手账',        cat:'生活', duration:600, tags:['journal','sad','quiet'],   times:['evening','night'],     priority:3, random:true, enabled:true, note:'今天发生了什么，三句话就够'},
    {id:'s8',  name:'把桌面清干净',          cat:'生活', duration:900, tags:['chores','bored','anxious'],times:['afternoon','evening'], priority:1, random:true, enabled:true, note:'只清桌面，不扩大战场'},
    {id:'s9',  name:'洗衣服',                cat:'生活', duration:600, tags:['chores'],                  times:['afternoon','evening'], priority:1, random:true, enabled:true, note:'顺手把明天要穿的也拿出来'},
    {id:'s10', name:'吃点东西，别空腹',      cat:'身体', duration:900, tags:['hungry','tired'],          times:['morning','afternoon','evening'], priority:3, random:true, enabled:true, note:'有热的最好'},
    {id:'s11', name:'睡 20 分钟',            cat:'身体', duration:1200, tags:['tired','sleepy','empty'],  times:['afternoon'],           priority:2, random:true, enabled:true, note:'定个闹钟，别睡过头'},
    {id:'s12', name:'把手机放远，做件现实里的事', cat:'心情', duration:900, tags:['phone','anxious','bored'], times:['any'],             priority:2, random:true, enabled:true, note:'哪怕只是倒杯水'},
    {id:'s13', name:'给家里或朋友发个消息',  cat:'心情', duration:300,  tags:['lonely','sad'],            times:['evening'],             priority:1, random:true, enabled:true, note:'不用聊很久'},
    {id:'s14', name:'明天下课要用的东西先装好', cat:'生活', duration:600, tags:['postclass','chores'],   times:['evening','night'],     priority:2, random:true, enabled:true, note:'装好就不用早上慌'},
    {id:'s15', name:'什么都不做，躺 10 分钟', cat:'心情', duration:600, tags:['empty','tired'],           times:['any'],                 priority:1, random:true, enabled:true, note:'不算偷懒，算充电'},
    {id:'s16', name:'取快递',                cat:'生活', duration:900, tags:['parcel'],                  times:['afternoon','evening'], priority:2, random:true, enabled:true, note:'顺手把纸箱带下去'}
  ].map(function(s){ s.scenes = DEFAULT_SCENES[s.id] || []; return s; });
}
function defaultTasks(){
  return [
    {id:'t1', title:'护肤',   cat:CAT_ROUTINE, repeat:'daily', duration:300,  done:{}, createdAt:Date.now()},
    {id:'t2', title:'刷牙',   cat:CAT_ROUTINE, repeat:'daily', duration:180,  done:{}, createdAt:Date.now()},
    {id:'t3', title:'洗衣服', cat:CAT_ROUTINE, repeat:'daily', duration:600, done:{}, createdAt:Date.now()}
  ];
}
function defaultPlugins(){
  return [
    { id:'tags', name:'标签打卡', desc:'点一下记一次，用来数频率', enabled:false }
  ];
}
function defaults(){
  return {
    v: 4,
    tasks: defaultTasks(),
    schedule: [],
    plans: [],
    notes: {},          // {date: text}
    marks: {},          // {date: {penId, updatedAt}}
    pens: defaultPens(),
    tags: defaultTags(),
    tagLogs: [],        // {id, tagId, date, ts}
    suggestions: defaultSuggestions(),
    doneSugg: {},       // {date: {suggId: true}}
    workouts: [],       // {id, date, start, minutes, parts[], kcal, note}
    studyLogs: [],      // {id, date, minutes, what}
    decisionLog: [],    // {id, date, ts, title, duration, actual, mode, input, src}
    restDays: [],       // ['YYYY-MM-DD']
    flashes: [],
    itemLogs: [],   // 自己填的重点记录 {id,itemId,date,time,minutes,what,feel}
    plugins: defaultPlugins(),   // 首页功能插件 {id,name,desc,enabled}，关掉只隐藏入口，数据不动
    settings: {
      resetHour: 4,
      theme: 'default',
      showDone: true,
      remind: true,
      remindDismissed: '',
      goals: { trainMin: 30, studyMin: 40 },
      libFilter: '全部',
      randFilter: '全部',
      uiScale: 1.2,
      tasksFold: false,   // 今日待办是否折叠成卡片堆
      focusSeedV: 0,   // 预设补回标记，写过 2 之后用户删掉的预设不再塞回来
      focusItems: [
        { id:'fi-train', text:'健身', goal:{ value:30, unit:'分钟' }, mode:'multi', options: PARTS.slice() },
        { id:'fi-study', text:'学习', goal:{ value:40, unit:'分钟' }, mode:'text', label:'学了什么', ph:'高数 / 单词…（可留空）' }
      ]
    }
  };
}

var S = defaults();
var migrated = false;

/* ---------- 主题色（莫兰迪预设） ---------- */
var THEME_KEYS = ['default', 'mist', 'clay', 'matcha', 'lotus', 'warm'];
function applyTheme(){
  var t = S.settings.theme || 'default';
  document.documentElement.classList.remove('theme-mist','theme-clay','theme-matcha','theme-lotus','theme-warm');
  if(t !== 'default') document.documentElement.classList.add('theme-' + t);
}
function themeRGB(){
  var map = {
    default: '111,143,126', mist: '97,114,141', clay: '183,113,95',
    matcha: '92,117,97', lotus: '142,122,142', warm: '106,93,87'
  };
  return map[S.settings.theme] || map.default;
}

function loadState(){
  try{
    var raw = localStorage.getItem(KEY);
    if(raw){
      var o = JSON.parse(raw);
      deepMerge(S, o);
      return;
    }
  }catch(e){}
  // 迁移 v3
  try{
    var old = localStorage.getItem(OLD);
    if(!old) return;
    var v3 = JSON.parse(old);
    migrate(v3);
    migrated = true;
    save();
  }catch(e){}
}
function deepMerge(base, src){
  for(var k in src){
    if(!(k in base)){ base[k] = src[k]; continue; }
    var b = base[k], s = src[k];
    if(b && s && typeof b === 'object' && typeof s === 'object' && !Array.isArray(b) && !Array.isArray(s)){
      deepMerge(b, s);
    }else if(s !== undefined){
      base[k] = s;
    }
  }
}
function migrate(v3){
  if(!v3 || typeof v3 !== 'object') return;
  // 待办组 → 分类待办
  if(Array.isArray(v3.groups)){
    var tasks = [];
    v3.groups.forEach(function(g){
      var cat = /日常|习惯|每天/.test(g.name || '') ? CAT_ROUTINE : CAT_WANT;
      (g.items || []).forEach(function(it){
        tasks.push({
          id: it.id || uid('t'),
          title: it.title || '未命名',
          cat: cat,
          repeat: cat === CAT_ROUTINE ? 'daily' : 'once',
          duration: 0, done: {}, createdAt: Date.now()
        });
      });
    });
    if(tasks.length){
      var titles = {};
      tasks.forEach(function(t){ titles[t.title] = 1; });
      S.tasks = tasks.concat(S.tasks.filter(function(t){ return !titles[t.title]; }));
    }
  }
  // 旧的勾选记录 → done 映射
  if(v3.completions){
    for(var dk in v3.completions){
      var dm = v3.completions[dk] || {};
      for(var tid in dm){
        if(!dm[tid]) continue;
        for(var i=0;i<S.tasks.length;i++){
          if(S.tasks[i].id === tid){ S.tasks[i].done[dk] = 1; break; }
        }
      }
    }
  }
  if(v3.pens && v3.pens.length) S.pens = v3.pens;
  if(v3.marks) S.marks = v3.marks;
  if(v3.tags && v3.tags.length) S.tags = v3.tags;
  if(Array.isArray(v3.tagLogs)) S.tagLogs = v3.tagLogs;
  if(v3.dailyNotes) S.notes = v3.dailyNotes;
  if(Array.isArray(v3.decisions)){
    S.decisionLog = v3.decisions.map(function(d){
      return { id:d.id || uid('d'), date:d.date, ts:d.ts || Date.now(), title:d.title, duration:(+d.mins || 0) * 60, actual:0, mode:'migrated', input:'' };
    });
  }
  // 按天的部位打卡 → 训练记录（时长未知，记 0）
  if(Array.isArray(v3.workouts)){
    var byDate = {};
    v3.workouts.forEach(function(w){
      if(!w || !w.date) return;
      if(!byDate[w.date]) byDate[w.date] = [];
      if(w.type) byDate[w.date].push(w.type);
    });
    Object.keys(byDate).forEach(function(d){
      S.workouts.push({ id: uid('w'), date:d, start:'', minutes:0, parts:byDate[d], kcal:null, note:'从旧版迁移，时长未记' });
    });
  }
  // 旧规则 → 建议库
  if(Array.isArray(v3.rules) && v3.rules.length){
    v3.rules.forEach(function(r){
      S.suggestions.push({
        id: uid('s'), name: r.title || '旧建议', cat:'旧规则', duration:(+r.mins || 0) * 60,
        tags:[], times:['any'], priority:1, random:false, enabled:true, note: r.desc || ''
      });
    });
  }
  if(v3.resetHour != null) S.settings.resetHour = v3.resetHour;
  if(v3.showDone != null) S.settings.showDone = v3.showDone;
}
function save(){
  try{ localStorage.setItem(KEY, JSON.stringify(S)); }catch(e){}
}
function normalize(){
  var d = defaults();
  ['tasks','schedule','plans','pens','tags','tagLogs','suggestions','workouts','studyLogs','decisionLog','restDays','flashes','itemLogs'].forEach(function(k){
    if(!Array.isArray(S[k])) S[k] = d[k];
  });
  ['notes','marks','doneSugg'].forEach(function(k){
    if(!S[k] || typeof S[k] !== 'object' || Array.isArray(S[k])) S[k] = d[k];
  });
  if(!S.settings || typeof S.settings !== 'object' || Array.isArray(S.settings)) S.settings = d.settings;
  S.plugins = normalizePlugins(S.plugins, d.plugins);
  if(!S.settings.goals || typeof S.settings.goals !== 'object') S.settings.goals = d.settings.goals;
  if(typeof S.settings.resetHour !== 'number') S.settings.resetHour = 4;
  if(THEME_KEYS.indexOf(S.settings.theme) < 0) S.settings.theme = 'default';
  if(!S.settings.libFilter) S.settings.libFilter = '全部';
  if(!S.settings.randFilter) S.settings.randFilter = '全部';
  if(!Array.isArray(S.settings.focusItems)) S.settings.focusItems = [];
  S.settings.focusItems = S.settings.focusItems.filter(function(it){ return it && it.text; }).map(function(it){
    it.id = it.id || uid('fi');
    /* 目标：{ value, unit } 或 null（不设目标）。老存档只有 target（分钟），这里就地迁移 */
    var g = it.goal;
    if(g && typeof g === 'object'){
      var unit = (typeof g.unit === 'string' && g.unit.trim()) ? g.unit.trim().slice(0, 4) : '分钟';
      var val = +g.value;
      it.unit = unit;
      it.goal = (val > 0) ? { value: val, unit: unit } : null;
    }else if(it.goal === null){
      it.goal = null;
      it.unit = (typeof it.unit === 'string' && it.unit.trim()) ? it.unit.trim().slice(0, 4) : '分钟';
    }else{
      var oldv = +it.target;
      it.goal = (oldv > 0) ? { value: oldv, unit: '分钟' } : null;
      it.unit = '分钟';
    }
    delete it.target;
    delete it.auto;   // 「记录来源」功能已删，重点统一走自己的账本
    /* 输入方式：multi（chips 多选）/ text（自填），老数据默认 text */
    if(it.mode !== 'multi' && it.mode !== 'text') it.mode = 'text';
    if(it.mode === 'multi'){
      if(!Array.isArray(it.options)) it.options = [];
      it.options = it.options.filter(function(o){ return o && typeof o === 'string'; });
    }else{
      if(typeof it.label !== 'string') it.label = '';
      if(typeof it.ph !== 'string') it.ph = '';
    }
    /* 老存档的预设健身/学习补上各自默认的输入方式（用户没自定义过才补） */
    if(it.id === 'fi-train' && it.mode === 'text' && !it.label && !it.ph){ it.mode = 'multi'; it.options = PARTS.slice(); }
    if(it.id === 'fi-study' && it.mode === 'text' && !it.label && !it.ph){ it.label = '学了什么'; it.ph = '高数 / 单词…（可留空）'; }
    return it;
  });
  // 预设「健身」「学习」默认就在；这里一次性补回被清掉的那两条，补过之后用户删掉就不再塞回来
  if(S.settings.focusSeedV !== 2){
    var haveName = {};
    S.settings.focusItems.forEach(function(it){ haveName[it.text] = 1; });
    var seed = d.settings.focusItems.filter(function(p){ return !haveName[p.text]; });
    S.settings.focusItems = seed.concat(S.settings.focusItems);
    S.settings.focusSeedV = 2;
  }
  delete S.focusLog;   // 旧的「+1 次」记录不再用，记录统一走分钟
  if(typeof S.settings.uiScale !== 'number' || S.settings.uiScale < 0.85 || S.settings.uiScale > 1.6) S.settings.uiScale = 1.2;
  else if(S.settings.uiScale === 1.12) S.settings.uiScale = 1.2;  // 旧默认值随新默认一起调大
  // 标记：老数据 {penId} → 新数据 {items:[{penId,size}]}
  Object.keys(S.marks).forEach(function(k){
    var m = S.marks[k];
    if(!m || typeof m !== 'object'){ delete S.marks[k]; return; }
    if(!Array.isArray(m.items)){
      m.items = m.penId ? [{ penId: m.penId, size: 2 }] : [];
      delete m.penId;
    }
    m.items = m.items.filter(function(it){ return it && it.penId; });
    m.items.forEach(function(it){
      it.size = it.size || 2;
      if(it.size < 1 || it.size > 3) it.size = 2;
    });
    if(!m.items.length) delete S.marks[k];
  });
  /* 旧存档把时长记成 mins（分钟），新版统一用 duration（总秒数） */
  function normalizeDuration(row){
    if(!row || typeof row !== 'object') return;
    if(typeof row.duration !== 'number' || !isFinite(row.duration)){
      var m = +row.mins;
      row.duration = (m > 0) ? Math.round(m * 60) : 0;
    }
    delete row.mins;
  }
  S.suggestions.forEach(normalizeDuration);
  S.tasks.forEach(normalizeDuration);
  S.decisionLog.forEach(function(d){
    if(typeof d.duration !== 'number' || !isFinite(d.duration)){
      d.duration = (+d.mins > 0) ? Math.round((+d.mins) * 60) : 0;
    }
    delete d.mins;
    if(typeof d.actual !== 'number') d.actual = 0;
  });
  S.tasks.forEach(function(t){
    if(!t.done || typeof t.done !== 'object') t.done = {};
    if(!t.cat) t.cat = CAT_WANT;
    if(!t.repeat) t.repeat = t.cat === CAT_ROUTINE ? 'daily' : 'once';
  });
  S.suggestions.forEach(function(sg){
    if(!Array.isArray(sg.tags)) sg.tags = [];
    if(!Array.isArray(sg.scenes)) sg.scenes = DEFAULT_SCENES[sg.id] || [];
    if(!Array.isArray(sg.times) || !sg.times.length) sg.times = ['any'];
    if(typeof sg.enabled !== 'boolean') sg.enabled = true;
    if(typeof sg.random !== 'boolean') sg.random = true;
  });
  S.workouts.forEach(function(w){
    if(!Array.isArray(w.parts)) w.parts = [];
    w.minutes = +w.minutes || 0;
  });
  S.plans.forEach(function(p){
    if(!p.date) p.date = TODAY();
    if(typeof p.done !== 'boolean') p.done = false;
  });
}

/* ==================== 日期 / 业务日 ==================== */
function bizDate(){
  var d = new Date();
  if(d.getHours() < (+S.settings.resetHour || 0)) d.setDate(d.getDate() - 1);
  return d;
}
function TODAY(){ return fmt(bizDate()); }
function realToday(){ return fmt(new Date()); }
function isDone(t, date){ return !!(t.done && t.done[date] === 1); }
function isSkipped(t, date){ return !!(t.done && t.done[date] === 2); }
function doneCountOn(t){
  var n = 0; for(var k in (t.done||{})) if(t.done[k]) n++;
  return n;
}

/* ==================== 导航 ==================== */
var currentPage = 'pToday';
/* ==================== 滚动渐入：滑到哪，卡片才淡入到哪 ==================== */
var rvTimer = null, rvBusy = false;
var RV_SEL = '.sec, .card, .goal, .heat-card, .res';
var RV_MOVE = 'translateY(18px)';

function rvShow(el, delay){
  setTimeout(function(){
    el.style.opacity = '1';
    el.style.transform = 'none';
    setTimeout(function(){
      el.style.opacity = '';
      el.style.transform = '';
      el.style.transition = '';
    }, 850);
  }, delay || 0);
}
function rvPrepare(el){
  if(el.dataset.rv) return;
  el.dataset.rv = '1';
  el.style.transition = 'opacity .8s var(--ease),transform .8s var(--ease)';
  el.style.opacity = '0';
  el.style.transform = RV_MOVE;
}
/* 重建容器前调用：容器已经展示过的话，重建出来的卡片直接显示，不重播进场动画 */
function rvMarkKeep(box){
  if(!box) return;
  if(box.querySelector('[data-rv-in="1"]')) box.dataset.rvKeep = '1';
}
function rvScan(){
  var page = document.querySelector('.page.on');
  if(!page) return;
  var quick = 0;
  var keepers = page.querySelectorAll('[data-rv-keep]');
  page.querySelectorAll(RV_SEL).forEach(function(el){
    var r = el.getBoundingClientRect();
    if(el.dataset.rvIn){
      // 滚出视野就重新武装：不管往上还是往下滚，再次进入都会重新浮现
      if(r.bottom < -40 || r.top > window.innerHeight + 40) delete el.dataset.rvIn;
      return;
    }
    if(r.height < 2) return;   // 空占位不参与
    var inView = r.top < window.innerHeight * 0.96 && r.bottom > 0;
    if(inView && el.closest('[data-rv-keep]')){
      el.dataset.rvIn = '1';   // 重建出来的元素直接显示，不抖不闪
      return;
    }
    rvPrepare(el);
    if(inView){
      el.dataset.rvIn = '1';
      rvShow(el, Math.min(quick++, 3) * 70);
    }
  });
  keepers.forEach(function(k){ delete k.dataset.rvKeep; });
}
function rvRefresh(){
  clearTimeout(rvTimer);
  rvTimer = setTimeout(rvScan, 60);
}
function rvOnScroll(){
  if(rvBusy) return;
  rvBusy = true;
  setTimeout(function(){ rvBusy = false; rvScan(); }, 80);
}
window.addEventListener('scroll', rvOnScroll, { passive: true });
window.addEventListener('resize', rvOnScroll, { passive: true });

function showPage(id){
  currentPage = id;
  var pages = document.querySelectorAll('.page');
  for(var i=0;i<pages.length;i++) pages[i].classList.remove('on');
  $(id).classList.add('on');
  var bs = $('nav').querySelectorAll('button');
  for(var j=0;j<bs.length;j++) bs[j].classList.toggle('on', bs[j].dataset.page === id);
  window.scrollTo(0,0);
  if(id === 'pToday') renderToday();
  if(id === 'pDecide'){
    renderScenes();
    renderLib();
    if(decState.mode === 'scene' && decState.scene) renderSceneResult(decState.scene);
    else if(decState.list.length) renderDecisionResult();
  }
  if(id === 'pRecords'){ renderRecords(); }
  if(id === 'pSettings') renderSettings();
  rvRefresh();
}

/* ==================== 头部 ==================== */
function renderHeader(){
  var d = new Date(), h = d.getHours();
  var greet = '早上好';
  if(h >= 5 && h < 11) greet = '早上好';
  else if(h >= 11 && h < 14) greet = '中午好';
  else if(h >= 14 && h < 18) greet = '下午好';
  else if(h >= 18 && h < 23) greet = '晚上好';
  else greet = '还没睡';
  $('hdHi').textContent = greet;
  $('hdDate').textContent = (d.getMonth()+1) + '月' + d.getDate() + '日 · ' + weekdayCN(d);
}

/* ==================== 通用面板 / 弹窗 ==================== */
function openSheet(html){
  $('sheetBody').innerHTML = html;
  $('mask').classList.add('on');
  $('sheet').scrollTop = 0;
  return $('sheetBody');
}
function closeSheet(){ $('mask').classList.remove('on'); }

/* ==================== 统一记录弹层 ====================
   健身 / 学习 / 手账共用同一套版式：标题 → 日期时间 → 快捷时长 → 时长+补充 → 标签 → 备注 → 按钮
   cfg: title sub date time minutes(false 隐藏) minutesLabel extra{label,value,placeholder}
        tagOptions[] / tagFree + tagValue tagLabel note noteArea noteLabel notePlaceholder
        needMinutes lockDate okText onDelete onSave({date,time,minutes,tags,extra,tagFree,note})
*/
var LOG_QUICK = [15, 30, 45, 60];
function openLogSheet(cfg){
  var tags = (cfg.tags || []).slice();
  var html = '<div class="shd"><div class="shd-t">' + esc(cfg.title) + '</div>' +
    '<div class="shd-s">' + esc(cfg.sub || '') + '</div></div>';

  html += '<div class="row2">' +
    '<div class="field"><div class="field-l">日期</div><input class="inp" id="lgDate" type="date" value="' + esc(cfg.date || TODAY()) + '"' + (cfg.lockDate ? ' disabled' : '') + '></div>' +
    (cfg.time === null ? '' : '<div class="field"><div class="field-l">时间</div><input class="inp" id="lgTime" type="time" value="' + esc(cfg.time || '') + '"></div>') +
    '</div>';

  if(cfg.minutes !== false){
    var quick = (cfg.quick === false) ? [] : (cfg.quick && cfg.quick.length ? cfg.quick : LOG_QUICK);
    if(quick.length){
      html += '<div class="field"><div class="field-l">' + esc(cfg.quickLabel || '快捷时长') + '</div><div class="chips" id="lgQuick">' +
        quick.map(function(m){
          var label = cfg.quickUnit ? (m + ' ' + cfg.quickUnit) : (m === 60 ? '1 小时' : m + ' 分钟');
          return '<button class="chip" data-m="' + m + '">' + label + '</button>';
        }).join('') +
        '</div></div>';
    }
    html += '<div class="row2">' +
        '<div class="field"><div class="field-l">' + esc(cfg.minutesLabel || '时长（分钟）') + '</div>' +
          '<input class="inp" id="lgMin" type="number" inputmode="decimal" placeholder="—" value="' + (cfg.minutes || '') + '"></div>' +
        (cfg.extra ? '<div class="field"><div class="field-l">' + esc(cfg.extra.label) + '</div>' +
          '<input class="inp" id="lgExtra" type="number" inputmode="numeric" placeholder="' + esc(cfg.extra.placeholder || '—') + '" value="' + (cfg.extra.value || '') + '"></div>' : '') +
      '</div>';
  }

  if(cfg.tagOptions){
    html += '<div class="field"><div class="field-l">' + esc(cfg.tagLabel || '标签') + '</div><div class="chips" id="lgTags">' +
      cfg.tagOptions.map(function(t){
        return '<button class="chip' + (tags.indexOf(t) >= 0 ? ' on' : '') + '" data-t="' + esc(t) + '">' + esc(t) + '</button>';
      }).join('') + '</div></div>';
  }else if(cfg.tagFree){
    html += '<div class="field"><div class="field-l">' + esc(cfg.tagLabel || '标签') + '</div>' +
      '<input class="inp" id="lgTagFree" maxlength="24" placeholder="' + esc(cfg.tagPlaceholder || '') + '" value="' + esc(cfg.tagValue || '') + '"></div>';
  }

  html += '<div class="field"><div class="field-l">' + esc(cfg.noteLabel || '备注') + '</div>' +
    (cfg.noteArea
      ? '<textarea class="ta" id="lgNote" style="min-height:150px" placeholder="' + esc(cfg.notePlaceholder || '') + '">' + esc(cfg.note || '') + '</textarea>'
      : '<input class="inp" id="lgNote" maxlength="40" placeholder="' + esc(cfg.notePlaceholder || '可留空') + '" value="' + esc(cfg.note || '') + '">') +
    '</div>';

  html += '<div class="acts">' + (cfg.onDelete ? '<button class="btn d fx" id="lgDel">删除</button>' : '') +
    '<button class="btn g" id="lgNo">取消</button><button class="btn p" id="lgOk">' + esc(cfg.okText || '保存') + '</button></div>';

  var body = openSheet(html);
  var minEl = body.querySelector('#lgMin');
  var qk = body.querySelector('#lgQuick');
  if(qk && minEl){
    qk.querySelectorAll('.chip').forEach(function(c){
      c.addEventListener('click', function(){
        minEl.value = c.dataset.m;
        qk.querySelectorAll('.chip').forEach(function(x){ x.classList.remove('on'); });
        c.classList.add('on');
      });
    });
  }
  var tagBox = body.querySelector('#lgTags');
  if(tagBox){
    tagBox.querySelectorAll('.chip').forEach(function(c){
      c.addEventListener('click', function(){
        var t = c.dataset.t, i = tags.indexOf(t);
        if(i >= 0) tags.splice(i, 1); else tags.push(t);
        c.classList.toggle('on');
      });
    });
  }
  if(cfg.noteArea) setTimeout(function(){ var n = body.querySelector('#lgNote'); if(n) n.focus(); }, 280);
  body.querySelector('#lgNo').addEventListener('click', closeSheet);
  if(cfg.onDelete) body.querySelector('#lgDel').addEventListener('click', cfg.onDelete);
  body.querySelector('#lgOk').addEventListener('click', function(){
    var m = minEl ? (parseFloat(minEl.value) || 0) : 0;
    if(cfg.needMinutes && m <= 0){ toast(cfg.needMsg || '填一下时长'); if(minEl) minEl.focus(); return; }
    var extraEl = body.querySelector('#lgExtra');
    var freeEl = body.querySelector('#lgTagFree');
    cfg.onSave({
      date: body.querySelector('#lgDate').value || TODAY(),
      time: body.querySelector('#lgTime') ? body.querySelector('#lgTime').value : '',
      minutes: m,
      tags: tags,
      extra: extraEl ? (parseInt(extraEl.value, 10) || null) : null,
      tagFree: freeEl ? freeEl.value.trim() : '',
      note: body.querySelector('#lgNote').value.trim()
    });
  });
  return body;
}


var modalCfg = null, modalInput = null;
function openModal(cfg){
  modalCfg = cfg;
  $('mTitle').textContent = cfg.title || '';
  $('mSub').textContent = cfg.sub || '';
  $('mSub').style.display = cfg.sub ? 'block' : 'none';
  var body = $('mBody');
  body.innerHTML = '';
  modalInput = null;
  if(cfg.input){
    var inp = document.createElement('input');
    inp.className = 'inp';
    inp.type = cfg.numeric ? 'number' : 'text';
    if(cfg.numeric) inp.inputMode = 'numeric';
    inp.placeholder = cfg.placeholder || '';
    inp.value = cfg.value || '';
    inp.style.marginBottom = '12px';
    if(!cfg.numeric) inp.maxLength = cfg.maxLength || 24;
    inp.addEventListener('keydown', function(e){ if(e.key === 'Enter') $('mOk').click(); });
    body.appendChild(inp);
    modalInput = inp;
    setTimeout(function(){ try{ inp.focus(); inp.select(); }catch(e){} }, 180);
  }else if(cfg.message){
    body.appendChild(el('div','m-msg', cfg.message));
  }
  $('mOk').textContent = cfg.okText || '确定';
  $('mOk').className = 'btn ' + (cfg.danger ? 'd' : 'p');
  $('modalMask').classList.add('on');
  if(cfg.focusCancel && !cfg.input){
    setTimeout(function(){ try{ $('mCancel').focus(); }catch(e){} }, 180);
  }
}
function closeModal(){ $('modalMask').classList.remove('on'); }
function confirmBox(title, msg, cb, opts){
  opts = opts || {};
  openModal({
    title:title, message:msg, danger:true,
    okText: opts.okText || '确定', onOk:cb,
    lock: opts.lock !== false,        /* 确认框默认不许点背景关掉，必须显式取消/确认 */
    focusCancel: true
  });
}

/* ==================== 导入导出 ==================== */
function exportJSON(){
  var payload = {
    app: 'earthonline', version: 4, exportedAt: new Date().toISOString(), data: S
  };
  var blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'earthonline-' + todayReal() + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
  toast('已导出备份');
}

function importJSON(){
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.addEventListener('change', function(){
    var f = inp.files && inp.files[0];
    if(!f) return;
    var fr = new FileReader();
    fr.onload = function(){
      var parsed = null;
      try{ parsed = JSON.parse(fr.result); }catch(e){ toast('这个文件读不出来'); return; }
      var data = parsed && parsed.data ? parsed.data : parsed;
      if(!data || typeof data !== 'object' || !Array.isArray(data.tasks)){ toast('不像是备份文件'); return; }
      var n = 0;
      ['tasks','marks','tagLogs','workouts','studyLogs','decisionLog'].forEach(function(k){
        if(Array.isArray(data[k])) n += data[k].length;
        else if(data[k] && typeof data[k] === 'object') n += Object.keys(data[k]).length;
      });
      openModal({
        title:'确认恢复',
        message:'这份备份有 ' + n + ' 条数据，导出于 ' + (parsed.exportedAt ? String(parsed.exportedAt).slice(0,10) : '未知日期') + '。\n恢复会覆盖这台设备上的现有数据；当前数据会先自动存一份到本地，误操作还有退路。',
        okText:'恢复',
        onOk:function(){
          try{ localStorage.setItem(KEY + '-backup-' + Date.now(), JSON.stringify(S)); }catch(e){}
          S = defaults();
          deepMerge(S, data);
          normalize();
          save(); renderAll(); toast('已恢复');
        }
      });
    };
    fr.readAsText(f);
  });
  inp.click();
}

/* ==================== PDF 报告 ==================== */
function recordHas(k){
  var r = dayRecord(k);
  return !!(r.mark || r.groups.length || r.tags.length || r.workouts.length ||
            r.studies.length || r.decs.length || (r.plans && r.plans.length) || r.note);
}
function pdfRangeDays(from, to){
  var out = [], cur = from, guard = 0;
  while(cur <= to && guard < 400){ out.push(cur); cur = addDays(cur, 1); guard++; }
  return out;
}
function pdfMonths(from, to){
  var a = parse(from), b = parse(to), out = [];
  var y = a.getFullYear(), m = a.getMonth(), guard = 0;
  while((y < b.getFullYear() || (y === b.getFullYear() && m <= b.getMonth())) && guard < 24){
    out.push([y, m]);
    m++; if(m > 11){ m = 0; y++; }
    guard++;
  }
  return out;
}
function pdfMonthHtml(y, m, from, to){
  var first = new Date(y, m, 1), startW = first.getDay();
  var n = new Date(y, m + 1, 0).getDate(), cells = [];
  for(var i=0;i<startW;i++) cells.push('');
  for(var d=1;d<=n;d++) cells.push(fmt(new Date(y, m, d)));
  while(cells.length % 7) cells.push('');
  var h = '<div class="pv-cal"><div class="pv-cal-t">' + y + ' 年 ' + (m+1) + ' 月</div><div class="pv-cal-grid">';
  ['日','一','二','三','四','五','六'].forEach(function(w){ h += '<span class="hd">' + w + '</span>'; });
  cells.forEach(function(k){
    if(!k){ h += '<span class="out"></span>'; return; }
    var dt = parse(k), items = markItems(k), p = items.length ? penOf(items[0].penId) : null;
    var bg = p ? rgba(p.color, .32) : '#fff';
    var inRange = (k >= from && k <= to);
    var emos = items.map(function(it){ var q = penOf(it.penId); return q.emoji || ''; }).filter(Boolean).join(' ');
    h += '<span style="background:' + bg + ';' + (inRange ? 'border-color:#D8D0C2' : '') + '">' +
         dt.getDate() + (emos ? ' ' + esc(emos) : '') + (items.length > 1 ? ' <b style="font-weight:600">×' + items.length + '</b>' : '') + '</span>';
  });
  h += '</div></div>';
  return h;
}
/* 年度热力图：列=周、行=星期，按项目各画一张（GitHub 贡献图那种样子） */
/* 热力图分类：跟着首页「今日重点」的条目走，每条一张；末尾两张是整体概览 */
function heatCats(){
  var cats = (S.settings.focusItems || []).map(function(it){
    return {
      name: it.text,
      unit: focusUnit(it),
      get: function(k){ return focusSum(it, k); }
    };
  });
  cats.push({ name:'完成', unit:'件', get:function(k){
    var n = 0;
    S.tasks.forEach(function(t){ if(t.done && t.done[k] === 1) n++; });
    S.plans.forEach(function(p){ if(p.done && p.doneAt === k) n++; });
    return n;
  } });
  cats.push({ name:'记录', unit:'条', get:function(k){
    var n = 0;
    if((S.notes[k] || '').trim()) n += 1;
    if(S.marks[k]) n += 1;
    S.tagLogs.forEach(function(l){ if(l.date === k) n++; });
    return n;
  } });
  return cats;
}
function pdfHeatCats(){ return heatCats(); }
function pdfHeatWeeks(from, to){
  var a = parse(from), b = parse(to);
  var start = new Date(a.getFullYear(), a.getMonth(), a.getDate() - a.getDay());
  var weeks = [], cur = new Date(start), guard = 0;
  while(cur <= b && guard < 80){ weeks.push(new Date(cur)); cur.setDate(cur.getDate() + 7); guard++; }
  return weeks;
}
function pdfHeatLevel(v, max){
  if(!v) return 0;
  if(!max) return 1;
  return Math.max(1, Math.min(4, Math.ceil(v / max * 4)));
}
function pdfHeatMapHtml(cat, weeks, from, to){
  /* 先收集每日数值，求最大值做深浅档 */
  var vals = {}, max = 0, total = 0, days = 0;
  weeks.forEach(function(w){
    for(var i = 0; i < 7; i++){
      var d = new Date(w.getFullYear(), w.getMonth(), w.getDate() + i);
      var k = fmt(d);
      if(k < from || k > to) continue;
      var v = cat.get(k);
      vals[k] = v;
      if(v > 0){ days++; total += v; }
      if(v > max) max = v;
    }
  });
  /* 月历式网格：每行一周、7 列对齐星期，格子带日期数字 */
  var rows = '';
  weeks.forEach(function(w){
    var cells = '';
    for(var i = 0; i < 7; i++){
      var d = new Date(w.getFullYear(), w.getMonth(), w.getDate() + i);
      var k = fmt(d);
      if(k < from || k > to){ cells += '<i class="out"></i>'; continue; }
      cells += '<i class="lv' + pdfHeatLevel(vals[k] || 0, max) + '">' + d.getDate() + '</i>';
    }
    rows += '<div class="pv-hm-row">' + cells + '</div>';
  });
  var wds = ['日','一','二','三','四','五','六'].map(function(t){ return '<i>' + t + '</i>'; }).join('');
  return '<div class="pv-hm">' +
    '<div class="pv-hm-h"><span class="pv-hm-t">' + cat.name + '</span>' +
    '<span class="pv-hm-s">共 ' + total + ' ' + cat.unit + ' · ' + days + ' 天有记录</span></div>' +
    '<div class="pv-hm-wd">' + wds + '</div>' +
    '<div class="pv-hm-grid">' + rows + '</div></div>';
}
function pdfHeatSectionHtml(from, to){
  var weeks = pdfHeatWeeks(from, to);
  var h = '<div class="pv-heat">';
  pdfHeatCats().forEach(function(cat){ h += pdfHeatMapHtml(cat, weeks, from, to); });
  h += '</div>';
  h += '<div class="pv-hm-lg"><span>少</span><i class="lv0"></i><i class="lv1"></i><i class="lv2"></i><i class="lv3"></i><i class="lv4"></i><span>多</span></div>';
  return h;
}
function pdfStatsHtml(days){
  var inRange = {};
  days.forEach(function(k){ inRange[k] = 1; });
  var marked = Object.keys(S.marks).filter(function(k){ return inRange[k]; }).length;
  var doneN = 0;
  S.tasks.forEach(function(t){
    for(var k in (t.done||{})) if(t.done[k] === 1 && inRange[k]) doneN++;
  });
  var trainMin = sum(S.workouts.filter(function(w){ return inRange[w.date]; }).map(function(w){ return w.minutes || 0; }));
  var studyMin = sum(S.studyLogs.filter(function(x){ return inRange[x.date]; }).map(function(x){ return x.minutes || 0; }));
  var noteN = Object.keys(S.notes).filter(function(k){ return inRange[k] && (S.notes[k]||'').trim(); }).length;
  var planN = S.plans.filter(function(p){ return p.done && p.doneAt && inRange[p.doneAt]; }).length;

  var h = '<div class="pv-h2">这段时间</div><div class="pv-stats">';
  [['标记', marked + ' 天'], ['勾完', doneN + ' 次'], ['训练', trainMin + ' 分'],
   ['学习', studyMin + ' 分'], ['手账', noteN + ' 篇'], ['计划', planN + ' 件']].forEach(function(p){
    h += '<div class="pv-stat"><div class="l">' + p[0] + '</div><div class="v">' + esc(p[1]) + '</div></div>';
  });
  h += '</div>';

  var tagCount = {}, penCount = {};
  S.tagLogs.forEach(function(l){ if(inRange[l.date]) tagCount[l.tagId] = (tagCount[l.tagId]||0) + 1; });
  Object.keys(S.marks).forEach(function(k){
    if(!inRange[k]) return;
    markItems(k).forEach(function(it){
      var n = penOf(it.penId).name || '未命名';
      penCount[n] = (penCount[n] || 0) + 1;
    });
  });
  var tagNames = {};
  S.tags.forEach(function(t){ tagNames[t.id] = t.name; });
  var tags = Object.keys(tagCount).map(function(id){
    return (tagNames[id] || '已删除') + ' ×' + tagCount[id];
  });
  var pens = Object.keys(penCount).map(function(n){ return n + ' ' + penCount[n] + ' 天'; });
  h += '<div class="pv-line">标签：' + (tags.length ? esc(tags.join('、')) : '这段时间没有打过标签') + '</div>';
  h += '<div class="pv-line">潮汐：' + (pens.length ? esc(pens.join('、')) : '这段时间没有标记') + '</div>';
  return h;
}
function pdfDayHtml(k){
  var r = dayRecord(k), d = parse(k);
  var h = '<div class="pv-day"><div class="pv-day-t">' + (d.getMonth()+1) + ' 月 ' + d.getDate() + ' 日' +
          '<em>' + weekdayCN(d) + '</em></div>';
  var rows = [];
  if(r.mark){
    var p = penOf(r.mark.penId);
    rows.push(['标记', (p.emoji ? p.emoji + ' ' : '') + p.name]);
  }
  if(r.groups.length) rows.push(['完成', r.groups.join('、')]);
  if(r.plans && r.plans.length) rows.push(['计划', r.plans.join('、')]);
  if(r.tags.length) rows.push(['标签', r.tags.map(function(t){ return t.name + ' ×' + t.n; }).join('、')]);
  if(r.workouts.length){
    var wm = sum(r.workouts.map(function(w){ return w.minutes || 0; }));
    var parts = r.workouts.map(function(w){ return (w.parts||[]).join('/'); }).filter(Boolean).join('，');
    rows.push(['训练', (wm ? wm + ' 分钟' : '未记时长') + (parts ? ' · ' + parts : '')]);
  }
  var sm = sum(r.studies.map(function(x){ return x.minutes || 0; }));
  if(sm){
    var what = r.studies.map(function(x){ return x.what; }).filter(Boolean).join('、');
    rows.push(['学习', sm + ' 分钟' + (what ? ' · ' + what : '')]);
  }
  if(r.decs.length) rows.push(['定了', r.decs[r.decs.length-1].title]);
  if(r.note) rows.push(['手账', r.note]);
  if(!rows.length) return h + '<div class="pv-line">这天没有记录。</div></div>';
  rows.forEach(function(rw){
    h += '<div class="pv-row"><div class="pv-k">' + rw[0] + '</div><div class="pv-v">' + esc(rw[1]) + '</div></div>';
  });
  return h + '</div>';
}
function buildPdfReport(from, to, opts){
  var days = pdfRangeDays(from, to);
  var recDays = days.filter(recordHas);
  var d = new Date();
  var html = '<div class="pv-h1">地球online · 生活记录</div>' +
    '<div class="pv-sub">' + esc(from) + ' — ' + esc(to) + ' · 有记录 ' + recDays.length + ' 天 · 导出于 ' +
    (d.getMonth()+1) + ' 月 ' + d.getDate() + ' 日</div>';
  if(opts.stats) html += pdfStatsHtml(days);
  if(opts.cal){
    html += '<div class="pv-h2">潮汐月历</div>';
    pdfMonths(from, to).forEach(function(ym){ html += pdfMonthHtml(ym[0], ym[1], from, to); });
    html += '<div class="pv-h2">热力图</div>' + pdfHeatSectionHtml(from, to);
  }
  if(opts.days){
    html += '<div class="pv-h2">每天记了什么</div>';
    if(!recDays.length) html += '<div class="pv-empty">这段时间没有记录，空白也算一种记录。</div>';
    else recDays.slice().reverse().forEach(function(k){ html += pdfDayHtml(k); });
  }
  html += '<div class="pv-foot">地球online · 数据只在你这台设备上 · 全部内容本地生成</div>';
  $('pvPaper').innerHTML = html;
  $('printView').classList.add('on');
  document.body.classList.add('printing');
  document.body.style.overflow = 'hidden';
  setTimeout(function(){ $('printView').scrollTop = 0; }, 30);
}
function closePdf(){
  $('printView').classList.remove('on');
  document.body.classList.remove('printing');
  document.body.style.overflow = '';
}
function openPdfPanel(){
  var all = allRecordDates();
  var end = TODAY();
  var start = all.length ? all[all.length - 1] : addDays(end, -30);
  if(diffDays(end, start) > 365) start = addDays(end, -365);
  var body = openSheet(
    '<div class="shd"><div class="shd-t">导出 PDF 记录</div>' +
    '<div class="shd-s">把月历、时间轴和小结打成一份。生成后在打印窗口选「存储为 PDF」，手机上用分享里的「打印」。</div></div>' +
    '<div class="row2"><div class="field"><div class="field-l">从</div><input class="inp" id="pdfFrom" type="date" value="' + start + '"></div>' +
    '<div class="field"><div class="field-l">到</div><input class="inp" id="pdfTo" type="date" value="' + end + '"></div></div>' +
    '<div class="field"><div class="field-l">里面放什么</div>' +
      '<label class="pdfck"><input type="checkbox" id="pdfCal" checked> 潮汐月历</label>' +
      '<label class="pdfck"><input type="checkbox" id="pdfDays" checked> 每天的时间轴记录</label>' +
      '<label class="pdfck"><input type="checkbox" id="pdfStats" checked> 统计小结</label>' +
    '</div>' +
    '<div class="acts"><button class="btn g" id="pdfCancel">取消</button><button class="btn p" id="pdfMake">生成预览</button></div>'
  );
  body.querySelector('#pdfCancel').addEventListener('click', closeSheet);
  body.querySelector('#pdfMake').addEventListener('click', function(){
    var from = body.querySelector('#pdfFrom').value || addDays(TODAY(), -30);
    var to = body.querySelector('#pdfTo').value || TODAY();
    if(from > to){ toast('开始日期要在结束日期前面'); return; }
    closeSheet();
    setTimeout(function(){
      buildPdfReport(from, to, {
        cal: body.querySelector('#pdfCal').checked,
        days: body.querySelector('#pdfDays').checked,
        stats: body.querySelector('#pdfStats').checked
      });
    }, 180);
  });
}

/* ==================== 渲染总入口 ==================== */
