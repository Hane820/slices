# Phase Auth.3 部署 Runbook（slices0flife.me 同源 Auth 上线）

> 本文档是**部署操作手册**，所有 Dashboard 操作必须由项目所有者本人执行。
> 生成时间：2026-11-28；基线 HEAD `61187d2`。执行前置：`npm run auth:preflight`
> 全绿（0 BLOCKED）。本文与 `docs/space-auth/PHASE_AUTH_IMPLEMENT.md` 配套阅读。

## 0. 部署架构（当前实测）

```
浏览器
  │  https://slices0flife.me/
  ▼
Cloudflare Zone（slices0flife.me）
  ├── /            与 /app/*  ──► 静态托管（Astro dist，匿名可访问，实测 200）
  ├── /api/auth/*  ──► [待配置 Route] ──► earthonline-backup Worker（D1 Session 认证）
  └── /api/backup* ──► [实测：边缘 Access 302 拦截，AUD ee636904…] ──► [待配置 Route] ──► earthonline-backup Worker
```

- `earthonline-backup` Worker 是唯一 API Worker；仓库内没有第二个 Worker。
- 当前站点 `/api/*` 无 Route，全部由静态托管 404（实测）。
- **注意**：站点域上存在一个 Access 应用（AUD `ee636904…`）保护 `/api/backup*`；
  它与 `wrangler.toml` 的 `AUD_TAG`（`7aff656c…80e88`，Worker 域名应用）**不是同一个**。
  Route 配置后，浏览器访问 `/api/backup*` 会先被该 Access 应用在边缘拦截（302 到
  `still-silence-4b58.cloudflareaccess.com`），带 Access 会话后才到达 Worker。

## 1. Git 基线确认

- 位置：本地仓库 `E:\astro-fourfold-main`
- 命令：`git status && git log --oneline -1`
- 前置：HEAD 与 origin/main 一致；暂存区按 A 包结论处理完毕（尤其不要带着
  `package-lock.json` 删除提交——CI 的 `npm ci` 会失败）。
- 预期：工作区干净，preflight 通过。
- 停止条件：暂存区内容与预期不符 → 停，先人工核对。

## 2. Worker Route（同源）

- 位置：Cloudflare Dashboard → Workers & Pages → earthonline-backup → Settings →
  Domains & Routes → Add Route。
- 操作：Route `slices0flife.me/api/*`，Zone 选 `slices0flife.me`；同时把真实
  `zone_id` 填入 `cloudflare-worker/wrangler.toml` 的 routes 行（取消注释）。
- 前置：Zone 在同一账号。
- 预期：Route 列表出现新条目；此时 `/api/*` 尚未部署新代码，先不要验证。
- 停止条件：Route 保存报错（Zone 不匹配）→ 停。
- **路径匹配注意**：`/api/*` 会同时接管 `/api/auth/*` 与 `/api/backup*`，
  静态资源不受影响（它们不在 /api/ 前缀下）。

## 3. 创建 D1 并绑定

- 位置：Dashboard → Storage & Databases → D1 → Create。
- 操作：数据库名 `earthonline-auth`（与 wrangler.toml `database_name` 一致），
  复制 database_id 填入 wrangler.toml 替换 `REPLACE-ME-D1-DATABASE-ID`。
- 预期：`npm run auth:preflight` 该项转 PASS。
- 停止条件：ID 填入后 preflight 仍 BLOCKED → 检查格式。

## 4. migration 远程执行

- 位置：本机（需 wrangler 登录凭证）。
- 命令：`cd cloudflare-worker && npx wrangler d1 migrations apply AUTH_DB --remote`
- 前置：第 3 步完成；wrangler 已 `wrangler login`。
- 预期：输出应用 `0001_auth.sql`，创建四表。migration 全部 `IF NOT EXISTS`，
  **可安全重复执行**。
- 停止条件：报 database_id 无效 / 权限不足 → 停，不要手工在控制台建表（结构漂移）。

## 5. Secrets 配置

- 位置：本机 wrangler（或 Dashboard → Worker → Settings → Variables → Secrets）。
- 命令：
  ```bash
  npx wrangler secret put AUTH_CODE_PEPPER   # ≥32 字节随机值，如 openssl rand -base64 32
  npx wrangler secret put AUTH_IP_PEPPER     # 同上，必须与 CODE 不同
  npx wrangler secret put MAIL_API_KEY       # 邮件服务商 API Key
  ```
- 红线：不记录明文；两个 pepper 不能相同；`AUTH_IP_PEPPER` 缺失时代码回退
  常量 `"v1"`（可被字典化），**必须设置**。
- 预期：三条 secret 列表可见（Dashboard 只显示名称与更新时间）。

## 6. 邮件服务配置

- 仓库侧：`wrangler.toml [vars]` 改 `EMAIL_DRIVER = "http"`，加
  `MAIL_API_URL = "https://<服务商端点>"`（非敏感，可进仓库）。
- 服务商要求（`src/auth/email.js` 契约）：
  - HTTPS POST，`Authorization: Bearer <MAIL_API_KEY>`，`Content-Type: application/json`
  - 请求体：`{ "to", "from", "subject", "text" }`；`from` 默认 `noreply@slices0flife.me`
  - **HTTP 2xx 即视为发送成功**，无重试、无超时（依赖 Workers 平台超时）。
    服务商必须保证：同步返回 2xx 前邮件已入队。
  - 若服务商格式不同（如 SendGrid/Resend 专有字段），需改 `email.js` 适配层，
    不要硬改请求体以外的假设。
- 域名前置：`slices0flife.me` 需在服务商完成发信域名验证（SPF/DKIM），
  否则邮件进垃圾箱或被拒。
- 停止条件：服务商无法满足 Bearer + 四字段 JSON → 停，先改适配层。

## 7. Worker 部署

- 命令：`cd cloudflare-worker && npx wrangler deploy`
- 前置：1-6 步全部完成；`npm test` 与 Worker harness 全绿。
- 预期：部署输出列出 Route `slices0flife.me/api/*`。
- 回滚预案见文末。

## 8. 同源 API 验证（只读，不登录）

| 探测 | 预期 |
|---|---|
| `curl -s https://slices0flife.me/api/auth/session` | `401 {"ok":false,"error":"no-session"}`（JSON，非 404/HTML） |
| `curl -s https://slices0flife.me/api/backup/status` | 现有 Access 应用仍在边缘 302（或按第 2-B 决策调整后为 401 JSON） |
| `curl -s -X POST https://slices0flife.me/api/auth/code -H "Content-Type: application/json" -d '{}'` | `403 csrf-required`（缺 `X-Earthonline-Auth: 1`） |
| 浏览器无痕打开 `/app/` | 直接进应用，无验证码页 |

- 停止条件：`/api/auth/session` 返回 404 → Route 未生效，检查第 2 步；
  返回 HTML → 被 Access 拦截，检查 Access 应用路径覆盖。

## 9. 登录与退出验证（用你自己的真实邮箱，一次性）

1. 应用内 设置 → 登录 → 输入邮箱发码（预期：`202` + 收到 6 位码邮件）。
2. 输码验证（预期：`Set-Cookie: __Host-eo_sess=…; Secure; HttpOnly; SameSite=Lax`，无 Domain）。
3. 刷新页面：设置页应显示脱敏邮箱（user 态）。
4. 退出登录（预期：服务端 Session 撤销 + Cookie 清除；刷新回到 guest 态）。
5. 失败排查：收不到邮件 → 查服务商日志与垃圾箱；`email-send-failed` → 检查第 6 步。

## 10. Session 过期与撤销验证

- 多标签页 A/B 登录；A 执行「退出所有设备」（`logout-all`）→ B 刷新应回 guest，
  B 的待备份状态保留但停止调度（`syncIdentity` 停 timer）。
- 90 天绝对过期由服务端判断（`absolute_expires_at`），无需实测，代码路径有测试覆盖。

## 11. 备份 API 授权验证

| 场景 | 预期 |
|---|---|
| 无 Session 直接 PUT `/api/backup` | 401 `code=session-invalid`（若被 Access 先拦则 302） |
| 用户 A 登录后 GET `/api/backup/status` | 只见 `users/<A>/…` 键空间结果 |
| 用户 A 手动备份后 GET `/api/backup` | 返回刚上传内容（`users/<A>/earthonline/backup-latest.json`） |
| 换用户 B 登录查 status | `hasBackup:false`（B 命名空间为空，与 A 隔离） |

## 2-B. 前置决策：站点域 Access 应用（AUD ee636904…）怎么办

当前该应用在边缘拦截 `/api/backup*`。三个选项（部署前必须选一个）：

- **选项 1（推荐）**：收窄/删除该站点域 Access 应用。备份授权现已改为应用
  Session（`BACKUP_REQUIRE_ACCESS_JWT=false`），站点域上不再需要 Access 拦截；
  Worker 域名（`earthonline-backup.*.workers.dev`）上的 Access 应用（AUD `7aff656c…`）
  保持不动。收窄后 `/api/backup*` 直接到达 Worker，401 JSON 语义完整。
- **选项 2**：保留拦截。所有用备份功能的浏览器必须先完成 Access 登录
  （One-time PIN 等），否则 fetch 被重定向到 Access HTML 页（前端按
  `unknown` 类处理，保留 user 态与 pending，不会误降级）。体验差，不推荐。
- **选项 3**：仅当需要过渡加固时设 `BACKUP_REQUIRE_ACCESS_JWT=true`，
  此时 Worker 验签用的 AUD 必须与实际拦截应用的 AUD 一致（当前不一致：
  `7aff656c…` vs `ee636904…`，直接开启会全部拒绝）。

## 生产验证矩阵（汇总）

| 场景 | 预期结果 |
|---|---|
| 匿名访问 `/app/` | 200 HTML，直接进应用 |
| 匿名访问 `/api/auth/session` | 401 `no-session` JSON |
| 匿名访问 `/api/backup/*` | 401 `session-invalid`（或按 2-B 决策 302 Access） |
| 非法 Origin 认证请求 | 403 `origin-forbidden` |
| 缺 `X-Earthonline-Auth` 头 | 403 `csrf-required` |
| 邮件服务未配置/失败 | 503 `email-unconfigured` / `email-send-failed`，验证码作废 |
| D1 不可用 | 502/503 `auth-unavailable`，不降级身份 |
| 登录成功 | `__Host-eo_sess` HttpOnly Cookie |
| 退出登录 | 服务端 `revoked_at` 写入，Cookie 清除 |
| 用户 A 读用户 B 备份 | 拒绝（命名空间隔离） |
| Access 边缘拦截返回 HTML | 前端分类 `unknown`，不误判 session 失效 |

## 回滚方案

| 变更 | 回退方式 | 可逆性 |
|---|---|---|
| Worker 代码 | `npx wrangler rollback`（回上一版本）或重新部署旧 commit 构建 | ✅ 可逆 |
| Worker Route | Dashboard 删除 Route `slices0flife.me/api/*`；站点恢复静态 404 | ✅ 可逆 |
| D1 数据库 | **保留不删**（含真实用户账号与 Session）；如需停用只解绑/删 Route | ⚠️ 删除不可逆 |
| migration | **不可自动回滚**。`0001_auth.sql` 只建新表；如必须回退：先 `wrangler d1 export` 备份，再手工 `DROP TABLE`（需逐一确认无业务依赖） | ❌ 标注不可逆 |
| 已发出 Session | 不需要单独处理：删除 Route 后 Cookie 无法到达 Worker；如需强制失效，`UPDATE sessions SET revoked_at=<now>` 全量撤销 | ✅ 可逆 |
| R2 备份对象 | 备份写入在 `users/<userId>/` 前缀下，回滚 Worker 不影响已有对象；回滚到 Access-only 旧协议**不会**读到用户命名空间对象（旧路径无数据） | ✅ 数据保留 |
| Secrets | 删除 Secret 会使对应功能明确失败（fail closed），不影响其它功能 | ✅ 可逆 |

## 与本文相关的核查产物

- `scripts/auth-preflight.mjs`（`npm run auth:preflight`）：部署前仓库级检查。
- D1 本地验证：migration 已在内存 SQLite 空库执行两次 + `routes.js` 全部 14 条
  SQL 模拟通过 + `users.email_norm` UNIQUE 生效（2026-11-28 核查）。
