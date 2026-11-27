/* backup-isolation.test.cjs — Phase Auth.2：真实 Worker 备份路由 + 应用 Session
 * 只有 D1（Session 查询）与 R2 是内存替身；Worker 路由、授权、键与 v2 校验都是真代码。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto').webcrypto;

const ORIGIN = 'https://slices0flife.me';
let worker;

test.before(async () => {
  ({ default: worker } = await import('../src/index.js'));
});

/* ---------------- 替身 ---------------- */
class SessionDb {
  constructor(users) {
    this.users = users;             // [{id,email,spaceKey}]
    this.sessions = [];             // [{token_hash,user_id,expires_at,...}]
  }
  addSession(userId, token) {
    this.sessions.push({
      raw: token, token_hash: token, user_id: userId,
      created_at: Date.now(), last_seen_at: Date.now(),
      expires_at: Date.now() + 30 * 86400000,
      absolute_expires_at: Date.now() + 90 * 86400000,
      revoked_at: null
    });
  }
  prepare(sql) {
    const self = this;
    return {
      bind(...args) { this.args = args; return this; },
      async first() {
        if (!/FROM sessions s JOIN users u/.test(sql)) return null;
        let s = null;
        for (const cand of self.sessions) {
          if (cand.token_hash === this.args[0] || await sha256HexText(cand.raw) === this.args[0]) { s = cand; break; }
        }
        if (!s) return null;
        const u = self.users.find((x) => x.id === s.user_id);
        if (!u) return null;
        return {
          session_id: s.token_hash + '-id', expires_at: s.expires_at,
          absolute_expires_at: s.absolute_expires_at, last_seen_at: s.last_seen_at,
          revoked_at: s.revoked_at, user_id: u.id, email_norm: u.email,
          email: u.email, space_key: u.space_key, status: 'active'
        };
      },
      async run() { return { success: true, meta: { changes: 0 } }; }
    };
  }
}

class R2Stub {
  constructor() { this.store = new Map(); this.n = 0; }
  keys() { return Array.from(this.store.keys()); }
  async head(key) {
    const o = this.store.get(key);
    return o ? { size: o.text.length, customMetadata: o.meta, etag: o.etag, httpEtag: '"' + o.etag + '"' } : null;
  }
  async get(key) {
    const o = this.store.get(key);
    if (!o) return null;
    return {
      size: o.text.length, customMetadata: o.meta, etag: o.etag, httpEtag: '"' + o.etag + '"',
      body: o.text,
      text: async () => o.text
    };
  }
  async put(key, text, opts) {
    const onlyIf = opts && opts.onlyIf;
    const existing = this.store.get(key);
    if (onlyIf && typeof onlyIf.get === 'function') {
      if (onlyIf.get('If-None-Match') === '*' && existing) return null;
      const match = onlyIf.get('If-Match');
      if (match && (!existing || existing.etag !== match.replace(/^"|"$/g, ''))) return null;
    }
    const etag = 'stub-etag-' + (++this.n);
    this.store.set(key, { text, meta: (opts && opts.customMetadata) || {}, etag });
    return { uploaded: true, etag, httpEtag: '"' + etag + '"' };
  }
}

function setup() {
  const users = [
    { id: 'u_a', email: 'a@example.com', space_key: 'u_a' },
    { id: 'u_b', email: 'b@example.com', space_key: 'u_b' }
  ];
  const db = new SessionDb(users);
  db.addSession('u_a', 'token-a');
  db.addSession('u_b', 'token-b');
  const r2 = new R2Stub();
  const env = {
    APP_ORIGIN: ORIGIN,
    ACCESS_TEAM: 'test-team.cloudflareaccess.com',
    AUD_TAG: 'test-aud',
    AUTH_DB: db,
    BACKUP_BUCKET: r2,
    MAX_BACKUP_BYTES: 4 * 1024 * 1024
    /* 不设置 ALLOW_LEGACY_ACCESS_BACKUP：Access JWT 单独不得访问用户备份 */
  };
  return { env, db, r2, users };
}

function call(env, path, opts) {
  return worker.fetch(new Request('https://slices0flife.me' + path, opts), env, {});
}
function headers(token, extra) {
  return Object.assign({
    'Cookie': '__Host-eo_sess=' + token,
    'Origin': ORIGIN,
    'Content-Type': 'application/json'
  }, extra || {});
}
function backupBody(marker) {
  return JSON.stringify({
    app: 'earthonline', version: 4, exportedAt: '2026-11-27T00:00:00.000Z',
    data: { v: 4, marker: marker }
  });
}
async function sha256HexText(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Tag(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const b64 = Buffer.from(new Uint8Array(buf)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'sha256-' + b64;
}
async function objectRequest(userId, writeId, marker) {
  function objectKeyOf(w, u) { return 'users/' + u + '/earthonline/backups/' + w + '.json'; }
  async function immutableHash(im) {
    const e = im.identity.expectedConflictState;
    const canonical = JSON.stringify({
      protocolVersion: im.protocolVersion, attemptId: im.attemptId, writeId: im.writeId,
      clientId: im.clientId, clientRevision: im.clientRevision, baseRev: im.baseRev,
      objectKey: im.objectKey, payloadHash: im.payloadHash, payloadBytes: im.payloadBytes,
      createdAt: im.createdAt,
      identity: {
        conflictEpoch: im.identity.conflictEpoch, blockEpoch: im.identity.blockEpoch,
        expectedConflictState: { mode: e.mode, id: e.mode === 'present' ? e.id : null }
      }
    });
    return sha256Tag(canonical);
  }
  const payload = JSON.parse(backupBody(marker));
  const payloadText = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(payloadText);
  const im = {
    protocolVersion: 2, attemptId: writeId, writeId: writeId,
    clientId: 'v2-client', clientRevision: 1, baseRev: 0,
    objectKey: objectKeyOf(writeId, userId),
    payloadHash: 'sha256-pending', payloadBytes: bytes.length,
    createdAt: 1764000000000,
    identity: { conflictEpoch: 0, blockEpoch: 0, expectedConflictState: { mode: 'none', id: null } },
    immutableHash: 'sha256-pending'
  };
  im.payloadHash = await sha256Tag(payloadText);
  im.immutableHash = await immutableHash(im);
  return { protocolVersion: 2, immutable: im, payload: payload, payloadText: payloadText };
}
function pointerFrom(im, revision) {
  return {
    protocolVersion: 2, revision, writeId: im.writeId, objectKey: im.objectKey,
    payloadHash: im.payloadHash, payloadBytes: im.payloadBytes, immutableHash: im.immutableHash,
    clientId: im.clientId, clientRevision: im.clientRevision, baseRev: im.baseRev, createdAt: im.createdAt
  };
}
async function json(res) { return { status: res.status, body: JSON.parse(await res.text()) }; }

/* ---------------- 授权 ---------------- */

test('未认证 / 无效 Cookie / 仅 Access JWT 都不能访问备份', async () => {
  const { env } = setup();
  const no = await call(env, '/api/backup/status', { method: 'GET', headers: { Origin: ORIGIN } });
  assert.equal(no.status, 401);
  const noBody = (await json(no)).body;
  assert.equal(noBody.reason, 'no-valid-session');
  assert.equal(noBody.code, 'session-invalid', '无 Session 是明确的会话失效码');
  const bad = await call(env, '/api/backup/status', { method: 'GET', headers: headers('not-a-session') });
  assert.equal(bad.status, 401);
  assert.equal((await json(bad)).body.code, 'session-invalid', '无效 Cookie = 会话失效');
  const accessOnly = await call(env, '/api/backup/status', {
    method: 'GET', headers: { Origin: ORIGIN, 'Cf-Access-Jwt-Assertion': 'eyJhbGciOiJub25lIn0.e30.' }
  });
  assert.equal(accessOnly.status, 401, 'Access JWT 不能单独获得用户备份权限');
});

test('会话过期 / 撤销后备份被拒绝，且返回明确的 session-invalid 码', async () => {
  const { env, db } = setup();
  db.sessions[0].expires_at = Date.now() - 1;
  const expired = await json(await call(env, '/api/backup/status', { method: 'GET', headers: headers('token-a') }));
  assert.equal(expired.status, 401);
  assert.equal(expired.body.code, 'session-invalid', '过期 = 会话失效');
  db.sessions[0].expires_at = Date.now() + 100000;
  db.sessions[0].revoked_at = Date.now();
  const revoked = await json(await call(env, '/api/backup/status', { method: 'GET', headers: headers('token-a') }));
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.code, 'session-invalid', '撤销 = 会话失效');
});

test('Session 缺失：/api/auth/session 401 返回 no-session 明确码', async () => {
  const { env } = setup();
  const r = await json(await call(env, '/api/auth/session', { method: 'GET', headers: { Origin: ORIGIN } }));
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'no-session');
});

test('403 授权拒绝（非法 Origin）带 access-denied 语义，不冒充会话失效', async () => {
  const { env } = setup();
  const r = await call(env, '/api/backup/status', {
    method: 'GET', headers: { Origin: 'https://evil.example', Cookie: '__Host-eo_sess=token-a' }
  });
  assert.equal(r.status, 403);
  const body = (await json(r)).body;
  assert.equal(body.error, 'origin-forbidden');
  assert.notEqual(body.code, 'session-invalid', 'Origin 拒绝不得被当作会话失效');
});

test('双校验模式：Session 有效但 Access 失败 → 401 access-denied，不是会话失效', async () => {
  const { env } = setup();
  env.BACKUP_REQUIRE_ACCESS_JWT = 'true';
  const r = await json(await call(env, '/api/backup/status', {
    method: 'GET', headers: headers('token-a') /* 无 Access JWT */
  }));
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'access-denied', 'Access 拦截不得被误判为应用会话失效');
  assert.equal(r.body.reason, 'access-token-required');
});

test('身份服务故障（D1 查询抛错）→ 502 auth-unavailable，不是会话失效', async () => {
  const { env, db } = setup();
  const origPrepare = db.prepare.bind(db);
  db.prepare = () => ({ bind() { return this; }, async first() { throw new Error('d1 down'); }, async run() { throw new Error('d1 down'); } });
  const r = await json(await call(env, '/api/backup/status', { method: 'GET', headers: headers('token-a') }));
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'auth-unavailable');
  assert.notEqual(r.body.code, 'session-invalid', '服务故障不得当作会话失效');
  db.prepare = origPrepare;
});

/* ---------------- v1 用户命名空间与隔离 ---------------- */

test('v1：A/B 各自独立对象；状态与读取只看自己的命名空间', async () => {
  const { env, r2 } = setup();
  const putA = await call(env, '/api/backup', { method: 'PUT', headers: headers('token-a'), body: backupBody('A-data') });
  assert.equal(putA.status, 200);
  const storedA = (await json(putA)).body.stored.key;
  assert.equal(storedA, 'users/u_a/earthonline/backup-latest.json');

  const putB = await call(env, '/api/backup', { method: 'PUT', headers: headers('token-b'), body: backupBody('B-data') });
  assert.equal(putB.status, 200);
  assert.equal((await json(putB)).body.stored.key, 'users/u_b/earthonline/backup-latest.json');

  const stA = await json(await call(env, '/api/backup/status', { method: 'GET', headers: headers('token-a') }));
  const stB = await json(await call(env, '/api/backup/status', { method: 'GET', headers: headers('token-b') }));
  assert.equal(stA.body.hasBackup, true);
  assert.equal(stA.body.key, 'users/u_a/earthonline/backup-latest.json');
  assert.equal(stB.body.key, 'users/u_b/earthonline/backup-latest.json');
  assert.notEqual(stA.body.exportedAt, undefined);

  const getB = await call(env, '/api/backup', { method: 'GET', headers: headers('token-b') });
  assert.equal(getB.status, 200);
  assert.match(await getB.text(), /B-data/);
  assert.equal((await r2.get('users/u_a/earthonline/backup-latest.json')).text ? true : false, true);
});

test('v1：伪造 userId / URL 参数不能改写命名空间', async () => {
  const { env, r2 } = setup();
  const put = await call(env, '/api/backup?userId=u_b', {
    method: 'PUT',
    headers: headers('token-a', { 'X-User-Id': 'u_b' }),
    body: JSON.stringify({ ...JSON.parse(backupBody('forged')), userId: 'u_b' })
  });
  assert.equal(put.status, 200);
  assert.equal((await json(put)).body.stored.key, 'users/u_a/earthonline/backup-latest.json');
  assert.equal(r2.keys().some((k) => k.indexOf('users/u_b/') === 0), false, '伪造字段不得写入他人命名空间');
});

/* ---------------- v2 用户命名空间与 CAS ---------------- */

test('v2：对象与 pointer 均落在用户命名空间，A/B 完全隔离', async () => {
  const { env, r2 } = setup();
  const a = await objectRequest('u_a', 'write-a', 'A-v2');
  const b = await objectRequest('u_b', 'write-b', 'B-v2');
  const v2h = { 'X-Earthonline-Protocol': '2' };

  const putA = await json(await call(env, '/api/backup/v2/object', {
    method: 'PUT', headers: headers('token-a', v2h), body: JSON.stringify(a)
  }));
  assert.equal(putA.status, 200, JSON.stringify(putA.body));
  assert.equal(putA.body.stored.objectKey, 'users/u_a/earthonline/backups/write-a.json');
  const putB = await json(await call(env, '/api/backup/v2/object', {
    method: 'PUT', headers: headers('token-b', v2h), body: JSON.stringify(b)
  }));
  assert.equal(putB.status, 200);
  assert.equal(putB.body.stored.objectKey, 'users/u_b/earthonline/backups/write-b.json');

  /* A 的 pointer 指向 A 的对象；B 不能用 A 的 objectKey 提交自己的 pointer */
  const ptrA = await json(await call(env, '/api/backup/v2/pointer', {
    method: 'PUT', headers: headers('token-a', v2h),
    body: JSON.stringify({ protocolVersion: 2, pointer: pointerFrom(a.immutable, 1), expected: { revision: 0, etag: null } })
  }));
  assert.equal(ptrA.status, 200, JSON.stringify(ptrA.body));
  const cross = await json(await call(env, '/api/backup/v2/pointer', {
    method: 'PUT', headers: headers('token-b', v2h),
    body: JSON.stringify({ protocolVersion: 2, pointer: pointerFrom(a.immutable, 1), expected: { revision: 0, etag: null } })
  }));
  assert.equal(cross.status, 400, '跨用户 objectKey 必须被命名空间校验拒绝');
  assert.ok(r2.keys().indexOf('users/u_b/earthonline/backups/v2/pointer.json') < 0);

  const stA = await json(await call(env, '/api/backup/v2/status', { method: 'GET', headers: headers('token-a', v2h) }));
  const stB = await json(await call(env, '/api/backup/v2/status', { method: 'GET', headers: headers('token-b', v2h) }));
  assert.equal(stA.body.hasPointer, true);
  assert.equal(stA.body.pointer.objectKey, 'users/u_a/earthonline/backups/write-a.json');
  assert.equal(stB.body.hasPointer, false, 'B 不得看到 A 的 pointer');
});

test('v2：同用户 CAS 冲突与重复 writeId 幂等，跨用户对象不可读', async () => {
  const { env, r2 } = setup();
  const a = await objectRequest('u_a', 'write-cas', 'A-cas');
  const v2h = { 'X-Earthonline-Protocol': '2' };
  await call(env, '/api/backup/v2/object', { method: 'PUT', headers: headers('token-a', v2h), body: JSON.stringify(a) });
  const repeat = await json(await call(env, '/api/backup/v2/object', {
    method: 'PUT', headers: headers('token-a', v2h), body: JSON.stringify(a)
  }));
  assert.equal(repeat.body.idempotent, true);
  const conflict = await objectRequest('u_a', 'write-cas', 'A-different');
  const cf = await json(await call(env, '/api/backup/v2/object', {
    method: 'PUT', headers: headers('token-a', v2h), body: JSON.stringify(conflict)
  }));
  assert.equal(cf.status, 409);
  assert.equal(cf.body.error, 'object-conflict');

  const stale = await json(await call(env, '/api/backup/v2/pointer', {
    method: 'PUT', headers: headers('token-a', v2h),
    body: JSON.stringify({ protocolVersion: 2, pointer: pointerFrom(a.immutable, 1), expected: { revision: 3, etag: '"wrong"' } })
  }));
  assert.equal(stale.status, 409, 'CAS 冲突必须拒绝');

  /* B 既无法用 A 的 writeId 在自己的命名空间写入不同内容 */
  const bCross = await objectRequest('u_b', 'write-cas', 'B-cross');
  const bc = await json(await call(env, '/api/backup/v2/object', {
    method: 'PUT', headers: headers('token-b', v2h), body: JSON.stringify(bCross)
  }));
  assert.equal(bc.status, 200, '同 writeId 在 B 的命名空间是独立对象');
  assert.equal(bc.body.stored.objectKey, 'users/u_b/earthonline/backups/write-cas.json');
  assert.notEqual(
    (await r2.get('users/u_a/earthonline/backups/write-cas.json')).etag,
    (await r2.get('users/u_b/earthonline/backups/write-cas.json')).etag);
});
