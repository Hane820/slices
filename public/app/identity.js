/* identity.js — 数据空间的唯一权威来源（本轮只有 local / guest 两个空间）
 *
 * 背景（代码事实）：
 *   本应用没有账号体系。没有登录页、没有用户 ID、没有服务端用户数据；
 *   唯一的认证是备份 Worker 背后的 Cloudflare Access，它只保护 /api/*，
 *   前端读不到身份，也不该拿它当身份。所以这里不定义 authenticated，
 *   只定义「这次页面加载用哪个本地数据库」：
 *     local —— 现有的本机数据库 earthonline（默认值，行为与以前完全一致）
 *     guest —— 独立的游客数据库 earthonline-guest（演示数据，独立空间）
 *
 * 为什么存 sessionStorage 而不是 localStorage：
 *   本轮产品决策不提供登录/切换入口。若游客身份持久化，用户点进游客空间后
 *   就再也回不到本机数据（数据没删，但进不去）。用 sessionStorage 后：
 *     刷新页面 → 仍在游客空间（同一标签页）
 *     关闭标签页/浏览器 → 自动回到本机数据
 *     游客数据本身仍在 IndexedDB 里，下次再点「游客体验」能接着用
 *   将来接入真实认证时，把 STORE 换成 localStorage 并补登录/切换流程即可，
 *   本模块的 mode()/dbName() 调用方不用改。
 *
 * 安全失败策略：
 *   完全没记录 → local（保持现有用户行为，不打扰）
 *   记录存在但读不懂 → guest（宁可不打开正式数据，也不猜）
 */
(function (global) {
  'use strict';

  var KEY       = 'earthonline-space';   /* 只写 'guest'；local 是默认，不落盘 */
  var FORMAL_DB = 'earthonline';
  var GUEST_DB  = 'earthonline-guest';

  function store() {
    try { return global.sessionStorage || null; } catch (e) { return null; }
  }

  function readRaw() {
    var s = store();
    if (!s) return null;
    try { return s.getItem(KEY); } catch (e) { return null; }
  }

  /* 'local' | 'guest'。唯一权威判定，其它模块一律不许自己判断。 */
  function mode() {
    var raw = readRaw();
    if (raw === null) return 'local';
    var v = String(raw);
    if (v === 'local') return 'local';
    if (v === 'guest') return 'guest';
    return 'guest';                      /* 值损坏：安全失败，不开正式库 */
  }

  function isGuest() { return mode() === 'guest'; }

  /* 当前页面应该使用的数据库名。db.js 在建 Dexie 实例前调用。 */
  function dbName() { return isGuest() ? GUEST_DB : FORMAL_DB; }

  function enterGuest() {
    var s = store();
    if (!s) return false;
    try { s.setItem(KEY, 'guest'); return true; } catch (e) { return false; }
  }

  function leaveGuest() {
    var s = store();
    if (!s) return false;
    try { s.removeItem(KEY); return true; } catch (e) { return false; }
  }

  global.OLIdentity = {
    KEY: KEY,
    FORMAL_DB: FORMAL_DB,
    GUEST_DB: GUEST_DB,
    mode: mode,
    isGuest: isGuest,
    dbName: dbName,
    enterGuest: enterGuest,
    leaveGuest: leaveGuest
  };
})(typeof window !== 'undefined' ? window : this);
