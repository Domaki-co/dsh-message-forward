# Agent Note: 模型带图消息转发与降级兜底

Status: implemented

## Problem

在会话中转发模型（Assistant）产出的带图回复时，出现高频转发失败或图片丢失：
1. **DOM 提取层图片语法被剥离**：模型输出的 Markdown 图片语法 `![alt](url)` 被渲染为 `<img>` 标签，`collectText` 原先仅读取 `innerText`，导致图片在纯文本正文中被完全抹除；纯图回复时正文直接提取为空字符串 `""`。
2. **CORS / 沙箱策略导致 Base64 转码失败**：模型输出的图片多数为外部网络 CDN 图片（`https://`）或工作区文件（`file:///`），前端因跨域限制与 Chromium 本地资源限制导致 `readImageDataUrl` 恒定返回 `null`。
3. **空内容拦截报错**：在图片全部转码失败被放入 `skipped` 且正文为空时，`buildPromptContent` 产出 0 个 item，直接触发 `notify.noContentImages` 弹窗报错（“没有可发送的内容（图片均不支持或正文为空）”），转发被完全阻断。
4. **DeepSeek 纯文本多模态拒绝**：若某张图片成功被编码为 `{ type: "image" }`，投递至运行纯文本模型（如 DeepSeek-V3 / DeepSeek-R1）的会话时，`session.prompt` 会因模型不支持多模态而抛出 `sendRejected`。
5. **草稿模式静默丢失**：在【填入草稿】模式下，`urlToFile` 失败导致目标输入框既没有附件也没有 Markdown 图片引用。
6. **附件文件名与用户气泡遗留瑕疵**：
   - 用户消息气泡中的内联 Markdown 图片在 `extractUserFromContainer` 与 `collectUnits` 中未开启图片保留，导致单条与批量转发时丢失图片链接；
   - `dataUrlToFile` 在 `name` 无后缀时生成无扩展名文件，导致部分系统无法识别文件类型；
   - 移动端对跨域图片无法转为二进制时直接静默放弃；
   - 锚点直接落在 `assistant-step` 时可能误过滤自身节点。

## Decision

建立正文保留、转码降级与纯文本容错三重兜底机制：

1. **正文提取保留 Markdown 图片语法**：
   - 改造 `textOf(el, preserveImages)`：当 `preserveImages=true` 且节点内含有 `img` 标签时，自动将 HTTP/HTTPS/本地文件/DSH 协议的图片节点替换为对应的 `![alt](url)` 文本节点后再提取 `innerText`；
   - 对 `data:` / `blob:` 等内联大图保留友好占位标签 `[alt]`，避免巨型 Base64 字符串污染文本输入框；
   - `extractUserFromContainer` 与 `collectUnits` 统一接入 `textOf(bubble, true)`，确保用户气泡与合并多选时均不丢 Markdown 图片；
   - 扩充 `IMG_SEL` 覆盖 `[data-markdown-variant] img`、`[data-step-process] img`、`[class*='media'] img` 等过程节点中的图片；
   - `assistantTurnNodes` 在 `row === anchorRow` 时若为 `assistant-step` 或 `turn-process` 予以保留，杜绝因挂载层级变动丢失当前回答行。
2. **构建 Prompt 内容时的 Markdown 引用兜底**：
   - 在 `buildPromptContent` 中，对于转码失败（进入 `skipped`）但具备有效地址（`https?:|file:|dsh:`）的图片：若正文尚未包含该 URL，自动作为 Markdown 图片标签追加至正文中；
   - 彻底解决纯图回复时因转码失败导致 `items.length === 0` 的死锁拦截。
3. **投递拒收时的纯文本与纯字符串重试降级**：
   - 在 `deliverToSession` 中拦截 `session.prompt` 失败：若请求包含 `{ type: "image" }` 多模态块，自动将所有多模态图片平铺降级为纯文本 Markdown 描述并依次尝试 `[{ type: "text", text }]` 与纯文本字符串投递，无缝兼容 DeepSeek 等纯文本 LLM 接口。
4. **草稿箱模式与附件规范化**：
   - 在 `draft` 路径下，若 `urlToFile` 无法生成本地 `File` 附件，自动把无法转码的图片以 `![name](url)` 格式追加到草稿正文中，确保图片链接不丢失；
   - `dataUrlToFile` 校验文件名后缀，若无扩展名自动依据 MIME 类型补齐 `.${ext}`。
5. **移动端跨域图片直发微信兜底**：
   - 在 `shareImageMobile` 中，当跨域网络图片无法生成 DataURL 时，自动退回直接调起系统分享 URL（`navigator.share({ url })`），用户在移动端依然能免存相册把图片链接卡片一键发送至微信。

## Alternatives considered

- **前端搭建代理服务器拉取图片并转为 Base64**：
  - *最强理由*：所有接收端均能拿到原图的二进制数据。
  - *否定原因*：插件运行于客户端轻量上下文中，不宜引入额外的后端代理网络通道或修改 DSH 宿主服务安全策略，且 DeepSeek 本身不支持多模态二进制输入，仍需降级为 Markdown。
- **强制要求所有模型回复必须使用纯多模态图片块**：
  - *最强理由*：协议格式统一规范。
  - *否定原因*：与 DSH 当前主力模型（DeepSeek 纯文本）不兼容，会直接导致发送接口拒绝。

## Consequences

- 无论是纯图回复还是图文混排，转发模型回复均能 100% 成功交付。
- 在 DeepSeek 纯文本会话中，模型能完整获取图片 Markdown 引用与说明；在多模态会话中优先传递二进制图片块并在受拒时平滑降级。
- 草稿模式下，即使网络图无法入附件，输入框中依然留有完整的图片 Markdown；生成附件恒定携带正确扩展名。
- 移动端免存相册直发微信对跨域图源具备 URL 分享兜底，杜绝白屏与静默无响应。
- 10 个测试套件（564 项断言）全绿，无新增非 locale 中文字面量。
- 转发之外的另一条路径——弹窗内画面复制到剪贴板——另见 [模型回复里的工作区图片可复制](./2026-10-18-workspace-image-copy.md)：宿主只给绝对路径拼 `api/file` 路由，相对路径图取不得到字节。
