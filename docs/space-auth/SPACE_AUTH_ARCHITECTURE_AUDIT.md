# SPACE_AUTH_ARCHITECTURE_AUDIT

> 地球online · 身份认证与空间管理体系 · 现状审计
> 审计日期：2026-11-26　基线提交：`a5a151e`（工作区含 36 项未提交改动，见 §9）
> 审计方式：只读源码 + 静态分析，未运行任何网络请求、未改动任何文件。

---

## 0. 结论摘要

| 结论 | 事实依据 |
|---|---|
| 应用**没有任何账号体系**，也没有服务端用户表 | 全仓无 `login/signup/user` 业务实现；Worker 只做备份（`cloudflare-worker/src/index.js:1-32`） |
| 现有「身份」只是**本地数据空间选择**，且存在 **sessionStorage** 里 | `public/app/identity.js:27,31-49,54` |
| 「正式空间」= 单库 `earthonline`，与游客库 `earthonline-guest` 并列 | `identity.js:28-29`、`db.js:26-37` |
| 云端备份是**单租户单对象**，所有用户共用一份 key | `index.js:27,31-32`（`BACKUP_KEY` / `V2_POINTER_KEY` 为常量） |
| 云端认证用 **Cloudflare Access**，不是终端用户身份 | `index.js:117-197`；`README` 明确要求 Access JWT |
| Backup v2 的协议、CAS、不可变对象**已完整实现**，但**前端尚未接入** | `backup-v2-core.js` 仅被 `index.html:308` 加载，全仓无调用点；`cloud-backup.js:144` 仍走 v1 `/api/backup` |
| 无 D1、无 KV、无邮件能力 | `wrangler.toml` 只有 `[vars]` + R2 binding；`grep` 无邮件 SDK |
| 首启没有「探测旧数据」这一步 | `identity.js:44`：无记录 → `'local'`，既不做 legacy 探测、也不进 guest（决策 #1 要求：先探测，有旧数据→legacy，确认空→guest） |

---

## 1. 审计范围与方法

- 前端全部 16 个 JS + `index.html`（`public/app/`）。
- Worker 全部源码与配置（`cloudflare-worker/src/index.js` 856 行、`wrangler.toml`、`wrangler.dev.toml`、`README.md`）。
- 本地数据库 schema 与写入链路：`db.js` / `migrate.js` / `write.js` / `commit-queue.js`。
- 备份链路：`cloud-backup.js` / `backup-v2-core.js` / Worker。
- 测试：`scripts/*.test.*`、`cloudflare-worker/test/*.cjs`。
- Git：HEAD、`git status`、未跟踪文件（只读）。

审计期间**未执行**：任何 `fetch`、wrangler 命令、数据库操作、邮件调用、Git 写操作。

---

## 2. 身份与空间现状

### 2.1 唯一权威来源

`public/app/identity.js`（78 行）定义 `OLIdentity`，语义是「这次页面加载用哪个本地库」：

| 函数 | 行为 | 位置 |
|---|---|---|
| `mode()` | 返回 `'local'` / `'guest'`；**无记录 → local**；值损坏 → guest（fail-closed） | `identity.js:42-49` |
| `dbName()` | guest → `earthonline-guest`，否则 `earthonline` | `identity.js:54` |
| `enterGuest()` / `leaveGuest()` | 写/删 `sessionStorage['earthonline-space']='guest'` | `identity.js:56-66` |

**存储介质是 sessionStorage**，注释写明了原因（`identity.js:11-18`）：本轮产品决策没有登录入口，持久化会把用户永久困在游客空间。

### 2.2 生命周期实测（由存储介质推导，非猜测）

| 场景 | 结果 |
|---|---|
| 刷新页面 | 同一标签页仍是 guest（sessionStorage 保留） |
| 新标签页打开 | **回到 local**（sessionStorage 按标签页隔离） |
| 关闭标签页/浏览器 | 回到 local；游客库数据仍在 IndexedDB |
| 多标签页 | 允许「一个标签页游客 + 一个标签页正式」并存，两个库互不干扰 |

**与新需求的冲突**：产品要求「游客空间长期保留、刷新/关闭不得清除」。当前 sessionStorage 策略下，关闭标签页后空间标识消失（数据没丢，但下次进不去），**不满足**。

### 2.3 启动流程

```js
// boot.js:1002-1029
startBoot():
  if (OLIdentity.isGuest()) → bootGuest()        // 独立分支，零交叉
  else if (!OLDB.isSupported()) → bootLegacy()   // 老浏览器退回 localStorage
  else OLDB.open() → OLMigrate.status() → {
    idb        → bootFromIdb()
    in_progress→ waitMigration()
    failed     → tryMigrate()
    unavailable→ bootBlocked(...)
    ls/unmigrated/unknown → 有旧数据? tryMigrate() : bootLegacy()
  }
```

游客分支 `bootGuest()`（`boot.js:974-1000`）：只开 `earthonline-guest` → `OLGuest.prepare()` → `bootFromIdb()`；**不查迁移状态、不读 localStorage 正式数据、不回退 legacy**（回退就等于读写正式数据）。

### 2.4 游客库初始化与清空

`public/app/guest.js`：

- `prepare()`（`:105-132`）：`meta.schemaVersion` 存在 → 直接返回；不存在但六表有数据 → `incomplete-guest-db`（不覆盖）；否则 `defaults()` → `OLMigrate.buildRows()` → **单事务**写六表 + `schemaVersion` + `migration.status='done'`。
- `clear()`（`:135-171`）：先 `OLDB.close()`，再 `indexedDB.deleteDatabase('earthonline-guest')`，只清 `earthonline-guest-backup-*` 快照键。
- 幂等性有事务内二次确认（`:68-69`）。

### 2.5 身份异常处理

| 异常 | 现状 | 位置 |
|---|---|---|
| sessionStorage 被禁用 | `store()` 返回 null → `mode()` 返回 local（**不是** guest） | `identity.js:31-33,44` |
| 记录值损坏 | guest（安全失败） | `identity.js:48` |
| 游客库打不开 | 全屏阻断，不回退 legacy | `boot.js:985-999` |
| 游客库半初始化 | 阻断并报 `incomplete-guest-db` | `guest.js:113-117` |

> 注意 `identity.js:44` 与 `:48` 的取值方向相反：**没有记录**判 local，**记录损坏**判 guest。这是有意为之（不打扰老用户 / 不猜错库），但对新体系是一个必须重写的判定点。

---

## 3. 本地数据库

### 3.1 库名与版本

| 项 | 值 | 位置 |
|---|---|---|
| 库名解析 | `OLIdentity.dbName()`，只接受 `earthonline-guest`，否则回落 `earthonline` | `db.js:26-37` |
| 声明版本 | `DB_VERSION = 1`（原生 `IDBDatabase.version` 显示 10，Dexie ×10） | `db.js:36-37` |
| 打开点 | `db.js:256`（自省）、`db.js:180-181`（Dexie 实例） | — |
| legacy 存储 | `localStorage['earthonline-v4']` | `core.js:12`、`migrate.js:27` |

### 3.2 六张表

```js
// db.js:42-49
meta:        'key'
definitions: '[kind+id], kind'          // pen / tag / suggestion
tasks:       'id, cat, createdAt'
schedule:    'id, weekday, date'
dayEntries:  '[type+id], [type+date], date, ts, updatedAt'   // 8 类按日记录
dayMaps:     '[kind+date], date'        // note / mark / doneSugg
```

`dayEntries.type` ∈ `plan|tagLog|workout|studyLog|decision|flash|itemLog|restDay`（`db.js:53`）；
`definitions.kind` ∈ `pen|tag|suggestion`（`:54`）；`dayMaps.kind` ∈ `note|mark|doneSugg`（`:55`）。

### 3.3 meta 白名单（关键）

```js
// db.js:59-63
META_KEYS = {
  v:'payload', settings:'payload', plugins:'payload',
  schemaVersion:'infra', migration:'infra', writer:'infra',
  preNormalize:'infra', bizDatePolicy:'infra', bizRev:'infra'
}
```

新增 meta key 必须显式改白名单（`:56-58` 注释：不接受前缀/正则通配）。这条约束对后续「多用户空间」是**正面资产**：身份相关元数据不会悄悄混进业务表。

### 3.4 数据边界（不是表名清单）

| 类别 | 内容 | 能否跨空间复制 |
|---|---|---|
| **业务数据** | `tasks` / `schedule` / `dayEntries` / `dayMaps`；`definitions` 的 pen/tag/suggestion | ✅ 可复制（用户自己的内容） |
| **用户偏好** | `meta.settings`（主题、字号、resetHour、goals、mealSlots、装修/插件开关） | ✅ 可复制（属于「这个人怎么用」） |
| **插件开关** | `meta.plugins` | ✅ 可复制（与偏好同质） |
| **数据结构版本** | `meta.schemaVersion` | ❌ 不可复制（每库自建） |
| **迁移状态** | `meta.migration`（status/phase/lease/ownerId/writeCounts） | ❌ **绝对不可复制**（写入闸门依赖它，复制会伪造完成态） |
| **写入权租约** | `meta.writer`（epoch/ownerId/leaseExpiresAt/heartbeatAt） | ❌ 绝对不可复制（跨库复制会制造双写） |
| **业务版本号** | `meta.bizRev` | ❌ 不可复制（版本序列必须从 0 开始） |
| **日期策略基线** | `meta.bizDatePolicy`、`meta.preNormalize` | ❌ 不可复制（库级基线） |
| **迁移标记（库外）** | `localStorage['earthonline-v4-migrated']` | ❌ 不可复制，且**目前是全局单例** |
| **备份状态（库外）** | `localStorage['earthonline-cloud-backup-v1' / '-lease']` | ❌ 不可复制，且**目前是全局单例** |
| **导入快照（库外）** | `localStorage['earthonline-v4-backup-*']` / `earthonline-guest-backup-*` | ⚠️ 按空间前缀区分，可保留但不迁移 |

**结论**：一个「空间」= 一个 IndexedDB 库 + 一组**按空间隔离**的 localStorage 键。当前只有游客空间做到了键前缀隔离（`guest.js:20`），正式空间的 `MARKER_KEY`、`STATE_KEY`、`LEASE_KEY` 都是**全局唯一键**——这是多用户改造必须处理的第一处硬冲突。

### 3.5 写入链路（决定「切换空间」的复杂度）

- `core.js:531-537`：`save()` 在非 idb 模式下写 localStorage，并有一条游客安全带（游客库未就绪时拒绝写 localStorage）。
- idb 模式必须拿到**写入权租约**：`write.js` 的取权闸门要求 `meta.migration.status === 'done'`（`write.js:211-215`），租约存在 `meta.writer`，还有 epoch 下界校验（`migrate.js:122-131`）。
- 租约是 **per-DB** 的，因此「游客库 / 用户库」天然互斥不干扰；但**同一库多标签页**由租约串行化，跨库没有协调机制——这决定了「一个标签页一个空间」是必须的约束，而不是可选优化。

---

## 4. 现有云端备份

### 4.1 路由与认证

```
// index.js:781-844
/api/backup            PUT（上传，覆盖）| GET（下载）
/api/backup/status     GET
/api/backup/v2/object  PUT
/api/backup/v2/pointer PUT
/api/backup/v2/status  GET
```
- 所有路径**先验 Access JWT**（`index.js:796-808`），无 token → 401，验签失败 → 401，JWKS 不可用 → 502。
- 验签实现：`extractToken`（`:117-123`，取 `Cf-Access-Jwt-Assertion` 头或 `CF_Authorization` cookie）→ `verifyAccessJwt`（`:141-197`，WebCrypto 验 RS256/ES256 + `iss`/`aud`/`exp`/`nbf`）。
- CORS 只允许 `APP_ORIGIN` 单值（`:68-70`，`wrangler.toml:12`）。

### 4.2 存储布局（全部硬编码常量）

```js
// index.js:27-32
BACKUP_KEY      = 'earthonline/backup-latest.json'         // v1
V2_POINTER_KEY  = 'earthonline/backups/v2/pointer.json'    // v2 pointer
V2_OBJECT_PREFIX= 'earthonline/backups/'
```

**没有任何 userId 维度**。任何人只要持有有效 Access JWT，读写的都是同一份备份。

### 4.3 v2 协议实现质量（可直接复用）

| 能力 | 实现 | 位置 |
|---|---|---|
| 不可变对象 + 哈希自校验 | `parseV2Immutable` / `immutableHashOf` | `index.js:233-297` |
| 条件创建 `If-None-Match:*` | `v2CreateOnlyIf()` | `:389-391` |
| pointer CAS（`If-Match: etag`） | `v2MatchOnlyIf()` | `:393-396` |
| revision 单调 + 幂等判定 | `:644-679` |
| 对象内容与 metadata 交叉校验 | `:686-708` |
| 条件写失败（返回 null / 抛错）都当冲突 | `:609-616, 729-736` |
| 失败绝不假报成功 | 全文一致，`:733-740` 注释显式声明 |

**风险点（多租户必须改）**：`handleV2ObjectPut` 直接采信请求体里的 `im.objectKey`（`:573, 595`），只在 `parseV2Immutable` 内做形状校验，**没有前缀校验**。当前单租户无害；一旦多用户，这就是「写到别人 prefix」的入口。

### 4.4 v1 与 v2 的关系

- v1（`/api/backup`）是**当前唯一在用的上传通道**：`cloud-backup.js:144`。
- v2 有完整 Worker 实现 + `backup-v2-core.js` 协议库 + `scripts/backup-v2-core.test.cjs` + `r2-s3-integration.cjs` 真实 S3 集成脚本，**但前端没有任何调用**（`index.html:308` 仅加载）。
- 结论：v2 处于「服务端就绪、客户端未接」状态。这对新体系是好消息（不需要重写协议），但意味着**恢复流程在客户端还不存在**。

### 4.5 前端备份行为

`cloud-backup.js`：
- 门禁 `guestBlocked()`（`:21-25`）挂在 `init/markDirty/backupNow/refreshStatus` 四个真实出口（`:177,196,207,216`）。
- 状态与租约存 `localStorage` 全局键（`:8-9`），**不区分空间**。
- 自动上传：`save()` 成功出口 → `markDirty()` → 3s 去抖（`:195-203`）；失败只重试一次（`:163`）。
- 上传前读「已提交数据」走 `readExportSource()`（`:104-113`），不读内存未保存态。

### 4.6 测试覆盖

| 测试 | 覆盖 | 缺口 |
|---|---|---|
| `cloudflare-worker/test/harness.cjs` | Worker 全路由、JWT 验签、R2 故障注入、CAS 冲突 | 单租户假设；无多用户越权用例 |
| `test/r2-integration.cjs` | 真实 R2 的 S0–S8（含 `--s0-only`） | 只验证存储原语 |
| `scripts/backup-v2-core.test.cjs` | 客户端 v2 原语 | 不含 Worker 集成 |
| `scripts/guest-space.test.mjs` | 身份/守卫/静态隔离 11 项 | 不含多用户 |

---

## 5. 部署与基础设施

| 项 | 现状 | 证据 |
|---|---|---|
| 站点 | Astro 静态构建，`public/app/*` 原样进 `dist/app` | `astro.config.mjs:1-20`；`npm run build` 69 页 |
| 托管 | **待核实**：仓库内无 Pages/Worker 静态托管配置；线上据称为 Cloudflare Worker | 仓库无 `_headers`/`functions/`/`[assets]` |
| 业务 API | 无。Worker 只做备份 | `index.js:781-844` |
| 服务端数据库 | **无 D1/KV/DO**；`.wrangler/state` 里的 d1 目录是本地 miniflare 默认产物 | `wrangler.toml` 全文 |
| 邮件 | **无任何邮件能力** | 全仓无 resend/sendgrid/mailgun/smtp |
| Secrets | 全部走 `[vars]`（`APP_ORIGIN`/`ACCESS_TEAM`/`AUD_TAG`），无 `wrangler secret` 记录 | `wrangler.toml:11-17` |
| 环境隔离 | 生产 `wrangler.toml`（真实 Access）与 `wrangler.dev.toml`（本地 JWKS + 模拟桶）两套 | 两文件对照 |
| CI | 只 `npm ci && npm run build`，不部署 | `.github/workflows/ci.yml:1-30` |

---

## 6. 已有能力 / 缺失能力

### 已有（可直接复用）

1. 本地数据空间**已经有隔离骨架**：`OLIdentity.dbName()` 是唯一取库名入口，`db.js` 只在两处 `indexedDB.open`，业务代码无一处直接开库。
2. 游客库**幂等种子** + 单事务 + 半初始化检测（`guest.js`）。
3. 六表 schema 与 `buildRows()`/`rehydrate()` 双向转换（`migrate.js:327-397, 600+`），迁移可复用。
4. 写入权租约与版本号（`write.js`/`commit-queue.js`），天然 per-DB。
5. v2 备份协议 + CAS + 幂等（服务端完整）。
6. Access JWT 验签代码（可保留给「管理端」或内部运维接口）。

### 缺失（必须新建）

1. 服务端用户表、会话、验证码、限流 —— 全部没有。
2. 邮件发送通道 —— 没有。
3. 用户级 R2 前缀 —— 没有。
4. 客户端 v2 上传/恢复 —— 没有。
5. 空间标识的**长期持久化** —— 用的是 sessionStorage。
6. 空间切换 / 数据迁移 / 冲突确认的 UI —— 没有（设置页只有一句「未开放」）。
7. 多空间下 localStorage 键的命名空间 —— 全局单例。

---

## 7. 与新产品需求的冲突清单

| # | 冲突 | 现状 | 影响的决策 |
|---|---|---|---|
| C1 | 首次打开应进游客空间 | 无记录 → `local`（`identity.js:44`） | 启动判定必须重写 |
| C2 | 游客身份需长期保留 | sessionStorage，关标签页即失效 | 换 localStorage + 显式退出 |
| C3 | 一台设备多账号 | 只有一个正式库 `earthonline` | 库名按用户派生 |
| C4 | 迁移标记要按空间 | `MARKER_KEY` 全局单例（`migrate.js:28`） | 键名加空间前缀 |
| C5 | 备份状态要按空间 | `STATE_KEY`/`LEASE_KEY` 全局（`cloud-backup.js:8-9`） | 同上 |
| C6 | 云端按用户隔离 | 所有 key 是常量，无 userId | Worker 派生前缀 |
| C7 | 终端用户登录 | 认证是 Cloudflare Access（企业 SSO） | 必须换自有会话；Access 不能给终端用户签发 |
| C8 | 老用户数据不能消失 | 老数据在 `earthonline`，且 `MARKER_KEY` 已置位 | 升级时必须识别「legacy local」并保留入口 |

> **C1 与 C8 已由决策 #1 裁决（2026-11-26 确认）**：不是「一律进游客」，而是**先探测再定**——检测到有效旧数据库/旧数据进 `legacy`（老用户零感知），确认无旧数据才进 `guest`，探测异常或无法确定一律 fail-safe 到 `legacy`。判定不得只依赖 `MARKER_KEY`（`migrate.js:28`）。
> 详见 `SPACE_AUTH_ARCHITECTURE_DESIGN.md` §3.4（判定表与实现约束）、`SPACE_AUTH_SECURITY_REVIEW.md` T17/T18。
> 本条不再属于「待确认」，C1/C8 的原始冲突描述保留作现状记录。

---

## 8. 待核实项（不得猜测）

1. 线上静态站点究竟由 Cloudflare Pages 还是 Worker Assets 托管（决定 API 能否同源、Cookie 前缀能否用 `__Host-`）。
2. 生产 Worker 使用的是 Workers Free 还是 Paid 计划（决定 D1 单库 500MB / 50 查询每请求等上限）。
3. `earthonline-backups` 桶里现有对象的实际数量与归属（只读核对，本轮未访问）。
4. `slices0flife.me` 是否已在 Cloudflare 托管 DNS（决定能否给 API 加自定义域）。
5. 是否已有 Resend/Postmark 账号与已验证发信域名（决定邮件阶段的启动成本）。
6. `.wrangler/state/v3/d1` 目录来源（疑似 miniflare 默认产物，非真实 D1）。

---

## 9. Git 工作区（审计开始前 → 审计结束时）

- HEAD：`a5a151e feat(app): add standalone Toast config center (toast-text.js)`（两次一致）。
- `git status --short`：**36 项**（16 M / 1 D / 19 ??），审计前后逐行一致。
- 本任务新增文件：仅 `docs/space-auth/` 下 5 个 Markdown（本文件为其中之一）。
- 未执行任何 Git 写操作；未触碰既有未提交/未跟踪文件。

---

## 10. 决策收敛说明（2026-11-26 增补，不改写上文历史记录）

> 本节只记录「审计结论之后发生了什么」，不修改 §0–§9 的现状描述。
> 上文（尤其 §7 末尾关于决策 #1 的批注）保留为当时的历史记录，其结论已被本节取代。

### 10.1 审计发现的问题

上文记录的核心事实：现有「身份」只是 sessionStorage 里的一个本地库选择标记（`identity.js:27,31-49,54`），
没有账号体系；`earthonline`（正式库）与 `earthonline-guest`（游客库）并列，首启没有旧数据探测（`identity.js:44`）。

在此之上，三态设计曾把 `legacy` 提升为**第三种空间**（独立 kind、独立库名、独立身份记录、独立的
`guest ⇄ legacy` 双向切换与两阶段指针提交）。这带来三类问题：

1. **概念膨胀**：`legacy` 同时表示「旧版数据」「一种身份」「一个可切换的空间」，同一词承担三种语义。
2. **切换路径成为必需品**：为了在「本机数据」和「游客空间」之间往返，需要一整套切换执行器、
   `pendingSwitch` 中间态、关闭连接顺序、切换中断恢复与 T19/T20 两项威胁。
3. **首启判定被迫二选一**：探测结论（`has-data` / `empty` / `unknown`）被直接映射成空间身份，
   `unknown` 只能 fail-safe 到 `legacy`。

### 10.2 产品所有者确认的模型（两态）

- 只有两种空间状态：`guest`（未登录）与 `user`（已登录）。
- **`legacy` 不再是空间、不再是身份、不再有独立数据库与空间指针**，只作为「旧版数据」的兼容概念存在。
- 旧版数据在首次升级时被识别，并**原地认领为游客空间的数据**（不复制、不改名、不删除）。
- 旧数据探测的三态结论 `has-data` / `empty` / `unknown` 保留为**探测结果**，不再映射成空间身份；
  `unknown` 一律**阻断**，不写身份、不建库、不判空。
- 取消 `guest ⇄ legacy` 双向切换，连同 `pendingSwitch`、切换执行器、切换异常恢复与 T19/T20 一并撤销；
  两态之间只有「登录」与「退出登录」两条边。

完整设计见 `SPACE_AUTH_ARCHITECTURE_DESIGN.md`（§1 模型、§3.2 首次初始化、§3.3–§3.5 登录/退出/再次登录、
§10.1 撤销对照）；实施计划见 `SPACE_AUTH_IMPLEMENTATION_PLAN.md` Phase A/G；威胁模型见
`SPACE_AUTH_SECURITY_REVIEW.md` T17–T20。

### 10.3 对源码的影响

**尚未实施。** 截至本节写入时：

- `public/app/identity.js` 仍是 sessionStorage 版本，`mode()` 仍返回 `'local'` / `'guest'`，`dbName()` 只有两个取值。
- `public/app/boot.js` 仍按「guest / 非 guest」二分启动，没有旧数据探测、没有阻断页。
- `public/app/db.js` 仍把非 `earthonline-guest` 的库名一律回落 `earthonline`。
- 没有 D1、没有会话、没有 R2 前缀隔离、没有迁移状态机、没有空间卡片 UI。

也就是说：**文档已收敛为两态，代码仍是审计时的单用户 + 本地开关状态**。审计结论（§0–§9）在代码层面仍然成立。

### 10.4 工作区状态变化（仅记录，不解释）

- 审计时 HEAD `a5a151e`，工作区 36 项；此后提交 `f38d03f`（`feat(app): guest space, static UI text center, decide UI polish`），
  当前 HEAD `f38d03f`，工作区 20 项（10 修改/删除 + 10 未跟踪）。
- 本轮文档修订未改动任何源码、未执行任何 Git 写操作、未操作 Cloudflare 资源。
