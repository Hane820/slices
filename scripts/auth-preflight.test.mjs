/* auth-preflight.test.mjs — auth-preflight.mjs 纯函数 collectResults 的单元测试
 *
 * 用合成 wrangler.toml 文本驱动，覆盖：
 *   - TOML 数组表 [[d1_databases]] 识别
 *   - 占位符识别（REPLACE-ME）
 *   - routes 注释模板 / 已配置 / zone_name 形式 / 残留注释干扰回归
 *   - EMAIL_DRIVER 各取值与 MAIL_API_URL 缺失
 *   - 危险开关（ALLOW_LEGACY_ACCESS_BACKUP / ALLOW_TEST_EMAIL / cross-site 双开）
 *   - migration 目录缺失 / 空目录 / 表缺失
 *   - 段内含字母 z 的值不截断（\z 正则陷阱回归）
 *   - 任何输出不包含 Secret 值
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectResults } from './auth-preflight.mjs';

const FRONT_OK = { authJsExists: true, cloudBackupText: 'const ep = location.origin + "/api/";' };
const MIG_OK = { dirMissing: false, sqlFiles: ['CREATE TABLE IF NOT EXISTS users (...);\nCREATE TABLE IF NOT EXISTS email_codes (...);\nCREATE TABLE IF NOT EXISTS sessions (...);\nCREATE TABLE IF NOT EXISTS rate_limits (...);'] };

function toml(overrides = {}) {
  return `
name = "earthonline-backup"
main = "src/index.js"
${overrides.routes || '# routes = [ { pattern = "slices0flife.me/api/*", zone_id = "REPLACE-ME-ZONE-ID" } ]'}
${overrides.extra}

[vars]
EMAIL_DRIVER = "${overrides.driver || 'none'}"
${overrides.vars || ''}
[[d1_databases]]
binding = "AUTH_DB"
database_name = "earthonline-auth"
database_id = "${overrides.d1id || 'REPLACE-ME-D1-DATABASE-ID'}"
`;
}

function statuses(results) {
  const map = {};
  for (const r of results) map[r.name] = r.status;
  return map;
}

test('TOML 数组表 [[d1_databases]] 能被识别，占位符报 BLOCKED', () => {
  const s = statuses(collectResults(toml(), MIG_OK, FRONT_OK));
  assert.equal(s['D1 database_id'], 'BLOCKED');
  assert.equal(s['D1 binding 名称'], 'PASS');
});

test('database_id 填入真实 ID 后转 PASS', () => {
  const s = statuses(collectResults(toml({ d1id: '8f2c-some-real-id' }), MIG_OK, FRONT_OK));
  assert.equal(s['D1 database_id'], 'PASS');
});

test('database_id 缺失时报 BLOCKED', () => {
  const t = toml().replace(/database_id = .*\n/, '');
  const s = statuses(collectResults(t, MIG_OK, FRONT_OK));
  assert.equal(s['D1 database_id'], 'BLOCKED');
});

test('routes 仅注释模板 → BLOCKED（当前仓库状态）', () => {
  const s = statuses(collectResults(toml(), MIG_OK, FRONT_OK));
  assert.equal(s['同源 Route 配置'], 'BLOCKED');
});

test('routes 已配置 + zone_id 填入 → PASS', () => {
  const s = statuses(collectResults(toml({ routes: 'routes = [ { pattern = "slices0flife.me/api/*", zone_id = "abc123" } ]' }), MIG_OK, FRONT_OK));
  assert.equal(s['同源 Route 配置'], 'PASS');
});

test('回归：routes 已配置但残留注释模板行，不再误判 BLOCKED', () => {
  const t = toml({
    routes: 'routes = [ { pattern = "slices0flife.me/api/*", zone_id = "abc123" } ]\n# 旧模板：# routes = [ { pattern = "...", zone_id = "..." } ]',
  });
  const s = statuses(collectResults(t, MIG_OK, FRONT_OK));
  assert.equal(s['同源 Route 配置'], 'PASS');
});

test('routes 用 zone_name 形式 → PASS', () => {
  const s = statuses(collectResults(toml({ routes: 'routes = [ { pattern = "slices0flife.me/api/*", zone_name = "slices0flife.me" } ]' }), MIG_OK, FRONT_OK));
  assert.equal(s['同源 Route 配置'], 'PASS');
});

test('EMAIL_DRIVER=none 与 console 均 BLOCKED；http 缺 MAIL_API_URL 是 WARN', () => {
  const none = statuses(collectResults(toml({ driver: 'none' }), MIG_OK, FRONT_OK));
  assert.equal(none['EMAIL_DRIVER'], 'BLOCKED');
  const cons = statuses(collectResults(toml({ driver: 'console' }), MIG_OK, FRONT_OK));
  assert.equal(cons['EMAIL_DRIVER'], 'BLOCKED');
  const http = statuses(collectResults(toml({ driver: 'http' }), MIG_OK, FRONT_OK));
  assert.equal(http['EMAIL_DRIVER'], 'PASS');
  assert.equal(http['MAIL_API_URL'], 'WARN');
  const httpFull = statuses(collectResults(toml({ driver: 'http', vars: 'MAIL_API_URL = "https://mail.example.com/send"' }), MIG_OK, FRONT_OK));
  assert.equal(httpFull['MAIL_API_URL'], 'PASS');
});

test('危险开关：LEGACY / TEST_EMAIL 出现在 [vars] 即 BLOCKED；cross-site 双开是 WARN', () => {
  const legacy = statuses(collectResults(toml({ vars: 'ALLOW_LEGACY_ACCESS_BACKUP = "true"' }), MIG_OK, FRONT_OK));
  assert.equal(legacy['ALLOW_LEGACY_ACCESS_BACKUP'], 'BLOCKED');
  const testEmail = statuses(collectResults(toml({ vars: 'ALLOW_TEST_EMAIL = "1"' }), MIG_OK, FRONT_OK));
  assert.equal(testEmail['ALLOW_TEST_EMAIL'], 'BLOCKED');
  const cross = statuses(collectResults(toml({ vars: 'AUTH_COOKIE_MODE = "cross-site"\nAUTH_ALLOW_CROSS_SITE = "true"' }), MIG_OK, FRONT_OK));
  assert.equal(cross['AUTH_COOKIE_MODE'], 'WARN');
  const same = statuses(collectResults(toml({ vars: 'AUTH_COOKIE_MODE = "same-site"' }), MIG_OK, FRONT_OK));
  assert.equal(same['AUTH_COOKIE_MODE'], 'PASS');
});

test('回归：段内值含字母 z 不截断段落（\\z 陷阱）', () => {
  const t = toml({ vars: 'NOTES = "example z-value note"\nBACKUP_REQUIRE_ACCESS_JWT = "true"' });
  const s = statuses(collectResults(t, MIG_OK, FRONT_OK));
  assert.equal(s['BACKUP_REQUIRE_ACCESS_JWT'], 'WARN');
});

test('migration 目录缺失 / 空目录 / 表缺失均 BLOCKED', () => {
  const miss = statuses(collectResults(toml(), { dirMissing: true, sqlFiles: [] }, FRONT_OK));
  assert.equal(miss['migration 目录'], 'BLOCKED');
  const empty = statuses(collectResults(toml(), { dirMissing: false, sqlFiles: [] }, FRONT_OK));
  assert.equal(empty['migration 文件'], 'BLOCKED');
  const partial = statuses(collectResults(toml(), { dirMissing: false, sqlFiles: ['CREATE TABLE IF NOT EXISTS users (...);'] }, FRONT_OK));
  assert.equal(partial['migration 表完整性'], 'BLOCKED');
});

test('前端 auth.js 缺失 BLOCKED；cloud-backup 无同源端点 WARN', () => {
  const s = statuses(collectResults(toml(), MIG_OK, { authJsExists: false, cloudBackupText: 'fetch("https://x.dev/api/")' }));
  assert.equal(s['前端 auth.js'], 'BLOCKED');
  assert.equal(s['前端同源端点'], 'WARN');
});

test('任何输出不包含 Secret 值', () => {
  const secret = 'super-secret-pepper-DO-NOT-LEAK-9f2';
  const t = toml({ vars: 'MAIL_API_KEY_NOTE = "secrets are set via wrangler secret put, value: ' + secret + '"' });
  const results = collectResults(t, MIG_OK, FRONT_OK);
  for (const r of results) {
    assert.ok(!r.detail.includes(secret), 'detail 泄露了 Secret 值');
    assert.ok(!r.fix.includes(secret), 'fix 泄露了 Secret 值');
  }
});

test('四态与汇总语义：DASHBOARD 项始终存在且不影响退出语义', () => {
  const results = collectResults(toml(), MIG_OK, FRONT_OK);
  const dash = results.filter(r => r.status === 'DASHBOARD');
  assert.ok(dash.length >= 4, 'DASHBOARD 项应不少于 4 条');
  for (const r of results) {
    assert.ok(['PASS', 'WARN', 'BLOCKED', 'DASHBOARD'].includes(r.status), '未知状态: ' + r.status);
    assert.ok(r.name && r.detail, 'name/detail 必填');
  }
});
