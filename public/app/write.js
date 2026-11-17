/* ============================================================
 * 地球online · 业务写入事务核心 + Writer 身份与生命周期（Step 5B / Task 4B）
 *
 * window.OLWrite 对外提供：
 *   - tabId           本标签页的独立身份（模块加载时生成，生命周期内不变）
 *   - wired           只读 getter，反映业务写入是否已接线；由 bootWriter 成功后
 *                     通过受控 activateWrites() 开放，初始化失败恒为 false
 *   - acquireWriter() 在单个 readwrite 事务内完成「首次取得 / 续期 / CAS 接管」
 *   - commit()        六表原子写入；显式 ownerId + epoch，且要求迁移已完成
 *   - startHeartbeat() / stopHeartbeat()  本标签页持有 writer 后的租约续期（周期下限 1000ms）
 *   - hasWriterLease() / writerLost()    本标签页写入权的只读状态
 *   - currentWriterIdentity()           当前标签页持有身份的只读摘要（新对象，非授权）
 *   - readBizRev()                      只读迁移后 bizRev 基线（writer 接管后对齐用）
 *   - readCommitEvidence()              提交凭据只读查询
 *   - transitionJobRev() / cleanupJobRev()  凭据 CAS 原语；恢复器未实现时
 *                                       confirm / cleanup 一律失败关闭
 *
 * 身份契约：正式写入不再从 meta.writer 推断身份。推断只能证明「租约有效」，
 * 不能证明「本标签页持有写入权」；因此 commit() 缺显式身份时直接失败关闭。
 *
 * 凭据契约（5B-2-R2）：commitTag = <tabId>:<jobIdNoPrefix>:<attempt>@<seq>。
 * prepare() 在事务外逐段比对 options.tabId / jobId / attempt（且 tabId 必须等于
 * 本模块 TAB_ID），不一致即失败关闭、不碰数据库；同一事务内的重复凭据检查保留。
 *
 * 恢复器契约（5B-2-R2）：applyEvidence / resolveHung 尚未实现，
 * confirm 与 cleanupJobRev 的公开入口失败关闭；finish 必须核对 instanceId
 * 与当前 resolver 一致，pending / resolving / 未确认凭据一律保留。
 *
 * 迁移契约：acquireWriter() 与 commit() 都在同一个 rw 事务内要求 migration 行
 * 存在且 status === 'done'；缺失、非 done、读取异常一律失败关闭，不修复不改行。
 *
 * 接管契约：判定与写入在同一个 rw 事务内完成，靠 IndexedDB 的事务串行化
 * 保证原子性，不使用 localStorage 锁或内存变量做跨标签页互斥。
 * 两个标签页同时竞争同一份过期租约时，只有先提交的那个成功，后一个在
 * 自己的事务里读到的已是新租约，因而失败关闭。
 *
 * 心跳契约：只在成功取得 writer 后启动；每个周期在同一 rw 事务内复用
 * checkWriteLeaseInTx + buildRenewedWriterRow，不绕过 ownerId / epoch / floor，
 * 不写业务表、不改 bizRev；任何失败即停止并标记失去写入权，不自动抢占。
 *
 * 职责边界：业务 save() 接线、成功 toast、失败回滚、committedSnapshot、
 * normalize 持久化、JSON 导入与清空数据均不在本任务范围。
 * ============================================================ */
(function (global) {
  'use strict';

  var BIZ_REV_KEY = 'bizRev';
  var JOBREV_PREFIX = 'jobRev:';       /* 提交凭据键前缀：jobRev:<commitTag> */
  /* 提交凭据 tag 的明确格式：
       <tabId>:<jobIdNoPrefix>:<attempt>@<seq>
     - tabId           : 1..128 字符，禁冒号/控制字符；必须等于 options.tabId 与模块 TAB_ID
     - jobIdNoPrefix   : 1..128 字符，禁冒号/控制字符；等于 options.jobId 去掉开头的 'job-'
     - attempt         : 十进制非负整数，字符串必须严格等于 String(options.attempt)
     - seq             : 十进制非负整数，仅用于同页面内的附加唯一性
     COMMIT_TAG_RE 只做格式解析；一致性由 prepare() 逐段比对，授权仍由
     ownerId/epoch 的本地 HELD 比对 + fencing 完成。 */
  var COMMIT_TAG_RE = /^([^\x00-\x1f:]{1,128}):([^\x00-\x1f:]{1,128}):(\d+)@(\d+)$/;
  var TAG_SEG_RE = /^[^\x00-\x1f:]{1,128}$/;
  /* 恢复器（applyEvidence / resolveHung）尚未实现。
     实现完成并通过验收前，confirm 与 cleanupJobRev 的公开入口一律失败关闭；
     这不是测试开关，调用方无法用参数绕过。 */
  var RECOVERER_READY = false;
  var BIZ_REV_MIN = 0;
  var MAX_REV = Number.MAX_SAFE_INTEGER || 9007199254740991;
  var MAX_EPOCH = MAX_REV;

  /* 业务写入闸门：闭包私有，外部赋值无法改变；只有 bootWriter 完整成功后
     调用 activateWrites() 且依赖校验通过才会置为 true。 */
  var WIRED = false;

  /* 心跳与生命周期状态（全部模块私有）：
       HEARTBEAT_TIMER  当前定时器句柄，null 表示未运行
       HELD             仅 acquireWriter() 成功后写入 {ownerId, epoch}
       LOST_WRITER      心跳失败 / 被接管 / versionchange 后置真，不自动自愈 */
  var HEARTBEAT_MS = 10000;
  /* 心跳周期下限：过小会造成高频 rw(meta) 事务，抢占写入通道。
     合法区间 [MIN_HEARTBEAT_MS, MAX_HEARTBEAT_MS]；缺省仍为 HEARTBEAT_MS。 */
  var MIN_HEARTBEAT_MS = 1000;
  var MAX_HEARTBEAT_MS = 2147483647;
  var HEARTBEAT_TIMER = null;
  var HELD = null;
  var LOST_WRITER = false;
  var VC_ATTACHED_DB = null;

  /* 失权原因（最近一次）+ 页面生命周期代次。
     pagehide / versionchange 都会让代次 +1；旧代次发起的 acquire / 重试结果一律作废，
     不允许再启动心跳或 activateWrites。 */
  var LAST_LOST_CODE = null;
  var LIFECYCLE_GEN = 0;
  var PAGE_HIDDEN = false;

  /* 启动取权重试（有限次数，轮次可作废）：
       WRITER_RETRY_DELAYS 第 1/2/3 次重试的退避；
       每次尝试仍调用 acquireWriter()，CAS/epoch fencing/事务原子性不变。 */
  var WRITER_RETRY_DELAYS = [1000, 2000, 4000];
  var RETRY_TIMER = null;
  var RETRY_ROUND = 0;
  var RETRY_ACTIVE = false;
  var RETRY_ATTEMPT = 0;
  var RETRY_NEXT_AT = 0;
  var RETRY_RESOLVE = null;

  /* 明确的「已失去库端写入权」结果：必须清本地租约、关 wired、停队列。 */
  var WRITER_LOSS_CODES = {
    'writer-lost': 1,
    'writer-not-held': 1,
    'writer-owner-changed': 1,
    'writer-epoch-changed': 1,
    'writer-lease-expired': 1,
    'writer-missing': 1,
    'writer-vanished': 1,
    'writer-inactive': 1,
    'writer-epoch-below-floor': 1,
    'writer-epoch-invalid': 1,
    'writer-lease-invalid': 1
  };

  /* 只有这两类取权失败值得重试：他页暂时持有 / 事务级失败。
     迁移未完成、数据损坏、DB 未打开等一律停止，避免掩盖真实故障。 */
  var RETRYABLE_ACQUIRE_CODES = {
    'writer-held-by-other': 1,
    'writer-acquire-failed': 1
  };

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /* ---------------- 标签页身份 ---------------- */

  /* 只用时间戳 + 随机数，不含任何业务数据或账户信息，也无法反推用户。
     crypto 不可用时退回 Math.random，仍是 16 位以上随机串。 */
  function makeTabId() {
    var rnd = '';
    try {
      if (global.crypto && typeof global.crypto.getRandomValues === 'function' &&
          typeof global.Uint32Array === 'function') {
        var buf = new global.Uint32Array(2);
        global.crypto.getRandomValues(buf);
        rnd = buf[0].toString(36) + buf[1].toString(36);
      }
    } catch (e) { rnd = ''; }
    if (!rnd) {
      rnd = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
    }
    return 'tab-' + Date.now().toString(36) + '-' + rnd;
  }

  /* 每个标签页各自加载一份脚本，因此各自生成一个 ID；
     同一标签页生命周期内它保持不变（模块级常量）。 */
  var TAB_ID = makeTabId();

  /* 业务版本只允许非负有限安全整数。NaN / Infinity / 小数 / 负数 / 字符串
     一律视为损坏：失败关闭，绝不静默归零重新计数。 */
  function isBizRev(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v &&
      v >= BIZ_REV_MIN && v <= MAX_REV;
  }

  function failure(code, message, extra) {
    var out = { ok: false, rev: null, code: code, reason: code, message: message || code };
    if (extra) {
      for (var k in extra) if (has(extra, k)) out[k] = extra[k];
    }
    return out;
  }

  /* 事务内抛出的错误：Dexie 会据此回滚整个事务 */
  function txError(code, message) {
    var e = new Error(message || code);
    e.name = 'BusinessWriteFailed';
    e.code = code;
    return e;
  }

  /* ---------------- 依赖 ---------------- */

  function checkDeps(M) {
    if (!M || typeof M.buildRows !== 'function' ||
        typeof M.checkConflicts !== 'function' || typeof M.collectBadDates !== 'function' ||
        typeof M.checkWriteLeaseInTx !== 'function' || typeof M.buildRenewedWriterRow !== 'function' ||
        typeof M.isWriterEpoch !== 'function' || typeof M.EXTRAS_KEY !== 'string' ||
        typeof M.SCHEMA_VERSION !== 'number' || typeof M.WRITE_TTL !== 'number' ||
        typeof M.readWriterEpochFloor !== 'function' || typeof M.nextWriterEpoch !== 'function' ||
        !Array.isArray(M.CLEARED_KEYS)) {
      return failure('module-missing', '迁移模块或写入常量不可用，拒绝写入');
    }
    return { ok: true };
  }

  function currentDb() {
    if (!global.OLDB || typeof global.OLDB.instance !== 'function') return null;
    var db;
    try { db = global.OLDB.instance(); } catch (e) { return null; }
    if (!db || typeof db.transaction !== 'function') return null;
    return db;
  }

  /* 迁移状态闸门：与 acquireWriter 同一口径，只能在调用方已打开的 Dexie 事务内使用。
     只读 db.meta.get('migration')，不推断、不修复、不改写任何行；
     读取异常由 Dexie 向上抛出，整事务回滚，绝不被解释成「迁移完成」。 */
  function checkMigrationDoneInTx(db) {
    return db.meta.get('migration').then(function (m) {
      if (m === undefined || m === null) {
        throw txError('migration-missing', '迁移记录不存在，拒绝写入');
      }
      if (!isPlainObject(m) || m.status !== 'done') {
        throw txError('migration-not-done',
          '迁移未完成（status=' + String(m && m.status) + '），拒绝写入');
      }
      return m;
    });
  }

  /* ---------------- 事务外准备 ---------------- */

  /* options.jobId → tag 中段：去掉开头的 'job-'（若有），其余原样。
     段必须非空、无冒号/控制字符，保证 tag 可无歧义解析。 */
  function tagJobIdOf(jobId) {
    if (typeof jobId !== 'string' || !jobId || jobId.length > 128) return null;
    var seg = jobId.indexOf('job-') === 0 ? jobId.slice(4) : jobId;
    return TAG_SEG_RE.test(seg) ? seg : null;
  }

  /* 参数、显式身份、候选数据与六表行构建。全程同步、不碰数据库。 */
  function prepare(candidateS, options, M) {
    var dep = checkDeps(M);
    if (!dep.ok) return dep;

    if (!isPlainObject(candidateS)) {
      return failure('candidate-not-object', '候选数据不是普通对象，拒绝写入');
    }
    if (!isPlainObject(options)) {
      return failure('options-invalid', '写入参数不是普通对象，拒绝写入');
    }
    /* 正式写入必须显式声明身份：缺一不可，不接受推断兜底 */
    if (typeof options.ownerId !== 'string' || !options.ownerId) {
      return failure('writer-identity-required', '正式写入必须显式传入 ownerId，不接受推断身份');
    }
    if (!M.isWriterEpoch(options.epoch)) {
      return failure('writer-epoch-required', '正式写入必须显式传入合法 epoch：' + String(options.epoch));
    }
    /* 只有真正给了值才校验：显式传 undefined 等同于「不指定」 */
    if (options.expectedRev !== undefined && !isBizRev(options.expectedRev)) {
      return failure('expected-rev-invalid', '期望的业务版本非法：' + String(options.expectedRev));
    }
    /* 提交凭据字段（可选）：缺省走兼容路径，不写凭据、不改变行为。
       提供 commitTag 时必须同时提供合法 tabId / jobId / attempt；
       先解析 tag，再逐段与 options 比对，任一不一致即失败关闭（不碰数据库）。 */
    if (options.commitTag !== undefined) {
      if (typeof options.commitTag !== 'string' || options.commitTag.length === 0 ||
          options.commitTag.length > 320 || !COMMIT_TAG_RE.test(options.commitTag)) {
        return failure('commit-tag-invalid', 'commitTag 格式非法：' + String(options.commitTag));
      }
      var jobSeg = tagJobIdOf(options.jobId);
      if (jobSeg === null) {
        return failure('job-id-invalid', '提供 commitTag 时 jobId 必须可映射为合法 tag 段');
      }
      if (typeof options.attempt !== 'number' || !isFiniteNumber(options.attempt) ||
          !Number.isInteger(options.attempt) || options.attempt < 0) {
        return failure('attempt-invalid', '提供 commitTag 时 attempt 必须是非负整数');
      }
      if (typeof options.tabId !== 'string' || !TAG_SEG_RE.test(options.tabId)) {
        return failure('tab-id-invalid', '提供 commitTag 时 tabId 必须是合法 tag 段');
      }
      if (options.tabId !== TAB_ID) {
        return failure('tab-id-mismatch', 'commitTag 的 tabId 与本模块身份不一致，拒绝写入');
      }
      var parts = COMMIT_TAG_RE.exec(options.commitTag);
      if (parts[1] !== options.tabId) {
        return failure('commit-tag-tab-mismatch', 'commitTag 的 tabId 段与 options.tabId 不一致');
      }
      if (parts[2] !== jobSeg) {
        return failure('commit-tag-job-mismatch', 'commitTag 的 jobId 段与 options.jobId 不一致');
      }
      if (parts[3] !== String(options.attempt)) {
        return failure('commit-tag-attempt-mismatch', 'commitTag 的 attempt 段与 options.attempt 不一致');
      }
    }

    var built = M.buildRows(candidateS);
    var rows = built && built.rows;
    if (!rows || !Array.isArray(rows.meta) || !Array.isArray(rows.definitions) ||
        !Array.isArray(rows.tasks) || !Array.isArray(rows.schedule) ||
        !Array.isArray(rows.dayEntries) || !Array.isArray(rows.dayMaps)) {
      return failure('build-rows-failed', '六表行构建结果不完整，拒绝写入');
    }

    var conflicts = M.checkConflicts(rows);
    if (conflicts.length) {
      return failure('primary-key-conflict', '存在 ' + conflicts.length + ' 处主键冲突，写入会互相覆盖',
        { conflicts: conflicts });
    }

    /* 与迁移口径一致：非法日期键保留原键、只记录，不作为致命阻断 */
    var badDates = M.collectBadDates(rows);
    return {
      ok: true,
      rows: rows,
      warnings: (built.issues || []).slice(),
      badDates: badDates,
      counts: {
        meta: rows.meta.length, definitions: rows.definitions.length,
        tasks: rows.tasks.length, schedule: rows.schedule.length,
        dayEntries: rows.dayEntries.length, dayMaps: rows.dayMaps.length
      }
    };
  }

  function buildChain(db, rows, at, M) {
    var chain = Promise.resolve();
    function step(table, list) {
      if (!list.length) return;
      chain = chain.then(function () { return table.bulkPut(list); });
    }
    if (rows.extras && rows.extras.present) {
      step(db.meta, [{
        key: M.EXTRAS_KEY,
        keys: rows.extras.keys.slice(),
        value: rows.extras.value,
        count: rows.extras.keys.length,
        capturedAt: at,
        schemaVersion: M.SCHEMA_VERSION
      }]);
    }
    step(db.meta, rows.meta);
    step(db.definitions, rows.definitions);
    step(db.tasks, rows.tasks);
    step(db.schedule, rows.schedule);
    step(db.dayEntries, rows.dayEntries);
    step(db.dayMaps, rows.dayMaps);
    return chain;
  }

  /* ---------------- CAS 接管 ---------------- */

  /* 取得或接管写入权。整个判定 + 写入在同一个 rw(meta) 事务内完成：
       0. migration 缺失或 status !== 'done' → 失败关闭（未迁移库不授权写入）
       1. 无 writer 行           → 新建，epoch = max(1, floor)
       2. status !== 'active'    → 失败关闭（需人工介入，不自愈）
       3. epoch 非法             → 失败关闭
       4. leaseExpiresAt 非法    → 失败关闭
       5. 租约未过期 + 是本人    → 仅续期，epoch 不变
       6. 租约未过期 + 非本人    → 失败（writer-held-by-other），不得抢占
       7. 租约已过期             → 接管，epoch = nextWriterEpoch(old, floor)
    第 7 条同时覆盖「epoch 低于 floor」的情形：nextWriterEpoch 保证新代次
    严格大于旧值且不低于 floor，旧代次因此被永久 fencing。
  */
  function acquireWriter(options) {
    var opts = options === undefined || options === null ? {} : options;
    var M = global.OLMigrate;
    var dep = checkDeps(M);
    if (!dep.ok) return Promise.resolve(dep);
    if (!isPlainObject(opts)) {
      return Promise.resolve(failure('options-invalid', '接管参数不是普通对象'));
    }

    var db = currentDb();
    if (!db) return Promise.resolve(failure('db-not-open', '数据库尚未打开，拒绝接管'));
    /* 版本变更监听必须在第一次取权尝试前就挂上：
       即使这次取权失败、进入退避重试，versionchange 也能立即取消后续轮次。 */
    try { attachVersionChange(db); } catch (e) {}

    var out = {
      ok: false, code: '', reason: '', message: '',
      ownerId: TAB_ID, epoch: null, source: null, status: null,
      previousOwnerId: null, previousEpoch: null,
      floor: null, at: null, heartbeatAt: null, leaseExpiresAt: null
    };
    /* 生命周期代次：事务提交瞬间若页面已 pagehide / versionchange，
       即使库内本次取权已成功，也绝不把结果升级为「本页持有写入权」。 */
    var gen0 = LIFECYCLE_GEN;

    return db.transaction('rw', db.meta, function () {
      var at = Date.now();
      out.at = at;
      return db.meta.get('writer').then(function (w) {
        return db.meta.get('migration').then(function (m) {
          return { w: w, m: m };
        });
      }).then(function (ctx) {
        /* 0. 迁移状态闸门：writer 只在迁移完成后的库上存在。
           缺失 / in_progress / failed / 未知状态一律失败关闭；不推断、不修复、不改写 migration 行。
           缺失不得当作「已完成」——那会让未迁移库拿到写入权。 */
        if (ctx.m === undefined || ctx.m === null) {
          throw txError('migration-missing', '迁移记录不存在，拒绝取得写入权');
        }
        if (ctx.m.status !== 'done') {
          throw txError('migration-not-done',
            '迁移未完成（status=' + String(ctx.m.status) + '），拒绝取得写入权');
        }

        var f = M.readWriterEpochFloor(ctx.m);
        if (!f.ok) throw txError(f.code, f.message);
        out.floor = f.value;

        var w = ctx.w;
        out.previousOwnerId = w && w.ownerId !== undefined ? w.ownerId : null;
        out.previousEpoch = w && w.epoch !== undefined ? w.epoch : null;

        /* 1. 首次取得 */
        if (!w) {
          var e0 = M.nextWriterEpoch(0, f.value);
          if (!isFiniteNumber(e0) || e0 > MAX_EPOCH) {
            throw txError('writer-epoch-overflow', '写入权代次已达上限，拒绝接管');
          }
          out.epoch = e0; out.source = 'created'; out.status = 'active';
          return db.meta.put({
            key: 'writer', status: 'active', ownerId: TAB_ID,
            epoch: e0, heartbeatAt: at, leaseExpiresAt: at + M.WRITE_TTL
          });
        }

        /* 2/3/4. 数据损坏一律失败关闭，不猜、不修复 */
        if (w.status !== 'active') {
          throw txError('writer-inactive', '写入权状态不是 active：' + String(w.status));
        }
        if (!M.isWriterEpoch(w.epoch)) {
          throw txError('writer-epoch-invalid', '写入权 epoch 非法：' + String(w.epoch));
        }
        if (!isFiniteNumber(w.leaseExpiresAt)) {
          throw txError('writer-lease-invalid', '写入权有效期不是有限数值：' + String(w.leaseExpiresAt));
        }

        /* 5/6. 租约仍有效 */
        if (w.leaseExpiresAt > at) {
          if (w.ownerId !== TAB_ID) {
            throw txError('writer-held-by-other',
              '写入权由其它标签页持有，租约到期前不得抢占');
          }
          if (w.epoch < f.value) {
            throw txError('writer-epoch-below-floor',
              '本标签页 epoch ' + w.epoch + ' 低于合法下界 ' + f.value);
          }
          out.epoch = w.epoch; out.source = 'renewed'; out.status = w.status;
          return db.meta.put(M.buildRenewedWriterRow(w, at));
        }

        /* 7. 租约已过期 → CAS 接管 + 代次提升 */
        var e1 = M.nextWriterEpoch(w.epoch, f.value);
        if (!isFiniteNumber(e1) || e1 > MAX_EPOCH) {
          throw txError('writer-epoch-overflow', '写入权代次已达上限，拒绝接管');
        }
        if (e1 <= w.epoch || e1 < f.value) {
          throw txError('writer-epoch-not-advanced', '接管代次未严格提升，拒绝写入');
        }
        out.epoch = e1; out.source = 'taken-over'; out.status = 'active';
        return db.meta.put({
          key: 'writer', status: 'active', ownerId: TAB_ID,
          epoch: e1, heartbeatAt: at, leaseExpiresAt: at + M.WRITE_TTL
        });
      });
    }).then(function () {
      /* pagehide / versionchange 已发生：事务结果作废，不写 HELD、不开放写入。
         库内本次写入的租约自然过期后由其他标签页接管。 */
      if (gen0 !== LIFECYCLE_GEN) {
        out.ok = false;
        out.code = 'lifecycle-ended';
        out.reason = out.code;
        out.message = '页面生命周期已变化，取权结果作废';
        out.epoch = null;
        HELD = null;
        LOST_WRITER = true;
        WIRED = false;
        return out;
      }
      out.ok = true;
      out.code = out.source === 'created' ? 'writer-acquired'
        : out.source === 'renewed' ? 'writer-renewed' : 'writer-taken-over';
      out.reason = out.code;
      out.message = '';
      out.heartbeatAt = out.at;
      out.leaseExpiresAt = out.at + M.WRITE_TTL;
      /* 只有成功取得 / 续期 / 接管后才允许本标签页启动心跳 */
      HELD = { ownerId: out.ownerId, epoch: out.epoch };
      LOST_WRITER = false;
      return out;
    }, function (e) {
      out.code = (e && e.code) || 'writer-acquire-failed';
      out.reason = out.code;
      out.message = (e && e.message) || String(e);
      out.epoch = null;
      out.rolledBack = true;
      /* 失败的接管不能留下「本页持有写入权」的假状态 */
      HELD = null;
      return out;
    });
  }

  /* ---------------- 心跳与生命周期 ---------------- */

  function clearHeartbeatTimer() {
    if (HEARTBEAT_TIMER !== null) {
      try { global.clearInterval(HEARTBEAT_TIMER); } catch (e) {}
      HEARTBEAT_TIMER = null;
    }
  }

  /* 统一失权收口：任何明确的库端失权都走这里。
     清心跳、清本地身份、关闭业务写入、记录原因，并作废在途取权重试。
     注意：失权不是页面结束，生命周期代次不变；页面结束由 onPageHide 处理。 */
  function markWriterLost(code) {
    clearHeartbeatTimer();
    cancelWriterRetry();
    HELD = null;
    LOST_WRITER = true;
    WIRED = false;
    LAST_LOST_CODE = code || 'writer-lost';
  }

  function isWriterLossCode(code) {
    return typeof code === 'string' && has(WRITER_LOSS_CODES, code);
  }

  /* ---------------- 启动取权重试（有限次数 + 轮次作废） ---------------- */

  function writerRetryState() {
    return { active: RETRY_ACTIVE, attempt: RETRY_ATTEMPT,
             nextAt: RETRY_NEXT_AT || null, round: RETRY_ROUND };
  }

  function clearRetryTimer() {
    if (RETRY_TIMER !== null) {
      try { global.clearTimeout(RETRY_TIMER); } catch (e) {}
      RETRY_TIMER = null;
    }
  }

  /* 取消当前轮次：定时器清掉，挂起 Promise 以 retry-cancelled 收口（不悬挂）。
     旧轮次的回调会因 round / active 不再匹配而全部作废。 */
  function cancelWriterRetry() {
    clearRetryTimer();
    RETRY_ACTIVE = false;
    RETRY_ATTEMPT = 0;
    RETRY_NEXT_AT = 0;
    var resolve = RETRY_RESOLVE;
    RETRY_RESOLVE = null;
    if (resolve) resolve({ ok:false, code:'retry-cancelled', retryCancelled:true });
  }

  /* 带退避的取权：第 1/2/3 次重试延迟 1s/2s/4s。
     每一轮绑定 round + LIFECYCLE_GEN；pagehide/versionchange/新一次重试都会让旧轮次失效，
     旧结果不得再触发心跳或写入开放。 */
  function acquireWriterWithRetry(options, onAttempt) {
    cancelWriterRetry();
    var round = ++RETRY_ROUND;
    var gen = LIFECYCLE_GEN;
    RETRY_ACTIVE = true;
    RETRY_ATTEMPT = 0;
    RETRY_NEXT_AT = 0;

    return new Promise(function (resolve) {
      RETRY_RESOLVE = resolve;

      function finish(r) {
        if (RETRY_RESOLVE !== resolve) return;   /* 已被取消 / 新一轮接管，结果丢弃 */
        RETRY_RESOLVE = null;
        clearRetryTimer();
        RETRY_ACTIVE = false;
        RETRY_NEXT_AT = 0;
        resolve(r);
      }
      function current() {
        return round === RETRY_ROUND && RETRY_ACTIVE && gen === LIFECYCLE_GEN;
      }
      function attempt() {
        if (!current()) { finish({ ok:false, code:'lifecycle-ended', retryCancelled:true }); return; }
        RETRY_ATTEMPT += 1;
        if (!currentDb()) { finish({ ok:false, code:'db-not-open' }); return; }
        acquireWriter(options).then(function (r) {
          if (!current()) { finish({ ok:false, code:'lifecycle-ended', retryCancelled:true }); return; }
          if (typeof onAttempt === 'function') {
            try { onAttempt(r, { round:round, attempt:RETRY_ATTEMPT, gen:gen }); } catch (e) {}
          }
          if (r && r.ok) { finish(r); return; }
          var code = (r && r.code) || 'writer-acquire-failed';
          if (!has(RETRYABLE_ACQUIRE_CODES, code) || RETRY_ATTEMPT > WRITER_RETRY_DELAYS.length) {
            finish(r);
            return;
          }
          var delay = WRITER_RETRY_DELAYS[Math.min(RETRY_ATTEMPT - 1, WRITER_RETRY_DELAYS.length - 1)];
          RETRY_NEXT_AT = Date.now() + delay;
          RETRY_TIMER = global.setTimeout(function () {
            RETRY_TIMER = null;
            RETRY_NEXT_AT = 0;
            attempt();
          }, delay);
        }, function (e) {
          if (!current()) { finish({ ok:false, code:'lifecycle-ended', retryCancelled:true }); return; }
          finish({ ok:false, code:(e && e.code) || 'writer-acquire-failed' });
        });
      }
      attempt();
    });
  }

  function onPageHide() {
    PAGE_HIDDEN = true;
    LIFECYCLE_GEN += 1;               /* 旧代次的异步结果一律作废 */
    clearHeartbeatTimer();
    cancelWriterRetry();
  }

  function onVersionChange() {
    LIFECYCLE_GEN += 1;               /* 版本变更后不得再激活写入 */
    markWriterLost('versionchange');
  }

  /* 版本变更只挂一次，避免 startHeartbeat 重复调用叠加监听。
     Dexie 的 db.on('versionchange') 与原生 IDBDatabase.onversionchange 都挂，
     任一触发即停止心跳，不依赖数据库版本升级一定走哪条路径。 */
  function attachVersionChange(db) {
    if (!db || VC_ATTACHED_DB === db) return;
    VC_ATTACHED_DB = db;
    try {
      if (typeof db.on === 'function') db.on('versionchange', onVersionChange);
    } catch (e) {}
    try {
      var native = typeof db.backendDB === 'function' ? db.backendDB() : null;
      if (native) native.onversionchange = onVersionChange;
    } catch (e) {}
  }

  /* 心跳失败统一收口：停定时器 + 标记失去写入权 + 明确错误。
     提前失败（未持有 / DB 不可用）与事务内失败走同一条路径，不留状态缝隙。 */
  function heartbeatFail(code, message, extra) {
    markWriterLost(code || 'heartbeat-failed');
    return failure(code, message, extra);
  }

  /* 一次心跳：同一个 rw(meta) 事务内检查迁移状态 → 校验 ownerId / epoch / floor / 租约
     → 用 buildRenewedWriterRow 续期。不写业务表、不改 bizRev、不做 CAS 抢占。 */
  function renewOwnLease() {
    if (!HELD || LOST_WRITER) {
      return Promise.resolve(heartbeatFail('writer-not-held', '本标签页当前未持有写入权'));
    }
    var db = currentDb();
    if (!db) return Promise.resolve(heartbeatFail('db-not-open', '数据库不可用，心跳停止'));
    var held = HELD;
    var M = global.OLMigrate;
    return db.transaction('rw', db.meta, function () {
      return checkMigrationDoneInTx(db).then(function () {
        var at = Date.now();
        return M.checkWriteLeaseInTx(db, held.ownerId, held.epoch, at).then(function (r) {
          return db.meta.put(M.buildRenewedWriterRow(r.writerRow, Date.now()));
        });
      });
    }).then(function () {
      return { ok: true, code: 'heartbeat-renewed', ownerId: held.ownerId, epoch: held.epoch };
    }, function (e) {
      return heartbeatFail((e && e.code) || 'heartbeat-failed', (e && e.message) || String(e), {
        ownerId: held.ownerId, epoch: held.epoch
      });
    });
  }

  function startHeartbeat(options) {
    var o = options === undefined || options === null ? {} : options;
    if (!isPlainObject(o)) return Promise.resolve(failure('options-invalid', '心跳参数不是普通对象'));
    if (HEARTBEAT_TIMER !== null) {
      return Promise.resolve({ ok: true, code: 'heartbeat-already-running',
        intervalMs: o.intervalMs, ownerId: HELD && HELD.ownerId, epoch: HELD && HELD.epoch });
    }
    if (!HELD || LOST_WRITER) {
      return Promise.resolve(failure('writer-not-held', '只有成功取得 writer 的标签页才能启动心跳'));
    }
    var ms = o.intervalMs === undefined ? HEARTBEAT_MS : o.intervalMs;
    if (!isFiniteNumber(ms) || ms < MIN_HEARTBEAT_MS || ms > MAX_HEARTBEAT_MS) {
      return Promise.resolve(failure('heartbeat-interval-invalid',
        '心跳周期必须是 [' + MIN_HEARTBEAT_MS + ', ' + MAX_HEARTBEAT_MS + '] 内的有限数值：' + String(ms),
        { min: MIN_HEARTBEAT_MS, max: MAX_HEARTBEAT_MS, received: ms }));
    }
    var db = currentDb();
    if (!db) return Promise.resolve(failure('db-not-open', '数据库不可用，心跳未启动'));
    attachVersionChange(db);
    var held = HELD;
    HEARTBEAT_TIMER = global.setInterval(function () {
      var p = renewOwnLease();
      if (p && typeof p.catch === 'function') {
        p.catch(function () { markWriterLost('heartbeat-rejected'); });
      }
    }, ms);
    return Promise.resolve({ ok: true, code: 'heartbeat-started', intervalMs: ms,
      ownerId: held.ownerId, epoch: held.epoch });
  }

  function stopHeartbeat() {
    var wasRunning = HEARTBEAT_TIMER !== null;
    clearHeartbeatTimer();
    return { ok: true, code: 'heartbeat-stopped', wasRunning: wasRunning };
  }

  function hasWriterLease() { return !!(HELD && !LOST_WRITER); }
  function writerLost() { return LOST_WRITER === true; }

  /* 只读身份摘要：仅返回当前标签页 acquireWriter 成功后保存的 {ownerId, epoch}。
     返回的是新对象（调用方修改不影响内部 HELD）；未持有或已失权时返回 null。
     不构成写入授权，也不读库——库内租约有效性仍由 status()/commit() 各自判定。 */
  function currentWriterIdentity() {
    if (!HELD || LOST_WRITER) return null;
    return { ownerId: HELD.ownerId, epoch: HELD.epoch };
  }

  /* 5B-3：受控开放业务写入。只有本标签页真实持有 writer 且保存队列可用时
     才置 WIRED=true；任何依赖缺失 / 失权都保持只读，不接受参数绕过。 */
  function activateWrites() {
    var Q = global.OLCommitQueue;
    if (!Q || typeof Q.enqueue !== 'function' || typeof Q.status !== 'function') {
      WIRED = false;
      return failure('queue-not-ready', '保存队列未就绪，保持只读');
    }
    if (!HELD || LOST_WRITER || !hasWriterLease()) {
      WIRED = false;
      return failure('writer-not-held', '本标签页未持有写入权，保持只读');
    }
    if (WIRED) return { ok:true, code:'already-wired', wired:true };
    WIRED = true;
    return { ok:true, code:'writes-activated', wired:true };
  }

  /* 页面关闭只停止心跳，不主动释放 writer；租约自然过期后由其他标签页接管。 */
  try {
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('pagehide', onPageHide);
    }
  } catch (e) {}

  /* ---------------- 六表原子写入 ---------------- */

  /* 唯一的业务写入口。成功返回实际提交的 rev；失败返回明确错误，绝不伪装成功。
     必须显式传入 options.ownerId / options.epoch（来自 acquireWriter 的结果）。

     同步异常边界：事务外准备阶段（prepare 及其调用的 buildRows / checkConflicts /
     collectBadDates）由调用方注入的 OLMigrate 实现，可能同步抛错。这里统一收口为
     与 prepare 失败一致的契约：{ok:false, rev:null, code, reason, message}，
     并带 phase:'prepare'、rolledBack:false（数据库根本未被触碰），绝不把异常逃逸到
     调用方，也不把它伪装成「事务回滚成功」。错误细节（原 code / message）完整保留。 */
  function prepareFailure(e) {
    var code = (e && typeof e.code === 'string' && e.code) || 'prepare-threw';
    var message = (e && typeof e.message === 'string' && e.message) || String(e);
    return failure(code, message, { phase: 'prepare', rolledBack: false });
  }

  function commit(candidateS, options) {
    var opts = options === undefined || options === null ? {} : options;
    var M = global.OLMigrate;
    var p;
    try {
      p = prepare(candidateS, opts, M);
    } catch (e) {
      return Promise.resolve(prepareFailure(e));
    }
    if (!p.ok) {
      /* prepare 的既有失败结果保持原错误码语义，只补充统一的边界标记。 */
      var out = {};
      for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = p[k];
      out.phase = 'prepare';
      out.rolledBack = false;
      return Promise.resolve(out);
    }

    var db = currentDb();
    if (!db) return Promise.resolve(failure('db-not-open', '数据库尚未打开，拒绝写入'));

    var result = {
      rev: null, committedAt: null,
      counts: p.counts, warnings: p.warnings, badDates: p.badDates
    };
    /* 提交凭据：tag 缺省时完全走旧路径（不读不写 jobRev、返回结构不变）。 */
    var tag = (typeof opts.commitTag === 'string' && opts.commitTag) ? opts.commitTag : null;
    var jobId = tag ? opts.jobId : null;
    var attempt = tag ? opts.attempt : null;

    return db.transaction('rw',
      db.meta, db.definitions, db.tasks, db.schedule, db.dayEntries, db.dayMaps,
      function () {
        /* 事务内取一次时间：同步调用，不会让 IndexedDB 提前提交。
           租约校验用同一时刻，避免事务排队期间租约已过期却被放行。
           注意：该时刻是**事务开始**时刻，返回值 committedAt 沿用此语义。 */
        var at = Date.now();
        result.committedAt = at;

        /* ⓪ 迁移状态闸门：任何清空 / 写入 / bizRev 更新 / writer 续期之前。
              即使调用者绕过 acquireWriter 直接拿旧 ownerId + epoch，
              未迁移或迁移未完成的库也一律失败关闭。 */
        return checkMigrationDoneInTx(db).then(function () {
          /* ① 本标签页本地写入权：心跳失败 / versionchange 后 LOST_WRITER 为真，
                 或从未成功 acquireWriter（HELD 缺失）时，必须失败关闭。
                 数据库恢复、旧租约仍有效、调用方重新传旧身份都不能恢复写入权；
                 唯一恢复路径是重新成功调用 acquireWriter()。 */
          if (LOST_WRITER) {
            throw txError('writer-lost', '本标签页已失去写入权，拒绝写入');
          }
          if (!HELD) {
            throw txError('writer-not-held', '本标签页尚未取得写入权，拒绝写入');
          }
          if (opts.ownerId !== HELD.ownerId || opts.epoch !== HELD.epoch) {
            throw txError('writer-identity-mismatch',
              '传入身份与本标签页持有的写入权不一致，拒绝写入');
          }
          /* ② 写入权 / 代次下界校验：ownerId / epoch 由调用方显式给出，
                 旧代次在这里被 fencing 拒绝。 */
          return M.checkWriteLeaseInTx(db, opts.ownerId, opts.epoch, at);
        }).then(function (lease) {
          return { lease: lease };
        }).then(function (ctx) {
          /* ③ 业务版本：行缺失兼容 0，非法失败关闭且与 expectedRev 比对 */
          return db.meta.get(BIZ_REV_KEY).then(function (row) {
            var curRev = BIZ_REV_MIN;
            if (row !== undefined && row !== null) {
              if (!isPlainObject(row) || !isBizRev(row.value)) {
                throw txError('biz-rev-invalid', '业务版本号非法：' + String(row && row.value));
              }
              curRev = row.value;
            }
            if (opts.expectedRev !== undefined && opts.expectedRev !== curRev) {
              throw txError('stale-state', '业务版本已变化（期望 ' + opts.expectedRev +
                '，实际 ' + curRev + '）');
            }
            if (curRev >= MAX_REV) {
              throw txError('biz-rev-overflow', '业务版本号已达上限，拒绝继续递增');
            }
            result.preRev = curRev;      /* 凭据绑定业务版本基线（事务内读取） */
            result.rev = curRev + 1;
            return ctx;
          });
        }).then(function (ctx) {
          /* ③' 凭据重复检测：同一 commitTag 只允许提交一次。
                放在 ④ 清空载荷之前读，避免覆盖已存在的凭据行；
                jobRev 不在 CLEARED_KEYS 静态白名单内，④ 不会删它。 */
          if (!tag) return ctx;
          return db.meta.get(JOBREV_PREFIX + tag).then(function (existing) {
            if (existing !== undefined && existing !== null) {
              throw txError('commit-tag-duplicate', '凭据 tag 已存在，拒绝重复提交：' + tag);
            }
            return ctx;
          });
        }).then(function (ctx) {
          /* ④ 原子替换：五张业务表清空，meta 只按精确白名单删业务载荷，
               基础设施行（migration / writer / schemaVersion / preNormalize /
               bizDatePolicy / bizRev 及其它未知 key）一律保留 */
          return db.definitions.clear()
            .then(function () { return db.tasks.clear(); })
            .then(function () { return db.schedule.clear(); })
            .then(function () { return db.dayEntries.clear(); })
            .then(function () { return db.dayMaps.clear(); })
            .then(function () { return db.meta.bulkDelete(M.CLEARED_KEYS.slice()); })
            .then(function () { return ctx; });
        }).then(function () {
          /* ⑤ 重建六表行 */
          return buildChain(db, p.rows, at, M);
        }).then(function () {
          /* ⑥ 版本递增 */
          return db.meta.put({ key: BIZ_REV_KEY, value: result.rev, at: at });
        }).then(function () {
          /* ⑦ 同一事务内续期：以续期时刻重新取时间，长事务提交时租约不会已过期。
               只延长有效期与心跳，epoch / owner / status 不变 */
          return db.meta.get('writer').then(function (w) {
            if (!w) throw txError('writer-vanished', 'writer 行在写入过程中消失');
            return db.meta.put(M.buildRenewedWriterRow(w, Date.now()));
          });
        }).then(function () {
          /* ⑧ 提交凭据：与六表替换 / bizRev 递增 / writer 续期处于【同一 rw 事务】。
                 resolution:'pending'、completion:null 从写入那一刻原子诞生。
                 tag 不存在 ⇒ 凭据不存在（R9 判定表：视为未提交，不自造凭据行）。 */
          if (!tag) return;
          return db.meta.put({
            key: JOBREV_PREFIX + tag,
            value: {
              rev: result.rev, jobId: jobId, attempt: attempt,
              tabId: TAB_ID, ownerId: opts.ownerId, epoch: opts.epoch,
              expectedRev: result.preRev, at: at,
              resolution: 'pending', completion: null,
              resolver: null, resolvingAt: null,
              recoveredAt: null, confirmedAt: null
            }
          });
        });
      }).then(function () {
        var ok = {
          ok: true, rev: result.rev, code: 'ok', reason: 'ok',
          identitySource: 'explicit', committedAt: result.committedAt,
          counts: result.counts, warnings: result.warnings, badDates: result.badDates
        };
        if (tag) ok.commitTag = tag;      /* 兼容：无 tag 时不出现该字段 */
        return ok;
      }, function (e) {
        var code = (e && e.code) || 'write-failed';
        /* 库端明确的失权结果：立即清本地租约、关 wired、记录原因。
           队列随后按 fatal 分类进入 recovering，旧页不再接受新提交。
           本地身份不一致（writer-identity-mismatch）不属于库端失权，不在此清理。 */
        if (isWriterLossCode(code)) markWriterLost(code);
        var out = failure(code, (e && e.message) || String(e), {
          rolledBack: true, identitySource: 'explicit'
        });
        if (tag) out.commitTag = tag;
        return out;                        /* 事务已 abort，凭据行不存在 */
      });
  }

  /* ---------------- 提交凭据（jobRev）只读查询与恢复状态机 ----------------
     commitTag 凭据与业务数据在同一个 rw 事务内写入（见 commit ⑧）。
     这里提供最小必要的读取与恢复原语，供队列与恢复流程使用：
       - readCommitEvidence(tag)：只读凭据 + bizRev，绝不写；
       - transitionJobRev(tag, action, instanceId, payload, at)：
           claim / finish / confirm 的 CAS，全部在同一 rw(meta) 事务内 read-modify-write，
           靠 IDB 跨标签页事务串行化保证原子，不依赖时间窗；恢复器未实现时
           confirm 直接失败关闭，finish 只认当前 resolver 本人；
       - cleanupJobRev(opts)：恢复器未实现时直接失败关闭；将来开放后也只清理
           已判定【且已确认完成】且过期的凭据，未确认完成一律保留。
     所有函数经 currentDb() 取库，绝不触碰真实业务库之外的任何库。 */

  /* 只读业务版本基线：保存队列在 writer 取得 / 接管后必须调用它对齐当前库的 bizRev。
     迁移未完成即失败关闭；bizRev 缺失按 0 兼容（与 commit 口径一致），非法值失败关闭。
     全程 r(db.meta) 事务，不写任何行、不推断、不修复。 */
  function readBizRev() {
    var db = currentDb();
    if (!db) return Promise.resolve(failure('db-not-open', '数据库尚未打开'));
    return db.transaction('r', db.meta, function () {
      return checkMigrationDoneInTx(db).then(function () {
        return db.meta.get(BIZ_REV_KEY);
      }).then(function (row) {
        if (row === undefined || row === null) return { ok: true, rev: BIZ_REV_MIN, at: null };
        if (!isPlainObject(row) || !isBizRev(row.value)) {
          throw txError('biz-rev-invalid', '业务版本号非法：' + String(row && row.value));
        }
        return { ok: true, rev: row.value, at: (typeof row.at === 'number' ? row.at : null) };
      });
    }).then(function (r) {
      return r;
    }, function (e) {
      return failure((e && e.code) || 'baseline-read-failed', (e && e.message) || String(e));
    });
  }

  function readCommitEvidence(tag) {
    var db = currentDb();
    if (!db) return Promise.resolve(failure('db-not-open', '数据库尚未打开'));
    if (typeof tag !== 'string' || !tag) return Promise.resolve(failure('tag-invalid', '凭据 tag 非法'));
    return db.transaction('r', db.meta, function () {
      return db.meta.get(JOBREV_PREFIX + tag).then(function (row) {
        return db.meta.get(BIZ_REV_KEY).then(function (revRow) {
          return { tagRecord: (row && row.value) ? row.value : null,
                   currentRev: (revRow && isBizRev(revRow.value)) ? revRow.value : null,
                   present: !!(row && row.value) };
        });
      });
    });
  }

  /* CAS 状态机。返回结构统一 { ok, code?, ... }。
     action ∈ { claim, finish, confirm }。instanceId 是本次恢复流程的全局唯一身份。 */
  function transitionJobRev(tag, action, instanceId, payload, at) {
    /* 恢复器（applyEvidence / resolveHung）尚未实现：公开 confirm 入口一律失败关闭。
       不接受任何 payload / 测试参数绕过；不得凭 resolution 已达终态就伪造"恢复完成"。 */
    if (action === 'confirm' && !RECOVERER_READY) {
      return Promise.resolve(failure('recoverer-not-ready',
        '恢复器未实现，confirm 已关闭；凭据 completion 保持未确认'));
    }
    var db = currentDb();
    if (!db) return Promise.resolve(failure('db-not-open', '数据库尚未打开'));
    if (typeof tag !== 'string' || !tag) return Promise.resolve(failure('tag-invalid', '凭据 tag 非法'));
    at = (typeof at === 'number' && isFinite(at)) ? at : Date.now();
    payload = isPlainObject(payload) ? payload : {};

    return db.transaction('rw', db.meta, function () {
      return db.meta.get(JOBREV_PREFIX + tag).then(function (row) {
        var key = JOBREV_PREFIX + tag;
        /* tag 不存在 = 未提交（R9 判定表），不自造凭据行 */
        if (!row || !row.value) {
          if (action === 'claim') return { ok:true, noCredential:true, claimed:false };
          return failure('evidence-missing', '凭据不存在，拒绝恢复状态转换');
        }
        var v = row.value;
        /* 结构非法：失败关闭，不猜、不修复 */
        if (typeof v.resolution !== 'string' ||
            ['pending','resolving','resolved-committed','resolved-not-committed'].indexOf(v.resolution) < 0) {
          throw txError('evidence-invalid', '凭据 resolution 字段非法');
        }

        if (action === 'claim') {
          if (v.resolution === 'resolved-committed' || v.resolution === 'resolved-not-committed') {
            return { ok:true, alreadyDecided:true, resolution:v.resolution,
                     rev:isBizRev(v.rev) ? v.rev : null };
          }
          if (v.resolution === 'resolving') {
            if (v.resolver && v.resolver !== instanceId) {
              return failure('resolve-taken-by-other', '凭据正由其它恢复流程处理');
            }
            /* 同 instanceId 幂等重入 */
            return { ok:true, claimed:true, resolution:v.resolution,
                     rev:isBizRev(v.rev) ? v.rev : null };
          }
          /* pending → resolving */
          v.resolution = 'resolving';
          v.resolver = instanceId;
          v.resolvingAt = at;
          return db.meta.put({ key:key, value:v }).then(function () {
            return { ok:true, claimed:true, resolution:v.resolution,
                     rev:isBizRev(v.rev) ? v.rev : null };
          });
        }

        if (action === 'finish') {
          if (v.resolution !== 'resolving') {
            /* 已终态：幂等返回；pending 未 claim 直接 finish 拒绝 */
            if (v.resolution === 'resolved-committed' || v.resolution === 'resolved-not-committed') {
              return { ok:true, alreadyDecided:true, resolution:v.resolution,
                       rev:isBizRev(v.rev) ? v.rev : null };
            }
            return failure('not-resolving', '凭据未处于 resolving，拒绝 finish');
          }
          if (!v.resolver || typeof v.resolver !== 'string') {
            return failure('resolver-missing', '凭据缺少 resolver，拒绝 finish');
          }
          if (v.resolver !== instanceId) {
            return failure('resolver-mismatch', 'instanceId 与当前 resolver 不一致，禁止结束他人的恢复任务');
          }
          /* 只认可信判定：committed 或 not-committed */
          var decision = payload.decision;
          if (decision !== 'committed' && decision !== 'not-committed') {
            return failure('decision-invalid', 'finish 判定非法：' + String(decision));
          }
          v.resolution = 'resolved-' + decision;
          v.resolver = null;               /* finish 后释放 resolver；completion 仍 null */
          v.recoveredAt = at;
          return db.meta.put({ key:key, value:v }).then(function () {
            return { ok:true, resolution:v.resolution, rev:isBizRev(v.rev) ? v.rev : null };
          });
        }

        if (action === 'confirm') {
          if (v.resolution !== 'resolved-committed' && v.resolution !== 'resolved-not-committed') {
            return failure('confirm-not-decided', '凭据尚未判定，拒绝 confirm');
          }
          if (v.completion === 'confirmed') {
            return { ok:true, alreadyConfirmed:true, resolution:v.resolution,
                     rev:isBizRev(v.rev) ? v.rev : null };
          }
          v.completion = 'confirmed';
          v.confirmedAt = at;
          return db.meta.put({ key:key, value:v }).then(function () {
            return { ok:true, confirmed:true, resolution:v.resolution,
                     rev:isBizRev(v.rev) ? v.rev : null };
          });
        }

        return failure('unknown-action', '未知的凭据动作：' + String(action));
      });
    });
  }

  /* 只清理【已判定 + 已确认完成 + 无 resolver + 过期】的凭据。
     任何未确认完成（completion!=='confirmed'）的凭据都保留——
     这是"HUNG 未成功恢复时凭据不被清理"的安全锚点。 */
  function cleanupJobRev(opts) {
    /* 恢复器未实现前禁止清理任何恢复凭据：pending / resolving / resolved-*
       一律保留，防止误确认后唯一证据被抹除。不接受任何 opts 绕过。 */
    if (!RECOVERER_READY) {
      return Promise.resolve(failure('recoverer-not-ready',
        '恢复器未实现，凭据清理已关闭；所有凭据保留'));
    }
    var db = currentDb();
    if (!db) return Promise.resolve(failure('db-not-open', '数据库尚未打开'));
    opts = isPlainObject(opts) ? opts : {};
    var maxAge = (typeof opts.maxAgeMs === 'number' && isFiniteNumber(opts.maxAgeMs) && opts.maxAgeMs >= 0)
      ? opts.maxAgeMs : (7 * 24 * 60 * 60 * 1000);
    var now = (typeof opts.now === 'number' && isFiniteNumber(opts.now)) ? opts.now : Date.now();
    var protect = (Array.isArray(opts.protectedTags) ? opts.protectedTags : []);

    return db.transaction('rw', db.meta, function () {
      return db.meta.toArray().then(function (rows) {
        var doomed = [];
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          if (!r || typeof r.key !== 'string' || r.key.indexOf(JOBREV_PREFIX) !== 0) continue;
          var tag = r.key.slice(JOBREV_PREFIX.length);
          if (protect.indexOf(tag) >= 0) continue;              /* 显式保护 */
          var v = r.value;
          if (!isPlainObject(v)) continue;                       /* 结构非法 → 保留 */
          if (v.resolution !== 'resolved-committed' && v.resolution !== 'resolved-not-committed') continue;
          if (v.completion !== 'confirmed') continue;            /* ★ 未确认完成 → 保留 */
          if (v.resolver) continue;                              /* 仍有恢复者 → 保留 */
          if (!isFiniteNumber(v.at) || v.at >= now - maxAge) continue;  /* 未过期 → 保留 */
          doomed.push(r.key);
        }
        /* 逐条删除，删除前在同一事务内重读（防同事务内状态已被其它步骤改动） */
        return doomed.reduce(function (chain, key) {
          return chain.then(function () {
            return db.meta.get(key).then(function (fresh) {
              if (!fresh || !isPlainObject(fresh.value)) return;
              var fv = fresh.value;
              if (fv.resolution !== 'resolved-committed' && fv.resolution !== 'resolved-not-committed') return;
              if (fv.completion !== 'confirmed') return;
              if (fv.resolver) return;
              return db.meta.delete(key);
            });
          });
        }, Promise.resolve()).then(function () { return { ok:true, deleted:doomed.length }; });
      });
    });
  }

  var api = {
    tabId: TAB_ID,
    BIZ_REV_KEY: BIZ_REV_KEY,
    JOBREV_PREFIX: JOBREV_PREFIX,
    BIZ_REV_MIN: BIZ_REV_MIN,
    MAX_REV: MAX_REV,
    MAX_EPOCH: MAX_EPOCH,
    isBizRev: isBizRev,
    acquireWriter: acquireWriter,
    commit: commit,
    readBizRev: readBizRev,
    readCommitEvidence: readCommitEvidence,
    transitionJobRev: transitionJobRev,
    cleanupJobRev: cleanupJobRev,
    startHeartbeat: startHeartbeat,
    stopHeartbeat: stopHeartbeat,
    hasWriterLease: hasWriterLease,
    writerLost: writerLost,
    lastLostCode: function () { return LAST_LOST_CODE; },
    lifecycleState: function () { return { gen: LIFECYCLE_GEN, hidden: PAGE_HIDDEN }; },
    isLifecycleCurrent: function (gen) { return gen === LIFECYCLE_GEN; },
    acquireWriterWithRetry: acquireWriterWithRetry,
    cancelWriterRetry: cancelWriterRetry,
    writerRetryState: writerRetryState,
    currentWriterIdentity: currentWriterIdentity,
    activateWrites: activateWrites
  };

  /* 只暴露只读 getter：外部 OLWrite.wired = true 不能改变闭包里的 WIRED。
     除 WIRED 外还与真实本地租约 / 失权标志相与：任何失权后即使 WIRED 残留，
     也不可能读成可写。configurable:false 同时挡住外部 defineProperty 改写。 */
  Object.defineProperty(api, 'wired', {
    enumerable: true,
    configurable: false,
    get: function () { return !!(WIRED && HELD && !LOST_WRITER); }
  });

  global.OLWrite = api;
})(typeof window !== 'undefined' ? window : this);
