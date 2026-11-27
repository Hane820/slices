/* startup.js — 首次启动的旧数据探测（只判断，不写库、不建库）
 *
 * 与两态设计一致：探测结果不是空间身份，只决定"认领 / 新建 / 阻断"：
 *   has-data —— 发现旧版正式库（earthonline）里有数据，或 localStorage 旧键有数据
 *               → 以 guest 身份认领，库原地不动，零复制
 *   empty    —— 确认既没有旧库数据也没有旧键数据 → 新建 earthonline-guest
 *   unknown  —— 无法确认（databases() 不可用 / 超时 / 读库出错）
 *               → 阻断，绝不自作主张新建空库或覆盖旧数据
 *
 * 硬约束：
 *   1. 绝不使用 indexedDB.open() 去"看看库在不在" —— 不存在会被凭空创建。
 *      先用 databases() 确认存在，才允许 open。
 *   2. 只读事务，任何写操作都不在本模块里。
 *   3. 1500ms 超时；超时按 unknown 处理，不按空库处理。
 *   4. 不碰身份模块（identity.js 已落定的记录绝不被探测覆盖）。
 */
(function (global) {
  'use strict';

  var FORMAL_DB = 'earthonline';
  var OLD_KEY = 'earthonline-v4';
  var TIMEOUT = 1500;
  var TABLES = ['definitions', 'tasks', 'schedule', 'dayEntries', 'dayMaps'];

  function verdict(v, detectedBy, reason) {
    return { verdict: v, detectedBy: detectedBy || 'none', reason: reason || null };
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('detect-timeout'));
      }, ms);
      promise.then(function (v) {
        if (done) return;
        done = true; clearTimeout(t); resolve(v);
      }, function (e) {
        if (done) return;
        done = true; clearTimeout(t); reject(e);
      });
    });
  }

  /* databases() 不存在或调用失败一律 unknown —— 此时无法证明"没有旧库"。 */
  function listDatabases() {
    return new Promise(function (resolve, reject) {
      var idb = global.indexedDB;
      if (!idb || typeof idb.databases !== 'function') { reject(new Error('databases-unsupported')); return; }
      var req;
      try { req = idb.databases(); } catch (e) { reject(e); return; }
      if (!req || typeof req.then !== 'function') { reject(new Error('databases-invalid')); return; }
      req.then(function (list) {
        if (!Array.isArray(list)) { reject(new Error('databases-invalid-result')); return; }
        resolve(list.map(function (x) { return x && x.name ? String(x.name) : ''; }).filter(Boolean));
      }, reject);
    });
  }

  /* 只在库已确认存在时调用。open 用默认版本（不指定 version），不会触发升级。 */
  function readOldDb() {
    return new Promise(function (resolve, reject) {
      var req;
      try { req = global.indexedDB.open(FORMAL_DB); }
      catch (e) { reject(e); return; }

      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { req.result && req.result.close(); } catch (e) {}
        reject(new Error('old-db-timeout'));
      }, TIMEOUT);

      function finish(result, err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve(result);
      }

      req.onsuccess = function () {
        var db = req.result;
        var names = [];
        try { names = Array.prototype.slice.call(db.objectStoreNames); } catch (e) { db.close(); finish(null, e); return; }
        var missing = TABLES.filter(function (n) { return names.indexOf(n) < 0; });
        if (missing.length) { db.close(); finish({ hasData: false, schemaUnknown: true, missing: missing }); return; }
        var tx;
        try { tx = db.transaction(TABLES.concat(['meta']), 'readonly'); }
        catch (e) { db.close(); finish(null, e); return; }
        var jobs = TABLES.map(function (n) {
          return new Promise(function (res, rej) {
            try {
              var r = tx.objectStore(n).count();
              r.onsuccess = function () { res(r.result); };
              r.onerror = function () { rej(r.error || new Error('count-failed')); };
            } catch (e) { rej(e); }
          });
        });
        jobs.push(new Promise(function (res, rej) {
          try {
            var r = tx.objectStore('meta').get('schemaVersion');
            r.onsuccess = function () { res(r.result ? r.result.value : null); };
            r.onerror = function () { rej(r.error || new Error('meta-failed')); };
          } catch (e) { rej(e); }
        }));
        Promise.all(jobs).then(function (vals) {
          var counts = vals.slice(0, TABLES.length);
          var total = counts.reduce(function (a, b) { return a + (b || 0); }, 0);
          var byTable = {};
          TABLES.forEach(function (n, i) { byTable[n] = counts[i]; });
          finish({ hasData: total > 0, total: total, byTable: byTable, schemaVersion: vals[vals.length - 1] });
        }, function (e) { finish(null, e); }).then(function () { db.close(); });
      };
      req.onerror = function () { finish(null, req.error || new Error('old-db-open-failed')); };
      req.onblocked = function () { finish(null, new Error('old-db-blocked')); };
    });
  }

  function oldLocalStorageHasData() {
    try {
      var ls = global.localStorage;
      if (!ls) return { known: false };
      var raw = ls.getItem(OLD_KEY);
      if (raw === null) return { known: true, value: false };
      if (typeof raw !== 'string' || !raw.trim()) return { known: true, value: false };
      /* 只认"看起来像旧版存档"的内容，避免一个空壳键把新用户判成老用户 */
      var looksLikeState = raw.trim().charAt(0) === '{' || raw.indexOf('"tasks"') >= 0 || raw.indexOf('settings') >= 0;
      return { known: true, value: looksLikeState };
    } catch (e) { return { known: false }; }
  }

  /* 唯一的公开入口。永不抛错：所有异常都收敛成 unknown。 */
  function detectOldData() {
    return withTimeout(listDatabases(), TIMEOUT).then(function (names) {
      var hasFormal = names.indexOf(FORMAL_DB) >= 0;
      var ls = oldLocalStorageHasData();

      if (hasFormal) {
        return readOldDb().then(function (info) {
          if (!info) return verdict('unknown', 'idb', 'old-db-read-failed');
          if (info.hasData) return verdict('has-data', 'idb', 'old-db-has-rows');
          if (info.schemaUnknown) return verdict('unknown', 'idb', 'old-db-schema-mismatch');
          /* 库存在但六表为空：旧键有数据仍算 has-data（迁移中断的现场） */
          if (ls.known && ls.value) return verdict('has-data', 'localStorage', 'old-key-has-data');
          return verdict('empty', 'idb', 'old-db-empty');
        }).catch(function (e) {
          return verdict('unknown', 'idb', (e && e.message) || 'old-db-error');
        });
      }

      if (!ls.known) return verdict('unknown', 'none', 'databases-known-but-storage-unreadable');
      if (ls.value) return verdict('has-data', 'localStorage', 'old-key-has-data');
      return verdict('empty', 'databases', 'no-old-db-no-old-key');
    }).catch(function (e) {
      /* databases() 不可用：不能证明无旧库。此时若旧键明确有数据仍可认领，否则 unknown。 */
      var ls = oldLocalStorageHasData();
      if (ls.known && ls.value) return verdict('has-data', 'localStorage', 'databases-unavailable-old-key');
      return verdict('unknown', 'none', (e && e.message) || 'detect-failed');
    });
  }

  global.OLStartup = { detectOldData: detectOldData, OLD_KEY: OLD_KEY, FORMAL_DB: FORMAL_DB, TIMEOUT: TIMEOUT };
})(typeof window !== 'undefined' ? window : this);
