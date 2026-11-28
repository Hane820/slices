# 真实 Cloudflare R2 S3 API 集成验证（阶段 1C）

`r2-s3-integration.cjs` 是一套**独立于 Wrangler remote binding** 的 R2 S3 集成测试工具，直接使用 AWS SigV4 调用 R2 S3-compatible API，验证真实 R2 的条件写原子性、ETag 语义、并发冲突与不确定写入对账。

它**不验证 Worker 协议**：不测幂等分支、revision 校验、409 映射、metadata 交叉校验或跨 Worker isolate 并发。Wrangler remote binding 路径因 `workers.dev` 网络阻断仍不可用，Worker 端到端验证保持 BLOCKED。

---

## 1. 安全边界（代码硬门禁）

| 项 | 约束 |
|---|---|
| Bucket | 只能 `earthonline-backups-r2test`；等于生产桶 `earthonline-backups` 或 `wrangler.toml` 中的桶时直接退出 |
| 白名单 | `R2_S3_ALLOWED_BUCKETS` 必须显式包含测试桶，且不得含生产桶 |
| 前缀 | 所有写入对象位于 `earthonline/backups/r2it-<runId>-*.json`；pointer key 与 legacy v1 key 从不访问 |
| Endpoint | 仅由 `R2_S3_ACCOUNT_ID`（32 位 hex）+ 固定 `https://<account>.r2.cloudflarestorage.com` 构造，不接受任意 endpoint 覆盖 |
| 凭证 | 只从环境变量读取；不打印、不落盘、不写入结果 JSON；日志统一脱敏 |
| 默认模式 | `--self-check` 完全离线；不带 `--run` 时 dry-run，**零网络请求** |
| 真实写入 | 必须显式 `--run` + `R2_S3_CONFIRM=YES`；S0 只读探针失败即停止，不进入任何 PUT |

---

## 2. 凭证模型

**唯一签发路径：本地 JWT 临时凭证**（不自动回退到需要额外 Cloudflare API Token 的方案）。

父凭证由你在 Cloudflare 面板创建并授权：

1. R2 → Overview → API Tokens → Create Account API token
2. 权限：`Object Read & Write`
3. **仅**应用到 `earthonline-backups-r2test`，不授予 Admin、不含生产桶
4. 设置较短过期时间；Secret 只在创建时显示一次

脚本用父 Secret 以 HS256 签发临时凭证：

- `accessKeyId` 复用父值
- `secretAccessKey = SHA256(jwt)` 的十六进制
- `sessionToken = base64("jwt/" + jwt)`，随每个请求以 `X-Amz-Security-Token` 发送并参与签名
- claims 绑定：单一 bucket、`actions = [HeadObject, GetObject, PutObject, DeleteObject]`、`paths.prefixPaths = ["earthonline/backups/r2it-"]`、TTL 默认 900 秒
- 撤销父 token 即使所有派生凭证立即失效

> 官方文档中关于 `actions` 存在不一致：概念页称仅本地签发支持，API 参考页已列出 `actions`。本工具只走本地签发，不依赖 API 支持。

---

## 3. 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `R2_S3_ACCOUNT_ID` | 是 | 32 位十六进制 Account ID（不打印） |
| `R2_S3_BUCKET` | 是 | 必须严格为 `earthonline-backups-r2test` |
| `R2_S3_ALLOWED_BUCKETS` | 是 | 逗号分隔白名单，必须含测试桶、不得含生产桶 |
| `R2_S3_ACCESS_KEY_ID` | 是 | 父凭证 Access Key ID |
| `R2_S3_SECRET_ACCESS_KEY` | 是 | 父凭证 Secret（只进内存） |
| `R2_S3_CONFIRM` | 是 | 必须 `YES` 才允许真实写 |
| `R2_S3_SESSION_TOKEN` | 否 | 脚本自行铸造，不需外部提供 |
| `R2_S3_TTL_SECONDS` | 否 | 默认 900，范围 60–604800 |
| `R2_S3_TIMEOUT_MS` | 否 | 默认 20000，范围 1000–120000 |

---

## 4. 命令

```powershell
cd E:\astro-fourfold-main\cloudflare-worker

# 1) 离线自检：不联网、不需要凭证
npm run test:r2:s3:self

# 2) dry-run：检查门禁，不铸造凭证、不发网络请求
npm run test:r2:s3

# 3) 真实执行（需你另行授权且已配置凭证）
node test/r2-s3-integration.cjs --run
```

不带 `--run` 时永远不写云端。默认测试 `npm test` 不包含本工具。

---

## 5. 测试流程

| 编号 | 内容 | 预期 |
|---|---|---|
| S0 | **只读** HEAD 探针（测试桶内、新 runId 前缀下不存在的 key）+ 前缀外 HEAD 作用域检查 | 探针 404；前缀外 403；任一不符即停止，不进入 PUT |
| S1 | `If-None-Match: *` 条件创建，带 `x-amz-meta-write-id` | 200 + 强 quoted ETag |
| S2 | 同 key 重复条件创建 | 412；HEAD 确认 ETag 与 write-id 仍属首次写入 |
| S3 | HEAD 一致性 | ETag 与 S1 一致，Content-Length 正确 |
| S4 | 正确 ETag 的 `If-Match` 更新 | 200，ETag 变更 |
| S5 | 过期 ETag 的 `If-Match` | 412；GET 确认内容保持 S4 |
| S6 | 两个独立 HTTP 连接并发 `If-Match`（同一旧 ETag、不同 body/write-id） | 严格一个 200、一个 412；记录状态码、ETag、请求 ID、耗时 |
| S7 | GET + HEAD 最终状态 | 内容等于胜者 body，write-id 等于胜者 |
| S8 | 按 manifest 清理 | 逐项 HEAD 校验归属 → DELETE → HEAD 404 |

**S6 的证据边界**：两个 `fetch` 并发发出、由 R2 服务端判定条件写；这**不是**跨 Worker isolate 并发验证。

---

## 6. 不确定写入处理

- 超时、断连、响应无法解析 → 标记 `indeterminate`，绝不直接认定失败。
- **`If-None-Match: *` 创建**：按官方流程用**同一 body、同一 write-id、同一条件头**重放一次；200 → 已提交；412 → HEAD 比对 `x-amz-meta-write-id`，相同则已提交，不同则他人写入，HEAD 404 则原请求仍可能挂起 → 仍不确定。
- **`If-Match` 更新**：**禁止盲目重试**；一律标记 `indeterminate`，立即停止，保留现场。
- 任何不确定状态均不触发清理，退出码非零。

依据：Cloudflare《Conditional operations / Reconcile an ambiguous write》与《Consistency model / Negative reads and in-flight writes》。

---

## 7. 清理策略

- 只有全部用例 PASS 且无 fatal/indeterminate 才清理。
- 只遍历 manifest 中显式记录的 key；逐项 `HEAD` 校验 `x-amz-meta-write-id` 与记录一致后才删除。
- 不按前缀列举批量删除；不删除 pointer、v1 key 或其他 runId 对象。
- 删除后逐项 `HEAD` 确认 404；任一删除失败立即停止，不扩大范围。

---

## 8. 结果文件

`r2-s3-integration-<runId>-result.json`（被 `.gitignore` 的 `*-result.json` 规则忽略）。包含 runId、bucket、起止时间、每个用例的状态/ETag/write-id/耗时、cleanup 清单、limitations。**不含任何凭证、Authorization 头或签名串**。

---

## 9. 已知局限

1. 仅验证 R2 存储原语，不代表 Worker 端到端验证通过。
2. 单次 PUT 的 ETag 无官方 MD5 保证，工具只做不透明比较。
3. ETag 缺失、弱 ETag、非强 quoted 一律 fail closed 并保留现场。
4. customMetadata 体积上限、SigV4 path-style 的具体行为需 S0 真实响应验证。
5. 当前未创建任何凭证、未进行真实 R2 验证；本文件描述的是可执行设计。
