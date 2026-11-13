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

  var TABLE_NAMES = ['meta', 'definitions', 'tasks', 'schedule', 'dayEntries', 'dayMaps'];
  var BUSINESS_TABLES = ['definitions', 'tasks', 'schedule', 'dayEntries', 'dayMaps'];
  var PAYLOAD_KEYS = ['v', 'settings', 'plugins'];
  var EXTRAS_KEY = 'legacyExtras';

  /* 19 个顶层字段，与 legacy.js 的 TOP_ORDER / core.js 的 defaults() 逐一对应。
     不在此列 = 未知顶层字段，写入 meta.legacyExtras，绝不丢弃。 */
  var TOP_KEYS = [
    'v', 'tasks', 'schedule', 'plans', 'notes', 'marks', 'pens', 'tags', 'tagLogs',
    'suggestions', 'doneSugg', 'workouts', 'studyLogs', 'decisionLog', 'restDays',
    'flashes', 'itemLogs', 'plugins', 'settings'
  ];

  /* 重迁移时先清的业务载荷：三个原始载荷 + legacyExtras（它由源数据派生） */
  var CLEARED_KEYS = PAYLOAD_KEYS.concat([EXTRAS_KEY]);

  /* meta 精确白名单。新增 key 必须显式改这里，不接受前缀/正则通配。 */
  var META_ALLOWED = {
    v: 'payload', settings: 'payload', plugins: 'payload', legacyExtras: 'payload',
    schemaVersion: 'infra', migration: 'infra', writer: 'infra',
    preNormalize: 'infra', bizDatePolicy: 'infra'
  };

  var DEF_MAP = [
    { src: 'pens', kind: 'pen' },
    { src: 'tags', kind: 'tag' },
    { src: 'suggestions', kind: 'suggestion' }
  ];
  var ENTRY_MAP = [
    { src: 'plans', type: 'plan' },
    { src: 'tagLogs', type: 'tagLog' },
    { src: 'workouts', type: 'workout' },
    { src: 'studyLogs', type: 'studyLog' },
    { src: 'decisionLog', type: 'decision' },
    { src: 'flashes', type: 'flash' },
    { src: 'itemLogs', type: 'itemLog' }
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

  function shallow(rec) {
    var out = {};
    for (var k in rec) if (has(rec, k)) out[k] = rec[k];
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

  function leaseError(code, message) {
    var err = new Error(message || code);
    err.name = 'MigrationLeaseLost';
    err.code = code;
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
        extraVal[allTop[i]] = S0[allTop[i]];
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

      function putClaim(cur, now) {
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
          writerEpochFloor: (cur && cur.writerEpochFloor) || 0
        }).then(function () { return { epoch: epoch, attempts: attempts }; });
      }

      return db.meta.get('migration').then(function (cur) {
        var now = Date.now();
        if (cur && cur.status === 'done') return 'already-done';
        if (cur && cur.status === 'in_progress' && cur.leaseExpiresAt > now && cur.ownerId !== ownerId) return 'busy';
        if (cur && (cur.attempts || 0) >= MAX_ATTEMPTS) return 'too-many-attempts';

        attempts = ((cur && cur.attempts) || 0) + 1;

        if (!cur) {
          return countBusinessRows(db).then(function (total) {
            if (total > 0) return 'unexpected-data';
            return putClaim(cur, now);
          });
        }
        return putClaim(cur, now);
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

  /* ==================== 写入权（Step 4.5） ==================== */

  /* 业务写入权的校验顺序：存在 → 状态 → 归属 → epoch → 有效期。
     顺序固定，第一个不满足的即为失败原因，便于诊断「到底哪一项不对」。 */
  function checkWriteLease(db, ownerId, epoch) {
    return db.meta.get('writer').then(function (w) {
      if (!w) throw writeLeaseError('writer-missing', '没有写入权记录');
      if (w.status !== 'active') throw writeLeaseError('writer-inactive', '写入权状态不是 active：' + w.status);
      if (w.ownerId !== ownerId) throw writeLeaseError('writer-owner-changed', '写入权已被其它标签页接管');
      if (w.epoch !== epoch) throw writeLeaseError('writer-epoch-changed', '写入权 epoch 不匹配');
      if (typeof w.leaseExpiresAt !== 'number' || w.leaseExpiresAt < Date.now()) {
        throw writeLeaseError('writer-lease-expired', '写入权租约已过期');
      }
      return w;
    });
  }

  function writeLeaseError(code, message) {
    var err = new Error(message || code);
    err.name = 'WriteLeaseLost';
    err.code = code;
    return err;
  }

  /* 拿当前已打开的实例；关闭态 instance() 返回 null，不自动 open（写入权不负责建库） */
  function currentDb() {
    if (!global.OLDB || typeof global.OLDB.instance !== 'function') return null;
    try { return global.OLDB.instance(); } catch (e) { return null; }
  }

  /* 只读校验：不改任何字段。返回 {ok, ownerId, epoch, leaseExpiresAt} */
  function assertWriteLease(ownerId, epoch) {
    var db = currentDb();
    if (!db) return Promise.resolve({ ok: false, reason: 'db-not-open', message: '数据库尚未打开' });
    return db.transaction('r', db.meta, function () {
      return checkWriteLease(db, ownerId, epoch);
    }).then(function (w) {
      return { ok: true, ownerId: w.ownerId, epoch: w.epoch, status: w.status, leaseExpiresAt: w.leaseExpiresAt };
    }, function (e) {
      return { ok: false, reason: (e && e.code) || 'write-lease-lost', message: (e && e.message) || String(e) };
    });
  }

  /* 事务内校验后续期。校验不通过就一个字都不写——绝不把别人的写入权改成自己的。
     返回 {ok:true, writer:{ownerId, epoch, heartbeatAt, leaseExpiresAt, status}} */
  function renewWriteLease(ownerId, epoch) {
    var db = currentDb();
    if (!db) return Promise.resolve({ ok: false, reason: 'db-not-open', message: '数据库尚未打开' });
    var renewed = null;
    return db.transaction('rw', db.meta, function () {
      return checkWriteLease(db, ownerId, epoch).then(function (w) {
        var now = Date.now();
        w.heartbeatAt = now;
        w.leaseExpiresAt = now + WRITE_TTL;
        renewed = { ownerId: w.ownerId, epoch: w.epoch, status: w.status, heartbeatAt: w.heartbeatAt, leaseExpiresAt: w.leaseExpiresAt };
        return db.meta.put(w);
      });
    }).then(function () {
      return { ok: true, writer: renewed };
    }, function (e) {
      return { ok: false, reason: (e && e.code) || 'write-lease-lost', message: (e && e.message) || String(e) };
    });
  }

  /* ==================== 租约续期 ==================== */

  /* claim 之后启动：每 MIGRATION_HEARTBEAT_MS 用独立的 meta 单表事务续租。
     续租事务内同样先 assertMigrationLease()，租约一旦丢失立刻停表，不再续。
     写入事务本身会持有 meta 的读写锁，所以心跳在事务进行中会被排队——这是对的：
     事务结束即结束迁移，锁也不再需要。 */
  function startHeartbeat(db, ownerId, epoch) {
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
          /* 迁移锁退出、日常写入权装上：同一个事务里完成切换。
             status='active' 是 assertWriteLease 的第一道判定，缺它即视为无写入权。 */
          return db.meta.put({
            key: 'writer',
            status: 'active',
            ownerId: ctx.ownerId,
            epoch: 1,
            heartbeatAt: now,
            leaseExpiresAt: now + WRITE_TTL
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
        var stopHeartbeat = startHeartbeat(db, ownerId, ctx.epoch);

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

  function status() {
    var out = {
      readOnly: true,
      marker: readMarker(),
      markerKeyPresent: false,
      migration: null,
      writer: null,
      tables: null,
      mode: 'unknown'
    };
    try { out.markerKeyPresent = global.localStorage.getItem(MARKER_KEY) !== null; } catch (e) {}

    if (!global.OLDB) return Promise.resolve(out);

    return global.OLDB.inspect().then(function (rep) {
      out.existence = rep.existence;
      if (rep.existence !== 'exists') {
        out.mode = rep.existence === 'not-exists' ? 'ls' : 'unknown';
        return out;
      }
      out.tables = rep.tables;
      if (rep.meta) {
        out.migration = rep.meta.infra.migration.present ? rep.meta.infra.migration : null;
        out.writer = rep.meta.infra.writer.present ? rep.meta.infra.writer : null;
      }
      if (out.migration && out.migration.status === 'done') out.mode = 'idb';
      else if (out.migration && out.migration.status === 'in_progress') out.mode = 'in_progress';
      else if (out.migration && out.migration.status === 'failed') out.mode = 'failed';
      else out.mode = 'unmigrated';
      return out;
    }, function (e) {
      out.mode = 'unavailable';
      out.error = (e && e.message) || String(e);
      return out;
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
    /* 写入权：Step 5 接线 save() 前先独立实现，本阶段只提供 API 与测试 */
    assertWriteLease: assertWriteLease,
    renewWriteLease: renewWriteLease,
    /* 供测试与人工恢复使用，不自动调用 */
    startHeartbeat: function (ownerId, epoch) {
      var db = global.OLDB && global.OLDB.instance();
      if (!db) return function () {};
      return startHeartbeat(db, ownerId, epoch);
    },
    markFailed: function (ownerId, epoch, errorCode, summary) {
      var db = global.OLDB && global.OLDB.instance();
      if (!db) return Promise.resolve({ ok: false, reason: 'db-not-open' });
      return markMigrationFailed(db, ownerId, epoch, errorCode, summary);
    }
  };

  global.OLMigrate = api;
})(typeof window !== 'undefined' ? window : this);
