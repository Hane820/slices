/* identity.js — 本地空间身份的唯一权威来源（两态：guest / user）
 *
 * 产品规则（默认游客实施阶段）：
 *   打开应用 → 没有身份记录就是 guest，直接进入游客空间；
 *   旧版本数据识别成功后接入 guest（认领 earthonline 库，零复制）；
 *   探测 unknown → 由启动层阻断，本模块只负责如实给出"无记录"；
 *   已存在的合法身份（guest / local）绝不被默认游客逻辑覆盖。
 *
 * 关于 local：
 *   当前仓库还没有账号体系，local 是"正式空间"的历史值，等价于将来两态模型里的
 *   user 空间。本阶段不实现登录，但必须保留 local 记录的语义：一旦显式存在，
 *   启动层就按它打开正式库，绝不擅自切成游客。
 *
 * 存储：sessionStorage 'earthonline-space'。
 *   旧值是裸字符串 'guest' / 'local'；新值是 JSON 记录（带 dbName / adoptedOldData）。
 *   两种都读，读不懂时 fail-closed 到 guest（宁可不开正式库，也不猜）。
 *
 * 不读写 localStorage：旧版数据探测属于 startup.js 的职责，身份模块只表达身份。
 */
(function (global) {
  'use strict';

  var KEY       = 'earthonline-space';
  var FORMAL_DB = 'earthonline';
  var GUEST_DB  = 'earthonline-guest';
  /* 登录时暂时记住游客记录（含认领旧库的 dbName），退出时原样恢复；不存任何 token */
  var GUEST_MEM_KEY = 'earthonline-guest-record';

  function store() {
    try { return global.sessionStorage || null; } catch (e) { return null; }
  }

  function readRaw() {
    var s = store();
    if (!s) return null;
    try { return s.getItem(KEY); } catch (e) { return null; }
  }

  /* 把裸字符串或 JSON 记录统一解析成规范记录；无法解析返回 null。
     null 表示"没有合法记录"，由调用方决定如何处理（本阶段 = 默认 guest）。 */
  function parse(raw) {
    if (raw === null || raw === undefined) return null;
    var v = String(raw);
    if (v === 'guest') {
      return { space: 'guest', dbName: GUEST_DB, adoptedOldData: false, source: 'legacy-string' };
    }
    if (v === 'local') {
      return { space: 'local', dbName: FORMAL_DB, adoptedOldData: false, source: 'legacy-string' };
    }
    var o = null;
    try { o = JSON.parse(v); } catch (e) { return null; }
    if (!o || typeof o !== 'object') return null;
    if (o.space !== 'guest' && o.space !== 'local') return null;
    if (typeof o.dbName !== 'string' || !o.dbName) return null;
    if (o.dbName !== FORMAL_DB && o.dbName !== GUEST_DB) return null;
    return {
      space: o.space,
      dbName: o.dbName,
      adoptedOldData: o.adoptedOldData === true,
      source: typeof o.source === 'string' ? o.source : 'record',
      /* 仅展示用途：邮箱是服务端返回的脱敏值，绝不是服务端凭证 */
      email: typeof o.email === 'string' && o.email ? o.email : null,
      userId: typeof o.userId === 'string' && o.userId ? o.userId : null
    };
  }

  /* 当前身份记录；无合法记录返回 null。唯一权威入口，其它模块不要自己读 sessionStorage。 */
  function record() { return parse(readRaw()); }

  /* 是否已经落定身份（探测后由 settle 写入）。启动层据此决定要不要做旧数据探测。 */
  function hasRecord() { return record() !== null; }

  /* mode() 保持旧接口：'guest' | 'local'。
     无记录 = 默认游客（与旧版"无记录=local"相反，这是本阶段的产品变更）。 */
  function mode() {
    var r = record();
    return r ? r.space : 'guest';
  }

  function isGuest() { return mode() === 'guest'; }

  /* 当前应该使用的库名。db.js 只读取它，不自行猜测。 */
  function dbName() {
    var r = record();
    return r ? r.dbName : GUEST_DB;
  }

  /* 启动层探测完成后落定身份。已有合法记录一律拒绝覆盖 ——
     一次旧数据探测绝不能改写用户当前正在使用的空间。 */
  function settle(next) {
    if (hasRecord()) return { ok: false, reason: 'already-settled', record: record() };
    if (!next || typeof next !== 'object') return { ok: false, reason: 'invalid-record' };
    var space = next.space === 'local' ? 'local' : (next.space === 'guest' ? 'guest' : null);
    var dbName = next.dbName;
    if (!space || (dbName !== FORMAL_DB && dbName !== GUEST_DB)) {
      return { ok: false, reason: 'invalid-record' };
    }
    var s = store();
    if (!s) return { ok: false, reason: 'storage-unavailable' };
    var value = JSON.stringify({
      space: space,
      dbName: dbName,
      adoptedOldData: next.adoptedOldData === true,
      source: typeof next.source === 'string' ? next.source : 'startup'
    });
    try { s.setItem(KEY, value); return { ok: true, record: record() }; }
    catch (e) { return { ok: false, reason: 'storage-write-failed' }; }
  }

  /* 兼容旧接口：进入游客。
     守卫（默认游客实施）：已经有合法 guest 记录时返回 false ——
     设置页旧的「游客体验」入口会无条件调它，若允许覆盖，认领记录
     {guest, earthonline, adoptedOldData} 会被裸字符串 'guest' 冲掉，
     下次启动就会打开 earthonline-guest 而旧库入口永久消失。宁可拒绝。 */
  function enterGuest() {
    var cur = record();
    if (cur && cur.space === 'guest') return false;
    var s = store();
    if (!s) return false;
    try { s.setItem(KEY, 'guest'); return true; } catch (e) { return false; }
  }

  function leaveGuest() {
    var s = store();
    if (!s) return false;
    try { s.removeItem(KEY); return true; } catch (e) { return false; }
  }

  /* 服务端 Session 验证成功后才能调用：切换到 user（历史值 local=正式库）。
     调用方必须已经拿到服务端确认；本模块本身不做任何网络验证。 */
  function enterUser(payload) {
    if (!payload || typeof payload !== 'object' || !payload.userId) {
      return { ok: false, reason: 'invalid-user' };
    }
    var s = store();
    if (!s) return { ok: false, reason: 'storage-unavailable' };
    var cur = record();
    if (cur && cur.space === 'guest') {
      try { s.setItem(GUEST_MEM_KEY, JSON.stringify(cur)); } catch (e) {}
    }
    try {
      s.setItem(KEY, JSON.stringify({
        space: 'local',
        dbName: FORMAL_DB,
        adoptedOldData: false,
        source: typeof payload.source === 'string' && payload.source ? payload.source : 'auth-session',
        email: typeof payload.email === 'string' && payload.email ? payload.email : null,
        userId: payload.userId
      }));
      return { ok: true, record: record() };
    } catch (e) { return { ok: false, reason: 'storage-write-failed' }; }
  }

  /* 退出 / Session 失效：回到 guest，恢复登录前的游客记录（包括认领旧库的库名）。
     只改身份记录，不删任何 IndexedDB 数据、不做任何合并。 */
  function demoteToGuest(reason) {
    var s = store();
    if (!s) return { ok: false, reason: 'storage-unavailable' };
    var cur = record();
    if (cur && cur.space === 'guest') return { ok: true, record: cur };
    var guest = null;
    try {
      var raw = s.getItem(GUEST_MEM_KEY);
      if (raw) guest = parse(raw);
    } catch (e) {}
    var value = guest
      ? Object.assign({}, guest, { source: reason || guest.source })
      : { space: 'guest', dbName: GUEST_DB, adoptedOldData: false, source: reason || 'logout' };
    try {
      s.setItem(KEY, JSON.stringify(value));
      s.removeItem(GUEST_MEM_KEY);
      return { ok: true, record: record() };
    } catch (e) { return { ok: false, reason: 'storage-write-failed' }; }
  }

  function isUser() { return mode() === 'local'; }

  global.OLIdentity = {
    KEY: KEY,
    FORMAL_DB: FORMAL_DB,
    GUEST_DB: GUEST_DB,
    GUEST_MEM_KEY: GUEST_MEM_KEY,
    record: record,
    hasRecord: hasRecord,
    mode: mode,
    isGuest: isGuest,
    isUser: isUser,
    dbName: dbName,
    settle: settle,
    enterGuest: enterGuest,
    leaveGuest: leaveGuest,
    enterUser: enterUser,
    demoteToGuest: demoteToGuest
  };
})(typeof window !== 'undefined' ? window : this);
