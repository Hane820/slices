/* auth/routes.js — 应用自有认证 API（D1 + HttpOnly Cookie）
 *
 * 与 Cloudflare Access 完全分离：备份路由仍由原有 Access JWT 校验保护；
 * 本模块只处理 /api/auth/*，身份一律来自服务端 Session，不信任前端 userId。
 */
import {
  normalizeEmail, maskEmail, sha256Hex, codeDigest,
  randomCode, randomToken, sessionCookie, clearSessionCookie, readSessionCookie
} from './crypto.js';
import { sendLoginCode } from './email.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_COOLDOWN_MS = 60 * 1000;
const EMAIL_HOUR_MS = 60 * 60 * 1000;
const MAX_EMAIL_PER_HOUR = 5;
const MAX_IP_PER_HOUR = 20;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
const AUTH_HEADER = 'X-Earthonline-Auth';

function fail(status, error, message) {
  return { status: status, body: { ok: false, error: error, message: message || error } };
}
function ok(status, body, headers) {
  return { status: status, body: body, headers: headers || null };
}
function changesOf(r) {
  if (!r) return 0;
  if (typeof r.changes === 'number') return r.changes;
  if (r.meta && typeof r.meta.changes === 'number') return r.meta.changes;
  return 0;
}
function db(env) {
  if (!env || !env.AUTH_DB) {
    throw Object.assign(new Error('认证数据库未绑定'), { status: 503, error: 'auth-unavailable' });
  }
  return env.AUTH_DB;
}

async function hitLimit(database, bucket, max, windowMs, now) {
  var row = await database.prepare('SELECT count, window_start FROM rate_limits WHERE bucket=?')
    .bind(bucket).first();
  if (row && (now - row.window_start) < windowMs && row.count >= max) return false;
  var count = (row && (now - row.window_start) < windowMs) ? (row.count + 1) : 1;
  await database.prepare(
    'INSERT INTO rate_limits(bucket,count,window_start) VALUES(?,?,?) ' +
    'ON CONFLICT(bucket) DO UPDATE SET count=excluded.count, window_start=excluded.window_start'
  ).bind(bucket, count, now).run();
  return true;
}

async function hashOf(env, value) {
  return sha256Hex((env && env.AUTH_IP_PEPPER ? env.AUTH_IP_PEPPER : 'v1') + '|' + value);
}

function requestIp(request) {
  return (request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown').split(',')[0].trim();
}

function requireCsrf(request, env, origin, needsJson) {
  if (origin && origin !== env.APP_ORIGIN) return fail(403, 'origin-forbidden', '来源不在允许列表');
  if (request.headers.get(AUTH_HEADER) !== '1') return fail(403, 'csrf-required', '缺少认证请求头');
  if (needsJson) {
    var ct = request.headers.get('Content-Type') || '';
    if (ct.indexOf('application/json') < 0) return fail(415, 'content-type-invalid', '需要 JSON 请求体');
  }
  return null;
}

async function readJson(request) {
  try {
    var body = await request.json();
    return (body && typeof body === 'object' && !Array.isArray(body)) ? body : null;
  } catch (e) { return null; }
}

/* ============ 发码 ============ */
async function requestCode(request, env, origin) {
  var csrf = requireCsrf(request, env, origin, true);
  if (csrf) return csrf;
  var body = await readJson(request);
  var email = body ? normalizeEmail(body.email) : null;
  if (!email) return fail(400, 'bad-email', '邮箱格式不正确');

  var database = db(env);
  var now = Date.now();
  var emailHash = await hashOf(env, email);
  var ipHash = await hashOf(env, requestIp(request));
  if (!(await hitLimit(database, 'cooldown:' + emailHash, 1, CODE_COOLDOWN_MS, now))) {
    return fail(429, 'rate-limited', '发送过于频繁，请稍后再试');
  }
  if (!(await hitLimit(database, 'email:' + emailHash, MAX_EMAIL_PER_HOUR, EMAIL_HOUR_MS, now))) {
    return fail(429, 'rate-limited', '该邮箱发送次数过多，请稍后再试');
  }
  if (!(await hitLimit(database, 'ip:' + ipHash, MAX_IP_PER_HOUR, EMAIL_HOUR_MS, now))) {
    return fail(429, 'rate-limited', '请求过于频繁，请稍后再试');
  }

  var code = randomCode();
  var id = 'c_' + randomToken(12);
  var digest = await codeDigest(env, email, code);
  await database.prepare(
    'INSERT INTO email_codes(id,email_norm,purpose,code_hash,attempts,max_attempts,created_at,expires_at,consumed_at,ip_hash) ' +
    'VALUES(?,?,?,?,0,5,?,?,NULL,?)'
  ).bind(id, email, 'login', digest, now, now + CODE_TTL_MS, ipHash).run();

  try {
    await sendLoginCode(env, { to: email, code: code, expiresAt: now + CODE_TTL_MS });
  } catch (e) {
    /* 发送失败：这张码作废，不向前端泄露是哪一个邮箱注册过 */
    try { await database.prepare('DELETE FROM email_codes WHERE id=?').bind(id).run(); } catch (ignore) {}
    var errCode = (e && (e.code || e.error)) || 'email-send-failed';
    return fail(503, errCode, '验证码发送失败，请稍后重试');
  }
  return ok(202, { ok: true, resendAfter: 60 });
}

/* ============ 验码登录 ============ */
async function verifyCode(request, env, origin) {
  var csrf = requireCsrf(request, env, origin, true);
  if (csrf) return csrf;
  var body = await readJson(request);
  var email = body ? normalizeEmail(body.email) : null;
  var code = body && typeof body.code === 'string' ? body.code.trim() : '';
  if (!email || !/^\d{6}$/.test(code)) return fail(400, 'bad-input', '邮箱或验证码格式不正确');

  var database = db(env);
  var row = await database.prepare(
    "SELECT * FROM email_codes WHERE email_norm=? AND purpose='login' AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1"
  ).bind(email).first();
  if (!row) return fail(400, 'code-invalid', '验证码不对或不存在');

  var now = Date.now();
  var digest = await codeDigest(env, email, code);
  if (digest !== row.code_hash) {
    /* 先取旧值：D1 的 first() 是快照，但某些实现/替可能返回同一对象引用 */
    var attemptsBefore = row.attempts || 0;
    var bumped = await database.prepare(
      'UPDATE email_codes SET attempts=attempts+1 WHERE id=? AND consumed_at IS NULL AND attempts<max_attempts'
    ).bind(row.id).run();
    if (changesOf(bumped) === 0) return fail(429, 'too-many-attempts', '尝试次数过多，请重新发送验证码');
    var attempts = attemptsBefore + 1;
    if (attempts >= (row.max_attempts || 5)) {
      await database.prepare('UPDATE email_codes SET consumed_at=? WHERE id=?').bind(now, row.id).run();
      return fail(429, 'too-many-attempts', '尝试次数过多，请重新发送验证码');
    }
    return fail(400, 'code-invalid', '验证码不对，还可以再试 ' + ((row.max_attempts || 5) - attempts) + ' 次');
  }
  if (!row.expires_at || row.expires_at <= now) {
    await database.prepare('UPDATE email_codes SET consumed_at=? WHERE id=?').bind(now, row.id).run();
    return fail(400, 'code-expired', '验证码过期了，请重新发送');
  }

  var consumed = await database.prepare(
    'UPDATE email_codes SET consumed_at=? WHERE id=? AND consumed_at IS NULL'
  ).bind(now, row.id).run();
  if (changesOf(consumed) === 0) return fail(400, 'code-consumed', '验证码已使用，请重新发送');

  var userId = 'u_' + randomToken(16);
  var spaceKey = 'u_' + userId;
  await database.prepare(
    'INSERT OR IGNORE INTO users(id,email,email_norm,space_key,status,created_at,email_verified_at,last_login_at) ' +
    "VALUES(?,?,?,?,'active',?,?,?)"
  ).bind(userId, email, email, spaceKey, now, now, now).run();
  var user = await database.prepare('SELECT * FROM users WHERE email_norm=?').bind(email).first();
  if (!user || user.status !== 'active') return fail(403, 'account-disabled', '账号不可用');

  var token = randomToken(32);
  var tokenHash = await sha256Hex(token);
  var sessionId = 's_' + randomToken(16);
  await database.prepare(
    'INSERT INTO sessions(id,user_id,token_hash,created_at,last_seen_at,expires_at,absolute_expires_at,revoked_at,ua_hash,ip_hash) ' +
    'VALUES(?,?,?,?,?,?,?,NULL,?,?)'
  ).bind(
    sessionId, user.id, tokenHash, now, now,
    now + SESSION_TTL_MS, now + SESSION_ABSOLUTE_MS,
    await hashOf(env, request.headers.get('User-Agent') || ''), await hashOf(env, requestIp(request))
  ).run();

  var safeUser = {
    id: user.id,
    spaceKey: user.space_key,
    emailMasked: maskEmail(user.email_norm),
    emailVerified: true
  };
  return ok(200, { ok: true, user: safeUser, expiresAt: now + SESSION_TTL_MS }, {
    'Set-Cookie': sessionCookie(env, token, Math.floor(SESSION_TTL_MS / 1000))
  });
}

/* ============ Session 中间层：业务路由必须从这里取身份 ============ */
export async function requireSession(request, env) {
  var token = readSessionCookie(request, env);
  if (!token) return null;
  var database = db(env);
  var tokenHash = await sha256Hex(token);
  var row = await database.prepare(
    'SELECT s.id AS session_id, s.expires_at, s.absolute_expires_at, s.last_seen_at, ' +
    'u.id AS user_id, u.email_norm, u.email, u.space_key, u.status ' +
    'FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?'
  ).bind(tokenHash).first();
  if (!row || row.status !== 'active') return null;
  var now = Date.now();
  if (row.revoked_at || row.expires_at <= now || row.absolute_expires_at <= now) return null;
  if (now - row.last_seen_at > 60 * 60 * 1000) {
    await database.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').bind(now, row.session_id).run();
  }
  return {
    user: {
      id: row.user_id,
      email: row.email_norm,
      emailMasked: maskEmail(row.email_norm),
      spaceKey: row.space_key
    },
    session: { id: row.session_id, expiresAt: row.expires_at }
  };
}

async function sessionRoute(request, env, origin) {
  if (request.method !== 'GET') return fail(405, 'method-not-allowed', '不支持的方法');
  var ctx = await requireSession(request, env);
  if (!ctx) return fail(401, 'no-session', '尚未登录或会话已失效');
  return ok(200, { ok: true, user: ctx.user, expiresAt: ctx.session.expiresAt });
}

async function logoutRoute(request, env, origin) {
  var csrf = requireCsrf(request, env, origin, false);
  if (csrf) return csrf;
  var ctx = await requireSession(request, env);
  var headers = { 'Set-Cookie': clearSessionCookie(env) };
  if (ctx) {
    await db(env).prepare('UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
      .bind(Date.now(), ctx.session.id).run();
  }
  /* 幂等：无有效会话也返回 204，便于补撤销 */
  return { status: 204, body: null, headers: headers };
}

async function logoutAllRoute(request, env, origin) {
  var csrf = requireCsrf(request, env, origin, false);
  if (csrf) return csrf;
  var ctx = await requireSession(request, env);
  if (!ctx) return fail(401, 'no-session', '尚未登录或会话已失效');
  var r = await db(env).prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL')
    .bind(Date.now(), ctx.user.id).run();
  return ok(200, { ok: true, revoked: changesOf(r) }, { 'Set-Cookie': clearSessionCookie(env) });
}

/* 返回 null = 不是认证路由，交回原有备份路由处理 */
export async function handleAuthRequest(request, env, origin) {
  var path = new URL(request.url).pathname;
  if (path.indexOf('/api/auth/') !== 0) return null;
  try {
    if (path === '/api/auth/code' && request.method === 'POST') return await requestCode(request, env, origin);
    if (path === '/api/auth/verify' && request.method === 'POST') return await verifyCode(request, env, origin);
    if (path === '/api/auth/session') return await sessionRoute(request, env, origin);
    if (path === '/api/auth/logout' && request.method === 'POST') return await logoutRoute(request, env, origin);
    if (path === '/api/auth/logout-all' && request.method === 'POST') return await logoutAllRoute(request, env, origin);
    return fail(404, 'not-found', '接口不存在');
  } catch (e) {
    var status = (e && e.status) || 500;
    var code = (e && (e.error || e.code)) || 'auth-error';
    return fail(status, code, status >= 500 ? '认证服务暂不可用' : code);
  }
}
