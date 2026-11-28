/* auth-preflight.mjs — Phase Auth 部署前只读检查
 *
 * 用途：`npm run auth:preflight`。只读检查仓库配置，不做任何修复、
 * 不连接网络、不读取或打印任何 Secret 值。
 *
 * 输出四态：
 *   PASS      本地可验证，当前配置正确
 *   WARN      不阻塞部署但需要注意的配置
 *   BLOCKED   必须先修复才能部署（附具体修复建议）
 *   DASHBOARD 无法在仓库内验证，必须由项目所有者在 Cloudflare Dashboard 确认
 *
 * 退出码：存在 BLOCKED 时为 1，否则 0。
 *
 * 结构：collectResults(tomlText, migrations) 是纯函数（可被测试导入，
 * 见 scripts/auth-preflight.test.mjs）；本文件作为 CLI 入口时读取
 * 仓库真实文件后调用它并打印。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ================= 纯检查逻辑（可测试） ================= */

/* 极简 TOML 段读取：支持 [name] 与 [[name]]（数组表），取首个匹配段。
 * 实现说明：先从段头贪婪取到文本末尾，再在捕获内截断于下一个行首 [。
 * 不用 lookahead 终止（lookahead 必须成立——最后一段没有后继 [ 段时
 * 整个匹配会失败返回空串）；也不用 \z —— JS 非 unicode 正则里 \z 是
 * 字面字母 z，会在段内第一个 z 字符处截断。 */
function sectionOf(tomlText, name) {
  const re = new RegExp('^\\[{1,2}' + name + '\\]{1,2}([\\s\\S]*)', 'm');
  const m = re.exec(tomlText);
  if (!m) return '';
  const rest = m[1];
  const cut = rest.search(/^[\t ]*\[/m); /* 下一个段（含数组表）的行首 */
  return cut === -1 ? rest : rest.slice(0, cut);
}
function varOf(section, key) {
  const re = new RegExp('^\\s*' + key + '\\s*=\\s*"([^"]*)"', 'm');
  const m = re.exec(section);
  return m ? m[1] : null;
}
/* 行内形式查找（如 routes = [ { pattern = "...", zone_id = "..." } ] 中
 * zone_id 与路由同行）。仅用于 zone_id 这类无歧义键；[vars] 业务键
 * 仍用 varOf 的行首锚定，避免误命中注释行。 */
function inlineVarOf(text, key) {
  const re = new RegExp('[^\\w-]' + key + '\\s*=\\s*"([^"]*)"', 'm');
  const m = re.exec(text);
  return m ? m[1] : null;
}

/**
 * @param {string} tomlText wrangler.toml 全文（不存在时传空串）
 * @param {{dirMissing: boolean, sqlFiles: string[]}|null} migrations
 *        dirMissing: migrations 目录不存在；sqlFiles: 按
 *        文件名排序的 .sql 文件内容数组（目录存在但为空时传 []）
 * @param {{authJsExists: boolean, cloudBackupText: string|null}} frontend
 * @returns {Array<{status:string,name:string,detail:string,fix:string}>}
 */
export function collectResults(tomlText, migrations, frontend) {
  const results = [];
  const add = (status, name, detail, fix) => results.push({ status, name, detail, fix: fix || '' });

  const vars = sectionOf(tomlText, 'vars');
  const d1Section = sectionOf(tomlText, 'd1_databases');

  /* ---- 1. D1 database_id 占位符 ---- */
  {
    const id = varOf(d1Section, 'database_id');
    if (id === null) {
      add('BLOCKED', 'D1 database_id', '[[d1_databases]] 缺少 database_id',
        '在 Dashboard 创建 D1 数据库后，把真实 ID 填入 wrangler.toml');
    } else if (/REPLACE-ME/i.test(id)) {
      add('BLOCKED', 'D1 database_id', 'database_id 仍是占位符 "' + id + '"',
        'Dashboard → Storage & Databases → D1 创建数据库，复制 ID 替换占位符，然后执行 wrangler d1 migrations apply AUTH_DB --remote');
    } else {
      add('PASS', 'D1 database_id', '已填入真实 ID（仓库内无法验证其有效性，部署时以 wrangler 报错为准）');
    }
    const binding = varOf(d1Section, 'binding');
    add(binding === 'AUTH_DB' ? 'PASS' : 'BLOCKED', 'D1 binding 名称',
      binding === 'AUTH_DB' ? 'AUTH_DB（与代码一致）' : '当前为 "' + binding + '"，代码要求 AUTH_DB',
      binding === 'AUTH_DB' ? '' : '保持 binding = "AUTH_DB"');
  }

  /* ---- 2. 同源 Worker Route ---- */
  {
    /* 只认行首无缩进的 routes =（注释模板行以 # 开头，天然不匹配） */
    const routesActive = /^routes\s*=/m.test(tomlText);
    if (routesActive) {
      const zoneId = varOf(tomlText, 'zone_id') ?? inlineVarOf(tomlText, 'zone_id');
      const zoneName = /^\s*zone_name\s*=/m.test(tomlText) || !!inlineVarOf(tomlText, 'zone_name');
      if ((zoneId && !/REPLACE-ME/i.test(zoneId)) || zoneName) {
        add('PASS', '同源 Route 配置',
          zoneName ? 'routes 已配置（zone_name 形式）' : 'routes 已配置且 zone_id 已填入');
      } else {
        add('BLOCKED', '同源 Route 配置', 'routes 存在但 zone_id 缺失或仍是占位符',
          'Dashboard → Workers & Pages → earthonline-backup → Settings → Domains & Routes 添加 Route "slices0flife.me/api/*"，把真实 zone_id 填入 wrangler.toml（或改用 zone_name = "slices0flife.me"）');
      }
    } else {
      add('BLOCKED', '同源 Route 配置',
        'wrangler.toml 中 routes 仍是注释模板（站点 /api/* 当前由静态托管返回 404）',
        '取消注释 routes 行并填入真实 zone_id；也可改用 Dashboard 直接添加 Route（则此行可保持注释，但需要在部署验证矩阵中确认）');
    }
  }

  /* ---- 3. 邮件驱动 ---- */
  {
    const driver = varOf(vars, 'EMAIL_DRIVER') || 'none';
    if (driver === 'http') {
      const url = varOf(vars, 'MAIL_API_URL');
      add('PASS', 'EMAIL_DRIVER', 'http（真实邮件驱动）');
      add(url ? 'PASS' : 'WARN', 'MAIL_API_URL',
        url ? '已配置 HTTPS 端点' : 'http 驱动要求 MAIL_API_URL，当前未在 wrangler.toml [vars] 配置',
        url ? '' : '在 [vars] 增加 MAIL_API_URL = "https://…"（真实发信端点，非敏感变量）');
    } else if (driver === 'console') {
      add('BLOCKED', 'EMAIL_DRIVER', 'console 是本地开发替身，生产发码不可用',
        '改为 EMAIL_DRIVER = "http" 并配置 MAIL_API_URL');
    } else {
      add('BLOCKED', 'EMAIL_DRIVER', '当前为 "' + driver + '"，生产发码会明确失败（email-unconfigured）',
        '接入邮件服务商后改为 EMAIL_DRIVER = "http"，并在 [vars] 配置 MAIL_API_URL');
    }
  }

  /* ---- 4. 危险开关 ---- */
  {
    if (/^\s*ALLOW_LEGACY_ACCESS_BACKUP\s*=/m.test(vars)) {
      add('BLOCKED', 'ALLOW_LEGACY_ACCESS_BACKUP', '生产配置中不应出现该变量',
        '从 wrangler.toml [vars] 删除此行（仅供旧协议测试使用）');
    } else {
      add('PASS', 'ALLOW_LEGACY_ACCESS_BACKUP', '未设置（正确）');
    }
    const cookieMode = varOf(vars, 'AUTH_COOKIE_MODE') || 'same-site';
    const crossAllow = varOf(vars, 'AUTH_ALLOW_CROSS_SITE');
    if (cookieMode === 'cross-site' && crossAllow === 'true') {
      add('WARN', 'AUTH_COOKIE_MODE', 'cross-site + AUTH_ALLOW_CROSS_SITE=true：第三方 Cookie 在 Safari ITP 下会失效',
        '同源路由配置好后改回 "same-site"（__Host- Cookie）');
    } else if (cookieMode === 'same-site') {
      add('PASS', 'AUTH_COOKIE_MODE', 'same-site（__Host-eo_sess; SameSite=Lax）');
    } else {
      add('WARN', 'AUTH_COOKIE_MODE', '当前为 "' + cookieMode + '"', '确认是否符合部署意图');
    }
    if (/^\s*ALLOW_TEST_EMAIL\s*=/m.test(vars)) {
      add('BLOCKED', 'ALLOW_TEST_EMAIL', '生产配置中不应出现该变量（测试邮件替身）',
        '从 wrangler.toml [vars] 删除此行');
    } else {
      add('PASS', 'ALLOW_TEST_EMAIL', '未设置（正确）');
    }
    const requireAccess = varOf(vars, 'BACKUP_REQUIRE_ACCESS_JWT') || 'false';
    if (requireAccess === 'true') {
      add('WARN', 'BACKUP_REQUIRE_ACCESS_JWT', '双校验模式：浏览器还必须持有 Access 会话才能备份',
        '同源部署且 Access 边界调整完成前保持 "false"');
    } else {
      add('PASS', 'BACKUP_REQUIRE_ACCESS_JWT', 'false（仅应用 Session 授权备份）');
    }
    const workersDev = /^\s*workers_dev\s*=\s*true/m.test(tomlText);
    add(workersDev ? 'WARN' : 'PASS', 'workers_dev 入口',
      workersDev ? 'workers.dev 入口开启（同源路由稳定后可关闭，减少暴露面）' : '已关闭',
      workersDev ? '同源验证通过后可把 workers_dev 改为 false' : '');
  }

  /* ---- 5. migration 文件 ---- */
  {
    if (!migrations || migrations.dirMissing) {
      add('BLOCKED', 'migration 目录', 'cloudflare-worker/migrations 不存在',
        '恢复 migrations/0001_auth.sql');
    } else if (!migrations.sqlFiles.length) {
      add('BLOCKED', 'migration 文件', 'migrations 目录没有 .sql 文件',
        '恢复 migrations/0001_auth.sql（users/email_codes/sessions/rate_limits 四表）');
    } else {
      add('PASS', 'migration 文件', migrations.sqlFiles.length + ' 个 .sql（按文件名顺序执行）');
      const text = migrations.sqlFiles[0];
      const need = ['users', 'email_codes', 'sessions', 'rate_limits'];
      const missing = need.filter(t => !text.includes('CREATE TABLE IF NOT EXISTS ' + t));
      add(missing.length ? 'BLOCKED' : 'PASS', 'migration 表完整性',
        missing.length ? '首个 migration 缺少表：' + missing.join(', ') : '四张认证表齐全（IF NOT EXISTS，可重复执行）',
        missing.length ? '核对 migrations/0001_auth.sql 内容' : '');
    }
  }

  /* ---- 6. 前端认证文件与端点形态 ---- */
  {
    add(frontend.authJsExists ? 'PASS' : 'BLOCKED', '前端 auth.js',
      frontend.authJsExists ? '存在' : '缺失（登录客户端不可用）',
      frontend.authJsExists ? '' : '恢复 public/app/auth.js');
    const cbText = frontend.cloudBackupText;
    const sameOriginDefault = !!cbText && cbText.includes('location.origin');
    add(sameOriginDefault ? 'PASS' : 'WARN', '前端同源端点',
      sameOriginDefault ? 'cloud-backup.js 默认 location.origin + /api/*（file:// 才回退 dev Worker）'
        : 'cloud-backup.js 未按同源默认端点实现',
      sameOriginDefault ? '' : '核对 public/app/cloud-backup.js defaultEndpoint()');
  }

  /* ---- 7. Secrets（只提示，不读值） ---- */
  add('DASHBOARD', 'Secrets（3 项）',
    'AUTH_CODE_PEPPER、AUTH_IP_PEPPER、MAIL_API_KEY 必须用 wrangler secret put 设置；仓库内无法验证是否已设置',
    'wrangler secret put AUTH_CODE_PEPPER / AUTH_IP_PEPPER / MAIL_API_KEY；AUTH_IP_PEPPER 未设置时代码回退常量 "v1"，不可带上生产');
  add('DASHBOARD', 'Access 边界',
    '实测站点域名 /api/backup* 被一个 AUD=ee636904… 的 Access 应用拦截（302），与 wrangler.toml AUD_TAG（7aff656c…）不是同一个应用；/app/ 与 /api/auth/* 未被拦截',
    '在 Zero Trust → Access → Applications 确认该应用的覆盖路径与用途；同源部署前决定：保留（浏览器需先有 Access 会话）或收窄（备份授权已改用应用 Session）');
  add('DASHBOARD', 'D1 数据库与 migration 远程执行',
    'database_id 有效性与 wrangler d1 migrations apply AUTH_DB --remote 只能在有凭证的机器执行',
    '部署步骤第 3-4 步，见 docs/space-auth/AUTH3_DEPLOY_RUNBOOK.md');
  add('DASHBOARD', 'MAIL_API_URL 最终可用性',
    '邮件服务商端点的可达性与成功响应语义只能在生产验证',
    '部署后按 Runbook 第 6/9 步实测发码');

  return results;
}

/* ================= CLI 入口 ================= */

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const WRANGLER = join(ROOT, 'cloudflare-worker', 'wrangler.toml');
  const MIGRATIONS = join(ROOT, 'cloudflare-worker', 'migrations');

  let tomlText = '';
  try { tomlText = readFileSync(WRANGLER, 'utf8'); }
  catch { tomlText = ''; }

  let migrations = null;
  if (!existsSync(MIGRATIONS)) {
    migrations = { dirMissing: true, sqlFiles: [] };
  } else {
    const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
    migrations = { dirMissing: false, sqlFiles: files.map(f => readFileSync(join(MIGRATIONS, f), 'utf8')) };
  }
  const authJs = join(ROOT, 'public', 'app', 'auth.js');
  const cloudJs = join(ROOT, 'public', 'app', 'cloud-backup.js');
  const frontend = {
    authJsExists: existsSync(authJs),
    cloudBackupText: existsSync(cloudJs) ? readFileSync(cloudJs, 'utf8') : null,
  };

  const results = collectResults(tomlText, migrations, frontend);
  const ORDER = { BLOCKED: 0, WARN: 1, DASHBOARD: 2, PASS: 3 };
  results.sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  let blocked = 0, warn = 0;
  console.log('=== Phase Auth 部署前检查（auth:preflight，只读）===\n');
  for (const r of results) {
    const tag = { PASS: '[PASS]     ', WARN: '[WARN]     ', BLOCKED: '[BLOCKED]  ', DASHBOARD: '[DASHBOARD]' }[r.status];
    console.log(tag + r.name + ' — ' + r.detail);
    if (r.fix) console.log('           ↳ 修复：' + r.fix);
    if (r.status === 'BLOCKED') blocked++;
    if (r.status === 'WARN') warn++;
  }
  console.log('\n汇总：' + blocked + ' BLOCKED / ' + warn + ' WARN / ' +
    results.filter(r => r.status === 'DASHBOARD').length + ' DASHBOARD / ' +
    results.filter(r => r.status === 'PASS').length + ' PASS');
  if (blocked) { console.log('\n结论：存在 BLOCKED 项，尚不具备部署条件。'); process.exitCode = 1; }
  else console.log('\n结论：仓库级配置无阻塞；DASHBOARD 项需项目所有者在 Cloudflare 完成。');
}
