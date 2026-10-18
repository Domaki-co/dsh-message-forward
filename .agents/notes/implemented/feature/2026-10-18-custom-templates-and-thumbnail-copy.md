# Agent Note: 自定义模板与缩略图剪贴板复制

Status: implemented

## Problem

1. **加工模板写死在源码中**：此前仅内置了四个固定模板（`+ 作为参考背景`、`+ 作为任务输入`、`重置原文`、`原文（不加标签）`）。长会话向下游派发任务时诉求各异（如代码审查、多语言翻译、PRD 生成、异常根因分析），用户每次都需要在弹窗文本框内手动输入重复的提示语。
2. **消息中的图片无法带入外部系统**：DSH 原生复制按钮仅拼接 `kind === "text"` 的文本块；在聊天气泡或富文本中，图片被降级为 Markdown 链接或附件文件名（如 `[image.png]`）。当用户需要把上游产出的架构图、排查截图或多模态分析图交付到外部应用（微信、飞书、文档等）时，直接复制只能得到文件名文本，无法获取实际的图片位图。

## Decision

### 一、自定义模板库（基于 `localStorage`）

在现有固定模板的基础上开放用户自由增删模板的能力，并持久化于客户端存储中：

1. **存储格式与隔离**：
   - 使用键名 `dsh_mf_custom_templates`。
   - 记录结构：`[{ id, name, hint, noBoundary }]`。
     - `name`: 模板展示名称（如「代码评审」）；
     - `hint`: 前置注入的提示词（如「请仔细审查以下产出中的并发安全问题：」）；
     - `noBoundary`: 布尔值，是否跳过 `<forwarded_context>` 引文边界包裹（默认为 `false`，保持边界）。
2. **纯函数生成逻辑**：
   在 `applyTemplateToText(payload, templateDef)` 中统一派发：
   - 纯图片/空正文保护：若正文为空（`!rawText.trim()`），仅输出提示词 `hint`，严禁生成空的 `<forwarded_context>` 引文块，坚决守住 [2026-10-16-forward-context-boundary.md](2026-10-16-forward-context-boundary.md) 确立的引文边界契约；
   - 默认模式：通过约定的 `wrapContextBody` 将正文安全包裹，前置追加 `hint`；
   - 纯文本模式（`noBoundary: true`）：调用 `neutralizeContextBody` 中和潜在标签字面量后直接拼接正文，不生成边界标签。
3. **界面交互与表单健壮性**：
   - 快捷加工栏（`.dsh-mf-row`）支持自然折行，动态渲染已保存的自定义模板 Chip（带 `+ ` 前缀与虚线边框样式 `.dsh-mf-chip-custom`）；
   - 末尾提供「管理模板」按钮，展开轻量管理卡片（`.dsh-mf-tpl-card`）；弹窗重开时显式重置管理卡片与未保存输入，防止废弃状态残留；
   - 表单升级：提示语采用自适应多行 `.dsh-mf-tpl-textarea`，模板名称限制 16 字符并执行重名与非空校验（`notify.templateNameTooLong`, `notify.templateNameDuplicate`）；全量样式通过 Token 规范化抽离（`.dsh-mf-tpl-input`, `.dsh-mf-tpl-del`, `.dsh-mf-tpl-save`）。

### 二、缩略图一键二进制复制与移动端原生直发微信

在转发弹窗的缩略图展示区直接打通向系统剪贴板（OS Clipboard）输出二进制位图及移动端原生分享的管道：

1. **DOM 结构与移动端触控优化**：
   - 原 `.dsh-mf-thumbs > img.dsh-mf-thumb` 升级为 `.dsh-mf-thumb-wrap > [img.dsh-mf-thumb, button.dsh-mf-thumb-copy]`；
   - 按钮右下角绝对定位浮动，悬浮或触摸时激活；图标采用内联 `CopyIcon`，复制中切换为 `SpinnerIcon` 旋转动画；外层包裹 `MfTooltip`（`side="top"` 正确向上展开）标明「复制图片」/「复制中…」；
   - 移动端适配（`max-width: 720px`）：无 hover 环境下按钮常显（`opacity: 1`），且通过 `::after` 伪元素扩展触控热区至规范的 44x44px。
2. **转码与输出管道（`shareImageMobile` + `copyImageToClipboard`）**：
   - 移动端原生分享优先（`shareImageMobile`）：在手机/触屏环境中优先通过 Web Share API（`navigator.share({ files: [file] })`）直接拉起系统面板直发微信好友（免存相册）；用户取消分享静默兜底，不支持则无缝降级剪贴板；
   - 环境安全检查：拦截局域网 HTTP（`window.isSecureContext === false`），明确提示 `error.clipboardInsecureContext`；
   - 用户激活手势保护：通过 Promise 延迟解析模式包装 `new ClipboardItem({ "image/png": pngPromise })`，保持 Safari / WebKit 异步 User Activation 活跃；
   - 复用现有的 `readImageDataUrl` 统一读取图片源（支持 `data:`、`blob:`、本地与跨域图）；
   - 针对浏览器异步剪贴板规范（`ClipboardItem` 强制要求标准 `image/png` MIME 类型）：
     - 若图片本身为 PNG 则直接解析为 Blob；
     - 若为 JPEG / WebP / GIF 或外部格式，自动通过离屏 `canvas.toBlob(..., "image/png")` 重新光栅化为标准 PNG Blob；
   - 调用 `navigator.clipboard.write([item])` 写入系统剪贴板；弹窗层级维护 `copyingUrl` 并发状态锁，执行中禁用其他按钮，杜绝重复写入冲突。
3. **反馈机制**：
   - 复制成功触发绿色 Toast 提示 `t("notify.imageCopied")`；
   - 权限拒绝或环境不支持触发告警 Toast `t("notify.imageCopyFailed")`。

## Alternatives considered

1. **在聊天流消息气泡的图片上直接悬浮复制按钮**：
   - *最强理由*：用户无需点击转发按钮进入弹窗，即可在消息历史中随时复制单图。
   - *否定原因*：DSH 消息流具备高频动态重绘与虚拟滚动特性，直接在主聊天 DOM 中通过 MutationObserver 劫持或注入图片浮层容易引起界面抖动、事件冒泡穿透与样式冲突。而转发弹窗本质上是用户的“内容加工与导出工作台”，在此处提供图片复制体验最为稳定且边界清晰。
2. **将自定义模板同步到 DSH Host 侧配置文件**：
   - *最强理由*：可以跨不同的浏览器端或 Webview 容器同步模板。
   - *否定原因*：插件架构严格遵循 Cordis 客户端模式，Host 侧（`lib/index.js`）保持有意为空的空实现，不持有服务或存储连接。引入 Host 通信会打破当前的纯前端架构基线，`localStorage` 能够轻量且独立地满足用户的本地持久化需求。
3. **复制时导出为图文混合的富文本（`text/html` + `text/plain`）**：
   - *最强理由*：一次点击可把加工后的文字和图片一起粘进富文本编辑器。
   - *否定原因*：各主流接收方（微信客户端、飞书文档、Notion、Word）对包含内联 Base64 图片的 HTML 剪贴板解析机制差异极大，绝大多数聊天应用在粘贴时会直接丢弃 Base64 图片而只保留文字；而单独复制标准 PNG 二进制位图能够 100% 保证在任意外部应用中成功粘贴为图片。

## Consequences

### 收益
- **工作流提效**：用户可将高频指令（代码审查、摘要翻译、任务拆解等）固化为一键 Chip，免去重复打字。
- **补齐图文闭环**：彻底解决了此前 DSH 复制图片只有文件名的系统级体验断层，无论是模型回复的示意图还是用户自己上传的图片，均可一键转存至剪贴板并在外部软件中直接粘贴。
- **与引文边界体系完全兼容**：自定义模板完美复用了 `<forwarded_context>` 隔离机制，下游模型依然能够准确区分引文与用户指令。

### 代价与局限
- **环境安全限制**：`navigator.clipboard.write` 必须依赖安全上下文（HTTPS / Localhost / Electron 桌面）以及用户显式手势激活，在未获授权或非安全环境中会被浏览器拦截。
- **单机存储范围**：模板保存在当前浏览器的 `localStorage` 中，若用户清除浏览器缓存或更换客户端配置，自定义模板需重新录入。
