# SPACE_AUTH_IMPLEMENTATION_PLAN

> 地球online · Phase A–H 实施计划
> 依据：`SPACE_AUTH_ARCHITECTURE_AUDIT.md`、`SPACE_AUTH_ARCHITECTURE_DESIGN.md`
> 原则：每个阶段可独立验收、可独立回滚；**任何阶段未验收前不得开始下一阶段**（除标注可并行）。
> **模型：两态（`guest` / `user`）**。`legacy` 不是空间，只作为旧版数据的兼容概念存在。

> **已确认决策（截至 2026-11-26，两态收敛后重述）**
> - **决策 A · 只有两个空间**：`guest`（未登录）与 `user`（已登录）。不存在第三种空间、不存在旧数据空间、不存在空间切换边。
> - **决策 B · 旧数据识别 ≠ 第三种空间**：首次升级探测到有效旧数据 → **原地认领为游客空间的数据**；确认无旧数据 → 新建空游客空间；无法确定 → **阻断**，不写身份、不建库、不判空。
> - **决策 C · 游客登录与迁移**：验证码 → 定位/检查 user 空间与云端备份 → **询问**是否迁移 → 复制 + 校验 + **云端备份成功** → 才允许切换身份。拒绝迁移则游客数据完整保留。
> - **决策 D · 退出登录**：撤销服务端 session → 停止访问云端 → 保留 user 本地库 → 切回 guest。**本地退出与服务端撤销分开表述**，失败不假装成功。
> - **决策 E · 再次登录**：本地优先；新设备才询问云端恢复；不自动覆盖、不自动迁移 guest、不同用户严格隔离、冲突先处理。
> - **决策 F · 撤销 `guest ⇄ legacy` 切换**：连同 `pendingSwitch`、切换执行器、切换异常恢复与测试一并撤销；旧数据探测能力保留，改为首次初始化 + 阻断页重试。
> - 其余七项见设计 §11（含两态收敛带出的 5 个新问题），**未确认前不得在实施中单方面定值**。

---

## 0. 阶段总览与依赖

```
A 身份两态 + 首次初始化 ──▶ C 用户库隔离 ──▶ D 游客迁移 ──┐
                                                          ├─▶ G UI ──▶ H 安全测试与上线
B 验证码/会话 ────────────▶ E R2 多用户隔离 ──▶ F 跨设备恢复 ─┘
```

| 阶段 | 目标 | 依赖 | 可并行 |
|---|---|---|---|
| A | 身份权威源换成持久化记录；只保留 `guest` / `user` 两态；旧数据认领或阻断 | — | 与 B |
| B | D1 + 邮件验证码 + 会话 Cookie | — | 与 A、C |
| C | 用户空间多库并存；退出后不串库 | A | 与 B |
| D | 游客 → 用户 的复制迁移 | A、C、B（会话） | 与 E |
| E | R2 按 spaceKey 隔离，v2 接入前端 | B | 与 D |
| F | 云端恢复 + 冲突确认 + 再次登录 | E | — |
| G | 两态卡片 / 登录 / 退出 / 迁移 UI + 常驻标识 | A、B、C、D | — |
| H | 威胁用例、异常恢复、上线切换 | 全部 | — |

**关键路径**：A → C → D → G → H。B/E/F 可与左侧并行，但 G 必须等 D。

---

## Phase A — 身份与空间数据模型（两态）

**目标**：把「身份」从 sessionStorage 的临时标记，升级为长期持久化、可校验、可恢复的单一权威记录；身份取值收敛为 `guest` / `user` 两态；旧版数据在首次启动时被认领或阻断。

**涉及文件**
- `public/app/identity.js`（重写，保留 `mode()/isGuest()/dbName()` 兼容壳）
- `public/app/db.js`（`resolveDbName` 两态 + 非法值返回 `null`，不再回落默认库）
- `public/app/boot.js`（启动决策树；首次初始化；阻断页分支）
- `public/app/settings.js`（空间状态读取改为新 API）
- `public/app/guest.js`（认领路径下**不**调用 `OLGuest.prepare()`——它只负责给 `earthonline-guest` 建库种子）
- `scripts/guest-space.test.mjs`（扩充用例）
- `scripts/space-first-run.test.mjs`（新增：探测 + 认领 + 阻断）

**前置条件**：无。

**任务**

1. 新增 `earthonline.space.v2` 读写层：`record()` / `writeFirstRun()` / `writeLogin()` / `writeLogout()` / `clear()`。记录字段严格按设计 §1.4：`space`（仅两值）/ `dbName` / `origin`（`first-run|login|logout|repair`）/ `detectedBy` / `adoptedOldData`。
   - **禁止写入 `pendingSwitch`**（已删除，设计 §1.4）。
   - `guest` 记录里不得出现 `userId`/`spaceKey`；出现即判损坏。
2. `mode()` 兼容映射：`guest → 'guest'`，`user → 'local'`（内部仍叫 local，避免大面积改调用点）。**删除 `legacy → 'local'` 的映射**。
3. `dbName()`：按设计 §1.5 校验
   - `guest` + `earthonline-guest` → 通过
   - `guest` + `earthonline` + `adoptedOldData:true` → 通过
   - `user` + `earthonline-u-[a-z0-9]{16}` → 通过
   - 其余 → 返回 `null`（**不回落**、不猜）。
   `db.js` 拿到 `null` 时抛 `identity-unknown`，由 `startBoot()` 进阻断页。
4. `detectOldData()`（历史名 `detectLegacy()` 可保留，但**不得返回空间身份**）：按设计 §3.2.1 实现三步取证、1500ms 超时、只读、不调 `OLMigrate`；返回 `{verdict:'has-data'|'empty'|'unknown', detectedBy, counts?}`。
5. 首次初始化（设计 §3.2.2）：
   - `has-data` → 写 `{space:'guest', dbName:'earthonline', adoptedOldData:true, origin:'first-run'}` → 走既有 `OLMigrate.status()`/`tryMigrate()` 或 `bootFromIdb()`；**不复制、不改名、不删除旧库**。
   - `empty` → 写 `{space:'guest', dbName:'earthonline-guest', adoptedOldData:false}` → `OLGuest.prepare()` → `bootGuest()`。
   - `unknown` → **不写记录、不建库、不开库**，进阻断页。
6. 旧 `sessionStorage['earthonline-space']` 一次性迁移（设计 §9.4）：只作诊断，**不参与判定**；迁移后删除该键。
7. 身份记录损坏：备份原值到 `earthonline.space.broken` → 走首次初始化；若探测同时发现本机存在 `earthonline-u-*` 库 → 进阻断页（设计 §3.2.3 第 7/8 条），主行动「登录后继续」、次行动「以游客身份继续」。
8. **阻断页**（设计 §3.2.4）：`reason` 分类（`detect-timeout` / `db-blocked` / `identity-corrupt` / `db-unreadable`）、重试、可选兼容模式；**不得**出现「跳过并开始使用」。
9. **记录合法时不探测**：`space/dbName` 通过校验就直接用，探测调用次数必须为 0（设计 §3.9 第 3 条）。
10. 提供 `writeLogout()` 原语：只写 guest 记录（`origin:'logout'`，`dbName` 取 `earthonline.guest.lastDb`，缺省 `earthonline-guest`），并清理 user 记录字段。**退出登录的交互与网络调用不在本阶段**（见 Phase B 任务 8、Phase G 任务 6）。

**明确不做（本轮）**：不实现空间切换执行器 `OLSpace.switchTo()`（已撤销）、不实现 `pendingSwitch` 恢复分支、不实现设置页旧数据入口、不实现退出登录的 HTTP 流程。

**数据/接口变更**：仅 localStorage 键；**数据库 schema 不变**（`DB_VERSION=1`）。

**安全风险**
① 记录被篡改 → 指向不存在的库：`dbName` 白名单 + 非法即阻断（不是猜一个库）。
② **探测误判**：把有数据的旧库判成空库 = 用户以为数据丢了。防护：判定表 + 超时/异常一律 `unknown` 并阻断；`unknown` 绝不写身份。
③ **认领路径写坏旧库**：认领必须是纯指向操作，打开库后只做 `OLMigrate.status()`（只读）；测试断言升级前后六表行数与 `meta` 逐字节一致。

**对已有功能影响**：老用户首次启动多一次只读探测（正常 <20ms；打不开时受 1500ms 超时约束）；探测不写业务数据、不触发迁移、不联网。

**测试**
- 判定表逐行（设计 §3.2.1）：
  - 无记录 + `earthonline` 六表任一有行 → `has-data`，`detectedBy='rows'`，identity 为 `{guest, earthonline, adoptedOldData:true}`。
  - 无记录 + 库全空 + `earthonline-v4` 可解析 → `has-data`，`detectedBy='localStorage'`。
  - 无记录 + 库全空 + 无 localStorage → `empty` → 建 `earthonline-guest`。
  - 无记录 + `open` 抛异常 / 超时（模拟 1800ms）→ `unknown`，**identity 未写入**、`indexedDB.databases()` 里**没有新增库**。
  - 无记录 + `indexedDB` 不可用 → `unknown` + 阻断页。
  - `earthonline-v4-migrated` 存在但库与 localStorage 都空 → `empty`（证明标记不参与判定）。
  - `earthonline-v4-migrated` 缺失但库有数据 → `has-data`（同上）。
- 认领只读性：探测 + 认领后，六表行数与 `meta` 与操作前一致（除可能的空库创建外无写入）。
- 记录损坏：截断 JSON / 非法 space / `guest` 带 `userId` / 非法 `dbName` → 保留 broken 副本；有旧数据 → 认领；同时存在 user 库 → 阻断。
- 记录合法（指向 `earthonline-guest`）但 `earthonline` 有数据 → 启动进 guest，`detectOldData` 调用次数 0。
- `dbName()` 对 `earthonline-u-<15字符>`、`../../x`、`earthonline-u-<16大写>`、`earthonline`（无 `adoptedOldData`）全部返回 `null`。
- `writeLogout()` 只写 guest 记录（`origin:'logout'`），不触发任何网络请求（网络桩断言 0 次），不改动任何库的行数。
- 旧 sessionStorage='guest' + 探测 `has-data` → 仍认领旧库（老标记被否决）。

**验收标准**
- 上述测试全绿。
- 手工：老用户升级后首屏数据/条数/页面与升级前完全一致（认领）；新设备首开进 guest；「清 localStorage」「清 IndexedDB」「都清」三种情况分别落到设计 §3.2.3 的预期结论。
- 探测耗时 P95 < 50ms（空库路径）；最坏受 1500ms 约束，期间显示阻断页骨架而不是白屏。

**回滚**：删 `earthonline.space.v2` 即回到「无记录」；`identity.js` 保留旧函数名，回滚只需还原该文件。`detectOldData()` 若需关闭，用 `SPACE_DETECT=off` 强制进入阻断页（**不是**强制 legacy——那会掩盖数据）。

---

## Phase B — 邮箱验证码与会话

**目标**：可用的邮箱登录闭环：发码、验码、建会话、查会话、退出；含限流与防枚举。

**涉及文件（新增/修改）**
- `cloudflare-worker/src/auth/`（新增：`codes.js`、`sessions.js`、`ratelimit.js`、`email.js`、`routes.js`）
- `cloudflare-worker/src/index.js`（路由挂载 + 会话中间件）
- `cloudflare-worker/wrangler.toml`（`[[d1_databases]]`、`[vars]`、secret 清单）
- `cloudflare-worker/migrations/0001_auth.sql`（新增）
- `cloudflare-worker/test/auth.test.cjs`（新增）
- `public/app/auth.js`（新增，前端调用层 + 退出状态机编排）
- `public/app/identity.js`（调用 `writeLogout()`；`earthonline.logout.v1` journal 读写）
- `public/app/index.html`（加载 `auth.js`）
- `public/app/config/settings.js`（登录面板文案 key）

**前置条件**：D1 实例已创建；发信域名完成 SPF/DKIM 验证（见 Phase H 上线清单）。

**任务**
1. 建表（设计 §4.2），`wrangler d1 migrations apply`。
2. 发码：校验邮箱格式 → 限流（邮箱 5/h、IP 20/h、60s 冷却）→ 生成 6 位码 → 存 hash → 调邮件适配层 → 统一 202。
3. 验码：查最近未消费记录 → 校验 hash / 过期 / 次数 → 消费 → 建/取 user → 建 session → Set-Cookie。
4. 会话中间件：读 cookie → hash → D1 查 → 过期/吊销判定 → 挂 `ctx.user`。
5. `GET /api/auth/session` / `POST /api/auth/logout|logout-all`。
6. 邮件适配层：`send({to, subject, text, html})`，可切换驱动，**默认不发送**（`EMAIL_DRIVER=none` 写日志返回 queued）。
7. 前端 `auth.js`：`requestCode / verifyCode / session / logout`，全部 `credentials:'include'`，错误码映射为 UI 文案；`logout` 必须有 10s 超时并区分 `failed` 与 `offline`。
8. **退出登录状态机**（设计 §3.4，本阶段实现逻辑，Phase G 接 UI）：
   - `loggingOut` 内存闸门（拦云端上传与备份）→ `POST /api/auth/logout` → 三态 `revoked` / `failed` / `offline`；
   - `revoked` → `OLIdentity.writeLogout()` → reload；
   - `failed`/`offline` → **不切身份**，返回可重试错误；用户显式选择「只退出本机」时写 guest 记录 + `earthonline.logout.v1 {at, serverRevoked:false}`；
   - 任何分支都不删除 `earthonline-u-*` 库、不改动 guest 库。
9. **补撤销入口的后端契约**：`POST /api/auth/logout` 在无有效会话时返回 204（幂等），使「上次没撤销成功，再点一次」不会因为 401 卡死。

**数据/接口变更**：新增 D1 4 张表；新增 5 个 `/api/auth/*` 端点；Worker 首次出现「非备份」路由。

**安全风险**：邮箱枚举、暴力破解、发信滥用、Cookie 配置错误。见 `SPACE_AUTH_SECURITY_REVIEW.md` T4–T9、T12。

**测试**
- 发码成功 / 冷却期内重复发 → 429（且不重复扣邮件配额）。
- 错误码 5 次 → 作废，再试 `too-many-attempts`。
- 正确码只能用一次；第二次 `code-consumed`。
- 不存在邮箱与存在邮箱的响应体、状态码、时延差异 < 50ms。
- 会话过期（伪造 `expires_at` 过去）→ 401；吊销后 → 401。
- Cookie 头断言：`HttpOnly; Secure; SameSite=Lax; Path=/`，且带 `__Host-` 前缀。
- 邮件驱动用 mock，断言「只发一次」与「模板不含验证码以外的用户数据」。
- `logout` 超时 → 前端拿到 `offline`（而不是抛异常）。
- 退出三态各一条：`revoked` 写 guest 记录；`failed` / `offline` **不写** guest 记录且 identity 仍为 user；「只退出本机」写 guest 记录 + journal。
- `logout` 在无会话时返回 204（幂等补撤销）。
- 退出前后 `earthonline-u-*` 与 guest 库的行数均不变。

**验收标准**：上述测试全绿；本地 `wrangler dev` 用 mock 邮件完成一次完整登录；D1 中查不到明文验证码与明文 token。

**回滚**：Worker 保留 `AUTH_MODE=access|session|both`；回滚置 `access` 即恢复原行为。D1 表可保留。

**对已有功能影响**：备份端点在此期间保持 Access 校验（`both` 时两种都接受），前端备份行为不变。

---

## Phase C — 用户空间本地数据库隔离

**目标**：同一设备支持多个用户库并存；退出/换号只重载；多标签页不串库。

**涉及文件**
- `public/app/identity.js`（`writeLogin`/`writeLogout` 后广播）
- `public/app/db.js`（库名两态 + 打开前断言）
- `public/app/core.js`（快照键加空间前缀）
- `public/app/migrate.js`（`MARKER_KEY` 改为 `earthonline.migrated.<dbName>`）
- `public/app/cloud-backup.js`（`STATE_KEY/LEASE_KEY` 改为按 spaceKey）
- `public/app/boot.js`（storage 事件 → 只读横幅）
- `scripts/guest-space.test.mjs`、`scripts/space-isolation.test.mjs`（新增）

**前置条件**：Phase A 完成。

**任务**
1. 库名生成：`earthonline-u-<spaceKey>`；首次进入用户空间时建库 + 种子（复用 `OLGuest.prepare()` 的通用化版本 `OLSpace.ensureSeeded(dbName)`）。
2. `MARKER_KEY`、`STATE_KEY`、`LEASE_KEY` 全部加空间后缀；启动时执行一次旧键搬迁。
3. 多标签页：监听 `storage` 事件，`dbName` 变化 → 置只读 + 提示刷新（不自动 reload）。
4. 写入门禁：`core.js:531` 的安全带从「游客」推广为「空间未就绪」（任何非 idb 状态都不得写 localStorage）。
5. 身份写入 API：`OLIdentity.writeLogin({space:'user',...})` / `writeLogout()` + `location.replace()`。

**数据/接口变更**：无新表；新增库名形态；localStorage 键改名（附搬迁函数）。

**安全风险**：串库（写到别人库）、旧键污染、多标签页双写。防护：库名白名单、键名带 spaceKey、`storage` 事件只读降级、写入租约 per-DB。

**测试**
- 同一设备 A/B 两账号：A 写 3 条，切 B 看不到；切回 A 仍在。
- 多标签：A 标签 + B 标签并行写，两库计数互不干扰。
- 旧键搬迁：预置旧 `earthonline-cloud-backup-v1` 后启动，新键有值且旧键被清。
- 退出后未重载直接写 → 被门禁拦截并提示。

**验收标准**：测试全绿；手工「登录 A → 退出 → 登录 B → 退出 → 登录 A」数据各自完整。

**回滚**：库名形态与键名前缀都是新增；回滚只需把 `identity.js` 恢复为旧版，用户库数据仍在（不删），只是暂时不可达。

**对已有功能影响**：认领的 `earthonline`（guest）不受影响；`earthonline-guest` 不受影响。

> **注意**：本阶段**不包含**任何空间切换逻辑。`user → guest` 只有退出登录一条路（Phase A/§3.4）。

---

## Phase D — 游客 → 用户 数据迁移

**目标**：把游客数据**复制**进用户空间，全流程可中断、可恢复、不删源数据、不经用户确认不触发。

**涉及文件**
- `public/app/migration-space.js`（新增：状态机 + 复制 + 校验）
- `public/app/settings.js`（迁移询问入口）
- `public/app/boot.js`（启动时检测未完成迁移 → 阻断式提示）
- `public/app/core.js`（复用 `readExportSource`）
- `scripts/space-migration.test.mjs`（新增）

**前置条件**：A、C 完成；B 至少「会话可用」（迁移后要上传）。

**任务**
1. 状态机落盘 `earthonline.migration.v1`（设计 §3.6）；`from` 恒为 `guest`。
2. `plan()`：读源库计数；判断源库是否「仅演示种子」（是则跳过询问）；**检查目标 user 库是否已有该账号数据——有则不给迁移入口**（设计 §3.3 第 4 条）。
3. `run()`：`rehydrate(源)` → `buildRows()` → 目标库单事务写入 + `meta.import` 行。
4. `verify()`：逐表计数 + 抽样重水合 + payload 哈希。
5. `upload()`：调用 Phase E 的上传（可先 stub）；**`uploaded` 之前不得写 identity**。
6. `activate()`：写 identity（唯一提交点，必须 `stage=uploaded`）。
7. 启动恢复：任意 stage 中断 → 弹「继续 / 放弃」；`stage !== 'done'` 时不得让用户直接进入该 user 库。
8. 目标库防污染：已有 `meta.import.id` 且不同 → 拒绝。
9. 失败三出口：重试 / 放弃并进入空 user 空间（清本 importId 行 + 迁移记录）/ 回到 guest。

**数据/接口变更**：`meta` 新增 `import` 键（需扩 `db.js` 白名单）；无服务端变更。

**安全风险**：把游客数据误当目标库已有数据（覆盖）、迁移后源库被清、重复迁移产生重复行、半迁移库被当作正常库使用、**未经确认自动迁移**。

**测试**
- 游客 42 条 → 迁移 → 用户库 42 条、内容逐条相等、源库仍 42 条。
- 在 `copying` 阶段强杀（事务中途抛错）→ 目标库 0 行、无 import 行。
- 在 `uploaded` 阶段中断 → 重启后补写 identity，不重复复制。
- 上传失败 → **identity 未写**，仍为 guest，源库完整（决策 C 第 7 条）。
- 重复点两次迁移 → 第二次直接进 `done`（幂等）。
- 目标库已有他人 import.id → 拒绝并提示。
- 未点「迁过去」→ 没有任何复制发生（可用写入桩断言目标库 0 行）。
- 目标 user 库已有数据 → 迁移入口不渲染。

**验收标准**：测试全绿；手工断网迁移 → 停在「上传失败」，本地完整，回到游客数据仍在。

**回滚**：删 `earthonline.migration.v1` + 删用户库（或保留）→ 回到游客。**任何情况下源库不受影响**。

**对已有功能影响**：迁移期间写入被冻结（唯一一次全屏 Sheet）；迁移完成后进入常规流程。

---

## Phase E — Backup v2 多用户隔离 + 前端接入

**目标**：每个用户只可能读写 `users/<spaceKey>/` 下的对象；前端从 v1 切到 v2。

**涉及文件**
- `cloudflare-worker/src/index.js`（前缀派生、会话鉴权、object/pointer/status 改造、新增 GET object）
- `cloudflare-worker/test/auth-isolation.test.cjs`（新增）
- `cloudflare-worker/test/harness.cjs`（扩充）
- `public/app/cloud-backup.js`（改用 v2：object → pointer）
- `public/app/backup-v2-core.js`（已有，补 `fetch` 包装）
- `scripts/backup-v2-core.test.cjs`（补充集成断言）

**前置条件**：Phase B（会话可用）。可与 D 并行。

**任务**
1. `prefixOf(spaceKey)`：`users/${spaceKey}/backups/v2/`。
2. 所有 v2 处理函数从 `ctx.user.spaceKey` 取前缀；**删除**对客户端 `objectKey` 的信任（改为等值校验）。
3. `GET /api/backup/v2/object?writeId=` 新增（恢复用）。
4. v1 三个端点：仅 `LEGACY_OWNER_USER_ID` 可用，其余 `410 legacy-retired`（此处 `legacy` 指旧版 v1 协议，不是空间）。
5. 前端上传改为 object → pointer 两段式（保留「不丢 pending」与 3s 去抖）。
6. 保留 `AUTH_MODE=both` 过渡。

**数据/接口变更**：R2 路径变更（新对象写新前缀）；v1 端点语义收窄；新增 1 个端点。

**安全风险**：越权（T1/T2/T16）、pointer 被跨用户更新、old 前缀残留可读。防护：前缀派生 + 等值校验 + 所有读取都从派生 key 出发。

**测试**
- 用户 A 的 session 请求 B 的 writeId → 400 `object-key-mismatch` 或 404（不得 200）。
- 用户 A 读 `status` 只能看到自己的 pointer。
- CAS：A 用 B 的 etag 更新自己的 pointer → 409。
- objectKey 传 `users/../` 或绝对路径 → 400。
- v1 端点：非 owner session → 410；owner → 仍可用。
- 前端：上传后 pointer.revision +1；断网重试只有一次；409 时不重试。

**验收标准**：测试全绿；两账号交叉用例全为拒绝；v2 协议头与 CAS 行为与改造前逐字节一致（对比 `r2-integration.cjs --self-check`）。

**回滚**：`AUTH_MODE=access` + 前端开关 `BACKUP_CHANNEL=v1`；新前缀对象保持不动（不删）。

**对已有功能影响**：owner 的旧备份仍在旧前缀，前端切 v2 后需要一次「认领」或保持 v1 直到迁移完成（上线顺序见 Phase H）。

---

## Phase F — 跨设备恢复、冲突确认与「再次登录」

**目标**：新设备能从云端恢复；本地有数据时永不自动覆盖；再次登录按「本地优先」进入。

**涉及文件**
- `public/app/cloud-restore.js`（新增）
- `public/app/settings.js`（恢复入口 + 冲突面板）
- `public/app/migrate.js`（导出「整库替换」事务能力，或复用 import 路径）
- `scripts/restore.test.mjs`（新增）

**前置条件**：Phase E。

**任务**
1. `status()` 对比逻辑（设计 §6.2 判定表）。
2. 恢复：下载 → 暂存库 → 校验 → 快照 → 替换 → 校验 → 删暂存。
3. 冲突面板：展示云端/本地的时间、条数、设备标识；两个按钮「用云端」「保留本地」。
4. 「撤销这次恢复」：24 小时内可从 `-bak-<ts>` 库回滚。
5. 恢复期间写冻结 + 顶部横幅。
6. **再次登录分支**（设计 §3.5）：本机 user 库非空 → 直接进入，只在卡片提示「云端有更新的备份」，由用户主动点恢复；新设备 → 询问后恢复。

**数据/接口变更**：本地临时库 `-incoming` / `-bak-<ts>`；无服务端变更。

**安全风险**：覆盖本地数据（T14）、恢复中途损坏、云端损坏数据被信任。防护：payload 哈希 + 快照 + 两阶段替换 + 显式确认。

**测试**
- 新设备（空库）+ 云端有备份 → 提示恢复 → 恢复后条数一致。
- 本地有 10 条、云端 8 条 → 不自动恢复，必须确认。
- 本机已有该账号 10 条 + 云端有更新 → 直接进入本地 10 条，不弹恢复面板。
- 恢复中途断电（事务抛错）→ 当前库仍是原数据（快照可回滚）。
- 云端 payload 哈希不符 → 拒绝并提示「备份损坏」。
- 撤销恢复 → 回到恢复前条数。

**验收标准**：测试全绿；手工双设备流程（A 上传 → B 登录 → 恢复 → 校验）通过。

**回滚**：删 `cloud-restore.js` 的入口即可；已恢复的数据由用户自行撤销（bak 保留 24h）。

**对已有功能影响**：无（新增能力）。

---

## Phase G — 设置页 UI（两态）

**目标**：一张两态空间卡片 + 一个 ⓘ 弹窗 + 登录/迁移/管理三套 Sheet + 一个常驻空间标识。

**涉及文件**
- `public/app/settings.js`（`renderGuestSet` 重写为 `renderSpaceCard`）
- `public/app/index.html`（`#guestSet` → `#spaceSet`；新增 sheet 容器；顶栏空间标识容器）
- `public/app/config/settings.js`（新增 key：`settings.space.*`、`settings.space.badge.*`、`settings.signin.*`、`settings.migrate.*`、`settings.info.*`）
- `public/app/base.css` / `settings.css`（卡片、标识与弹窗样式）
- `scripts/ui-text-check.mjs`（新 key 纳入检查）

**前置条件**：A、B、C、D。

**任务**
1. 两态卡片（设计 §7.1，共 11 个子态）+ ⓘ 按钮。**不得**渲染任何「旧数据空间 / 切换空间」入口。
2. ⓘ 弹窗五段说明（设计 §7.2），文案全部走 `U()`；必须写清「迁移是复制」「退出不删数据」；`adoptedOldData:true` 时多一段升级说明。
3. 登录 Sheet（邮箱 → 验证码，含倒计时、错误态、重发）。
4. 迁移 Sheet（询问 / 进度 / 失败三出口）。
5. 空间管理 Sheet（邮箱、设备、备份详情、恢复、退出、删除本机数据）。
6. **退出登录**：二次确认 + 失败三态（重试 / 只退出本机）；`loggingOut` 期间禁用按钮与遮罩。
7. **常驻空间标识**（设计 §7.4）：`role="status"`；数据只来自 `OLIdentity.record()`；子状态随备份/会话变化局部更新；`≤22px`、不遮挡；未确认/阻断时显示「身份未确认」。
8. 无障碍：`aria-label`、焦点圈、`Esc` 关闭、弹窗焦点陷阱、标识对比度 ≥ 4.5:1。

**已删除（决策 F，必须有测试断言其不存在）**：guest 卡片「检查本机是否有旧数据」、legacy 卡片、任何「切换空间」按钮与确认弹窗。

**数据/接口变更**：无。

**安全风险**：UI 误导（把「退出」写成「删除」）、把云端状态说成实时同步、把标识写成缓存值、**残留「切换空间」入口**。

**测试**
- 11 态快照（固定状态渲染，断言标题/副标题/按钮文案）。
- 断言 DOM 中**不存在** `space-switch` / `check-old-data` 类入口（选择器级断言）。
- 常驻标识：guest / user 已备份 / user 离线 / 阻断 四态文案正确；阻断时不得出现「游客空间」。
- 文案完整性：`node scripts/ui-text-check.mjs` 0 错误。
- 键盘操作：Tab 循环、Esc 关闭、焦点回到触发按钮。

**验收标准**：11 态截图与设计一致；无「切换」类入口；标识四态正确；文案检查通过；无硬编码中文（全部经 `U()`）。

**回滚**：旧 `renderGuestSet` 保留在文件末尾（`if (FLAGS.legacySpaceUI) renderGuestSet()`），一键切回。注意：开关名里的 `legacy` 指「旧版 UI」，与本轮空间模型无关。

**对已有功能影响**：设置页视觉变化；云端备份区合并进卡片（`renderCloudSet` 保留但不再渲染在主导航路径）。

---

## Phase H — 安全测试与上线

**目标**：威胁模型逐项验证，异常恢复逐条演练，分阶段放量，可随时回退。

**涉及文件**
- `cloudflare-worker/test/security.test.cjs`（新增，覆盖 T1–T20）
- `scripts/e2e-space.test.mjs`（可选，Playwright 若引入）
- `scripts/space-recovery.test.mjs`（新增，R1–R17 中 node 环境可跑的部分）
- `docs/space-auth/RUNBOOK.md`（新增，上线与回滚手册）
- `cloudflare-worker/wrangler.toml`（cron、日志、限流开关）

**前置条件**：A–G 全部验收。

**任务**
1. 威胁用例（T1–T20）逐条自动化。
2. **异常恢复用例（R1–R17）**：至少覆盖 R1/R2/R3/R5/R7/R8/R9/R10/R11/R12/R13。
3. 压测：100 并发验码 + 100 并发行写入，确认 D1 写入行数在免费额度内。
4. 上线顺序：
   `D1 建表 → Worker 部署（AUTH_MODE=both）→ 前端发布（登录入口灰度）→ 观察 7 天 → AUTH_MODE=session → v1 端点 410`
5. 监控：401/403/429 比例、发信成功率、D1 行读/写、R2 5xx、**阻断页触发率**（`identity-unknown` 异常升高说明探测在误伤）。
6. 回滚演练：`AUTH_MODE=access` + 前端 `SPACE_UI=legacy`（即 Phase G 的 `FLAGS.legacySpaceUI`，只切旧版 UI），确认老用户可继续用。

**数据/接口变更**：线上 Worker 环境变量与 D1 绑定（运维操作，不由代码自动执行）。

**安全风险**：上线切换期间会话/权限不一致、旧前端缓存导致 cookie 与 API 不匹配。

**测试/验收**
- 20 项威胁用例全绿（安全评审 §3）。
- 两态专项（设计 §3.9 十二条）：
  1. `has-data` / `empty` / `unknown` 三支逐支可复现，`unknown` 不写 identity、不建库；
  2. 认领前后 `earthonline` 零写入；
  3. 记录合法时探测调用次数 0；
  4. `guest → user` 后两端库均不变；
  5. `user → guest` 后两端库均不变；
  6. 迁移 42 条逐条相等、源库不变、`uploaded` 前不写 identity；
  7. 退出 `offline` 分支不切身份；「只退出本机」写 journal；
  8. guest 态除补撤销外零 `/api/*`（网络桩断言）；
  9. 再次登录本地优先，不弹恢复；
  10. 阻断页无「跳过」按钮，标识显示「身份未确认」。
- 灰度 7 天：登录失败率 < 1%，发信成功率 > 98%，无 5xx 尖峰，阻断页触发率 < 0.1%。
- 回滚演练一次成功（< 5 分钟恢复）。

**回滚**：见 RUNBOOK；核心是**不改数据、只切开关**。

---

## 1. 文件影响总表

| 文件 | A | B | C | D | E | F | G | H |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `public/app/identity.js` | ● | ● | ● | | | | | |
| `public/app/auth.js`（新增） | | ● | | | | | ● | |
| `public/app/db.js` | ● | | ● | | | | | |
| `public/app/boot.js` | ● | | ● | ● | | | | |
| `public/app/guest.js` | ● | | | | | | | |
| `public/app/core.js` | | | ● | ● | | | | |
| `public/app/migrate.js` | | | ● | | | ● | | |
| `public/app/cloud-backup.js` | | | ● | | ● | | | |
| `public/app/migration-space.js` | | | | ● | | | | |
| `public/app/cloud-restore.js` | | | | | | ● | | |
| `public/app/settings.js` | ● | | | ● | | ● | ● | |
| `public/app/index.html` | | ● | | | | | ● | |
| `public/app/config/settings.js` | | ● | | | | | ● | |
| `cloudflare-worker/src/*` | | ● | | | ● | | | ● |
| `cloudflare-worker/wrangler.toml` | | ● | | | | | | ● |

---

## 2. 每阶段的「不许做」

| 阶段 | 禁止 |
|---|---|
| A | 不得修改数据库版本；不得删除 `earthonline` 库；不得改 `OLMigrate` 规则；**不得写 `pendingSwitch`**；**不得把 `unknown` 映射成任何空间** |
| B | 不得在前端存 token；不得用 `SameSite=None`；不得返回邮箱是否存在 |
| C | 不得同页切库；不得让旧键继续生效；不得复用同一库服务两个 userId |
| D | 不得删除/清空源库；不得在云上传成功前写 identity；**不得未经确认自动迁移** |
| E | 不得信任客户端 objectKey；不得改动 CAS/哈希逻辑；不得让 v1 对所有人可用 |
| F | 不得自动恢复；不得在无快照时替换本地库；**不得本地优先时弹恢复覆盖** |
| G | 不得把说明文字散落在卡片上；不得用 `innerHTML` 渲染文案；**不得残留任何「切换空间」入口** |
| H | 不得跳过回滚演练；不得一次性全量切换；不得用「切换失败」概括所有故障 |

---

## 3. 粗略工作量（用于排期，不含缓冲）

| 阶段 | 代码 | 测试 | 主要不确定性 |
|---|---|---|---|
| A | 中 | 中 | 老用户升级路径 + 认领只读性 |
| B | 大 | 大 | 邮件服务选型与域名验证 |
| C | 中 | 中 | 多标签页边界 |
| D | 大 | 大 | 断点恢复 + 上传前置 |
| E | 中 | 大 | 越权用例 |
| F | 中大 | 大 | 本地替换的原子性 |
| G | 中 | 小 | 文案与状态机对齐、标识轻量 |
| H | 小 | 大 | 上线顺序 |

> 不写具体人日：本仓库没有历史吞吐数据，任何数字都是猜的。
