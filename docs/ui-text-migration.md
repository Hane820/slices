# UI 文案中心 · 书写与迁移规范

> 适用：`public/app/**` 下的静态界面文案（`config/` 注册表、`data-i18n`、`U()` / `UH()`）
> 不适用：Toast 配置中心（`config/toast-text.js`，独立体系）、业务数据里的用户输入、日志与调试输出
> 配套门禁：`node scripts/ui-text-check.mjs`（已前置到 `npm test`）

---

## 0. 一句话规则

**界面上的固定文字必须能在一个地方改；key 必须是静态字面量；拼进 HTML 的文案必须转义。**

---

## 1. 生效链路（顺序不能乱）

```
config/index.js        定义注册表（OLText / U / UH），**自己不碰 DOM**
config/<分组>.js ×13   同步 register() 文案
config/apply.js        注册完成后立刻替换一次 DOM（唯一首替换点）
config/toast-text.js   Toast 配置中心（不参与本体系）
…业务脚本…
core.js / boot.js      业务渲染与启动
```

门禁会断言：所有「会 `register()` 的 `config/*.js`」都排在 `apply.js` 之前，
且 `apply.js` 早于 `core.js` 与 `boot.js`。**新增分组文件必须同时改 `index.html`**，
否则检查直接报错（"配置模块未在 index.html 中加载"）。

---

## 2. key 命名

```
模块.业务对象.用途      today.section.tasks / common.a11y.backToTop / settings.space.badge.guest
```

- 小写字母开头，至少两段，段内允许 camelCase。
- 与文件路径无关、与中文原文无关：**改文案不改 key**。
- 分组名与 key 前缀保持一致（`config/decision.js` 的分组名是 `decide`，前缀也是 `decide.`）。
- 旧的中文原文 key（`'取消': '取消'`）仍在 `legacy` 表里保留，供 `OLT()` 使用；新代码一律用英文 key。

---

## 3. JS 调用：`U()` 与 `UH()`

| 函数 | 用途 | 转义 |
|---|---|---|
| `U(key, vars?)` | 纯文本：`textContent`、`toast` 文本、`title` 属性 | 否（原样返回） |
| `UH(key, vars?)` | 拼进 HTML 字符串：`innerHTML`、`insertAdjacentHTML` | 是（整句 + 插值一起转义） |

```js
el.textContent = U('today.section.tasks');
el.innerHTML = '<b>' + UH('today.task.due.overdue', { days: 3 }) + '</b>';
```

### 3.1 key 必须是静态字面量（硬规则）

允许：

```js
U('common.save');
U("common.save");
U(`common.save`);
```

禁止（检查脚本按**错误**处理，`npm test` 直接失败）：

```js
U('common.' + name);      // 拼接
U(prefix + '.save');      // 拼接
U(`common.${name}`);      // 模板插值
U(key);                   // 变量
U(keyMap[action]);        // 映射表下标
```

需要「按条件选文案」时，拆成显式分支：

```js
// ✅ 正确
const label = action === 'save' ? U('common.save') : U('common.cancel');

// ❌ 错误：keyMap 的值仍是动态 key
const keyMap = { save: 'common.save' };
U(keyMap[action] || 'common.unknownAction');
```

> 为什么禁止：动态 key 无法被静态检查覆盖（无效 key、未使用、插值缺失全部失效），
> 出错时只能在界面上看到 `［缺少文案：…］`。第二批要新增数百个调用点，必须靠静态门禁兜住。

### 3.2 插值

```js
// 配置：'today.task.due.overdue': '逾期 {days} 天'
U('today.task.due.overdue', { days: 3 });   // → 逾期 3 天
```

- 只接受 `string` 与有限 `number`；`false` / 数组 / 对象 / 函数 / `undefined` → 显示 `［缺参数：days］`。
- `0` 与负数合法。
- 调用处必须是**对象字面量**（`{ days }` 可以），传变量时检查脚本会告警「插值无法静态判断」。
- 配置里的 `{name}` 在 HTML 静态兜底里不允许出现（`data-i18n` 不做插值）。

---

## 4. DOM 静态文案

```html
<span data-i18n="today.section.tasks">今日待办</span>
```

- HTML 里的中文是**兜底**：JS 没加载、key 写错、配置缺失时显示的都是这段原文，不会白屏或闪 key。
- 兜底文案必须与配置值**逐字一致**（检查脚本逐元素比对，含属性）。
- 元素里有子标签时，只替换第一段纯文本，子元素结构保留：

```html
<button data-i18n="common.example">原始文本<strong>保留</strong></button>
```

- 纯图标元素（例如 `#toTop` 的 `↑`）加 `data-i18n-skip-text`：只换属性，不动可见文本。

---

## 5. 属性文案（placeholder / aria-label / title）

两种写法，**属性名只取后缀，属性值没有语义**：

```html
<!-- A. 单个属性：后缀就是目标属性名；值留空 -->
<input data-i18n="decide.placeholder.librarySearch" data-i18n-attr="placeholder"
       placeholder="找一下，比如 下课">

<button data-i18n="common.a11y.backToTop" data-i18n-aria-label aria-label="回到顶端">↑</button>

<!-- B. 多个属性：逗号分隔 -->
<button data-i18n="common.example" data-i18n-attr="title,aria-label"
        title="原标题" aria-label="原标签">原始文本</button>
```

规则：

1. `data-i18n-<X>` 的目标是属性 `X`，属性值被忽略。
2. 因此 `data-i18n-aria-label="aria-label"` 虽然能用，但那个值是**冗余**的；写别的名字（如 `="title"`）
   会被检查脚本判为错误，因为它会误导读者。
3. 同时改多个属性用 `data-i18n-attr="a,b"`，不要写多个 `data-i18n-*` 后缀。
4. 属性的 HTML 原值必须等于配置值（兜底一致性检查）。

---

## 6. 什么该登记，什么不登记

### 6.1 必须登记

- 用户需要读懂才能操作的文字：按钮、菜单、标题、说明、空状态、错误提示、表单占位符。
- 有信息含义的英文（例如 `Backup now`、`Guest`）：它和其他界面文案同属固定文案，**不能因为它是英文就放过**。
- 无可见文字但承载语义的属性：`aria-label`、`title`、`alt`、`placeholder`。

### 6.2 不登记（明确排除）

- **装饰性品牌/版式文字**：`DECIDE` / `RECORDS` / `SETTINGS` / `EARTH ONLINE`
  这类只用于版面节奏的英文小标（`index.html` 中 `.hd-date`、页脚品牌行）。
- 纯视觉符号：`↑`、`·`、`—`、`＋`。
- 由业务数据拼出来的文本（用户名、条数、日期、自定义标签名）。
- 调试与日志文案、Toast 配置中心里的条目。

### 6.3 判断依据（不看语言，看用途）

依次问三个问题，任一为「是」就必须登记：

1. 用户是否需要**理解这段话**才能完成操作或判断状态？
2. 它是否是**应用的固定文案**（不是用户数据、不是计算结果）？
3. 翻译/改写它是否会改变产品语义？

三条都为「否」，才是装饰元素。**「是英文」不构成排除理由**；
反过来，装饰性英文也不必为了统一而强行迁移（第 6.2 条的四个词就是刻意保留的）。

---

## 7. 提交前检查

```bash
npm test          # 内含 node scripts/ui-text-check.mjs + 运行时测试
```

检查脚本的 10 类检查：

| # | 检查 | 级别 |
|---|---|---|
| 1 | key 命名格式 | 错误 |
| 2 | 重复 key（跨分组文件） | 错误 |
| 3 | 无效引用（`U()` / `data-i18n` 找不到定义） | 错误 |
| 4 | 未使用文案 | 告警（`--strict` 时失败） |
| 5 | 插值参数缺失 | 错误 |
| 6 | HTML 仍用中文当 key | 告警 |
| 7 | HTML 兜底文本/属性与配置不一致 | 错误 |
| 8 | 加载顺序（分组 → `apply.js` → `core.js`/`boot.js`） | 错误 |
| 9 | 裸 `U()` 进入 `innerHTML` / `outerHTML` / `insertAdjacentHTML`（**跨行**分析整条语句，含「拼进变量再写入」一跳） | 错误 |
| 10 | 动态 key（拼接 / 变量 / 模板插值） | 错误 |

另有「无法静态判断的 HTML 写入」告警：表达式里调用了检查脚本不认识的函数
（如 `goalCardHtml(...)`），会列出文件与行号，需要人工确认它内部没有拼裸 `U()`。

---

## 8. 分批迁移流程

1. **先 HTML，后 JS**：`data-i18n` 有中文兜底，出错也看得见；`U()` 出错会显示可见标记。
2. 每批只动一个模块，改完立刻 `npm test`。
3. 同一批里：加 key → 改调用点 → 改 HTML 兜底 → 跑检查，四步不要跨批混做。
4. 一批的验收：`npm test` 全绿（0 错误）、`ui-text-check` 的「未使用」为 0、
   HTML 兜底与配置值逐字一致。
5. 回滚：这一批的 key 定义与调用点一起撤，不要只撤一半（会留下未使用 key 或无效引用）。

---

## 9. 常见报错对照

| 报错 | 真实原因 | 修法 |
|---|---|---|
| `裸 U() 进入 innerHTML` | 拼 HTML 时用了 `U()` | 改 `UH()`，或改成 `textContent` |
| `裸 U() 拼进 HTML 字符串` | `'<div>' + U('x')` 跨行拼接 | 同上（检查按整条语句分析，跨行也会被抓住） |
| `动态 key（规范禁止…）` | `U('a.' + b)` / `U(k)` / `` U(`a.${b}`) `` | 拆成静态分支 |
| `无效引用：xxx` | key 拼错，或配置没注册 | 对照 `config/*.js` |
| `兜底不一致` | HTML 原文与配置值不同 | 以配置为准改 HTML，或反之 |
| `属性兜底不一致` | 属性原值 ≠ 配置值 | 同上 |
| `配置模块未在 index.html 中加载` | 新加了 `config/xxx.js` 却没加 `<script>` | 补 script 标签，位置在 `apply.js` 之前 |
| `排在 config/apply.js 之后` | 分组脚本位置错了 | 移到 `apply.js` 之前 |
| `无法静态判断的 HTML 写入` | 表达式调用了未知函数 | 人工确认该函数只拼 `UH()` 或已转义内容 |

---

## 10. 后续待办登记：UI 文案中心第二批迁移（BLOCKED）

> 本节只登记任务，**当前不执行任何迁移**。状态由产品所有者确认后生效。

| 字段 | 值 |
|---|---|
| 任务名称 | UI 文案中心第二批迁移 |
| 状态 | 待办 / **BLOCKED**（等待前置业务改造完成） |
| 优先级 | **P3** —— 低于默认游客模式、身份架构修复、设置页重构、云端备份核心闭环 |
| 所属系统 | 现有 `public/app/config/` + `OLText`，沿用第一批；不另建系统、不重构 Toast |

### 10.1 前置依赖（满足或明确排除冲突后才可启动）

1. 默认游客模式落地。
2. `guest` / `user` 两态身份架构的核心 P0 修复。
3. 设置页与云端备份入口调整。
4. 登录、用户空间、游客迁移及云端备份相关代码的主要结构稳定。

空间/云端区域的 19 条未注册 OLT **不得提前迁移**；其中预计被两态改造重写或删除的 11 条，
必须等业务代码稳定后再处理。不得在身份代码尚未稳定时把旧状态名称、旧空间概念固化进文案中心。
与身份系统无关的批次，将来可在确认无冲突后单独安排。

### 10.2 完成条件

- 第二批固定 UI 文案完成迁移，所有 key 正确注册。
- 不存在未解释的固定文案遗漏。
- `npm test`（含 `ui-text-check`）静态检查与运行时测试全部通过。
- Toast 系统保持独立；业务行为与用户数据不受影响。
- 迁移文档与实际代码一致。

### 10.3 基线引用（本轮不重新统计）

- OLT 唯一基线：**94 调用 / 92 静态 / 85 key / 19 条未注册**。
- 19 条未注册 OLT：精确、临时、不登记 legacy 的例外机制，随身份改造完成后删除例外。
- B2-8：静态分支方案，不新增通用映射 API、不改文案引擎。
- B2-9：**14 片段 / 8 key**（问候语与屏幕时长单位；PDF 报告正文排除）。
- 九批合计：**228 片段 / 195 key**；全量对账 **2046** 条。
- 基线来源：本项目的《UI 文案中心第二批最终基线确认》会话记录（**尚未落盘为仓库文档**）；
  本节所在的 `docs/ui-text-migration.md` 是迁移规则的正式依据。

**差异提示（不覆盖旧数字）**：默认游客模式实施后，`public/app/boot.js` 新增了 7 条启动阻断文案
（`身份与数据库绑定失败`、`身份指向的数据库不存在`、`数据库完整性检查失败`、`启动探测模块缺失`、
`旧数据探测结果不确定`、`默认游客身份写入失败`、`旧数据探测失败`）。这些属于 B2-5 的固定 UI 文案，
但本轮**不重新统计**，因此上面的 228/195 仍是「登记时引用的历史基线」。正式启动 B2-5 前必须按
当时代码复核并更新基线；若其他前置改造也改动了文案，同样先更新基线再实施。

### 10.4 正式启动时的约束

沿用 §1–§8 规则；按已确认批次顺序逐批推进，禁止一次性大范围替换；每批跑静态检查与运行时测试；
例外机制保持精确、可追踪，不得用大量豁免掩盖遗漏；不得迁移 Toast、Tooltip、临时弹窗、即时反馈、
用户数据、动态统计与 PDF 正文；不得改变业务行为或数据结构；每批交付修改清单、测试结果、未解决问题与 Git 状态。
