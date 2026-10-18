# Agent Note: 模型回复里的工作区图片可复制

Status: implemented

## Problem

同一张图片, 用户自己发出去的在转发弹窗里能复制位图, 模型回复里的却一律失败 (报 `error.imageReadFailed`)。

差异来自宿主给 `<img>` 的地址来源:

- 用户自发图片走附件通道: `entry.binding.session.readAttachment(attachmentId)` → `URL.createObjectURL(new Blob([bytes], { type: mediaType }))`, 得到 `blob:` 地址, 插件 `readOneImageDataUrl` 用 XHR 直接读得到字节。
- 模型回复里的图片是 Markdown, 地址由宿主 `dsh-client-ui-chat/lib/client.js` 的 `fileMediaUrl(base, path)` 决定:

```js
function fileMediaUrl(base, path) {
    if (!/^https?:/u.test(base) && !base.startsWith("dsh-app://app/") || !isAbsoluteWorkspacePath(path) || /^[/\\\\]{2}/u.test(path) || /[\u0000-\u001f\u007f]/u.test(path)) return void 0;
    return new URL(`api/file?path=${encodeURIComponent(path)}`, base).href;
}
```

它只给**绝对路径**拼宿主鉴权文件路由 `api/file?path=<绝对路径>`。模型却常写工作区相对路径, 例如 `![压缩后的图片](compressed_bunny-girl_1063x1594.jpg)` (实测会话 `session-17236f1a`, 文件确实在工作区根下)。`isAbsoluteWorkspacePath` 对相对路径返回 false → 返回 `undefined` → 页面把相对路径按文档基址解析成 `http://127.0.0.1:19387/compressed_bunny-girl_1063x1594.jpg` → 404。插件 XHR 拿到 404 页面, FileReader 读不出图片, canvas 也画不出来, 于是复制失败。

"转发成功但复制失败" 之前就是这个原因被掩盖的: 转码失败的图片会降级成 Markdown 链接塞进正文, 所以只有位图复制这一条路径暴露了 404, 见 [模型带图消息转发与降级兜底](./2026-10-18-assistant-image-forward-fallback.md)。

## Decision

提取层把消息里原本写的地址还原成工作区绝对路径, 再按宿主同一拼法补出 `api/file` 地址, 作为**同一张图的备用读取地址**与显示地址并存; 读取时按候选链依次尝试。

- `authoredImagePath(rawSrc, cwd)` (lib/client.js): 把 `src` 属性还原成工作区绝对路径。依次识别 `dsh-resource://file/session/<sid>/<path>` 与 `dsh-resource://file/absolute/<path>`、绝对路径 (POSIX / 盘符 / UNC)、以及相对路径 (去掉 `./` 前缀后拼到会话 `cwd` 上)。`data:` / `blob:` / `http(s):` / `file:` 返回空串, 继续走原有通道。协议相对地址 (`//`) 与控制字符一律拒绝, 与宿主 `fileMediaUrl` 的条件同口径。
- `hostFileMediaUrl(path)` (lib/client.js): `new URL("api/file?path=" + encodeURIComponent(path), document.baseURI).href`。base 取 `document.baseURI`, 因此地址与页面同源、自带会话 cookie, XHR 可直接取字节; 这是宿主既有路由, 不新增对外通信。
- `cwdOfSession(sessionId)` (lib/client.js): 从会话快照读 `cwd`。**必须由提取层自带**: 会话业务层的 `sessionCwd()` 在更靠后的段落, 测试按段落切割后单独 eval, 提取层反向依赖它会直接 ReferenceError。
- `liveSessionId()` (lib/client.js): 主视图正在浏览的会话 (`retainedBy.mainView > 0`)。用户消息转发与长按多选两个入口没有 slots props 传 sessionId, 原先各自内联了同一段推导, 现在共用一个 helper。
- `collectImages(root, sessionId)` 产出的图片对象是 `{ url, altUrl?, authored, name }`: `url` 是首选读取地址 (工作区图即 `api/file` 路由, 其余仍是页面渲染地址), `altUrl` 是同一张图的页面渲染地址, `authored` 是消息原本写的地址。地址白名单由"必须是已知 scheme"改为"工作区路径先走 `api/file` 分支, 兜底分支再按 http(s)/blob/file/dsh 与内联 data 收口"——旧白名单 `/^(https?:|blob:|file:|dsh:)/i` 会把页面渲染出的相对地址整条丢掉。
- `readImageDataUrl(url, altUrl)` (lib/client.js) 变成候选链: 依次尝试 `url`、`altUrl`, 单地址实现原样留在 `readOneImageDataUrl(url)`。复制、Web Share 直发、prompt 图片块、草稿附件四条路径都透传 `altUrl`, 主地址能读时不多发一次请求。

转发正文的图片引用用 `authored` 而不是 `url`: 工作区相对路径原样保留 (同一工作区的目标会话仍能解析), 绝不把插件内部补出来的 `api/file?path=<本机绝对路径>` 或 `127.0.0.1` 地址写进转发正文。

## Boundaries

- 外部 `https` 且无 CORS 的图、`file://` 本地图客户端仍然读不到字节, 仍然只降级成 Markdown 链接。本次只解决"宿主自己就能取的图"。
- 依赖宿主 `api/file?path=` 的拼法。宿主路由或参数名一变, 复制会退回本文描述的失败形态; README 已声明宿主 DOM / 内部接口变更不在自检范围。
- 每次 `collectImages` 会读一次会话快照拿 `cwd`, 与 `sessionCwd()` 同一开销量级。

## Alternatives considered

- **走宿主资源系统取字节** (`dsh-resource:` + `ResourceRegistry.source` + `workspaceFiles.readBytes`):
  - *最强理由*: 那是宿主为工作区文件设计的正式通道, 不依赖 `api/file` 的 URL 拼法。
  - *否定原因*: `createFileResourceProvider` 只 yield `WorkspaceFileStat` (`absolutePath` + `version`, 没有 URL), 字节要另走 `readBytes`; 全仓只有 `dsh-client-ui-sidebar-documentpreview` 同时用 `useResource` + `readBytes`, 插件在自己的 slot 里复用要自己接 provider 与订阅生命周期, 代价远高于一次同源 XHR。
- **让宿主侧修 `fileMediaUrl` 支持相对路径**:
  - *最强理由*: 根因在宿主, 修一次所有消费方受益。
  - *否定原因*: 这是本插件仓库外的代码, 发版节奏不受控; 插件能自愈就不等上游。
- **host 半边加一个读图服务**:
  - *最强理由*: 客户端不必关心地址与协议。
  - *否定原因*: 本插件的 `lib/index.js` 是有意为之的空实现 (纯客户端插件, 不注册任何宿主服务/工具), 为一张图的字节破这条边界不值。
- **只做"复制链接"降级, 不碰地址**:
  - *最强理由*: 与上次裁决 (右键复制图片属功能新增) 一致, 零风险。
  - *否定原因*: 这是功能错误而非新功能——同一张图用户发的能复制、模型发的不能, 且模型产出的图恰恰是转发的常见对象。

## Consequences

- 模型回复里指向工作区文件 (以及相对路径、`dsh-resource:` 会话地址) 的图片, 复制、移动端分享、转发图片块、草稿附件四条路径都能拿到字节。代价是多一层地址还原逻辑与一条只在主地址失败时才走到的候选读取。
- 图片字节的四条通道（复制到剪贴板、移动端分享、多模态投递载荷、草稿附件）都按还原后的原路径取字节。
- **已知限制一**: 转发**正文文本**里的那段 Markdown 仍按 `<img>` 的解析地址生成——`textOf` 取 `img.currentSrc || img.src` 优先于原始属性（`lib/client.js:1775`），于是工作区绝对路径图写作 `api/file?path=%2FUsers%2F...`、模型写的相对路径图写作同源绝对 URL（在目标会话里是 404），并非消息原本写的路径；`buildPromptContent` 里 `body.includes(authored)` 的去重也因此失效，转码回退时同一张图会写两遍。修复方向是优先取原始 `src` 并把 `api/file?path=` 反解回原路径，留待下一轮带断言处理。
- **已知限制二**: 为保留图片语法，带图节点是 `cloneNode` 之后读 `innerText`（`lib/client.js:1772-1795`）。按 HTML 规范，不在渲染树中的节点其 `innerText` 退化为 `textContent`，因此真实浏览器里同一 markdown 块内的段落换行会并成一行；jsdom 没有 `innerText`，现有断言全部走在 `textContent` 分支上，覆盖不到这一层。
- 用户自发图片 (`blob:`)、外部 https 图的行为不变。
- 10 个测试套件 564 项断言全绿。新增覆盖: `tests/test-extract.mjs` 的相对路径 / 绝对路径 / `dsh-resource` / 远程图 / blob 图地址还原与拒绝协议相对地址、非文件 scheme; `tests/test-session.mjs` 的正文兜底改用 `authored`。
