/* legacy.js — 旧数据读取、结构校验与迁移预览（严格只读）
 *
 * 本文件只做四件事：
 *   1) 读取 localStorage 里的原始字符串，保留逐字符快照，算 SHA-256
 *   2) 识别数据版本与读取状态（不存在 / 空串 / JSON 损坏 / 非对象 / 正常）
 *   3) 按真实 defaults() 与已冻结的六表 Schema 做结构校验，分致命 / 警告 / 提示三级
 *   4) 给出六表迁移预览（预计写入条数、meta 基础设施、无法映射的记录、ID 冲突）
 *
 * 明确不做：
 *   - 不调用 normalize() / save() / loadState() / any 业务函数，不碰全局 `S`
 *   - 不写 localStorage（不 setItem / removeItem / clear），只 getItem
 *   - 不打开 IndexedDB，不写任何业务数据（本文件不引用 OLDB）
 *   - 不修复数据、不删未知字段、不补造记录、不改历史时间戳
 *   - 报告不含时间戳，相同输入必得相同结果
 *
 * 依赖：无。可独立于 dexie / db.js 加载。
 */
(function (global) {
  'use strict';

  var KEY = 'earthonline-v4';       /* 与 core.js 的同名常量保持一致 */
  var OLD_KEY = 'earthonline-v3';   /* 仅用于识别「只有 v3 数据」的情况，不读取内容 */
  var EXPECTED_V = 4;
  var SCHEMA_VERSION = 1;           /* 六表 Schema 版本，与 db.js 的 DB_VERSION 语义对应 */

  /* ---------- 19 个顶层字段：顺序与 defaults() 的书写顺序一致 ---------- */
  var TOP_ORDER = [
    'v', 'tasks', 'schedule', 'plans', 'notes', 'marks', 'pens', 'tags', 'tagLogs',
    'suggestions', 'doneSugg', 'workouts', 'studyLogs', 'decisionLog', 'restDays',
    'flashes', 'itemLogs', 'plugins', 'settings'
  ];
  var TOP_KIND = {
    v: 'number',
    tasks: 'array', schedule: 'array', plans: 'array',
    notes: 'map', marks: 'map',
    pens: 'array', tags: 'array', tagLogs: 'array', suggestions: 'array',
    doneSugg: 'map',
    workouts: 'array', studyLogs: 'array', decisionLog: 'array',
    restDays: 'array', flashes: 'array', itemLogs: 'array', plugins: 'array',
    settings: 'object'
  };

  /* ---------- 13 类含 id 的数组（与设计文档 §4.1 一致） ---------- */
  var ID_ARRAYS = [
    { key: 'tasks',       type: 'task',       table: 'tasks' },
    { key: 'schedule',    type: 'schedule',   table: 'schedule' },
    { key: 'plans',       type: 'plan',       table: 'dayEntries' },
    { key: 'pens',        type: 'pen',        table: 'definitions' },
    { key: 'tags',        type: 'tag',        table: 'definitions' },
    { key: 'tagLogs',     type: 'tagLog',     table: 'dayEntries' },
    { key: 'suggestions', type: 'suggestion', table: 'definitions' },
    { key: 'workouts',    type: 'workout',    table: 'dayEntries' },
    { key: 'studyLogs',   type: 'studyLog',   table: 'dayEntries' },
    { key: 'decisionLog', type: 'decision',   table: 'dayEntries' },
    { key: 'flashes',     type: 'flash',      table: 'dayEntries' },
    { key: 'itemLogs',    type: 'itemLog',    table: 'dayEntries' },
    { key: 'plugins',     type: 'plugin',     table: 'meta' }
  ];

  /* ---------- 记录字段规格：required 缺了影响渲染，optional 缺了是正常 ----------
     date       合法 YYYY-MM-DD
     dateEmpty  合法 YYYY-MM-DD 或空串（schedule.date 的空串是正常状态）
     time       合法 HH:MM 或空串
     ms         13 位毫秒时间戳
     any        不做类型检查（内嵌对象结构复杂，交给专项校验） */
  var RECORD_SPEC = {
    tasks: {
      required: { id: 'string', title: 'string', done: 'map' },
      optional: { cat: 'string', repeat: 'string', due: 'dateEmpty', note: 'string', doneTime: 'map', createdAt: 'ms', duration: 'number', suggId: 'string' }
    },
    schedule: {
      required: { id: 'string', title: 'string' },
      optional: { start: 'time', end: 'time', place: 'string', date: 'dateEmpty', weekday: 'number|null' }
    },
    plans: {
      required: { id: 'string', title: 'string', date: 'date' },
      optional: { done: 'boolean', note: 'string', createdAt: 'ms', weekday: 'number|null', doneAt: 'dateEmpty', doneTime: 'time' }
    },
    pens: {
      required: { id: 'string', name: 'string' },
      optional: { color: 'string', emoji: 'string' }
    },
    tags: {
      required: { id: 'string', name: 'string' },
      optional: {}
    },
    tagLogs: {
      required: { id: 'string', tagId: 'string', date: 'date', ts: 'ms' },
      optional: {}
    },
    suggestions: {
      required: { id: 'string', name: 'string' },
      optional: { cat: 'string', tags: 'array', times: 'array', priority: 'number', random: 'boolean', enabled: 'boolean', note: 'string', scenes: 'array', duration: 'number' }
    },
    workouts: {
      required: { id: 'string', date: 'date' },
      optional: { start: 'time', minutes: 'number', parts: 'array', kcal: 'number|null', note: 'string' }
    },
    studyLogs: {
      required: { id: 'string', date: 'date' },
      optional: { time: 'time', minutes: 'number', what: 'string', note: 'string', itemId: 'string' }
    },
    decisionLog: {
      required: { id: 'string', date: 'date', title: 'string' },
      optional: { ts: 'ms', mode: 'string', input: 'string', src: 'string', duration: 'number', actual: 'number' }
    },
    flashes: {
      required: { id: 'string', date: 'date', text: 'string' },
      optional: { time: 'time' }
    },
    itemLogs: {
      required: { id: 'string', itemId: 'string', date: 'date' },
      optional: { time: 'time', minutes: 'number', what: 'string', feel: 'string' }
    },
    plugins: {
      required: { id: 'string' },
      optional: { name: 'string', desc: 'string', enabled: 'boolean' }
    }
  };

  /* ---------- settings 的 12 个键 ---------- */
  var SETTINGS_SPEC = {
    resetHour:       { type: 'number',  range: [0, 23] },
    theme:           { type: 'string',  enum: ['default', 'mist', 'clay', 'matcha', 'lotus', 'warm'] },
    showDone:        { type: 'boolean' },
    remind:          { type: 'boolean' },
    remindDismissed: { type: 'string' },
    goals:           { type: 'object' },
    libFilter:       { type: 'string' },
    randFilter:      { type: 'string' },
    uiScale:         { type: 'number',  range: [0.85, 1.6] },
    tasksFold:       { type: 'boolean' },
    focusSeedV:      { type: 'number' },
    focusItems:      { type: 'array' }
  };
  var THEME_KEYS = SETTINGS_SPEC.theme.enum;

  /* meta 的固定 8 个 key：3 个载荷 + 5 个基础设施 */
  var META_PAYLOAD_KEYS = ['v', 'settings', 'plugins'];
  var META_INFRA_KEYS = ['schemaVersion', 'migration', 'writer', 'preNormalize', 'bizDatePolicy'];

  /* ==================== 基础工具 ==================== */

  function kindOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /* 本地时区回验，避免 toISOString() 的 UTC 偏移把月初月末判错 */
  function isDate(s) {
    if (typeof s !== 'string' || s.length !== 10) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  function isTime(s) {
    if (s === '') return true;                    /* 空串是合法的「未填」 */
    if (typeof s !== 'string' || !/^\d{2}:\d{2}$/.test(s)) return false;
    var h = +s.slice(0, 2), mi = +s.slice(3, 5);
    return h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
  }

  function isMs(n) {
    return isNum(n) && n > 0;
  }

  function msLooksOdd(n) {
    /* 13 位毫秒约在 1e12 ~ 1e14；秒级时间戳或 0 都会落到区间外 */
    return isMs(n) && (n < 1e12 || n > 1e14);
  }

  function matches(v, expect) {
    switch (expect) {
      case 'string':      return typeof v === 'string';
      case 'number':      return isNum(v);
      case 'boolean':     return typeof v === 'boolean';
      case 'array':       return Array.isArray(v);
      case 'map':         return isPlainObject(v);
      case 'object':      return isPlainObject(v);
      case 'date':        return isDate(v);
      case 'dateEmpty':   return v === '' || isDate(v);
      case 'time':        return isTime(v);
      case 'ms':          return isMs(v);
      case 'number|null': return v === null || isNum(v);
      default:            return true;
    }
  }

  function utf8Bytes(s) {
    try { if (typeof global.Blob === 'function') return new global.Blob([s]).size; } catch (e) {}
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  /* SHA-256：浏览器不支持就返回 supported:false，绝不伪造一个值 */
  function sha256(text) {
    var subtle = global.crypto && global.crypto.subtle;
    if (!subtle || typeof global.TextEncoder !== 'function') {
      return Promise.resolve({ supported: false, hex: null });
    }
    try {
      var buf = new global.TextEncoder().encode(text);
      return subtle.digest('SHA-256', buf).then(function (ab) {
        var bytes = new Uint8Array(ab), hex = '';
        for (var i = 0; i < bytes.length; i++) hex += ('0' + bytes[i].toString(16)).slice(-2);
        return { supported: true, hex: hex };
      }, function () {
        return { supported: true, hex: null, error: 'digest-failed' };
      });
    } catch (e) {
      return Promise.resolve({ supported: false, hex: null, error: 'digest-threw' });
    }
  }

  /* ==================== 读取 ==================== */

  /* 只 getItem，任何写操作都不做。null=键不存在，''=存在但为空 */
  function readRaw() {
    var out = { available: false, present: false, raw: null, bytes: 0, error: null, legacyFound: false };
    try {
      if (typeof global.localStorage === 'undefined' || !global.localStorage) {
        out.error = 'localStorage 不可用';
        return out;
      }
      out.available = true;
      var raw = global.localStorage.getItem(KEY);
      if (raw !== null) {
        out.present = true;
        out.raw = raw;
        out.bytes = utf8Bytes(raw);
        return out;
      }
      /* 主键不存在时，看一眼有没有 v3 老数据（只判存在，不解析、不迁移） */
      try { out.legacyFound = global.localStorage.getItem(OLD_KEY) !== null; } catch (e2) {}
      return out;
    } catch (e) {
      out.error = String((e && e.message) || e);
      return out;
    }
  }

  /* ==================== Issue 收集 ==================== */

  function IssueBag() {
    this.list = [];
  }
  IssueBag.prototype.add = function (level, code, path, message, detail) {
    var it = { level: level, code: code, path: path || '', message: message };
    if (detail !== undefined) it.detail = detail;
    this.list.push(it);
    return it;
  };
  IssueBag.prototype.fatal = function (code, path, message, detail) { return this.add('fatal', code, path, message, detail); };
  IssueBag.prototype.warn  = function (code, path, message, detail) { return this.add('warn', code, path, message, detail); };
  IssueBag.prototype.info  = function (code, path, message, detail) { return this.add('info', code, path, message, detail); };
  IssueBag.prototype.sorted = function () {
    var w = { fatal: 0, warn: 1, info: 2 };
    return this.list.slice().sort(function (a, b) {
      if (w[a.level] !== w[b.level]) return w[a.level] - w[b.level];
      if (a.code !== b.code) return a.code < b.code ? -1 : 1;
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      return 0;
    });
  };
  IssueBag.prototype.counts = function () {
    var c = { fatal: 0, warn: 0, info: 0 };
    for (var i = 0; i < this.list.length; i++) c[this.list[i].level]++;
    return c;
  };

  /* ==================== 校验 ==================== */

  function validateTop(data, bag) {
    var key, i;
    for (i = 0; i < TOP_ORDER.length; i++) {
      key = TOP_ORDER[i];
      if (!Object.prototype.hasOwnProperty.call(data, key)) {
        bag.warn('top.missing', key, '缺少顶层字段 ' + key + '；normalize() 会用默认值补上');
        continue;
      }
      var v = data[key], expect = TOP_KIND[key];
      if (expect === 'number') {
        if (!isNum(v)) bag.warn('top.wrongType', key, key + ' 应为数字，实际是 ' + kindOf(v) + '；会被重置为默认值');
        else if (v !== EXPECTED_V) bag.warn('version.unexpected', key, '数据版本是 v' + v + '，当前代码期望 v' + EXPECTED_V);
        continue;
      }
      if (expect === 'array' || expect === 'map' || expect === 'object') {
        if (!matches(v, expect)) {
          bag.fatal('top.wrongType', key,
            key + ' 应为' + (expect === 'array' ? '数组' : '对象') + '，实际是 ' + kindOf(v) +
            '；normalize() 会整体换成默认值，等于丢弃这部分历史');
        }
      }
    }
    /* 多余顶层字段：只提示，原样保留 */
    var extra = [];
    for (key in data) {
      if (Object.prototype.hasOwnProperty.call(data, key) && TOP_ORDER.indexOf(key) < 0) extra.push(key);
    }
    extra.sort();
    for (i = 0; i < extra.length; i++) {
      bag.info('top.extra', extra[i], '多出顶层字段 ' + extra[i] + '；迁移时原样保留，不会被删除');
    }
    return extra;
  }

  function checkRecordFields(rec, spec, path, bag) {
    var f;
    function checkOne(name, expect, required) {
      var has = Object.prototype.hasOwnProperty.call(rec, name);
      if (!has) {
        if (required) bag.warn('rec.missingField', path + '.' + name, '必填字段 ' + name + ' 缺失');
        return;
      }
      var val = rec[name];
      if (!matches(val, expect)) {
        bag.warn('rec.fieldType', path + '.' + name, name + ' 期望 ' + expect + '，实际是 ' + kindOf(val));
        return;
      }
      /* 时间戳落在非 13 位毫秒区间：能迁移，但很可能是秒级或哨兵值 */
      if (expect === 'ms' && msLooksOdd(val)) {
        bag.warn('rec.oddTimestamp', path + '.' + name, name + ' 的时间戳 ' + val + ' 不在 13 位毫秒区间，原值保留但不参与时间排序');
      }
      /* 日期字符串合法但不是标准写法的情况已经在 matches 里拦掉；这里补一条「未来日期」提示 */
    }
    for (f in spec.required) {
      if (Object.prototype.hasOwnProperty.call(spec.required, f)) checkOne(f, spec.required[f], true);
    }
    for (f in spec.optional) {
      if (Object.prototype.hasOwnProperty.call(spec.optional, f)) checkOne(f, spec.optional[f], false);
    }
    /* 未知字段：保留，不删 */
    var known = {}, k;
    for (k in spec.required) if (Object.prototype.hasOwnProperty.call(spec.required, k)) known[k] = 1;
    for (k in spec.optional) if (Object.prototype.hasOwnProperty.call(spec.optional, k)) known[k] = 1;
    var unknown = [];
    for (k in rec) {
      if (Object.prototype.hasOwnProperty.call(rec, k) && !known[k]) unknown.push(k);
    }
    unknown.sort();
    for (var i = 0; i < unknown.length; i++) {
      bag.info('rec.unknownField', path + '.' + unknown[i], '未知字段 ' + unknown[i] + '；原样保留');
    }
  }

  /* 返回 { counts, mappable, unmappable, idIndex } */
  function validateRecords(data, bag) {
    var counts = {}, mappable = {}, unmappable = [];
    var idIndex = {};      /* id -> [{type, path}]，用来发现跨类型同 ID */

    for (var s = 0; s < ID_ARRAYS.length; s++) {
      var spec = ID_ARRAYS[s];
      var arr = data[spec.key];
      if (!Array.isArray(arr)) continue;

      counts[spec.key] = arr.length;
      mappable[spec.key] = 0;
      var seen = {};
      var fieldSpec = RECORD_SPEC[spec.key] || { required: { id: 'string' }, optional: {} };

      for (var i = 0; i < arr.length; i++) {
        var rec = arr[i];
        var path = spec.key + '[' + i + ']';

        if (!isPlainObject(rec)) {
          bag.fatal('rec.notObject', path, '元素不是对象（是 ' + kindOf(rec) + '），无法映射到 ' + spec.table);
          unmappable.push({ key: spec.key, type: spec.type, index: i, id: null, reason: 'not-object' });
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(rec, 'id')) {
          bag.fatal('rec.missingId', path, '缺少 id，无法作为 ' + spec.table + ' 的主键');
          unmappable.push({ key: spec.key, type: spec.type, index: i, id: null, reason: 'missing-id' });
          continue;
        }
        if (typeof rec.id !== 'string' || rec.id === '') {
          bag.fatal('rec.badId', path, 'id 不是非空字符串（' + kindOf(rec.id) + '），无法作为主键');
          unmappable.push({ key: spec.key, type: spec.type, index: i, id: null, reason: 'bad-id' });
          continue;
        }
        if (seen[rec.id]) {
          bag.fatal('rec.duplicateId', path, '同一数组内 id 重复：' + rec.id + '（首次出现在 ' + spec.key + '[' + seen[rec.id].index + ']），后写会覆盖先写');
          unmappable.push({ key: spec.key, type: spec.type, index: i, id: rec.id, reason: 'duplicate-id' });
          continue;
        }
        seen[rec.id] = { index: i };
        mappable[spec.key]++;

        if (!idIndex[rec.id]) idIndex[rec.id] = [];
        idIndex[rec.id].push({ type: spec.type, path: path });

        checkRecordFields(rec, fieldSpec, path, bag);
      }
    }

    /* 跨类型同 ID：设计上允许（复合主键区分），只提示 */
    var ids = Object.keys(idIndex).sort();
    for (var n = 0; n < ids.length; n++) {
      var hits = idIndex[ids[n]];
      if (hits.length > 1) {
        var types = [];
        for (var h = 0; h < hits.length; h++) types.push(hits[h].type);
        bag.info('id.crossType', ids[n], 'id「' + ids[n] + '」在多个类型里出现：' + types.join(' / ') + '；复合主键可区分，不冲突');
      }
    }

    return { counts: counts, mappable: mappable, unmappable: unmappable, idIndex: idIndex };
  }

  function validateRestDays(data, bag, unmappable) {
    var arr = data.restDays;
    if (!Array.isArray(arr)) return { count: 0, mappable: 0 };
    var seen = {}, ok = 0;
    for (var i = 0; i < arr.length; i++) {
      var d = arr[i], path = 'restDays[' + i + ']';
      if (typeof d !== 'string') {
        bag.warn('restDays.notString', path, '休息日应为 YYYY-MM-DD 字符串，实际是 ' + kindOf(d));
        unmappable.push({ key: 'restDays', type: 'restDay', index: i, id: null, reason: 'not-string' });
        continue;
      }
      if (!isDate(d)) {
        bag.warn('restDays.badDate', path, '不是合法日期：' + d);
      }
      if (seen[d]) {
        bag.fatal('restDays.duplicate', path, '休息日重复：' + d + '（首次出现在 restDays[' + seen[d].index + ']），date 会撞主键');
        unmappable.push({ key: 'restDays', type: 'restDay', index: i, id: d, reason: 'duplicate-id' });
        continue;
      }
      seen[d] = { index: i };
      ok++;
    }
    return { count: arr.length, mappable: ok };
  }

  function validateMaps(data, bag) {
    var out = { counts: {}, unmappable: [] };

    /* notes */
    var notes = data.notes;
    if (isPlainObject(notes)) {
      var keys = Object.keys(notes);
      out.counts.notes = keys.length;
      for (var i = 0; i < keys.length; i++) {
        if (!isDate(keys[i])) bag.warn('map.badDateKey', 'notes.' + keys[i], '键不是合法日期，仍可迁移但按日期查不到');
        if (typeof notes[keys[i]] !== 'string') bag.warn('map.valueType', 'notes.' + keys[i], '日记内容应为字符串，实际是 ' + kindOf(notes[keys[i]]));
      }
    }

    /* marks */
    var marks = data.marks;
    if (isPlainObject(marks)) {
      var mkeys = Object.keys(marks);
      out.counts.marks = mkeys.length;
      for (var m = 0; m < mkeys.length; m++) {
        var k = mkeys[m], mv = marks[k], mp = 'marks.' + k;
        if (!isDate(k)) bag.warn('map.badDateKey', mp, '键不是合法日期，仍可迁移但按日期查不到');
        if (!isPlainObject(mv)) {
          bag.warn('map.valueType', mp, '标记应为对象，实际是 ' + kindOf(mv) + '；normalize() 会删掉这条');
          continue;
        }
        if (Array.isArray(mv.items)) {
          for (var j = 0; j < mv.items.length; j++) {
            var it = mv.items[j], ip = mp + '.items[' + j + ']';
            if (!isPlainObject(it)) { bag.warn('map.marksItem', ip, '标记项不是对象'); continue; }
            if (typeof it.penId !== 'string' || it.penId === '') bag.warn('map.marksItem', ip + '.penId', 'penId 缺失或不是字符串');
            if (it.size !== undefined && !(isNum(it.size) && it.size >= 1 && it.size <= 3)) {
              bag.warn('map.marksItem', ip + '.size', 'size 应为 1~3，实际是 ' + it.size + '；normalize() 会改成 2');
            }
          }
        } else if (Object.prototype.hasOwnProperty.call(mv, 'penId')) {
          bag.info('map.legacyShape', mp, '是旧结构 {penId}，normalize() 会就地转成 {items:[...]}');
        } else {
          bag.warn('map.marksShape', mp, '既没有 items 也没有 penId；normalize() 会删掉这条');
        }
        if (mv.updatedAt !== undefined && !isMs(mv.updatedAt)) {
          bag.warn('map.badTimestamp', mp + '.updatedAt', '更新时间不是数字时间戳');
        }
      }
    }

    /* doneSugg */
    var ds = data.doneSugg;
    if (isPlainObject(ds)) {
      var dkeys = Object.keys(ds);
      out.counts.doneSugg = dkeys.length;
      for (var d = 0; d < dkeys.length; d++) {
        var dk = dkeys[d], dv = ds[dk], dp = 'doneSugg.' + dk;
        if (!isDate(dk)) bag.warn('map.badDateKey', dp, '键不是合法日期，仍可迁移但按日期查不到');
        if (!isPlainObject(dv)) {
          bag.warn('map.valueType', dp, '值应为对象，实际是 ' + kindOf(dv));
          continue;
        }
        var inner = Object.keys(dv);
        for (var x = 0; x < inner.length; x++) {
          /* 源码两种写法都有：defaults() 注释写 true，decide.js:215 实际写 1。
             读取处一律按真值判断，所以 true / 1 都算合法，其余值才提示。 */
          var flag = dv[inner[x]];
          if (flag !== true && flag !== 1) {
            bag.warn('map.doneSuggValue', dp + '.' + inner[x], '值应为 true 或 1，实际是 ' + JSON.stringify(flag) + '；读取时按真值处理');
          }
        }
      }
    }

    return out;
  }

  function validateSettings(data, bag) {
    var s = data.settings;
    if (!isPlainObject(s)) return { present: false, focusIds: {}, keys: [] };

    var focusIds = {}, keys = [];
    var known = {};
    for (var k in SETTINGS_SPEC) if (Object.prototype.hasOwnProperty.call(SETTINGS_SPEC, k)) known[k] = 1;

    for (k in SETTINGS_SPEC) {
      if (!Object.prototype.hasOwnProperty.call(SETTINGS_SPEC, k)) continue;
      var spec = SETTINGS_SPEC[k];
      if (!Object.prototype.hasOwnProperty.call(s, k)) {
        bag.warn('settings.missingKey', 'settings.' + k, '缺少配置项 ' + k + '；normalize() 会补默认值');
        continue;
      }
      var v = s[k];
      if (!matches(v, spec.type)) {
        bag.warn('settings.badType', 'settings.' + k, k + ' 期望 ' + spec.type + '，实际是 ' + kindOf(v) + '；会被重置为默认值');
        continue;
      }
      if (spec.enum && spec.enum.indexOf(v) < 0) {
        bag.warn('settings.badEnum', 'settings.' + k, k + ' 的值「' + v + '」不在允许集合里；会被重置为 default');
      }
      if (spec.range && (v < spec.range[0] || v > spec.range[1])) {
        bag.warn('settings.badRange', 'settings.' + k, k + ' 的值 ' + v + ' 超出 ' + spec.range[0] + '~' + spec.range[1] + '；会被重置');
      }
    }

    /* 多余配置键：保留 */
    for (k in s) {
      if (Object.prototype.hasOwnProperty.call(s, k) && !known[k]) {
        bag.info('settings.extraKey', 'settings.' + k, '未知配置项 ' + k + '；原样保留');
        keys.push(k);
      }
    }

    /* focusItems：每项要 id + text，id 不能重复 */
    if (Array.isArray(s.focusItems)) {
      var seen = {};
      for (var i = 0; i < s.focusItems.length; i++) {
        var it = s.focusItems[i], p = 'settings.focusItems[' + i + ']';
        if (!isPlainObject(it)) { bag.warn('focus.notObject', p, '重点项不是对象；normalize() 会过滤掉'); continue; }
        if (typeof it.id !== 'string' || it.id === '') {
          bag.warn('focus.noId', p + '.id', '缺少 id；normalize() 会补一个，itemLogs 的引用会断');
        } else {
          if (seen[it.id]) bag.warn('focus.duplicateId', p + '.id', '重点 id 重复：' + it.id);
          seen[it.id] = true;
          focusIds[it.id] = true;
        }
        if (typeof it.text !== 'string' || it.text === '') {
          bag.warn('focus.noText', p + '.text', '缺少 text；normalize() 会把这整项过滤掉');
        }
        if (it.mode !== undefined && it.mode !== 'multi' && it.mode !== 'text') {
          bag.warn('focus.badMode', p + '.mode', 'mode 只能是 multi / text，实际是 ' + JSON.stringify(it.mode) + '；会被改成 text');
        }
        if (it.goal !== undefined && it.goal !== null) {
          if (!isPlainObject(it.goal)) bag.warn('focus.badGoal', p + '.goal', 'goal 应为 null 或对象');
          else {
            if (!isNum(it.goal.value) || it.goal.value <= 0) bag.warn('focus.badGoal', p + '.goal.value', '目标值应为正数，实际是 ' + JSON.stringify(it.goal.value) + '；会被置为 null');
            if (typeof it.goal.unit !== 'string' || it.goal.unit === '') bag.warn('focus.badGoal', p + '.goal.unit', '单位应为非空字符串');
          }
        }
      }
    }

    return { present: true, focusIds: focusIds, keys: keys };
  }

  function validateRefs(data, ctx, bag) {
    var i, j;
    var tagIds = {}, penIds = {}, suggIds = {}, focusIds = ctx.focusIds || {};

    if (Array.isArray(data.tags)) for (i = 0; i < data.tags.length; i++) {
      if (isPlainObject(data.tags[i]) && typeof data.tags[i].id === 'string') tagIds[data.tags[i].id] = true;
    }
    if (Array.isArray(data.pens)) for (i = 0; i < data.pens.length; i++) {
      if (isPlainObject(data.pens[i]) && typeof data.pens[i].id === 'string') penIds[data.pens[i].id] = true;
    }
    if (Array.isArray(data.suggestions)) for (i = 0; i < data.suggestions.length; i++) {
      if (isPlainObject(data.suggestions[i]) && typeof data.suggestions[i].id === 'string') suggIds[data.suggestions[i].id] = true;
    }

    /* tagLogs.tagId → tags.id */
    if (Array.isArray(data.tagLogs)) for (i = 0; i < data.tagLogs.length; i++) {
      var tl = data.tagLogs[i];
      if (!isPlainObject(tl) || typeof tl.tagId !== 'string') continue;
      if (!tagIds[tl.tagId]) bag.warn('ref.dangling', 'tagLogs[' + i + '].tagId', '引用了不存在的标签：' + tl.tagId + '；记录保留，标签名显示为原值');
    }

    /* itemLogs.itemId → settings.focusItems[].id */
    if (Array.isArray(data.itemLogs)) for (i = 0; i < data.itemLogs.length; i++) {
      var il = data.itemLogs[i];
      if (!isPlainObject(il) || typeof il.itemId !== 'string' || il.itemId === '') continue;
      if (!focusIds[il.itemId]) bag.warn('ref.dangling', 'itemLogs[' + i + '].itemId', '引用了不存在的重点：' + il.itemId);
    }

    /* marks.items[].penId → pens.id */
    if (isPlainObject(data.marks)) {
      var mk = Object.keys(data.marks).sort();
      for (i = 0; i < mk.length; i++) {
        var mv = data.marks[mk[i]];
        if (!isPlainObject(mv) || !Array.isArray(mv.items)) continue;
        for (j = 0; j < mv.items.length; j++) {
          var mi = mv.items[j];
          if (!isPlainObject(mi) || typeof mi.penId !== 'string' || mi.penId === '') continue;
          if (!penIds[mi.penId]) bag.warn('ref.dangling', 'marks.' + mk[i] + '.items[' + j + '].penId', '引用了不存在的标记笔：' + mi.penId);
        }
      }
    }

    /* doneSugg 内层键 → suggestions.id */
    if (isPlainObject(data.doneSugg)) {
      var dk = Object.keys(data.doneSugg).sort();
      for (i = 0; i < dk.length; i++) {
        var dv = data.doneSugg[dk[i]];
        if (!isPlainObject(dv)) continue;
        var inner = Object.keys(dv).sort();
        for (j = 0; j < inner.length; j++) {
          if (!suggIds[inner[j]]) bag.warn('ref.dangling', 'doneSugg.' + dk[i] + '.' + inner[j], '引用了不存在的建议：' + inner[j]);
        }
      }
    }

    /* tasks.suggId → suggestions.id：设计文档已确认存在 1 处悬空且原值保留，因此只提示 */
    if (Array.isArray(data.tasks)) for (i = 0; i < data.tasks.length; i++) {
      var t = data.tasks[i];
      if (!isPlainObject(t) || typeof t.suggId !== 'string' || t.suggId === '') continue;
      if (!suggIds[t.suggId]) bag.info('ref.danglingKnown', 'tasks[' + i + '].suggId', '引用了不存在的建议：' + t.suggId + '；按约定原值保留，不做级联删除');
    }
  }

  /* ==================== 迁移预览 ==================== */

  function buildPreview(data, ctx) {
    var counts = ctx.counts || {};
    var mappable = ctx.mappable || {};
    var unmappable = ctx.unmappable || [];

    function m(key) {
      return Object.prototype.hasOwnProperty.call(mappable, key) ? mappable[key] : 0;
    }
    function c(key) {
      return Object.prototype.hasOwnProperty.call(counts, key) ? counts[key] : 0;
    }

    var restMappable = 0;
    if (ctx.rest && typeof ctx.rest.mappable === 'number') restMappable = ctx.rest.mappable;

    var metaPresent = {
      v: Object.prototype.hasOwnProperty.call(data, 'v'),
      settings: isPlainObject(data.settings),
      plugins: Array.isArray(data.plugins)
    };
    var metaRows = 0;
    for (var i = 0; i < META_PAYLOAD_KEYS.length; i++) if (metaPresent[META_PAYLOAD_KEYS[i]]) metaRows++;

    var mapCounts = ctx.mapCounts || {};

    var preview = {
      /* 六张表的预计写入条数：只统计能映射的记录 */
      append: {
        meta: metaRows,
        definitions: m('pens') + m('tags') + m('suggestions'),
        tasks: m('tasks'),
        schedule: m('schedule'),
        dayEntries: m('plans') + m('tagLogs') + m('workouts') + m('studyLogs') + m('decisionLog') + m('flashes') + m('itemLogs') + restMappable,
        dayMaps: (mapCounts.notes || 0) + (mapCounts.marks || 0) + (mapCounts.doneSugg || 0)
      },
      /* 原始条数，用于和 append 对照，差值是「无法映射」的数量 */
      sourceCounts: {
        definitions: c('pens') + c('tags') + c('suggestions'),
        tasks: c('tasks'),
        schedule: c('schedule'),
        dayEntries: c('plans') + c('tagLogs') + c('workouts') + c('studyLogs') + c('decisionLog') + c('flashes') + c('itemLogs') + (ctx.rest ? ctx.rest.count : 0),
        dayMaps: (mapCounts.notes || 0) + (mapCounts.marks || 0) + (mapCounts.doneSugg || 0)
      },
      meta: {
        payloadKeys: META_PAYLOAD_KEYS.slice(),
        payloadPresent: metaPresent,
        infraKeys: META_INFRA_KEYS.slice(),
        infraPlanned: {
          schemaVersion: SCHEMA_VERSION,
          bizDatePolicy: { mode: 'legacy', note: '历史日期原样保留，不重算' }
        },
        preNormalize: {
          planned: true,
          note: 'normalize() 之前先存 meta.preNormalize.raw，保留原始字符串'
        }
      },
      unmappable: unmappable.slice(),
      unmappableCount: unmappable.length,
      risks: []
    };

    /* 风险清单：只写「确实会影响迁移结果」的，不写套话 */
    var fatals = 0;
    var rows = ctx.issues || [];
    for (var r = 0; r < rows.length; r++) if (rows[r].level === 'fatal') fatals++;
    if (fatals > 0) {
      preview.risks.push({ code: 'has-fatal', message: '存在 ' + fatals + ' 条致命问题，对应记录无法写入或会互相覆盖；见 issues' });
    }
    if (unmappable.length > 0) {
      preview.risks.push({ code: 'unmappable', message: unmappable.length + ' 条记录无法映射到主键，迁移时会被跳过' });
    }
    if (preview.append.dayEntries !== preview.sourceCounts.dayEntries) {
      preview.risks.push({
        code: 'dayEntries-gap',
        message: 'dayEntries 原始 ' + preview.sourceCounts.dayEntries + ' 条，可写入 ' + preview.append.dayEntries + ' 条，差额 ' +
          (preview.sourceCounts.dayEntries - preview.append.dayEntries) + ' 条'
      });
    }
    if (!metaPresent.settings) {
      preview.risks.push({ code: 'no-settings', message: 'settings 缺失或类型不对，meta.settings 将写入默认值' });
    }

    return preview;
  }

  /* ==================== 主流程 ==================== */

  function emptyResult(status, statusText, read, extra) {
    var out = {
      readOnly: true,
      key: KEY,
      status: status,
      statusText: statusText,
      source: read.source,
      storageAvailable: read.available,
      present: read.present,
      legacyV3Found: !!read.legacyFound,
      bytes: read.bytes || 0,
      characters: read.raw === null || read.raw === undefined ? 0 : read.raw.length,
      sha256: null,
      sha256Supported: null,
      dataVersion: null,
      schemaVersion: SCHEMA_VERSION,
      counts: {},
      totals: { records: 0, mappable: 0, unmappable: 0 },
      issues: [],
      issueCount: { fatal: 0, warn: 0, info: 0 },
      unknownTopLevel: [],
      preview: null
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
    return out;
  }

  /* 核心：输入原始字符串，输出确定性报告。不传 options.raw 时从 localStorage 读 */
  function inspect(options) {
    options = options || {};
    var injected = Object.prototype.hasOwnProperty.call(options, 'raw');
    var read;

    if (injected) {
      var r = options.raw;
      read = {
        available: true, present: r !== null && r !== undefined,
        raw: r === null || r === undefined ? null : String(r),
        bytes: r === null || r === undefined ? 0 : utf8Bytes(String(r)),
        error: null, legacyFound: false, source: 'injected'
      };
    } else {
      read = readRaw();
      read.source = 'localStorage';
    }

    if (read.error) {
      return Promise.resolve(emptyResult('storage-unavailable', 'localStorage 不可用：' + read.error, read));
    }
    if (!read.present) {
      var absent = emptyResult('absent', read.legacyV3Found
        ? '当前没有 v4 数据；检测到 v3 老数据，需先由 loadState() 迁移'
        : '当前设备没有这个应用的数据', read);
      return Promise.resolve(absent);
    }
    if (read.raw === '') {
      return Promise.resolve(emptyResult('empty', '数据键存在但内容是空字符串', read));
    }

    var parsed;
    try {
      parsed = JSON.parse(read.raw);
    } catch (e) {
      return Promise.resolve(emptyResult('invalid-json', 'JSON 解析失败：' + ((e && e.message) || '未知错误'), read));
    }
    if (!isPlainObject(parsed)) {
      return Promise.resolve(emptyResult('not-object', '解析结果不是对象（是 ' + kindOf(parsed) + '），不是有效存档', read, {
        dataVersion: isNum(parsed) ? parsed : null
      }));
    }

    return sha256(read.raw).then(function (hash) {
      var bag = new IssueBag();

      var extraTop = validateTop(parsed, bag);
      var rec = validateRecords(parsed, bag);
      var rest = validateRestDays(parsed, bag, rec.unmappable);
      var maps = validateMaps(parsed, bag);
      var settings = validateSettings(parsed, bag);

      validateRefs(parsed, { focusIds: settings.focusIds }, bag);

      var issues = bag.sorted();
      var issueCount = bag.counts();

      var totalRecords = 0, totalMappable = 0;
      for (var k in rec.counts) if (Object.prototype.hasOwnProperty.call(rec.counts, k)) totalRecords += rec.counts[k];
      for (k in rec.mappable) if (Object.prototype.hasOwnProperty.call(rec.mappable, k)) totalMappable += rec.mappable[k];
      totalRecords += rest.count;
      totalMappable += rest.mappable;

      var preview = buildPreview(parsed, {
        counts: rec.counts, mappable: rec.mappable, unmappable: rec.unmappable,
        rest: rest, mapCounts: maps.counts, issues: issues
      });

      var countsOut = {};
      for (k in rec.counts) if (Object.prototype.hasOwnProperty.call(rec.counts, k)) countsOut[k] = rec.counts[k];
      countsOut.restDays = rest.count;
      countsOut.notes = maps.counts.notes || 0;
      countsOut.marks = maps.counts.marks || 0;
      countsOut.doneSugg = maps.counts.doneSugg || 0;

      return {
        readOnly: true,
        key: KEY,
        status: 'usable',
        statusText: '可读取并预览',
        source: read.source,
        storageAvailable: read.available,
        present: true,
        legacyV3Found: false,
        bytes: read.bytes,
        characters: read.raw.length,
        sha256: hash.hex,
        sha256Supported: hash.supported,
        dataVersion: isNum(parsed.v) ? parsed.v : null,
        schemaVersion: SCHEMA_VERSION,
        counts: countsOut,
        totals: {
          records: totalRecords,
          mappable: totalMappable,
          unmappable: rec.unmappable.length
        },
        issues: issues,
        issueCount: issueCount,
        unknownTopLevel: extraTop,
        preview: preview
      };
    });
  }

  /* 同步取原始串：给测试与调试用，永远不写 */
  function snapshot() {
    var r = readRaw();
    return {
      available: r.available,
      present: r.present,
      raw: r.raw,
      bytes: r.bytes,
      error: r.error,
      legacyV3Found: r.legacyFound
    };
  }

  var api = {
    KEY: KEY,
    OLD_KEY: OLD_KEY,
    EXPECTED_V: EXPECTED_V,
    SCHEMA_VERSION: SCHEMA_VERSION,
    TOP_ORDER: TOP_ORDER.slice(),
    ID_ARRAYS: ID_ARRAYS.slice(),
    META_PAYLOAD_KEYS: META_PAYLOAD_KEYS.slice(),
    META_INFRA_KEYS: META_INFRA_KEYS.slice(),
    inspect: inspect,
    snapshot: snapshot,
    /* 供测试复用的纯函数，不产生副作用 */
    isDate: isDate,
    isTime: isTime,
    utf8Bytes: utf8Bytes
  };

  global.OLLegacy = api;
})(typeof window !== 'undefined' ? window : this);
