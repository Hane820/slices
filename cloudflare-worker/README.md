# 地球online — Cloudflare 云端备份 Worker

一个独立的 Cloudflare Worker：把「完整业务备份 JSON」存进**私有 R2 桶**，
用 **Cloudflare Access** 做备份 API 的身份认证。本地 IndexedDB 仍是唯一业务数据源；
这里只保存最新一份备份（单对象 `earthonline/backup-latest.json`），
不做多设备实时同步。

**应用自有认证（Phase Auth）**：同一 Worker 还挂载 `/api/auth/*`，用 D1 + 邮箱验证码 +
HttpOnly Session Cookie 认证地球online用户。它与 Cloudflare Access JWT **互不替代**：
备份 API 仍要求 Access JWT；认证 API 只认应用自己的 Session；R2 保持私有。
详见 `docs/space-auth/PHASE_AUTH_IMPLEMENT.md`（含 D1 / Secrets / 同源路由阻塞项）。

## API

所有备份接口都要求 Cloudflare Access JWT（请求头 `Cf-Access-Jwt-Assertion`，
或浏览器 Access 会话的 `CF_Authorization` Cookie）。Worker 会用 Access 团队域的
JWKS 公钥**真实验签**（WebCrypto），并校验 `iss` / `aud` / `exp`，绝不只解码就放行。

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

## 部署前：Cloudflare 控制台配置清单

1. **R2**：创建桶（建议名 `earthonline-backups`）。保持**私有**——不绑自定义域、
   不开公开访问、不生成公开链接（r2.dev 链接保持关闭）。
2. **Zero Trust → Access → Applications**：新建 Self-hosted 应用，
   域名填 Worker 的 `*.workers.dev` 地址（或自定义域）；策略按需（Allow 你的邮箱）。
   记下应用的 **AUD** 值。
3. 把 `wrangler.toml` 里三个 `REPLACE-ME` 换成真实值：
   `ACCESS_TEAM`（团队域）、`AUD_TAG`（应用 AUD）、确认 `APP_ORIGIN` 与站点一致；
   `[[r2_buckets]]` 的 `bucket_name` 换成第 1 步的桶名。
4. `wrangler login && wrangler deploy`。
5. 验证：浏览器登录 Access 后打开 `GET /api/backup/status` 应返回
   `{"ok":true,"hasBackup":false}`；未登录应被 Access 拦截或返回 401。

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
- **不得**为了让游客访问而取消备份 API 的 JWT 验签：游客根本不发 `/api/*` 请求，
  两者不冲突。R2 桶保持私有，不绑公开域。

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
| `https://earthonline-backup.*.workers.dev/api/backup*`（v1 与 v2 全部路径） | **保持认证** | Access JWT 验签 + CORS 白名单都不许取消；游客不发这些请求 |

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
- 未实现前端备份 UI（按任务边界，后续任务处理）。
