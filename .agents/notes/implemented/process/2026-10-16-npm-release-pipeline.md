# Agent Note: 走 npm 可信发布（OIDC）的 tag 发版链路

Status: implemented

## Problem

插件一直只以 GitHub 源的方式分发：目录条目里的安装命令是
`dsh plugin --profile web add github:Domaki-co/dsh-message-forward`，`package.json`
从未发布到 registry。这带来三个后果：

- **目录侧的下载量恒为 `null`。** awesome-dsh-plugin 的 `scripts/probe-npm.mjs`
  只承认"registry 上存在该包、且它的 `repository` 指回同一个 GitHub 仓库"的条目，
  `scripts/probe-downloads.mjs` 再对这批条目取滚动 30 天下载量写进 `plugins.json`。
  `github:`-only 条目拿到的永远是 `null`——`dshmarket` 的卡片署名行因此不显示
  `· ↓ N / 30d`，而市场的默认排序字段就是 `downloads`（`client/client.js:2070`：
  只要有下载数就排在没有的前面），`github:`-only 条目只能退化成按 stars 排。
- **安装走整仓拉取。** 没有 registry 包时，市场只能退回 GitHub 源码/Release
  tarball，比 registry tarball 慢，且对国内用户尤其不稳。
- **发版靠手工。** 版本只活在 `package.json` 与 git tag 里，没有任何东西保证
  tag 与版本号一致，也没有东西在发布前跑一遍那套回归测试。

## Decision

发布走 **npm 可信发布（Trusted Publishing / OIDC）**，由 `.github/workflows/publish.yml`
在 `v*` tag 推送时执行：**仓库里不存在任何 npm token**，npm 用 workflow 的 OIDC
身份核对包页面上配置的可信发布者，并自动签发 provenance 证明。

workflow 的五条不变量：

- **tag 必须等于 `package.json` 的版本**（`if: github.ref_type == 'tag'` +
  `v$version` 比对），版本号与 tag 不允许各自漂移。
- **发布前跑全量回归**（`cd tests && npm i --no-save jsdom react@18 react-dom@18`
  然后 `node tests/run.mjs`）。`files` 只发 `lib/`、`locale/`、`cordis.patch.yml`、
  `icon.svg`、`README.md`、`LICENSE`，测试套件不进包，所以这里是它出厂前唯一的关卡。
- **已发布的版本是 no-op**（`npm view <name>@<version>` 探到就只打 notice），
  重推同一个 tag 不会变成红叉。
- **`setup-node` 之后强制刷新 npm**（OIDC 发布要求 npm ≥ 11.5.1，runner 自带的
  可能更旧），并且 `package-manager-cache: false`——发布构建不缓存。
- **发布后必须回查 registry**（`Verify the version is live`：轮询
  `npm view <name>@<version>`），因为 `npm publish` 在 stage-only 连接下会以 0 退出却
  只入暂存队列——job 颜色不构成上线证据，见 Consequences 的"陷阱"。

一次性人工步骤（workflow 无法覆盖的部分，顺序不可颠倒）：

1. 在 npm 上认领包名并做**首次发布**——可信发布者只能配在已存在的包上，所以第一次
   必须本地交互式 `npm publish`（带 2FA）。
2. 在包页面的 Settings → Trusted Publisher 填 GitHub Actions：仓库
   `Domaki-co/dsh-message-forward`、workflow 文件名 `publish.yml`、
   environment 留空（workflow 里没有声明 environment）、**Allowed actions 勾上
   `npm publish`**。表单里 `npm stage publish` 恒允许、不参与勾选，而 2026-09-03
   之后新建的配置默认**只**给 stage publish——不勾这一项，CI 的 `npm publish` 会走
   暂存流程。配置保存后不可编辑，改只能删除重建；建好后 2 天内要有一次成功发布验证，
   否则过期作废。
3. 之后每次发版：改 `package.json` 版本 → 提交 → `git tag vX.Y.Z && git push origin vX.Y.Z`。

`repository` 字段（`git+https://github.com/Domaki-co/dsh-message-forward.git`）是目录
探针"包与仓库同源"校验的依据，不得删除或改指向。

## Alternatives considered

- **long-lived `NPM_TOKEN` + granular access token（bypass 2FA）。** 这是过去最常见的
  做法，也是唯一能覆盖"首次发布"自动化的做法，但已被 npm 主动淘汰：classic token 于
  2025-12-09 被全部吊销；bypass-2FA 的 granular token 自 2026-07-31 起被限制做账号/组织/
  包管理操作，且**将于 2027 年 1 月彻底失去直接发布权限**，官方的迁移路径只有"stage-only
  token + 人工 2FA 审批"或可信发布。选它等于现在写下一条明年必坏、且要在 GitHub 里长期
  保管一个高权限明文密钥的链路——被否。
- **只在本地手工 `npm publish`。** 零 CI 成本、零配置，但没有任何东西保证 tag 与版本一致、
  发布前跑测试，或人工不会忘记带 `--provenance`。上述不变量全都要靠纪律维持——被否。
- **`npm stage publish` + 人工审批。** 比可信发布多一道人肉确认，适合需要"打包后再看一眼"
  的发布节奏；本插件的回归测试已经充当出厂关卡，再加一层审批只是延迟，不是保护——被否。
- **继续只发 GitHub 源，不碰 npm。** 需要接受下载量恒为 `null`、默认排序天然靠后、安装慢。
  这三条都是用户可感知的损失，而代价只是"发布一次、配一次"——被否。

## Consequences

- **收益**：下载量进入目录统计（探针每日重跑，`probe-npm.mjs` 对"未发布"判定只缓存 1 天，
  所以首次发布后最快次日 `dshmarket` 卡片出现 `↓ N / 30d`，安装命令同时切到 registry 包）；
  发版有了 tag=版本号的硬约束和出厂测试关卡；provenance 免费获得。
- **代价**：首次发布必须人工做一次，且必须在可信发布者配置之前完成——这两步的顺序不能反，
  反过来 CI 会以 `ENEEDAUTH`/身份不匹配失败。`workflow_dispatch` 保留为逃生阀，可信发布在
  手动触发下同样有效。
- **约束**：npm 账号必须开启 2FA（所有包现在都要求）。包页面上的"Require two-factor
  authentication and disallow tokens"只影响传统 token，可信发布者的 OIDC 发布不受它
  约束——文档已确认，不再是待验证项。
- **陷阱：CI 绿灯不等于已上线，但"注册表查不到"也不等于没上线。** 两条实测事实：
  可信发布者只允许 stage publish 时，`npm publish` 会静默降级成暂存提交——退出码 0、
  provenance 照签、版本只在包页面等人工批准；而**直发本身也有分钟级的可见性延迟**
  （v0.2.8：job 11:47:33Z 结束，版本 11:50:40Z 才可读，日志里那句话是
  `Your package is being processed and may take a few minutes to become available.`）。
  所以判定"到底发没发"要看 stage API
  （`https://registry.npmjs.org/-/stage?package=<name>` 的 `items`）或等够时间，
  不能拿一次 `npm view` 的失败下结论——本次就因为在这段延迟窗口里查了一次，
  误判成"必须去批准"。workflow 末尾的 `Verify the version is live` 因此按分钟级窗口
  轮询（30 × 20s ≈ 10 分钟）：探到打 notice，探不到才打 warning 并在 step summary
  里给出批准入口。job 颜色和注册表瞬时状态都不构成上线证据。
- **未覆盖**：本地 `npm publish` 仍可绕过全部门禁（`prepublishOnly` 没有加），CI 只覆盖
  tag 触发的路径。
