/* core.js — 常量/工具/数据/导航/头部/通用面板·弹窗/导入导出/PDF */
/* ==================== 文案 ====================
   OLT(原文)：把界面文字交给 config/ 下的分组配置统一管理。
   配置先于本脚本加载，传入的原文作为键去查显示文字；查不到就原样返回，
   所以即使配置缺失（例如某些测试只加载部分脚本）也不会影响功能与文案。 */
function OLT(s){
  var C = window.OLText;
  if(C && typeof C.text === 'function') return C.text(s);
  return s;
}
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
/* 运行时情境清单以 S.scenes 为准（可自定义、稳定 id）；SCENES 只作种子与系统保护基线 */
function defaultScenes(){
  return SCENES.map(function(sc, i){
    return { id:sc.k, name:sc.n, desc:sc.d, sys:true, enabled:true, order:i };
  });
}
function allScenes(){
  return Array.isArray(S.scenes) && S.scenes.length ? S.scenes : defaultScenes();
}
function activeScenes(){
  return allScenes().filter(function(sc){ return sc && sc.enabled !== false; });
}
function sceneName(k){
  var list = allScenes();
  for(var i=0;i<list.length;i++) if(list[i] && list[i].id === k) return list[i].name;
  for(i=0;i<SCENES.length;i++) if(SCENES[i].k === k) return SCENES[i].n;
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

/* 饭点：「吃什么」按这几个档位分池，任一道菜可以勾多个档或勾「随时」 */
var FOOD_SLOTS = ['breakfast', 'lunch', 'tea', 'dinner', 'night'];
var FOOD_SLOT_LABEL = { breakfast:'早餐', lunch:'午餐', tea:'下午茶', dinner:'晚餐', night:'夜宵' };
var FOOD_CATS = ['家常', '面食', '米饭', '快餐', '清淡', '外卖', '聚餐', '其它'];
function foodSlotName(k){
  if(k === 'any') return '随时';
  return FOOD_SLOT_LABEL[k] || k;
}

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
  /* 原有 toast(msg, '按钮', cb) 保持不变；数组形式用于保存失败的「重试 / 放弃」。 */
  var actions = Array.isArray(act) ? act : (act ? [{ label:act, cb:cb }] : []);
  t.innerHTML = esc(msg) + (actions.length
    ? ' ' + actions.map(function(a, i){
        return '<button class="t-act" id="tAct' + i + '">' + esc((a && a.label) || '') + '</button>';
      }).join('')
    : '');
  t.style.pointerEvents = actions.length ? 'auto' : 'none';
  if(actions.length){
    actions.forEach(function(a, i){
      var btn = $('tAct' + i);
      if(!btn) return;
      btn.addEventListener('click', function(ev){
        ev.stopPropagation();
        t.classList.remove('on');
        if(a && typeof a.cb === 'function') a.cb();
      });
    });
  }
  t.classList.add('on');
  clearTimeout(window.__tt);
  window.__tt = setTimeout(function(){ t.classList.remove('on'); }, actions.length ? 5000 : 1700);
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
    { id:'tags', name:'标签打卡', desc:'点一下记一次，用来数频率', enabled:false },
    { id:'food', name:'吃什么', desc:'到饭点替你抽一个，菜单自己攒', enabled:true },
    { id:'diet', name:'饮食记录', desc:'记吃了什么、什么时候吃，看进食窗口', enabled:false }
  ];
}
/* 菜单种子：只为「第一次就能抽」；用户可改可删，删光也不会再塞回来 */
function defaultFoodItems(){
  return [
    { id:'fd-congee',  name:'粥和小菜',   cat:'清淡', note:'胃不舒服的时候',   slots:['breakfast','night'], enabled:true },
    { id:'fd-baozi',   name:'小笼包豆浆', cat:'家常', note:'楼下那家',         slots:['breakfast'], enabled:true },
    { id:'fd-jianbing',name:'煎饼果子',   cat:'快餐', note:'路上带着吃',       slots:['breakfast'], enabled:true },
    { id:'fd-noodle',  name:'牛肉面',     cat:'面食', note:'多加香菜',         slots:['lunch','dinner'], enabled:true },
    { id:'fd-rice',    name:'番茄炒蛋盖饭', cat:'米饭', note:'',               slots:['lunch','dinner'], enabled:true },
    { id:'fd-malatang',name:'麻辣烫',     cat:'快餐', note:'少辣',             slots:['lunch','dinner','night'], enabled:true },
    { id:'fd-salad',   name:'鸡胸沙拉',   cat:'清淡', note:'想轻一点的时候',   slots:['lunch','tea'], enabled:true },
    { id:'fd-dumpling',name:'饺子',       cat:'家常', note:'',                 slots:['lunch','dinner'], enabled:true },
    { id:'fd-hotpot',  name:'火锅',       cat:'聚餐', note:'叫上人一起',       slots:['dinner','night'], enabled:true },
    { id:'fd-bbq',     name:'烧烤',       cat:'聚餐', note:'',                 slots:['night'], enabled:true },
    { id:'fd-sandwich',name:'三明治',     cat:'快餐', note:'赶时间',           slots:['breakfast','tea'], enabled:true },
    { id:'fd-cake',    name:'一个小蛋糕', cat:'其它', note:'下午垫一口',       slots:['tea'], enabled:true }
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
    scenes: defaultScenes(),   // 决策情境（自定义）：{id,name,desc,sys,enabled,order}，id 稳定，顺序即显示顺序
    meals: [],      // 饮食记录（插件）{id,date,ts,slot,foods:[{name,portion}],note}，date 为业务日期，ts 为实际进食时间戳
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
      foodItems: defaultFoodItems(),   // 吃什么：菜单库 {id,name,cat,note,slots,enabled}
      foodLog: [],                     // 吃什么：吃过的记录 {id,date,ts,name,slot}，只增不覆写
      mealSlots: ['早餐', '午餐', '晚餐', '加餐'],   // 饮食记录：餐次清单，可自定义；不入配置文件导出
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
    default: '110,155,128', mist: '113,134,178', clay: '193,121,92',
    matcha: '139,166,99', lotus: '185,106,133', warm: '156,107,82'
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
function hasOwn(obj, k){
  return Object.prototype.hasOwnProperty.call(obj, k);
}
/* 显式建自有属性。键名为 __proto__ 时普通赋值会走原型 setter：
   字段丢失且把值挂成原型。5A 起所有动态合并统一走这里（Step 4.5 审核结论） */
function defineOwn(obj, k, v){
  if(k === '__proto__'){
    Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
  }else{
    obj[k] = v;
  }
}
function deepMerge(base, src){
  for(var k in src){
    if(!hasOwn(src, k)) continue;
    if(!hasOwn(base, k)){ defineOwn(base, k, src[k]); continue; }
    var b = base[k], s = src[k];
    if(b && s && typeof b === 'object' && typeof s === 'object' && !Array.isArray(b) && !Array.isArray(s)){
      deepMerge(b, s);
    }else if(s !== undefined){
      defineOwn(base, k, s);
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
/* ---------- 业务写入：5A 闸门 / 5B-3 串行队列接线 ----------
   legacy 模式：localStorage 仍是唯一真相，行为完全不变。
   idb 模式：save() 只把当前 S 的同步快照交给 OLCommitQueue；返回值仅表示
   「成功入队」，绝不表示已持久化。成功提示由 onSuccess 在事务确认成功后
   触发；失败统一给可重试 / 放弃的提示，内存 S 始终保留。 */
function bizWriteBlocked(){
  var ob = (typeof window !== 'undefined') && window.OLBoot;
  return !!(ob && ob.mode === 'idb');
}
var bizWriteNoticeAt = 0;
function bizWriteBlockedNotice(){
  var now = Date.now();
  if(now - bizWriteNoticeAt < 3000) return;
  bizWriteNoticeAt = now;
  toast(OLT('保存不可用：写入还没准备好，这次改动不会保存'));
}
var bizSaveFailAt = 0;
var bizSaveFailSig = '';
var bizFailForceOnce = false;   /* 用户点过重试 / 恢复后，下一次失败必须提示 */
/* 把队列 / 恢复原语的错误码翻成用户能看懂的原因；未知码原样显示。 */
function saveFailText(code){
  var map = {
    'snapshot-changed':'内容已变化，请重新操作一次',
    'retry-not-allowed':'当前状态不能重试',
    'no-pending':'没有待重试的保存',
    'abort-not-allowed':'当前状态不能放弃',
    'writer-not-ready':'写入权还没恢复',
    'writer-changed-requires-recapture':'写入权已变化，需要重新操作',
    'state-changed-requires-recapture':'内容或版本已变化，需要重新操作',
    'no-recovering-job':'没有待恢复的保存',
    'resolve-failed':'恢复失败'
  };
  if(!code) return '';
  return map[code] ? (code + '：' + map[code]) : String(code);
}
function bizSaveFailed(code, actions, jobId, force){
  var now = Date.now();
  var sig = String(jobId || '') + '|' + String(code || '');
  /* 同一 job 的同一错误在极短时间内只提示一次（多个 save 合并到同一 job 时防重复）；
     用户点过重试 / 恢复后 force=true，保证再次失败一定重新提示。 */
  if(!force && sig === bizSaveFailSig && now - bizSaveFailAt < 1200) return;
  bizSaveFailSig = sig; bizSaveFailAt = now;
  toast(OLT('没保存成功') + (code ? '（' + saveFailText(code) + '）' : '') + '，改动还在内存里', actions || []);
}
function saveResultFailed(r, fallback){
  bizSaveFailed((r && r.code) || fallback, [], null, true);
}
/* 失败出口按当前队列状态生成：普通失败用 retry/abort；fatal 走 resolve 显式出口。
   所有结果都检查返回值与 reject，失败原因必须让用户看到。 */
function saveRecoveryActions(Q){
  var st = (Q && typeof Q.status === 'function') ? Q.status() : null;
  if(st && st.state === 'recovering'){
    return [
      { label:'重试', cb:function(){
          bizFailForceOnce = true;
          var p = Q.resolve({ action:'retry' });
          if(p && p.then) p.then(function(r){ if(!r || !r.ok) saveResultFailed(r, 'resolve-failed'); },
                                   function(e){ saveResultFailed(e, 'resolve-failed'); });
        } },
      { label:'放弃', cb:function(){
          var p = Q.resolve({ action:'discard' });
          if(p && p.then) p.then(function(r){ if(!r || !r.ok) saveResultFailed(r, 'resolve-failed'); },
                                   function(e){ saveResultFailed(e, 'resolve-failed'); });
        } }
    ];
  }
  return [
    { label:'重试', cb:function(){
        bizFailForceOnce = true;
        var r = Q.retry();
        if(r && r.ok === false) saveResultFailed(r, 'retry-failed');
      } },
    { label:'放弃', cb:function(){
        var r = Q.abort();
        if(r && r.ok === false) saveResultFailed(r, 'abort-failed');
      } }
  ];
}
/* save(onSuccess, opts) 保持同步。opts.highFrequency 只给确有连续输入的点。 */
function save(onSuccess, opts){
  opts = opts || {};
  if(!bizWriteBlocked()){
    try{ localStorage.setItem(KEY, JSON.stringify(S)); }
    catch(e){ bizSaveFailed('local-storage'); return false; }
    if(typeof onSuccess === 'function') onSuccess();
    /* 只在 localStorage 真正写成功后标记云端待备份 */
    if(window.OLCloudBackup && typeof window.OLCloudBackup.markDirty === 'function') window.OLCloudBackup.markDirty('local');
    return true;
  }
  var Q = window.OLCommitQueue, W = window.OLWrite;
  var ident = (W && typeof W.currentWriterIdentity === 'function') ? W.currentWriterIdentity() : null;
  var st = (Q && typeof Q.status === 'function') ? Q.status() : null;
  if(!Q || typeof Q.enqueue !== 'function' || !W || !W.wired || !ident ||
     (st && (st.state === 'recovering' || st.state === 'stopped'))){
    bizWriteBlockedNotice();
    return false;
  }
  /* R2 契约：operation 的 callback 只在终局结算（普通失败不调用），
     所以成功提示走 callback，失败提示必须另走队列的全局结果事件。 */
  var r, off = null;
  function jobStillActive(id){
    var s = (Q && typeof Q.status === 'function') ? Q.status() : null;
    if(!s) return false;
    return !!((s.inFlight && s.inFlight.id === id) ||
              (s.pending && s.pending.id === id) ||
              (s.recoveringJob && s.recoveringJob.id === id));
  }
  var onEvent = function(ev){
    if(!r || !ev || ev.jobId !== r.jobId) return;
    var force = bizFailForceOnce; bizFailForceOnce = false;
    if(ev.type === 'failure' || ev.type === 'fatal'){
      bizSaveFailed(ev.code || ev.stopReason, saveRecoveryActions(Q), r.jobId, force);
    }
    /* failure/fatal 时 job 仍在 PENDING / RECOVERING_JOB，监听器必须保留：
       重试后再次失败仍要提示。只有 job 真正离开队列才注销。 */
    if(off && !jobStillActive(r.jobId)){ off(); off = null; }
  };
  try{
    off = Q.onResult(onEvent);
    r = Q.enqueue({
      source: 'business',
      onResult: function(result){
        /* 队列终局确认成功才触发云端备份，绝不上传内存中的候选状态 */
        if(result && result.ok){
          if(typeof onSuccess === 'function') onSuccess();
          if(window.OLCloudBackup && typeof window.OLCloudBackup.markDirty === 'function') window.OLCloudBackup.markDirty('idb');
        }
      }
    }, opts);
  }catch(e){ if(off) off(); bizSaveFailed((e && e.code) || 'save-threw'); return false; }
  if(!r || !r.ok){ if(off) off(); bizSaveFailed(r && r.code); return false; }
  return true;   /* 只表示入队成功，不代表事务已提交 */
}
function normalize(){
  var d = defaults();
  ['tasks','schedule','plans','pens','tags','tagLogs','suggestions','workouts','studyLogs','decisionLog','restDays','flashes','itemLogs','meals'].forEach(function(k){
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
  /* 吃什么：菜单与记录都放在 settings 里，随 settings 载荷整体迁移，不新增顶层字段。
     非法项就地丢弃，缺字段补默认值；用户删光菜单不会被种子塞回来。 */
  if(!Array.isArray(S.settings.foodItems)) S.settings.foodItems = d.settings.foodItems;
  S.settings.foodItems = S.settings.foodItems.map(function(it){
    if(!it || typeof it !== 'object') return null;
    var name = typeof it.name === 'string' ? it.name.trim().slice(0, 20) : '';
    if(!name) return null;
    var slots = Array.isArray(it.slots) ? it.slots.filter(function(k){ return k === 'any' || FOOD_SLOTS.indexOf(k) >= 0; }) : [];
    if(!slots.length) slots = ['any'];
    return {
      id: typeof it.id === 'string' && it.id ? it.id : uid('fd'),
      name: name,
      cat: typeof it.cat === 'string' && it.cat.trim() ? it.cat.trim().slice(0, 6) : '其它',
      note: typeof it.note === 'string' ? it.note.slice(0, 30) : '',
      slots: slots,
      enabled: it.enabled !== false
    };
  }).filter(function(it){ return !!it; });
  if(!Array.isArray(S.settings.foodLog)) S.settings.foodLog = [];
  S.settings.foodLog = S.settings.foodLog.filter(function(l){
    return l && typeof l.date === 'string' && typeof l.name === 'string' && l.name;
  }).map(function(l){
    return {
      id: typeof l.id === 'string' && l.id ? l.id : uid('fl'),
      date: l.date,
      ts: typeof l.ts === 'number' ? l.ts : 0,
      name: l.name,
      slot: FOOD_SLOTS.indexOf(l.slot) >= 0 ? l.slot : ''
    };
  }).slice(-200);
  /* 饮食记录（插件）：业务数据，存顶层 meals（dayEntries type=meal）。
     结构非法项就地丢弃；时间戳非法的记录保留但置 0——界面与统计按「无效」
     明确标识，不静默纳入统计。每条记录的 id/date/ts 原样保留，不重生成。 */
  if(!Array.isArray(S.meals)) S.meals = [];
  S.meals = S.meals.filter(function(m){
    return m && typeof m === 'object' && !Array.isArray(m) &&
      typeof m.id === 'string' && m.id &&
      typeof m.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.date);
  }).map(function(m){
    var foods = (Array.isArray(m.foods) ? m.foods : []).map(function(f){
      if(!f || typeof f !== 'object' || Array.isArray(f)) return null;
      var name = typeof f.name === 'string' ? f.name.trim().slice(0, 40) : '';
      if(!name) return null;
      return { name: name, portion: typeof f.portion === 'string' ? f.portion.trim().slice(0, 20) : '' };
    }).filter(function(f){ return !!f; });
    return {
      id: m.id,
      date: m.date,
      ts: (typeof m.ts === 'number' && isFinite(m.ts) && m.ts > 0) ? m.ts : 0,
      slot: typeof m.slot === 'string' && m.slot.trim() ? m.slot.trim().slice(0, 8) : '',
      foods: foods,
      note: typeof m.note === 'string' ? m.note.slice(0, 60) : ''
    };
  });
  /* 餐次清单：用户可自定义；去重去空，空清单回退默认。不入配置文件导出白名单。 */
  if(!Array.isArray(S.settings.mealSlots)) S.settings.mealSlots = d.settings.mealSlots.slice();
  S.settings.mealSlots = S.settings.mealSlots.map(function(s){
    return typeof s === 'string' ? s.trim().slice(0, 8) : '';
  }).filter(function(s, i, arr){ return s && arr.indexOf(s) === i; }).slice(0, 8);
  if(!S.settings.mealSlots.length) S.settings.mealSlots = d.settings.mealSlots.slice();
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
  /* 决策情境：顶层 scenes（definitions kind='scene'）。id 稳定不重生成；
     内置情境是系统项——不可删除、缺失自动补回，改名/停用结果保留；
     顺序即决策页显示顺序，order 随数组下标刷新，重排不改历史记录含义。 */
  if(!Array.isArray(S.scenes)) S.scenes = defaultScenes();
  var sceneOut = [];
  (Array.isArray(S.scenes) ? S.scenes : []).forEach(function(sc){
    if(!sc || typeof sc !== 'object' || Array.isArray(sc)) return;
    if(typeof sc.id !== 'string' || !sc.id || byId(sceneOut, sc.id)) return;
    sceneOut.push({
      id: sc.id,
      name: (typeof sc.name === 'string' && sc.name.trim()) ? sc.name.trim().slice(0, 12) : '未命名情况',
      desc: (typeof sc.desc === 'string') ? sc.desc.trim().slice(0, 30) : '',
      sys: sc.sys === true,
      enabled: sc.enabled !== false,
      order: sceneOut.length
    });
  });
  defaultScenes().forEach(function(ds){
    if(!byId(sceneOut, ds.id)){
      sceneOut.push({ id:ds.id, name:ds.name, desc:ds.desc, sys:true, enabled:true, order:sceneOut.length });
    }
  });
  S.scenes = sceneOut.slice(0, 24);
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

/* 选择器的独立浮层：不能复用 #sheet，否则会把正在编辑的表单顶掉 */
var OLPickLayer = (function(){
  function layer(){
    var l = document.getElementById('olPickMask');
    if(l) return l;
    l = document.createElement('div');
    l.id = 'olPickMask';
    l.className = 'mask pk';
    l.innerHTML = '<div class="sheet"><div class="handle"></div><div id="olPickBody"></div></div>';
    document.body.appendChild(l);
    return l;
  }
  function open(html){
    var l = layer();
    l.querySelector('#olPickBody').innerHTML = html;
    l.classList.add('on');
    l.querySelector('.sheet').scrollTop = 0;
    return l.querySelector('#olPickBody');
  }
  function close(){
    var l = document.getElementById('olPickMask');
    if(l) l.classList.remove('on');
  }
  return { open: open, close: close };
})();

/* ==================== 时间输入：滚轮选择 ====================
   浏览器自带的 type="time" 桌面是弹窗、iPhone 是系统滚轮，长相和操作都不一致，
   这里统一成两列滚轮：点输入框打开弹层，滚到哪就是哪。
   输入框还是普通 <input>，值仍是 "HH:MM"，读取方式不变。 */
var OLTimePicker = (function(){
  var ITEM = 36, PAD = 72;
  var HOURS = [], MINS = [];
  for(var hh = 0; hh < 24; hh++) HOURS.push(pad2(hh));
  for(var mm = 0; mm < 60; mm++) MINS.push(pad2(mm));
  var CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="8.6"/><path d="M12 7.6V12l3.1 1.9"/></svg>';

  function pad2(n){ return (n < 10 ? '0' : '') + n; }
  function parse(v){
    var m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v == null ? '' : v).trim());
    if(!m) return null;
    var h = +m[1], mi = +m[2];
    return (h < 24 && mi < 60) ? { h: h, m: mi } : null;
  }
  function nowHM(){ var d = new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

  function colHtml(list, idx){
    var s = '<div class="tp-pad"></div>';
    for(var i = 0; i < list.length; i++){
      s += '<div class="tp-item' + (i === idx ? ' on' : '') + '" data-i="' + i + '">' + list[i] + '</div>';
    }
    return s + '<div class="tp-pad"></div>';
  }

  /* 一列：滚动停稳后取最近的一格，并把位置吸附过去 */
  function bindCol(col, onChange){
    var timer = null;
    function items(){ return col.querySelectorAll('.tp-item'); }
    function paint(i){
      var list = items();
      for(var k = 0; k < list.length; k++) list[k].classList.toggle('on', k === i);
      onChange(i);
    }
    function settle(){
      var list = items();
      var i = Math.round(col.scrollTop / ITEM);
      i = Math.max(0, Math.min(list.length - 1, i));
      paint(i);
      var target = i * ITEM;
      if(Math.abs(col.scrollTop - target) > 1) col.scrollTop = target;
    }
    col.addEventListener('scroll', function(){
      clearTimeout(timer);
      timer = setTimeout(settle, 90);
    }, { passive: true });
    col.addEventListener('click', function(e){
      var it = e.target.closest ? e.target.closest('.tp-item') : null;
      if(!it) return;
      var i = +it.dataset.i;
      if(col.scrollTo) col.scrollTo({ top: i * ITEM, behavior: 'smooth' });
      else col.scrollTop = i * ITEM;
      paint(i);
    });
    return settle;
  }

  function fire(input){
    try{
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }catch(e){}
  }

  function open(input, opts){
    opts = opts || {};
    var cur = parse(input.value) || parse(nowHM());
    var picked = { h: cur.h, m: cur.m };
    var body = OLPickLayer.open(
      '<div class="shd"><div class="shd-t">' + OLT('选择时间') + '</div></div>' +
      '<div class="tp-head"><span>' + OLT('时') + '</span><span>' + OLT('分') + '</span></div>' +
      '<div class="tp-wheel">' +
        '<div class="tp-col" id="tpHour">' + colHtml(HOURS, cur.h) + '</div>' +
        '<div class="tp-col" id="tpMin">' + colHtml(MINS, cur.m) + '</div>' +
      '</div>' +
      (opts.allowEmpty ? '<button class="tp-clear" id="tpClear">' + OLT('清空') + '</button>' : '') +
      '<div class="acts"><button class="btn g" id="tpNo">' + OLT('取消') + '</button>' +
      '<button class="btn p" id="tpOk">' + OLT('确定') + '</button></div>'
    );
    var hCol = body.querySelector('#tpHour'), mCol = body.querySelector('#tpMin');
    var hSettle = bindCol(hCol, function(i){ picked.h = i; });
    var mSettle = bindCol(mCol, function(i){ picked.m = i; });
    /* 打开时直接定位，不要从 00 滚上来 */
    requestAnimationFrame(function(){
      hCol.scrollTop = cur.h * ITEM;
      mCol.scrollTop = cur.m * ITEM;
    });
    body.querySelector('#tpNo').addEventListener('click', function(){
      hSettle(); mSettle();
      OLPickLayer.close();
    });
    if(opts.allowEmpty){
      body.querySelector('#tpClear').addEventListener('click', function(){
        input.value = '';
        OLPickLayer.close();
        fire(input);
      });
    }
    body.querySelector('#tpOk').addEventListener('click', function(){
      input.value = pad2(picked.h) + ':' + pad2(picked.m);
      OLPickLayer.close();
      fire(input);
    });
  }

  /* 把现有 <input type="time"> 换成点了就开滚轮的输入框 */
  function attach(input, opts){
    if(!input || input.__olTp) return input;
    input.__olTp = true;
    input.readOnly = true;
    input.setAttribute('type', 'text');
    input.setAttribute('inputmode', 'none');
    input.setAttribute('autocomplete', 'off');
    if(input.parentNode){
      var box = el('div', 'tp-field');
      input.parentNode.insertBefore(box, input);
      box.appendChild(input);
      var ico = el('span', 'tp-ico');
      ico.innerHTML = CLOCK;
      box.appendChild(ico);
    }
    input.addEventListener('click', function(e){
      e.preventDefault();
      open(input, opts || {});
    });
    input.addEventListener('keydown', function(e){
      if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); open(input, opts || {}); }
    });
    return input;
  }

  return { attach: attach, open: open, now: nowHM };
})();

/* ==================== 日期输入：月历选择 ====================
   原生 type="date" 各浏览器长相不一，这里统一成月历弹层：翻月、点日、确定。
   输入框还是普通 <input>，值仍是 "YYYY-MM-DD"，读取方式不变。 */
var OLDatePicker = (function(){
  var WD = ['日', '一', '二', '三', '四', '五', '六'];
  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3.7" y="5.3" width="16.6" height="15" rx="2.6"/><path d="M8 3.5v3.4M16 3.5v3.4M3.7 10.1h16.6"/></svg>';

  function pad2(n){ return (n < 10 ? '0' : '') + n; }
  function parse(v){
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(v == null ? '' : v).trim());
    if(!m) return null;
    var o = { y: +m[1], m: +m[2], d: +m[3] };
    if(o.m < 1 || o.m > 12 || o.d < 1 || o.d > 31) return null;
    if(o.d > new Date(o.y, o.m, 0).getDate()) return null;
    return o;
  }
  function key(o){ return o.y + '-' + pad2(o.m) + '-' + pad2(o.d); }
  function todayObj(){
    var t = String(TODAY()).split('-');
    return { y: +t[0], m: +t[1], d: +t[2] };
  }
  function same(a, b){ return !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d; }

  function cellsHtml(view, sel){
    var today = todayObj();
    var first = new Date(view.y, view.m - 1, 1).getDay();
    var len = new Date(view.y, view.m, 0).getDate();
    var out = [];
    for(var i = 0; i < first; i++) out.push('<span class="dp-cell mute"></span>');
    for(var d = 1; d <= len; d++){
      var cls = 'dp-cell';
      if(same(sel, { y: view.y, m: view.m, d: d })) cls += ' on';
      else if(same(today, { y: view.y, m: view.m, d: d })) cls += ' today';
      out.push('<button class="' + cls + '" data-d="' + d + '">' + d + '</button>');
    }
    return out.join('');
  }

  function fire(input){
    try{
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }catch(e){}
  }

  function open(input, opts){
    opts = opts || {};
    var cur = parse(input.value) || todayObj();
    var sel = { y: cur.y, m: cur.m, d: cur.d };
    var view = { y: cur.y, m: cur.m };
    var body = OLPickLayer.open(
      '<div class="shd"><div class="shd-t">' + OLT('选择日期') + '</div></div>' +
      '<div class="dp-head"><button class="dp-nav" id="dpPrev">‹</button>' +
        '<div class="dp-title" id="dpTitle"></div>' +
        '<button class="dp-nav" id="dpNext">›</button></div>' +
      '<div class="dp-wd">' + WD.map(function(w){ return '<span>' + w + '</span>'; }).join('') + '</div>' +
      '<div class="dp-grid" id="dpGrid"></div>' +
      '<div class="dp-quick"><button class="tp-clear" id="dpToday">' + OLT('今天') + '</button>' +
        (opts.allowEmpty ? '<button class="tp-clear" id="dpClear">' + OLT('清空') + '</button>' : '') + '</div>' +
      '<div class="acts"><button class="btn g" id="dpNo">' + OLT('取消') + '</button>' +
        '<button class="btn p" id="dpOk">' + OLT('确定') + '</button></div>'
    );
    var title = body.querySelector('#dpTitle');
    var grid = body.querySelector('#dpGrid');
    function paint(){
      title.textContent = view.y + ' 年 ' + view.m + ' 月';
      grid.innerHTML = cellsHtml(view, sel);
    }
    function shift(n){
      var m = view.m + n, y = view.y;
      if(m < 1){ m = 12; y--; }
      if(m > 12){ m = 1; y++; }
      view = { y: y, m: m };
      paint();
    }
    body.querySelector('#dpPrev').addEventListener('click', function(){ shift(-1); });
    body.querySelector('#dpNext').addEventListener('click', function(){ shift(1); });
    grid.addEventListener('click', function(e){
      var c = e.target.closest ? e.target.closest('.dp-cell') : null;
      if(!c || !c.dataset.d) return;
      sel = { y: view.y, m: view.m, d: +c.dataset.d };
      paint();
    });
    body.querySelector('#dpToday').addEventListener('click', function(){
      sel = todayObj(); view = { y: sel.y, m: sel.m }; paint();
    });
    if(opts.allowEmpty){
      body.querySelector('#dpClear').addEventListener('click', function(){
        input.value = ''; OLPickLayer.close(); fire(input);
      });
    }
    body.querySelector('#dpNo').addEventListener('click', closeSheet);
    body.querySelector('#dpOk').addEventListener('click', function(){
      input.value = key(sel); OLPickLayer.close(); fire(input);
    });
    paint();
  }

  function attach(input, opts){
    if(!input || input.__olDp || input.disabled) return input;
    input.__olDp = true;
    input.readOnly = true;
    input.setAttribute('type', 'text');
    input.setAttribute('inputmode', 'none');
    input.setAttribute('autocomplete', 'off');
    if(input.parentNode){
      var box = el('div', 'tp-field');
      input.parentNode.insertBefore(box, input);
      box.appendChild(input);
      var ico = el('span', 'tp-ico');
      ico.innerHTML = ICON;
      box.appendChild(ico);
    }
    input.addEventListener('click', function(e){
      e.preventDefault();
      open(input, opts || {});
    });
    input.addEventListener('keydown', function(e){
      if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); open(input, opts || {}); }
    });
    return input;
  }

  return { attach: attach, open: open };
})();

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
  if(OLTimePicker && body.querySelector('#lgTime')) OLTimePicker.attach(body.querySelector('#lgTime'), { allowEmpty: true });
  if(OLDatePicker && body.querySelector('#lgDate')) OLDatePicker.attach(body.querySelector('#lgDate'), { allowEmpty: false });
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
/* 生成备份文件：payload 结构与文件名沿用原有约定，改格式会破坏 importJSON 兼容性。
   只接收待导出的数据，不读全局 S、不写任何存储、不调用 save()。 */
/* 完整业务备份信封：文件导出与云端上传共用同一份生成逻辑 */
function buildBackupPayload(data){
  return { app:'earthonline', version:4, exportedAt:new Date().toISOString(), data:data };
}
function writeBackupFile(data){
  var payload = buildBackupPayload(data);
  var blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'earthonline-' + todayReal() + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
  toast(OLT('已导出备份'));
}

/* idb 模式：导出必须等于 IndexedDB 里已持久化的数据，不能夹带内存中未保存的改动。
   OLMigrate.rehydrate() 是单只读事务，返回六表反解的 S 形对象（含 legacyExtras）。
   任何读取失败都交给 onFail，绝不退回内存 S；成功的数据交给 onOk 生成文件。 */
function readExportSource(onOk, onFail){
  var M = window.OLMigrate;
  if(!M || typeof M.rehydrate !== 'function'){ onFail('读取本地库不可用'); return; }
  var rep;
  try{ rep = M.rehydrate(); }
  catch(e){ onFail('读取本地库出错'); return; }
  Promise.resolve(rep).then(function(r){
    if(!r || r.ok !== true || !r.data || typeof r.data !== 'object'){
      onFail('读取本地库未完成' + (r && (r.reason || r.message) ? '（' + (r.reason || r.message) + '）' : ''));
      return;
    }
    /* 与启动链 mergeRehydrated 同样的合并规则：defaults 打底 → 六表数据覆盖 → extras 原键原值。
       不调用 normalize()（它只作用于全局 S），不改动 S，不写库。 */
    var base = defaults();
    deepMerge(base, r.data);
    if(r.extras && Array.isArray(r.extras.keys) && r.extras.keys.length){
      var val = r.extras.value || {};
      for(var i = 0; i < r.extras.keys.length; i++){
        var k = r.extras.keys[i];
        if(!hasOwn(base, k)) defineOwn(base, k, val[k]);
      }
    }
    onOk(base);
  }, function(e){
    onFail('读取本地库出错' + (e && e.message ? '（' + e.message + '）' : ''));
  });
}

function exportFromIdb(){
  readExportSource(writeBackupFile, function(msg){ toast(OLT('导出失败：') + msg + '，未生成备份'); });
}

function exportJSON(){
  /* 与写入闸门共用同一个 idb 模式判定，避免两处判定漂移。
     legacy 模式保持原有导出行为不变。 */
  if(bizWriteBlocked()){ exportFromIdb(); return; }
  writeBackupFile(S);
}

/* 配置文件导出（Task C1）在 config-io.js：抽取规则、信封、下载与 idb/legacy
   分流都在那里，共用本文件的只读通道 readExportSource()。设置页调用全局
   exportConfig()（由 config-io.js 暴露）。 */

/* ==================== 配置文件导入（Task C2） ====================
   解析 / 校验 / 合并预览 / 冲突裁决全部在 config-io.js（纯函数）。
   本文件负责：读取基线（readConfigSource）、把合并结果套进 S（applyConfigImport）、
   预览确认弹层（importConfig 系列）。提交就是普通的一次 save()：
   队列在入队时克隆整个 S，单事务 bizRev CAS 提交，天然满足原子性；
   失权 / 版本冲突 / 失败重试沿用 5B 系列的恢复生命周期，导入不做特殊分支。 */
var CI_STATE = {
  file: null,          /* parseConfigFile 的成功结果（含 config） */
  preview: null,       /* previewConfigImport 结果 */
  choices: {},         /* 冲突裁决：key -> 'local' | 'incoming' */
  mode: null,          /* 'idb' | 'legacy' */
  baselineRev: null,   /* idb：预览基线 bizRev */
  fileLabel: '',       /* 弹层副标题 */
  reading: false,      /* 读基线 / 读版本进行中，挡重复点击 */
  submitting: false    /* 已进提交路径，挡重复确认 */
};

/* idb 导入基线：与 readExportSource 同一套只读通道，但额外带回 meta.bizRev，
   供「预览 → 确认」之间的版本变化检测。不读内存 S、不写库。 */
function readConfigSource(onOk, onFail){
  var M = window.OLMigrate;
  if(!M || typeof M.rehydrate !== 'function'){ onFail('读取本地库不可用'); return; }
  var rep;
  try{ rep = M.rehydrate(); }
  catch(e){ onFail('读取本地库出错'); return; }
  Promise.resolve(rep).then(function(r){
    if(!r || r.ok !== true || !r.data || typeof r.data !== 'object'){
      onFail('读取本地库未完成' + (r && (r.reason || r.message) ? '（' + (r.reason || r.message) + '）' : ''));
      return;
    }
    var base = defaults();
    deepMerge(base, r.data);
    if(r.extras && Array.isArray(r.extras.keys) && r.extras.keys.length){
      var val = r.extras.value || {};
      for(var i = 0; i < r.extras.keys.length; i++){
        var k = r.extras.keys[i];
        if(!hasOwn(base, k)) defineOwn(base, k, val[k]);
      }
    }
    onOk(base, {
      bizRev: (r.meta && typeof r.meta.bizRev === 'number') ? r.meta.bizRev : null
    });
  }, function(e){
    onFail('读取本地库出错' + (e && e.message ? '（' + e.message + '）' : ''));
  });
}

/* 把合并结果套进 S。patch 只含白名单字段；settings 只写文件提供的键，
   其余设置不动。写完统一 normalize()（补默认字段、重排 scenes order、
   清洗 mealSlots / theme 等，与正常编辑同一条路径）。 */
function applyConfigImport(patch){
  if(!patch || typeof patch !== 'object') return false;
  ['pens', 'tags', 'suggestions', 'scenes', 'plugins'].forEach(function(k){
    if(Array.isArray(patch[k])) S[k] = patch[k];
  });
  if(patch.settings && typeof patch.settings === 'object'){
    Object.keys(patch.settings).forEach(function(k){
      S.settings[k] = patch.settings[k];
    });
  }
  normalize();
  return true;
}

function importConfig(){
  if(CI_STATE.reading || CI_STATE.submitting) return;   /* 重复点击 / 提交中不重开 */
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.style.display = 'none';
  document.body.appendChild(inp);
  var cleanup = function(){ if(inp.parentNode) inp.parentNode.removeChild(inp); };
  inp.addEventListener('change', function(){
    var f = inp.files && inp.files[0];
    cleanup();
    if(!f){ return; }                       /* 未选择文件：不执行任何操作 */
    importConfigStart(f);
  });
  inp.addEventListener('cancel', function(){ cleanup(); });   /* 用户取消 */
  inp.click();
}

function importConfigStart(fileObj){
  var CIO = window.OLConfigIO;
  if(!CIO || typeof CIO.parseConfigFile !== 'function'){ toast(OLT('导入失败：配置模块未加载')); return; }
  var MAXB = CIO.MAX_IMPORT_CHARS || (2 * 1024 * 1024);
  if(typeof fileObj.size === 'number' && fileObj.size > MAXB){
    toast(OLT('导入失败：文件太大（上限约 2MB），已拒绝')); return;
  }
  CI_STATE.reading = true;
  var fr = new FileReader();
  fr.onload = function(){
    CI_STATE.reading = false;
    importConfigPreview(String(fr.result), fileObj.name || '');
  };
  fr.onerror = function(){
    CI_STATE.reading = false;
    toast(OLT('导入失败：文件读不出来'));
  };
  try{ fr.readAsText(fileObj); }
  catch(e){ CI_STATE.reading = false; toast(OLT('导入失败：文件读不出来')); }
}

function importConfigPreview(text, fileName){
  var CIO = window.OLConfigIO;
  var parsed = CIO.parseConfigFile(text, {
    pluginIds: defaultPlugins().map(function(p){ return p.id; })
  });
  if(!parsed.ok){
    toast(OLT('导入失败：') + parsed.message + '，本机没有任何改动');
    return;
  }
  CI_STATE.file = parsed.file;
  CI_STATE.fileLabel = '来自 ' + (fileName || '配置文件') +
    (parsed.file.exportedAt ? ' · 导出于 ' + parsed.file.exportedAt.slice(0, 10) : '');
  if(bizWriteBlocked()){
    /* idb：基线必须来自已持久化数据，不能拿可能含未保存改动的内存 S */
    if(window.OLBoot && typeof OLBoot.hasUnsavedSnapshot === 'function' && OLBoot.hasUnsavedSnapshot()){
      toast(OLT('导入失败：有一份未处理的恢复副本，先在顶部横幅里处理它')); return;
    }
    readConfigSource(function(data, meta){
      var local = CIO.buildConfigPayload(data);
      ciEnterPreview('idb', local, meta && typeof meta.bizRev === 'number' ? meta.bizRev : null);
    }, function(msg){
      toast(OLT('导入失败：') + msg + '，本机没有任何改动');
    });
  } else {
    ciEnterPreview('legacy', CIO.buildConfigPayload(S), null);
  }
}

/* 插件注册表名称：预览逐项展示用（文件里只有 {id, enabled}，名字以应用注册定义为准） */
function ciPluginNames(){
  var names = {};
  try { defaultPlugins().forEach(function(pl){ names[pl.id] = pl.name; }); } catch(e){}
  return names;
}

function ciEnterPreview(mode, local, baselineRev){
  var CIO = window.OLConfigIO;
  var preview = CIO.previewConfigImport(local, CI_STATE.file.config, { pluginNames: ciPluginNames() });
  if(!preview || preview.ok !== true){ toast(OLT('导入失败：预览计算失败，本机没有任何改动')); return; }
  CI_STATE.mode = mode;
  CI_STATE.preview = preview;
  CI_STATE.baselineRev = baselineRev;
  CI_STATE.choices = {};
  preview.conflicts.forEach(function(cf){ CI_STATE.choices[cf.key] = 'local'; });  /* 默认保留本机，可逐条改 */
  openImportSheet();
}

function ciStatsLines(preview){
  var s = preview.stats;
  var lines = [];
  lines.push({ t: '新增 ' + s.add + ' 条', sub: '导入文件里有、本机没有的定义与重点/菜单项，追加到末尾' });
  lines.push({ t: '冲突 ' + s.conflict + ' 条', sub: '两边都有但内容不同，逐条选择：用导入版还是保留本机' });
  lines.push({ t: '相同跳过 ' + s.same + ' 条', sub: '两边完全一样，不用动' });
  lines.push({ t: '保留本机 ' + s.keepLocal + ' 条', sub: '本机有、导入文件里没有，不会被删' });
  var extra = [];
  if(s.settingsChanged && s.settingsChanged.length) extra.push('设置变更：' + s.settingsChanged.join('、'));
  if(s.pluginUpdates) extra.push('插件开关更新 ' + s.pluginUpdates + ' 个');
  if(s.pluginAdds) extra.push('补上缺失插件 ' + s.pluginAdds + ' 个');
  if(s.settingsChanged && s.settingsChanged.indexOf('mealSlots') >= 0) extra.push('餐次清单按导入文件整体替换');
  lines.push({ t: extra.length ? extra.join('；') : '设置与插件：无变更', sub: '文件没提供的设置保持本机原样' });
  /* 插件变化逐项展示：已有插件（开关翻转）与新增插件分别列，各显示名称与状态变化 */
  function onoff(v){ return v ? '开' : '关'; }
  if(s.pluginDetails && s.pluginDetails.updates.length){
    s.pluginDetails.updates.forEach(function(u){
      lines.push({ t: '插件开关更新：' + (u.name || u.id),
        sub: '本机：' + onoff(u.from) + ' → 导入后：' + onoff(u.to) });
    });
  }
  if(s.pluginDetails && s.pluginDetails.adds.length){
    s.pluginDetails.adds.forEach(function(a){
      lines.push({ t: '补上缺失插件：' + (a.name || a.id),
        sub: '本机没有这个插件 → 导入后状态：' + onoff(a.enabled) });
    });
  }
  return lines;
}

function openImportSheet(){
  var body = openSheet(
    '<div class="shd"><div class="shd-t">导入配置文件</div><div class="shd-s">' + esc(CI_STATE.fileLabel) + '</div></div>' +
    '<div id="ciBody"></div>' +
    '<div class="acts">' +
      '<button class="btn g" id="ciCancel">取消</button>' +
      '<button class="btn p" id="ciOk">确认导入</button>' +
    '</div>'
  );
  body.querySelector('#ciCancel').addEventListener('click', function(){
    CI_STATE.file = null; CI_STATE.preview = null; CI_STATE.choices = {};
    closeSheet();
  });
  body.querySelector('#ciOk').addEventListener('click', confirmConfigImport);
  renderImportSheetBody();
}

/* 预览过期重算后整体重渲染；旧的冲突选择保留仍然有效的 key，其余重置为保留本机 */
function renderImportSheetBody(){
  var body = $('sheetBody');
  var box = body.querySelector('#ciBody');
  if(!box || !CI_STATE.preview) return;
  var p = CI_STATE.preview;
  var keep = CI_STATE.choices;
  CI_STATE.choices = {};
  p.conflicts.forEach(function(cf){
    CI_STATE.choices[cf.key] = (keep[cf.key] === 'incoming') ? 'incoming' : 'local';
  });
  var html = '<div class="card plain" id="ciStats">';
  ciStatsLines(p).forEach(function(l){
    html += '<div class="row"><div class="row-main"><div class="row-t">' + esc(l.t) +
      '</div><div class="row-s">' + esc(l.sub) + '</div></div></div>';
  });
  html += '</div>';
  /* 全部冲突保留本机且没有其他实际变化 → 提示本次确认不会改任何数据 */
  var noEffNow = !window.OLConfigIO.previewHasEffectiveChange(p, CI_STATE.choices);
  if(p.conflicts.length && noEffNow){
    html += '<div style="font-size:10.5px;color:var(--ink3);margin:8px 4px 0;line-height:1.6">所有冲突都保留本机，且没有其他变化——确认不会改任何数据。</div>';
  }
  if(p.conflicts.length){
    html += '<div class="sec"><span class="sec-t">冲突（逐条选择）</span><span class="sec-line"></span></div>';
    p.conflicts.forEach(function(cf, i){
      html += '<div class="row" data-ci="' + esc(cf.key) + '">' +
        '<div class="row-main"><div class="row-t">' + esc(cf.label) + ' <span style="color:var(--ink3)">(' + esc(cf.id) + ')</span></div>' +
        '<div class="row-s">本机：' + esc(window.OLConfigIO.configItemSummary(cf.kind, cf.local)) + '<br>导入：' + esc(window.OLConfigIO.configItemSummary(cf.kind, cf.incoming)) + '</div></div>' +
        '<div class="row-a">' +
          '<button class="btn g sm" id="ciL' + i + '">保留本机</button> ' +
          '<button class="btn p sm" id="ciR' + i + '">用导入版</button>' +
        '</div></div>';
    });
    html += '<div style="font-size:10.5px;color:var(--ink3);margin:8px 4px 0;line-height:1.6">每一条冲突都必须选过才提交；默认保留本机。</div>';
  } else if(p.stats.nothingToDo){
    html += '<div style="font-size:11px;color:var(--ink3);margin:10px 4px;line-height:1.7">导入文件和本机配置一致，没有什么要导入的。直接关闭就行。</div>';
  }
  box.innerHTML = html;
  var okBtn = body.querySelector('#ciOk');
  function refreshOkBtn(){
    if(!okBtn) return;
    /* 确认可用性跟裁决联动：纯相同 → 禁用；全部冲突保留本机且无其他变化 → 禁用；
       任一真实变化（新增/设置/插件/任一冲突选导入版）→ 可确认 */
    var eff = window.OLConfigIO.previewHasEffectiveChange(CI_STATE.preview, CI_STATE.choices);
    var none = !!CI_STATE.preview.stats.nothingToDo || !eff;
    okBtn.disabled = none;
    okBtn.textContent = CI_STATE.preview.stats.nothingToDo ? '没有要导入的变更'
      : (none ? '没有要导入的变更（冲突均保留本机）' : '确认导入');
    okBtn.className = 'btn ' + (none ? 'g' : 'p');
  }
  refreshOkBtn();
  p.conflicts.forEach(function(cf, i){
    var l = box.querySelector('#ciL' + i), r = box.querySelector('#ciR' + i);
    function paint(){
      var v = CI_STATE.choices[cf.key];
      if(l){ l.className = 'btn sm ' + (v === 'local' ? 'p' : 'g'); }
      if(r){ r.className = 'btn sm ' + (v === 'incoming' ? 'p' : 'g'); }
      refreshOkBtn();  /* 每次裁决变化都重算确认按钮可用性 */
    }
    if(l) l.addEventListener('click', function(){ CI_STATE.choices[cf.key] = 'local'; paint(); });
    if(r) r.addEventListener('click', function(){ CI_STATE.choices[cf.key] = 'incoming'; paint(); });
    paint();
  });
}

function confirmConfigImport(){
  var st = CI_STATE;
  if(!st.preview || st.submitting) return;
  if(st.submitting) return;
  /* 冲突逐条都必须有明确选择（UI 默认保留本机，可改）；缺选直接拦截 */
  for(var i = 0; i < st.preview.conflicts.length; i++){
    var key = st.preview.conflicts[i].key;
    if(st.choices[key] !== 'local' && st.choices[key] !== 'incoming'){
      toast(OLT('还有冲突没选好，每一条都要选')); return;
    }
  }
  /* 无实际变化（全部冲突保留本机且无新增/设置/插件变化）：不提交、不动 bizRev */
  if(!window.OLConfigIO.previewHasEffectiveChange(st.preview, st.choices)){
    toast(OLT('没有要导入的变更，本机没有任何改动'));
    closeSheet();
    st.file = null; st.preview = null; st.choices = {};
    return;
  }
  if(st.mode === 'legacy'){
    var res = OLConfigIO.applyResolutions(st.preview, st.choices);
    if(!res){ toast(OLT('导入失败：合并结果异常')); return; }
    applyConfigImport(res.merged);
    closeSheet();
    st.file = null; st.preview = null; st.choices = {};
    var okL = save(function(){ toast(OLT('配置已导入')); });
    if(!okL) toast(OLT('导入没存上，再试一次'));
    return;
  }
  /* idb：确认时复核 队列空闲 / writer 仍有效 / bizRev 未变 */
  var Q = window.OLCommitQueue, W = window.OLWrite;
  var qs = (Q && typeof Q.status === 'function') ? Q.status() : null;
  if(!Q || !W || typeof W.readBizRev !== 'function' || !W.wired ||
     !qs || qs.state !== 'idle' || qs.inFlight || qs.pending || qs.recoveringJob){
    toast(OLT('当前保存还没就绪（队列忙或写入未接线），稍后再确认')); return;
  }
  if(st.reading) return;
  st.reading = true;
  W.readBizRev().then(function(rr){
    st.reading = false;
    if(!rr || rr.ok !== true){ toast(OLT('导入失败：读不到当前版本号，请重试')); return; }
    if(st.baselineRev !== null && rr.rev !== st.baselineRev){
      /* 预览已过期：重读库、重算预览、要求再次确认；绝不用旧预览覆盖新状态 */
      readConfigSource(function(data, meta){
        var local = OLConfigIO.buildConfigPayload(data);
        var p2 = OLConfigIO.previewConfigImport(local, st.file.config, { pluginNames: ciPluginNames() });
        if(!p2 || p2.ok !== true){ toast(OLT('导入失败：重算预览失败')); return; }
        CI_STATE.preview = p2;
        CI_STATE.baselineRev = (meta && typeof meta.bizRev === 'number') ? meta.bizRev : null;
        renderImportSheetBody();
        toast(OLT('本机数据在这期间有变化，预览已重算，请再确认一次'));
      }, function(msg){
        toast(OLT('重算预览失败：') + msg);
      });
      return;
    }
    var res2 = OLConfigIO.applyResolutions(st.preview, st.choices);
    if(!res2){ toast(OLT('导入失败：合并结果异常')); return; }
    st.submitting = true;
    /* 同一个 JS 回合内完成：改 S → 入队（快照克隆）→ CAS 提交，中间无等待点 */
    applyConfigImport(res2.merged);
    closeSheet();
    st.file = null; st.preview = null; st.choices = {}; st.submitting = false;
    var ok = save(function(){ toast(OLT('配置已导入并保存')); });
    if(!ok) toast(OLT('导入没存上（队列拒绝了这次提交）'));
  }, function(){
    st.reading = false;
    toast(OLT('导入失败：读不到当前版本号，请重试'));
  });
}



/* ==================== 导出表格 ==================== */
/* 把各类记录摊平成「日期 / 类别 / 内容 / 补充」四列的一张 CSV。
   只读取传入的数据：不改全局 S、不写任何存储、不调用 save()。
   Excel / WPS 打开中文需要 UTF-8 BOM；单元格一律加引号并转义内部双引号。 */
function tableText(v){
  if(v === null || v === undefined || typeof v === 'object') return '';
  return String(v);
}
function tableField(o, keys){
  for(var i = 0; i < keys.length; i++){
    var v = tableText(o[keys[i]]);
    if(v !== '') return v;
  }
  return '';
}
function tableJoin(parts){
  return parts.filter(function(x){ return x !== '' && x !== null && x !== undefined; }).join('；');
}
function tableCsvCell(v){
  return '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
}

function buildTableRows(D){
  var rows = [];
  function add(date, kind, content, extra){
    rows.push([date || '', kind, content || '', extra || '']);
  }
  var penName = {};
  (Array.isArray(D.pens) ? D.pens : []).forEach(function(p){
    if(p && p.id) penName[p.id] = tableText(p.name || p.emoji || p.id);
  });
  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  (Array.isArray(D.plans) ? D.plans : []).forEach(function(p){
    if(!p) return;
    add(p.date, '计划', tableField(p, ['title', 'text']),
      tableJoin([tableText(p.note), p.done ? '已完成' : '']));
  });
  var notes = (D.notes && typeof D.notes === 'object') ? D.notes : {};
  Object.keys(notes).forEach(function(k){
    var v = tableText(notes[k]);
    if(v.trim()) add(k, '每日笔记', v, '');
  });
  var marks = (D.marks && typeof D.marks === 'object') ? D.marks : {};
  Object.keys(marks).forEach(function(k){
    var m = marks[k];
    var items = (m && Array.isArray(m.items)) ? m.items : [];
    var names = items.map(function(it){
      return penName[it && it.penId] || tableText(it && it.penId);
    }).filter(function(x){ return x; });
    if(names.length) add(k, '标记', names.join('、'), '');
  });
  (Array.isArray(D.workouts) ? D.workouts : []).forEach(function(w){
    if(!w) return;
    var parts = Array.isArray(w.parts) ? w.parts.map(tableText).filter(function(x){ return x; }) : [];
    add(w.date, '训练', parts.join('、'),
      tableJoin([w.minutes ? w.minutes + ' 分钟' : '', w.kcal ? w.kcal + ' 千卡' : '', tableText(w.note)]));
  });
  (Array.isArray(D.studyLogs) ? D.studyLogs : []).forEach(function(s){
    if(!s) return;
    add(s.date, '学习', tableText(s.what),
      tableJoin([s.minutes ? s.minutes + ' 分钟' : '', tableText(s.note)]));
  });
  (Array.isArray(D.decisionLog) ? D.decisionLog : []).forEach(function(d){
    if(!d) return;
    add(d.date, '决定', tableText(d.title),
      tableJoin([d.duration ? '计划 ' + Math.round(d.duration / 60) + ' 分钟' : '',
        d.actual ? '实际 ' + Math.round(d.actual / 60) + ' 分钟' : '']));
  });
  (Array.isArray(D.restDays) ? D.restDays : []).forEach(function(day){
    add(day, '休息日', '休息', '');
  });
  (Array.isArray(D.flashes) ? D.flashes : []).forEach(function(f){
    if(!f) return;
    add(f.date, '灵光一闪', tableField(f, ['text', 'title']), tableText(f.time));
  });
  (Array.isArray(D.itemLogs) ? D.itemLogs : []).forEach(function(r){
    if(!r) return;
    add(r.date, '重点记录', tableField(r, ['what', 'text', 'title']),
      tableJoin([r.minutes ? r.minutes + ' 分钟' : '', r.count ? r.count + ' 次' : '', tableText(r.feel)]));
  });
  (Array.isArray(D.tasks) ? D.tasks : []).forEach(function(t){
    if(!t) return;
    add(t.due || t.date || '', '待办', tableText(t.title),
      tableJoin([tableText(t.cat), tableText(t.note)]));
  });
  (Array.isArray(D.schedule) ? D.schedule : []).forEach(function(s){
    if(!s) return;
    var wd = (s.weekday !== null && s.weekday !== undefined && s.weekday !== '') ?
      '每周' + WEEK[+s.weekday] : '';
    var span = (tableText(s.start) && tableText(s.end)) ? s.start + '–' + s.end : '';
    add(s.date || '', '日程', tableText(s.title),
      tableJoin([wd, span, tableText(s.place)]));
  });

  var order = ['计划', '每日笔记', '标记', '训练', '学习', '决定', '休息日',
    '灵光一闪', '重点记录', '待办', '日程'];
  rows.sort(function(a, b){
    if(a[0] && !b[0]) return -1;
    if(!a[0] && b[0]) return 1;
    if(a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    return order.indexOf(a[1]) - order.indexOf(b[1]);
  });
  return rows;
}

function writeTableFile(D){
  var rows;
  try{ rows = buildTableRows(D); }
  catch(e){ toast(OLT('导出失败：整理记录时出错，未生成表格')); return; }
  var lines = [['日期', '类别', '内容', '补充']].concat(rows).map(function(r){
    return r.map(tableCsvCell).join(',');
  });
  var text = '\ufeff' + lines.join('\r\n') + '\r\n';
  var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'earthonline-表格-' + todayReal() + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
  toast(OLT('已导出表格'));
}

function exportTable(){
  /* 与 JSON 备份共用同一个 idb 判据和同一条只读取数路径：
     本地库里已保存的数据才进表格，读失败就报错且不生成文件。 */
  if(bizWriteBlocked()){
    readExportSource(writeTableFile, function(msg){ toast(OLT('导出失败：') + msg + '，未生成表格'); });
    return;
  }
  writeTableFile(S);
}

function importJSON(){
  if(bizWriteBlocked()){ bizWriteBlockedNotice(); return; }   /* idb 模式：入口拦截，S 不被替换 */
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.addEventListener('change', function(){
    var f = inp.files && inp.files[0];
    if(!f) return;
    var fr = new FileReader();
    fr.onload = function(){
      var parsed = null;
      try{ parsed = JSON.parse(fr.result); }catch(e){ toast(OLT('这个文件读不出来')); return; }
      var data = parsed && parsed.data ? parsed.data : parsed;
      if(!data || typeof data !== 'object' || !Array.isArray(data.tasks)){ toast(OLT('不像是备份文件')); return; }
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
          save(); renderAll(); toast(OLT('已恢复'));
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
    h += '<span style="background:' + bg + ';' + (inRange ? 'border-color:var(--line)' : '') + '">' +
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
  if(OLDatePicker){
    OLDatePicker.attach(body.querySelector('#pdfFrom'));
    OLDatePicker.attach(body.querySelector('#pdfTo'));
  }
  body.querySelector('#pdfCancel').addEventListener('click', closeSheet);
  body.querySelector('#pdfMake').addEventListener('click', function(){
    var from = body.querySelector('#pdfFrom').value || addDays(TODAY(), -30);
    var to = body.querySelector('#pdfTo').value || TODAY();
    if(from > to){ toast(OLT('开始日期要在结束日期前面')); return; }
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
