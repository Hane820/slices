/* presets.js — 地球online 默认预设种子（独立单文件）
 *
 * 这里放的是「第一次打开应用时的默认内容」：情境、荧光笔、标签、建议库、
 * 每日待办、插件、吃什么菜单、今日重点预设、餐次、主题名，以及少量分类名。
 * core.js / settings.js 已把这些内容的初始值搬走，启动时从本文件读取，
 * 不再内嵌中文。要改默认预设，只改本文件等号右边的文字，存盘刷新即可。
 *
 * 改法：只改每一项里带引号的文字（名字 / 说明 / 分类名等）。
 *      不要改 id、键名（如 id:'s1'、afterclass）、数字、颜色、emoji、true/false——
 *      那些是程序用来认条目、算时长、存数据的，改了会让历史记录对不上。
 *
 * 生效范围：只影响「首次建档」的默认值。已经在用的浏览器里，这些内容是你的
 *      自定义数据（存在本机库里），不会因为改了这里而被覆盖；想让老设备也变，
 *      需要在设置页手动改，或用「导出/导入配置文件」迁移。
 *
 * 注意区分：界面按钮/提示文字在 config/ 下的分组文件里，不在这里。
 */
(function(){
  var P = {};

  /* ---------- 情境：点一个，就列出绑在这个情境上的建议 ----------
     注意：afterclass（下课后）与 inclass（上课时）是两个独立情境，
     各自有独立键名。afterclass 是老版本就有的，老用户的历史数据和建议
     绑定都挂在它上面——永远不要删除或改名这两个键。 */
  P.SCENES = [
    { k:'afterclass', n:'下课后',       d:'刚下课，还没安排' },
    { k:'inclass',    n:'上课时',       d:'妈妈人生是旷课' },
    { k:'noclass',    n:'没课',         d:'悠哉悠哉' },
    { k:'tired',      n:'疲惫',         d:'累了' },
    { k:'nofuel',     n:'不想动',       d:'什么都不想开始' },
    { k:'bored',      n:'无聊',         d:'想找点事做' },
    { k:'meal',       n:'刚吃完饭',     d:'消化消化' },
    { k:'move',       n:'精力十足',     d:'动起来！' },
    { k:'study',      n:'想学点东西',   d:'三分钟热度也没关系' },
    { k:'beforebed',  n:'睡前',         d:'ZzzzzZzz' },
    { k:'lost',       n:'焦虑',         d:'做点什么安抚一下自己吧' }
  ];

  /* ---------- 荧光笔：颜色 / emoji 别动，只改名字 ---------- */
  P.PENS = [
    { id:'p1', color:'#B6CBA8', emoji:'😐', name:'平静' },
    { id:'p2', color:'#A8C0D8', emoji:'⚠️', name:'波动' },
    { id:'p3', color:'#E8CEA8', emoji:'❕', name:'事件' }
  ];

  /* ---------- 默认标签 ---------- */
  P.TAGS = ['运动日','生理期','排卵期','熬夜','休息日'];

  /* ---------- 建议库：name=标题，note=补充说明，cat=分类，其余是匹配与时长，别动 ---------- */
  P.SUGGESTIONS = [
    { id:'s1',  name:'出去散步',        cat:'身体', duration:1200, tags:['bored','tired','quiet'],     times:['afternoon','evening'], priority:2, random:true, enabled:true, note:'自我放松' },
    { id:'s2',  name:'练一组力量',      cat:'健身', duration:2400, tags:['train','fresh'],             times:['afternoon','evening'], priority:3, random:true, enabled:true, note:'记得拉伸和补水' },
    { id:'s3',  name:'拉伸',            cat:'健身', duration:600,  tags:['tired','sore','train'],      times:['evening','night'],     priority:2, random:true, enabled:true, note:'健康生活' },
    { id:'s4',  name:'洗澡',            cat:'身体', duration:1200, tags:['tired','empty','low'],       times:['evening','night'],     priority:3, random:true, enabled:true, note:'自我重启' },
    { id:'s5',  name:'复习',            cat:'学习', duration:1200, tags:['study','postclass'],         times:['afternoon','evening'], priority:3, random:true, enabled:true, note:'温故而知新' },
    { id:'s6',  name:'看 20 分钟书',    cat:'学习', duration:1200, tags:['study','bored','quiet'],     times:['afternoon','night'],   priority:2, random:true, enabled:true, note:'纸质书，手机放远' },
    { id:'s7',  name:'记手帐',          cat:'生活', duration:600,  tags:['journal','sad','quiet'],     times:['evening','night'],     priority:3, random:true, enabled:true, note:'不然生活的记忆从指尖溜走了' },
    { id:'s8',  name:'整理桌面/房间',   cat:'生活', duration:900,  tags:['chores','bored','anxious'],  times:['afternoon','evening'], priority:1, random:true, enabled:true, note:'最简单的掌控感' },
    { id:'s9',  name:'洗衣服',          cat:'生活', duration:600,  tags:['chores'],                    times:['afternoon','evening'], priority:1, random:true, enabled:true, note:'吾日三省吾身：洗衣否，洗澡否，睡够否？' },
    { id:'s10', name:'吃东西',          cat:'身体', duration:900,  tags:['hungry','tired'],            times:['morning','afternoon','evening'], priority:3, random:true, enabled:true, note:'不饿别吃' },
    { id:'s11', name:'眯一会',          cat:'身体', duration:1200, tags:['tired','sleepy','empty'],    times:['afternoon'],           priority:2, random:true, enabled:true, note:'记得定闹钟' },
    { id:'s12', name:'放下手机，发呆',  cat:'心情', duration:900,  tags:['phone','anxious','bored'],   times:['any'],                 priority:2, random:true, enabled:true, note:'你不许玩手机' },
    { id:'s13', name:'检查一下有啥事没做不', cat:'心情', duration:300, tags:['chores','anxious'],      times:['any'],                 priority:1, random:true, enabled:true, note:'比如妈妈叫你从冰箱拿冻肉' },
    { id:'s14', name:'收拾一下之后要用的东西', cat:'生活', duration:600, tags:['postclass','chores'],  times:['evening','night'],     priority:2, random:true, enabled:true, note:'钥匙耳机眼镜纸巾身份证' },
    { id:'s15', name:'保持收腹/提肛十次', cat:'心情', duration:600, tags:['bored','tired'],            times:['any'],                 priority:1, random:true, enabled:true, note:'立刻！马上！' },
    { id:'s16', name:'取快递',          cat:'生活', duration:900,  tags:['parcel'],                    times:['afternoon','evening'], priority:2, random:true, enabled:true, note:'买什么了呀？' }
  ];

  /* ---------- 建议默认绑哪些情境：情境键与上表 k 一一对应，改名后这里必须同步 ---------- */
  P.SUGGESTION_SCENES = {
    s1:['bored','tired','meal'],        s2:['move','noclass'],           s3:['tired','move','beforebed'],
    s4:['tired','nofuel','beforebed'], s5:['afterclass','study'],       s6:['study','bored','beforebed'],
    s7:['beforebed','lost'],            s8:['bored','lost'],             s9:['lost','noclass'],
    s10:['afterclass','tired'],         s11:['tired','nofuel','meal'],   s12:['bored','lost','beforebed'],
    s13:['lost','bored'],               s14:['afterclass','beforebed'],  s15:['nofuel','tired'],
    s16:['afterclass','noclass']
  };

  /* ---------- 每日重复待办（默认三条） ---------- */
  P.TASKS = [
    { id:'t1', title:'护肤',   duration:300 },
    { id:'t2', title:'刷牙',   duration:180 },
    { id:'t3', title:'洗衣服', duration:600 }
  ];

  /* ---------- 首页插件：name / desc 可改，id 与 enabled 别动 ---------- */
  P.PLUGINS = [
    { id:'tags', name:'标签打卡', desc:'+1', enabled:false },
    { id:'food', name:'吃什么',   desc:'是啊，吃什么', enabled:true },
    { id:'diet', name:'饮食记录', desc:'不要不小心吃太多', enabled:false }
  ];

  /* ---------- 吃什么菜单：cat 必须取自下面的 FOOD_CATS，否则菜单筛选里归不到类 ---------- */
  P.FOOD_ITEMS = [
    { id:'fd-congee',   name:'三鲜汤粉',     cat:'清淡',   note:'没胃口就吃汤汤水水', slots:['breakfast','night'], enabled:true },
    { id:'fd-baozi',    name:'包子',         cat:'随便吃', note:'最经典',             slots:['breakfast'],         enabled:true },
    { id:'fd-malatang', name:'麻辣烫',       cat:'外卖',   note:'不要麻不要辣',       slots:['lunch','dinner','night'], enabled:true },
    { id:'fd-salad',    name:'鸡胸肉',       cat:'蛋白质', note:'蛋白质',             slots:['lunch','tea'],       enabled:true },
    { id:'fd-dumpling', name:'饺子',         cat:'随便吃', note:'想吃荠菜馅...',       slots:['lunch','dinner'],    enabled:true },
    { id:'fd-hotpot',   name:'火锅',         cat:'聚餐',   note:'亚米亚米',           slots:['dinner','night'],    enabled:true },
    { id:'fd-bbq',      name:'烤肉',         cat:'聚餐',   note:'肉！',               slots:['night'],             enabled:true },
    { id:'fd-sandwich', name:'储备粮罐头',   cat:'随便吃', note:'不要光买不吃',       slots:['breakfast','tea'],   enabled:true },
    { id:'fd-cake',     name:'蛋白粉拌酸奶', cat:'蛋白质', note:'酸奶味蛋白粉拌酸奶', slots:['tea'],               enabled:true }
  ];

  /* ---------- 今日重点预设：text=名字，label/ph=自填时的字段名与提示 ---------- */
  P.FOCUS_ITEMS = [
    { id:'fi-train', text:'健身', goal:{ value:30, unit:'分钟' }, mode:'multi' },
    { id:'fi-study', text:'学习', goal:{ value:40, unit:'分钟' }, mode:'text', label:'学了什么', ph:'高数 / 单词…（可留空）' }
  ];

  /* ---------- 饮食餐次 ---------- */
  P.MEAL_SLOTS = ['早餐','午餐','晚餐','加餐'];

  /* ---------- 决策库/建议的默认筛选值 ---------- */
  P.FILTER_ALL = '全部';

  /* ---------- 身体部位选项：⚠ 这些文字会写进训练历史与重点选项，改了旧记录含义会变，一般别动 ---------- */
  P.PARTS = ['胸','背','腿','肩','手臂','核心','有氧','拉伸','休息'];

  /* ---------- 计数单位：⚠ 会写进目标数据，改了旧记录含义会变，一般别动 ---------- */
  P.FOCUS_UNITS = ['分钟','小时','次','杯','页','个'];
  P.FOCUS_TIME_UNITS = ['分钟','小时'];
  P.UNIT_DEFAULT = '分钟';

  /* ---------- 分类 / 餐位显示名 ---------- */
  P.CAT_LABEL = { must:'必须处理', want:'今天想完成', routine:'每天重复' };
  P.FOOD_SLOT_LABEL = { breakfast:'早餐', lunch:'午餐', tea:'下午茶', dinner:'晚餐', night:'夜宵' };
  P.FOOD_SLOT_ANY = '随时';
  P.FOOD_CATS = ['减脂','蛋白质','清淡','外卖','聚餐','其它','随便吃'];

  window.OLPresets = P;
})();
