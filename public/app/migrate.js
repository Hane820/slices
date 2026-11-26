/* migrate.js — 一次性迁移机制（干跑 + 受保护写入）
 *
 * 两层：
 *   1) 纯内存干跑 dryRun()：读原始串 → OLLegacy.inspect() 校验 → 自己解析成 S0
 *      → 确定性映射成六表行 → 主键冲突 / 非法日期 / 数量交叉核对
 *      —— 不创建数据库、不写 localStorage、不调 normalize()
 *   2) 受保护写入 run()：外部标记 pending → IDB 认领租约 → 单事务（清表 + 写 preNormalize
 *      + 写六表 + 结迁移锁 + 装写入权）→ 标记 done → 只读复验
 *
 * 硬约束：
 *   - run() 必须显式传 {confirm:true}，否则直接拒绝；不自动启动
 *   - 干跑不通过（fatal / 主键冲突 / 数量不符 / 无指纹）一律禁止写入
 *   - 事务内第一条 await 必须是 assertMigrationLease()
 *   - meta 只按精确白名单操作，不做前缀匹配
 *   - 未知顶层字段原样存 meta.legacyExtras（不进业务表，也不丢）
 *   - 写入权：assertWriteLease / renewWriteLease 只提供能力，不接 save()、不自动启动
 *   - Step 5B T2：writerEpochFloor 参与代次判定；新增纯校验器与只读状态能力，
 *     租约最终有效性仍必须在未来的业务 rw 事务内部校验，本阶段不开放业务写入
 *   - 不调用 save() / normalize() / loadState()，不碰全局 S
 *   - localStorage['earthonline-v4'] 原样保留，只写独立的 earthonline-v4-migrated
 *
 * 依赖：vendor/dexie.min.js → db.js（OLDB）→ legacy.js（OLLegacy）→ 本文件
 */
(function (global) {
  'use strict';

  var KEY = 'earthonline-v4';
  var MARKER_KEY = 'earthonline-v4-migrated';
  var LOCK_KEY = 'earthonline-v4-migrate-lock';
  var SCHEMA_VERSION = 1;
  var MIGRATION_LEASE_TTL = 20000;
  var MIGRATION_HEARTBEAT_MS = 5000;
  var WRITE_TTL = 30000;
  var MAX_ATTEMPTS = 5;

  /* 业务 writer 的代次：epoch 从 1 起，只能严格递增。
     writerEpochFloor 存 meta.migration，是本轮迁移之后合法 epoch 的下界；
     旧库没有该字段时按 0 兼容（epoch 1 天然合法），已有 0 也不需要数据迁移。 */
  var WRITER_EPOCH_MIN = 1;
  var WRITER_FLOOR_DEFAULT = 0;

  var TABLE_NAMES = ['meta', 'definitions', 'tasks', 'schedule', 'dayEntries', 'dayMaps'];
  var BUSINESS_TABLES = ['definitions', 'tasks', 'schedule', 'dayEntries', 'dayMaps'];
  var PAYLOAD_KEYS = ['v', 'settings', 'plugins'];
  var EXTRAS_KEY = 'legacyExtras';

  /* 19 个顶层字段，与 legacy.js 的 TOP_ORDER / core.js 的 defaults() 逐一对应。
     不在此列 = 未知顶层字段，写入 meta.legacyExtras，绝不丢弃。 */
  var TOP_KEYS = [
    'v', 'tasks', 'schedule', 'plans', 'notes', 'marks', 'pens', 'tags', 'tagLogs',
    'suggestions', 'doneSugg', 'workouts', 'studyLogs', 'decisionLog', 'restDays',
    'flashes', 'itemLogs', 'meals', 'scenes', 'plugins', 'settings'
  ];

  /* 重迁移时先清的业务载荷：三个原始载荷 + legacyExtras（它由源数据派生） */
  var CLEARED_KEYS = PAYLOAD_KEYS.concat([EXTRAS_KEY]);

  /* meta 精确白名单。新增 key 必须显式改这里，不接受前缀/正则通配。 */
  var META_ALLOWED = {
    v: 'payload', settings: 'payload', plugins: 'payload', legacyExtras: 'payload',
    schemaVersion: 'infra', migration: 'infra', writer: 'infra',
    preNormalize: 'infra', bizDatePolicy: 'infra', bizRev: 'infra'
  };

  var DEF_MAP = [
    { src: 'pens', kind: 'pen' },
    { src: 'tags', kind: 'tag' },
    { src: 'suggestions', kind: 'suggestion' },
    { src: 'scenes', kind: 'scene' }
  ];
  var ENTRY_MAP = [
    { src: 'plans', type: 'plan' },
    { src: 'tagLogs', type: 'tagLog' },
    { src: 'workouts', type: 'workout' },
    { src: 'studyLogs', type: 'studyLog' },
    { src: 'decisionLog', type: 'decision' },
    { src: 'flashes', type: 'flash' },
    { src: 'itemLogs', type: 'itemLog' },
    { src: 'meals', type: 'meal' }
  ];
  var MAP_KINDS = [
    { src: 'notes', kind: 'note' },
    { src: 'marks', kind: 'mark' },
    { src: 'doneSugg', kind: 'doneSugg' }
  ];

  /* ==================== 基础 ==================== */

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function has(obj, k) {
    return Object.prototype.hasOwnProperty.call(obj, k);
  }

  /* 显式建自有属性。普通 obj[k] = v 在 k === '__proto__' 时会走原型 setter：
     字段丢失、且把值挂成原型（污染）。JSON.parse 出来的对象可以带 __proto__ 自有属性，
     所以凡是从外部数据复制键的地方都必须走这里。 */
  function defineOwn(obj, key, value) {
    Object.defineProperty(obj, key, { value: value, enumerable: true, writable: true, configurable: true });
  }

  /* 有限数值的截止时间。NaN / Infinity 参与比较时不报错：
     NaN < now 为 false（会放行），Infinity < now 也为 false（会永久占锁）。 */
  function usableDeadline(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /* epoch 必须是有限正整数。NaN / Infinity / 小数 / 0 / 负数 / 字符串一律不合法。 */
  function isWriterEpoch(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= WRITER_EPOCH_MIN;
  }

  /* 代次下界的读取与判定。三种情况严格区分，避免「静默归零让旧 epoch 复活」：
       - migration 行缺失       → 失败关闭（无法证明下界）
       - 行在、字段缺失         → 兼容旧库，取 0
       - 字段在但值损坏 / 非法  → 失败关闭，不猜、不修复 */
  function readWriterEpochFloor(m) {
    if (!m || !isPlainObject(m)) {
      return { ok: false, present: false, value: null, code: 'writer-floor-row-missing',
        message: '迁移记录缺失，无法确认 writer epoch 下界' };
    }
    if (!has(m, 'writerEpochFloor')) {
      return { ok: true, present: false, value: WRITER_FLOOR_DEFAULT,
        code: 'ok', message: '旧库无下界字段，按 0 兼容' };
    }
    var f = m.writerEpochFloor;
    if (typeof f !== 'number' || !isFinite(f) || Math.floor(f) !== f || f < 0) {
      return { ok: false, present: true, value: null, code: 'writer-floor-invalid',
        message: 'writer epoch 下界不是非负有限整数：' + String(f) };
    }
    return { ok: true, present: true, value: f, code: 'ok', message: '' };
  }

  /* 唯一允许提升 epoch 的规则：新代次必须同时 > 当前代次且 >= floor。
     续期 / 心跳不调用本函数，因此不会提升代次；接管与重迁移必须调用它。 */
  function nextWriterEpoch(curEpoch, floor) {
    var base = isWriterEpoch(curEpoch) ? curEpoch : 0;
    var f = (typeof floor === 'number' && isFinite(floor) && floor >= 0)
      ? Math.floor(floor) : WRITER_FLOOR_DEFAULT;
    return Math.max(WRITER_EPOCH_MIN, f, base + 1);
  }

  /* writer 行体检（纯函数，同步，不含调用方身份判定、不发起任何异步操作）。
     固定顺序：存在 → 状态 → epoch 合法 → epoch 不低于 floor → 有效期合法 → 未过期。 */
  function inspectWriterRow(w, floor, now) {
    var out = {
      present: !!w,
      status: w && w.status !== undefined ? w.status : null,
      ownerId: w && w.ownerId !== undefined ? w.ownerId : null,
      epoch: w && w.epoch !== undefined ? w.epoch : null,
      heartbeatAt: w && w.heartbeatAt !== undefined ? w.heartbeatAt : null,
      leaseExpiresAt: w && w.leaseExpiresAt !== undefined ? w.leaseExpiresAt : null,
      epochValid: false, leaseValid: false, remainingMs: null, belowFloor: false,
      floor: typeof floor === 'number' ? floor : null,
      ok: false, code: 'writer-missing', message: '没有写入权记录'
    };
    if (!w) return out;
    if (w.status !== 'active') {
      out.code = 'writer-inactive'; out.message = '写入权状态不是 active：' + String(w.status); return out;
    }
    if (!isWriterEpoch(w.epoch)) {
      out.code = 'writer-epoch-invalid'; out.message = '写入权 epoch 非法：' + String(w.epoch); return out;
    }
    out.epochValid = true;
    if (typeof floor === 'number' && isFinite(floor) && w.epoch < floor) {
      out.belowFloor = true;
      out.code = 'writer-epoch-below-floor';
      out.message = '写入权 epoch ' + w.epoch + ' 低于合法下界 ' + floor;
      return out;
    }
    if (!usableDeadline(w.leaseExpiresAt)) {
      out.code = 'writer-lease-invalid';
      out.message = '写入权有效期不是有限数值：' + String(w.leaseExpiresAt); return out;
    }
    out.leaseValid = true;
    out.remainingMs = w.leaseExpiresAt - now;
    if (out.remainingMs <= 0) {
      out.code = 'writer-lease-expired'; out.message = '写入权租约已过期'; return out;
    }
    out.ok = true; out.code = 'ok'; out.message = '';
    return out;
  }

  /* 事务级租约判定（纯函数、同步、不抛错）：把身份、行、代次下界、时间算成一份结论。
     checkWriteLeaseInTx 在业务 rw 事务内调用它并按需抛错；只读状态查询直接取结果。 */
  function evaluateWriterLease(w, m, ownerId, epoch, now) {
    var out = {
      ok: false, code: '', message: '', leaseKind: 'writer', statusOnly: false,
      ownerId: ownerId === undefined ? null : ownerId,
      epoch: epoch === undefined ? null : epoch,
      floor: null, checkedAt: now, writer: null
    };
    function fail(code, message) { out.code = code; out.message = message; return out; }

    if (typeof ownerId !== 'string' || !ownerId) {
      return fail('writer-identity-invalid', '写入身份不是非空字符串');
    }
    if (!isWriterEpoch(epoch)) {
      return fail('writer-epoch-invalid', '调用方 epoch 非法：' + String(epoch));
    }
    var f = readWriterEpochFloor(m);
    if (!f.ok) return fail(f.code, f.message);
    out.floor = f.value;

    var h = inspectWriterRow(w, f.value, now);
    out.writer = h;
    if (!h.ok) return fail(h.code, h.message);
    if (w.ownerId !== ownerId) {
      return fail('writer-owner-changed', '写入权已被其它标签页接管');
    }
    if (w.epoch !== epoch) {
      return fail('writer-epoch-changed', '写入权 epoch 不匹配');
    }
    out.ok = true; out.code = 'ok';
    return out;
  }

  /* 续期只延长租约：身份、状态与 epoch 逐字保留，其余字段也不丢。
     心跳与同一 writer 的续期都只能构造这种行，因此不会提升代次。 */
  function buildRenewedWriterRow(w, now) {
    var out = shallow(w);
    out.heartbeatAt = now;
    out.leaseExpiresAt = now + WRITE_TTL;
    return out;
  }

  function shallow(rec) {
    var out = {};
    for (var k in rec) if (has(rec, k)) defineOwn(out, k, rec[k]);
    return out;
  }

  function isDate(s) {
    if (typeof s !== 'string' || s.length !== 10) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
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

  function sha256(text) {
    var subtle = global.crypto && global.crypto.subtle;
    if (!subtle || typeof global.TextEncoder !== 'function') {
      return Promise.resolve({ supported: false, hex: null });
    }
    try {
      var buf = new global.TextEncoder().encode(text);
      return subtle.digest('SHA-256', buf).then(function (ab) {
        var b = new Uint8Array(ab), hex = '';
        for (var i = 0; i < b.length; i++) hex += ('0' + b[i].toString(16)).slice(-2);
        return { supported: true, hex: hex };
      }, function () { return { supported: true, hex: null }; });
    } catch (e) {
      return Promise.resolve({ supported: false, hex: null });
    }
  }

  /* 规范化序列化：键排序；含 id 的数组按 id 排序。只用于算 sourceDigest。 */
  function canonicalize(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) {
      var allId = v.length > 0, i;
      for (i = 0; i < v.length; i++) {
        if (!v[i] || typeof v[i] !== 'object' || typeof v[i].id !== 'string') { allId = false; break; }
      }
      var items = [];
      for (i = 0; i < v.length; i++) items.push(canonicalize(v[i]));
      if (allId) items.sort();
      return '[' + items.join(',') + ']';
    }
    var keys = Object.keys(v).sort();
    var parts = [];
    for (var k = 0; k < keys.length; k++) parts.push(JSON.stringify(keys[k]) + ':' + canonicalize(v[keys[k]]));
    return '{' + parts.join(',') + '}';
  }

  function newOwnerId() {
    try {
      if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    } catch (e) {}
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /* 迁移租约：ownerId/epoch 来自 claimOwner，TTL = MIGRATION_LEASE_TTL，
     心跳由 startMigrationHeartbeat 驱动，事务结束即停止。 */
  function leaseError(code, message) {
    var err = new Error(message || code);
    err.name = 'MigrationLeaseLost';
    err.code = code;
    err.leaseKind = 'migration';
    return err;
  }

  function isAllowedMetaKey(key) {
    return has(META_ALLOWED, key);
  }

  /* ==================== 映射：S0 → 六表行（纯函数） ==================== */

  function setRoute(row, field, value, sink, src) {
    if (has(row, field) && row[field] !== value) {
      sink.push({
        level: 'warn', code: 'route.overwritten', path: src,
        message: '记录自带 ' + field + ' 字段（' + JSON.stringify(row[field]) + '），被路由值 ' +
          JSON.stringify(value) + ' 覆盖；原值不再保留'
      });
    }
    row[field] = value;
  }

  function buildRows(S0) {
    var rows = { meta: [], definitions: [], tasks: [], schedule: [], dayEntries: [], dayMaps: [] };
    var issues = [];
    var i, j;

    if (has(S0, 'v')) rows.meta.push({ key: 'v', value: S0.v });
    if (isPlainObject(S0.settings)) rows.meta.push({ key: 'settings', value: shallow(S0.settings) });
    if (Array.isArray(S0.plugins)) rows.meta.push({ key: 'plugins', value: S0.plugins.slice() });

    /* 未知顶层字段：键与值原样收进 meta.legacyExtras。
       不删、不改、不进五张业务表，也不计入六表条数（Step 3 预览只算三个载荷）。 */
    var extraKeys = [];
    var extraVal = {};
    var allTop = Object.keys(S0).sort();
    for (i = 0; i < allTop.length; i++) {
      if (TOP_KEYS.indexOf(allTop[i]) < 0) {
        extraKeys.push(allTop[i]);
        defineOwn(extraVal, allTop[i], S0[allTop[i]]);
      }
    }
    rows.extras = { present: extraKeys.length > 0, keys: extraKeys, value: extraVal };

    for (i = 0; i < DEF_MAP.length; i++) {
      var dm = DEF_MAP[i];
      var darr = S0[dm.src];
      if (!Array.isArray(darr)) continue;
      for (j = 0; j < darr.length; j++) {
        if (!isPlainObject(darr[j])) continue;
        var drow = shallow(darr[j]);
        setRoute(drow, 'kind', dm.kind, issues, dm.src + '[' + j + ']');
        rows.definitions.push(drow);
      }
    }

    if (Array.isArray(S0.tasks)) {
      for (i = 0; i < S0.tasks.length; i++) if (isPlainObject(S0.tasks[i])) rows.tasks.push(shallow(S0.tasks[i]));
    }
    if (Array.isArray(S0.schedule)) {
      for (i = 0; i < S0.schedule.length; i++) if (isPlainObject(S0.schedule[i])) rows.schedule.push(shallow(S0.schedule[i]));
    }

    for (i = 0; i < ENTRY_MAP.length; i++) {
      var em = ENTRY_MAP[i];
      var earr = S0[em.src];
      if (!Array.isArray(earr)) continue;
      for (j = 0; j < earr.length; j++) {
        if (!isPlainObject(earr[j])) continue;
        var erow = shallow(earr[j]);
        setRoute(erow, 'type', em.type, issues, em.src + '[' + j + ']');
        rows.dayEntries.push(erow);
      }
    }
    if (Array.isArray(S0.restDays)) {
      for (i = 0; i < S0.restDays.length; i++) {
        var rd = S0.restDays[i];
        if (typeof rd !== 'string') continue;
        rows.dayEntries.push({ type: 'restDay', id: rd, date: rd });
      }
    }

    for (i = 0; i < MAP_KINDS.length; i++) {
      var mk = MAP_KINDS[i];
      var mobj = S0[mk.src];
      if (!isPlainObject(mobj)) continue;
      var keys = Object.keys(mobj);
      for (j = 0; j < keys.length; j++) {
        rows.dayMaps.push({ kind: mk.kind, date: keys[j], value: mobj[keys[j]] });
      }
    }

    return { rows: rows, issues: issues };
  }

  /* ==================== 主键冲突 ==================== */

  function checkConflicts(rows) {
    var out = [];
    var seen, k, i;

    seen = {};
    for (i = 0; i < rows.meta.length; i++) {
      k = rows.meta[i].key;
      if (seen[k]) out.push({ table: 'meta', mainKey: k, reason: 'duplicate-key' });
      seen[k] = true;
    }

    seen = {};
    for (i = 0; i < rows.definitions.length; i++) {
      k = rows.definitions[i].kind + '/' + rows.definitions[i].id;
      if (seen[k]) out.push({ table: 'definitions', mainKey: k, reason: 'duplicate-key' });
      seen[k] = true;
    }

    seen = {};
    for (i = 0; i < rows.tasks.length; i++) {
      k = rows.tasks[i].id;
      if (seen[k]) out.push({ table: 'tasks', mainKey: k, reason: 'duplicate-key' });
      seen[k] = true;
    }

    seen = {};
    for (i = 0; i < rows.schedule.length; i++) {
      k = rows.schedule[i].id;
      if (seen[k]) out.push({ table: 'schedule', mainKey: k, reason: 'duplicate-key' });
      seen[k] = true;
    }

    seen = {};
    for (i = 0; i < rows.dayEntries.length; i++) {
      k = rows.dayEntries[i].type + '/' + rows.dayEntries[i].id;
      if (seen[k]) out.push({ table: 'dayEntries', mainKey: k, reason: 'duplicate-key' });
      seen[k] = true;
    }

    seen = {};
    for (i = 0; i < rows.dayMaps.length; i++) {
      k = rows.dayMaps[i].kind + '/' + rows.dayMaps[i].date;
      if (seen[k]) out.push({ table: 'dayMaps', mainKey: k, reason: 'duplicate-key' });
      seen[k] = true;
    }

    return out;
  }

  /* 非法日期键：保留原始键与值，只记录，不改写、不丢弃、不当作合法业务日期 */
  function collectBadDates(rows) {
    var out = [], i;
    for (i = 0; i < rows.dayMaps.length; i++) {
      var dm = rows.dayMaps[i];
      if (!isDate(dm.date)) out.push({ table: 'dayMaps', kind: dm.kind, date: dm.date, reason: 'invalid-date-key' });
    }
    for (i = 0; i < rows.dayEntries.length; i++) {
      var de = rows.dayEntries[i];
      if (de.type === 'restDay') {
        if (!isDate(de.id)) out.push({ table: 'dayEntries', type: 'restDay', date: de.id, reason: 'invalid-date-key' });
        continue;
      }
      if (typeof de.date === 'string' && de.date !== '' && !isDate(de.date)) {
        out.push({ table: 'dayEntries', type: de.type, id: de.id, date: de.date, reason: 'invalid-date' });
      }
    }
    return out;
  }

  /* ==================== 干跑 ==================== */

  function emptyPlan(reason, detail, extra) {
    var p = {
      ok: false,
      reason: reason,
      blocked: [{ code: reason, message: detail || reason }],
      warnings: [],
      conflicts: [],
      badDates: [],
      counts: null,
      expected: null,
      diff: [],
      rows: null,
      source: null
    };
    if (extra) for (var k in extra) if (has(extra, k)) p[k] = extra[k];
    return p;
  }

  function readRaw(options) {
    if (has(options, 'raw')) {
      return options.raw === null || options.raw === undefined ? null : String(options.raw);
    }
    try { return global.localStorage.getItem(KEY); } catch (e) { return { error: String((e && e.message) || e) }; }
  }

  function dryRun(options) {
    options = options || {};

    return Promise.resolve().then(function () {
      if (!global.OLLegacy || typeof global.OLLegacy.inspect !== 'function') {
        return emptyPlan('legacy-module-missing', 'OLLegacy 未加载，无法读取旧数据');
      }

      var raw = readRaw(options);
      if (raw && typeof raw === 'object' && raw.error) return emptyPlan('source-read-failed', raw.error);
      if (raw === null) return emptyPlan('no-source', '没有可迁移的数据（存储键不存在）');
      if (raw === '') return emptyPlan('source-empty', '存储键存在但内容为空');

      return global.OLLegacy.inspect({ raw: raw }).then(function (rep) {
        if (!rep || rep.status !== 'usable') {
          return emptyPlan('source-not-usable', '旧数据状态为 ' + (rep && rep.status) + '：' + ((rep && rep.statusText) || '不可读取'), { source: rep ? { status: rep.status } : null });
        }
        if (rep.issueCount && rep.issueCount.fatal > 0) {
          return emptyPlan('source-has-fatal', '旧数据存在 ' + rep.issueCount.fatal + ' 条致命问题，禁止写入', {
            warnings: rep.issues || [],
            source: { status: rep.status, sha256: rep.sha256, bytes: rep.bytes, characters: rep.characters, dataVersion: rep.dataVersion }
          });
        }

        var parsed;
        try { parsed = JSON.parse(raw); } catch (e) { return emptyPlan('source-parse-failed', String((e && e.message) || e)); }
        if (!isPlainObject(parsed)) return emptyPlan('source-not-object', '解析结果不是对象');

        return sha256(raw).then(function (h) {
          var built = buildRows(parsed);
          var conflicts = checkConflicts(built.rows);
          var badDates = collectBadDates(built.rows);

          var counts = {
            meta: built.rows.meta.length,
            definitions: built.rows.definitions.length,
            tasks: built.rows.tasks.length,
            schedule: built.rows.schedule.length,
            dayEntries: built.rows.dayEntries.length,
            dayMaps: built.rows.dayMaps.length
          };

          var expected = rep.preview ? rep.preview.append : null;
          var diff = [];
          if (expected) {
            for (var k in counts) {
              if (has(counts, k) && expected[k] !== counts[k]) diff.push({ table: k, expected: expected[k], actual: counts[k] });
            }
          }

          var blocked = [];
          if (conflicts.length) blocked.push({ code: 'primary-key-conflict', message: '存在 ' + conflicts.length + ' 处主键冲突，写入会互相覆盖' });
          if (diff.length) {
            blocked.push({
              code: 'count-mismatch',
              message: '六表条数与 Step 3 预览不一致：' + diff.map(function (d) { return d.table + ' ' + d.expected + '→' + d.actual; }).join('、')
            });
          }
          if (!h.hex) blocked.push({ code: 'digest-unavailable', message: '当前环境算不出 SHA-256（非安全上下文），无法建立可核对的来源指纹' });

          var warnings = (rep.issues || []).concat(built.issues);
          if (built.rows.extras.present) {
            warnings.push({
              level: 'info', code: 'extras.preserved', path: built.rows.extras.keys.join(','),
              message: '有 ' + built.rows.extras.keys.length + ' 个未知顶层字段，将原样存入 meta.legacyExtras（不进业务表）'
            });
          }
          if (badDates.length) {
            var kinds = {};
            for (var b = 0; b < badDates.length; b++) kinds[badDates[b].kind || badDates[b].type] = true;
            warnings.push({
              level: 'warn', code: 'date.invalid-key', path: Object.keys(kinds).sort().join(','),
              message: '有 ' + badDates.length + ' 个日期字段不是合法 YYYY-MM-DD；原键与原值保留，但不会被当作合法业务日期'
            });
          }

          return {
            ok: blocked.length === 0,
            reason: blocked.length ? blocked[0].code : 'ready',
            blocked: blocked,
            warnings: warnings,
            conflicts: conflicts,
            badDates: badDates,
            counts: counts,
            expected: expected,
            diff: diff,
            rows: built.rows,
            extras: built.rows.extras,
            source: {
              status: rep.status,
              sha256: h.hex,
              supported: h.supported,
              bytes: rep.bytes,
              characters: rep.characters,
              dataVersion: rep.dataVersion
            }
          };
        });
      });
    });
  }

  /* ==================== 读取回灌（Step 5A） ==================== */

  /* 自然序比较：'p2' < 'p10'。用于把按主键读回的行恢复成接近创建顺序 */
  function cmpNat(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  /* 剥离迁移时注入的路由字段（DEF_MAP 的 kind / ENTRY_MAP 的 type）。
     旧数据结构里没有任何数组记录自带这两个字段名；若真有，
     迁移时的 route.overwritten 警告已经记录过原值丢失。 */
  function stripRoute(row, field) {
    delete row[field];
    return row;
  }

  /* 六表行 → S 形对象（逆向 buildRows）。只读，不改表。 */
  function buildStateFromRows(metaRows, defRows, taskRows, schedRows, entryRows, mapRows) {
    var d = {};
    var out = { ok: true, data: d, extras: null, meta: {}, counts: {} };
    var i, row, k;

    out.counts.meta = metaRows.length;
    for (i = 0; i < metaRows.length; i++) {
      row = metaRows[i];
      if (row.key === 'v') d.v = row.value;
      else if (row.key === 'settings') d.settings = row.value;
      else if (row.key === 'plugins') d.plugins = row.value;
      else if (row.key === EXTRAS_KEY) out.extras = { keys: (row.keys || []).slice(), value: row.value };
      else if (row.key === 'schemaVersion') out.meta.schemaVersion = row.value;
      else if (row.key === 'migration') out.meta.migrationStatus = row.status;
      else if (row.key === 'preNormalize') out.meta.preNormalize = { sha256: row.sha256, bytes: row.bytes };
      /* 5B-5-R：同事务读取 bizRev，供恢复凭据与重建基线绑定 */
      else if (row.key === 'bizRev') out.meta.bizRev = typeof row.value === 'number' ? row.value : null;
    }

    /* definitions → pens / tags / suggestions */
    defRows.sort(function (a, b) { return cmpNat(a.id, b.id); });
    var defBuckets = { pen: [], tag: [], suggestion: [], scene: [] };
    for (i = 0; i < defRows.length; i++) {
      row = defRows[i];
      if (defBuckets[row.kind]) defBuckets[row.kind].push(stripRoute(row, 'kind'));
    }
    d.pens = defBuckets.pen;
    d.tags = defBuckets.tag;
    d.suggestions = defBuckets.suggestion;
    /* 情境：用户可自定义显示顺序（order 字段），按 order 还原，不按 id 字典序 */
    d.scenes = defBuckets.scene.slice().sort(function (a, b) {
      return (+a.order || 0) - (+b.order || 0) || cmpNat(a.id, b.id);
    });

    /* tasks：创建时间优先，其次 id 自然序（主键序 't10' 会排到 't2' 前面） */
    taskRows.sort(function (a, b) {
      var ca = +a.createdAt || 0, cb = +b.createdAt || 0;
      if (ca !== cb) return ca - cb;
      return cmpNat(a.id, b.id);
    });
    d.tasks = taskRows;
    out.counts.tasks = taskRows.length;

    schedRows.sort(function (a, b) { return cmpNat(a.id, b.id); });
    d.schedule = schedRows;
    out.counts.schedule = schedRows.length;

    /* dayEntries → 七类记录 + restDays */
    var entryBuckets = {
      plan: [], tagLog: [], workout: [], studyLog: [],
      decision: [], flash: [], itemLog: [], meal: [], restDay: []
    };
    for (i = 0; i < entryRows.length; i++) {
      row = entryRows[i];
      if (!entryBuckets[row.type]) continue;
      if (row.type === 'restDay') entryBuckets.restDay.push(String(row.date || ''));
      else entryBuckets[row.type].push(stripRoute(row, 'type'));
    }
    d.plans = entryBuckets.plan;
    d.tagLogs = entryBuckets.tagLog;
    d.workouts = entryBuckets.workout;
    d.studyLogs = entryBuckets.studyLog;
    d.decisionLog = entryBuckets.decision;
    d.flashes = entryBuckets.flash;
    d.itemLogs = entryBuckets.itemLog;
    d.meals = entryBuckets.meal;
    d.restDays = entryBuckets.restDay;
    out.counts.dayEntries = entryRows.length;

    /* dayMaps → notes / marks / doneSugg（键即原始日期键，非法键原样还原） */
    d.notes = {}; d.marks = {}; d.doneSugg = {};
    for (i = 0; i < mapRows.length; i++) {
      row = mapRows[i];
      if (row.kind === 'note') d.notes[row.date] = row.value;
      else if (row.kind === 'mark') d.marks[row.date] = row.value;
      else if (row.kind === 'doneSugg') d.doneSugg[row.date] = row.value;
    }
    out.counts.dayMaps = mapRows.length;

    return out;
  }

  /* 从已打开的数据库读回全部业务数据。单读事务，不写任何东西。 */
  function rehydrate() {
    var db = global.OLDB && typeof global.OLDB.instance === 'function' ? global.OLDB.instance() : null;
    if (!db) return Promise.resolve({ ok: false, reason: 'db-not-open', message: '数据库尚未打开' });

    return db.transaction('r', db.meta, db.definitions, db.tasks, db.schedule, db.dayEntries, db.dayMaps, function () {
      return db.meta.toArray()
        .then(function (m) { return db.definitions.toArray().then(function (x) { return [m, x]; }); })
        .then(function (r) { return db.tasks.toArray().then(function (x) { return [r[0], r[1], x]; }); })
        .then(function (r) { return db.schedule.toArray().then(function (x) { return [r[0], r[1], r[2], x]; }); })
        .then(function (r) { return db.dayEntries.toArray().then(function (x) { return [r[0], r[1], r[2], r[3], x]; }); })
        .then(function (r) { return db.dayMaps.toArray().then(function (x) { return [r[0], r[1], r[2], r[3], r[4], x]; }); });
    }).then(function (all) {
      var rep = buildStateFromRows(all[0], all[1], all[2], all[3], all[4], all[5]);
      rep.meta.tableNames = TABLE_NAMES.slice();
      return rep;
    }, function (e) {
      return { ok: false, reason: 'read-failed', message: (e && e.message) || String(e) };
    });
  }

  /* ==================== 标记与租约 ==================== */

  function readMarker() {
    try {
      var s = global.localStorage.getItem(MARKER_KEY);
      if (!s) return null;
      var o = JSON.parse(s);
      return isPlainObject(o) ? o : { corrupt: true };
    } catch (e) { return { corrupt: true, error: String((e && e.message) || e) }; }
  }

  function writeMarker(state, info) {
    info = info || {};
    var payload = {
      v: 1,
      state: state,
      sourceHash: info.sourceHash || null,
      sourceDigest: info.sourceDigest || null,
      schemaVersion: SCHEMA_VERSION,
      epoch: typeof info.epoch === 'number' ? info.epoch : 0,
      ownerId: info.ownerId || null,
      attempts: typeof info.attempts === 'number' ? info.attempts : 0,
      at: Date.now(),
      doneAt: state === 'done' ? Date.now() : null
    };
    try { global.localStorage.setItem(MARKER_KEY, JSON.stringify(payload)); return true; }
    catch (e) { return false; }
  }

  /* 事务内校验迁移租约。只读 meta.migration，不碰 meta.writer */
  function assertMigrationLease(db, ownerId, epoch) {
    return db.meta.get('migration').then(function (m) {
      if (!m || m.status !== 'in_progress') throw leaseError('not-in-progress', '迁移状态不是 in_progress');
      if (m.ownerId !== ownerId) throw leaseError('owner-changed', '迁移锁已被其它标签页接管');
      if (m.epoch !== epoch) throw leaseError('epoch-changed', '迁移 epoch 不匹配');
      if (!usableDeadline(m.leaseExpiresAt)) {
        throw leaseError('lease-invalid', '迁移租约有效期不是有限数值：' + String(m.leaseExpiresAt));
      }
      if (m.leaseExpiresAt < Date.now()) throw leaseError('lease-expired', '迁移租约已过期');
      return m;
    });
  }

  function countBusinessRows(db) {
    var total = 0, i = 0;
    function step() {
      if (i >= BUSINESS_TABLES.length) return Promise.resolve(total);
      var name = BUSINESS_TABLES[i++];
      return db.table(name).count().then(function (n) { total += n; return step(); });
    }
    return step();
  }

  /* 单事务认领。返回 'already-done' / 'busy' / 'unexpected-data' / 'too-many-attempts' / {epoch,attempts}
     事务 scope 必须列全六张表：认领时要判定「是否已有业务数据」，
     在只声明 meta 的事务里访问其它表会被 IndexedDB 判为 NotFoundError。 */
  function claimOwner(db, ownerId, ctx) {
    return db.transaction(
      'rw',
      db.meta, db.definitions, db.tasks, db.schedule, db.dayEntries, db.dayMaps,
      function () {
      var attempts = 0;

      /* 代次下界只能升不能降：旧 writer 的 epoch + 1 成为新的合法下界。
         迁移行里若已有非法 floor，一律失败关闭（不能静默归零让旧 writer 复活）。 */
      function putClaim(cur, now, oldWriter) {
        /* 首次认领本就没有迁移行，等价于「旧库无下界字段」→ 0；
           已有迁移行则严格校验，损坏值一律失败关闭。 */
        var prev = cur ? readWriterEpochFloor(cur) : {
          ok: true, present: false, value: WRITER_FLOOR_DEFAULT, code: 'ok', message: ''
        };
        if (!prev.ok) throw writeLeaseError(prev.code, prev.message);
        var oldEpoch = (oldWriter && isWriterEpoch(oldWriter.epoch)) ? oldWriter.epoch : null;
        var floor = oldEpoch === null ? prev.value : Math.max(prev.value, oldEpoch + 1);
        var epoch = ((cur && cur.epoch) || 0) + 1;
        return db.meta.put({
          key: 'migration',
          status: 'in_progress',
          phase: 'claiming',
          ownerId: ownerId,
          epoch: epoch,
          heartbeatAt: now,
          leaseExpiresAt: now + MIGRATION_LEASE_TTL,
          attempts: attempts,
          sourceHash: ctx.sourceHash,
          sourceDigest: ctx.sourceDigest,
          schemaVersion: SCHEMA_VERSION,
          startedAt: (cur && cur.startedAt) || now,
          finishedAt: null,
          errorCode: null,
          writerEpochFloor: floor
        }).then(function () { return { epoch: epoch, attempts: attempts, writerEpochFloor: floor }; });
      }

      return db.meta.get('migration').then(function (cur) {
        var now = Date.now();
        if (cur && cur.status === 'done') return 'already-done';
        /* 非有限有效期不算有效租约：否则 Infinity 会让所有后续认领永久 busy */
        if (cur && cur.status === 'in_progress' && usableDeadline(cur.leaseExpiresAt) &&
            cur.leaseExpiresAt > now && cur.ownerId !== ownerId) return 'busy';
        if (cur && (cur.attempts || 0) >= MAX_ATTEMPTS) return 'too-many-attempts';

        attempts = ((cur && cur.attempts) || 0) + 1;

        /* 同事务内读旧 writer：下界要盖过它，重迁移后旧代次才不会重新获得写入权。 */
        return db.meta.get('writer').then(function (oldWriter) {
          if (!cur) {
            return countBusinessRows(db).then(function (total) {
              if (total > 0) return 'unexpected-data';
              return putClaim(cur, now, oldWriter);
            });
          }
          return putClaim(cur, now, oldWriter);
        });
      });
    });
  }

  /* 同事务内再校验租约 → 写 failed。租约已丢失则抛错、一个字都不写。 */
  function markMigrationFailed(db, ownerId, epoch, errorCode, summary) {
    return db.transaction('rw', db.meta, function () {
      return assertMigrationLease(db, ownerId, epoch).then(function () {
        return db.meta.get('migration').then(function (m) {
          m.status = 'failed';
          m.phase = 'failed';
          m.errorCode = errorCode || 'write-error';
          m.verifyDiffSummary = summary || null;
          m.finishedAt = Date.now();
          m.leaseExpiresAt = 0;
          m.ownerId = null;
          m.heartbeatAt = Date.now();
          return db.meta.put(m);
        });
      });
    }).then(function () { return { ok: true }; }, function (e) {
      return { ok: false, reason: (e && e.code) || 'lease-lost', message: (e && e.message) || String(e) };
    });
  }

  /* ==================== 业务 writer 租约（Step 4.5 / 5B T2） ====================
     与「迁移租约」是两套独立身份和生命周期，绝不混用：
       迁移租约  meta.migration / status in_progress / MIGRATION_LEASE_TTL /
                 claimOwner 认领 / startMigrationHeartbeat 续期 / 迁移完成即退出
       writer    meta.writer   / status active       / WRITE_TTL /
                 迁移末尾装上 / 由后续任务的心跳续期 / 常驻，过期后由新代次接管
     本任务只提供元数据、纯校验器与只读状态能力；不启动 writer 心跳、不做接管、
     不开放业务写入。租约最终有效性必须在业务 rw 事务内部判定，事务外结果只作展示。 */

  function writeLeaseError(code, message) {
    var err = new Error(message || code);
    err.name = 'WriteLeaseLost';
    err.code = code;
    err.leaseKind = 'writer';
    return err;
  }

  /* 拿当前已打开的实例；关闭态 instance() 返回 null，不自动 open（写入权不负责建库） */
  function currentDb() {
    if (!global.OLDB || typeof global.OLDB.instance !== 'function') return null;
    try { return global.OLDB.instance(); } catch (e) { return null; }
  }

  /* 事务内校验：只能由调用方在自己已经打开的 Dexie 事务里调用。
     链条里只有 db.meta.get 这类 Dexie 操作，没有非 Dexie 异步，因此不会提前提交事务。
     失败抛 WriteLeaseLost → Dexie 整事务回滚。
     这是为未来业务 rw 事务准备的可复用函数，本任务没有任何业务写事务调用它。 */
  function checkWriteLeaseInTx(db, ownerId, epoch, now) {
    var at = usableDeadline(now) ? now : Date.now();
    return db.meta.get('writer').then(function (w) {
      return db.meta.get('migration').then(function (m) {
        var r = evaluateWriterLease(w, m, ownerId, epoch, at);
        if (!r.ok) throw writeLeaseError(r.code, r.message);
        r.writerRow = w;
        return r;
      });
    });
  }

  /* 只读状态摘要：一个 r 事务读两行，返回完整体检结论。
     statusOnly=true 明确表示它只作状态展示，不构成写入授权。 */
  function inspectWriterLease(ownerId, epoch) {
    var db = currentDb();
    if (!db) return Promise.resolve({
      ok: false, code: 'db-not-open', message: '数据库尚未打开',
      statusOnly: true, leaseKind: 'writer', writer: null, floor: null
    });
    var now = Date.now();
    return db.transaction('r', db.meta, function () {
      return db.meta.get('writer').then(function (w) {
        return db.meta.get('migration').then(function (m) {
          return { w: w, m: m };
        });
      });
    }).then(function (r) {
      var out = evaluateWriterLease(r.w, r.m, ownerId, epoch, now);
      out.statusOnly = true;
      return out;
    }, function (e) {
      return {
        ok: false, code: 'read-failed', message: (e && e.message) || String(e),
        statusOnly: true, leaseKind: 'writer', writer: null, floor: null
      };
    });
  }

  /* 只读校验（沿用 Step 4.5 对外契约）：不改任何字段，只作状态展示。 */
  function assertWriteLease(ownerId, epoch) {
    var db = currentDb();
    if (!db) return Promise.resolve({ ok: false, reason: 'db-not-open', message: '数据库尚未打开', statusOnly: true });
    return db.transaction('r', db.meta, function () {
      return checkWriteLeaseInTx(db, ownerId, epoch, Date.now());
    }).then(function (r) {
      return {
        ok: true, ownerId: r.ownerId, epoch: r.epoch, status: r.writer.status,
        leaseExpiresAt: r.writer.leaseExpiresAt, floor: r.floor, statusOnly: true
      };
    }, function (e) {
      return {
        ok: false, reason: (e && e.code) || 'write-lease-lost',
        message: (e && e.message) || String(e), statusOnly: true
      };
    });
  }

  /* 事务内校验后续期。校验不通过就一个字都不写——绝不把别人的写入权改成自己的。
     只延长有效期与心跳时间，epoch / ownerId / status 逐字保留。 */
  function renewWriteLease(ownerId, epoch) {
    var db = currentDb();
    if (!db) return Promise.resolve({ ok: false, reason: 'db-not-open', message: '数据库尚未打开' });
    var now = Date.now();
    var renewed = null;
    return db.transaction('rw', db.meta, function () {
      return checkWriteLeaseInTx(db, ownerId, epoch, now).then(function (r) {
        var row = buildRenewedWriterRow(r.writerRow, now);
        renewed = {
          ownerId: row.ownerId, epoch: row.epoch, status: row.status,
          heartbeatAt: row.heartbeatAt, leaseExpiresAt: row.leaseExpiresAt
        };
        return db.meta.put(row);
      });
    }).then(function () {
      return { ok: true, writer: renewed };
    }, function (e) {
      return { ok: false, reason: (e && e.code) || 'write-lease-lost',
        message: (e && e.message) || String(e) };
    });
  }

  /* ==================== 迁移租约续期 ==================== */

  /* 只服务迁移租约（meta.migration），不是 writer 心跳。
     claim 之后启动：每 MIGRATION_HEARTBEAT_MS 用独立的 meta 单表事务续租。
     续租事务内同样先 assertMigrationLease()，租约一旦丢失立刻停表，不再续。
     写入事务本身会持有 meta 的读写锁，所以心跳在事务进行中会被排队——这是对的：
     事务结束即结束迁移，锁也不再需要。 */
  function startMigrationHeartbeat(db, ownerId, epoch) {
    var timer = null;
    var stopped = false;

    function stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    }

    function tick() {
      if (stopped) return;
      db.transaction('rw', db.meta, function () {
        return assertMigrationLease(db, ownerId, epoch).then(function (m) {
          var now = Date.now();
          m.heartbeatAt = now;
          m.leaseExpiresAt = now + MIGRATION_LEASE_TTL;
          return db.meta.put(m);
        });
      }).then(function () {}, function () { stop(); });
    }

    if (typeof global.setInterval === 'function') timer = global.setInterval(tick, MIGRATION_HEARTBEAT_MS);
    return stop;
  }

  /* ==================== 单事务写入 ==================== */
  function writeAllInOneTransaction(db, ctx) {
    var rows = ctx.plan.rows;
    var now = Date.now();   /* 事务外取一次，事务内不再取时间 */

    return db.transaction(
      'rw',
      db.meta, db.definitions, db.tasks, db.schedule, db.dayEntries, db.dayMaps,
      function () {
        /* 事务内第一条必须是租约校验；失败即整库回滚 */
        return assertMigrationLease(db, ctx.ownerId, ctx.epoch).then(function () {
          return db.definitions.clear();
        }).then(function () {
          return db.tasks.clear();
        }).then(function () {
          return db.schedule.clear();
        }).then(function () {
          return db.dayEntries.clear();
        }).then(function () {
          return db.dayMaps.clear();
        }).then(function () {
          /* 精确白名单：只删三个业务载荷 key + legacyExtras，基础设施行不动 */
          return db.meta.bulkDelete(CLEARED_KEYS.slice());
        }).then(function () {
          /* 原始快照先落库：normalize 之前唯一可回退副本 */
          return db.meta.put({
            key: 'preNormalize',
            raw: ctx.raw,
            sha256: ctx.sourceHash,
            bytes: ctx.bytes,
            characters: ctx.characters,
            capturedAt: now,
            schemaVersion: SCHEMA_VERSION
          });
        }).then(function () {
          /* 未知顶层字段的载体：有才写，没有就不留空行 */
          if (!rows.extras || !rows.extras.present) return null;
          return db.meta.put({
            key: EXTRAS_KEY,
            keys: rows.extras.keys.slice(),
            value: rows.extras.value,
            count: rows.extras.keys.length,
            capturedAt: now,
            schemaVersion: SCHEMA_VERSION
          });
        }).then(function () {
          var chain = Promise.resolve();
          if (rows.meta.length) chain = chain.then(function () { return db.meta.bulkPut(rows.meta); });
          if (rows.definitions.length) chain = chain.then(function () { return db.definitions.bulkPut(rows.definitions); });
          if (rows.tasks.length) chain = chain.then(function () { return db.tasks.bulkPut(rows.tasks); });
          if (rows.schedule.length) chain = chain.then(function () { return db.schedule.bulkPut(rows.schedule); });
          if (rows.dayEntries.length) chain = chain.then(function () { return db.dayEntries.bulkPut(rows.dayEntries); });
          if (rows.dayMaps.length) chain = chain.then(function () { return db.dayMaps.bulkPut(rows.dayMaps); });
          return chain;
        }).then(function () {
          return db.meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION });
        }).then(function () {
          /* 收尾三件事，必须在同一事务内 */
          return db.meta.get('migration').then(function (m) {
            if (!m) throw new Error('migration-row-vanished');
            m.status = 'done';
            m.phase = 'finalizing';
            m.finishedAt = now;
            m.leaseExpiresAt = 0;
            m.ownerId = null;
            m.heartbeatAt = now;
            m.writeCounts = {
              meta: rows.meta.length,
              definitions: rows.definitions.length,
              tasks: rows.tasks.length,
              schedule: rows.schedule.length,
              dayEntries: rows.dayEntries.length,
              dayMaps: rows.dayMaps.length
            };
            m.legacyExtrasKeys = rows.extras ? rows.extras.keys.length : 0;
            return db.meta.put(m);
          });
        }).then(function () {
          /* 迁移锁退出、日常写入权的「占位行」装上：同一个事务里完成切换。
             epoch 取本轮迁移记录的合法下界（首次迁移为 0 → epoch 1）；
             重迁移时下界已盖过旧 writer，旧代次因此永远不可能重新生效。
             leaseExpiresAt 故意写 0：迁移用的 ownerId 与各标签页 write.js 的 TAB_ID
             不同，满额租约会让迁移页在 TTL（30s）内无法 acquire，首启只能只读。
             置 0 表示「本迁移不持有日常写入权」——行仍保留 owner/epoch/status，
             verifyAfterWrite 的 writerInstalled 与 epoch fencing 不受影响；
             首个 acquireWriter 会按「租约已过期」立即接管并提升 epoch。 */
          return db.meta.get('migration').then(function (m) {
            var f = readWriterEpochFloor(m);
            if (!f.ok) throw writeLeaseError(f.code, f.message);
            return db.meta.put({
              key: 'writer',
              status: 'active',
              ownerId: ctx.ownerId,
              epoch: Math.max(WRITER_EPOCH_MIN, f.value),
              heartbeatAt: now,
              leaseExpiresAt: 0
            });
          });
        });
      }
    );
  }

  /* 迁移后只读复验 */
  function verifyAfterWrite(db, ownerId) {
    var names = ['definitions', 'tasks', 'schedule', 'dayEntries', 'dayMaps'];
    var got = {};
    var i = 0;
    function step() {
      if (i >= names.length) return Promise.resolve();
      var n = names[i++];
      return db.table(n).count().then(function (c) { got[n] = c; return step(); });
    }
    return step().then(function () {
      return db.meta.get('migration');
    }).then(function (m) {
      return db.meta.get('writer').then(function (w) {
        return db.meta.get(EXTRAS_KEY).then(function (x) {
          return {
            counts: got,
            metaStatus: m ? m.status : null,
            leaseCleared: !!(m && m.ownerId === null && m.leaseExpiresAt === 0),
            writerInstalled: !!(w && w.ownerId === ownerId && w.status === 'active'),
            legacyExtrasKeys: x && Array.isArray(x.keys) ? x.keys.length : 0,
            schemaVersion: null
          };
        });
      });
    }).then(function (r) {
      return db.meta.get('schemaVersion').then(function (s) {
        r.schemaVersion = s ? s.value : null;
        return r;
      });
    });
  }

  /* ==================== 主流程 ==================== */

  function run(options) {
    options = options || {};

    /* 游客库不参与迁移：迁移的源是 localStorage 里的正式数据，
       任何情况下都不允许把它搬进 earthonline-guest（产品决策：游客库只放静态种子）。 */
    if (global.OLIdentity && typeof global.OLIdentity.isGuest === 'function' && global.OLIdentity.isGuest()) {
      return Promise.resolve({ ok: false, reason: 'guest-space-refused', message: '游客空间不使用迁移流程' });
    }

    if (options.confirm !== true) {
      return Promise.resolve({ ok: false, reason: 'not-confirmed', message: '迁移必须显式传 {confirm:true}' });
    }
    if (!global.OLDB || typeof global.OLDB.open !== 'function') {
      return Promise.resolve({ ok: false, reason: 'db-module-missing' });
    }

    var ownerId = newOwnerId();
    var ctx = { ownerId: ownerId, epoch: null, plan: null, raw: null, sourceHash: null, sourceDigest: null };

    return dryRun(options).then(function (plan) {
      if (!plan.ok) return { ok: false, reason: 'dry-run-blocked', blocked: plan.blocked, plan: summarizePlan(plan) };
      ctx.plan = plan;

      /* 事务外算完所有异步量，并复核来源未被改动 */
      return sha256(String(readRaw(options))).then(function (h) {
        if (h.hex !== plan.source.sha256) {
          return { ok: false, reason: 'source-hash-mismatch', message: '干跑与实际迁移之间原始数据发生变化，已中止' };
        }
        var rawNow = String(readRaw(options));
        ctx.raw = rawNow;
        ctx.bytes = utf8Bytes(rawNow);
        ctx.characters = rawNow.length;
        ctx.sourceHash = h.hex;

        var parsed;
        try { parsed = JSON.parse(rawNow); } catch (e) { return { ok: false, reason: 'source-parse-failed' }; }

        return sha256(canonicalize(parsed)).then(function (d) {
          ctx.sourceDigest = d.hex;

          return global.OLDB.open().then(function () {
            return proceedAfterOpen();
          }, function (e) {
            return {
              ok: false,
              reason: 'db-open-failed',
              errorCode: (e && e.code) || 'open-failed',
              message: (e && e.message) || String(e)
            };
          });
        });
      });
    });

    function proceedAfterOpen() {
      var db = global.OLDB.instance();
      if (!db) return { ok: false, reason: 'db-instance-missing' };

      var marker = readMarker();
      if (marker && marker.state === 'done') {
        return db.meta.get('migration').then(function (m) {
          if (m && m.status === 'done') return { ok: true, skipped: 'marker-done' };
          return { ok: false, reason: 'marker-db-mismatch', message: '标记显示已完成，但库里状态不是 done；不猜，交人工' };
        });
      }

      /* 外部标记 pending 必须先于写事务；写不进就放弃整个迁移（E20） */
      var pendingOk = writeMarker('pending', {
        sourceHash: ctx.sourceHash, sourceDigest: ctx.sourceDigest, ownerId: ownerId, attempts: 0
      });
      if (!pendingOk) return { ok: false, reason: 'marker-write-failed', message: '无法写迁移标记，已保持原样' };

      return claimOwner(db, ownerId, ctx).then(function (claim) {
        if (claim === 'already-done') {
          writeMarker('done', { sourceHash: ctx.sourceHash, sourceDigest: ctx.sourceDigest, ownerId: ownerId });
          return { ok: true, skipped: 'already-done' };
        }
        if (claim === 'busy') return { ok: false, reason: 'migration-busy', message: '另一个标签页正在迁移' };
        if (claim === 'unexpected-data') return { ok: false, reason: 'unexpected-existing-data', message: '六表已有数据但无迁移记录，拒绝覆盖' };
        if (claim === 'too-many-attempts') return { ok: false, reason: 'too-many-attempts', message: '已失败 ' + MAX_ATTEMPTS + ' 次，转人工' };

        ctx.epoch = claim.epoch;
        var stopHeartbeat = startMigrationHeartbeat(db, ownerId, ctx.epoch);

        return writeAllInOneTransaction(db, ctx).then(function () {
          stopHeartbeat();
          var markerOk = writeMarker('done', {
            sourceHash: ctx.sourceHash, sourceDigest: ctx.sourceDigest,
            ownerId: ownerId, epoch: ctx.epoch, attempts: claim.attempts
          });
          return verifyAfterWrite(db, ownerId).then(function (v) {
            return {
              ok: true,
              epoch: ctx.epoch,
              attempts: claim.attempts,
              counts: ctx.plan.counts,
              verify: v,
              markerDone: markerOk,
              ownerId: ownerId
            };
          });
        }, function (err) {
          stopHeartbeat();
          var code = (err && err.code) || 'write-error';
          return markMigrationFailed(db, ownerId, ctx.epoch, code, {
            stage: 'transaction', name: (err && err.name) || 'Error',
            message: String((err && err.message) || err).slice(0, 200)
          }).then(function (mf) {
            return {
              ok: false,
              reason: 'transaction-failed',
              errorCode: code,
              message: (err && err.message) || String(err),
              failedMarked: mf.ok,
              failedReason: mf.reason || null,
              plan: summarizePlan(ctx.plan)
            };
          });
        });
      });
    }
  }

  /* 计划摘要：不带行数据，避免把整份业务数据抛来抛去 */
  function summarizePlan(plan) {
    if (!plan) return null;
    return {
      ok: plan.ok,
      reason: plan.reason,
      blocked: plan.blocked,
      counts: plan.counts,
      expected: plan.expected,
      diff: plan.diff,
      conflictCount: (plan.conflicts || []).length,
      badDateCount: (plan.badDates || []).length,
      extrasCount: plan.extras && plan.extras.keys ? plan.extras.keys.length : 0,
      source: plan.source,
      warningCount: (plan.warnings || []).length
    };
  }

  /* ==================== 只读状态 ==================== */

  /* 只读状态：marker + 六表 + 两套租约摘要。
     readOnly 是五条件合取的结果，缺一即只读：
       ① mode === 'idb'（迁移完成、六表可用）
       ② migration.status === 'done'
       ③ OLWrite.wired === true（业务写入已显式接线，加载 write.js 不算）
       ④ writerLease.valid === true（writer 体检含代次下界全部通过）
       ⑤ 当前标签页持有写入权且身份匹配：hasWriterLease() === true、
         writerLost() === false、currentWriterIdentity() 与库内 writer 行的
         ownerId / epoch 逐字一致。
     关键修正（5B-Preflight-R1）：④只证明「库内存在有效 writer 租约」，并不证明
     该租约属于当前标签页。A 标签页持有时 B 标签页的 ④ 同样为真，若只看四条件，
     B 会被报可写、但 commit() 必因身份不匹配失败。第 ⑤ 条把「当前标签页」纳入判定，
     且采用 OLWrite 既有的只读接口 + 最小只读摘要 currentWriterIdentity()，
     不削弱 commit() 事务内的迁移闸门 / 租约校验 / fencing。 */
  function status() {
    var out = {
      readOnly: true,
      marker: readMarker(),
      markerKeyPresent: false,
      migration: null,       /* 迁移租约 / 迁移状态 */
      writer: null,          /* writer 行摘要 */
      writerLease: null,     /* 业务 writer 租约体检（含代次下界） */
      currentWriter: null,   /* 当前标签页持有的只读身份摘要（来自 OLWrite） */
      writerHeldByCurrentTab: false, /* 当前标签页是否持有且与库内身份匹配 */
      tables: null,
      mode: 'unknown'
    };
    try { out.markerKeyPresent = global.localStorage.getItem(MARKER_KEY) !== null; } catch (e) {}

    function done() {
      var idbMode = out.mode === 'idb';
      var migrationDone = !!(out.migration && out.migration.status === 'done');
      var wired = !!(global.OLWrite && global.OLWrite.wired === true);
      var leaseValid = !!(out.writerLease && out.writerLease.valid === true);

      /* 当前标签页身份判定：全部只读，不改库、不授权。
         没有 OLWrite 模块 / 未持有 / 已失权 → currentWriter=null → 必然只读。 */
      var localHeld = !!(global.OLWrite && typeof global.OLWrite.hasWriterLease === 'function'
        && global.OLWrite.hasWriterLease() === true);
      var notLost = !!(global.OLWrite && typeof global.OLWrite.writerLost === 'function'
        && global.OLWrite.writerLost() === false);
      var identity = null;
      if (global.OLWrite && typeof global.OLWrite.currentWriterIdentity === 'function') {
        var id = global.OLWrite.currentWriterIdentity();
        if (id && typeof id === 'object' && typeof id.ownerId === 'string' && id.ownerId
            && typeof id.epoch === 'number' && isFinite(id.epoch)) {
          identity = { ownerId: id.ownerId, epoch: id.epoch };
        }
      }
      out.currentWriter = identity;

      /* 身份匹配：本地身份与库内 writer 行逐字一致，且库内行有效。 */
      var dbWriter = out.writer;   /* summarizeInfra('writer')：含 ownerId / epoch / status */
      var identityMatches = !!(identity && dbWriter && dbWriter.present
        && dbWriter.ownerId === identity.ownerId && dbWriter.epoch === identity.epoch);
      out.writerHeldByCurrentTab = !!(localHeld && notLost && identityMatches && leaseValid);

      out.readOnly = !(idbMode && migrationDone && wired && leaseValid
        && localHeld && notLost && out.writerHeldByCurrentTab);
      return out;
    }

    if (!global.OLDB) return Promise.resolve(done());

    return global.OLDB.inspect().then(function (rep) {
      out.existence = rep.existence;
      if (rep.existence !== 'exists') {
        out.mode = rep.existence === 'not-exists' ? 'ls' : 'unknown';
        return done();
      }
      out.tables = rep.tables;
      if (rep.meta) {
        out.migration = rep.meta.infra.migration.present ? rep.meta.infra.migration : null;
        out.writer = rep.meta.infra.writer.present ? rep.meta.infra.writer : null;
      }
      /* 代次下界从迁移记录读：旧库无字段 → 0；字段损坏 → 失败关闭。 */
      var mView = null;
      if (out.migration) {
        mView = {};
        if (out.migration.writerEpochFloorPresent) {
          defineOwn(mView, 'writerEpochFloor', out.migration.writerEpochFloor);
        }
      }
      var f = readWriterEpochFloor(mView);
      var now = Date.now();
      var h = inspectWriterRow(out.writer, f.ok ? f.value : null, now);
      out.writerLease = {
        leaseKind: 'writer',
        statusOnly: true,
        present: h.present,
        valid: f.ok && h.ok,
        code: f.ok ? h.code : (h.present ? f.code : h.code),
        message: f.ok ? h.message : (h.present ? f.message : h.message),
        floor: f.ok ? f.value : null,
        floorPresent: f.present,
        epochBelowFloor: h.belowFloor,
        epochValid: h.epochValid,
        leaseValid: h.leaseValid,
        remainingMs: h.remainingMs,
        checkedAt: now
      };
      if (out.migration && out.migration.status === 'done') out.mode = 'idb';
      else if (out.migration && out.migration.status === 'in_progress') out.mode = 'in_progress';
      else if (out.migration && out.migration.status === 'failed') out.mode = 'failed';
      else out.mode = 'unmigrated';
      return done();
    }, function (e) {
      out.mode = 'unavailable';
      out.error = (e && e.message) || String(e);
      return done();
    });
  }

  var api = {
    KEY: KEY,
    MARKER_KEY: MARKER_KEY,
    LOCK_KEY: LOCK_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    MIGRATION_LEASE_TTL: MIGRATION_LEASE_TTL,
    MIGRATION_HEARTBEAT_MS: MIGRATION_HEARTBEAT_MS,
    WRITE_TTL: WRITE_TTL,
    MAX_ATTEMPTS: MAX_ATTEMPTS,
    WRITER_EPOCH_MIN: WRITER_EPOCH_MIN,
    WRITER_FLOOR_DEFAULT: WRITER_FLOOR_DEFAULT,
    TABLE_NAMES: TABLE_NAMES.slice(),
    BUSINESS_TABLES: BUSINESS_TABLES.slice(),
    PAYLOAD_KEYS: PAYLOAD_KEYS.slice(),
    CLEARED_KEYS: CLEARED_KEYS.slice(),
    EXTRAS_KEY: EXTRAS_KEY,
    TOP_KEYS: TOP_KEYS.slice(),
    META_ALLOWED: Object.keys(META_ALLOWED),
    isAllowedMetaKey: isAllowedMetaKey,
    buildRows: buildRows,
    checkConflicts: checkConflicts,
    collectBadDates: collectBadDates,
    canonicalize: canonicalize,
    summarizePlan: summarizePlan,
    dryRun: dryRun,
    run: run,
    status: status,
    readMarker: readMarker,
    /* Step 5A：从已迁移的六表读回业务数据（只读） */
    rehydrate: rehydrate,
    /* 业务 writer 租约：只读校验 / 续期（Step 4.5 既有能力） */
    assertWriteLease: assertWriteLease,
    renewWriteLease: renewWriteLease,
    /* Step 5B T2：代次基础设施（全部为纯函数，不写库、不授权写入） */
    isWriterEpoch: isWriterEpoch,
    readWriterEpochFloor: readWriterEpochFloor,
    nextWriterEpoch: nextWriterEpoch,
    inspectWriterRow: inspectWriterRow,
    evaluateWriterLease: evaluateWriterLease,
    buildRenewedWriterRow: buildRenewedWriterRow,
    /* 只能在调用方已打开的 Dexie 事务内部调用；事务外调用不构成写入授权 */
    checkWriteLeaseInTx: checkWriteLeaseInTx,
    /* 只读状态摘要：只作展示，statusOnly=true */
    inspectWriterLease: inspectWriterLease,
    /* 迁移租约心跳（不是 writer 心跳）：供测试与人工恢复使用，不自动调用。
       保留 startHeartbeat 名字以兼容 Step 4.5 既有调用。 */
    startMigrationHeartbeat: function (ownerId, epoch) {
      var db = global.OLDB && global.OLDB.instance();
      if (!db) return function () {};
      return startMigrationHeartbeat(db, ownerId, epoch);
    },
    startHeartbeat: function (ownerId, epoch) {
      var db = global.OLDB && global.OLDB.instance();
      if (!db) return function () {};
      return startMigrationHeartbeat(db, ownerId, epoch);
    },
    markFailed: function (ownerId, epoch, errorCode, summary) {
      var db = global.OLDB && global.OLDB.instance();
      if (!db) return Promise.resolve({ ok: false, reason: 'db-not-open' });
      return markMigrationFailed(db, ownerId, epoch, errorCode, summary);
    }
  };

  global.OLMigrate = api;
})(typeof window !== 'undefined' ? window : this);
