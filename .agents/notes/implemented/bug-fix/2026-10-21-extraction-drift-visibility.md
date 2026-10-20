# Agent Note: 提取失败不再静默

Status: implemented

## Problem

提取层 (`lib/client.js` 的『文案 / 内容提取』段) 在宿主 DOM 结构变化时一律"安静地"返回空串或空数组: `anchor.closest(...)` 落空、回合里一个内容行都没匹配上、正文节点在却抽不出文本, 三种情况的结果都只是 `text: ""`。用户看不到任何差异, 只有在**收件会话**里才会发现转发出去了空内容或错内容 —— 故障点和使用点隔了一个会话, 没有反馈回路。

难点在于"空"有两种来源, 必须分开:

- 结构漂移: 宿主给行换了 `data-chat-flow-kind`、给正文换了 markdown 类名, 提取器的选择器就落空;
- 本来就是空: 用户发了空消息、模型这一轮只产出了思考链, 抽出空串是**正确**结果。

无差别地"空就报警"会把第二种变成噪声, 用户很快就会学会忽略提示, 等于没做。

## Decision

在提取边界建一条单一通道, 并只在弹窗里给一条可关闭的非阻塞提示。

- 通道: 模块级 `EXTRACT_ISSUES` (lib/client.js:1872) + `noteExtractIssue(code, detail)` (lib/client.js:1879) + `takeExtractionIssues()` (lib/client.js:1886, 取走即清空)。走模块级而不是往调用点传参, 因为六个提取调用点里有两个 (批量多选消息单元、slash 命令) 不在本次可改边界内。
- 判据 (a) 锚点丢失: `!anchor` → `anchor-missing` (lib/client.js:2152); `anchor.closest("[data-chat-flow-kind], [data-chat-flow-key]")` 落空 → `anchor-off-row` (lib/client.js:2156)。
- 判据 (a) 与 (b) 的分界线在**行是否存在**, 不在结果是否为空: `assistantTurnNodes(anchor, stats)` (lib/client.js:2103) 多记一个可选 `stats.rows`, 只有 `nodes.length === 0 && stats.rows === 0` 才报 `no-turn-nodes` (lib/client.js:2161)。回合里只有思考链时 `stats.rows > 0`, 因此**不报**。
- 判据 (c) 节点在但文本为空: `collectText` (lib/client.js:1957) 数出真正参与拼接的正文节点 `bodyNodes`, 退化路径取出 `fallback` 后若 `!fallback && bodyNodes > 0` → `text-nodes-empty` (lib/client.js:1981)。
- `extractLastAssistantTurn` 会逐条向前回退, 中途那些"取不到"的尝试只是中间步骤: 循环前记 `mark = EXTRACT_ISSUES.length` (lib/client.js:2204), 取到内容就 `EXTRACT_ISSUES.length = mark` 抹掉 (lib/client.js:2208), 不让它升级成告警。
- 用户侧同理: `extractUserFromContainer` 只报容器/操作行缺失 (lib/client.js:2233、:2237), 不报正文为空。
- 呈现: 打开弹窗时取一次快照 (lib/client.js:3385), `describeExtractIssues` (lib/client.js:3334) 把 code 翻成人话 (按词条去重、最多三条), 紧跟既有 boundaryIssue 行渲染一条 `.dsh-mf-warn` (lib/client.js:3681)。有 issues 才渲染, 无 issues 时零 UI 变化; 关闭按钮复用 `.dsh-mf-picker-close`, **不新增 CSS** (样式段不在可改边界内)。
- `EXTRACT_ISSUE_TEXT` (lib/client.js:3325) 的键写成字面量而不是提取段的常量: 弹窗段会被 `tests/test-forward-wrap.mjs` 单独 `new Function` eval, 那时提取段不在作用域里, 引用常量会 `ReferenceError`。

## Consequences

- 结构漂移从"收件人吃亏"变成"发送前看得见"。提示措辞只说**可能**不完整并请用户核对, 因为它不能证明内容错了 —— 空内容的合法来源 (b) 依然存在, 只是不再被误报。
- 判据 (b) 的反向断言是这套机制的价值所在: 变异测试里把条件放宽成"空集一律报", `tests/test-extract.mjs` 立刻 FAIL; 关掉任一判据则对应断言 FAIL。
- 通道是模块级单例, 因此**一次转发只对应一次快照**: 取走即清空 (lib/client.js:1888)。代价是提取发生在别处 (槽组件/批量单元)、弹窗只负责消费, 谁先取谁负责; 若将来出现两个消费者 (比如再加一个"复制单条"入口), 需要改成显式的 `takeExtractionIssues()` 交接而不是各自读数组。
- 未覆盖: 图片提取 (`collectImages`) 的静默丢失没有判据 —— 图片节点缺失与"这一轮本来没图"同样不可区分, 需要宿主给更硬的信号才能做, 这次不猜。
- 未覆盖: `lib/client.js:1993` 的 `new URL()` 解析、`:2172` 的服务探测等本就该静默的路径一律没动; 全文件仍有 14 处 `catch` 只做兜底, 这次没有无差别加日志。
