# Agent Note: 宿主 DOM 契约漂移检测（`tests/host-drift.mjs`）

Status: implemented

## Problem

插件靠宿主渲染出来的属性定位每一行消息，而仓库里没有任何东西在核对宿主：

- `tests/` 的 10 个套件跑的全是本仓复刻的 DOM 契约（见 `tests/README.md`）。宿主把 `data-chat-flow-kind` 改名，它们照样全绿——漂移进来时插件不抛错，只会少转发或转发错行。
- 实测本机宿主是 **0.2.1-rc.2**，而 `package.json` 的 `dsh.compatibility.dshReleases` 只列到 `0.2.1-alpha.4`。「声明了什么」与「核对过什么」是两件事，此前没有任何机械手段能判断后者。
- `README.md:289` / `README.en.md:281` 曾把 `0.2.0-rc.2` 说成「官方桌面客户端当前主流版本」，与实测矛盾——这正是 `2026-10-16-claim-accuracy-and-change-triage.md` 立过的规矩：无法机械证实时，把「如何才算验证过」写进清单，由人去执行。

## Decision

**一、新增 `tests/host-drift.mjs`（离线、零依赖、不联网）**

- 读安装好的宿主单文件 `app.asar`（本机 182,833,898 字节）。宿主版本按 asar 头公式取：`contentBase = 8 + UInt32LE(4)`，JSON 从 offset 16 开始，长度 `UInt32LE(12)`，再按 `files.dsh.files["package.json"]` 的 `offset/size` 读出 `version`；读不出就跳过版本行，不影响检查。
- 正文按 8 MiB 分块 + 300 字节重叠流式扫描（`latin1` 解码，1 字节 = 1 字符，窗口按字节算）。本机 21 条契约、1 遍 1.6s。

**二、分级决定退出码**

| 级别 | 条数 | 缺失时 | 判据 |
|---|---|---|---|
| `required` | 8 | exit 1 | 核心路径上没有等价替代：行枚举（`data-chat-flow-kind`/`data-chat-flow-key`/`data-chat-turn`）、收尾行定位（`data-turn-tail`）、滚动容器（`data-conversation-scroll`）、用户消息注入点（`data-clock=start`）、思考链排除（`data-markdown-variant=compact`、`data-variant=think`） |
| `enum` | 6 | exit 1 | `data-chat-flow-kind` 的取值，缺一个就认错行 |
| `fallback` | 4 | 只告警 | 只出现在 OR 兜底选择器里的分支：`data-turn-process-inline`（THINK_SEL 五支之一）、`data-process-activity`（仅退化路径）、`data-step-process`（IMG_SEL 六支之一）、`data-image-viewer` |
| `canary` | 3 | 只告警 | 构建期哈希类名 `icaHSq_flowItem` / `IzP3Va_userRow` / `ppByMG_actions` |

把 `data-image-viewer` 判成 required 会让这道门**第一天就是红的**（0.2.1-rc.2 里它计数为 0），它只是 `lib/client.js:4164` 那串 fallback 的最后一项；3 个哈希类名同理——插件用的是 `[class*='flowItem']` 子串匹配，前缀变了不影响功能，但说明宿主重新构建过。一道永远红、没人会修的门等于没有门。

**三、属性的取值形态不可假设，逐条按宿主的真实写法取证**

- `data-chat-flow-kind`：宿主 JSX 是 `"data-chat-flow-kind": routedNode.kind`，取值来自变量。`turn-process` / `user` / `steering` / `turn-trigger` 以 CSS 选择器形态出现；`assistant-step` / `turn-tail` 只以 `node.kind === "V"` 形态出现。故每个取值"选择器形态 或 kind 比较形态"任一命中即 PASS。
- `data-clock=start`：宿主是 `"data-clock": clock` 加 `clock === "start"`，不是连写字符串 → 用 ±300 字节邻近窗口判定（本机 2 处命中，其中 1 处邻近出现 `start`，另一处是 CSS 的 `[data-clock=end]`）。
- `data-variant=think`：宿主写 JSX 属性对 `"data-variant": "think"`；`data-variant=think` 连写串计数为 0 → 两种形态都匹配。

**四、矩阵一条不加，改为写清进档判据**

`0.2.1-rc.2` 只在 DOM 契约这一条轴上被机械证实，不等于整插件兼容，故不进 `dshReleases`。两份 README 新增「发布前核对宿主兼容性」，把进矩阵的三条判据写明：① 该宿主上 `node tests/host-drift.mjs` exit 0；② 真机手工过核心链路（单条转发 / 多选合并 / 三种投递模式 / 用户消息操作行注入 / 深色浅色主题）；③ `npm test` 全绿。缺一条只留在范围声明里当「预期可用」。

**五、`--self-test` 证明这道门会红**

合成两份 asar（一份含全部 `sample`、一份删掉 `data-variant=think` 的 sample）并断言子进程退出码为 0 / 1，另加「宿主不存在 → SKIP + exit 0」。防的是"这道门哪天悄悄变成永远绿"。

## Alternatives considered

- **做成 `run.mjs` 的第 11 套**：否。它需要装好的宿主，CI 与没装客户端的机器会 SKIP，而 `run.mjs` 默认把 SKIP 判定为失败——等于给所有人和所有 CI 一条红。改为独立命令 + 发布前清单一行。
- **解压 asar 后扫 js 目录**：没这个必要，宿主是单文件 asar（`app.asar.unpacked` 215 MB 里不含这些属性），多一步解压只增加失败面。
- **直接把 `0.2.1-rc.2` 加进 dshReleases**：否，违反 2026-10-16 note 的规矩（没实测不标 compatible）。
- **只做 required 不做 canary**：否。哈希类名变化是"宿主重构建过"的最早信号，成本几乎为零。

## Consequences

- 21 条契约多了一份维护面：宿主改 DOM 时要同时改 `lib/client.js` 的选择器与本脚本的 `sample`/`match`；漏改的风险由 `--self-test` 与证据列（命中次数、插件引用行号）兜住。
- 顺带修正 `README.md:247` / `README.en.md:239` 的断言数（490 → 608，实测），并删掉「0.2.0-rc.2 是当前官方主流版本」这类会过期的断言。
- 仍是**单轴**检测：API、生命周期、主题样式漂移都不在范围内，`exit 0` 只能是进矩阵的必要条件之一。

## 验证

```bash
node tests/host-drift.mjs                 # exit 0：required 8/8 · enum 6/6 · fallback 3/4 · canary 3/3
node tests/host-drift.mjs --self-test     # exit 0：三个用例（完整 / 残缺 / 缺宿主）全部符合预期
DSH_HOST_ASAR=/nope.asar node tests/host-drift.mjs   # SKIP + exit 0
npm test                                  # 10 套全绿
npm run check:host                        # 与第一条等价
```
