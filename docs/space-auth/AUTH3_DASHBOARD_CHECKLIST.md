# Auth.3.2 — Cloudflare Dashboard 操作清单（只准备，不执行）

> 依据：2026-11-28 线上只读实测 + `wrangler.toml` 当前内容 + `AUTH3_DEPLOY_RUNBOOK.md`。
> 本清单由项目所有者本人在 Cloudflare Dashboard 操作；每项标注操作位置与核对方法。

## 1. 同源 Worker Route

| 项目 | 值 |
|---|---|
| 目标 Worker | `earthonline-backup`（仓库内唯一 Worker，入口 `cloudflare-worker/src/index.js`） |
| Route pattern | `slices0flife.me/api/*` |
| 操作位置 | Dashboard → Workers & Pages → earthonline-backup → Settings → **Domains & Routes** → Add route；或取消 `wrangler.toml:35` 注释并填真实 `zone_id` 后 `wrangler deploy` |
| 接管范围 | **仅 `/api/*`**。`/`、`/app/*`、博客页继续由静态托管服务，互不冲突 |
| 静态托管关系 | `slices0flife.me/api/auth/session` 现返回 404（静态托管无此路径）；Route 生效后返回 JSON |
| 附带项 | `workers_dev = true`（wrangler.toml:9）：同源验证通过后建议改 `false` 关闭 workers.dev 入口，减少暴露面 |

**核对方法**：Route 添加后（无需重新部署静态站），无痕窗口 GET `https://slices0flife.me/api/auth/session`（该端点不要求 CSRF 头），预期 `401 {"ok":false,"error":"no-session",...}` 的 JSON，而非 404 或 Access HTML；带有效 Session Cookie 的同一请求应返回 `200 {"ok":true,"user":{...},"expiresAt":...}`。与 Runbook §8 的期望一致。

## 2. Access 双 AUD（⚠️ 两个不同应用，不得混淆）

| 应用 | 覆盖 | AUD | 用途 |
|---|---|---|---|
| **Worker 域名应用**（earthonline-backup.workers.dev） | workers.dev 域 | `7aff656c944431a8c78434defd7875f695e4bad64eb44a1e2602992a70e80e88`（= wrangler.toml `AUD_TAG`，Worker `validateAccessJwt` 验签依赖） | 旧协议浏览器直接调 workers.dev 时的 JWT 校验 |
| **站点域应用**（slices0flife.me，团队 `still-silence-4b58`） | 实测拦截 `/api/backup*`（302 → Access 登录页）；`/`、`/app/*`、`/api/auth/*` 未拦截 | `ee636904…`（与 AUD_TAG **不同**） | 历史上保护备份 API，现备份授权已改用应用 Session |

**操作位置**：Zero Trust → Access → Applications，逐个打开两个应用核对 Self-hosted domain 与 AUD 值。

**路径公开要求**：
- 必须公开：`/`、`/app/*`（应用本体，已实测匿名 200 ✅）、`/api/auth/*`（登录入口，被拦则无法登录）
- 待决策：站点域应用是否继续拦 `/api/backup*` —— **推荐收窄**（备份授权已完全走应用 Session，Access 拦截只会在边缘产生 302 HTML，徒增前端误判面）；收窄后该应用可保留用于其他路径或直接删除

**风险提示**：若 Route 把 `/api/*` 交给 Worker 后，站点域 Access 应用仍在 Worker 之前拦截 `/api/*` 整体，则 `/api/auth/*` 会返回 302 HTML——前端 `classifyAuthFailure()` 会按 `auth-denied`/`unknown` 分类而不会误判 Session 失效（Auth.2-R 已修），但登录将不可用。**Route 生效后第一件事就是核对 `/api/auth/*` 不被 Access 拦**。

## 3. D1 创建与绑定

| 项 | 值 |
|---|---|
| 创建位置 | Dashboard → Storage & Databases → D1 SQL Database → Create |
| 建议名称 | `earthonline-auth`（与 wrangler.toml `database_name` 一致） |
| 填回仓库 | `wrangler.toml:51` `database_id = "REPLACE-ME-D1-DATABASE-ID"` → 真实 ID |
| binding | 必须 `AUTH_DB`（代码 `env.AUTH_DB` 硬依赖） |
| migration | `wrangler d1 migrations apply AUTH_DB --remote`（幂等，全 `IF NOT EXISTS`） |

**初始化后只读验证 SQL**（Dashboard → D1 → Console）：
```sql
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
-- 预期含：users / email_codes / sessions / rate_limits（及 _cf_KV 系统表可忽略）
SELECT COUNT(*) FROM users;  -- 预期 0
```

## 4. 邮件 Secrets 与变量清单

| 名称 | 类型 | 设置方式 | 缺失时行为 |
|---|---|---|---|
| `AUTH_CODE_PEPPER` | **Secret** | `wrangler secret put AUTH_CODE_PEPPER` | 代码回退非安全默认，验证码摘要强度下降——**必须设置** |
| `AUTH_IP_PEPPER` | **Secret** | `wrangler secret put AUTH_IP_PEPPER` | 回退常量 `"v1"`，IP 哈希可被枚举——**必须设置** |
| `MAIL_API_KEY` | **Secret** | `wrangler secret put MAIL_API_KEY` | 发码 503 `email-unconfigured` |
| `MAIL_API_URL` | 普通变量（非敏感） | `wrangler.toml [vars]` 或 Dashboard → Worker → Settings → Variables | `EMAIL_DRIVER=http` 时发码失败 |
| `EMAIL_DRIVER` | 普通变量 | `wrangler.toml [vars]`，改 `"none"` → `"http"` | `none` 时发码 503 |
| `ALLOW_LEGACY_ACCESS_BACKUP` | ❌ 禁止设置 | — | 出现即 preflight BLOCKED |
| `ALLOW_TEST_EMAIL` | ❌ 禁止设置 | — | 出现即 preflight BLOCKED |
| `BACKUP_REQUIRE_ACCESS_JWT` | 保持 `"false"` | wrangler.toml | `true` 会要求浏览器同时持有 Access 会话 |

**邮件服务商硬契约**（代码 `src/auth/email.js`）：HTTP POST、2xx 即判定成功、**无超时无重试**——选型时确认服务商有同步 2xx 响应语义；Secrets 值一律不写入仓库。

## 5. 操作顺序（依赖关系）

```
1. D1 创建 → 填 database_id（先于 deploy，binding 缺失 Worker 503）
2. 3 个 Secrets put（先于 deploy）
3. Route 添加（Dashboard 即时生效，或随 deploy）
4. wrangler deploy
5. Access 站点域应用路径核对（/api/auth/* 不被拦）
6. 按 Runbook 验证矩阵逐项验证
```
