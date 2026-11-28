# Phase Auth.3 部署准备核查报告（扩展任务版，2026-11-28）

> 只读核查 + 测试 + 文档/脚本准备。基线 HEAD `61187d2`（= origin/main）。
> 本轮新增：`scripts/auth-preflight.mjs`、根 `package.json` 一行 script、本文档与
> `AUTH3_DEPLOY_RUNBOOK.md`。未做任何生产变更、未执行任何 Git 写操作（本轮新增
> 文件保持未暂存状态，由项目所有者决定是否纳入）。

## 1. Git 基线

- 分支 `main`，HEAD `61187d2` = `origin/main`（0 ahead / 0 behind）。
- **所有既有变更全部位于暂存区**（工作区与暂存区一致，无未暂存修改、无未跟踪文件，本轮新增文件除外）。
- 暂存区 6 项逐项结论：

| 文件 | 状态 | 内容/来源 | 影响 | 建议 |
|---|---|---|---|---|
| `cloudflare-worker/package.json` | M（+2） | 新增 `test:r2:s3` 两个脚本入口 | 无风险 | 可保留 |
| `cloudflare-worker/test/r2-s3-integration.cjs` | A（704 行） | R2 S3 SigV4 独立集成测试；凭证只读环境变量、日志脱敏、`--self-check` 离线、桶白名单硬门禁 | 无凭证引用，安全 | 可保留 |
| `cloudflare-worker/test/r2-s3-integration.md` | A（131 行） | 上述测试说明；明确 Worker 端到端验证仍 BLOCKED（workers.dev 网络阻断） | 无风险 | 可保留 |
| `orange-soda-preview.html` | D（-1015 行） | 旧主题实验页（f4473a8 引入），全仓库无引用 | 无引用，与上次 theme-lab.html 清理同类 | 若确认无用可提交删除 |
| `package-lock.json` | D（-4847 行） | **整个 lockfile 被暂存删除** | **`.github/workflows/ci.yml:26` 用 `npm ci`，PR CI 将直接失败**；依赖不可复现 | **取消暂存恢复（勿提交）** |
| `src/content/writing/博客测试.md` | A | 内容仅 `title: 未命名 / 测试`；已实测可构建（会作为博文发布到 /writing/） | 发布后公开可见测试博文 | 建议取消暂存，勿发布 |

- 特别说明：取消暂存（`git restore --staged`）只移动索引指针；`package-lock.json`
  与 `orange-soda-preview.html` 在 HEAD 中有内容，取消暂存即恢复；无风险。

## 2. Cloudflare 架构（实测）

- 仓库内只有**一个** Worker：`earthonline-backup`（`wrangler.toml` + 本地验收专用
  `wrangler.dev.toml`）。静态站点是 Astro `output:'static'`，仓库内无 Pages/CNAME
  配置，托管方式在 Dashboard（仓库证据不可见）。
- 线上探测（2026-11-28）：

| URL | 结果 | 含义 |
|---|---|---|
| `/` | 200 HTML（cf-cache-status HIT） | 博客正常 |
| `/app/` | 200 HTML | **匿名可访问，Access 未拦应用**（此前收窄已生效） |
| `/api/auth/session` | 404（空 body） | **同源 Route 未配置**，静态托管 404 |
| `/api/backup/status` | **302 → Access 登录页**（`still-silence-4b58.cloudflareaccess.com`，`CF_AppSession` + `www-authenticate` 头） | 站点域存在 Access 应用保护 `/api/backup*`，AUD=`ee636904…`，**与 wrangler.toml `AUD_TAG=7aff656c…` 不是同一个应用** |

- workers.dev 旧端点：本地 DNS 污染（域名解析到假 IP）无法探测，属网络环境限制，
  不据此判断 Worker 配置状态。
- 路由冲突结论：`/api/*` Route 一旦配置，`/api/auth/*`（无 Access 覆盖）直达
  Worker；`/api/backup*` 会被站点域 Access 应用先拦。处理决策见 Runbook §2-B
  （推荐收窄站点域该 Access 应用，备份授权已改用应用 Session）。

## 3. D1 审查

- `migrations/0001_auth.sql`：四表全部 `IF NOT EXISTS`，**可安全重复执行**；
  索引 `idx_codes_email(email_norm,purpose,created_at DESC)`、
  `idx_sessions_user(user_id,revoked_at)`。
- 本地内存 SQLite 空库验证（node:sqlite + D1 API 垫片，临时脚本已删除）：
  - migration 执行两次成功；
  - `routes.js` 全部 **14 条 SQL**（含 UPSERT、JOIN、条件 UPDATE）在真实表结构上执行通过；
  - `users.email_norm` UNIQUE 生效（`INSERT OR IGNORE` 重复插入被忽略）；
  - 代码查询字段与表结构**零偏差**（无代码依赖但 migration 未创建的字段）。
- 数据清理策略：代码不做定时清理；`email_codes` 靠 `consumed_at`/`expires_at`
  逻辑作废，物理清理可后续用 D1 定时任务（非阻塞项）。
- 生产初始化：`npx wrangler d1 migrations apply AUTH_DB --remote`（Runbook §4）。
- 回滚：migration 不可自动回滚；回退前 `wrangler d1 export` 备份（Runbook）。

## 4. 邮件链路审查

链路：`settings.js` 两步 Sheet → `auth.js` POST `/api/auth/code`（Origin + `X-Earthonline-Auth:1`）→ `routes.js requestCode`（三层限流：60s 冷却→邮箱 5/h→IP 20/h）→ `email.js sendLoginCode` → HTTP 邮件服务商。

- `EMAIL_DRIVER` 取值：`none`（未配置→503 `email-unconfigured`）/ `console`
  （本地替身，不落验证码）/ `http`（真实驱动）。
- 请求契约：HTTPS POST + `Bearer MAIL_API_KEY` + JSON `{to, from, subject, text}`；
  **HTTP 2xx 即成功**；无应用层超时/重试（依赖 Workers 平台超时）——服务商必须
  同步 2xx 前完成入队，这是选型要求。
- **发送失败不会留下有效验证码**：`routes.js:107-114` 发送抛错即 `DELETE FROM
  email_codes` 该行，返回 503，不泄露账号存在性。
- 限流计数在发送前递增（失败也计数），行为一致、无绕过。
- 日志：`console` 驱动只记 `queued to=<邮箱>`（不含验证码）；http 驱动无日志；
  Secret 不出现在任何日志路径。验证码明文只在 `sendLoginCode` 内存中，不落库不落日志。
- 缺失项：无服务商账号/Key/发信域名验证（SPF/DKIM）——均为用户侧配置，非代码缺口。
  若服务商 API 非「Bearer + 四字段」格式，需改 `email.js` 适配层（契约已写进 Runbook §6）。

## 5. Auth 部署边界（环境变量与 Secrets 清单）

| 名称 | 类型 | 必填 | 当前配置 | 缺失时行为 |
|---|---|---|---|---|
| `APP_ORIGIN` | var | 是 | `https://slices0flife.me` ✅ | CORS/CSRF 全拒 |
| `AUTH_COOKIE_MODE` | var | 是 | `same-site` ✅（`__Host-eo_sess; Lax`） | 默认 same-site |
| `AUTH_ALLOW_CROSS_SITE` | var | 否 | 未设置 ✅ | 跨站不可用（安全） |
| `BACKUP_REQUIRE_ACCESS_JWT` | var | 否 | `false` ✅ | 默认仅 Session 授权 |
| `ALLOW_LEGACY_ACCESS_BACKUP` | var | **生产禁止** | 未设置 ✅ | —（设置即旧协议裸奔） |
| `ALLOW_TEST_EMAIL` | var | **生产禁止** | 未设置 ✅ | —（设置即测试替身可用） |
| `EMAIL_DRIVER` | var | 是 | `none` ❌ | 发码 503 `email-unconfigured` |
| `MAIL_API_URL` | var | http 驱动时 | 未设置 ❌ | 503 `email-unconfigured` |
| `MAIL_FROM` | var | 否 | `noreply@slices0flife.me` ✅ | 用默认值 |
| `AUTH_CODE_PEPPER` | **secret** | 是 | 无法仓库验证 ⬜ | 摘要退化为纯 SHA256（可被 10^6 字典化） |
| `AUTH_IP_PEPPER` | **secret** | 是 | 无法仓库验证 ⬜ | **回退常量 `"v1"`**，IP/邮箱哈希可被字典化 |
| `MAIL_API_KEY` | **secret** | http 驱动时 | 无法仓库验证 ⬜ | 503 `email-unconfigured` |
| `AUTH_DB`（D1 binding） | binding | 是 | 占位符 ❌ | 503 `auth-unavailable`（fail closed） |
| `BACKUP_BUCKET`（R2） | binding | 是 | `earthonline-backups` ✅ 声明 | `bucket-not-bound` → 502（fail closed） |

其余边界（本轮确认，无回归）：Access 拦截可发生在 Worker 之前（站点域实测成立），
前端对 HTML/重定向响应分类为 `unknown`，保留 user + pending，不误降级；
`session-invalid` 仅限机器码，与普通 403 区分正确；v1/v2 备份键均带
`users/<userId>/` 前缀，`backupCtx.userId` 只来自 `requireSession()`；
无登录不可触发的写入入口（备份 PUT 必须过 `authorizeBackup`）。

## 6. 部署前检查工具

`npm run auth:preflight`（`scripts/auth-preflight.mjs`，零依赖只读）：
本轮实测输出 **3 BLOCKED（D1 占位符 / Route 注释模板 / EMAIL_DRIVER=none）·
1 WARN（workers_dev 开启）· 4 DASHBOARD（Secrets、Access 边界、D1 远程
migration、邮件端点）· 9 PASS**，exit 1。与线上实测状态一致。

## 7. 自动备份衔接（Auth → 备份）

`cloud-backup.js`（360 行）真实状态：
1. user 登录后**会**自动上传：`boot.js finishBoot → syncIdentity() → startUser()`。
2. 调度器已连接**真实 v1 API**：`PUT {location.origin}/api/backup`（含
   `credentials:'include'`）；3 秒防抖合并、8 秒重试一次、60 秒心跳兜底、
   online 事件补排、30 秒 localStorage 多标签租约单飞。
3. pending 恢复：`pending/seq` 持久化 localStorage，刷新/重开页面由
   `startUser()` 1.5 秒后补传。
4. guest 完全不触发上传：`guestBlocked()` fail-closed 门禁覆盖
   markDirty/backupNow/run/refreshStatus/快照五层。
5. 身份切换：`syncIdentity()` 先 `stopTimers()`；in-flight 结果由
   `identityKey()` 前后校验丢弃，不污染新身份状态机。
6. 触发源：`core.js:542/581`（save 成功出口 markDirty）+ `settings.js:464` 手动。
7. **距离可用还缺**：① 同源 Route（否则 404）；② 站点域 Access 应用决策
   （否则浏览器 fetch 被 302 到 Access HTML，上传持续失败——前端会保留
   pending 不丢数据，但功能不可用）；③ 登录闭环（D1+邮件）。
8. 未接 v2 pointer 协议（调度器仍走 v1 latest 单对象），历史版本/并发对账
   属后续阶段 → **建议 Auth.4**（内容：登录态联调收尾 + Access 边界落地 +
   备份端到端验收；v2 调度器接入可作为 Auth.5 单独评估）。

## 8. 测试结果（真实命令）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm test`（含 ui-text-check + auth-flow/auth-lifecycle 等） | 0 | **177/177 pass** |
| `cloudflare-worker: npm test`（harness.cjs） | 0 | **139/139 PASS** |
| `git diff --check` / `git diff --cached --check` | 0 | 无空白错误 |
| `node --check` × 7（auth.js/cloud-backup.js/index.js/routes.js/crypto.js/email.js/auth-preflight.mjs） | 0 | 全部语法 OK |
| migration 本地空库验证（node:sqlite） | 0 | 可重复执行、14 条 SQL、UNIQUE 全 PASS |
| `npm run build`（validate:content + astro check + astro build） | 0 | 69 页构建成功（含暂存测试博文） |
| `npm run auth:preflight` | 1 | 3 BLOCKED（预期，配置未就绪） |

本轮未引入任何测试失败；无已存在回归。

## 9. 待用户决策事项（仅必须由用户决定）

1. **package-lock.json 删除**：取消暂存恢复（强烈建议，CI 会失败）——或明确接受。
2. **orange-soda-preview.html / 博客测试.md**：确认删除/不发布意图。
3. **站点域 Access 应用（AUD `ee636904…`）**：收窄（推荐）/保留/删除——影响
   `/api/backup*` 是否需浏览器先持有 Access 会话（Runbook §2-B）。
4. **邮件服务商选型**：满足「Bearer + {to,from,subject,text} + 同步 2xx」契约者可直接用；否则需改 `email.js`。
5. **本轮新增三个文件是否纳入提交**：`scripts/auth-preflight.mjs`、`package.json` 一行、`docs/space-auth/AUTH3_DEPLOY_RUNBOOK.md` + 本文档。

## 10. 下一阶段建议（Phase Auth.3.2 顺序）

1. 处理暂存区（决策 1/2）→ 提交本轮新增文档与脚本（决策 5）。
2. 用户进 Dashboard：创建 D1 → 填 `database_id`；决定 Access 应用（决策 3）→
   配 Route `slices0flife.me/api/*` + zone_id。
3. 用户本机（wrangler 登录态）：`d1 migrations apply --remote` → 三个 `secret put`
   → 邮件服务商域名验证 → `EMAIL_DRIVER=http` + `MAIL_API_URL`。
4. `npm run auth:preflight` 全绿 → `wrangler deploy` → Runbook §8/9/10/11 逐项验证。
5. 验证矩阵全绿后关闭 `workers_dev` 入口（消除 WARN）。
6. Auth.4（备份端到端 + Access 边界落地）另行立项。

**Dashboard 必须用户本人完成的操作**：D1 创建、Worker Route 添加、Access 应用
查看/收窄、Secrets 查看；`wrangler secret put` / `d1 migrations apply --remote` /
`wrangler deploy` 需要本机 wrangler 登录态（同样须用户授权执行）。

---

## 附录（Auth.3.2 更新，2026-11-28）：检查脚本修复与测试化

`scripts/auth-preflight.mjs` 重构为「纯函数 `collectResults(tomlText, migrations, frontend)` + CLI 包装」，并修复三个真实缺陷：

1. **段边界正则缺陷（严重，本次实测暴露）**：原 `(?=^\[|\z)` 中 JS 正则的 `\z` 是字面字母 `z` 而非文本结尾，段内容会在第一个 `z` 处截断；且 lookahead 必须成立——**目标段是文件最后一段时整个匹配失败返回空串**。真实文件因 d1 段后有注释行而未暴露。已改为「贪婪取尾 + 按下一个行首 `[` 截断」。
2. **routes 误判**：原逻辑在取消注释真实 `routes` 但残留注释模板行时误报 BLOCKED；且不支持行内 `zone_id` 与 `zone_name` 形式。已修复。
3. **不可测试**：新增 `scripts/auth-preflight.test.mjs`（node:test，14 条），覆盖数组表识别、占位符、routes 四种形态、EMAIL_DRIVER 取值、危险开关、migration 三态、`\z` 陷阱回归、Secret 值不泄露断言；已接入 `npm test`。

修复后 CLI 对当前仓库输出与修复前一致：**3 BLOCKED / 1 WARN / 4 DASHBOARD / 9 PASS**，退出码语义不变。
