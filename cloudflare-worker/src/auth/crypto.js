/* auth/crypto.js — 认证相关的纯密码学/编码工具（无 D1、无网络） */

function b64url(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(byteLength) {
  var n = byteLength || 32;
  var buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

/* 6 位数字验证码：拒绝采样避免取模偏置 */
export function randomCode() {
  var out = '';
  while (out.length < 6) {
    var buf = new Uint8Array(1);
    crypto.getRandomValues(buf);
    if (buf[0] < 250) out += String(buf[0] % 10);
  }
  return out;
}

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  var s = value.trim().toLowerCase();
  if (s.length < 3 || s.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

export function maskEmail(email) {
  if (typeof email !== 'string' || email.indexOf('@') < 0) return '';
  var i = email.indexOf('@');
  var name = email.slice(0, i);
  var domain = email.slice(i + 1);
  return (name.charAt(0) || '*') + '***@' + domain;
}

export async function sha256Hex(value) {
  var data = new TextEncoder().encode(String(value));
  var digest = await crypto.subtle.digest('SHA-256', data);
  var bytes = new Uint8Array(digest);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/* 验证码摘要绑定邮箱与服务端 pepper：库泄露时不能直接离线比对 10^6 空间 */
export function codeDigest(env, emailNorm, code) {
  return sha256Hex((env && env.AUTH_CODE_PEPPER ? env.AUTH_CODE_PEPPER : '') + '|v1|' + emailNorm + '|' + code);
}

export function sessionCookieName(env) {
  return crossSiteAllowed(env) ? '__Secure-eo_sess' : '__Host-eo_sess';
}

function crossSiteAllowed(env) {
  return !!(env && env.AUTH_COOKIE_MODE === 'cross-site' && env.AUTH_ALLOW_CROSS_SITE === 'true');
}

export function sessionCookie(env, token, maxAgeSec) {
  var name = sessionCookieName(env);
  var parts = [
    name + '=' + token,
    'Path=/',
    'Secure',
    'HttpOnly',
    'SameSite=' + (crossSiteAllowed(env) ? 'None' : 'Lax'),
    'Max-Age=' + Math.max(1, maxAgeSec | 0)
  ];
  /* __Host- 明确禁止 Domain；同源形态不写 Domain，宿主-only 最安全 */
  return parts.join('; ');
}

export function clearSessionCookie(env) {
  var name = sessionCookieName(env);
  return name + '=; Path=/; Secure; HttpOnly; SameSite=' +
    (crossSiteAllowed(env) ? 'None' : 'Lax') + '; Max-Age=0';
}

export function readSessionCookie(request, env) {
  var raw = request.headers.get('Cookie') || '';
  var target = sessionCookieName(env);
  var items = raw.split(';');
  for (var i = 0; i < items.length; i++) {
    var kv = items[i].trim();
    var eq = kv.indexOf('=');
    if (eq > 0 && kv.slice(0, eq) === target) return kv.slice(eq + 1);
  }
  return null;
}
