/* guest.js — 游客数据空间：演示数据初始化 + 清空（只碰 earthonline-guest）
 *
 * 隔离约定（都是运行时硬检查，不是注释承诺）：
 *   1) 只认 OLDB.NAME === 'earthonline-guest'；库名不符一律拒绝操作，绝不"顺手"写正式库。
 *   2) 演示数据来自 defaults()（presets.js 的静态种子），不读 localStorage、不读正式库、
 *      不从正式数据复制任何一条记录。
 *   3) 初始化在单个读写事务里完成，进事务先查 schemaVersion：已有就直接返回，
 *      所以重复启动 / 多标签页同时初始化都不会覆盖用户已经改过的游客数据。
 *   4) 清空只 deleteDatabase('earthonline-guest')，不碰 earthonline、不碰
 *      正式库的迁移标记 / 备份状态等 localStorage 键；只清理游客自己命名的快照键。
 *
 * 依赖（都在它之前加载）：db.js（OLDB）、migrate.js（OLMigrate.buildRows）、
 * core.js（defaults）。
 */
(function (global) {
  'use strict';

  var GUEST_DB = 'earthonline-guest';
  var TABLES = ['meta', 'definitions', 'tasks', 'schedule', 'dayEntries', 'dayMaps'];
  var SNAPSHOT_PREFIX = GUEST_DB + '-backup-';   /* 游客自己的导入回滚快照前缀 */

  /* 默认游客有两种落点：
       1) 全新安装 → earthonline-guest（独立游客库）
       2) 旧数据认领 → earthonline（旧库原地接入 guest，零复制）
     第二种不是"游客能操作正式库"，而是身份已明确为 guest 且记录里带
     adoptedOldData:true；没有这个标记一律拒绝，防止误写用户数据。 */
  function isAdopted() {
    try {
      if (!global.OLIdentity || typeof global.OLIdentity.record !== 'function') return false;
      var r = global.OLIdentity.record();
      return !!(r && r.space === 'guest' && r.adoptedOldData === true && r.dbName === 'earthonline');
    } catch (e) { return false; }
  }

  function isGuestDb() {
    if (!global.OLDB) return false;
    if (global.OLDB.NAME === GUEST_DB) return true;
    return global.OLDB.NAME === 'earthonline' && isAdopted();
  }

  function instance() {
    if (!isGuestDb()) return null;
    return global.OLDB && typeof global.OLDB.instance === 'function' ? global.OLDB.instance() : null;
  }

  /* 建行之前先确认形状。OLMigrate.buildRows() 的返回值是 { rows, issues } —— 不是表映射，
     这是本轮 seed-failed（Cannot read properties of undefined (reading 'length')）的根因。
     这里把"取 rows"这一步显式化并逐表校验，拿到坏结构就在事务外失败，不留半截状态。 */
  function buildSeedRows() {
    /* 显式走 global：guest.js 的依赖只有 window 上的这几个模块，便于隔离测试 */
    var S0 = global.defaults();                /* 静态种子，与正式库无关 */
    if (!S0 || typeof S0 !== 'object') return { ok: false, reason: 'defaults-invalid' };

    var built = global.OLMigrate.buildRows(S0);
    var rows = built && built.rows;             /* 关键：取 built.rows */
    if (!rows || typeof rows !== 'object') return { ok: false, reason: 'buildrows-invalid' };

    for (var i = 0; i < TABLES.length; i++) {
      if (!Array.isArray(rows[TABLES[i]])) {
        return { ok: false, reason: 'buildrows-missing-table', table: TABLES[i] };
      }
    }
    return { ok: true, rows: rows, issues: (built.issues || []) };
  }

  /* 库里有数据但没有完成标记 = 上次初始化没走完。不覆盖、不删除，交给调用方报错并人工处理。 */
  function countRows(db) {
    var jobs = TABLES.map(function (n) { return db[n].count(); });
    return Promise.all(jobs).then(function (counts) {
      var total = 0, byTable = {}, i;
      for (i = 0; i < TABLES.length; i++) { byTable[TABLES[i]] = counts[i]; total += counts[i]; }
      return { total: total, byTable: byTable };
    });
  }

  /* 一个事务里：查 schemaVersion → 没有才灌种子。
     写 migration 行是必须的：write.js 的取权闸门要求 meta.migration.status === 'done'，
     缺了它游客空间会永远只读。这里写的 done 只表示"这个库已初始化"，不代表正式库迁移状态。
     任何一步失败，整个事务回滚 —— 包括 schemaVersion 与 migration 行，不会留下假的完成标记。 */
  function seed(db, rows, issues) {
    var stores = TABLES.map(function (n) { return db[n]; });
    return db.transaction('rw', stores[0], stores[1], stores[2], stores[3], stores[4], stores[5], function () {
      return db.meta.get('schemaVersion').then(function (row) {
        if (row) return { seeded: false };            /* 事务内二次确认：已有标记一个字都不动 */

        var now = Date.now();
        var chain = Promise.resolve();
        if (rows.meta.length) chain = chain.then(function () { return db.meta.bulkPut(rows.meta); });
        if (rows.definitions.length) chain = chain.then(function () { return db.definitions.bulkPut(rows.definitions); });
        if (rows.tasks.length) chain = chain.then(function () { return db.tasks.bulkPut(rows.tasks); });
        if (rows.schedule.length) chain = chain.then(function () { return db.schedule.bulkPut(rows.schedule); });
        if (rows.dayEntries.length) chain = chain.then(function () { return db.dayEntries.bulkPut(rows.dayEntries); });
        if (rows.dayMaps.length) chain = chain.then(function () { return db.dayMaps.bulkPut(rows.dayMaps); });
        /* 未知顶层字段（legacyExtras）不写：游客库只存当前 schema 认识的业务数据 */
        chain = chain.then(function () {
          return db.meta.put({ key: 'schemaVersion', value: global.OLMigrate.SCHEMA_VERSION });
        }).then(function () {
          return db.meta.put({
            key: 'migration', value: { seeded: true, at: now, issues: issues.length },
            status: 'done', phase: 'guest-seed',
            schemaVersion: global.OLMigrate.SCHEMA_VERSION,
            finishedAt: now, leaseExpiresAt: 0, ownerId: null,
            writeCounts: {
              meta: rows.meta.length,
              definitions: rows.definitions.length,
              tasks: rows.tasks.length,
              schedule: rows.schedule.length,
              dayEntries: rows.dayEntries.length,
              dayMaps: rows.dayMaps.length
            }
          });
        });
        return chain.then(function () { return { seeded: true }; });
      });
    });
  }

  /* 旧数据认领：库里已经有用户数据，绝不灌种子、绝不覆盖业务行。
     只补上写入闸门要求的基础设施行（schemaVersion / migration=done）。
     已有 migration 且 status!=='done' 时原样保留并阻断 —— 不替未完成的迁移签字。
     全部写在一个事务里，失败整体回滚。 */
  function adopt() {
    if (!isAdopted()) return Promise.resolve({ ok: false, reason: 'not-adopted' });
    var db = instance();
    if (!db) return Promise.resolve({ ok: false, reason: 'db-not-open' });

    var stores = TABLES.map(function (n) { return db[n]; });
    return db.transaction('rw', stores[0], stores[1], stores[2], stores[3], stores[4], stores[5], function () {
      return db.meta.get('migration').then(function (m) {
        if (m) {
          if (m.status === 'done') return { ok: true, adopted: false };
          return { ok: false, reason: 'migration-not-done', status: m.status };
        }
        return db.meta.get('schemaVersion').then(function (sv) {
          var chain = Promise.resolve();
          if (!sv) {
            chain = chain.then(function () {
              return db.meta.put({ key: 'schemaVersion', value: global.OLMigrate.SCHEMA_VERSION });
            });
          }
          return chain.then(function () {
            var now = Date.now();
            return db.meta.put({
              key: 'migration',
              value: { seeded: false, adoptedOldData: true, at: now, issues: 0 },
              status: 'done', phase: 'adopted-old',
              schemaVersion: global.OLMigrate.SCHEMA_VERSION,
              finishedAt: now, leaseExpiresAt: 0, ownerId: null,
              writeCounts: { meta: 0, definitions: 0, tasks: 0, schedule: 0, dayEntries: 0, dayMaps: 0 }
            });
          }).then(function () { return { ok: true, adopted: true }; });
        });
      });
    }).catch(function (e) {
      return { ok: false, reason: 'adopt-failed',
               message: ((e && e.name) || 'Error') + ': ' + ((e && e.message) || String(e)) };
    });
  }

  /* 启动前调用：打开游客库 → 必要则灌种子。返回 { ok, seeded, reason?, message? }
     失败一律给明确 reason（不含任何用户数据），并把原始错误留在控制台便于定位。 */
  function prepare() {
    if (!isGuestDb()) return Promise.resolve({ ok: false, reason: 'not-guest-db' });
    var db = instance();
    if (!db) return Promise.resolve({ ok: false, reason: 'db-not-open' });

    return db.meta.get('schemaVersion').then(function (row) {
      if (row) return { ok: true, seeded: false };
      return countRows(db).then(function (c) {
        if (c.total > 0) {
          console.error('[guest] 游客库有数据但没有完成标记，未覆盖：', JSON.stringify(c.byTable));
          return { ok: false, reason: 'incomplete-guest-db',
                   message: '库里有数据但缺少完成标记（未覆盖）：' + JSON.stringify(c.byTable) };
        }
        var built = buildSeedRows();
        if (!built.ok) {
          console.error('[guest] 种子行结构异常：' + built.reason + (built.table ? '（' + built.table + '）' : ''));
          return { ok: false, reason: built.reason, message: built.table ? '表 ' + built.table + ' 缺失' : '种子数据结构异常' };
        }
        if (built.issues.length) console.warn('[guest] 建行时记录到 ' + built.issues.length + ' 条路由冲突，已按原值写入');
        return seed(db, built.rows, built.issues).then(function (r) { return { ok: true, seeded: !!r.seeded }; });
      });
    }).catch(function (e) {
      /* 不吞：保留错误类型与消息（Dexie 的报错只含表名/键名，不含业务数据） */
      console.error('[guest] 初始化失败：', (e && e.name) || 'Error', (e && e.message) || String(e));
      return { ok: false, reason: 'seed-failed',
               message: ((e && e.name) || 'Error') + ': ' + ((e && e.message) || String(e)) };
    });
  }

  /* 只清游客库；正式库、正式库的迁移标记、云端备份状态一律不碰 */
  function clear() {
    if (!isGuestDb()) return Promise.resolve({ ok: false, reason: 'not-guest-db' });

    return new Promise(function (resolve) {
      var done = false;
      function finish(r) { if (!done) { done = true; resolve(r); } }

      /* 游客自己的快照键（如果有）一起清，不动正式库的 earthonline-v4 系列 */
      try {
        var ls = global.localStorage;
        if (ls) {
          for (var i = ls.length - 1; i >= 0; i--) {
            var k = ls.key(i);
            if (k && k.indexOf(SNAPSHOT_PREFIX) === 0) ls.removeItem(k);
          }
        }
      } catch (e) { /* localStorage 不可用：不影响删库 */ }

      function drop() {
        var req;
        try { req = global.indexedDB.deleteDatabase(GUEST_DB); }
        catch (e) { finish({ ok: false, reason: 'delete-throw' }); return; }
        req.onsuccess = function () { finish({ ok: true }); };
        req.onerror = function () { finish({ ok: false, reason: 'delete-failed' }); };
        req.onblocked = function () { finish({ ok: false, reason: 'delete-blocked' }); };
      }

      /* 先等连接真正关掉再删库，否则 deleteDatabase 会因为自己还连着而被 blocked */
      var closed;
      try {
        closed = (global.OLDB && typeof global.OLDB.close === 'function')
          ? Promise.resolve(global.OLDB.close())
          : Promise.resolve();
      } catch (e) { closed = Promise.resolve(); }
      closed.then(drop, drop);
    });
  }

  global.OLGuest = {
    NAME: GUEST_DB,
    SNAPSHOT_PREFIX: SNAPSHOT_PREFIX,
    isGuestDb: isGuestDb,
    isAdopted: isAdopted,
    adopt: adopt,
    prepare: prepare,
    clear: clear
  };
})(typeof window !== 'undefined' ? window : this);
