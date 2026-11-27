# SPACE_AUTH_ARCHITECTURE_DESIGN

> 地球online · 身份认证与空间管理体系 · 目标架构
> 基线：`f38d03f`（工作区含未提交改动）｜设计日期：2026-11-26
> 前置阅读：`SPACE_AUTH_ARCHITECTURE_AUDIT.md`（现状与冲突清单）
>
> **模型版本：两态（2026-11-26 收敛）**。本版把此前的「`guest` / `legacy` / `user` 三态」收敛为
> 「`guest` / `user` 两态」，`legacy` 不再是空间、身份或独立数据库，只作为**旧版数据的兼容概念**存在。
> 被撤销的条目与保留并重新定义的内容见 §10.1。凡本文件出现 `legacy`，均指「旧版数据库 / 旧版存储 /
> 历史函数名」，不指空间。

---

## 0. 不可违反的不变量（Invariants）

后续所有实现、测试、评审都以这 10 条为准，任何一条被破坏即视为设计失败：

| # | 不变量 |
|---|---|
| I1 | **身份只有一个权威来源**：`OLIdentity`。任何模块不得自行读 storage 判断空间。 |
| I2 | **一个标签页一个空间**：身份变化必须整页重载，不允许同页并行操作两个库。 |
| I3 | **空间标识长期持久化**，不得使用 sessionStorage 作为归属依据。 |
| I4 | **游客数据永不上传**；游客路径不发起任何 `/api/*` 请求（唯一例外见 I10 与 §3.4.1：用户显式点「补撤销上次退出」）。 |
| I5 | **云端上传成功之前，绝不删除或清空任何本地数据**。 |
| I6 | **服务端只信会话推导出的 userId**，绝不信请求体/查询参数里的 userId。 |
| I7 | **R2 key 由服务端派生**，客户端只能提交 writeId，不能指定路径。 |
| I8 | 任何失败必须**可见且可恢复**，不得静默降级到「另一个空间」或「另一份数据」，也不得用「看起来正常的空空间」掩盖不确定的旧数据。 |
| I9 | **两态之间只允许身份变化**：`user → guest` 只改指向、不搬数据；`guest → user` 的数据动作必须是用户显式确认的**复制**，源数据永不删除、永不自动合并。 |
| I10 | **空间标识只来自当前生效的 identity**：不得来自探测结果、缓存或 DOM 默认值；身份未确定、初始化失败或退出未完成时，必须显示「未确认」而不是正常态。 |

术语硬约束（违反即视为设计错误）：

- `space` 的取值集合只有 `'guest'` 与 `'user'`。
- `'legacy'` **不得**出现在身份记录、空间枚举、空间列表、切换入口、状态图节点或边里。
- 不得为旧版数据单独创建数据库、身份记录或空间指针。

---

## 1. 身份与空间模型

### 1.1 两个空间（唯一合法集合）

| 状态 | 含义 | 数据位置 | 云端行为 |
|---|---|---|---|
| `guest` | 未登录的游客状态 | 本机游客 IndexedDB（`earthonline-guest`，或首次升级时认领的 `earthonline`） | **不上传、不访问任何云端备份**；不发起 `/api/*` |
| `user` | 已登录的用户状态 | 当前用户独立 IndexedDB（`earthonline-u-<spaceKey>`） | 按会话推导的 `spaceKey` 访问 `users/<spaceKey>/` |

必须同时成立：

1. `guest` / `user` 是唯一合法的空间状态，没有第三种。
2. **不存在**为旧版数据准备的独立空间；旧版数据库里的数据在首次升级时被**认领为游客空间的数据**（§1.5、§3.2）。
3. 用户之间的 `user` 数据严格隔离（不同 `spaceKey` → 不同库、不同 R2 前缀）。
4. `guest` 数据与 `user` 数据**物理隔离**（不同库、不同 localStorage 命名空间）。
5. 两个空间**不会因为登录、退出或再次登录而自动合并**；唯一的跨空间数据动作是 §3.6 的显式复制迁移。

### 1.2 四个概念，不要混为一谈

```
User（服务端身份，D1 users.id）
   │ 1:1（仅 user 态）
   ▼
Space（身份状态：guest | user）
   │ 1:1
   ▼
LocalDB（这台设备上的一个 IndexedDB 库；库名是空间的「数据载体」，不是空间类型）
   │ 1:1（仅 user 态）
   ▼
R2 prefix（users/<spaceKey>/）
```

- 身份状态决定「用哪个库、能不能连云」。
- 库名只是载体：同一个 `guest` 空间在这台设备上可能叫 `earthonline-guest`（新装）或 `earthonline`（认领旧数据）。
- 旧版数据库、旧版 localStorage、`OLMigrate`、`legacy.js` 都属于**数据兼容层**，位于 Space 之下，不参与身份判定。

### 1.3 spaceKey（服务端派生，客户端不可指定）

```ts
spaceKey = base32hex( HMAC-SHA256(SPACE_KEY_PEPPER, userId) )[0..16]   // 16 字符
```

- 由 Worker 在**登录成功时**计算并随 `user` 返回，客户端只存储不生成。
- 用途：本地库名后缀 + R2 前缀。**不写进 URL、不作为权限凭证**。
- 理由：库名/路径不暴露原始 userId；同一 userId 永远得到同一 spaceKey（幂等）；pepper 泄露不等于 userId 泄露。

### 1.4 本地身份记录（唯一权威，替换 sessionStorage）

存储：`localStorage['earthonline.space.v2']`（**单键、单权威**）。键名沿用 `v2`，但记录结构已按两态重定义（该键从未上线，无历史数据需要兼容）。

```jsonc
// A. 游客 · 新装（确认本机没有旧版数据）
{ "v": 2, "space": "guest",
  "dbName": "earthonline-guest",
  "origin": "first-run",          // 记录来源，纯审计
  "detectedBy": "none",           // 旧数据探测结论来源
  "adoptedOldData": false,
  "createdAt": "...", "updatedAt": "..." }

// B. 游客 · 首次升级认领了旧库（库名仍是历史上那个，但身份是 guest）
{ "v": 2, "space": "guest",
  "dbName": "earthonline",
  "origin": "first-run",
  "detectedBy": "rows",           // rows | localStorage
  "adoptedOldData": true,
  "createdAt": "...", "updatedAt": "..." }

// C. 用户
{ "v": 2, "space": "user",
  "userId": "u_01JABCD...",
  "spaceKey": "7f3a91c2d4e5b6a7",   // 小写 base32hex，16 位
  "dbName": "earthonline-u-7f3a91c2d4e5b6a7",
  "email": "a***@gmail.com",        // 仅展示，服务端返回的掩码
  "origin": "login",                // login | logout | first-run | repair
  "boundAt": "...", "lastVerifiedAt": "...", "updatedAt": "..." }
```

字段规则：

| 字段 | 取值 | 语义 |
|---|---|---|
| `space` | `guest` \| `user` | **只有这两个值**；其余视为损坏 |
| `dbName` | `earthonline-guest` \| `earthonline` \| `earthonline-u-[a-z0-9]{16}` | 数据载体；`earthonline` 只允许出现在 `space:'guest'` 且 `adoptedOldData:true` |
| `origin` | `first-run` \| `login` \| `logout` \| `repair` | **记录来源的审计字段**，不参与权限/分支判断；不得用来表达空间种类 |
| `detectedBy` | `rows` \| `localStorage` \| `none` | 仅 `first-run` 记录：旧数据探测的结论来源（诊断用） |
| `adoptedOldData` | `true` \| `false` | 仅 `guest`：这个空间是否认领了历史库 `earthonline` |
| `userId` / `spaceKey` | — | **仅 `user`**；`guest` 记录里出现即视为损坏（游客不得关联云端身份） |

**已删除字段：`pendingSwitch`。** 它只服务于已撤销的 `guest ⇄ legacy` 指针切换（原三态设计的 §3.7.2）。两态模型下：
- `guest → user` 的中间态由**迁移状态机** `earthonline.migration.v1`（§3.6）表达，不需要 `pendingSwitch`；
- `user → guest` 是**单次原子写**（§3.4），不需要两阶段；
- 不得为了「将来可能用到」而保留该字段——含义不清的历史字段会让实现者误以为还有第三种空间。

其他规则：

1. **只写这一个键**。旧键 `sessionStorage['earthonline-space']` 仅在首次升级瞬间读取一次，随后删除（§9.4）。
2. 记录损坏 / 字段不全 / `space` 非法 / `guest` 带 `userId` → **不直接判 guest**：先把原值备份到 `earthonline.space.broken`，再走 §3.2 的首次初始化（探测 + 判定），必要时进阻断页。**禁止**「损坏即 guest」。
3. **不存任何 token、cookie、验证码**。会话只在 HttpOnly Cookie 里。
4. 记录里**不含明文邮箱**，只有掩码。
5. **记录合法时不探测**：`space` 与 `dbName` 通过 §1.5 校验后直接用，不再跑旧数据探测。这条同时保证「一次探测不会覆盖已生效的身份」（§3.2.3 第 7 条）。
6. `dbName` 无法通过校验时，`OLIdentity.dbName()` 返回 `null`，由启动流程进阻断页；**不得**回落到某个默认库名（回落 = 用猜出来的身份打开别人的/空的库）。

### 1.5 库名规则（含「认领」）

| space | dbName | 何时产生 | 说明 |
|---|---|---|---|
| `guest` | `earthonline-guest` | 首次启动确认本机无旧数据（`detectedBy:'none'`） | 新装用户；游客库六表 schema 与 user 库完全一致 |
| `guest` | `earthonline` | 首次启动探测到旧版数据（`adoptedOldData:true`） | **原地认领**：不复制、不改名、不删除，旧数据立刻成为游客空间的数据。`earthonline` 从此只是这个 guest 空间的库名 |
| `user` | `earthonline-u-<spaceKey>` | 登录成功（§3.3） | 每个账号一个库；换设备各自独立，云端只做备份 |

```js
// 伪代码；同步字符串判定，不引入异步
function resolveDbName(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (rec.space === 'guest') {
    if (rec.dbName === 'earthonline-guest') return 'earthonline-guest';
    if (rec.dbName === 'earthonline' && rec.adoptedOldData === true) return 'earthonline';
    return null;                                   // 不猜，交给阻断页
  }
  if (rec.space === 'user') {
    if (/^earthonline-u-[a-z0-9]{16}$/.test(rec.dbName || '')) return rec.dbName;
    return null;
  }
  return null;
}
```

`db.js` 的 `resolveDbName()` 改为：拿不到合法库名 → 抛 `identity-unknown`，**不打开任何库**、**不回落 `earthonline`**。

> 与旧版的差别：旧版「非法库名 fail-closed 到 `earthonline-guest`」看起来安全，实际会用一个空游客库掩盖「本机可能有别人的数据」。两态模型改成显式阻断。

### 1.6 「旧版数据」的正确说法

| 说法 | 是否成立 | 说明 |
|---|---|---|
| 「旧版数据库 `earthonline`」 | ✅ | 一个物理库，升级前所有数据都在这里 |
| 「旧版 localStorage `earthonline-v4`」 | ✅ | 无 IndexedDB 时代的存储 |
| 「`OLMigrate` / `legacy.js` / `bootLegacy()`」 | ✅ | 数据兼容层代码；`bootLegacy()` 是「无 IDB 时的降级渲染」，与空间无关 |
| 「legacy 空间 / 旧数据空间」 | ❌ | 已撤销；用户可见文案里不得出现 |
| 「切换到旧数据空间」 | ❌ | 已撤销；没有可供切换的第二个本机空间 |
| 「`legacy → guest` / `guest → legacy`」 | ❌ | 不再是状态机里的边 |

---

## 2. 启动决策树

```
startBoot()
 ├─ 读 identity 记录（earthonline.space.v2）
 │   ├─ 合法 → 按 space 分支（**不探测**，§1.4 规则 5）
 │   ├─ 缺失 / 损坏 → 首次初始化（§3.2）
 │   │     ├─ 探测 has-data → 认领 earthonline → 写 guest 记录 → 按下面 guest 分支启动
 │   │     ├─ 探测 empty    → 写 guest 记录（earthonline-guest）→ 建库种子 → bootGuest()
 │   │     └─ 探测 unknown  → **阻断页**：不写记录、不建库、不打开任何库，提供重试
 │   └─ 合法但 dbName 打不开 → 阻断页（库被删/被浏览器阻止），提供「重试 / 登录（user 态）」
 ├─ space=guest + dbName='earthonline-guest' → bootGuest()
 │     （零 /api 请求；不查会话；不读 user 库；不触发任何迁移）
 ├─ space=guest + dbName='earthonline'（认领）→ OLMigrate.status()
 │     ├─ idb   → bootFromIdb()
 │     ├─ 有旧 localStorage 未迁 → tryMigrate()（现有行为，属于兼容迁移，不是空间迁移）
 │     └─ 其它  → 现有 boot.js 的迁移分支，行为不变
 │     （同样零 /api 请求；"不触发迁移"指的是不触发 guest → user 的空间迁移）
 └─ space=user  → 先开本机 user 库（离线可用）→ 并行 GET /api/auth/session
       ├─ 200 → 记 lastVerifiedAt → 正常启动 + 云端备份
       └─ 401 → **仍进用户空间**，进入「离线/过期」态：
                可读可写本地，云备份暂停，常驻标识显示「用户空间 · 离线」
 任何致命异常 → 全屏阻断页（重试 / 说明），不进入任何空间
```

要点：

- **游客分支不发起任何网络请求**（I4）。
- **会话过期不等于锁死本地数据**：用户仍能用自己的数据，只是不备份。
- 首屏不等待会话校验：先 `bootFromIdb()` 渲染，再异步校验并更新状态（避免弱网白屏）。
- **探测只在记录缺失/损坏时发生**，且结果立刻落盘；此后每次启动只读记录。
- **探测本身不写业务数据**：只 `get`/`count`，不 `put`、不改 `meta`、不触发迁移；唯一的写操作是把判定结论写进 identity 记录（且只在 `has-data` / `empty` 两种确定结论下写）。
- **不允许「无记录就先建空游客库」**：必须先有结论（§3.2），否则就是用空空间掩盖旧数据（I8）。

---

## 3. 空间生命周期

### 3.1 身份状态图（只有两个节点）

```
                    ┌──────────────── 首次启动（无 identity 记录 / 记录损坏）────────────────┐
                    │  旧版数据探测                                                        │
                    │    has-data → guest（认领 earthonline，库原地不动）                    │
                    │    empty    → guest（新建 earthonline-guest）                         │
                    │    unknown  → 阻断页：不写 identity、不建库、不进入任何空间              │
                    └───────────────┬──────────────────────────────────────────────────────┘
                                    ▼
                          ┌───────────────────┐   登录（邮箱验证码）   ┌───────────────────┐
                          │       guest       │ ───────────────────▶ │       user        │
                          │  本机游客数据       │                      │ 本机用户数据+云端备份 │
                          └───────────────────┘ ◀─────────────────── └───────────────────┘
                                    退出登录（只改身份指向，不搬数据）

     `guest → user` 上可能挂一个**数据动作**（复制迁移，须用户确认，§3.6），
     但它不是状态边的一部分：不迁移也照样能从 guest 进入（空的）user 空间。
```

**不存在**的节点与边：`legacy`、`∅ → legacy`、`legacy → guest`、`guest → legacy`、`legacy → user`。
**不存在**「切换空间」这个动作：两态之间只有「登录」与「退出登录」。

### 3.2 首次启动与旧版数据识别（决策 B）

触发条件：identity 记录**缺失或损坏**（记录合法时一律不探测）。

#### 3.2.1 探测：三步独立取证

| 证据 | 取法 | 强度 |
|---|---|---|
| **A · 旧库内容** | 打开 `earthonline`，六张业务表任一 `count() > 0`，或 `meta` 存在 `schemaVersion` / `migration` 行 | 强（结构化事实） |
| **B · 旧存储** | `localStorage['earthonline-v4']` 能 `JSON.parse` 且含可识别顶层字段（`v` / `tasks` / `settings` 任一） | 弱（交叉验证） |
| **C · 不可用** | 打开失败 / 被 `versionchange` 阻塞 / 超时 / 抛异常 / 无 IndexedDB | 结论为「无法确定」 |

判定表（自上而下，先命中先返回）：

| A | B | `verdict` | 后续动作 |
|---|---|---|---|
| 有数据 | 任意 | `has-data` | 认领 `earthonline` 为游客空间（§3.2.2-B） |
| 空 | 有数据 | `has-data` | 同上，并由既有 `tryMigrate()` 把 localStorage 数据迁入该库 |
| 空 | 空 | `empty` | 新建空游客空间 `earthonline-guest`（§3.2.2-A） |
| 无法确定 | 任意 | `unknown` | **阻断**，不写记录、不建库（§3.2.4） |
| 无 IndexedDB | 任意 | `unknown` | **阻断**（若 `earthonline-v4` 有数据，额外给「兼容模式」入口，见 §3.2.4） |

**明确不作为证据**：`localStorage['earthonline-v4-migrated']`（`migrate.js:28`）。它只是迁移完成标记，用户清 localStorage 会留库、清库会留标记，两个方向都会误判。它仍可被 `OLMigrate.status()` 读取用于**迁移**判定，但不参与**空间身份**判定。

实现约束：

1. `indexedDB.open('earthonline')` 在库不存在时会**创建一个空库**。因此先用 `indexedDB.databases()`（支持的浏览器）判断存在性；不支持时才 open，且判定为空后**不删这个空库**（删库会与其它标签页竞争，空库无害）。
2. 探测**必须带超时**（1500ms）。`open` 被其它标签页的 `versionchange` 卡住时不会抛错，只会一直 pending——超时按 `unknown`。
3. 探测**只读**：不调 `OLMigrate.status()/run()`、不读写 `earthonline-v4`、不写 `earthonline` 的任何表、不触发备份。
4. 结论带 `detectedBy: 'rows' | 'localStorage' | 'none'`（仅诊断）；`unknown` 不写记录，只在控制台/诊断面板留痕。
5. **探测只在记录缺失/损坏时执行**，且只执行一次。
6. 探测**不得**返回空间身份。它只返回 `{verdict, detectedBy, counts?}`；把 `verdict` 映射成「用哪个库、写什么记录」是 §3.2.2 的职责。

#### 3.2.2 三种结论的处置

**A. `empty`（确认没有旧版数据）**

1. 写 identity：`{space:'guest', dbName:'earthonline-guest', origin:'first-run', detectedBy:'none', adoptedOldData:false}`。
2. `OLGuest.prepare()` 建库 + 幂等种子（现状逻辑不变）。
3. 进 `bootGuest()`。

**B. `has-data`（识别到旧版数据）**

1. 写 identity：`{space:'guest', dbName:'earthonline', origin:'first-run', detectedBy:'rows'|'localStorage', adoptedOldData:true}`。
2. **不复制、不改名、不删除**旧库；直接把 `earthonline` 当作游客空间的数据载体打开。
3. 走既有 `OLMigrate.status()`：若 localStorage 里还有未迁移数据则 `tryMigrate()`（这条路径今天就有），否则 `bootFromIdb()`。
4. 用户在设置页看到的仍然是「游客空间」，副标题「数据只保存在这台设备」。**不出现「旧数据空间」概念**。
5. 该 guest 空间可以随时登录（§3.3），迁移时源库就是 `earthonline`。

> 为什么用「认领」而不是「复制到 `earthonline-guest`」：
> 复制会让首次启动变成一次数据迁移（要事务、要校验、要断点恢复），失败就是「用户开不了应用」；
> 认领是零数据动作，旧数据立刻可用，且不产生第二份副本。代价是 guest 空间有两个可能的库名，
> 这个代价被 `adoptedOldData` 显式记录，不靠猜。

**C. `unknown`（无法确定）**

1. **不写 identity、不建库、不打开任何库**。
2. 进阻断页（§3.2.4），提供「重试」。
3. 明确**不提供**「跳过探测、直接新建游客空间」的一键按钮——那正是「用看起来正常的空空间掩盖旧数据」。

#### 3.2.3 边界情形

| 情形 | 结果 |
|---|---|
| 1. 清了 localStorage、库还在 | 证据 A 命中 → `has-data` → 认领，身份记录重建 |
| 2. 库被清、localStorage 还在 | 证据 B 命中 → `has-data` → 认领（空库）→ `tryMigrate()` 把旧数据迁进来（现有行为） |
| 3. 两者都被清 | `empty` → 新建 `earthonline-guest` |
| 4. 隐私模式 / 存储被禁 / 无 IndexedDB | `unknown` → 阻断页 |
| 5. 另一个标签页正开着 `earthonline` | 探测不带版本 → 同版本直接连通；遇 `blocked` → `unknown` |
| 6. 记录合法（用户已在某空间） | **不探测**；哪怕库里还有别的数据，也尊重记录（§1.4 规则 5） |
| 7. 记录损坏但本机存在 `earthonline-u-*` 库 | **阻断页**，提示「本机有已登录账号的数据」：主行动「登录后继续」，次行动「以游客身份继续（会新建空游客空间，账号数据在登录后仍可恢复）」 |
| 8. 记录损坏、探测 `has-data`、但本机也有 `earthonline-u-*` | 同第 7 条：先阻断，由用户选；不得自动在两者间挑一个 |
| 9. 探测过程中用户刷新页面 | 无记录 → 重新探测（幂等，只读）；不会产生半成品记录 |

> 第 7/8 条的存在理由：identity 损坏时，如果直接新建游客空间，用户会看到「空的游客空间」，
> 而他真正的数据在自己的 user 库里。阻断 + 引导登录，比「看起来正常」更诚实（I8/I10）。

#### 3.2.4 阻断页（`identity-unknown`）

适用：探测 `unknown`、库打不开、identity 损坏且无法安全判定、`dbName` 校验失败。

| 元素 | 内容 |
|---|---|
| 标题 | 「暂时无法确认这台设备上的数据」 |
| 说明 | 「为了不覆盖或隐藏你已有的记录，应用先停在这里。你的数据没有被改动。」 |
| 技术细节（可折叠） | `reason`（`detect-timeout` / `db-blocked` / `identity-corrupt` / `db-unreadable`） |
| 主行动 | 「重试」→ 重新走 §3.2（记录仍缺失时才重新探测） |
| 次行动 | 仅当 `localStorage['earthonline-v4']` 可解析时：「以兼容模式打开（不建库，使用浏览器本地存储）」 |
| 禁止 | 「跳过、直接开始使用」这类会创建空游客空间的按钮 |
| 标识 | 常驻标识显示「身份未确认」（§7.4），**不得**显示「游客空间」 |

> 「以兼容模式打开」沿用现有 `bootLegacy()` 渲染路径（读 `earthonline-v4`），**不写 identity**，
> 因此每次启动仍会经过阻断页；它是逃生通道，不是第三种空间。是否保留该入口见 §11 待确认项。

### 3.3 登录（`guest → user`，决策 C）

```
1. 游客空间点「登录地球online」→ 邮箱 → 验证码（§4）
2. 服务端返回 {userId, spaceKey, emailMasked} + Set-Cookie
3. 定位目标库 earthonline-u-<spaceKey>，判断本机是否已有该用户的 user 数据
   ├─ 已有数据 → 直接进入（本地优先），**不询问迁移、不合并**（决策 E 第 2/6 条）
   │     提示：「这台设备上已有该账号的数据，已直接进入；游客空间的数据仍在游客空间。」
   └─ 库里没有数据 → 进入第 4 步（是否新建 + 是否迁移游客数据）
4. 云端检查（新库才做）
   ├─ status 有 pointer → 询问「发现云端备份，是否恢复到这台设备？」
   │     恢复走 §6.3（暂存库 + 快照 + 两阶段），**绝不自动覆盖本地**
   └─ 无 pointer → 直接建库
5. 游客数据迁移询问（仅在「本机 user 库为空」且「游客库有用户改动」时出现，§3.6）
   ├─ 迁移 → 复制 → 校验 → 上传 → 激活（全部成功才切换身份）
   └─ 不迁移 → 直接进入空的 user 空间；游客库原样保留
6. 写 identity（user 记录）→ location.replace → 新空间按正常启动路径初始化
```

硬规则：

1. **提交点是写 identity**，不是上传成功；但按决策 C 第 7 条，**上传成功是允许写 identity 的前置条件**（`stage=uploaded` 之后才进 `activating`）。
2. 任何一步失败都**停在 guest**，本地数据一个字节不动。
3. 用户拒绝迁移，游客数据完整保留，且**不得**在后续任何时点自动并入 user 空间（决策 E 第 6 条）。
4. 已存在 user 数据时**不提供迁移入口**：guest → 非空 user 的复制是「合并」，而合并语义没有被设计过，也不是产品承诺。
5. 不同账号各自库名不同，登录 B 不会看到 A 的任何本地数据。
6. **云端恢复与游客迁移同时适用时**（新设备、云端有备份、游客库有改动）：先处理恢复；恢复成功后 user 库非空，按第 4 条**不再询问迁移**；用户拒绝恢复则 user 库为空，可继续询问迁移。二者不得并行写入同一个库。

### 3.4 退出登录（`user → guest`，决策 D）

```
[设置页] 点「退出登录」
  1. 置 loggingOut=true（内存闸门）：拦新写入的云端上传与备份，提示「正在退出」
  2. POST /api/auth/logout（10s 超时）→ 结果三态：
       revoked   → 服务端已吊销
       failed    → 4xx/5xx（服务端未确认）
       offline   → 网络不可达 / 超时
  3. 分支
       revoked → 写 identity {space:'guest', dbName:<本机游客库>, origin:'logout'} → reload（按 §2 的 guest 分支启动）
       failed / offline →
           主行动「重试」
           次行动「只退出本机（不推荐）」→ 写 identity guest + 写 earthonline.logout.v1 {at, serverRevoked:false}
                                            → reload → guest 设置页常驻一条「上次退出未在服务器完成 [重试撤销]」
  4. 任何分支都**不删除** earthonline-u-<spaceKey> 库，也不改动 guest 库
```

要点：

1. **区分「本地退出」与「服务端会话撤销」**：本地切到 guest 不等于服务端会话已失效。UI 必须分开表述，不得用「已退出登录」笼统覆盖 `failed` / `offline`。
2. **不允许先切本地、再慢慢撤销**：先撤销（或用户显式选择「只退出本机」）再切身份，避免出现「本地已 guest、cookie 还能读云端」的窗口。
3. `guest` 恢复的库名：**退出后回到退出前的那个游客库**（`earthonline` 或 `earthonline-guest`，取自 `earthonline.guest.lastDb` 诊断键，缺省 `earthonline-guest`）。退出**不搬运** user 数据（I9）。
4. 常驻标识与卡片在退出过程中显示「正在退出…」，失败后显示「退出未完成」，不得显示正常 user 态。
5. 公共设备：设置页另提供「删除本机此账号的数据」（二次确认 + 输入邮箱确认），与「退出登录」是两个动作。

#### 3.4.1 「补撤销上次退出」（I4 的唯一例外）

仅当 `earthonline.logout.v1.serverRevoked === false` 且用户**显式点击**时，guest 态才允许发一次 `POST /api/auth/logout`：

- 成功 → 删除 journal，提示「已撤销服务器会话」；
- 失败 → 保留 journal，提示稍后重试；
- 该请求**不带任何业务数据**，不读取备份，不上传；
- 除这一条外，guest 态不得出现任何 `/api/*` 调用（测试用例见 §3.9 第 9 条）。

### 3.5 再次登录（决策 E）

```
1. 验证码登录 → 拿到 userId / spaceKey
2. 本机 earthonline-u-<spaceKey> 是否存在且有业务数据？
   ├─ 是 → 本地优先：直接进入（不询问、不覆盖、不恢复）
   │        常驻标识显示「用户空间」；若云端 pointer 更新 → 只在卡片上提示「云端有更新的备份」，
   │        由用户主动点「查看并恢复」（§6.2 判定表）
   └─ 否 → 新设备/新库：检测 pointer
            ├─ 有备份 → 询问恢复（§6.3）
            └─ 无备份 → 建库种子
3. 无论哪种：**不得**把 guest 数据自动带进来；**不得**展示其他账号的任何数据
4. 冲突（本地有数据且云端也有更新的备份）→ **不自动处理**；只在卡片提示，用户点「查看并恢复」后才进 §6.2 的冲突面板
```

### 3.6 迁移状态机（`guest → user`，决策 C 第 5–8 条）

持久化位置：`localStorage['earthonline.migration.v1']`（**单一进行中任务**）

```jsonc
{
  "v": 1,
  "id": "mig_01J...",            // 幂等键，写入目标库 meta
  "from": "guest",               // 恒为 guest；不存在其他来源
  "fromDb": "earthonline",       // 或 earthonline-guest
  "toUserId": "u_01J...",
  "toDb": "earthonline-u-7f3a...",
  "stage": "copying",
  "attempt": 1,
  "startedAt": "...", "updatedAt": "...",
  "counts": { "tasks": 3, "dayEntries": 42 },
  "payloadHash": "sha256:...",
  "cloudRevision": null,
  "lastError": null
}
```

| stage | 动作 | 失败后果 | 恢复方式 |
|---|---|---|---|
| `prepared` | 校验源库可读、目标库为空或已带同一 `importId` | 中止 | 重新点迁移 |
| `copying` | `rehydrate(源)` → `buildRows()` → 目标库单事务写入六表（**不含** migration/writer/bizRev） | 事务回滚，目标库仍空 | 从 `copying` 重试（先清目标库同 importId 行） |
| `copied` | 逐表计数比对（源 vs 目标） | 计数不符 → 不继续 | 重试复制 |
| `verifying` | 抽样重水合 + `payloadHash` 比对 | 不符 → paused | 重试 |
| `uploading` | 用目标库数据生成备份，PUT object → PUT pointer | 网络/R2 失败 → paused（**本地完整，停在 guest**） | 重试上传 |
| `uploaded` | 记录 `cloudRevision` | — | — |
| `activating` | **写 identity 记录**（唯一提交点） | 写失败 → paused | 重试写 |
| `done` | 清迁移记录，reload 进用户空间 | — | — |

六条硬规则：

1. **复制而非移动**：源库只读，永不删除（I5）。用户想清理游客数据，去设置页单独点「清空游客数据」。
2. **提交点是写 identity**，但**必须 `stage=uploaded` 之后**才允许（决策 C 第 7 条）。上传成功后崩溃 → 下次启动检测到 `stage=uploaded`，补写 identity 即可（幂等）。
3. **目标库写入必须带 `meta.importId`**：`OLMigrate.buildRows()` 不产生 migration 行，由迁移器补一行 `{key:'import', value:{id, at}}`（属于 infra key，需扩 `META_KEYS`）；重试时若发现 `import.id` 不同 → 拒绝写入。
4. **不做自动清理**：迁移完成后游客数据保留，直到用户主动清空；UI 明确写「游客空间的数据还留着」。
5. **失败三出口**：重试 / 放弃迁移并进入空 user 空间（清掉本 importId 的行与迁移记录，源库不动）/ 回到 guest 继续用。三者都不删源数据。
6. **迁移任务存在时**：启动先处理它（继续 / 放弃），不得在 `stage !== 'done'` 时让用户直接进入该 user 库，避免「半迁移库被当成正常库」（T19）。

#### 3.6.1 迁移的幂等与断点

| 中断点 | 现象 | 下次启动 |
|---|---|---|
| 复制一半 | 目标库有部分行 | `stage=copying` → 删除本 importId 的行后重来 |
| 复制完成、未校验 | `stage=copied` | 直接进 `verifying` |
| 上传成功、未激活 | `stage=uploaded` + `cloudRevision` | 比对云端 pointer.revision 一致 → 补写 identity |
| 激活后崩溃 | identity 已写 | 正常进用户空间；迁移记录清理掉 |
| 用户中途关页面 | 记录停在任意 stage | 下次启动弹「有一次未完成的迁移，继续 / 放弃」；**放弃 = 删迁移记录 + 清目标库本 importId 行，不动源库** |

### 3.7 四件事不是同一个操作

| 层 | 发生时机 | 是否改本地业务数据 | 是否联网 | 失败时的状态 |
|---|---|---|---|---|
| **身份状态转换** | 登录成功 / 退出成功 / 首次判定 | 否 | 登录必联网；退出以服务端结果为准 | 停在原身份，不半途切换 |
| **数据复制（迁移）** | 用户在登录后确认 | **是**（复制到目标库） | 是（复制完必须上传） | 停 guest，源库完整，目标库可清理 |
| **云端恢复** | 新设备登录 / 用户主动点恢复 | 是（替换 user 库，带快照） | 是 | 当前库不变（暂存库 + 快照） |
| **服务端 session 生命周期** | 登录 / 每次启动校验 / 退出 | 否 | 是 | 本地仍可用（过期态），云备份暂停 |

任何文档、UI 文案、日志都不得把上述四件事统一称为「切换失败」或「同步失败」。

### 3.8 异常恢复路径总表（R1–R17）

| # | 失败点 | 用户看到 | 数据后果 | 恢复动作 |
|---|---|---|---|---|
| R1 | 旧数据探测超时 | 阻断页「暂时无法确认」（`detect-timeout`） | 无 | 重试；不写身份、不建库 |
| R2 | 探测结论不确定（open 被阻塞/异常） | 同上（`db-blocked`） | 无 | 重试 / 兼容模式（仅当 v4 可解析） |
| R3 | 旧版库打不开（被删/被浏览器阻止） | 同上（`db-unreadable`） | 无 | 重试；user 态另给「登录」出口 |
| R4 | 首次升级中断（写 identity 前崩溃） | 下次启动重新探测 | 无（旧库未被写） | 自动幂等 |
| R5 | 写 identity 失败（配额/隐私模式） | 「没能保存这台设备的选择」 | 无 | 重试；不进入任何空间 |
| R6 | 认证失败（码错/过期/限流/网络） | 登录面板内错误提示 | 无（仍在 guest） | 重发 / 重试 |
| R7 | 迁移复制失败（事务回滚） | 「迁移没开始，本地数据没动」 | 目标库 0 行 | 重试迁移；源库不动 |
| R8 | 复制完成但目标库校验/写入失败 | 「迁移没完成，本地数据没动」 | 目标库有残留（带 importId） | 重试（清残留重来）/ 放弃 |
| R9 | user 库已建成但云端备份失败 | 「本地已就绪，备份没成功」 | 本地完整，**身份未切换**（停在 guest） | 重试上传；或放弃迁移进空 user 库 |
| R10 | 退出登录时网络断开 | 「没能安全退出，请检查网络」+ [重试] [只退出本机] | 无 | 重试；选「只退出本机」则记 journal |
| R11 | 服务端 session 撤销失败（4xx/5xx） | 同上 | 无 | 重试；journal 记录未撤销 |
| R12 | 页面刷新/关闭发生在登录或退出中途 | 按 identity 真实值启动 | 无（登录未提交则仍 guest；退出未提交则仍 user） | 迁移看 §3.6.1；退出重新点 |
| R13 | 多标签页同时登录/退出 | 非当前标签转只读横幅「身份已变化，需要刷新」 | 无（各标签仍连自己的库） | 用户刷新 |
| R14 | 同一设备切换不同用户 | 各自库/前缀；旧标签只读 | 无 | 刷新 |
| R15 | 再次登录恢复原 user 数据 | 直接进入，条数一致 | 无 | — |
| R16 | guest 与 user 隔离验证 | — | 无跨库复制路径 | 见 §3.9 第 5/6 条 |
| R17 | 本地 user 数据与云端备份冲突 | 冲突面板（时间/条数/设备） | 不自动覆盖 | 用户选；覆盖前先本地快照 |

**故障分型（不得合并表述）**：

| 类型 | 对应 | 判定依据 |
|---|---|---|
| 认证失败 | R6 | 服务端 4xx / 码无效 / 无会话 |
| 本地身份状态写入失败 | R5、R12 | `localStorage.setItem` 抛错或读回不一致 |
| 数据迁移失败 | R7、R8、R9 | 事务失败 / 计数或哈希不符 / 上传失败 |
| 云端备份失败 | R9、R17 | R2 5xx / CAS 冲突 / 网络 |
| 服务端会话撤销失败 | R11 | `POST /api/auth/logout` 非 2xx 或超时 |

### 3.9 验收标准

1. 首次启动：`has-data` / `empty` / `unknown` 三支逐支可复现；`detectedBy` 落盘正确；`unknown` 时不产生 identity 记录、不新增任何库。
2. 认领路径：`earthonline` 的行数、`meta` 在升级前后**逐字节一致**（零写入）；identity 为 `{space:'guest', dbName:'earthonline', adoptedOldData:true}`。
3. 记录合法时**永不探测**：手工把 `earthonline` 填满数据、identity 指向 `earthonline-guest`，启动仍进 guest 且探测调用次数为 0。
4. `guest → user`：登录后 identity 为 user；`earthonline` / `earthonline-guest` 行数不变。
5. `user → guest`：退出后 identity 为 guest；`earthonline-u-*` 行数不变；guest 库行数不变。
6. 隔离：guest 与 user 两库同时存在时，任一侧写入不影响另一侧；无任何跨库复制代码路径（迁移除外，且迁移只读源库）。
7. 迁移：42 条 → 用户库 42 条、逐条相等、源库仍 42 条；`uploaded` 前不得写 identity。
8. 迁移中断：`copying` 中断 → 目标库 0 行；`uploaded` 中断 → 重启补写 identity 且不重复复制。
9. 退出：`revoked` 分支 3 秒内完成；`offline` 分支不切身份（或用户显式「只退出本机」后写 journal）；guest 态除「补撤销」外无 `/api/*` 请求（可用网络桩断言 0 次）。
10. 再次登录：本机已有 user 数据 → 直接进入且不弹迁移；新设备 → 只提示恢复，不自动执行。
11. 阻断页：`unknown` / `identity-corrupt` 下不出现「跳过并开始使用」；常驻标识显示「身份未确认」。
12. 同一设备 A/B 两账号：A 写 3 条，切 B 看不到；切回 A 仍在。

### 3.10 五个必答问题（两态模型）

| 问题 | 结论 | 依据 |
|---|---|---|
| 旧数据会不会因为「没有第三态」而丢失？ | 不会。首次升级识别到旧数据即**原地认领**为游客空间，零复制零改名；探测不确定时阻断而不是新建空库 | §3.2、I8 |
| 登录会不会把游客数据自动带走？ | 不会。只有用户显式确认才复制；拒绝则永不合并 | §3.3、§3.6、I9 |
| 退出会不会删本地数据？ | 不会。只改身份指向；user 库保留，guest 库原样 | §3.4、I5 |
| 退出后服务端会话还活着怎么办？ | 本地/服务端结果分开记录；失败不假装成功，给「重试 / 只退出本机 + 补撤销」 | §3.4、R10/R11 |
| 两个空间的数据会不会串？ | 不会。不同库名、不同 localStorage 命名空间、不同 R2 前缀；没有同页切库 | §1.1、§9.2、I2 |

---

## 4. 认证：邮箱验证码（方案 A）

*本节与收敛前版本一致，未因两态收敛而改变。*

### 4.1 为什么需要 D1

| 方案 | 能否满足 | 结论 |
|---|---|---|
| 纯 KV | 验证码/会话可存，但**无事务**、无唯一约束、最终一致 | ❌ 会话吊销、验证码一次性难以保证 |
| Durable Objects | 强一致、可按用户串行 | ✅ 但成本/复杂度高，本期不需要 |
| **D1** | SQL、事务、唯一索引、按行计费、可 Time Travel | ✅ **选它** |
| R2 当数据库 | 无查询、无事务 | ❌ 只放备份 |

需要 D1 存四类数据：`users` / `email_codes` / `sessions` / `rate_limits`（+ 可选 `audit_log`）。

### 4.2 表结构（DDL）

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,                 -- u_<ulid>
  email         TEXT NOT NULL,                    -- 归一化小写
  email_norm    TEXT NOT NULL,
  space_key     TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'active',   -- active | disabled | pending_delete
  created_at    INTEGER NOT NULL,
  email_verified_at INTEGER,
  last_login_at INTEGER
);
CREATE UNIQUE INDEX idx_users_email ON users(email_norm);

CREATE TABLE email_codes (
  id          TEXT PRIMARY KEY,
  email_norm  TEXT NOT NULL,
  purpose     TEXT NOT NULL,                      -- login | change_email | delete_account
  code_hash   TEXT NOT NULL,                      -- SHA-256(code|email|pepper)
  attempts    INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  ip_hash     TEXT
);
CREATE INDEX idx_codes_email ON email_codes(email_norm, purpose, created_at DESC);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at    INTEGER,
  ua_hash       TEXT,
  ip_hash       TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id, revoked_at);

CREATE TABLE rate_limits (
  bucket       TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
```

**成本约束下的写法**：每个请求最多 3–5 条 SQL（Free 计划单次 invocation 上限 50 条）。`last_seen_at` 每小时最多更新一次。

### 4.3 验证码规则

| 项 | 值 | 理由 |
|---|---|---|
| 形态 | 6 位数字，`crypto.getRandomValues` + 拒绝采样 | 好输入，不可预测 |
| 有效期 | 10 分钟 | 够用且窗口短 |
| 尝试次数 | 5 次，超限即作废 | 命中率 5/10⁶ |
| 一次性 | 验证成功即 `consumed_at` | 防重放 |
| 同邮箱 | 5 次/小时，60 秒冷却 | 防轰炸 |
| 同 IP | 20 次/小时（哈希后存储） | 防扫描 |
| 存储 | 只存 `code_hash`，**不存明文** | 库泄露不等于验证码泄露 |
| 响应 | 无论邮箱是否存在，都返回 `202 {ok:true}` 与同一 `resendAfter` | 防枚举 |
| 发信失败 | 记 `audit_log`，对用户仍返回 202，仅响应头带 `X-Email-Status: queued` | 不泄露基础设施状态 |

### 4.4 会话与 Cookie

**推荐部署形态：API 与站点同源**（`https://<站点域>/api/*` 由 Worker 路由接管）。此时：

```
Set-Cookie: __Host-eo_sess=<32B base64url>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000
```

| 属性 | 值 | 理由 |
|---|---|---|
| 前缀 | `__Host-` | 强制 Path=/、Secure、无 Domain，防子域注入 |
| HttpOnly | 是 | XSS 读不到 token |
| SameSite | `Lax` | 跨站 POST 不带 cookie，配合 Origin 校验防 CSRF |
| Secure | 是 | 仅 HTTPS |
| 有效期 | 30 天滑动 / 90 天绝对 | 日常不回登录，但泄露的会话不会永久有效 |

若被迫跨站（站点在 A 域、API 在 `*.workers.dev`）：`__Host-` 不可用，只能 `__Secure-eo_sess; SameSite=None`，而 **Safari ITP / Chrome 第三方 Cookie 限制会导致登录态失效**。因此**必须**让 API 同源，方案见 §7.5。

会话写入：每次登录生成新 token（旧 token 不自动吊销，支持多设备）；`POST /api/auth/logout` 吊销当前；`logout-all` 吊销全部；改邮箱等敏感操作 → 吊销其它设备。

### 4.5 API 契约

| 方法 | 路径 | 请求 | 成功响应 | 失败 |
|---|---|---|---|---|
| POST | `/api/auth/code` | `{email}` | `202 {ok:true,resendAfter:60}` | 429 `rate-limited`；400 `bad-email` |
| POST | `/api/auth/verify` | `{email,code}` | `200 {ok:true,user:{id,spaceKey,emailMasked}}` + Set-Cookie | 400 `code-invalid`/`code-expired`/`code-consumed`；429 `too-many-attempts` |
| GET | `/api/auth/session` | — | `200 {ok:true,user:{...},expiresAt}` | 401 `no-session`/`expired` |
| POST | `/api/auth/logout` | — | `204` | 401 |
| POST | `/api/auth/logout-all` | — | `200 {ok:true,revoked:N}` | 401 |
| PATCH | `/api/account/email` | `{email,code}` | `200 {ok:true}` | 400/409 `email-in-use` |
| DELETE | `/api/account` | `{code}` | `200 {ok:true,graceDays:7}` | 401/400 |

统一错误体：`{ok:false,error:'<code>',message:'<人类可读>'}`；**不返回内部细节**。

### 4.6 多设备 / 邮箱变更 / 注销

- **多设备**：同一 userId 可存在 N 个 session；设置页「已登录设备」可列出并单独吊销。
- **邮箱变更**：`purpose='change_email'`，验证码发到**新邮箱**；变更不影响 `userId` 与 `spaceKey`（数据不动）。
- **注销**：`DELETE /api/account` → `status='pending_delete'`，**7 天宽限期**；到期由 Cron 删除 D1 行 + `users/<spaceKey>/` 前缀全部对象。本地数据库由用户选择「一并删除 / 保留」。

---

## 5. 云端隔离（R2）

*本节与收敛前版本一致，仅调整了措辞（不涉及模型）。*

### 5.1 布局

```
users/<spaceKey>/backups/v2/pointer.json
users/<spaceKey>/backups/v2/objects/<writeId>.json
users/<spaceKey>/backups/v2/quarantine/<writeId>.json   （可选：损坏备份隔离）
```

- `<spaceKey>` 由会话推导，**不接受客户端提供**（I6/I7）。
- `writeId` 由客户端生成，服务端只校验字符集 `^[a-zA-Z0-9._-]{8,80}$` 与「路径不越界」。
- 兼容旧数据：owner 现有的 `earthonline/backups/v2/*` 保持不动；提供一次性「认领」脚本（把旧前缀复制到 owner 的 `users/<spaceKey>/`），**本轮不执行**。

### 5.2 Worker 侧最小改动清单

| 位置 | 现状 | 改动 |
|---|---|---|
| `index.js:27-32` 常量 | 三个硬编码 key | 改为 `prefixOf(spaceKey)` 函数；旧常量保留给 v1 兼容端点 |
| 认证段 `:796-808` | 只认 Access JWT | 改为「会话 cookie → userId → spaceKey」；Access 保留为 `/api/admin/*` 的可选二次校验 |
| `handleV2ObjectPut` `:531-625` | 采信 `im.objectKey` | 先算 `expected = prefix + 'objects/' + writeId + '.json'`，不等 → 400 `object-key-mismatch`；存储一律用 `expected` |
| `handleV2PointerPut` `:628-745` | 固定 pointer key | pointer key 改为 `prefix + 'pointer.json'`；校验 `pointer.objectKey` 以 `prefix` 开头 |
| `handleV2Status` `:747-765` | 固定 pointer key | 同上 |
| **新增** `GET /api/backup/v2/object` | 无 | `?writeId=` → 校验前缀 → 返回 payload，`Cache-Control: no-store` |
| v1 三个端点 | 全局单对象 | 仅对 `LEGACY_OWNER_USER_ID` 开放；其它用户返回 `410 legacy-retired` |
| `V2_PROTOCOL` / CAS / 哈希校验 | 已完整 | **一行不改** |

### 5.3 权限校验顺序（每个 `/api/backup/*` 请求）

```
1. Origin 检查（有 Origin 必须等于 APP_ORIGIN）
2. 会话 cookie → token_hash → D1 sessions（未过期、未吊销）
3. userId → spaceKey（users 表）
4. 路径前缀由 spaceKey 派生（忽略请求里的任何路径/ID）
5. 业务校验（协议头 / 哈希 / CAS / 大小）
6. 只对派生出的 key 做 R2 操作
```

第 4 步是**唯一**决定 key 的地方。

---

## 6. 备份与跨设备恢复

*本节与收敛前版本一致，仅调整了措辞（不涉及模型）。*

### 6.1 版本模型（不做实时同步）

| 概念 | 存放 | 含义 |
|---|---|---|
| `localRev` | `localStorage['earthonline.cloud.v2.<spaceKey>']` | 本机最后一次成功提交的 cloud revision |
| `cloudRev` | `pointer.revision` | 云端当前 revision |
| `localDirty` | 同上（pending 标记） | 本地有未上传改动 |
| `localExportedAt` | 备份 payload 的 `exportedAt` | 数据时间 |

### 6.2 判定表

| localRev | cloudRev | localDirty | 判定 | 行为 |
|---|---|---|---|---|
| = | = | false | 一致 | 无需操作 |
| = | > | false | **云端更新** | 提示「云端有更新的备份」→ 用户确认后恢复 |
| < | = | true | 本地更新 | 自动/手动上传 |
| 空 | 有 | — | 新设备 | 提示「发现云端备份」→ 确认恢复 |
| 有 | 空 | — | 云端被清 | 提示「云端没有备份」→ 仅可上传 |
| ≠ 且都非空 | ≠ | true | **双向分叉** | **禁止自动合并**；冲突面板（时间/条数/设备） |
| 任意 | 任意 | 恢复中 | 进行中 | 阻断新操作，提示继续/放弃 |

### 6.3 恢复流程（可中断、可回滚）

```
1. 取 status → pointer（revision / uploadedAt / payloadBytes）
2. 取 object（新端点）→ 本地校验 payloadHash / 信封版本
3. 写「暂存库」earthonline-u-<key>-incoming（单事务，六表）
4. 计数 + 哈希校验暂存库
5. 用户二次确认（展示：云端条数 / 本地条数 / 时间）
6. 本地快照：把当前库复制到 earthonline-u-<key>-bak-<ts>
7. 用暂存库数据替换当前库（单事务清空 + 写入；失败则从 bak 还原）
8. 校验当前库 == 暂存库 → 写 localRev = cloudRev → 删暂存库
9. 可选：保留 bak 24 小时，设置页可「撤销这次恢复」
```

**为什么用「暂存库 + 快照」**：IndexedDB 没有事务级 DDL，直接清空写坏就不可逆。

### 6.4 上传流程（v2）

```
1. 本地生成 payload（复用 core.js:1351 buildBackupPayload）
2. writeId = 'eo-' + ulid
3. PUT /api/backup/v2/object
4. 成功 → PUT /api/backup/v2/pointer {pointer, expected:{revision, etag}}
5. 409 cas-conflict → 重新 status，按 §6.2 判定，不盲目重试
6. 成功后写 localRev
```

失败处理沿用 `cloud-backup.js` 的「不丢 pending」原则，但**状态键按空间隔离**。

---

## 7. UI 设计

### 7.1 空间卡片（只有两态）

| 状态 | 标题 | 副标题 | 右侧 | 下方动作 |
|---|---|---|---|---|
| `guest` 新装 | 游客空间 | 数据只保存在这台设备，不上传云端。 | ⓘ | 登录地球online |
| `guest` 认领旧数据 | 游客空间 | 数据只保存在这台设备，升级前的记录都在。 | ⓘ | 登录地球online |
| `guest` 有改动 | 游客空间 | 数据只保存在这台设备，不上传云端。 | ⓘ | 登录地球online（副提示：登录后可选择迁到账号） |
| `guest` 有未完成迁移 | 游客空间 | 有一次未完成的迁移。 | ⓘ | 继续迁移 · 放弃 |
| `user` 未备份 | 用户空间 | 云端备份：尚未备份。 | ⓘ | 立即备份 · 空间管理 |
| `user` 备份中 | 用户空间 | 云端备份：正在备份… | ⓘ | （禁用按钮） |
| `user` 已备份 | 用户空间 | 云端备份：已备份 · 3 分钟前 | ⓘ | 立即备份 · 空间管理 |
| `user` 失败 | 用户空间 | 云端备份：上次失败（网络错误），本地数据已保留。 | ⓘ | 重试 · 空间管理 |
| `user` 离线/过期 | 用户空间 | 登录已过期，云端备份暂停。本地数据可正常使用。 | ⓘ | 重新登录 · 空间管理 |
| `user` 云端更新 | 用户空间 | 云端有更新的备份（另一台设备）。 | ⓘ | 查看并恢复 |
| `user` 退出中 | 用户空间 | 正在退出… | ⓘ | （禁用按钮） |

**不得出现**：「旧数据空间」「legacy 空间」「切换到旧数据空间」「检查本机是否有旧数据」「空间切换」。
卡片上只有三件事实：**当前状态 / 数据在哪 / 云备份怎么样**。

### 7.2 ⓘ 说明弹窗（全部解释性文字集中在这里）

1. **游客空间是什么**
   「不用注册就能用。数据只存在这台设备的浏览器里，不会上传，也不会和别人的数据混在一起。关掉页面、刷新、下次打开都还在。」
2. **用户空间是什么**
   「用邮箱登录后的空间。日常还是存在这台设备上，登录只是多了一层云端备份和换设备恢复。」
3. **数据保存在哪里 / 云端备份是什么**
   「本地：这台设备的浏览器（IndexedDB）。云端：项目自己的 R2 存储，只保存你最近一次成功的备份，不做实时同步。换设备时可以从云端恢复到新设备。」
4. **登录、退出、迁移的规则**
   「登录不会自动合并任何数据：如果游客空间里有东西，会先问你要不要迁过去。
     退出登录不会删除这台设备上的数据，云端也保留最近一次备份。
     迁移是**复制**，不是搬走：游客空间里的数据迁完仍然保留，你可以自己决定什么时候清空。
     同一台设备可以登录不同账号，各自的数据互相看不见。」
5. **升级说明（仅 `adoptedOldData:true` 时多一段）**
   「你升级前记录都还在，已经作为游客空间打开；没有被复制、改名或删除。」

### 7.3 交互流程

```
[游客卡片] 点「登录地球online」
  → 登录面板（Sheet）
      step1 输入邮箱 → [发送验证码]（60s 冷却，按钮倒计时）
      step2 输入 6 位码 → 自动提交或 [登录]
      错误：码错 → 抖动 + 「验证码不对，还可以试 4 次」；过期 → 「验证码过期了，重新发一个」
  → 登录成功
      ├─ 本机已有该账号数据 → toast「已进入用户空间」→ 写 identity → reload
      ├─ 本机无该账号数据 + 云端有备份 → 恢复询问面板
      │     ├─ 确认恢复 → 恢复完成（user 库非空）→ **不再询问迁移** → reload
      │     └─ 先不恢复（user 库为空）→ 可继续问迁移
      ├─ 本机无该账号数据 + 游客库有改动 → 迁移面板
      │     「游客空间里有 42 条记录。要迁到你的账号里吗？」
      │     [迁过去]（主） [先不迁，进入空账号]（次）
      │     勾选：「迁完后保留游客数据」（默认勾选且不可取消）
      └─ 都没有 → 直接进入空用户空间
  → 迁移进度（不可关闭，4 步：复制 → 校验 → 上传 → 完成）
      失败 → 「迁移没完成，本地数据没动」+ [重试] [先不迁，进入空账号] [回到游客空间]
  → 完成 → reload 进用户空间，toast「已进入用户空间」

[用户卡片] 点「空间管理」
  → 面板列表：账号邮箱（掩码）· 已登录设备 · 云端备份详情 · 从云端恢复 · 退出登录 · 删除本机此账号数据

[用户卡片] 点「退出登录」
  → 二次确认（「退出后本地数据仍然保留，下次登录可以继续用」）
  → 退出中（遮罩）
      ├─ 成功 → reload 进 guest，toast「已退出登录」
      └─ 失败 → 「没能安全退出」+ [重试] [只退出本机（不推荐）]

[任何空间] 点 ⓘ → 说明弹窗（§7.2）
```

**已删除的交互**（决策 F）：guest 卡片上的「检查本机是否有旧数据」、legacy 卡片的「切换到游客空间」、任何「切换空间」确认弹窗。

### 7.4 常驻空间标识

位置：顶栏右侧（`header` 内的固定位置），chip 形式，不参与主内容布局。

| 状态 | 文案 | 视觉 | 数据源 |
|---|---|---|---|
| guest | 「游客空间」 | 中性描边 | `identity.space === 'guest'` |
| user · 已备份 | 「用户空间」+ 云朵实心 | 强调色 | `identity.space === 'user'` + `cloud.lastResult === 'ok'` |
| user · 备份中 | 「用户空间」+ 云朵脉动 | 强调色 · 动效 ≤ 1.2s 循环 | 备份状态机 |
| user · 未备份 | 「用户空间」+ 云朵空心 | 强调色 | 无 pointer |
| user · 离线/过期 | 「用户空间 · 离线」 | 警示色 | `sessionState === 'expired'` |
| 未确认 / 阻断 | 「身份未确认」 | 警示色 · 不可点击 | 阻断页 |
| 退出中 | 「正在退出…」 | 中性 | `loggingOut` |

规则：

1. **只从 `OLIdentity.record()` 的已校验值取**。禁止读探测结果、禁止读 `sessionStorage` 残留、禁止用 HTML 里的默认文案充当状态。
2. 身份变化（登录 / 退出 / 首次判定）由整页重载自然更新；**同一标签内**备份状态变化只更新 chip 的子状态，不重排布局（避免跳动）。
3. 初始化失败、身份不确定、退出未完成时，**不得**显示「游客空间」或「用户空间」这种正常态文案（I10）。
4. 轻量约束：高度 ≤ 22px、`pointer-events: none`（`title` 提示除外）、不遮挡主内容、窄屏（≤ 360px）只显示图标 + 极短文案。
5. 可访问性：`role="status"`、`aria-live="polite"`、对比度 ≥ 4.5:1；颜色不是唯一信息载体（同时有图标或文字）。
6. 文案全部走 `U()`（`settings.space.badge.*`），不硬编码中文。

### 7.5 同源部署（决定 Cookie 能否安全）

| 方案 | 做法 | 评价 |
|---|---|---|
| **A（推荐）** | 站点与 API 同域：`https://<站点>/api/*` 由 Worker 路由接管（或 Pages Functions 反代） | `__Host-` cookie 可用；无第三方 Cookie 问题 |
| B | `api.<站点域>` 子域 | 同 site，`SameSite=Lax` 仍生效；需 `Domain=.<站点域>`，只能用 `__Secure-` 前缀 |
| C | `*.workers.dev` 跨站 | ❌ 不采用 |

> 当前 Worker 部署在 `earthonline-backup.<account>.workers.dev`（`cloud-backup.js:9`），属于 C。**上线前必须迁到 A 或 B**。

---

## 8. 完整状态机（空间维度）

| 边 | 触发 | 动数据吗 | 需确认 | 持久化 | 说明 |
|---|---|---|---|---|---|
| `∅ → guest` | 首次启动，`verdict=empty` | 否 | 否 | `space:'guest', dbName:'earthonline-guest', origin:'first-run'` | 新设备 |
| `∅ → guest` | 首次启动，`verdict=has-data` | 否（认领，零复制） | 否 | `space:'guest', dbName:'earthonline', adoptedOldData:true` | 老用户升级 |
| `guest → user` | 登录成功（+ 可选迁移） | 可选（复制） | 迁移需确认 | 写 user 记录 | §3.3 / §3.6 |
| `user → guest` | 退出登录 | 否（库保留） | 是（二次确认） | 写 guest 记录 + `origin:'logout'` | §3.4 |
| `user → user'` | 换账号 | 否 | 是（先退出再登录） | 重写 user 记录 | 两账号库互不可见 |

> `verdict=unknown` **不在本表内**：它不产生任何边，也不产生任何状态——启动停在阻断页，
> identity 记录保持「无」，可反复重试。它不是第三个空间节点。

**不存在**的边：`∅ → legacy`、`legacy → guest`、`guest → legacy`、`legacy → user`、任何 `⇄` 形式的普通切换。

三条硬规则：

- **`user` 没有「切换」出口**：离开 user 只有「退出登录」（保留本地库）。
- **任何状态都不自动删除另一空间的库**（I9）。
- **记录合法即以记录为准**：启动不再重新探测（§1.4 规则 5）。

---

## 9. 兼容与迁移（代码层面）

### 9.1 需要扩展的 meta 白名单

`db.js:59-63` 增加：

```js
import: 'infra'        // 迁移导入标记 {id, at, from}
```

### 9.2 localStorage 键命名空间

| 旧键（全局） | 新键（按空间） |
|---|---|
| `earthonline-v4-migrated` | `earthonline.migrated.<dbName>` |
| `earthonline-cloud-backup-v1` | `earthonline.cloud.v2.<spaceKey 或 guest>` |
| `earthonline-cloud-backup-lease` | `earthonline.cloud.lease.<spaceKey>` |
| `earthonline-cloud-backup-endpoint` | 保持全局（配置项，不属于数据） |
| `sessionStorage['earthonline-space']` | `earthonline.space.v2`（一次性迁移，见 §9.4） |
| —（新增） | `earthonline.logout.v1`（退出未完成的补撤销 journal） |
| —（新增） | `earthonline.guest.lastDb`（上次退出时所在的游客库名，仅用于「退出后回到原游客空间」） |

升级时读取旧键并搬到新键（一次性迁移函数，幂等）。

### 9.3 首屏与静态资源

- 登录面板、空间卡片、常驻标识文案进 `config/settings.js`（英文 key，沿用第一批建立的 `U()` 机制）。
- `identity.js` 必须在 `db.js` 之前加载（现状 `index.html:308-309` 已满足）。

### 9.4 旧身份记录兼容（`sessionStorage['earthonline-space']`）

```js
// 只执行一次：sessionStorage 的老标记 → 新的 localStorage 记录
// 关键：老标记只是「上一次这个标签页在哪个空间」的弱提示，不能覆盖旧数据判定
// 两态模型下它最多只能提供「上次是 guest」这一条弱提示，且必须被探测结论否决
var old = sessionStorage.getItem('earthonline-space');

if (!localStorage.getItem('earthonline.space.v2')) {
  var probe = detectOldData();                 // §3.2.1，返回 {verdict, detectedBy}

  if (probe.verdict === 'has-data') {
    writeRecord({ space:'guest', dbName:'earthonline', adoptedOldData:true,
                  origin:'first-run', detectedBy:probe.detectedBy });   // 老标记一律忽略
  } else if (probe.verdict === 'empty') {
    writeRecord({ space:'guest', dbName:'earthonline-guest', adoptedOldData:false,
                  origin:'first-run', detectedBy:'none' });             // old 只作诊断，不参与决策
  } else {
    // unknown：不写记录，进阻断页
  }
}
sessionStorage.removeItem('earthonline-space');
```

> 反例（不要这样做）：`if (old === 'guest') → 写 guest`。老用户曾在游客空间点过一下，
> 下次启动就直接看不到自己的本机数据——这正是「误判为空」要禁止的做法。
> 两态模型下更不能把 `old` 映射成空间身份：它连「有没有旧数据」都不能证明。

---

## 10. 变更记录（三态 → 两态）

### 10.1 撤销 / 保留对照

**旧编号 → 现编号的映射**（旧编号只保留在历史文档与本节的撤销记录里）：

| 旧 | 原内容 | 现状 |
|---|---|---|
| 决策 #1 | 首启空间判定（探测到旧数据即 `legacy`，`unknown` fail-safe 到 `legacy`） | **收敛为决策 B**（§3.2）；结论仍是「先探测再定」，但目标恒为 `guest`，`unknown` 改为阻断 |
| 决策 #2 | guest 设置页「检查本机是否有旧数据」并切换到 legacy | **入口与切换全部撤销**；只读探测能力保留在首次初始化与阻断页重试 |
| 决策 #3 | `guest ⇄ legacy` 双向主动切换 | **全部撤销**；两态之间只有登录与退出登录 |

| 原设计（三态） | 处置 | 现设计 |
|---|---|---|
| `legacy` 作为第三种空间（kind） | **撤销** | 只有 `guest` / `user`；旧数据在首次升级时被 `guest` 认领 |
| `legacy` 库名 `earthonline` 作为独立空间载体 | **重新定义** | 仍是同一个物理库，但它是 `guest` 空间的库名（`adoptedOldData:true`），不是空间类型 |
| `∅ → legacy`、`legacy → user` 边 | **撤销** | 改为 `∅ → guest`（has-data 分支）与 `guest → user` |
| `guest ⇄ legacy` 双向切换（决策 #3） | **撤销** | 不提供；两态之间只有登录/退出 |
| `pendingSwitch` 两阶段指针切换 | **删除字段与流程** | 迁移用 `earthonline.migration.v1`；退出用单次原子写 |
| `origin: 'auto' \| 'user'` 表达「怎么选的」 | **重新定义** | `origin: 'first-run' \| 'login' \| 'logout' \| 'repair'`，纯审计，不参与判定 |
| 设置页「检查本机是否有旧数据」+ 切换到 legacy（决策 #2） | **撤销入口** | 探测能力保留在首次启动与阻断页重试；设置页不再有该入口 |
| `detectLegacy()` 返回 `'legacy' \| 'guest'` | **重新定义** | 改名为 `detectOldData()`，返回 `{verdict:'has-data' \| 'empty' \| 'unknown'}`；**不再返回空间身份** |
| `unknown → legacy`（fail-safe 进旧路径） | **撤销** | `unknown` → 阻断页，不写记录、不建库 |
| 探测结论 → 空间身份的直接映射表（原三态设计的 §3.4.4） | **删除** | 结论只决定「认领 / 新建 / 阻断」，身份恒为 guest（成功时） |
| 「legacy 卡片」（本机空间·未登录） | **删除** | 卡片只有游客 / 用户两种 |
| R3–R9（切换预检、待定切换恢复、关库失败…） | **撤销** | 换成 R1–R17（§3.8），按「身份 / 复制 / 云端 / 会话」四层重排 |
| T19 / T20（切换后旧连接、切换中断） | **撤销并复用编号** | 新 T19 = 迁移被自动触发/自动合并；新 T20 = 退出后本地与服务端不一致 |

**保留并继续有效**：

1. 旧版数据探测本身（三步取证、1500ms 超时、只读、不依赖 `earthonline-v4-migrated`、不调 `OLMigrate`）。
2. `verdict` 三态（`has-data` / `empty` / `unknown`）——保留为**探测结论**，不再映射为空间身份。
3. 「记录合法时不探测」「一次探测不覆盖已生效身份」。
4. 「不允许用不确定结论执行危险操作」（原决策 #2 第 6 条的实质）。
5. 整页重载、一个标签页一个空间、per-DB 写入租约、多标签 `storage` 事件转只读。
6. 迁移的复制语义、两阶段（暂存库/快照）、幂等键、上传后才激活。
7. 全部认证与 R2 隔离设计（§4–§6）。

### 10.2 取舍记录

| 决策 | 选择 | 放弃的方案 | 理由 |
|---|---|---|---|
| 服务端存储 | D1 | KV / DO / 外部 Postgres | 需要唯一约束与事务 |
| 会话载体 | HttpOnly Cookie | localStorage + Bearer | XSS 可偷 token |
| 空间数量 | 两态 | 三态（含 legacy） | legacy 只是数据来源，不是身份；三态会让「切换」变成必须品 |
| 旧数据接入 | **原地认领** | 首次启动复制到 `earthonline-guest` | 复制把「开应用」变成一次迁移，失败即开不了；认领零数据动作 |
| 旧数据不确定 | **阻断** | fail-safe 进 legacy / 静默建空游客库 | 前者已无合法身份，后者是掩盖（I8） |
| 切换方式 | 登录 / 退出后整页重载 | 同页热切库 | 模块级单例无法安全热切 |
| 迁移 | 复制（且必须上传成功才激活） | 移动 / 先激活后备份 | 断电可回退；决策 C 第 7 条 |
| 退出 | 先撤销会话再切身份 | 先切本地再异步撤销 | 避免「本地 guest、cookie 仍能读云」的窗口 |
| 云端隔离 | 路径前缀 + 服务端派生 | 每用户一个桶 | 配额不可控 |
| 备份协议 | 沿用 v2 | 重写 v3 | CAS/不可变对象已经过真实 R2 验证 |

---

## 11. 仍需产品所有者确认的事项

以下均**未擅自决定**，实现前需要拍板：

1. **guest 空间允许两个库名**（`earthonline-guest` / 认领后的 `earthonline`）是否接受；若不接受，只能改成「首次启动复制」，那条路需要额外的首次启动迁移状态机。
2. **`unknown` 时只阻断、不提供「跳过并新建游客空间」**是否接受（当前设计如此；代价是 IDB 故障设备无法使用应用）。
3. **阻断页的「兼容模式打开」**（读 `earthonline-v4`、不建库、不写 identity）是否保留。
4. **已有 user 数据的账号不提供「把游客数据并进来」**是否接受（避免未设计的合并语义）。
5. **迁移必须在云端备份成功后才切身份**（决策 C 第 7 条）是否坚持；若同意「本地校验通过即可先进入、备份稍后补」，迁移体验会顺畅很多，但与决策 C 原文冲突。
6. **常驻空间标识的位置与形态**（顶栏右侧 chip、≤22px）是否认可。
7. 原五项遗留：API 同源部署、Access 是否退役、共享设备会话策略、迁移后游客数据是否提示清空、R2 回收参数。
