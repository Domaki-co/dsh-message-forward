# Agent Note: 转发目标按工作区筛选

Status: implemented

## Problem

转发弹窗的目标会话列表来自 `sessionRows()`（`lib/client.js:1762`）：它读 `ctx.sessions.list.getSnapshot().byId` 的**全部**会话，只用 `ctx.workspaces.list.getSnapshot().archivedSessionIds` 剔除归档（`lib/client.js:1768`），没有任何工作区维度。工作区一多，列表把不同项目的会话混在一起，用户只能靠标题 / 目录的文本搜索定位目标。

新建会话（`createTargetSession()`，`lib/client.js:1921`）只把源会话的 `cwd` 传给 `sessions.create`，因此无法把新会话落进某个已注册的工作区。

本仓需要让转发目标可按工作区筛选：多工作区环境下，用户要能先把候选收窄到一个工作区，再在其中挑具体目标。

## Decision

### 一、数据层：会话行携带 `workspaceId`

`sessionRows()` 在原有字段上多带一个 `workspaceId`，来源是 `ctxRef.workspaces.list.getSnapshot()`：

```
{ items: [{ workspaceId, path, title, sessionIds, createdAt, updatedAt }],
  archivedSessionIds, pinnedSessionIds, state, phase, error }
```

反查由 `workspaceOwnerIndex(snapshot)`（`lib/client.js:1752`）预建一次 `Map`，避免 O(会话 × 工作区)。反查写法与 DSH 自身同构（`dsh-client-ui-workspace/lib/client.js:257-258` 的 `owningGroupKey`）：

```js
for (const item of snapshot.items) {
  if (!item || !item.workspaceId) continue;
  for (const id of (item.sessionIds || [])) if (!index.has(id)) index.set(id, item.workspaceId);
}
```

- 未分组会话的键是**空字符串** `""`，与 DSH 的 `accounted` 差集口径一致（`dsh-client-ui-workspace/lib/client.js:720-723`）。UI 层不直接暴露 `""`，改用显式哨兵 `SCOPE_ALL = "__ALL__"` / `SCOPE_UNGROUPED = "__UNGROUPED__"`（`lib/client.js:1794-1795`），避免与「未选择」混淆。
- `WorkspaceView.sessionIds` 是**成员关系，不是显示顺序**（`dsh-client-ui-workspace/README.md:172`）。列表排序仍用 `updatedAt`，不跟随 `sessionIds`。
- `workspaceSnapshot()`（`lib/client.js:1731`）是唯一入口：`workspaces` 缺失或抛错一律返回 `null`，调用方据此整条降级。

### 二、三个纯函数

放在「会话业务」段落，与 `sessionRows()` 相邻，便于 `tests/_source.mjs` 的 `MARKERS.session` 切片直接 eval：

```js
function workspaceRowsFrom(snapshot, rows)          // lib/client.js:1785 → [{ scope, title, path, count, isDefault, tipKey }]
function scopeSessionRows(rows, scope)              // lib/client.js:1812 → 按 __ALL__ / workspaceId / __UNGROUPED__ 过滤
function resolveDefaultScope(remembered, sourceWorkspaceId, chips)  // lib/client.js:1820
```

`resolveDefaultScope` 的优先级：记忆值有效 → 用之；否则源会话所属工作区；源会话未分组、或工作区服务不可用 → `__ALL__`。

`workspaceRowsFrom` 的计数取自传入的 `rows`（已剔除归档），因此与列表实际可见条数一致；条目顺序沿用 Host 持久顺序，不按计数或标题重排。「未分组」条目**只在真有未分组会话时出现**，否则它是个永远空的筛选项。

### 三、UI：工作区筛选条

位置在「选择目标会话」标题行与搜索框之间（`lib/client.js:2640-2658`），复用 `.dsh-mf-chip` 视觉（`lib/client.js:1011-1021`），选中态加 `.selected`（`lib/client.js:1087`）：

```
[ 全部工作区 ] [ 项目A (3) ] [ 项目B (7) ] [ 未分组 (2) ]
```

- 搜索框文案与行为不变；过滤顺序 = 先工作区（`scoped`，`lib/client.js:2483`）后文本（`filtered`，`lib/client.js:2485`），AND 关系。
- 计数 `modal.targetCount` 显示 scope 过滤后的数量，自然跟随。
- 新建会话行下方追加一行提示（`lib/client.js:2674`），说明新会话将落在哪个工作区；「全部工作区」/「未分组」下不显示。
- 「默认工作区」与「未分组」语义易混，各自经 `MfTooltip`（`lib/client.js:588`）挂一条说明。

### 四、新建会话的工作区归属

`createTargetSession(scope)`（`lib/client.js:1921`）：

```js
const target = scope && scope !== SCOPE_ALL && scope !== SCOPE_UNGROUPED ? scope : "";
if (target) return sessions.create({ workspaceId: target });   // 落到选中工作区
const cwd = sessionCwd(sourceId);
return sessions.create(cwd ? { cwd } : {});                    // 继承源会话 cwd
```

依据：`dsh-api-session-controller/lib/client.js:2681-2685`，`workspaceId` 与 `cwd` 互斥且前者优先。

**边界**：`__UNGROUPED__` 没有 `workspaceId` 可传，回落源 `cwd`。

### 五、记忆 scope

`forwardStore`（`lib/client.js:1421`）带字段 `lastWorkspaceScope`，模块级，跨弹窗开合存活：

- 打开时（`lib/client.js:2452-2466` 的 reset effect）用 `resolveDefaultScope` 求初值。
- 用户切换时 `forwardStore.set({ lastWorkspaceScope })`。
- **不落盘**：页面刷新即失效，即「本次会话内记住」。
- 记忆值指向的工作区若已删除 → 回落 `__ALL__`。

### 六、降级与边界

- **工作区服务不可用**（`ctxRef.workspaces` 缺失或抛错）：`workspaceRowsFrom` 返回 `[]`，所有行 `workspaceId = ""`，**筛选条整条不渲染**（`lib/client.js:2640` 的 `chips.length > 0 &&`），弹窗行为与无此功能时一致。`workspaces` 在 `inject` 里是可选依赖（`lib/client.js:3055`）。
- **轮询期失效**：选中 scope 在下一轮 `workspaceRowsFrom()` 中消失 → 回落 `__ALL__`（`lib/client.js:2476`）。沿用现有 3s 轮询，未新增订阅。
- **空态三分支**（`lib/client.js:2676`）：`rows.length === 0` → `modal.noSessions`；scope 过滤后为空 → `modal.noWorkspaceSessions`；文本搜索无命中 → `modal.noMatch`。

### 七、`default-workspace` 标题的本地化

DSH 把首次使用的工作区标题固定存为 `default-workspace`，显示时经 `workspaceDisplayTitle(title, localizedDefault)` 折成本地化名称（`dsh-api-workspace-controller/lib/types/default-workspace.js`）。

但插件的 client 半边**不得 require 任何 `@deepseek-ai/*`**（`tests/test-conformance.mjs:146-147` 硬断言）。DSH 自己的 README 说明该 helper 是 pure fold、供 client bundle 内联，因此这里内联同一个折叠：`DEFAULT_WORKSPACE_TITLE = "default-workspace"`（`lib/client.js:1799`），命中时显示 `t("modal.workspaceDefault")`。

### 八、新增 locale 键

zh（`lib/client.js:153-161`）/ en（`lib/client.js:254-262`）同键，由 `tests/test-conformance.mjs:170-178` 自动校验；非词表段不得出现中文字面量，由 `tests/test-conformance.mjs:188-218` 自动校验：

| key | zh | en |
|---|---|---|
| `modal.workspaceAll` | 全部工作区 | All workspaces |
| `modal.workspaceAllTip` | 不限工作区，列出所有会话 | Every session, regardless of workspace |
| `modal.workspaceUngrouped` | 未分组 | Ungrouped |
| `modal.workspaceUngroupedTip` | 不属于任何工作区的会话 | Sessions that belong to no workspace |
| `modal.workspaceDefault` | 默认工作区 | Default workspace |
| `modal.workspaceDefaultTip` | 首次使用时自动创建的工作区 | Workspace created automatically on first use |
| `modal.workspaceChip` | `{title} ({count})` | `{title} ({count})` |
| `modal.noWorkspaceSessions` | 该工作区下暂无可选会话 | No session in this workspace |
| `modal.newSessionIn` | 将新建于「{workspace}」 | Will create in "{workspace}" |

### 九、移动端

新增一行 chip 会挤压 `.dsh-mf-list`（`max-width:720px` 下已被压到 `min(200px, 22dvh)`）。筛选条在窄屏是**单行横向滚动**（`lib/client.js:1393-1400`：`flex-wrap: nowrap; overflow-x: auto` + 隐藏滚动条），高度固定一行，不参与纵向挤压；桌面端折行（`lib/client.js:1080-1086`：`flex-wrap: wrap`）。

### 十、转发目标必须与侧边栏可见性同口径

`sessionRows()` 的过滤条件必须与侧边栏 `sessionVisible()`（`@deepseek-ai/dsh-client-ui-workspace/lib/client.js:357-367`）逐条对齐，否则列表里会出现侧边栏看不到的会话：

| 侧边栏条件 | 含义 | 插件 |
|---|---|---|
| `session.origin === "subagent"` → 不列 | 子代理会话只在父会话的目录里体现 | 剔除（`lib/client.js:1776`） |
| `session.blank` → 不列 | 未发过消息的空会话等同新建，转发给它没有意义 | 剔除（`lib/client.js:1777`） |
| `archivedFilter === "default"` → `!archived.has(id)` | 已归档不列 | 剔除（`lib/client.js:1778`） |

**子代理会话确实混在 `byId` 里**：`projectList()` 先从 `subagentCatalog` 补录（`dsh-api-session-controller/lib/client.js:3518-3542`），再从 `this.scopes` 补录（同文件 `:3543-3568`），两处都写 `origin: "subagent"`。实测本机 121 个会话中 24 个是子代理（7 个已归档），本项目目录 19 个里有 5 个 —— 这些此前都会出现在转发目标里。

**空会话一律剔除，不保留「当前空会话」例外**：侧边栏对当前空会话放行（`session.id !== current`），但转发场景下「没有发送任何消息的会话」与「新建会话」等价，列出来只是噪音。

**归档集必须独立读取**：`sessionRows()` 早先从 `workspaceSnapshot()` 取归档集，而后者在 `items` 非数组时返回 `null`，于是归档过滤被跳过。`items` 与 `archivedSessionIds` 是 `ClientWorkspaceModel` 上互不依赖的两个字段，`buildSnapshot()` 无条件带上两者（`@deepseek-ai/dsh-api-workspace-controller/lib/client.js:259-268`），初值各自独立（同文件 `:17-18`）。故拆出只读归档集的 `archivedSessionIds()`（`lib/client.js:1742`），自行判 `Array.isArray`，与工作区快照解耦。工作区**筛选条**仍走 `workspaceSnapshot()` 的降级语义（`items` 不可用即整条不渲染），两个关注点不再互相牵连。

`tests/test-session.mjs` 覆盖这两类回归：回退可见性过滤会让 5 条断言变红；把 `archived` 的构造改回复用 `wsSnapshot` 会让「items 非数组 + 归档集有值」一条变红。

## Alternatives considered

- **A1 两级选择：先选工作区，再选会话。** 最强理由：层级最清晰，工作区多时列表最短。否掉：默认视图变成两步，最高频路径（在同一工作区内转发）反而更慢，且失去「一屏看到全部会话」。
- **A2 分组折叠列表（一个列表按工作区分节，节头可折叠）。** 最强理由：一屏可见全部且无额外点击。否掉：工作区多时列表过长，移动端尤其吃高度——弹窗已在窄屏把列表压到 `min(200px, 22dvh)`。
- **A3 新建会话始终继承源 `cwd`，工作区选择只影响筛选。** 最强理由：改动最小、行为最可预测。否掉：筛到工作区 W 却把新会话建到别处，语义不一致。
- **A4 新建会话始终要求显式选工作区。** 最强理由：消除隐式继承。否掉：破坏「全部工作区」下已有的快捷路径。
- **A5 默认「全部工作区」且不记忆。** 最强理由：行为最接近现状。否掉：每次都要手动切换，多工作区用户的核心痛点没解决。
- **A6 订阅 `workspaces.list.subscribe` 而非随会话轮询。** 最强理由：变更即时反映，无 3s 陈旧窗口。否掉：弹窗已用 3s 轮询，工作区变更频率远低于会话；额外订阅多一条生命周期与清理路径而无实际收益（YAGNI）。
- **A7 把 scope 持久化到 localStorage。** 最强理由：跨刷新保留。否掉：引入落盘格式与迁移负担，而选定的是「本次会话内记住」。

## Consequences

- **收益**：多工作区环境下，转发目标的候选集可先按工作区收窄，再在区内挑具体会话；新建会话可显式落到选中工作区，不再只能继承源 `cwd`。工作区服务不可用时整条降级，行为与改动前一致。
- **代价与已知上限**：
  - **3s 陈旧窗口**：轮询间隔内的工作区重命名 / 删除不会立刻反映。删除已由「失效 scope 回落」兜住；重命名最多 3s 后自愈。
  - **计数与侧栏短暂不一致**：`sessionIds` 可能含尚无 summary 的会话，DSH 的 `groupByWorkspace` 会 `continue` 跳过它们。这里读 `byId` 天然同构，但两侧的到达时序不同，计数可能在几百毫秒内不同步。
  - **移动端纵向空间**：即使做成单行横向滚动，仍占用约一行高度。**未在真机验证**：矮屏（如 667px 高）下底部按钮是否被顶出视口尚未确认。
  - **`workspaces` 可选依赖**：若宿主未提供该服务，功能静默消失而非报错。这是有意的降级，但意味着「看不到筛选条」时用户无从判断原因。
- **重访信号**：若筛选条在矮屏（< 700px 高）把底部操作按钮顶出视口，且单行横向滚动无法解决，则撤掉筛选条，退回纯文本搜索——工作区维度改由搜索框匹配工作区标题承担。

## Verification

- `node tests/run.mjs` 全绿：9 套件 409 项断言，全部测试通过。
- `tests/test-session.mjs` 已补齐（45 项断言）：覆盖会话可见性同口径（子代理 / 空会话 / 归档剔除）、归档集独立读取、工作区归属反查、筛选条构成、范围筛选与默认范围优先级等全部行为分支。
