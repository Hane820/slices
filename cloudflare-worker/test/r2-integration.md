# 真实 Cloudflare R2 集成验证（阶段 1B）

本目录下的 `r2-integration.cjs` 用于在**独立测试 Bucket** 上验证 Worker v2 的真实 R2 行为：
条件创建、pointer CAS、ETag 往返、冲突、并发与失败语义。

它不会加入默认 `npm test`，只有显式执行 `npm run test:r2` 才会启动。

---

## 1. 安全模型（硬门禁）

脚本在写入任何云端数据前，必须全部满足：

1. `R2_TEST_BUCKET` 显式存在，且 ∈ `R2_TEST_ALLOWED_BUCKETS` 白名单。
2. `R2_TEST_BUCKET` ≠ `wrangler.toml` 中的生产 Bucket（当前为 `earthonline-backups`）。
3. `R2_TEST_CONFIRM=YES`。
4. 测试 Bucket 在账号中真实存在（`wrangler r2 bucket list` 校验）。
5. 测试 Bucket 中 **pointer 不存在**（`earthonline/backups/v2/pointer.json`）。
   存在则拒绝运行，避免覆盖其他测试或历史数据。
6. 本地 `wrangler` 存在且已登录。
7. 启动本地 dev 后先执行**隔离探针**：
   通过 Worker 写入一个 runId 对象，再用 `wrangler r2 object get --remote` 从测试 Bucket 读回。
   读不到即判定 “remote binding 未生效 / 指向了别的桶”，立即停止。
   这样不会把本地 Miniflare 模拟误报成真实 R2。

任何一项失败：非零退出，不继续写入。

---

## 2. 需要你授权的资源

脚本**不会自行创建** Bucket。需要你单独准备：

| 项目 | 建议值 | 说明 |
|---|---|---|
| 测试 Bucket | `earthonline-backups-r2test` | 与生产桶完全独立；不要复用生产桶 |
| Binding | `BACKUP_BUCKET` | 脚本生成的临时配置里使用同名 binding |
| 环境 | 本地 `wrangler dev`（不部署） | R2 binding 通过 `remote = true` 访问真实测试桶 |
| Worker 名称 | `earthonline-backup-r2test-local` | 仅本地 dev，不部署、不建路由 |

最小权限（当前登录账号或专用 API Token）：

- R2：对测试 Bucket 的读写/删除（Object Read & Write；建议只授予该桶）。
- Workers Scripts：Read（`wrangler dev` 需要读取脚本配置/上传开发会话）。
- 账号：Read（列出 Bucket）。
- 不需要 Access 应用、不需要生产 Worker 路由、不需要 DNS。

创建方式（任选其一，由你执行）：

```bash
# 方式 A：wrangler（会真实创建资源，请确认桶名后执行）
cd cloudflare-worker
npx wrangler r2 bucket create earthonline-backups-r2test
```

```text
# 方式 B：Cloudflare 控制台 → R2 → Create bucket
名称：earthonline-backups-r2test
区域：默认
不开公开访问、不绑自定义域名
```

创建后确认桶内为空（尤其不能有 `earthonline/backups/v2/pointer.json`）。

---

## 3. 环境变量

PowerShell 示例（不要把值写进仓库）：

```powershell
$env:R2_TEST_BUCKET = "earthonline-backups-r2test"
$env:R2_TEST_ALLOWED_BUCKETS = "earthonline-backups-r2test"
$env:R2_TEST_CONFIRM = "YES"
# 可选：
$env:R2_TEST_CLEANUP = "success"      # success | always | never
$env:R2_TEST_WORKER_PORT = "8789"     # 被占用时自动尝试后续 9 个端口
```

| 变量 | 必填 | 说明 |
|---|---|---|
| `R2_TEST_BUCKET` | 是 | 测试桶名，必须与白名单完全一致 |
| `R2_TEST_ALLOWED_BUCKETS` | 是 | 逗号分隔白名单；防止误填生产桶 |
| `R2_TEST_CONFIRM` | 是 | 必须为 `YES` |
| `R2_TEST_CLEANUP` | 否 | 默认 `success`：仅全部通过时清理；`always` 总是清理；`never` 保留 |
| `R2_TEST_WORKER_PORT` | 否 | 本地 dev 起始端口，默认 8789 |

脚本不会读取或输出任何 Token/Secret/JWT；日志中的邮箱、账号 ID、JWT 会被脱敏。

---

## 4. 命令

```bash
cd cloudflare-worker

# 不联网自检：校验 runId/Key/canonical/JWT/门禁拒绝逻辑
npm run test:r2:self

# 真实 R2 验证（需要上面的环境变量与测试桶）
npm run test:r2
```

默认 `npm test` 仍然只跑 Stub Harness，不会访问云端。

---

## 5. 测试分组

| 组 | 内容 |
|---|---|
| R0 | 本地 dev 就绪 + 真实桶隔离探针（写入后 CLI 读回） |
| R1 | `If-None-Match: *` 首次创建、幂等、同 writeId 不同内容冲突、原对象未被覆盖、ETag 格式 |
| R2 | pointer 首次初始化 rev=1、status 一致、重复初始化幂等、真实存储内容一致 |
| R3 | CAS 成功、revision 严格 +1、status 与真实存储一致 |
| R4 | 旧 ETag 提交 409、失败不覆盖、revision 只 +1 |
| R5 | 两个并发 CAS：一个 200、一个 409；最终 revision 只 +1、pointer 与胜者一致 |
| R6 | ETag 全链路：写入响应 → status → 回传 → CAS；强 quoted、无弱 ETag |
| R7 | 协议头错误、immutableHash 不匹配、缺认证、过期 ETag 均不误报成功 |
| R8 | `immutableJson`/customMetadata 体积估算、对象 key 长度、writeId 长度 |

结果写入 `cloudflare-worker/test/r2-integration-<runId>-result.json`，
该文件名匹配 `.gitignore` 的 `cloudflare-worker/test/*-result.json`，不会进入 Git。

---

## 6. 清理规则

- 只按本次运行的内存 manifest 删除**显式 key**，不做前缀扫描、不做通配删除。
- 删除前逐个用 `wrangler r2 object get --remote` 读回，并校验：
  - 对象 payload 的 `data.runId` 等于本次 runId；
  - pointer 的 `writeId` 以 `r2it-<runId>-` 开头。
  归属无法确认的对象一律保留并写入报告。
- 先删对象、最后删 pointer；删除后再确认 pointer 不存在。
- 不触碰 `earthonline/backup-latest.json` 或任何 legacy key。
- 默认仅在所有断言通过时清理；失败时保留现场，除非 `R2_TEST_CLEANUP=always`。
- 隔离/启动失败时，会清理已写入的本次对象（仍逐个校验归属）。

---

## 7. 已知局限（报告中必须如实标注）

1. **跨 isolate 并发未验证**：两个并发请求由同一个本地 `wrangler dev` 进程转发，
   不能证明跨 isolate 并发；但条件写的最终原子性由真实 R2 服务端决定。
2. **无法强制真实 R2 制造 ETag 缺失/读取失败**：这些分支保留 Stub 覆盖，
   不得声称“真实 R2 已验证”。
3. **metadata 体积为发送前精确计算值**：`wrangler r2 object get` 不返回 customMetadata，
   因此报告的是 Worker 实际写入的键值字节估算，而非从 R2 元数据接口反查。
4. **remote binding 依赖 Wrangler 版本**：若 `remote = true` 未生效，隔离探针会失败并中止，
   不会退化成“本地模拟通过”。
5. 测试桶中的 pointer 是固定 key（Worker 协议不允许自定义前缀）；
   因此要求运行前 pointer 必须不存在，且同一测试桶不要并行跑多个 run。

---

## 8. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `[missing-env]` | 缺少必填环境变量 | 按第 3 节设置 |
| `[production-bucket]` | 误填生产桶 | 改用独立测试桶 |
| `测试 Bucket 不存在` | 未创建或未授权 | 创建桶/确认账号 |
| `测试桶中已存在 pointer` | 上次未清理或桶被复用 | 确认归属后手动清理该测试桶 |
| `本地 dev 未就绪` | 端口/JWKS/remote binding 问题 | 查看日志尾部；确认 `wrangler whoami` 已登录 |
| `隔离探针无法从测试桶读回` | remote binding 未生效或指向别的桶 | 中止；不要当作真实 R2 结果 |
| `wrangler r2 bucket list 失败` | 未登录/权限不足/代理 | 先 `wrangler whoami`，再重试 |
