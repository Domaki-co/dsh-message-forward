# dsh-message-forward

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blue.svg)](https://github.com/topics/dsh-plugin)

DeepSeek Harness 插件：把**一个会话里的一条消息**（用户提问或模型回复）**精准提取**出来，投递到**另一个会话**。

> Cross-session message forwarding for DeepSeek Harness. Extract one user message or model reply — text plus images — from one session and deliver it into another, with three delivery modes, code-block-only extraction, and multi-select batch merging.

---

## 解决什么问题

长任务会话里塞满了试错、文件检索、工具调用和冗长的思考过程。当你想把「上游会话的某个结论」交给下游会话继续处理时，只有两种糟糕的选择：

1. **直接继承整个会话** —— 上下文被历史噪声撑爆，模型幻觉、格式漂移、指令遵循能力下降，成本也随上下文线性上涨；
2. **手工复制粘贴** —— 要自己挑段落、剥掉思考链和工具调用、重新上传图片，跨会话时还得来回切换窗口。

本插件把这件事变成一次点击：**从任意一条消息上提取纯净产出（正文 + 图片），作为独立、干净的输入投递给目标会话或全新会话**，从源头切断上下文污染。

---

## 功能

### 1. 单条消息提取转发

- 每条**模型回复**下方有「转发」按钮，点击即提取该条回复的正文与图片；
- 每条**用户消息**的操作行同样注入转发按钮（DSH 未提供用户消息动作槽，插件在 DOM 侧补齐）；
- 会话表头提供**会话级入口**，一键转发本会话最近一次模型产出；
- 也可用斜杠命令 `/forward` 触发。

提取范围与 DSH 官方 copy 按钮对齐：只取 `assistant-step` 行的正文，**自动排除思考链、工具调用、过程分组标题（如「已思考 N 秒」）和用户消息**。

### 2. 多选合并转发

- 在任意转发按钮上**长按 2 秒**进入多选模式，按钮上会显示环形倒计时；
- 进入多选后每条消息左侧出现勾选框，可自由勾选/反选；
- **严格按时间线顺序合并**：无论以什么顺序勾选，合并结果都按消息在对话中的原始先后排列，不会乱序；
- **图文混排一并打包**：文字与多张图片分散在多条消息中时，全部聚合为一次多模态投递；
- 底部浮动工具条显示「已选 N / M 条」，提供「全选 / 清空 / 退出 (Esc) / 合并转发」；
- **快捷选择面板**：点击工具条上的计数按钮展开消息清单，每条带角色徽章（用户 / 模型）、序号与摘要（每段最多 150 字符，超出截断，仅影响显示），**不必滚动到消息本身就能勾选**——长回答、长会话下尤其有用。面板列表独立滚动，不会把工具条顶出视口；`Esc` 先收面板、再退出多选。

### 3. 发送前可编辑 + 快捷加工模板

转发弹窗内的文本框**直接可编辑**，发送前可随手精简或补充要求，并提供一键模板：

| 模板 | 作用 |
|---|---|
| `+ 作为参考背景` | 前置「以下是上游会话的产出结果，请作为参考背景…」 |
| `+ 作为任务输入` | 前置「请基于以下上游结果继续执行后续任务…」 |
| `⚡ 仅保留代码块` | 用 Markdown 围栏正则萃取全部代码块，丢弃解释性文字 |
| `重置原文` | 还原为提取到的原始内容 |
| 附带来源标记 | 可选，在正文前加「【转发自会话「X」· 模型回复】」，**默认关闭**以保持纯净输出 |

### 4. 三种投递模式

| 模式 | 行为 |
|---|---|
| **发送并跳转** | 直接向目标会话投递 prompt，并把主视图切到目标会话 |
| **静默发送** | 后台投递，不打断当前浏览，仅以 Toast 反馈 |
| **填入草稿并跳转** | 切到目标会话并把文本与图片预填进输入框，由用户做最后的提示词组织后自行发送 |

### 5. 目标会话选择

- 默认提供「**新建空白会话（干净上下文）**」，一键在新会话开始下游工作；
- 会话列表支持按**标题或工作目录**搜索，显示运行中状态与更新时间；
- 新建会话时沿用来源会话的工作目录（`cwd`）。

### 6. 多模态图片

消息内的图片会被抓取并转换为标准 Base64 载荷，与文本组合成一次多模态投递；个别图片读取失败时跳过并在 Toast 中告知跳过数量。填入草稿模式走附件通道，图片作为真实附件落进输入框。

---

## 安装

```bash
dsh plugin --profile web add "github:Domaki-co/dsh-message-forward#main"
```

要求：

- Node.js >= 20
- DSH `>=0.2.0-rc.1 <0.2.1-0 || >=0.2.1-0 <0.3.0-0`

插件通过 `cordis.patch.yml` 注册，宿主侧入口为 `lib/index.js`，Web 侧 UI 为 `lib/client.js`（单文件 bundle，无需构建）。

---

## 使用

1. 打开任意会话，把鼠标移到一条模型回复或用户消息上，点击**转发**按钮（或点会话表头的转发按钮、或输入 `/forward`）；
2. 在弹窗里修剪内容、套用模板、选择目标会话与投递模式；
3. 需要多条一起转发时，**长按转发按钮 2 秒**进入多选，勾选后点「合并转发」。

---

## 实现要点

### 复用的宿主扩展点

| 扩展点 | 用途 |
|---|---|
| `conversation.chat.assistant-actions` | 模型回复下方的转发按钮（`ownerProps.messageId`，标准 props 自带 `sessionId`） |
| `conversation.session.header.utilities` | 会话表头的会话级转发入口 |
| `conversation.input.overlay` | 目标会话内落草稿（拿到该会话的 `inputActions`） |
| `commandUi` | 注册 `/forward` 命令 |
| DOM 注入 `[data-clock='start']` | 用户消息操作行（DSH 未提供用户消息动作槽） |

投递与草稿落地使用宿主公开 API：

```js
// 发送
ctx.sessions.using(id, { source }, (ref) => ref.binding.session.prompt(content, "queue"));

// 草稿：跨会话没有公开的 setDraft API，交给目标会话的 overlay 组件执行
inputActions.setDraft(text);
inputActions.addAttachments(ids);
```

### DOM 契约依赖

DSH 的聊天行是**两层**结构，提取逻辑必须按行级 `[data-chat-flow-kind]` 定位，而不是用 `previousElementSibling` 回溯，否则只能看到尾行自己的操作按钮：

- 行级：`div[data-chat-flow-kind][data-chat-turn][data-chat-flow-key]`
- 尾行：`div[data-turn-tail]`（是上面那行的**子元素**，转发按钮挂在这里）

正文只从 `data-chat-flow-kind="assistant-step"` 的行取，避免把用户消息或「已思考 N 秒」的折叠行混进转发内容。

### 思考链为什么必须按属性排除

DSH 会把同一个 `assistant-step` 渲染**两次**，靠 `groupPart` 分流：`groupPart="reasoning"` 是只含 reasoning 块的行（折叠态被打上 `hidden`），`groupPart="response"` 才是正式回答行。官方 copy 按钮取的是 `assistantText(closing.blocks)`——只拼接 `kind === "text"` 的块，天然不含 reasoning / tool-call。插件在 DOM 侧对齐这个语义，排除三类节点：

- `[data-chat-group-part="reasoning"]`：思考链分组行
- 带 `hidden` / `data-turn-process-hidden` 的行：被折叠的过程成员
- `[data-variant="think"]`、`[data-turn-process-inline]`、`[data-markdown-variant="compact"]`：思考链根节点、内联包装、思考链专用的紧凑 markdown 变体（正文用默认 `body` 变体）

**关键陷阱**：`innerText` 对 `hidden` 子树返回空串，而 `textContent` 兜底会把折叠中的思考链正文重新捞回来——这正是「转发里混进思考链」的直接原因。因此判定必须走属性，不能依赖构建期哈希类名，也不能依赖可见性。

### 弹窗自适应

primitives 的 `Modal` 卡片是 `width:min(380px,100%)` 且没有 `max-height`，内容一多就顶出窗口。插件通过 `className` / `contentClassName` 挂上自己的类（`.dsh-mf-dialog` / `.dsh-mf-content`）接管尺寸，并按官方注释的约定封顶（消费方用 `max-height:100%`，而不是自己算视口）：

- 卡片：`width:min(720px,100%)` + `max-height:100%`
- 正文区：`dialog > content > body` 全链 `min-height:0` 接上 flex 收缩链，内部滚动；另留 `calc(100dvh - 240px)` 兜底
- 编辑框 / 会话列表：`min(300px, 32dvh)` / `min(240px, 26dvh)` 跟随视口
- 选择器写成 `.dsh-mf-dialog.dsh-mf-dialog` 以稳定压过 primitives 的同名规则，不依赖两边 `<style>` 的注入顺序

### 浮层挂载

底部多选工具条通过 `portalToBody` 挂到 `document.body`：祖先元素若带 `transform` / `filter` / `backdrop-filter`，`position:fixed` 会被困在那个祖先里，导致工具条错位或被裁剪。拿不到 `react-dom` 时原地渲染，功能不受影响。

### 主题与样式

所有颜色取自 DSH 主题 token（`--dsw-alias-*`），浅色/深色主题自动适配，不写死深色底。多选装饰器只给 `position:static` 的宿主补 `position:relative` 并打标记，退出时精确还原（含摘掉空的 `style=""`），不破坏 DSH 原有布局。

---

## 开发与测试

```bash
node tests/run.mjs        # 4 个套件、119 项断言
```

回归测试基于从 `app.asar` 提取的真实 DSH DOM 契约（类名与 `data-*` 属性）在 jsdom 中复现，覆盖单条提取、多选合并、摘要截断、主题 token 有效性、弹窗自适应、以及多选装饰器的挂载与还原：

| 套件 | 覆盖内容 |
|---|---|
| `tests/test-extract.mjs` | 单条转发：行级回溯、只取 `assistant-step` 正文、排除用户消息与「已思考 N 秒」、`turn-error` 回退、分组嵌套穿透 |
| `tests/test-batch.mjs` | 多选：单元识别、按时间顺序合并、未选中项排除 |
| `tests/test-css-tokens.mjs` | CSS 引用的每个 `--dsw-alias-*` 必须是 DSH 真实存在的 token |
| `tests/test-decorator.mjs` | 多选装饰器：装订线 class、定位补丁与精确还原、`role=checkbox` / `aria-checked`、工具条 portal 挂载 |

测试依赖 `jsdom`，插件本身不依赖它，因此没有写进 `package.json`：

```bash
cd tests && npm i jsdom --no-save
```

详见 [tests/README.md](tests/README.md)。

---

## 已知限制

- **只处理已加载的消息**：快捷选择面板与多选基于当前 DOM 中已渲染的消息行，未滚动加载的历史消息不在列表内；
- **图片需可抓取**：图片以 Base64 载荷投递，跨域受限或已失效的图片会被跳过（会在 Toast 中提示数量）；
- **草稿填充依赖宿主输入框就绪**：目标会话的 `inputActions` 尚未挂载时会提示手动粘贴；
- **DOM 契约随 DSH 版本变化**：升级 DSH 大版本后若聊天行结构变动，提取逻辑需要同步校准（测试套件就是为此准备的）。

---

## 目录结构

```
lib/index.js         宿主侧插件入口（注册与日志）
lib/client.js        Web 侧 UI bundle（转发按钮、弹窗、多选、草稿落地）
cordis.patch.yml     插件注册补丁
icon.svg             插件图标
tests/               基于真实 DOM 契约的回归测试
```

---

## License

[MIT](LICENSE) © Domaki-co
