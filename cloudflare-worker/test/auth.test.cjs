/* auth.test.cjs — Phase Auth：真实 Worker 认证模块 + 内存 D1 替身
 * 测试的是 src/auth/* 的真实业务代码；只有 D1、邮件发送和网络是替身。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

let AUTH;
let sendLoginCode;

test.before(async () => {
  AUTH = await import('../src/auth/index.js');
  ({ sendLoginCode } = await import('../src/auth/email.js'));
});

/* ---------------- 最小 D1 实现：覆盖路由实际使用的 SQL ---------------- */
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  _table() { const m = this.sql.match(/(?:INTO|FROM|UPDATE)\s+(\w+)/); return m ? m[1] : ''; }
  async first() {
    const s = this.sql, a = this.args;
    if (/SELECT count, window_start FROM rate_limits/.test(s)) {
      return this.db.rows.rate_limits.find((r) => r.bucket === a[0]) || null;
    }
    if (/SELECT \* FROM email_codes/.test(s)) {
      return this.db.rows.email_codes
        .filter((r) => r.email_norm === a[0] && r.purpose === 'login' && r.consumed_at == null)
        .sort((x, y) => y.created_at - x.created_at)[0] || null;
    }
    if (/SELECT \* FROM users WHERE email_norm/.test(s)) {
      return this.db.rows.users.find((r) => r.email_norm === a[0]) || null;
    }
    if (/FROM sessions s JOIN users u/.test(s)) {
      const sess = this.db.rows.sessions.find((r) => r.token_hash === a[0]);
      if (!sess) return null;
      const u = this.db.rows.users.find((r) => r.id === sess.user_id);
      if (!u) return null;
      return {
        session_id: sess.id, expires_at: sess.expires_at,
        absolute_expires_at: sess.absolute_expires_at, last_seen_at: sess.last_seen_at,
        revoked_at: sess.revoked_at,
        user_id: u.id, email_norm: u.email_norm, email: u.email,
        space_key: u.space_key, status: u.status
      };
    }
    throw new Error('未支持的 SELECT: ' + s);
  }
  async run() {
    const s = this.sql, a = this.args, rows = this.db.rows;
    let m;
    if ((m = s.match(/INSERT (OR IGNORE )?INTO (\w+)\(([^)]+)\) VALUES\(([^)]+)\)/))) {
      const ignore = !!m[1], table = m[2];
      const cols = m[3].split(',').map((c) => c.trim());
      const vals = m[4].split(',').map((c) => c.trim().replace(/^'|'$/g, ''));
      const row = {};
      cols.forEach((c, i) => { row[c] = vals[i] === 'NULL' ? null : (vals[i] === '?' ? a.shift() : vals[i]); });
      if (ignore && table === 'users' && rows.users.some((r) => r.email_norm === row.email_norm)) {
        return { success: true, meta: { changes: 0 } };
      }
      if (table === 'rate_limits') {
        const idx = rows.rate_limits.findIndex((r) => r.bucket === row.bucket);
        if (idx >= 0) rows.rate_limits[idx] = row;
        else rows.rate_limits.push(row);
      } else rows[table].push(row);
      return { success: true, meta: { changes: 1 } };
    }
    if (/UPDATE rate_limits|ON CONFLICT\(bucket\)/.test(s)) {
      const row = { bucket: a[0], count: a[1], window_start: a[2] };
      const idx = rows.rate_limits.findIndex((r) => r.bucket === row.bucket);
      if (idx >= 0) rows.rate_limits[idx] = row; else rows.rate_limits.push(row);
      return { success: true, meta: { changes: 1 } };
    }
    if (/UPDATE email_codes SET attempts=attempts\+1/.test(s)) {
      const row = rows.email_codes.find((r) => r.id === a[0] && r.consumed_at == null && r.attempts < r.max_attempts);
      if (!row) return { success: true, meta: { changes: 0 } };
      row.attempts++;
      return { success: true, meta: { changes: 1 } };
    }
    if (/UPDATE email_codes SET consumed_at/.test(s)) {
      const row = rows.email_codes.find((r) => r.id === a[1] && r.consumed_at == null);
      if (!row) return { success: true, meta: { changes: 0 } };
      row.consumed_at = a[0];
      return { success: true, meta: { changes: 1 } };
    }
    if (/DELETE FROM email_codes WHERE id/.test(s)) {
      const n = rows.email_codes.length;
      rows.email_codes = rows.email_codes.filter((r) => r.id !== a[0]);
      return { success: true, meta: { changes: n - rows.email_codes.length } };
    }
    if (/UPDATE sessions SET last_seen_at/.test(s)) {
      const row = rows.sessions.find((r) => r.id === a[1]);
      if (row) row.last_seen_at = a[0];
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    if (/UPDATE sessions SET revoked_at=\? WHERE id/.test(s)) {
      const row = rows.sessions.find((r) => r.id === a[1] && r.revoked_at == null);
      if (row) row.revoked_at = a[0];
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    if (/UPDATE sessions SET revoked_at=\? WHERE user_id/.test(s)) {
      let n = 0;
      rows.sessions.forEach((r) => { if (r.user_id === a[1] && r.revoked_at == null) { r.revoked_at = a[0]; n++; } });
      return { success: true, meta: { changes: n } };
    }
    throw new Error('未支持的 SQL: ' + s);
  }
}
class D1Stub {
  constructor() { this.rows = { users: [], email_codes: [], sessions: [], rate_limits: [] }; }
  prepare(sql) { return new Stmt(this, sql); }
}

const ORIGIN = 'https://slices0flife.me';
const headers = { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Earthonline-Auth': '1' };

function setup(opts) {
  opts = opts || {};
  const db = new D1Stub();
  const sent = [];
  const env = {
    AUTH_DB: db,
    APP_ORIGIN: ORIGIN,
    AUTH_CODE_PEPPER: 'test-pepper-32-bytes-minimum-0001',
    AUTH_IP_PEPPER: 'ip-pepper',
    EMAIL_DRIVER: opts.emailDriver || 'none',
    ALLOW_TEST_EMAIL: opts.mailStub === false ? 'false' : 'true',
    __mailSender: async (m) => { sent.push(m); }
  };
  return { db, env, sent };
}
function post(path, body, env, extra) {
  return new Request('https://worker.example' + path, {
    method: 'POST',
    headers: Object.assign({}, headers, extra || {}),
    body: JSON.stringify(body || {})
  });
}
function auth(path, request, env) {
  return AUTH.handleAuthRequest(request, env, request.headers.get('Origin') || ORIGIN);
}

/* ---------------- 发码 ---------------- */

test('发码：邮件服务未配置时明确失败，不写验证码行', async () => {
  const { db, env } = setup({ mailStub: false });
  const r = await auth('/api/auth/code', post('/api/auth/code', { email: 'a@example.com' }, env), env);
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'email-unconfigured');
  assert.equal(db.rows.email_codes.length, 0);
});

test('发码：成功返回 202，只存摘要；响应/日志不含验证码', async () => {
  const { db, env, sent } = setup({ emailDriver: 'http-unused' });
  /* http-unused 走 http 分支会失败；这里用测试替身优先，证明真实发送路径被调用 */
  const orig = console.log;
  const logs = [];
  console.log = (...a) => logs.push(a.join(' '));
  let r;
  try { r = await auth('/api/auth/code', post('/api/auth/code', { email: ' A@Example.COM ' }, env), env); }
  finally { console.log = orig; }
  assert.equal(r.status, 202);
  assert.equal(r.body.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'a@example.com');
  assert.match(sent[0].code, /^\d{6}$/);
  assert.equal(JSON.stringify(r.body).includes(sent[0].code), false);
  assert.equal(logs.join('\n').includes(sent[0].code), false);
  assert.equal(db.rows.email_codes.length, 1);
  assert.equal(db.rows.email_codes[0].email_norm, 'a@example.com');
  assert.notEqual(db.rows.email_codes[0].code_hash, sent[0].code);
});

test('发码：60 秒冷却期内重复请求返回 429', async () => {
  const { env } = setup();
  const req = () => post('/api/auth/code', { email: 'b@example.com' }, env, { 'CF-Connecting-IP': '1.2.3.4' });
  const first = await auth('/api/auth/code', req(), env);
  assert.equal(first.status, 202);
  const second = await auth('/api/auth/code', req(), env);
  assert.equal(second.status, 429);
  assert.equal(second.body.error, 'rate-limited');
});

test('发码：邮箱 / IP 限流按小时生效', async () => {
  const { db, env } = setup();
  for (let i = 0; i < 5; i++) {
    const r = await auth('/api/auth/code',
      post('/api/auth/code', { email: 'c@example.com' }, env, { 'CF-Connecting-IP': '5.6.7.' + i }), env);
    assert.equal(r.status, 202);
    /* 跳过 60s 冷却，但保留小时计数 */
    const cool = db.rows.rate_limits.find((x) => x.bucket.startsWith('cooldown:'));
    if (cool) cool.window_start -= 120000;
  }
  const r = await auth('/api/auth/code',
    post('/api/auth/code', { email: 'c@example.com' }, env, { 'CF-Connecting-IP': '9.9.9.9' }), env);
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'rate-limited');
});

test('发码：邮件发送失败时验证码作废，返回明确错误类型', async () => {
  const { db, env } = setup();
  env.__mailSender = async () => { throw new Error('smtp down'); };
  const r = await auth('/api/auth/code', post('/api/auth/code', { email: 'd@example.com' }, env), env);
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'email-send-failed');
  assert.equal(db.rows.email_codes.length, 0, '发送失败的验证码必须作废');
});

/* ---------------- 验码 / Session ---------------- */

async function login(env, email) {
  const r1 = await auth('/api/auth/code', post('/api/auth/code', { email }, env), env);
  assert.equal(r1.status, 202);
  const code = (await import('../src/auth/crypto.js')).randomCode;
  /* 从测试邮件替身取验证码：生产接口绝不返回 */
  const mail = env.sent[env.sent.length - 1];
  return { code: mail.code, email };
}

test('验码：错误码 5 次后作废，正确码不能再用', async () => {
  const { db, env, sent } = setup();
  const r1 = await auth('/api/auth/code', post('/api/auth/code', { email: 'e@example.com' }, env), env);
  assert.equal(r1.status, 202);
  const code = sent[sent.length - 1].code;
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) {
    const r = await auth('/api/auth/verify', post('/api/auth/verify', { email: 'e@example.com', code: wrong }, env), env);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'code-invalid');
  }
  const last = await auth('/api/auth/verify', post('/api/auth/verify', { email: 'e@example.com', code: wrong }, env), env);
  assert.equal(last.status, 429);
  assert.equal(last.body.error, 'too-many-attempts');
  const good = await auth('/api/auth/verify', post('/api/auth/verify', { email: 'e@example.com', code }, env), env);
  assert.equal(good.status, 400);
  assert.notEqual(good.body.error, 'no-session');
  assert.equal(db.rows.sessions.length, 0, '超限后不得建立会话');
});

test('验码：过期验证码被拒绝且作废', async () => {
  const { db, env, sent } = setup();
  await auth('/api/auth/code', post('/api/auth/code', { email: 'expired@example.com' }, env), env);
  const code = sent[sent.length - 1].code;
  db.rows.email_codes[0].expires_at = Date.now() - 1;
  const r = await auth('/api/auth/verify',
    post('/api/auth/verify', { email: 'expired@example.com', code }, env), env);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'code-expired');
  assert.ok(db.rows.email_codes[0].consumed_at > 0, '过期码必须作废，不能再试');
  assert.equal(db.rows.sessions.length, 0);
});

test('验码：正确码一次性、Session Cookie 安全属性、userId 不信任前端', async () => {
  const { db, env, sent } = setup();
  const r1 = await auth('/api/auth/code', post('/api/auth/code', { email: 'f@example.com' }, env), env);
  assert.equal(r1.status, 202);
  const code = sent[sent.length - 1].code;
  const r = await auth('/api/auth/verify',
    post('/api/auth/verify', { email: 'f@example.com', code, userId: 'u_attacker' }, env), env);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.notEqual(r.body.user.id, 'u_attacker');
  assert.match(r.body.user.id, /^u_/);
  assert.equal(r.body.user.emailMasked, 'f***@example.com');
  const cookie = r.headers['Set-Cookie'];
  for (const part of ['__Host-eo_sess=', 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax', 'Max-Age=']) {
    assert.ok(cookie.includes(part), 'Cookie 缺少 ' + part);
  }
  assert.equal(/Domain=/.test(cookie), false, '__Host- cookie 不得带 Domain');
  assert.equal(db.rows.sessions.length, 1);
  assert.notEqual(db.rows.sessions[0].token_hash, cookie.match(/__Host-eo_sess=([^;]+)/)[1]);

  const again = await auth('/api/auth/verify', post('/api/auth/verify', { email: 'f@example.com', code }, env), env);
  assert.equal(again.status, 400);
  assert.ok(['code-invalid', 'code-consumed'].includes(again.body.error));
  assert.equal(db.rows.sessions.length, 1, '重复验码不得创建新 Session');
});

test('Session：查询、过期、吊销、退出幂等、Cookie 清理', async () => {
  const { db, env, sent } = setup();
  await auth('/api/auth/code', post('/api/auth/code', { email: 'g@example.com' }, env), env);
  const code = sent[sent.length - 1].code;
  const v = await auth('/api/auth/verify', post('/api/auth/verify', { email: 'g@example.com', code }, env), env);
  const raw = v.headers['Set-Cookie'].match(/__Host-eo_sess=([^;]+)/)[1];
  const sessReq = () => new Request('https://worker.example/api/auth/session', {
    method: 'GET', headers: { Cookie: '__Host-eo_sess=' + raw }
  });
  const st = await auth('/api/auth/session', sessReq(), env);
  assert.equal(st.status, 200);
  assert.equal(st.body.user.email, 'g@example.com');

  const no = await auth('/api/auth/session',
    new Request('https://worker.example/api/auth/session', { method: 'GET', headers: { Cookie: '__Host-eo_sess=bad' } }), env);
  assert.equal(no.status, 401);

  const lo = await auth('/api/auth/logout', post('/api/auth/logout', {}, env, { Cookie: '__Host-eo_sess=' + raw }), env);
  assert.equal(lo.status, 204);
  assert.match(lo.headers['Set-Cookie'], /Max-Age=0/);
  assert.ok(db.rows.sessions[0].revoked_at > 0, '退出必须在服务端撤销');
  assert.equal((await auth('/api/auth/session', sessReq(), env)).status, 401);
  const again = await auth('/api/auth/logout', post('/api/auth/logout', {}, env), env);
  assert.equal(again.status, 204, '无会话退出应幂等');

  db.rows.sessions[0].revoked_at = null;
  db.rows.sessions[0].expires_at = Date.now() - 1;
  assert.equal((await auth('/api/auth/session', sessReq(), env)).status, 401);
});

test('用户隔离：不同邮箱得到不同 user/session，前端身份字段不改变服务端归属', async () => {
  const { env, sent } = setup();
  const ids = [];
  for (const email of ['h1@example.com', 'h2@example.com']) {
    await auth('/api/auth/code', post('/api/auth/code', { email }, env), env);
    const code = sent[sent.length - 1].code;
    const r = await auth('/api/auth/verify',
      post('/api/auth/verify', { email, code, userId: 'u_attacker', spaceKey: 'u_other' }, env), env);
    assert.equal(r.status, 200);
    ids.push(r.body.user.id);
  }
  assert.notEqual(ids[0], ids[1]);
  assert.equal(ids.includes('u_attacker'), false);
});

test('CSRF：缺少自定义头 / Origin 不匹配一律拒绝', async () => {
  const { env } = setup();
  const bad = new Request('https://worker.example/api/auth/code', {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'i@example.com' })
  });
  assert.equal((await auth('/api/auth/code', bad, env)).status, 403);
  const wrongOrigin = new Request('https://worker.example/api/auth/code', {
    method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json', 'X-Earthonline-Auth': '1' },
    body: JSON.stringify({ email: 'i@example.com' })
  });
  assert.equal((await auth('/api/auth/code', wrongOrigin, env)).status, 403);
});

test('邮件适配层：未配置驱动明确失败，测试替身仅限显式开关', async () => {
  const { env } = setup();
  env.ALLOW_TEST_EMAIL = 'false';
  env.EMAIL_DRIVER = 'none';
  await assert.rejects(() => sendLoginCode(env, { to: 'j@example.com', code: '123456' }), /邮件服务未配置/);
});
