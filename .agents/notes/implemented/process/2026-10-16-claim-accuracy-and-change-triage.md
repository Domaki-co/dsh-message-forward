# Agent Note: 声明口径必须与代码一致（附改动必要性判据）

Status: implemented

## Problem

外人能读到的东西只有两份：`README.md` / `README.en.md` 里的「规范符合性」表与「安全与权限声明」，以及代码里的注释。它们此前多处与代码实际行为不符，最严重的一类是**把降级描述成升级**——读者照着 README 判断能不能装，装完发现不是那么回事：

- `README.md:224`「80 组文案」：locale 段（`lib/client.js:68-321`）里 MF_ZH / MF_EN 各 **93** 个键（共 186 条键值行）；90 个键以字面量 `t("…")` 调用，3 个走 `tipKey`（`lib/client.js:1824/1834/1838`），不存在「用了但没定义」的键。
- `README.md:270`「不使用任何外部网络通信 API……图片仅通过离屏 Canvas 与本地 Blob 解码」：`readImageDataUrl`（`lib/client.js:1893-1894`）对 `blob:` / 同源 / 远程地址走 `XMLHttpRequest` + `FileReader`，离屏 Canvas 只是跨源被拒时的兜底；`collectImages`（`lib/client.js:1584`）的地址白名单本身就含 `https?:`。
- `README.md:223`「颜色与层级全部取自 `--dsw-alias-*`，由自动化测试防护」：`lib/client.js` 有 14 处非 token 色值（`708`、`732`、`771`、`926`、`1015-1019`、`1080`、`1100`、`1123`、`1253-1254`、`1293`），而 `test-css-tokens.mjs` 只断言「引用的 token 必须真实存在」。
- `README.md:222`「零引用 Harness Client 内部包，仅声明并使用公共基线运行时」：`package.json:31-37` 声明了 5 个 `@deepseek-ai/*` peerDependencies（激活顺序）；不 require 是真的，「仅使用基线运行时」这个措辞不是。
- `README.md:230`「（由 `test-entry.mjs` 全面覆盖）」：该套件跑的是本仓复刻的 DOM 契约，真实宿主的 DOM 变更不在可自检范围内。
- `lib/client.js:44-51`「规范明确禁止…」：原文（`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:35`）是 “Do not `require(...)` … `dsh.client.inject` entries only order activation and stay allowed”；本仓真正的执行者是 `tests/test-conformance.mjs:152-156`（硬断言只 require `react` / `react-dom`、无 `@deepseek-ai/*` require）。
- `tests/README.md:3-5`「全部基于真实 DSH DOM 契约……在 jsdom 中复现」：10 套里只有 5 套用 jsdom；依赖分档表漏了 `test-session.mjs` / `test-mobile.mjs`，套件表漏了 `test-session.mjs`。

另一半问题是判据缺失：审计产出的「必要改动」清单把「删死代码 / 合并 observer / 加 token 快照」这类纯整洁项与「用户可感知的功能矛盾」并列在同一优先级上，于是没人知道该先做什么、也没人知道什么可以永远不做。

## Decision

**一、文件里的声明是契约。** `README.md`、`README.en.md`、`tests/README.md` 与本仓代码注释里每一句关于行为的断言，都必须是代码或测试能直接验证的；做不到就改写成可验证的范围（写「测试只校验引用的 token 是否存在」，不写「由自动化测试防护」）。声明与代码不一致时先分清是谁错：**功能性的诚实优先于文案好看**——宁可写「会经由网络读取 API，读的是宿主已渲染的那张图」，也不把 XHR 说成 Canvas。

**二、必要改动只有三条判据**，命中任意一条才算必要：

1. 用户可感知的功能错误（「不优雅」不算）；
2. 对外声明与代码行为不一致，且审阅者 / 安装者能直接证伪；
3. 静默失效风险——改了却看不出没生效（新增测试不被执行、发布产物缺文件）。

只满足「更整洁 / 更快 / 更少代码 / 更现代」的，一律不列为必要，最多进「有空再做」。

## 本次落地的六处声明修正

| 位置 | 旧口径 → 新口径 |
|---|---|
| `README.md:222` / `README.en.md:214` | 「零引用内部包，仅声明并使用公共基线运行时」→「不 require `@deepseek-ai/*`；`peerDependencies` + `dsh.client.inject` 只声明激活顺序与注入面」 |
| `README.md:223` / `README.en.md:215` | 「全部取自 token，由自动化测试防护」→「结构色与层级走 token；角色徽章等少量强调色固定色值；测试只校验 token 是否存在」 |
| `README.md:224` / `README.en.md:216` | 80 组 → **93 组**文案 |
| `README.md:230` / `README.en.md:222` | 「由 `test-entry.mjs` 全面覆盖」→ 枚举实际覆盖（注入 / 继位 / aria / 词表 / 卸载）+ 明确「宿主 DOM 变更不在可自检范围」 |
| `README.md:270` / `README.en.md:262` | 「零网络访问」→「**零外发请求**」，并写清 XHR + FileReader 与 Canvas 兜底的关系 |
| `lib/client.js:45`、`lib/client.js:1893` | 引规范原文（`practices.md:35`）+ 指出本仓执行者是 `tests/test-conformance.mjs:152-156`；取图注释如实描述读的是已渲染地址 |
| `tests/README.md:3-5` / `22-24` / `45` | 「全部基于真实 DOM 契约」→「5 套基于真实 DOM 契约，其余为纯静态 / 纯函数检查」；两处表格补齐 `test-session.mjs` / `test-mobile.mjs` |

`lib/client.js` 的两处注释改写**刻意保持行数不变**（8 行 → 8 行、1 行 → 1 行）：[工作区范围笔记](../feature/2026-10-15-forward-target-workspace-scope.md) 与 [引文边界笔记](../feature/2026-10-16-forward-context-boundary.md) 引用了 `lib/client.js:148/169/254/275/1794/1799/2593/2667` 等行号，注释多一行，这些引用就整体错位。

## 必要改动判定（本轮结论）

**必要、尚未落地**（本轮只落实文档）：

1. **草稿队列的四个窗口互相矛盾**（判据 ①）：四个常量写在 `lib/client.js:1442-1445`——广播间隔 250ms × 40 ≈ 10s、`DRAFT_ACK_TIMEOUT_MS = 4000`、`DRAFT_PENDING_TTL_MS = 30000`。用户在 4s 时已经收到「未填入」提示，但广播还在继续（到 ~10s），pending 也还留着（到 30s，`take()` 在 `lib/client.js:1500` 才丢弃）——目标会话晚一步挂载，这份已经被宣告失败的草稿仍会突然出现。要么让三个窗口同源（都取 10s），要么在提示「未填入」时真正作废 pending。
2. **`tests/run.mjs:16-27` 的套件清单是手写数组**（判据 ③）：新增 `test-*.mjs` 不会被跑。`run.mjs` 已经把「SKIP 算失败」当默认，这条是同一意图的延伸。
3. **`package.json:16-23` 的 `files` 只带 `README.md`**（判据 ②）：npm 包里没有 `README.en.md`，英文用户在 npm 页面读不到英文 README（见 [npm 发布链路笔记](2026-10-16-npm-release-pipeline.md)）。

**明确判定为不必要**（本轮否决）：

- 删掉草稿模式整块功能：`draftHub` 的持久重试是「目标会话还没挂载」时的唯一可用路径，删掉是真降级而非简化 → 只修窗口矛盾。
- 改用宿主 `dsh-client-ui-primitives`（可省 ~360 行自有原语）：`practices.md:35` 点名不要，且宿主不保证加载 → 拿稳定性换行数，不做。
- 删 `dshReleases` 矩阵或改成构建期生成：数据当前正确、无人消费，删除还要动 `test-conformance.mjs` 的断言，收益为零。
- 删死代码 / 死 CSS、合并双 observer、加主题 token 快照：零用户影响、零风险暴露。
- 字节级正则断言换行为断言、重写 `input.shell`、`data-*` 选择器换更稳契约：都需要实机验证或平台侧支持，属独立课题。

## 验证

`node tests/run.mjs` 全 10 套 490 断言通过（conformance 81 / extract 19 / session 45 / batch 34 / forward-wrap 68 / css-tokens 46 / mobile 43 / decorator 30 / primitives 54 / entry 70）。`git diff --numstat` 显示四个文件都是等量替换（`tests/README.md` 净 +2 行为新增表格行），`lib/client.js` 行数不变；上述 8 个被笔记引用的行号逐条与 `HEAD:lib/client.js` 比对一致。

## Alternatives considered

- **A1 只改数字（80 → 93），其余口径不动。** 最强理由：改动面最小、不触碰语义，也避免「把降级写进 README」的尴尬。否掉：另外四处是行为口径错误，审阅者读一眼代码即可证伪；留着不但没省事，还让「规范符合性」整张表失去可信度。
- **A2 改代码去迁就文档**（取图放弃 XHR 改纯 Canvas、硬编码色全换 token），这样 README 几乎不用改。最强理由：文档与实现都更干净。否掉：Canvas 在跨源图上会 taint / 导出失败，XHR + FileReader 是可靠主路径；14 处固定色是刻意的角色强调色（不随主题翻转），不是待还的债。为文案好看而降级功能是本末倒置。
- **A3 把草稿窗口的矛盾写进 README「已知限制」。** 最强理由：诚实，且本轮只改文档即可闭环。否掉：README 的「已知限制」写的是平台侧约束，把自己的缺陷写成 limitation 会让后来者以为那是设计；修代码只要几行，比解释它便宜（本轮用户要求的是落实文档，故留作待办）。
- **A4 判据与结论单独立一篇 `simplification` 笔记。** 最强理由：判据可独立检索、独立演进。否掉：判据的价值恰恰在于约束「声明准确性」这一件事，拆开后两篇都不完整；本轮只落地了声明修正，另开的简化提案会是一篇没有代码的空转记录。

## Consequences

- 收益：README 上每句关于行为的话都能被代码逐条验证；「必要」有了三条可复用判据，后续审计不再把整洁项与功能缺陷混为一谈；三个未落地的必要项各自带证据与行号，接手即可动手。
- 代价：README 里出现了减分句（「会经由网络读取 API」「测试只校验 token 是否存在」「宿主 DOM 变更不在可自检范围」）。对市场文案不算加分，但比被安装者当场证伪便宜。
- 代价：`lib/client.js` 的两处注释为了保持行数不变而压成长行 / 合并句，可读性略降。这是给既有笔记里 8 处行号引用让路的临时约束；若将来这些引用改按符号名定位（`draftHub` / `readImageDataUrl`），可以放开重排。
