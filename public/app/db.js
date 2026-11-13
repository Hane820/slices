/* db.js — IndexedDB 数据层（Dexie）基础模块
 *
 * 本文件只做四件事：
 *   1) 声明数据库名、版本、六张表的 store/索引（严格照 Phase 0.5 / Step 4 设计文档 §8）
 *   2) 安全启动：显式 open（单飞去重）、close、再次 open、状态查询、生命周期事件
 *   3) 只读自省：inspect() 查六表是否存在 / 记录数 / meta 基础设施状态 / 版本
 *   4) 暴露只读常量（路由字段取值、meta key 白名单），供后续迁移与校验复用
 *
 * 明确不做（留给后续步骤）：
 *   - 不读取、不写入任何业务数据；不实现 hydrate / commit / 迁移
 *   - 不读写 localStorage，不碰全局 `S`，不改任何 UI 或业务函数
 *   - 模块加载时**不打开**数据库；open() 只由调用方显式触发
 *   - IndexedDB 不可用时不降级、不兜底、不吞错误：如实返回 unsupported / error
 *
 * 依赖：vendor/dexie.min.js（Dexie 4.4.7，UMD，Apache-2.0），必须先于本文件加载。
 */
(function (global) {
  'use strict';

  var DB_NAME = 'earthonline';
  var DB_VERSION = 1;          /* Dexie 声明版本；原生 IDBDatabase.version 会显示 10（Dexie 内部 ×10 编码） */
  var OPEN_TIMEOUT = 12000;    /* open() 的兜底超时，防「既不成功也不失败」把调用方吊死 */

  /* 六张表：主键 / 复合主键 / 索引，逐字对应设计文档 §8 的 db.version(1).stores({...})。
     顺序也有意义：Dexie 按对象键顺序创建 store，保持与文档一致便于比对。 */
  var STORES = {
    meta:        'key',                                            // 配置、版本、迁移状态（key 为主键）
    definitions: '[kind+id], kind',                                // pens / tags / suggestions
    tasks:       'id, cat, createdAt',                             // tasks（done/doneTime 内嵌不拆）
    schedule:    'id, weekday, date',                              // schedule
    dayEntries:  '[type+id], [type+date], date, ts, updatedAt',     // 8 类按日记录
    dayMaps:     '[kind+date], date'                               // notes / marks / doneSugg
  };
  var STORE_NAMES = Object.keys(STORES);

  /* 路由字段取值：只读常量，供后续迁移写入与接管校验使用。本步骤不校验、不写入。 */
  var ENTRY_TYPES = ['plan', 'tagLog', 'workout', 'studyLog', 'decision', 'flash', 'itemLog', 'restDay'];
  var DEF_KINDS   = ['pen', 'tag', 'suggestion'];
  var MAP_KINDS   = ['note', 'mark', 'doneSugg'];

  /* meta 的 key 白名单：固定 8 个，精确匹配（设计文档 §13.5.2.2）。
     新增 key 必须显式改这里 + 加验收，不接受任何前缀/正则通配。 */
  var META_KEYS = {
    v: 'payload', settings: 'payload', plugins: 'payload',
    schemaVersion: 'infra', migration: 'infra', writer: 'infra',
    preNormalize: 'infra', bizDatePolicy: 'infra'
  };
  var INFRA_KEYS   = ['schemaVersion', 'migration', 'writer', 'preNormalize', 'bizDatePolicy'];
  var PAYLOAD_KEYS = ['v', 'settings', 'plugins'];

  var state = {
    supported: null,      // null=未探测 / true / false（只缓存 true，避免过早把 false 钉死）
    status: 'idle',       // idle | opening | open | closed | blocked | error | version-error | unsupported
    lastError: null,
    openedAt: null,
    closedReason: null,   // manual | versionchange | closed
    nativeVersion: null   // 原生 IDBDatabase.version（首次成功打开/自省后记录）
  };

  /* 仅用于自检与观测：calls=公开调用次数，runs=真正发起的打开次数（并发去重后应远小于 calls） */
  var stats = { calls: 0, runs: 0, failures: 0 };

  var db = null;            // Dexie 实例，惰性创建
  var openPromise = null;   // 单飞：并发 open 共享同一个 Promise
  var listeners = [];
  var pendingReject = null; // 仅 open 期间有效，供 blocked 事件提前失败
  var upgradeAbort = null;  // 受控 Factory 在 upgradeneeded 里拦下的原因（null=未拦）

  function hasIndexedDB() {
    try { return typeof global.indexedDB !== 'undefined' && global.indexedDB !== null; }
    catch (e) { return false; }
  }

  function hasDexie() {
    return typeof global.Dexie !== 'undefined' && typeof global.Dexie === 'function';
  }

  function isSupported() {
    if (state.supported === true) return true;
    state.supported = hasIndexedDB() && hasDexie();
    return state.supported;
  }

  function makeError(name, message, code, cause) {
    var err = new Error(message || name);
    err.name = name;
    err.code = code || name;
    if (cause) err.cause = cause;
    return err;
  }

  function emit(type, detail) {
    var snapshot = listeners.slice();
    for (var i = 0; i < snapshot.length; i++) {
      try { snapshot[i]({ type: type, detail: detail || null, status: status() }); }
      catch (e) { /* 订阅方异常不影响数据层 */ }
    }
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /* 受控 IDBFactory：唯一目的是在**升级事务内部**做最后一道拦截。
     预检与 Dexie 打开之间必然存在时间窗口（另一个标签页可能刚好升级），
     所以不能只靠「打开前读一次版本」。这里在 upgradeneeded 时按 oldVersion 判断：
       - oldVersion > 本页声明版本 → 立刻 abort（版本事务整体回滚，库不会被改动）
       - oldVersion === 声明版本 但缺表 → 同样 abort（阻止 Dexie 的 SchemaDiff 自动 +1 补表）
       - oldVersion < 声明版本（含 0=首次创建）→ 放行，属于正常升级/建库
     abort 是 IndexedDB 规范保证的回滚：版本号与已建 store 一起撤回。 */
  function makeGuardedFactory() {
    var real = global.indexedDB;
    if (!real) return null;

    var factory = {
      open: function (name, version) {
        var req = (typeof version === 'number') ? real.open(name, version) : real.open(name);
        try {
          req.addEventListener('upgradeneeded', function (ev) {
            var oldV = (ev && typeof ev.oldVersion === 'number') ? ev.oldVersion : 0;
            var target = DB_VERSION * 10;

            if (oldV > target) {
              upgradeAbort = 'higher-version:' + oldV;
              try { req.transaction.abort(); } catch (e) {}
              return;
            }
            if (oldV === target) {
              var names = [];
              try { names = Array.prototype.slice.call(req.result.objectStoreNames); } catch (e) {}
              var missing = STORE_NAMES.filter(function (n) { return names.indexOf(n) < 0; });
              if (missing.length) {
                upgradeAbort = 'schema-mismatch:' + missing.join(',');
                try { req.transaction.abort(); } catch (e) {}
              }
            }
          });
        } catch (e) { /* 老浏览器不支持 addEventListener 时退化为无拦截，由预检兜底 */ }
        return req;
      },
      deleteDatabase: function (name) { return real.deleteDatabase(name); },
      cmp: function (a, b) { return real.cmp(a, b); }
    };
    if (typeof real.databases === 'function') {
      factory.databases = function () { return real.databases(); };
    }
    return factory;
  }

  /* 只建实例、不打开。Dexie 在构造时不触碰 IndexedDB，不会产生任何副作用。 */
  function instance() {
    if (!isSupported()) return null;
    if (db) return db;
    if (!hasDexie()) return null;

    var factory = makeGuardedFactory();
    if (!factory) return null;

    db = new global.Dexie(DB_NAME, { indexedDB: factory, IDBKeyRange: global.IDBKeyRange });
    db.version(DB_VERSION).stores(STORES);

    /* 别的标签页要升级结构：本页主动让路，并让调用方知道连接被动断开 */
    db.on('versionchange', function (ev) {
      try { db.close(); } catch (e) {}
      db = null;
      state.status = 'closed';
      state.closedReason = 'versionchange';
      state.lastError = makeError(
        'VersionChangeError',
        '数据库结构已被其它标签页升级，本页连接已关闭；请刷新',
        'versionchange'
      );
      emit('versionchange', ev);
    });

    /* 被别的连接阻塞（通常发生在需要升级版本时）：记录并让等待方立即失败，不重试 */
    db.on('blocked', function () {
      state.status = 'blocked';
      var err = makeError('BlockedError', '数据库被其它标签页占用，打开被阻塞', 'blocked');
      state.lastError = err;
      emit('blocked', err);
      if (pendingReject) pendingReject(err);
    });

    /* 连接被关闭（主动或意外）：只有仍处于 open 时才视为「意外关闭」 */
    db.on('close', function () {
      if (state.status === 'open') {
        state.status = 'closed';
        state.closedReason = state.closedReason || 'closed';
        emit('closed');
      }
    });

    return db;
  }

  function status() {
    return {
      name: DB_NAME,
      version: DB_VERSION,
      dexieVersion: db ? safeVerno() : null,
      nativeVersion: state.nativeVersion,
      supported: isSupported(),
      hasIndexedDB: hasIndexedDB(),
      hasDexie: hasDexie(),
      status: state.status,
      openedAt: state.openedAt,
      closedReason: state.closedReason,
      opens: { calls: stats.calls, runs: stats.runs, failures: stats.failures },
      lastUpgradeAbort: upgradeAbort,
      lastError: state.lastError
        ? { name: state.lastError.name, message: state.lastError.message, code: state.lastError.code || null }
        : null
    };
  }

  function safeVerno() {
    try { return typeof db.verno === 'number' ? db.verno : null; } catch (e) { return null; }
  }

  function safeNativeVersion() {
    try {
      if (db && db.idbdb && typeof db.idbdb.version === 'number') return db.idbdb.version;
    } catch (e) {}
    return null;
  }

  /* 只读预检原生版本：不存在 / 不可判定时返回 null；存在则返回 IDBDatabase.version。
     不带版本号打开，不会触发升级；万一触发 upgrade 立刻 abort，绝不建库、绝不改结构。 */
  function preflightVersion() {
    return exists().then(function (ex) {
      if (ex !== 'yes') return null;
      return new Promise(function (resolve) {
        var req;
        try { req = global.indexedDB.open(DB_NAME); }
        catch (e) { resolve(null); return; }

        var aborted = false;
        req.onupgradeneeded = function (ev) {
          aborted = true;
          try { ev.target.transaction.abort(); } catch (e) {}
        };
        req.onblocked = function () { resolve(null); };
        req.onerror = function () { resolve(null); };
        req.onsuccess = function () {
          var v = req.result.version;
          try { req.result.close(); } catch (e) {}
          resolve(aborted ? null : v);
        };
      });
    }, function () { return null; });
  }

  /* 打开（首次调用按 DB_VERSION 建库建表；只建结构，不写任何业务数据）。
     并发调用共享同一个 Promise，不会重复初始化。 */
  function open(opts) {
    stats.calls++;
    opts = opts || {};

    if (!isSupported()) {
      state.status = 'unsupported';
      state.lastError = makeError(
        'UnsupportedError',
        hasIndexedDB() ? 'Dexie 未加载' : '浏览器不支持 IndexedDB',
        'unsupported'
      );
      stats.failures++;
      emit('unsupported', state.lastError);
      return Promise.reject(state.lastError);
    }
    if (state.status === 'open' && db && db.isOpen()) return Promise.resolve(api);
    if (openPromise) { emit('open-deduped'); return openPromise; }

    var timeout = (typeof opts.timeout === 'number' && opts.timeout > 0) ? opts.timeout : OPEN_TIMEOUT;
    var settled = false;

    stats.runs++;
    state.status = 'opening';
    state.lastError = null;
    upgradeAbort = null;
    emit('opening');

    var p = new Promise(function (resolve, reject) {
      var timer = null;

      function fail(err) {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        pendingReject = null;
        stats.failures++;
        state.lastError = err;
        state.status = (err.code === 'version-error') ? 'version-error'
                     : (err.code === 'blocked') ? 'blocked'
                     : (err.code === 'unsupported') ? 'unsupported'
                     : 'error';
        /* 这几种失败后 Dexie 实例可能停在半开状态，丢掉它，下次 open 重新建 */
        if (err.code === 'blocked' || err.code === 'version-error' || err.code === 'open-failed') {
          try { if (db) db.close(); } catch (e) {}
          db = null;
        }
        emit('error', err);
        reject(err);
      }

      pendingReject = fail;
      if (timeout > 0) {
        timer = setTimeout(function () {
          fail(makeError('TimeoutError', '打开数据库超时（' + timeout + 'ms）', 'timeout'));
        }, timeout);
      }

      /* 真正交给 Dexie 打开 */
      function beginOpen() {
        if (settled) return;
        var inst;
        try { inst = instance(); }
        catch (e) { fail(makeError('OpenFailedError', (e && e.message) || '创建 Dexie 实例失败', 'open-failed', e)); return; }
        if (!inst) { fail(makeError('UnsupportedError', 'Dexie 不可用', 'unsupported')); return; }

        inst.open().then(function () {
          /* 打开后再验一次：受控 Factory 理论上已拦下更高版本；这里是「万一」的最后一道断言 */
          var nv = safeNativeVersion();
          if (!settled && nv !== null && nv > DB_VERSION * 10) {
            try { inst.close(); } catch (e) {}
            db = null;
            fail(makeError(
              'VersionError',
              '打开后原生版本（' + nv + '）高于本页声明（' + (DB_VERSION * 10) + '），已断开连接',
              'version-error'
            ));
            return;
          }
          if (settled) {   /* 已超时/已判失败后才打开成功：只同步状态，不改写已返回的结果 */
            state.status = 'open';
            state.openedAt = Date.now();
            state.lastError = null;
            state.nativeVersion = nv;
            emit('open-late');
            return;
          }
          settled = true;
          if (timer) { clearTimeout(timer); timer = null; }
          pendingReject = null;
          state.status = 'open';
          state.openedAt = Date.now();
          state.closedReason = null;
          state.lastError = null;
          state.nativeVersion = nv;
          emit('open');
          resolve(api);
        }, function (err) {
          /* 受控 Factory 在升级事务里主动 abort 的情况，统一报 version-error */
          if (upgradeAbort) {
            var parts = upgradeAbort.split(':');
            var msg = (parts[0] === 'higher-version')
              ? '数据库已被其它标签页升级到版本 ' + parts[1] + '（本页声明 ' + (DB_VERSION * 10) + '），已拒绝打开且未改动该库'
              : '数据库结构与本页不一致（缺少表：' + (parts[1] || '') + '），已阻止自动改表';
            fail(makeError('VersionError', msg, 'version-error', err));
            return;
          }
          var code = (err && err.name === 'VersionError') ? 'version-error'
                   : (err && err.name === 'BlockedError') ? 'blocked'
                   : 'open-failed';
          fail(makeError((err && err.name) || 'OpenFailedError', (err && err.message) || '打开数据库失败', code, err));
        });
      }

      /* 预检：Dexie 遇到版本冲突会「重试一次 + 自动把原生版本 +1」补表（内部 SchemaDiff workaround），
         那等于静默改动一个更高版本的库。所以先自己读原生版本，高于本页脚本声明值就直接拒绝，不交给 Dexie。 */
      preflightVersion().then(function (nativeV) {
        if (settled) return;
        if (nativeV !== null && nativeV > DB_VERSION * 10) {
          fail(makeError(
            'VersionError',
            '数据库版本（' + nativeV + '）高于本页脚本（' + (DB_VERSION * 10) + '）；请刷新页面或更新到新版本',
            'version-error'
          ));
          return;
        }
        if (nativeV !== null) state.nativeVersion = nativeV;
        beginOpen();
      }, function () {
        beginOpen();   /* 预检不可用时不阻塞：Dexie 自己也会判版本 */
      });
    });

    openPromise = p;
    /* 结算后释放去重槽位（异步执行，避免与同步失败竞态） */
    p.then(function () { if (openPromise === p) openPromise = null; },
           function () { if (openPromise === p) openPromise = null; });
    return p;
  }

  function close() {
    state.closedReason = 'manual';
    var doClose = function () {
      if (db) { try { db.close(); } catch (e) {} }
      /* 丢弃实例：关闭后的 Dexie 仍缓存着关闭时的 schema，若库被外部删除或重建，
         复用它会拿到不存在的 store（NotFoundError）。下次 open() 重新构造即可。 */
      db = null;
      state.status = 'closed';
      emit('closed');
      return api;
    };
    if (openPromise) {
      return openPromise.then(function () { return doClose(); }, function () { return doClose(); });
    }
    if (!db) { state.status = 'closed'; return Promise.resolve(api); }
    return Promise.resolve(doClose());
  }

  /* ---------- 只读自省 ---------- */

  /* 判断库是否存在：三态 'yes' | 'no' | 'unknown'。
     绝不通过「打开一个不存在的库」来判断——那会把它创建出来。
     没有 indexedDB.databases() 时返回 'unknown'，**不得当作不存在**。 */
  function exists() {
    if (!hasIndexedDB()) return Promise.resolve('unknown');
    try {
      if (typeof global.indexedDB.databases !== 'function') return Promise.resolve('unknown');
      return global.indexedDB.databases().then(function (list) {
        var arr = list || [];
        for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].name === DB_NAME) return 'yes';
        return 'no';
      }, function () { return 'unknown'; });
    } catch (e) { return Promise.resolve('unknown'); }
  }

  /* 能否直接读：已经持有打开中的连接时，存在性是确定的，不必依赖 databases() */
  function nativeReadable() {
    if (db && db.isOpen()) return Promise.resolve('yes');
    return exists();
  }

  /* 只读打开原生连接；确认存在后才调用。万一触发 upgrade 立刻 abort，绝不建库。 */
  function openNativeReadonly() {
    return new Promise(function (resolve, reject) {
      var req;
      try { req = global.indexedDB.open(DB_NAME); }
      catch (e) { reject(makeError('OpenFailedError', '打开原生连接失败', 'open-failed', e)); return; }

      var aborted = false;
      req.onupgradeneeded = function (ev) {
        aborted = true;
        try { ev.target.transaction.abort(); } catch (e) {}
      };
      req.onblocked = function () {
        reject(makeError('BlockedError', '读取结构时被其它标签页阻塞', 'blocked'));
      };
      req.onerror = function () {
        reject(makeError('OpenFailedError', (req.error && req.error.message) || '读取数据库失败', 'open-failed', req.error));
      };
      req.onsuccess = function () {
        var raw = req.result;
        if (aborted) {
          try { raw.close(); } catch (e) {}
          reject(makeError('NotFoundError', '数据库不存在（已阻止创建）', 'not-found'));
          return;
        }
        resolve(raw);
      };
    });
  }

  function summarizeInfra(key, val) {
    if (val === undefined || val === null) return { present: false };
    if (key === 'schemaVersion') return { present: true, value: val };
    if (key === 'bizDatePolicy')  return { present: true, value: val };
    if (key === 'preNormalize')   return { present: true, bytes: (val && typeof val.raw === 'string') ? val.raw.length : null };
    if (key === 'migration') {
      return {
        present: true,
        status: val.status || null,
        phase: val.phase || null,
        epoch: (typeof val.epoch === 'number') ? val.epoch : null,
        ownerId: val.ownerId || null,
        leaseExpiresAt: (typeof val.leaseExpiresAt === 'number') ? val.leaseExpiresAt : null,
        attempts: (typeof val.attempts === 'number') ? val.attempts : null,
        errorCode: val.errorCode || null
      };
    }
    if (key === 'writer') {
      return {
        present: true,
        ownerId: val.ownerId || null,
        epoch: (typeof val.epoch === 'number') ? val.epoch : null,
        leaseExpiresAt: (typeof val.leaseExpiresAt === 'number') ? val.leaseExpiresAt : null
      };
    }
    return { present: true };
  }

  /* 只读检查：六张表是否存在、各表记录数、meta 基础设施状态、数据库版本。
     不写任何业务数据；不创建数据库；全流程只用 readonly 事务。 */
  function inspect() {
    if (!hasIndexedDB()) {
      return Promise.reject(makeError('UnsupportedError', '浏览器不支持 IndexedDB', 'unsupported'));
    }
    return nativeReadable().then(function (ex) {
      var base = {
        name: DB_NAME,
        declaredVersion: DB_VERSION,
        queriedAt: Date.now(),
        readOnly: true,
        dexieOpen: !!(db && db.isOpen())
      };

      if (ex === 'no') {
        base.exists = false;
        base.existence = 'not-exists';
        base.reason = '数据库尚未创建（未调用过 open()）';
        base.version = null;
        base.tables = {};
        base.missingTables = STORE_NAMES.slice();
        base.meta = null;
        return base;
      }
      if (ex === 'unknown') {
        base.exists = null;
        base.existence = 'unknown';
        base.reason = 'indexedDB.databases() 不可用，无法在不创建库的前提下判定存在性；按 unknown 处理，不视为不存在';
        base.version = null;
        base.tables = {};
        base.missingTables = null;
        base.meta = null;
        return base;
      }

      return openNativeReadonly().then(function (raw) {
        return new Promise(function (resolve, reject) {
          var names = Array.prototype.slice.call(raw.objectStoreNames);
          var missing = STORE_NAMES.filter(function (n) { return names.indexOf(n) < 0; });

          base.exists = true;
          base.existence = 'exists';
          base.version = raw.version;          /* 原生版本：1 声明 → 10 */
          base.tables = {};
          base.missingTables = missing;
          base.meta = null;

          var tx;
          try { tx = raw.transaction(names, 'readonly'); }
          catch (e) {
            try { raw.close(); } catch (e2) {}
            reject(makeError('InspectFailedError', '只读事务创建失败：' + ((e && e.message) || e), 'inspect-failed', e));
            return;
          }

          var pending = 0;
          var finished = false;
          function finish() {
            if (finished || pending !== 0) return;
            finished = true;
            try { raw.close(); } catch (e) {}
            resolve(base);
          }

          STORE_NAMES.forEach(function (n) {
            if (missing.indexOf(n) >= 0) { base.tables[n] = { exists: false, count: null }; return; }
            pending++;
            try {
              var req = tx.objectStore(n).count();
              req.onsuccess = function () {
                base.tables[n] = { exists: true, count: req.result };
                pending--; finish();
              };
              req.onerror = function () {
                base.tables[n] = { exists: true, count: null, error: 'count-failed' };
                pending--; finish();
                try { req.transaction.abort(); } catch (e) {}
              };
            } catch (e) {
              base.tables[n] = { exists: true, count: null, error: String((e && e.message) || e) };
              pending--; finish();
            }
          });

          if (missing.indexOf('meta') < 0) {
            var metaStore;
            try { metaStore = tx.objectStore('meta'); } catch (e) { metaStore = null; }
            if (metaStore) {
              var keys = INFRA_KEYS.concat(PAYLOAD_KEYS);
              var got = {};
              pending++;
              var left = keys.length;
              keys.forEach(function (k) {
                var r = metaStore.get(k);
                r.onsuccess = function () {
                  got[k] = summarizeInfra(k, r.result);
                  if (--left === 0) {
                    base.meta = {
                      infra: {
                        schemaVersion: got.schemaVersion || { present: false },
                        migration:     got.migration || { present: false },
                        writer:        got.writer || { present: false },
                        preNormalize:  got.preNormalize || { present: false },
                        bizDatePolicy: got.bizDatePolicy || { present: false }
                      },
                      payload: {
                        v:        !!(got.v && got.v.present),
                        settings: !!(got.settings && got.settings.present),
                        plugins:  !!(got.plugins && got.plugins.present)
                      }
                    };
                    pending--; finish();
                  }
                };
                r.onerror = function () {
                  got[k] = { present: false, error: 'read-failed' };
                  if (--left === 0) { base.meta = { infra: got, payload: null, partial: true }; pending--; finish(); }
                };
              });
            }
          }

          finish();
        });
      });
    });
  }

  /* 结构自省：用原生 IndexedDB 读真实 keyPath / 索引，避免「回读 Dexie 元数据」式自证。
     库不存在时直接返回 exists:false，不会创建它。 */
  function dumpSchema() {
    if (!hasIndexedDB()) {
      return Promise.reject(makeError('UnsupportedError', '浏览器不支持 IndexedDB', 'unsupported'));
    }
    return nativeReadable().then(function (ex) {
      if (ex === 'no') return { exists: false, existence: 'not-exists', name: DB_NAME, stores: {}, reason: '数据库尚未创建' };
      if (ex === 'unknown') return { exists: null, existence: 'unknown', name: DB_NAME, stores: {}, reason: '无法在不创建库的前提下判定存在性（不视为不存在）' };

      return openNativeReadonly().then(function (raw) {
        var names = Array.prototype.slice.call(raw.objectStoreNames);
        var out = {};
        var tx;
        try { tx = raw.transaction(names, 'readonly'); }
        catch (e) { try { raw.close(); } catch (e2) {} throw e; }

        names.forEach(function (name) {
          var store = tx.objectStore(name);
          var indexes = [];
          for (var i = 0; i < store.indexNames.length; i++) {
            var iname = store.indexNames[i];
            var ix = store.index(iname);
            indexes.push({ name: iname, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry });
          }
          out[name] = { keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: indexes };
        });

        var result = { exists: true, existence: 'exists', name: raw.name, version: raw.version, declaredVersion: DB_VERSION, stores: out };
        try { raw.close(); } catch (e) {}
        return result;
      });
    });
  }

  var api = {
    NAME: DB_NAME,
    VERSION: DB_VERSION,
    STORES: STORES,
    STORE_NAMES: STORE_NAMES.slice(),
    ENTRY_TYPES: ENTRY_TYPES.slice(),
    DEF_KINDS: DEF_KINDS.slice(),
    MAP_KINDS: MAP_KINDS.slice(),
    META_KEYS: Object.keys(META_KEYS),
    INFRA_KEYS: INFRA_KEYS.slice(),
    PAYLOAD_KEYS: PAYLOAD_KEYS.slice(),
    OPEN_TIMEOUT: OPEN_TIMEOUT,
    isSupported: isSupported,
    status: status,
    open: open,
    close: close,
    inspect: inspect,
    dumpSchema: dumpSchema,
    exists: exists,
    subscribe: subscribe,
    /* 供后续步骤 / 调试使用；本步骤不自动调用 */
    instance: function () { return db; }
  };

  global.OLDB = api;
})(typeof window !== 'undefined' ? window : this);
