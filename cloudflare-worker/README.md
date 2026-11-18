# 地球online — Cloudflare 云端备份 Worker

一个独立的 Cloudflare Worker：把「完整业务备份 JSON」存进**私有 R2 桶**，
用 **Cloudflare Access** 做身份认证。本地 IndexedDB 仍是唯一业务数据源；
这里只保存最新一份备份（单对象 `earthonline/backup-latest.json`），
不做多设备实时同步、不用 D1。

## API

所有接口都要求 Cloudflare Access JWT（请求头 `Cf-Access-Jwt-Assertion`，
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

## 已知边界

- 只保存**最新一份**备份（覆盖式），不做历史版本；需要历史可在 R2 控制台手动复制对象。
- 备份内容不做深度 schema 校验（只验信封 `app/version/data/exportedAt`）——
  恢复时的完整校验由应用端导入流程负责。
- 未实现前端备份 UI（按任务边界，后续任务处理）。
