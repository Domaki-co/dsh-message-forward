# dsh-message-forward 测试

针对 `lib/client.js` 的回归测试，全部基于**真实 DSH DOM 契约**（从 `app.asar` 里的
`ui-chat` 源码提取的类名与 `data-*` 属性）在 jsdom 中复现。

```bash
node tests/run.mjs
```

## 一次性准备

测试依赖 `jsdom`。插件本身不依赖它，所以没有写进 `package.json`：

```bash
cd tests && npm i jsdom --no-save
```

## 套件

| 文件 | 覆盖内容 |
|---|---|
| `test-extract.mjs` | 单条转发：`assistantTurnNodes` 行级回溯、只取 `assistant-step` 正文、排除用户消息与「已思考 N 秒」、`turn-error` 回退、分组嵌套穿透 |
| `test-batch.mjs` | 多选：`collectUnits` / `unitIdForNode` / `mergeUnits` 的单元识别、按时间顺序合并、未选中项排除 |
| `test-css-tokens.mjs` | CSS 里引用的每个 `--dsw-alias-*` 都必须是 DSH 真实存在的 token；底部工具条不得把硬编码深色底与主题文字色混搭 |
| `test-decorator.mjs` | 多选装饰器：装订线 class、只给 `position:static` 的宿主补定位并打标记、清理时精确还原（含摘掉空 `style=""`）、`role=checkbox`/`aria-checked`、工具条 portal 挂载 |

## 为什么有 token 测试

插件曾引用 5 个 **DSH 里根本不存在**的 token（`--dsw-alias-bg-elevated`、`-bg-hover`、
`-bg-primary`、`-bg-secondary`、`-border-secondary`）。CSS 变量取不到值时会静默回退到
硬编码兜底色，于是底部工具条变成「深色兜底背景 + 主题文字色」：浅色主题下文字是深色，
深底深字，按钮直接看不见。`dsh-theme-tokens.txt` 是当时从运行中的 Theme provider 与
`app.asar` 双向核对出的 token 清单，用来把这类错误挡在提交前。
