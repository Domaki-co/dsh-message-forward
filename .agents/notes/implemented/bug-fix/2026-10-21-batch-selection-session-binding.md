# Agent Note: 多选批量转发绑定会话身份，目标失效当场拒绝

Status: implemented

## Problem

批量多选是**跨操作存活**的状态: 用户在一个会话里勾几行, 中途切到另一个会话看别的东西, 再回来点“合并转发”。改造前这套状态有四处漏洞。

1. 选中态不属于任何会话。`batchStore` (lib/client.js:1765) 记了 `sessionId`, 但全文件没有任何一处读它做比对, `collectUnits()` (lib/client.js:2951) 直接扫 `document`。分屏时两个 `[data-conversation-scroll]` 同时在 DOM 里, 采集必然把两个会话的行混进同一个列表; 合并后的标题取的是**旧会话**的标题。结论: **选中态必须绑定会话身份** —— 一个 `Set` 只有在“这些 id 属于哪个会话”确定时才有意义, 否则它是一个没有主语的集合, 而标题、工作区、目标会话全都要从这个主语推出来。
2. 装饰器把勾选框画进宿主行 (`.dsh-mf-check` / `.dsh-mf-unit-selected`), 所以“作废选中态”不是清一个 Set 就完事: 不清 DOM 会留下“看起来还选着”的残留。
3. 目标工作区记忆压过源会话。`resolveDefaultScope(remembered, sourceWorkspaceId, chips)` 原来让 `remembered` 优先, 而这个筛选同时决定默认目标 `__NEW_SESSION__` 走 `sessions.create({ workspaceId })` 时落在哪个工作区 —— 于是会把内容建到上一次用过的、与源会话无关的工作区。
4. 目标没有两条最基本的校验: `handleExecute` 里 `finalTarget` 解析后既不检查“是不是自己”, 也不检查“这个会话还在不在”。自转把自己的标题引回自己; 目标在弹窗打开期间被删除/归档则页脚变空, 直到点执行才失败。

## Decision

把“会话身份”和“会话根”变成多选状态的显式字段, 并让两条校验成为纯函数。

- 状态位: `batchStore` 增 `root` (绑定的会话根) 与 `liveSessionId` (最近一次确认的会话身份) (lib/client.js:1765)。
- `batchScope()` (lib/client.js:2910): 绑定的 root 仍 `isConnected` 就用它, 否则取首个已连接的 `[data-conversation-scroll]`, 再否则 `document`。`collectUnits(scope)` (lib/client.js:2951) 改成“显式根 > `batchScope()`”, 两处 `document.querySelectorAll` 换成 `root.querySelectorAll`, 采集永远不出会话根。
- `ensureBatchSession()` (lib/client.js:2937): 仅当多选处于激活态时才比对, 发现 `liveSessionId()` 与记忆的 `liveSessionId` 不同就整体作废 —— `invalidateSelection()` (lib/client.js:2921) 先 `resetSelectionCache()` 再清 `selectedIds`, 并把 `.dsh-mf-check` 的 `selected` / `aria-checked` / `title` 与 `.dsh-mf-unit-selected` 一起回滚, 然后改绑 `sessionId` / `liveSessionId` / `root` 并给一条提示 (lib/client.js:2946-2948)。
- 三个入口都调 `ensureBatchSession()`: `toggleSelectedUnit` (lib/client.js:3080, 点之前先确认)、`decorate()` (lib/client.js:4299, 画之前先确认)、`handleMerge` (lib/client.js:3212, 合并之前先确认, 并把入参换成 `batchStore.state.selectedIds` —— 函数里的 `state` 是本次渲染的闭包快照, 作废后它已经过期)。
- 四个多选入口顺手记下 root: 弹窗“多选”与头部按钮 `root: null` (由 `batchScope()` 兜底), 助手槽按钮 `btn.closest("[data-conversation-scroll]")`, 用户行长按 `row.closest("[data-conversation-scroll]")` (lib/client.js:3689、:4171 及另两处)。三处退出多选把 `root` / `liveSessionId` 归零 (lib/client.js:3199、:3218、:3281)。
- `resolveDefaultScope` (lib/client.js:2370) 优先级翻转为“源会话工作区 → 记忆值 → `SCOPE_ALL`”: 记忆值只在没有源会话工作区、或源会话工作区不在工作区表里时才生效。理由是**默认值的语义是“跟着当前上下文”, 而记住的偏好只在上下文不给意见时才有资格说话**。
- 两条纯判据抽到 session 段: `targetStillExists(rows, targetId)` (lib/client.js:2379, 空目标与 `__NEW_SESSION__` 恒有效, 否则 `rows.some(row.id === targetId)`) 与 `isSelfTarget(sourceSessionId, finalTarget)` (lib/client.js:2385)。三处消费: `handleExecute` 自转守卫 (lib/client.js:3593)、`handleExecute` 提交前复验 (lib/client.js:3584)、3s 轮询的候选项刷新 (lib/client.js:3482, 靠 `targetIdRef` 读到最新值而不是闭包里的旧值)。
- 失效后的落点选“回到 `__NEW_SESSION__`”而不是“清空选择”: 新建会话永远有效, 用户不会卡在一个空目标上, 也不会静默改动已选的工作区。

## Alternatives

- 把 `selectedIds` 换成 `Map<sessionId, Set<unitId>>` 以支持“跨会话多选”。否定: 批量转发的语义是“把这几行合成一条消息”, 跨会话合并的产物既不属于源也不属于目标, 标题该用谁没有正确答案; 保留跨会话选中只会把问题从实现层推到产品层。
- 作废时静默清空。否定: 用户刚勾完几行, 切个会话回来发现勾选没了却不知道为什么, 等于把状态机的错误归因给用户。给一条可关闭提示的代价只有一对文案 (lib/client.js:94、:241)。
- 在 `resolveDefaultScope` 里保留 `remembered` 优先, 只把 `sessions.create` 的 `workspaceId` 改成源会话工作区。否定: 那会让“筛选器显示 w2、实际建到 w1”, 界面与实际分叉比优先级错更糟 —— 一个决定就该有一个唯一来源。
- 自转守卫放在 UI 层 (禁用“当前会话”那个候选项)。否定: 候选项来自轮询快照, 禁用状态会随刷新抖动; 把“能不能做”放在提交路径上是唯一不会被 UI 状态绕过的地方。
- 目标失效检测只靠 3s 轮询。否定: 轮询有窗口期, 用户可以在一个已经失效的目标上按回车; 提交前必须再验一次。

## Consequences

- 语义代价: 切换会话 = 放弃当前勾选。这是**故意的**取舍 —— 多选的产物绑定源会话的标题与工作区, 允许它跨越会话会让“转发到哪、标题叫什么”失去唯一解。
- `ensureBatchSession()` 返回 `true` 表示“调用方本次应当直接返回”: 它在作废的同时给出提示, 所以三个入口都写成 `if (ensureBatchSession()) return;`。它只在 `isActive` 且 `liveSessionId()` 非空时才判断, 会话表拿不到快照时不会误伤。
- 变异测试逐条验过 (改回旧行为 → 对应断言变红 → 还原 → `sha256` 与还原前一致): 采集根改回 `document` → test-batch 7 FAIL; 不比对会话身份 → 6 FAIL; `remembered` 恢复优先 → test-session 3 FAIL; 自转守卫恒返回 `false` → 1 FAIL; `targetStillExists` 恒真 → 2 FAIL。
- 测试夹具从单面板变成双面板 (`tests/test-batch.mjs` 的 `#pane2`), 并把 `storeSrc` 拼进切片: 否则 `batchScope` 里的 `batchStore` 在 `new Function` 作用域里不存在, 原样就是 `ReferenceError: batchStore is not defined`。
- 未覆盖: 勾选框视觉回滚只处理当前 DOM 里已存在的 `.dsh-mf-check`, 如果宿主把行虚拟化掉 (recycle 到别的 turn), 那些节点上的 class 不会被清 —— 它们已经不携带本会话的信息, 无害, 但没有测试能证明。
- 未覆盖: `targetStillExists` 依赖 `sessionRows()` 的快照新鲜度; 宿主若把归档会话继续留在快照里, 复验会通过而真正创建会话时失败。这条的判据在宿主侧, 插件只能复验不可更强。
