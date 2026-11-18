/* commit-queue.js — 串行业务保存队列（Phase 1 Step 5B-2）
 *
 * 职责：把"保存意图"串行地提交到 OLWrite.commit()，保证同一时刻最多一个 in-flight
 * 事务；pending 快照可合并但不丢操作来源与反馈；失败保留内存修改，绝不用旧快照覆盖 S。
 *
 * 严格边界（Task 5B-2 / 5B-2-R2）：
 *   - 本模块【不接】任何 save() 调用点，不改现有业务保存反馈；
 *   - 不把 OLWrite.wired 置 true，不开放业务写入；status().readOnly 仍为 true；
 *   - expectedRev 只使用确认提交后的 committedBizRev；基线未知或 writer 身份变化时
 *     必须先经 OLWrite.readBizRev() 只读对齐，无法确认即失败关闭，绝不无基线提交；
 *   - stale-state / writer-lost / writer-not-held 进 recovering，原 job / 快照 /
 *     operations 保留在 RECOVERING_JOB，resolve() 必须显式 retry / discard / recapture；
 *   - retry 前比对内存 S 与失败快照，变化即拒绝旧快照；
 *   - 高频操作恢复成功后重新安排 flush，不永久滞留；
 *   - operation 的 callback 只在终局结算一次；普通失败可 retry 并最终收到成功。
 *
 * 依赖：window.OLWrite（commit / readBizRev / tabId / 凭据 API）、全局 S（候选业务数据快照源）。
 * 加载本文件不会触发任何提交；必须由调用方显式 enqueue + drain。
 */
(function (global) {
  'use strict';

  var Q = {
    /* 最近一次【确认提交成功或只读对齐】的业务版本；null 表示未知，此时禁止提交 */
    committedBizRev: null,
    /* 最近一次确认提交的快照（成功后的业务状态副本，只读诊断用） */
    committedSnapshot: null,
    /* 待提交快照（pending job 的 snapshot 引用；合并时整体替换，不原地修改已入队快照） */
    pendingSnapshot: null
  };

  var STATE = 'idle';           /* idle | baseline | submitting | recovering | stopped */
  var INFLIGHT = null;          /* 当前在途 job（同一时刻最多一个） */
  var PENDING = null;           /* 待提交 job（可被后续 enqueue 合并 operations + 刷新快照） */
  var RECOVERING_JOB = null;    /* fatal 现场：原 job（快照 + operations），不得静默丢弃 */
  var STOP_REASON = null;       /* 进入 recovering/stopped 的原因码 */
  var WRITER_KEY = null;        /* 当前基线对应的 writer 身份：ownerId|epoch */
  /* 5B-5-R：恢复凭据（闭包私有，绝不通过可赋值的标志暴露）。
     只有 resolve() 的 writerChanged 分支在内部签发；completeRehydrate 按引用核对，
     一次成功即消费。外部伪造的普通对象永远无法通过 === 校验。 */
  var REHYDRATE_ROUND = 0;      /* 每次签发凭据递增；旧轮次凭据随之失效 */
  var REHYDRATE_CRED = null;    /* { round, writerKey, revAtIssue, issuedAt, used } */
  var BASELINE_INFLIGHT = false;/* 只读基线读取在途，防重入 */
  var SEQ = 0;                  /* 诊断用递增计数；jobId 唯一性不再依赖它 */
  var OP_SEQ = 0;               /* operation 序号（与 job 独立） */
  var ATTEMPT_SEQ = 0;          /* attempt/commitTag 序号（模块内全局单调） */
  var HF_TIMER = null;          /* 高频通道 debounce 定时器 */
  var HF_OPS = [];              /* 高频通道缓冲的 operations */
  var HF_DELAY_MS = 300;        /* 高频通道独立延迟；普通 enqueue 不受影响 */
  var HF_PENDING_RECOVERY = false; /* 恢复态期间滞留的 HF ops，恢复成功后必须重新 flush */
  var LISTENERS = [];           /* onResult 监听器 */

  /* ---------- 安全工具 ---------- */

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function safeClone(v) {
    if (v === null || typeof v !== 'object') return v;
    try {
      if (typeof global.structuredClone === 'function') return global.structuredClone(v);
    } catch (e) {}
    /* 业务 S 是纯 JSON 数据；JSON 往返作为回退并做等价校验 */
    try {
      var text = JSON.stringify(v);
      var out = JSON.parse(text);
      if (JSON.stringify(out) !== text) throw new Error('snapshot-loss');
      return out;
    } catch (e) {
      return null;              /* 无法安全快照 → 调用方据此失败关闭 */
    }
  }

  function makeOp(intent, kind, source) {
    return {
      opId: 'op-' + (++OP_SEQ),
      kind: kind || 'normal',
      source: source || 'user',
      intent: safeClone(intent === undefined ? null : intent),
      callback: (intent && typeof intent.onResult === 'function') ? intent.onResult : null,
      settled: false
    };
  }
  /* 跨页面刷新 / 模块重载仍唯一的 job 标识：时间戳 + 随机串，
     不依赖模块内加载即归零的 SEQ。生成结果满足 write.js tag 中段约束
     （1..128 字符，无冒号/控制字符）。 */
  function makeGlobalSuffix() {
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
    return Date.now().toString(36) + '-' + rnd;
  }

  function makeJob(ops, snapshot) {
    return {
      id: 'job-' + makeGlobalSuffix(),
      seq: ++SEQ,                 /* 仅诊断，不参与 tag */
      operations: ops,
      snapshot: snapshot,
      createdAt: Date.now(),
      attempts: 0
    };
  }

  /* ---------- 队列状态查询 ---------- */

  function status() {
    return {
      state: STATE,
      inFlight: INFLIGHT ? { id: INFLIGHT.id, attempts: INFLIGHT.attempts } : null,
      pending: PENDING ? { id: PENDING.id, opCount: PENDING.operations.length } : null,
      recoveringJob: RECOVERING_JOB ? {
        id: RECOVERING_JOB.id, attempts: RECOVERING_JOB.attempts,
        opCount: RECOVERING_JOB.operations.length
      } : null,
      committedBizRev: Q.committedBizRev,
      writerKey: WRITER_KEY,
      stopReason: STOP_REASON,
      hfBuffered: HF_OPS.length,
      hfPendingRecovery: HF_PENDING_RECOVERY,
      /* 5B-5-R：恢复诊断。只暴露轮次计数与“是否有待消费凭据”的布尔值，
         凭据对象本身永不放入 status/snapshot。 */
      rehydrateRound: REHYDRATE_ROUND,
      rehydrateCredentialPending: !!(REHYDRATE_CRED && !REHYDRATE_CRED.used),
      wired: !!(global.OLWrite && global.OLWrite.wired)
    };
  }

  function onResult(fn) {
    if (typeof fn !== 'function') return function () {};
    LISTENERS.push(fn);
    return function () {
      var i = LISTENERS.indexOf(fn);
      if (i >= 0) LISTENERS.splice(i, 1);
    };
  }

  function emitResult(ev) {
    for (var i = 0; i < LISTENERS.length; i++) {
      try { LISTENERS[i](safeClone(ev)); } catch (e) {}
    }
  }

  function settleOps(job, outcome) {
    if (!job || !Array.isArray(job.operations)) return;
    for (var i = 0; i < job.operations.length; i++) {
      var op = job.operations[i];
      if (op.settled) continue;                 /* 每个 operation 只结算一次 */
      op.settled = true;
      var cb = op.callback;
      if (typeof cb === 'function') {
        try { cb({ ok: outcome.ok, code: outcome.code, jobId: job.id, opId: op.opId, rev: outcome.rev }); }
        catch (e) {}
      }
    }
  }

  /* ---------- 入队 ---------- */

  /* enqueue(intent, opts)：同步捕获当前 S 的完整快照，进入串行队列。
     intent 可带 { onResult, source, kind }；opts 可带 { highFrequency:true }。
     返回 { ok, jobId, opId, deferred }；快照失败返回 { ok:false, code:'snapshot-failed' }。 */
  function enqueue(intent, opts) {
    opts = opts || {};
    if (STATE === 'recovering' || STATE === 'stopped') {
      return { ok:false, code:'queue-stopped', stopReason:STOP_REASON };
    }
    var op = makeOp(intent, intent && intent.kind, intent && intent.source);
    if (!op.intent && intent !== undefined && intent !== null) {
      return { ok:false, code:'snapshot-failed', opId:op.opId };
    }
    /* 高频通道：单独 debounce，不进入普通队列的即时 drain */
    if (opts.highFrequency === true) {
      HF_OPS.push(op);
      scheduleHighFrequencyFlush();
      return { ok:true, jobId:null, opId:op.opId, deferred:true, highFrequency:true };
    }

    var snap = safeClone(global.S);
    if (snap === null) return { ok:false, code:'snapshot-failed', opId:op.opId };

    if (PENDING) {
      /* 合并：operations 追加（不丢来源/反馈），快照整体替换为最新，不改已入队对象内部 */
      PENDING.operations.push(op);
      PENDING.snapshot = snap;
      Q.pendingSnapshot = snap;
      return { ok:true, jobId:PENDING.id, opId:op.opId, deferred:true };
    }
    var job = makeJob([op], snap);
    PENDING = job;
    Q.pendingSnapshot = snap;
    var started = drain();
    return { ok:true, jobId:job.id, opId:op.opId, deferred:!started };
  }

  /* 高频通道：debounce 到期后，把缓冲的 ops 合并成一个 job 进入普通队列。
     合并时重新捕获最新 S 快照，保证高频修改都落进这一次提交。 */
  function scheduleHighFrequencyFlush() {
    if (HF_TIMER !== null) return;
    HF_TIMER = global.setTimeout(function () {
      HF_TIMER = null;
      var ops = HF_OPS;
      HF_OPS = [];
      if (!ops.length) return;
      if (STATE === 'recovering' || STATE === 'stopped' || STATE === 'baseline') {
        /* 恢复 / 基线态：ops 与回调原样留在内存，置标志；恢复出口必须重新安排 flush */
        HF_OPS = ops.concat(HF_OPS);
        HF_PENDING_RECOVERY = true;
        return;
      }
      var snap = safeClone(global.S);
      if (snap === null) { HF_OPS = ops.concat(HF_OPS); return; }
      if (PENDING) {
        for (var i = 0; i < ops.length; i++) PENDING.operations.push(ops[i]);
        PENDING.snapshot = snap;
        Q.pendingSnapshot = snap;
      } else {
        var job = makeJob(ops, snap);
        PENDING = job;
        Q.pendingSnapshot = snap;
      }
      drain();
    }, HF_DELAY_MS);
  }

  /* ---------- 身份 / 基线 / 快照工具 ---------- */

  function currentIdentity() {
    if (!(global.OLWrite && typeof global.OLWrite.currentWriterIdentity === 'function')) return null;
    var id = global.OLWrite.currentWriterIdentity();
    return (id && typeof id.ownerId === 'string' && id.ownerId) ? id : null;
  }
  function writerKeyOf(ident) { return ident ? (ident.ownerId + '|' + ident.epoch) : null; }
  function currentS() { return safeClone(global.S); }
  function sameSnapshot(a, b) {
    if (a === null || b === null || a === undefined || b === undefined) return false;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
  }

  /* 只读对齐当前库 bizRev。迁移未完成 / 值非法 / API 缺失一律失败关闭，
     不允许"基线未知仍提交"。 */
  function readBaseline(ident) {
    if (!(global.OLWrite && typeof global.OLWrite.readBizRev === 'function')) {
      return Promise.resolve({ ok:false, code:'baseline-api-missing' });
    }
    return Promise.resolve().then(function () {
      return global.OLWrite.readBizRev();
    }).then(function (r) {
      if (!r || !r.ok || typeof r.rev !== 'number' || !isFiniteNumber(r.rev) || r.rev < 0) {
        return { ok:false, code:(r && r.code) || 'baseline-unavailable' };
      }
      return { ok:true, rev:r.rev, writerKey:writerKeyOf(ident) };
    }, function (e) {
      return { ok:false, code:(e && e.code) || 'baseline-read-failed' };
    });
  }

  /* 恢复出口：把恢复 / 基线态期间滞留的高频 ops 重新排入 flush */
  function flushHighFrequencyIfRecovered() {
    if (!HF_PENDING_RECOVERY) return false;
    HF_PENDING_RECOVERY = false;
    scheduleHighFrequencyFlush();
    return true;
  }

  /* ---------- 串行提交 ---------- */

  /* drain()：启动一次提交。基线未知或 writer 身份变化先走只读对齐；
     返回 true 表示"已发起一次 drain 尝试或基线准备"（被守卫拒绝返回 false）。 */
  function drain() {
    if (STATE !== 'idle') return false;
    if (INFLIGHT) return false;
    if (!PENDING) return false;
    if (!(global.OLWrite && typeof global.OLWrite.commit === 'function')) return false;

    var ident = currentIdentity();
    if (!ident) return false;                    /* 无 writer 身份：不提交 */
    var key = writerKeyOf(ident);

    /* 基线未知 / writer 变化：先只读读库对齐，禁止无 expectedRev 提交 */
    if (Q.committedBizRev === null || WRITER_KEY !== key) {
      if (BASELINE_INFLIGHT) return false;
      BASELINE_INFLIGHT = true;
      var previousKey = WRITER_KEY;
      STATE = 'baseline';
      readBaseline(ident).then(function (res) {
        if (!BASELINE_INFLIGHT) return;
        BASELINE_INFLIGHT = false;
        if (STATE !== 'baseline') return;
        STATE = 'idle';
        if (!res.ok) {
          STATE = 'recovering';
          STOP_REASON = res.code;
          emitResult({ type:'fatal', code:res.code, phase:'baseline' });
          return;
        }
        var changed = (previousKey !== null && previousKey !== key);
        Q.committedBizRev = res.rev;
        WRITER_KEY = key;
        if (changed) {
          /* 新 writer 不得沿用旧快照与版本基线：重新捕获当前内存 S */
          Q.committedSnapshot = null;
          var fresh = currentS();
          if (fresh === null) {
            STATE = 'recovering';
            STOP_REASON = 'snapshot-failed';
            emitResult({ type:'fatal', code:'snapshot-failed', phase:'baseline' });
            return;
          }
          if (PENDING) { PENDING.snapshot = fresh; Q.pendingSnapshot = fresh; }
          emitResult({ type:'writer-changed', writerKey:key, rev:res.rev });
        }
        flushHighFrequencyIfRecovered();
        drain();
      }, function (e) {
        if (!BASELINE_INFLIGHT) return;
        BASELINE_INFLIGHT = false;
        if (STATE !== 'baseline') return;
        STATE = 'recovering';
        STOP_REASON = (e && e.code) || 'baseline-read-failed';
        emitResult({ type:'fatal', code:STOP_REASON, phase:'baseline' });
      });
      return true;
    }

    var job = PENDING;
    PENDING = null;                       /* 出队并冻结：in-flight 快照不再被合并 */
    var id = job.id;
    job.attempts += 1;
    var attempt = job.attempts;
    INFLIGHT = job;
    STATE = 'submitting';

    /* attempt token：<tabId>:<jobIdNoPrefix>:<attempt>@<seq>；
       tabId 取自 OLWrite.tabId，与 write.js 的 TAB_ID 及凭据 value.tabId 一致。 */
    var tabId = (global.OLWrite && global.OLWrite.tabId) || 'tab-unknown';
    var jobSeg = String(id).replace(/^job-/, '');
    var commitTag = tabId + ':' + jobSeg + ':' + attempt + '@' + (++ATTEMPT_SEQ);

    var options = {
      tabId: tabId,
      ownerId: ident.ownerId,
      epoch: ident.epoch,
      commitTag: commitTag,
      jobId: id,
      attempt: attempt,
      expectedRev: Q.committedBizRev       /* 基线已就绪，必传 */
    };

    var p;
    try {
      p = global.OLWrite.commit(job.snapshot, options);
    } catch (e) {
      return handleCommitResult(job, {
        ok:false, code:(e && e.code) || 'commit-threw', message:String(e && e.message || e),
        rolledBack:true
      }, commitTag);
    }
    if (!p || typeof p.then !== 'function') {
      return handleCommitResult(job, { ok:false, code:'commit-no-promise', rolledBack:true }, commitTag);
    }
    p.then(function (r) {
      handleCommitResult(job, r, commitTag);
    }, function (e) {
      handleCommitResult(job, { ok:false, code:(e && e.code) || 'commit-rejected',
        message:String(e && e.message || e), rolledBack:true }, commitTag);
    });
    return true;
  }

  /* 处理提交结果：成功更新 committed 状态；失败区分"可重试"与"停队列恢复态"。 */
  function handleCommitResult(job, r, commitTag) {
    if (INFLIGHT !== job) return false;      /* 迟到回调：忽略，不改状态 */
    var code = r && r.code;
    var ok = !!(r && r.ok);

    if (ok) {
      STATE = 'idle';
      INFLIGHT = null;
      STOP_REASON = null;
      var rev = (typeof r.rev === 'number') ? r.rev : null;
      Q.committedBizRev = rev;              /* 只有确认提交才推进 expectedRev 基线 */
      Q.committedSnapshot = safeClone(job.snapshot);
      /* 内存 S 不回滚：保留用户当前修改；committedSnapshot 仅作已落库基线 */
      settleOps(job, { ok:true, code:'ok', rev:rev });
      emitResult({ type:'success', jobId:job.id, rev:rev, commitTag:commitTag });
      drain();                              /* 串行启动下一 job（若有） */
      return true;
    }

    /* 失败：保留内存修改，不覆盖 S；是否停队列按错误分类 */
    STATE = 'idle';
    INFLIGHT = null;
    var fatal = (code === 'stale-state' || code === 'writer-lost' ||
                 code === 'writer-not-held' || code === 'writer-identity-mismatch' ||
                 code === 'migration-missing' || code === 'migration-not-done' ||
                 /* 5B-5：库端明确失权（他页接管 / 租约过期 / 行缺失或损坏）也必须停队列。
                    这些码由 write.js 的 checkWriteLeaseInTx 返回，旧页继续入队只会反复失败。 */
                 code === 'writer-owner-changed' || code === 'writer-epoch-changed' ||
                 code === 'writer-lease-expired' || code === 'writer-missing' ||
                 code === 'writer-vanished' || code === 'writer-inactive' ||
                 code === 'writer-epoch-below-floor' || code === 'writer-epoch-invalid' ||
                 code === 'writer-lease-invalid');
    if (fatal) {
      STATE = 'recovering';
      STOP_REASON = code;
      /* 原 job（含快照与 operations）完整保留，不静默丢弃；
         operation 暂不结算，等 resolve() 出口明确 retry / discard / recapture。 */
      RECOVERING_JOB = job;
      emitResult({ type:'fatal', jobId:job.id, code:code, stopReason:code,
                   recoveringOpCount:job.operations.length });
      return true;                          /* 停队列，不再 drain */
    }

    /* 普通失败：把 job 放回队首，允许显式 retry；不自动重试。
       operation 不在此时结算，retry 成功后收到最终成功，放弃时由 abort() 结算失败。 */
    PENDING = job;
    if (!Q.pendingSnapshot) Q.pendingSnapshot = job.snapshot;
    emitResult({ type:'failure', jobId:job.id, code:code, retryable:true });
    return true;
  }

  /* ---------- 恢复与重试 ---------- */

  /* retry()：仅普通失败态可重试。先比对当前内存 S 与失败快照；
     若已变化则拒绝提交冻结的旧快照，要求调用方重新 enqueue 捕获最新状态。 */
  function retry() {
    if (STATE !== 'idle') return { ok:false, code:'retry-not-allowed', state:STATE };
    if (!PENDING) return { ok:false, code:'no-pending' };
    var fresh = currentS();
    if (fresh === null) return { ok:false, code:'snapshot-failed' };
    if (!sameSnapshot(fresh, PENDING.snapshot)) {
      return { ok:false, code:'snapshot-changed',
               message:'内存状态已变化，禁止提交冻结的旧快照；请重新 enqueue 捕获当前状态' };
    }
    return { ok:true, started:drain() };
  }

  /* 明确放弃当前 PENDING：结算一次失败，避免 operation 永远悬挂。 */
  function abort() {
    if (STATE !== 'idle') return { ok:false, code:'abort-not-allowed', state:STATE };
    if (!PENDING) return { ok:false, code:'no-pending' };
    var job = PENDING;
    PENDING = null;
    Q.pendingSnapshot = null;
    settleOps(job, { ok:false, code:'aborted', rev:null });
    emitResult({ type:'aborted', jobId:job.id });
    return { ok:true, jobId:job.id };
  }

  /* resolve()：recovering 的唯一出口，必须显式指定 action：
       retry     —— 仅在 writer / 基线 / 内存快照均未变化时安全重放原 job；
       discard   —— 明确放弃保留的 job，结算失败并向调用者报告；
       recapture —— 结算旧 job 失败，要求调用方按当前 S 重新 enqueue。
     返回 Promise；重新只读对齐基线，无法确认时保持 recovering 并失败关闭。 */
  function resolve(options) {
    options = isPlainObject(options) ? options : {};
    if (STATE !== 'recovering') {
      return Promise.resolve({ ok:false, code:'not-recovering', state:STATE });
    }
    var action = options.action;
    if (action !== 'retry' && action !== 'discard' && action !== 'recapture') {
      return Promise.resolve({ ok:false, code:'action-required',
        message:'必须显式指定 action: retry | discard | recapture' });
    }
    var ident = currentIdentity();
    if (!ident) return Promise.resolve({ ok:false, code:'writer-not-ready', stopReason:STOP_REASON });

    return readBaseline(ident).then(function (res) {
      if (STATE !== 'recovering') return { ok:false, code:'state-changed' };
      if (!res.ok) return { ok:false, code:res.code, phase:'baseline' };

      var job = RECOVERING_JOB;
      var key = res.writerKey;
      var writerChanged = (WRITER_KEY !== null && WRITER_KEY !== key);
      var baselineChanged = (Q.committedBizRev !== null && Q.committedBizRev !== res.rev);
      var fresh = null, snapChanged = false;
      if (job) {
        fresh = currentS();
        if (fresh === null) return { ok:false, code:'snapshot-failed' };
        snapChanged = !sameSnapshot(fresh, job.snapshot);
      }

      if (action === 'retry') {
        if (!job) return { ok:false, code:'no-recovering-job' };
        if (writerChanged) return { ok:false, code:'writer-changed-requires-recapture' };
        if (baselineChanged || snapChanged) {
          return { ok:false, code:'state-changed-requires-recapture',
                   detail:{ baselineChanged:baselineChanged, snapshotChanged:snapChanged,
                            oldRev:Q.committedBizRev, currentRev:res.rev } };
        }
        Q.committedBizRev = res.rev;
        WRITER_KEY = key;
        STATE = 'idle';
        STOP_REASON = null;
        RECOVERING_JOB = null;
        PENDING = job;
        Q.pendingSnapshot = job.snapshot;
        flushHighFrequencyIfRecovered();
        return { ok:true, action:'retry', started:drain() };
      }

      /* writer 已变化：旧快照可能建立在旧库状态上，禁止自动重放或直接恢复写入。
         明确结算 job 后停在 stopped（rehydrate-required），等调用方先从库里重建 S，
         再由 completeRehydrate() 读取最新基线后恢复队列。 */
      if (writerChanged) {
        if (job) {
          settleOps(job, { ok:false, code:'writer-changed', rev:null });
          emitResult({ type:(action === 'discard' ? 'discarded' : 'recapture-required'),
                       jobId:job.id, code:'writer-changed' });
        }
        Q.committedBizRev = null;      /* 不沿用旧 writer 的基线 */
        Q.pendingSnapshot = null;
        PENDING = null;
        RECOVERING_JOB = null;
        WRITER_KEY = key;
        STATE = 'stopped';
        STOP_REASON = 'rehydrate-required';
        /* 内部签发一次性恢复凭据：绑定本轮 round 与签发时的 writer 身份。
           只随本次返回值交给调用方；没有走真实 discard/recapture 流程的调用者拿不到。 */
        REHYDRATE_ROUND += 1;
        REHYDRATE_CRED = { round: REHYDRATE_ROUND, writerKey: key,
                           revAtIssue: res.rev, issuedAt: Date.now(), used: false };
        return { ok:true, action:action, started:false, rehydrateRequired:true,
                 rev:res.rev, rehydrateCredential:REHYDRATE_CRED };
      }

      /* discard / recapture：明确结算保留的 job 一次，operations 不悬挂 */
      Q.committedBizRev = res.rev;
      WRITER_KEY = key;
      STATE = 'idle';
      STOP_REASON = null;
      RECOVERING_JOB = null;
      if (job) {
        settleOps(job, { ok:false, code:(action === 'discard' ? 'discarded' : 'recapture-required'), rev:null });
        emitResult({ type:action === 'discard' ? 'discarded' : 'recapture-required', jobId:job.id });
      }
      flushHighFrequencyIfRecovered();
      return { ok:true, action:action, started:false };
    }, function (e) {
      return { ok:false, code:(e && e.code) || 'resolve-failed' };
    });
  }

  /* completeRehydrate(credential, mergedRev)：writer 变化后的唯一安全恢复入口。
     credential 必须是 resolve() writerChanged 分支内部签发的同一个对象（按引用核对，
     伪造对象 / 旧轮次 / 已消费 / 重复使用一律拒绝）；mergedRev 必须是调用方
     真实 rehydrate 读回并合并时同事务读到的 bizRev（本函数会重新只读对齐核对）。
     成功：凭据一次性消费，队列以最新 rev 为基线恢复 idle。
     失败（writer 或 bizRev 在恢复期间又变化）：凭据作废并在结果中签发新一轮，
     队列保持 stopped/rehydrate-required，绝不带旧内存状态恢复写入。 */
  function completeRehydrate(credential, mergedRev) {
    if (STATE !== 'stopped' || STOP_REASON !== 'rehydrate-required') {
      return Promise.resolve({ ok:false, code:'not-awaiting-rehydrate', state:STATE, stopReason:STOP_REASON });
    }
    if (!credential || credential !== REHYDRATE_CRED || credential.used) {
      return Promise.resolve({ ok:false, code:'rehydrate-credential-invalid',
        detail:{ provided:!!credential, isCurrent:credential === REHYDRATE_CRED, used:!!(credential && credential.used) } });
    }
    if (typeof mergedRev !== 'number' || !isFiniteNumber(mergedRev) || mergedRev < 0) {
      return Promise.resolve({ ok:false, code:'rehydrate-rev-missing',
        message:'必须传入真实 rehydrate 同事务读到的 bizRev' });
    }
    var ident = currentIdentity();
    if (!ident) return Promise.resolve({ ok:false, code:'writer-not-ready' });
    credential.used = true;               /* 防并发双花：进入即标记 */
    return readBaseline(ident).then(function (res) {
      if (STATE !== 'stopped' || STOP_REASON !== 'rehydrate-required') {
        return { ok:false, code:'state-changed' };
      }
      if (!res.ok) { credential.used = false; return { ok:false, code:res.code, phase:'baseline' }; }
      if (res.writerKey !== credential.writerKey) {
        /* writer 在恢复期间再次变化：本轮凭据作废，签发新一轮（旧引用自动失效） */
        REHYDRATE_ROUND += 1;
        REHYDRATE_CRED = { round: REHYDRATE_ROUND, writerKey: res.writerKey,
                           revAtIssue: res.rev, issuedAt: Date.now(), used: false };
        return { ok:false, code:'rehydrate-stale-writer-changed', credential:REHYDRATE_CRED,
                 detail:{ credRound:credential.round, nowRound:REHYDRATE_ROUND } };
      }
      if (res.rev !== mergedRev) {
        /* 库在重建之后又有提交：内存可能已经落后，作废并签发新一轮 */
        REHYDRATE_ROUND += 1;
        REHYDRATE_CRED = { round: REHYDRATE_ROUND, writerKey: res.writerKey,
                           revAtIssue: res.rev, issuedAt: Date.now(), used: false };
        return { ok:false, code:'rehydrate-stale-rev-changed', credential:REHYDRATE_CRED,
                 detail:{ mergedRev:mergedRev, currentRev:res.rev } };
      }
      /* 一次性消费：内部引用清空，凭据对象即刻作废 */
      REHYDRATE_CRED = null;
      credential.used = true;
      Q.committedBizRev = res.rev;
      WRITER_KEY = res.writerKey;
      Q.committedSnapshot = null;
      Q.pendingSnapshot = null;
      PENDING = null;
      RECOVERING_JOB = null;
      STATE = 'idle';
      STOP_REASON = null;
      flushHighFrequencyIfRecovered();
      return { ok:true, rev:res.rev, writerKey:res.writerKey, round:credential.round };
    }, function (e) {
      credential.used = false;            /* 失败不吞凭据，调用方可重试 */
      return { ok:false, code:(e && e.code) || 'rehydrate-failed' };
    });
  }

  function pause() {
    if (STATE === 'submitting' || STATE === 'baseline' || STATE === 'recovering') {
      return { ok:false, code:'pause-not-allowed', state:STATE };
    }
    if (STATE === 'idle') { STATE = 'stopped'; return { ok:true }; }
    return { ok:false, code:'pause-not-allowed', state:STATE };
  }
  function resume() {
    if (STATE !== 'stopped') return { ok:false, code:'not-stopped', state:STATE };
    /* writer 变化后的 stopped 不能靠 resume 绕过重建：必须先 rehydrate + completeRehydrate */
    if (STOP_REASON === 'rehydrate-required') {
      return { ok:false, code:'rehydrate-required',
               message:'写入权已变化，必须先从库里重建当前状态再恢复' };
    }
    STATE = 'idle';
    flushHighFrequencyIfRecovered();
    var started = drain();
    return { ok:true, started:started };
  }

  /* ---------- 只读诊断 ---------- */

  function snapshot() {
    return {
      committedSnapshot: safeClone(Q.committedSnapshot),
      pendingSnapshot: safeClone(Q.pendingSnapshot),
      recoveringSnapshot: RECOVERING_JOB ? safeClone(RECOVERING_JOB.snapshot) : null,
      committedBizRev: Q.committedBizRev,
      writerKey: WRITER_KEY,
      state: STATE
    };
  }

  var api = {
    enqueue: enqueue,
    drain: drain,
    retry: retry,
    resolve: resolve,
    completeRehydrate: completeRehydrate,
    abort: abort,
    pause: pause,
    resume: resume,
    status: status,
    snapshot: snapshot,
    onResult: onResult,
    /* 高频通道延迟可调（测试用；默认 300ms） */
    setHighFrequencyDelay:function (ms){ if (isFiniteNumber(ms) && ms>=0) HF_DELAY_MS=ms; }
  };

  function isFiniteNumber(v){ return typeof v === 'number' && isFinite(v); }

  global.OLCommitQueue = api;
})(typeof window !== 'undefined' ? window : this);
