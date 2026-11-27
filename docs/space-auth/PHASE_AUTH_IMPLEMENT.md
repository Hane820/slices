# Phase Auth 实际实施记录（2026-11-27）

> 本文件记录**本次实际写入仓库的代码与边界**，不是最终验收报告。
> 基线：HEAD `8eee3e9`；实施前 `npm test` 129/129；工作区已有未提交修改全部保留。
> 代码基线以实际仓库为准；产品两态（guest/user）与现有 Access/R2 边界未变。

## 1. 现状核对（实施前）

| 项 | 实施前实际情况 |
|---|---|
| D1 / 迁移 | Worker 无 D1 binding、无迁移目录、无用户/验证码/Session 表 |
| 邮件服务 | 仓库无邮件 SDK、无发信接口、无已配置服务；只有设计文档中的适配层设想 |
| 登录 UI | 无。设置页 guest 只显示「尚未开放」；`OLIdentity` 只有 guest/local 记录，无 user 登录入口 |
| Worker 路由 | 单文件 `src/index.js`，仅 `/api/backup*` 五个路径，全部经 `verifyAccessJwt()` |
| Access JWT | 保护 `/api/backup`、`/api/backup/status`、`/api/backup/v2/{object,pointer,status}`；非这些路径 404 |
| `OLIdentity` | sessionStorage `earthonline-space`；无记录 = guest；`local` = 历史正式库（将来的 user） |
| `OLCloudBackup` | 上轮已改为读 `OLIdentity.record()`，仅 `local + earthonline` 允许，`syncIdentity()` 负责身份切换启停 |

## 2. 本次实际新增/修改

### 服务端
- `cloudflare-worker/migrations/0001_auth.sql`：D1 四表 `users` / `email_codes` / `sessions` / `rate_limits`，按设计 §4.2 字段，只新增表。
- `cloudflare-worker/src/auth/crypto.js`：随机 token（32B base64url）、6 位拒绝采样验证码、邮箱归一化/脱敏、SHA-256 + pepper 摘要、Cookie 组装/解析。
- `cloudflare-worker/src/auth/email.js`：可替换适配层。`none` = 生产未配置**明确失败**；`console` = 本地替身（不记录验证码）；`http` = 可配置 HTTPS 端点 + API Key；测试替身需显式 `ALLOW_TEST_EMAIL=true`，生产代码里没有万能码。
- `cloudflare-worker/src/auth/routes.js`：`/api/auth/code|verify|session|logout|logout-all`；验证码 10 分钟有效、5 次错误作废、60s 冷却、邮箱 5/h、IP 20/h；Session 30 天滑动 / 90 天绝对、只存 token 摘要、可撤销；`requireSession()` 是可复用中间层，业务路由必须从它取 userId。
- `cloudflare-worker/src/index.js`：动态 import 认证模块并挂载路由；**现有 `/api/backup*` 与 Access JWT 校验一行未删**；CORS 预检新增 `X-Earthonline-Auth` 头。
- `cloudflare-worker/wrangler.toml`：新增 `AUTH_DB` D1 binding（`database_id` 为 REPLACE-ME）、`AUTH_COOKIE_MODE`、`EMAIL_DRIVER`、`MAIL_FROM` 及 Secrets 清单注释。
- `cloudflare-worker/test/auth.test.cjs`：11 条真实模块测试（D1/邮件为替身）；`test/harness.cjs` 更新一条 CORS 断言以纳入新头。

### 前端
- `public/app/auth.js`：真实认证客户端；所有请求 `credentials:'include'` + `X-Earthonline-Auth:1`；不保存 token/验证码；logout 10s 超时区分 `offline`。
- `public/app/identity.js`：新增 `enterUser()`（服务端验证成功后调用）、`demoteToGuest()`（恢复登录前游客记录，包括认领旧库的库名）、`isUser()`；本地身份记录**不是**服务端凭证。
- `public/app/boot.js`：本地记录为 `local` 时先 `OLAuth.session()`；明确失效（no-session/expired/revoked）才 demote 到 guest；网络/5xx 阻断启动，不伪装成功。
- `public/app/settings.js`：guest 登录入口 → 真实两步 Sheet；发码只进入第二步；验码后**再次读取服务端 session** 成功才 `enterUser()`；user 显示脱敏邮箱、退出入口；退出失败保持 user，成功后 demote + 停调度。
- `public/app/index.html`：在 `boot.js` 之前加载 `auth.js`。
- `scripts/auth-flow.test.mjs`：10 条前端真实源码测试；`scripts/cloud-backup-space.test.mjs` 的两条渲染断言随登录入口实际化更新。

## 3. 明确未做（本阶段边界）
- 游客数据迁移、user 自动备份真实 R2 闭环、新设备云端恢复、多设备同步。
- 独立演示空间、第二批 UI 文案迁移、Cloudflare Dashboard / Access / R2 变更、部署。
- 登录成功后**不**上传或合并游客数据。

## 4. 关键安全决定
- **Access JWT ≠ 应用 Session ≠ 本地 OLIdentity**。备份 API 仍只认 Access JWT；应用认证 API 只认自己的 Session；两者互不替代。
- Session token 32B 随机，服务端只存 SHA-256；Cookie HttpOnly+Secure；失败限流后不做快速重试；验证码只存摘要且不输出日志。
- CSRF：POST 必须 `Origin === APP_ORIGIN` + `X-Earthonline-Auth:1`；CORS 只放行 APP_ORIGIN。
- 发码响应不区分邮箱是否注册；发信失败返回明确 `email-unavailable/email-send-failed`，但不泄露账号存在性。

## 5. 部署前必须由用户完成的外部配置（当前未做）
1. 创建 D1 数据库，把 `wrangler.toml` 的 `database_id` 换成真实值，执行 `wrangler d1 migrations apply AUTH_DB --remote`。
2. 设置 Secrets：`AUTH_CODE_PEPPER`（≥32B 随机）、`AUTH_IP_PEPPER`、`MAIL_API_KEY`；设置 `MAIL_API_URL`（真实 HTTPS 发信端点）。
3. **同源路由是阻塞项**：当前 Worker 在 `earthonline-backup.1317746169.workers.dev`，站点在 `slices0flife.me`。跨站 Cookie 只能用 `__Secure-eo_sess; SameSite=None`，Safari ITP / 第三方 Cookie 限制会导致登录态失效。代码默认 `AUTH_COOKIE_MODE="same-site"`（生成 `__Host-eo_sess; SameSite=Lax`），必须把 `/api/*` 同源路由到该 Worker 才能可靠工作；跨站模式需显式 `AUTH_COOKIE_MODE=cross-site` 且 `AUTH_ALLOW_CROSS_SITE=true`，仅作为有风险的临时选择，不降低 Secure/HttpOnly。
4. Access 应用与 AUD 保持不变；若同源路由改变 `/api/backup*` 的 Access 覆盖范围，须先单独评估并提供兼容方案，本阶段不改 Dashboard。

## 6. 阻塞项
- 邮件服务商账号 / API Key / 发信域名未配置：生产发码会明确失败（`email-unconfigured`），不伪造成功。
- D1 实例与同源路由未配置：即使代码完整，真实登录闭环在未配置的部署上不可用。

---

## 7. Phase Auth.2 增补（同源 API / Session 备份授权 / 用户命名空间）

### 已实现
- **同源端点**：`public/app/auth.js` 与 `public/app/cloud-backup.js` 在 http(s) 页面默认使用 `location.origin + /api/*`；仅 `file://` 本地打开回退到开发 Worker。测试环境仍可用 `earthonline-auth-endpoint` / `earthonline-cloud-backup-endpoint` 覆盖。
- **备份授权重划分**：`cloudflare-worker/src/index.js` 新增 `authorizeBackup()`：
  - 正常模式必须应用 Session；userId 只来自 `AUTH.requireSession()`。
  - `BACKUP_REQUIRE_ACCESS_JWT=true` 时额外要求 Access JWT（过渡加固），Access JWT **单独**永远不能访问用户备份。
  - `ALLOW_LEGACY_ACCESS_BACKUP=true` 仅供旧协议 harness 回归使用，生产严禁开启；该模式保持旧单租户路径且不产生 userId。
  - Access JWT 验签代码保留未删。
- **每用户独立 R2 命名空间**（Session 模式）：
  - v1：`users/<userId>/earthonline/backup-latest.json`
  - v2 pointer：`users/<userId>/earthonline/backups/v2/pointer.json`
  - v2 对象：`users/<userId>/earthonline/backups/<writeId>.json`
  - 客户端提交的 `objectKey` 必须与服务端按 Session userId 推导的键一致；`parseV2Immutable` / `parseV2Pointer` 在 ctx 存在时强制校验命名空间，canonical 哈希内部仍可复用。
  - `backup-v2-core.js` 的 `objectKeyOf(writeId, userId)` 支持生成对应键；前端调度器本轮仍未接入自动上传。
- **不迁移旧对象**：旧单租户对象保持原样；本轮不认领、不删除、不写入正式 R2。

### 测试
- `cloudflare-worker/test/backup-isolation.test.cjs`（6 条，真实 Worker 路由 + 内存 D1/R2）：未认证/Access-only/过期/撤销拒绝；v1 A/B 命名空间隔离与伪造 userId 失败；v2 对象/pointer 隔离、跨用户 objectKey 拒绝、CAS 冲突与重复 writeId 幂等。
- `scripts/auth-flow.test.mjs` 增 4 条（同源端点 ×2、静态 401 处理、Session 失效回 guest 并停调度）；`npm test` 全量 161/161；Worker 旧 harness 139/139。
- 备份请求遇到 401/403 时，`cloud-backup.js` 调 `OLAuth.markSessionInvalid()`：本机身份回 guest、调度器重新同步、不删本地数据；刷新后仍以服务端 Session 为准。

### 需要用户在 Cloudflare 完成（本轮未操作）
1. 把 `slices0flife.me/api/*` 路由到 `earthonline-backup` Worker（Worker Routes 或 Custom Domain，取决于现有 Zone 配置）；静态 `/app/*` 与资源仍由静态托管返回，不能被 API 路由或 SPA fallback 接管。
2. 确认 Access Application 不拦截 `/app/*`；如仍保护 `/api/backup*`，浏览器必须先取得 Access 会话，或先设 `BACKUP_REQUIRE_ACCESS_JWT=false`（默认）仅用应用 Session。
3. 生产配置**不要**设置 `ALLOW_LEGACY_ACCESS_BACKUP`。
4. 旧单租户备份如要归属某个 user，必须由用户确认后单独设计迁移，本轮不自动认领。
