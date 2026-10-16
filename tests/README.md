# dsh-message-forward 测试

针对 `lib/client.js` 的回归测试，全部基于**真实 DSH DOM 契约**（从 `app.asar` 里的
`ui-chat` 源码提取的类名与 `data-*` 属性）在 jsdom 中复现。

```bash
node tests/run.mjs                 # 默认：任何 SKIP 都算失败
node tests/run.mjs --allow-skip    # 逃生阀：显式允许带着依赖缺口放行
```

## 一次性准备

```bash
cd tests && npm i --no-save jsdom react@18 react-dom@18
```

依赖按套件分三档（插件本身不依赖它们，所以没有写进 `package.json`）：

| 依赖 | 谁要 | 说明 |
|---|---|---|
| 无 | `test-conformance.mjs`、`test-css-tokens.mjs`、`test-forward-wrap.mjs` | 纯静态检查（读源码 / CSS） |
| `jsdom` | `test-extract.mjs`、`test-batch.mjs`、`test-decorator.mjs` | 造真实 DOM 跑提取 / 装饰器 |
| `jsdom` + `react` / `react-dom` | `test-primitives.mjs`、`test-entry.mjs` | **`test-entry.mjs` 是唯一真正调 `apply()` 的端到端覆盖**，`test-primitives.mjs` 用 `react-dom/server` 渲染原语；插件运行时从 DSH 的浏览器模块表里取 react，测试环境得自己装 |

> **一条命令装完。** `npm i --no-save X` 会把其它同样是 `--no-save` 装进来的包清掉
> （表现为输出里的 `removed N packages`），分两次装会让先前那次的依赖消失，测试随即以
> `Cannot find module .../jsdom/package.json` 失败。

### SKIP 语义（缺依赖时怎么办）

- 缺依赖的套件**一致**走 SKIP 路径：打印 `SKIP  <suite>  (缺什么)` + 安装命令，并以 **0** 退出
  （探测集中在 `tests/_deps.mjs` 的 `loadJsdom` / `loadReact`，五个套件共用，见 `tests/_deps.mjs`）。
- `run.mjs` **默认把 SKIP 判为失败**（打印 `FAIL(skip)`，整轮 exit 非 0），并说明缺的是什么、怎么装、
  哪些覆盖被跳过了。这正是为了堵住「装了 jsdom 没装 react → 全绿 exit 0，被跳过的恰好是唯一跑
  `apply()` 与真实渲染的两套」这个空洞。
- 只有显式传 `--allow-skip` 才允许带着 SKIP 放行（exit 0），并且仍然打印醒目告警。

## 套件

| 文件 | 覆盖内容 |
|---|---|
| `test-conformance.mjs` | **插件规范符合性**（`cordis-plugin-development` 技能）：清单字段与 exports 子路径、`icon`、`locale/*.json`（及显式导出）、宿主半边的导出形态、客户端只 require 基线运行时、没有 `require("@deepseek-ai/…")`、`Mf*` 原语自洽、词表 zh/en 同键且源码里没有漏网的硬编码中文、`t()` 回落与插值、槽位注册契约、版本兼容性声明矩阵（`dshReleases`） |
| `test-extract.mjs` | 单条转发：`assistantTurnNodes` 行级回溯、只取 `assistant-step` 正文、排除用户消息与「已思考 N 秒」、`turn-error` 回退、分组嵌套穿透 |
| `test-batch.mjs` | 多选：`collectUnits` / `unitIdForNode` / `mergeUnits` 的单元识别、按时间顺序合并、未选中项排除；块间不再插 `---` 分隔线、`speakers` 按实际出现过的角色去重（`user,model` / 仅模型 / 仅用户）并随 payload 传给弹窗 |
| `test-forward-wrap.mjs` | **转发引文的成对边界**：词表里的开 / 闭标签（zh / en 逐字相同、不再有 `source=` / `role=`、`modal.roleBatchSource` 不得复活）；成对包裹（含空 / `null` 正文）；**反伪造**（正文里的 `<forwarded_context` / `</forwarded_context` 只被转义成 `&lt;…`，大小写变体同样拦得住，包裹后能闭合边界的标签恰好 2 个）；属性转义与空白折叠（引号、`&`、尖括号、换行不得把开标签拆成两行）；`forwardLabels` 的 `session` / `speaker` 取值（批量多角色、顺序、缺 `speakers` 时留空）；`contextBoundaryIssue` 的九类输入（0/0 与 1/1 开在前不告警，漏一个 / 多一个 / 闭在开之前各自报数）；以及接线不变量（初始正文与模板都走 `wrapContextBody`、`「原文」`分支仍调 `neutralizeContextBody`、告警行走 `.dsh-mf-warn` 与真实主题 token） |
| `test-css-tokens.mjs` | CSS 里引用的每个 `--dsw-alias-*` 都必须是 DSH 真实存在的 token；底部工具条不得把硬编码深色底与主题文字色混搭 |
| `test-mobile.mjs` | 移动端适配：`max-width:720px` 断点存在且与 `dsh-mobile` 对齐；`clampCenter()` 把提示气泡夹进视口（含 **-50..425 共 951 个位置的扫描**，任何位置都不许溢出）；`data-side` 的 transform 确实组合了 `--dsh-mf-tooltip-shift`（只设 `left` 不组 transform 会静默失效）；44px 触摸目标（图标按钮走 `::after` 撑点击区、关闭按钮直接放大、工具条按钮 `min-height`）；勾选框装订线同步加宽；`safe-area-inset-bottom`；快捷面板高度收紧；桌面端规则未被改动 |
| `test-decorator.mjs` | 多选装饰器，**跑真实的 `setupBatchDecorator()`**（fake document / getComputedStyle / MutationObserver + 真实 batchStore）：装订线 class、只给 `position:static` 的宿主补定位并打标记、真实点击翻转选中态、退出多选与 `cleanup()` 两条路径都把注入节点 / 注入类名 / 内联 `position` 清干净（含摘掉空 `style=""`）、`role=checkbox` / `aria-checked`、迟到的防抖不能再装饰回来。工具条 portal（`portalToBody` / `BatchToolbarPortal`）只是**源码级正则不变量**，不在本套件的 DOM 覆盖里 |
| `test-primitives.mjs` | 自有原语 `MfButton` / `MfInput` / `MfModal` / `MfToast` / `MfTooltip` 的 props 契约与渲染标记（`dsh-mf-button-*` 等），用 `react-dom/server` 而不是靠读源码 |
| `test-entry.mjs` | **端到端入口（唯一调 `apply()` 的套件）**：用 stub 的 `window.__ModuleLoader__` 接住整个浏览器产物，用 mock ctx 调 `apply()`，检查槽位 / 命令 / 词表登记、`ctx.effect` 都返回清理函数、注入的转发按钮与多选勾选框在真实 DOM 契约下生效、**卸载后不留残留且迟到的防抖定时器不能复活装饰** |

## 源码切片（`tests/_source.mjs`）

套件不直接 `indexOf` + `slice` 取 `lib/client.js` 的段落：`_source.mjs` 用 `lib/client.js` 里的
段落注释标记做切分，**标记缺失或顺序颠倒就直接抛错并指出是哪个标记**（裸切片在标记被改名时会
静默切出错误的段落，测试照样全绿）。切片范围内含 `@deepseek-ai` 的既有约束也在这里统一校验。

`test-conformance.mjs` 里的硬编码中文扫描同理：它扫「整份源码减去词表段（`文案（Client locale 服务）`
→ `图标`）」，并有**自检断言**保证尺子不会被悄悄改窄——扫描文本必须覆盖除词表段之外的每一个段落标记，
且量级不低于 60000 字符（只扫到「插件入口」那种旧写法约 5.5K 字符，会立刻被这两条断言打红）。

## 为什么有 token 测试

插件曾引用 5 个 **DSH 里根本不存在**的 token（`--dsw-alias-bg-elevated`、`-bg-hover`、
`-bg-primary`、`-bg-secondary`、`-border-secondary`）。CSS 变量取不到值时会静默回退到
硬编码兜底色，于是底部工具条变成「深色兜底背景 + 主题文字色」：浅色主题下文字是深色，
深底深字，按钮直接看不见。`dsh-theme-tokens.txt` 是当时从运行中的 Theme provider 与
`app.asar` 双向核对出的 token 清单，用来把这类错误挡在提交前。
