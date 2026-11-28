# Phase Auth.4 — 自动云端备份端到端验收方案（设计稿，不执行）

> 依据：`public/app/cloud-backup.js` 当前实现（已连接真实 v1 上传 API、
> `markDirty` → 3s debounce → 调度上传、pending 持久化、guest 五层 fail-closed）。
> 本轮只设计验收；Auth.4 执行时按本方案逐场景记录证据。

## 0. 前置条件（全部满足才开始验收）

1. Auth.3 部署 Runbook 11 步完成，生产验证矩阵全绿（同源 Route、D1、Secrets、邮件、登录闭环）。
2. 准备两个真实测试邮箱 A、B（可收验证码）。
3. 一台浏览器装 DevTools；Network 面板过滤 `api/backup`；可随时切 offline（DevTools → Network → Offline）。
4. 记录基线：验收前 R2 桶中 `users/` 前缀对象清单（`wrangler r2 object list` 只读或 Dashboard 浏览）。
5. 禁止使用生产真实用户数据做破坏性操作；测试设备用独立浏览器 Profile。

## 1. 验收场景矩阵（9 项）

### S1 guest 打开应用，不发生云端上传
- **操作**：无痕窗口打开 `https://slices0flife.me/app/`，不登录，正常使用（记一笔饮食、勾一个待办）。
- **预期**：
  - Network 面板全程 **0 个** `/api/backup*` 请求；
  - 设置页备份区显示游客受限文案（guestBlocked 门禁）；
  - IndexedDB 中备份状态 `pending` 保持 `false`。
- **代码锚点**：`cloud-backup.js` `guestBlocked()`（identity.record() 必须 local+earthonline 用户）。
- **失败判定**：出现任何 backup 请求即 FAIL（fail-open 回归）。

### S2 user 登录成功
- **操作**：设置页 → 登录 Sheet → 输入邮箱 A → 收验证码 → 验证。
- **预期**：
  - 响应 `Set-Cookie: __Host-eo_sess=…; Secure; HttpOnly; SameSite=Lax`（DevTools 中 JS 不可读）；
  - `GET /api/auth/session` 返回 `authenticated: true` + userId；
  - 设置页进入登录态双态渲染；identity 进入 user 态。
- **失败判定**：Cookie 带 `Domain` 属性、或 JS 可读取 token、或登录后 identity 仍是 guest。

### S3 user 本地数据触发自动备份
- **操作**：登录后改动任一业务数据（记一笔饮食）。
- **预期**：`markDirty()` → 3s debounce → 自动发出上传请求（Network 可见，无需手动点备份）；请求头带 `X-Earthonline-Auth: 1`，Cookie 随同源自动携带。
- **代码锚点**：`markDirty()` → `schedule(DEBOUNCE_MS)`。
- **失败判定**：必须手动点按钮才上传（调度器未接通）。

### S4 上传成功后状态正确更新
- **预期**：上传 2xx 后状态变 `synced`、显示最近同步时间；`state.pending=false`、seq 递增持久化；R2 出现 `users/<userIdA>/…` 对象。
- **失败判定**：上传成功但 UI 仍显示 pending；或 R2 对象落在 `users/` 之外路径。

### S5 网络失败后 pending 保留
- **操作**：切 DevTools Offline → 再改动一条数据 → 观察 3s 后请求失败 → 恢复网络前检查状态。
- **预期**：请求失败；`state.pending` **保持 true**（绝不丢弃待备份状态）；UI 显示 pending/未同步；identity 不被降级（网络错误 ≠ Session 失效）。
- **代码锚点**：上传失败路径 `state.pending = true` + `authClass === 'session-invalid'` 才 markSessionInvalid。
- **失败判定**：失败后 pending 被清除、或用户被登出。

### S6 页面刷新后 pending 可恢复
- **操作**：S5 失败后（pending=true）刷新页面，恢复网络。
- **预期**：boot → 读取持久化 pending → 定时器恢复 → 自动补传成功 → 状态 synced。
- **代码锚点**：pending 持久化字段（persist）+ `syncIdentity()` 恢复调度。
- **失败判定**：刷新后 pending 丢失且不补传。

### S7 用户退出后旧身份任务停止
- **操作**：登录态 → 退出登录（logout）。
- **预期**：
  - 服务端 Session 撤销（再查 session 返回未登录）；
  - 本地停止上传定时器、丢弃 in-flight 请求；
  - 之后改动数据不触发任何上传（回到 S1 guest 行为）。
- **代码锚点**：`demoteToGuest()` → `syncIdentity()` → `stopTimers()` + uploading 复位。
- **失败判定**：退出后 Network 仍出现 backup 请求。

### S8 切换身份后不发生跨用户上传
- **操作**：A 退出 → 登录 B → 改动数据触发上传。
- **预期**：
  - 上传只写 `users/<userIdB>/…`（服务端按 Session 强制，前端不传 userId）；
  - B 的应用内不出现 A 的数据；切换瞬间 A 残留的 pending/in-flight 被丢弃（S7 同机制）。
- **失败判定**：R2 出现跨 userId 混写，或 B 首页短暂闪现 A 的数据。

### S9 用户 A 无法访问用户 B 的备份
- **操作**（服务端隔离负向测试）：
  1. A 登录态调用 `GET /api/backup/status` —— 只反映 A 的命名空间；
  2. DevTools 重放 B 的备份读请求但携带 **A 的 Cookie**（替换 Cookie 头）—— 预期 401/404，绝不返回 B 数据；
  3. 伪造上传 body 指定他人 userId —— 服务端忽略该字段（userId 只来自 Session 查表）。
- **代码锚点**：`authorizeBackup()` 返回 `{userId, source}`；R2 键 `users/<userId>/…` ctx 强校验（backup-isolation 10 条单测已覆盖伪造场景，本场景是生产端复核）。
- **失败判定**：任何能读到他人数据的路径。

## 2. 证据记录模板

每个场景记录：时间 · 浏览器/Profile · 操作步骤 · Network 截图（请求/响应关键行）·
状态截图 · IndexedDB 备份状态导出 · PASS/FAIL。全部 PASS 才算 Auth.4 验收完成。

## 3. 退出准则

- 9 场景全 PASS；
- R2 命名空间抽查无越界对象；
- 验收后保留：A、B 两账号留在 D1（便于后续回归），测试产生的备份数据可保留在各自命名空间（互不可见，无需清理）。
