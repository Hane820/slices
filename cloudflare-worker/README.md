# 地球online — Cloudflare 云端备份 Worker

一个独立的 Cloudflare Worker：把「完整业务备份 JSON」存进**私有 R2 桶**。
本地 IndexedDB 仍是唯一业务数据源；这里只保存最新一份备份
（单对象 `users/<userId>/earthonline/backup-latest.json`），不做多设备实时同步。

**当前生产授权方式（Phase Auth）**：同一 Worker 挂载 `/api/auth/*`（D1 + 邮箱验证码 +
HttpOnly Session Cookie）与 `/api/backup*`。备份身份**只来自应用 Session**，
`BACKUP_REQUIRE_ACCESS_JWT="false"`；Cloudflare Access JWT 不是备份的必要条件。
Access JWT 验签代码保留，仅用于可选的过渡加固模式（`BACKUP_REQUIRE_ACCESS_JWT="true"`
需 AUD 与实际拦截应用一致）与旧协议回归（`ALLOW_LEGACY_ACCESS_BACKUP`，生产禁止）。
R2 桶始终私有。部署权威文档是 `docs/space-auth/AUTH3_DEPLOY_RUNBOOK.md`；
设计为 `docs/space-auth/PHASE_AUTH_IMPLEMENT.md`。

## API

备份接口要求**应用 Session Cookie**（由 `/api/auth/verify` 签发的 `__Host-eo_sess`），
用户身份只从 Session 查表得到，前端传入的 userId 一律忽略。可选过渡模式下会额外要求
Cloudflare Access JWT（`Cf-Access-Jwt-Assertion` 头或 Access 会话 Cookie），此时 Worker
用团队域 JWKS 公钥**真实验签**（WebCrypto）并校验 `iss` / `aud` / `exp`，绝不只解码就放行。
未登录请求统一返回 401 JSON（`code=session-invalid` 时前端才允许降级为 guest）。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/backup/status` | 云端是否已有备份；返回 `hasBackup / size / uploadedAt / version`，不含内容 |
| `PUT` | `/api/backup` | 上传完整业务备份（`Content-Type: application/json`），覆盖 latest |
| `GET` | `/api/backup` | 下载完整业务备份（`Content-Disposition: attachment`） |

响应统一为 JSON；成功 `{"ok":true,...}`，失败 `{"ok":false,"error":"..."}`。
上传会校验：`app === "earthonline"`、`version === 4`、`data` 为对象、大小上限
（默认 20MB，可由 `MAX_BACKUP_BYTES` 调整）。校验失败、认证失败、R2 故障一律
明确报错（401 / 400 / 413 / 415 / 502 / 500），**绝不假报成功**。

CORS 只允许 `APP_ORIGIN`（生产值 `https://slices0flife.me`，站点 `/app/` 只是路径，Origin 不含路径）这一个来源；
其它来源一律 403 且不带 CORS 头。日志只记方法 / 路径 / 状态码 / 字节数，
不记录备份正文与任何凭据。

## 本地测试（隔离，不碰真实资源）

```bash
cd cloudflare-worker
npm test        # node test/harness.cjs
```

测试完全离线：R2 用内存桩（可注入故障），JWT 用本地生成的真实 ES256/RS256
密钥对 + 本地 JWKS 服务，Worker 走真实 WebCrypto 验签路径。
不 import 任何应用代码，IndexedDB / 业务库零接触。

## 本地运行（wrangler 模拟 R2）

```bash
npm install -D wrangler   # 或 npx wrangler dev
npx wrangler dev          # 本地模式自动模拟 R2 桶
# curl 需要 Access JWT；本地联调可在 wrangler.toml 临时加 JWKS_URL 指向自建 JWKS
curl -H "Cf-Access-Jwt-Assertion: <JWT>" http://127.0.0.1:8787/api/backup/status
```

注意：workerd 本地模式会拦截 Worker 发往**本机回环 / 私网地址**的 outbound fetch
（实测：公网可达、127.0.0.1 报 "Network connection lost"）。因此本地自建 JWKS
只能让已认证请求走到「502 auth-unavailable」（安全行为：身份服务不可达 → 拒绝）。
真实部署不受影响——正式 JWKS 在 `https://<团队域>.cloudflareaccess.com`（公网）。
需要本地验证完整认证链路时，可用 Miniflare 编程接口 + `outboundService` 拦截
JWKS 传输层（Worker 的 fetch + WebCrypto 验签代码路径不变），见
`E:/wb-5b5-test/cf-wrangler-local.cjs`。

## 部署前：Cloudflare 控制台配置清单（当前生产架构）

> 顺序与 `docs/space-auth/AUTH3_DEPLOY_RUNBOOK.md` 一致；完整操作与回滚以 Runbook 为准。

1. **R2**：创建桶（建议名 `earthonline-backups`）。保持**私有**——不绑自定义域、
   不开公开访问、不生成公开链接（r2.dev 链接保持关闭）。`wrangler.toml` 已声明
   `binding="BACKUP_BUCKET"`、`bucket_name="earthonline-backups"`。
2. **D1**：创建数据库（建议名 `earthonline-auth`），把 database_id 填进
   `wrangler.toml` 的 `[[d1_databases]]`（当前为 `REPLACE-ME-D1-DATABASE-ID`），
   binding 必须为 `AUTH_DB`。远程建表：
   `npx wrangler d1 migrations apply AUTH_DB --remote`（幂等）。
3. **Secrets**：`wrangler secret put AUTH_CODE_PEPPER`、`AUTH_IP_PEPPER`；
   启用 http 邮件驱动后再 put `MAIL_API_KEY`。仓库内不保存明文。
4. **邮件**：服务商需满足 HTTPS POST + Bearer + `{to,from,subject,text}` + 同步 2xx；
   配置 `EMAIL_DRIVER="http"` 与 `MAIL_API_URL`，并完成发信域名 SPF/DKIM 验证。
5. **同源 Route**：`slices0flife.me/api/*` → `earthonline-backup`（Dashboard 添加，
   或取消 `wrangler.toml` 的 `routes` 注释并填真实 `zone_id`）。`/`、`/app/*`
   继续由静态托管返回，不受影响。
6. **Access 边界**：确认没有 Access 应用拦截 `/api/auth/*` 或 `/app/*`；
   站点域若仍拦截 `/api/backup*`，按 Runbook §2-B 收窄。Worker 域名应用保持不动。
7. `npx wrangler deploy`，随后按 Runbook §8-§11 验证。
8. 验证：匿名 `GET /api/auth/session` 返回 401 `no-session` JSON；
   登录后 `GET /api/backup/status` 返回 `{"ok":true,"hasBackup":false}`。

### 默认游客模式下的 Access 边界（必须遵守）

应用现在是**默认游客**：打开 `https://slices0flife.me/app/` 必须直接进入本地游客空间，
不能要求邮箱验证码。因此：

- Access 应用**只允许保护 Worker 域名**（`earthonline-backup.*.workers.dev` 或自定义 API 域）。
  站点域名 `slices0flife.me` 及其 `/app/*` 路径、静态资源、PWA 文件一律不得被 Access 策略拦截。
- 仓库里的 Worker 代码已经做到这点：`handleRequest()` 对 `/api/backup*` 之外的路径直接返回
  404，认证只发生在这些 API 路径上（`src/index.js` 的 `verifyAccessJwt`）。仓库内**没有**
  任何对静态站点的登录守卫，也没有 `_headers` / `_redirects` / 中间件形式的 Access 规则。
- 如果打开应用网址看到邮箱验证码页，来源一定是 **Cloudflare Zero Trust Dashboard 里另一个
  Access 应用**（Self-hosted 应用保护了站点域名或整个 `*.slices0flife.me`）。仓库内改不了，
  必须在 Dashboard 处理，步骤见下方。
- **不得**为了让游客访问而放宽整个 Worker 的 Access 策略：游客根本不发 `/api/*` 请求，
  站点可访问性与备份 API 的应用 Session 授权互不冲突。当前生产用 Session 保护备份，
  不依赖 Access JWT；R2 桶保持私有，不绑公开域。

Dashboard 操作步骤（由项目所有者执行）：

1. 打开 Cloudflare Zero Trust → Access → Applications，列出全部应用。
2. 找到域名为 `slices0flife.me`（或 `*.slices0flife.me` / `/app/*`）的 Access 应用。
3. 若它保护的正是站点静态页面：删除该应用，或把它的 Policy 改为只对备份 API 域名生效；
   不要把 `slices0flife.me` 保留在任何 Allow 策略的匹配范围内。
4. 确认 Worker 域名的 Access 应用仍然存在且策略不变，AUD 与 `wrangler.toml` 的 `AUD_TAG` 一致。
5. 用无痕窗口打开 `https://slices0flife.me/app/`：应直接进入应用（无验证码页）；
   再直接打开 Worker 的 `/api/backup/status`：应出现验证码页或返回 401。
6. 若仍被拦截，检查 Zero Trust → Access → Application 的「Access Policy」是否还有
   `Include: Everyone` + 站点域名的组合，以及是否有 Cloudflare Rules / Page Rules 做的重定向。

必须公开访问 vs 必须保持认证（边界清单）：

| 资源 | 要求 | 说明 |
|---|---|---|
| `https://slices0flife.me/app/`（含全部静态资源、PWA 文件） | **匿名可访问** | 游客直接进本地空间；静态页面、JS/CSS、图标、manifest 一律不得有登录墙 |
| `https://slices0flife.me/api/backup*`（v1 与 v2 全部路径） | **应用 Session 保护** | 未登录返回 401 JSON；CORS 只许 `APP_ORIGIN`；可选 Access JWT 加固须 AUD 一致 |

**为什么不能直接删除一个「覆盖范围不明」的 Access 应用**：仓库证据只能证明
`wrangler.toml` 里登记了 `ACCESS_TEAM`（`still-silence-4b58.cloudflareaccess.com`）与一个
`AUD_TAG`，无法证明 Dashboard 上只有这一个 Access 应用、也无法证明某个应用是否同时
服务其它子域名（比如邮件网关、内网工具、另一个 Worker 的自定义域）。直接删除一个
不明覆盖范围的应用，可能把仍在使用它的其它服务一起裸奔。正确顺序是：先列出全部
应用与其域名 → 确认每个应用的真实用途 → 只删除/收窄保护站点域名的那个 → 每删一个
都用第 5 步的双向无痕验证确认「站点通了、API 仍拦」。

**待人工确认（仓库证据不足）**：
- Dashboard 上到底有哪些 Access 应用、各自绑定什么域名；
- 是否存在其它子域名（如 `api.slices0flife.me`）与备份 Worker 共用同一个 Access 应用；
- `AUD_TAG` 是否仍然匹配 Worker 域名应用的当前值（Access 应用重新创建后 AUD 会变）。

## 已知边界

- 只保存**最新一份**备份（覆盖式），不做历史版本；需要历史可在 R2 控制台手动复制对象。
- 备份内容不做深度 schema 校验（只验信封 `app/version/data/exportedAt`）——
  恢复时的完整校验由应用端导入流程负责。
- 前端自动备份调度已实现（`public/app/cloud-backup.js`）：登录后会合并上传、
  pending 持久化与刷新恢复、guest 五层 fail-closed；v2 pointer 调度接入属后续阶段。
