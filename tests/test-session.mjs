// 会话业务层：归档过滤 + 工作区范围。
//
// 这一套盯的是两个曾经无覆盖、且真出过事的点：
//   1. 已归档会话不得进入转发目标列表。早先 sessionRows() 复用 workspaceSnapshot() 取归档集，
//      而后者在 items 非数组时返回 null，于是整个归档过滤被静默跳过 —— 已归档会话照常出现。
//      归档集与 items 是 ClientWorkspaceModel 上互不依赖的两个字段，必须各自判定。
//   2. 工作区筛选条的构成与范围筛选的优先级分支。
import { sessionSrc, localeSrc } from "./_source.mjs";

const t = (key) => key;

/** 用给定 ctx 跑一次会话业务层，返回可调用的 API。 */
function loadSessionApi(ctx) {
  return new Function("t", "console", `
    let __ctx = ${JSON.stringify(null)};
    const api = (function(){ ${sessionSrc.replace(/\bctxRef\b/g, "__ctx")}
      return { sessionRows, workspaceSnapshot, archivedSessionIds,
               workspaceOwnerIndex, workspaceRowsFrom, scopeSessionRows,
               resolveDefaultScope, SCOPE_ALL, SCOPE_UNGROUPED, DEFAULT_WORKSPACE_TITLE,
               buildPromptContent, dataUrlToFile };
    })();
    return { set ctx(v) { __ctx = v; }, api };
  `)(t, console);
}

/** 造一个 ctx：sessions 给 byId，workspaces 给任意快照（含畸形值）。 */
function makeCtx(byId, wsSnapshot) {
  return {
    sessions: { list: { getSnapshot: () => ({ byId, ids: Object.keys(byId) }) } },
    workspaces: { list: { getSnapshot: () => wsSnapshot } },
  };
}

let passed = 0;
const failures = [];
function ok(label, condition) {
  if (condition) { passed += 1; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}`); }
}
function eq(label, actual, expected) {
  // 结构化比较：数组 / 对象按 JSON 值判等，标量仍按 ===。
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(`${label} (${JSON.stringify(actual)} === ${JSON.stringify(expected)})`, same);
}

const ARCHIVED = "session-archived-1";
const LIVE = "session-live-1";
const byId = {
  [ARCHIVED]: { id: ARCHIVED, displayTitle: "已归档", updatedAt: 10, cwd: "/a" },
  [LIVE]: { id: LIVE, displayTitle: "活跃", updatedAt: 20, cwd: "/b" },
};

console.log("\n[1] 归档会话必须被剔除（回归：items 未就绪时不得连带跳过归档过滤）");
{
  const cases = [
    ["归档集已填充", { items: [], archivedSessionIds: [ARCHIVED] }, 0],
    ["归档集为空数组", { items: [], archivedSessionIds: [] }, 1],
    ["归档集字段缺失", { items: [], archivedSessionIds: undefined }, 1],
    ["items 非数组 + 归档集有值", { archivedSessionIds: [ARCHIVED] }, 0],
    ["items 非数组 + 归档集为空", { archivedSessionIds: [] }, 1],
    ["快照为 null", null, 1],
    ["归档集非数组（脏值）", { items: [], archivedSessionIds: "oops" }, 1],
    ["归档集含 null 项", { items: [], archivedSessionIds: [null, ARCHIVED] }, 0],
  ];
  for (const [label, wsSnapshot, expectedLeak] of cases) {
    const h = loadSessionApi();
    h.ctx = makeCtx(byId, wsSnapshot);
    const leaked = h.api.sessionRows().filter((r) => r.id === ARCHIVED).length;
    eq(label, leaked, expectedLeak);
  }
}

console.log("\n[2] 归档集读取与工作区快照解耦");
{
  const h = loadSessionApi();
  h.ctx = makeCtx(byId, { archivedSessionIds: [ARCHIVED] });
  eq("items 非数组时 workspaceSnapshot() 仍返回 null（降级语义不变）", h.api.workspaceSnapshot(), null);
  eq("但 archivedSessionIds() 照常读到归档集", h.api.archivedSessionIds(), [ARCHIVED]);

  const h2 = loadSessionApi();
  h2.ctx = makeCtx(byId, null);
  eq("workspaces 快照为 null 时归档集为空", h2.api.archivedSessionIds(), []);

  const h3 = loadSessionApi();
  h3.ctx = { sessions: { list: { getSnapshot: () => ({ byId }) } } };
  eq("workspaces 服务缺失时归档集为空（不抛错）", h3.api.archivedSessionIds(), []);
}

console.log("\n[3] 会话行的字段投影");
{
  const h = loadSessionApi();
  h.ctx = makeCtx(byId, { items: [], archivedSessionIds: [] });
  const rows = h.api.sessionRows();
  eq("按 updatedAt 倒序", rows.map((r) => r.id), [LIVE, ARCHIVED]);
  eq("标题取 displayTitle", rows[0].title, "活跃");
  eq("cwd 透传", rows[0].cwd, "/b");
  eq("无归属工作区的会话 workspaceId 为空串", rows[0].workspaceId, "");
}console.log("\n[4] 工作区归属反查");
{
  const h = loadSessionApi();
  h.ctx = makeCtx(byId, {
    items: [
      { workspaceId: "w1", sessionIds: [LIVE] },
      { workspaceId: "w2", sessionIds: [ARCHIVED, LIVE] },
    ],
    archivedSessionIds: [],
  });
  const rows = h.api.sessionRows();
  const byIdOut = Object.fromEntries(rows.map((r) => [r.id, r.workspaceId]));
  eq("命中第一个声明该会话的工作区（不覆盖）", byIdOut[LIVE], "w1");
  eq("另一会话归到 w2", byIdOut[ARCHIVED], "w2");
}

console.log("\n[4b] 与侧边栏可见性同口径：子代理与空会话都不得进入转发目标");
{
  // 侧边栏 sessionVisible()：origin === "subagent" 不列；blank 不列；
  // 已归档按 default 口径不列。插件此前只做了归档这一条。
  const SUB = "subagent-1";
  const BLANK = "blank-1";
  const mixed = {
    [LIVE]: { id: LIVE, displayTitle: "主会话", updatedAt: 30, retainedBy: { mainView: 1 } },
    [SUB]: { id: SUB, displayTitle: "子代理", updatedAt: 25, origin: "subagent", parentId: LIVE },
    [BLANK]: { id: BLANK, displayTitle: "空会话", updatedAt: 20, blank: true },
    [ARCHIVED]: { id: ARCHIVED, displayTitle: "已归档", updatedAt: 10 },
  };

  const h = loadSessionApi();
  h.ctx = makeCtx(mixed, { items: [], archivedSessionIds: [ARCHIVED] });
  const ids = h.api.sessionRows().map((r) => r.id);
  eq("只留下活跃主会话", ids, [LIVE]);
  ok("子代理会话被剔除", !ids.includes(SUB));
  ok("空会话被剔除（等同新建，转发无意义）", !ids.includes(BLANK));
  ok("已归档会话被剔除", !ids.includes(ARCHIVED));

  // 空会话即便就是当前会话也剔除：转发给「没有任何消息的会话」等同新建。
  const h2 = loadSessionApi();
  h2.ctx = makeCtx(
    { [BLANK]: { id: BLANK, displayTitle: "空会话", updatedAt: 20, blank: true, retainedBy: { mainView: 1 } } },
    { items: [], archivedSessionIds: [] },
  );
  eq("当前空会话同样剔除", h2.api.sessionRows(), []);

  // 三个条件互不干扰：各自单独成立时都要生效。
  const h3 = loadSessionApi();
  h3.ctx = makeCtx(
    {
      ok1: { id: "ok1", displayTitle: "正常", updatedAt: 3 },
      sub: { id: "sub", displayTitle: "子代理", updatedAt: 2, origin: "subagent" },
      blank: { id: "blank", displayTitle: "空", updatedAt: 1, blank: true },
    },
    { items: [], archivedSessionIds: [] },
  );
  eq("无归档时仍剔除子代理与空会话", h3.api.sessionRows().map((r) => r.id), ["ok1"]);

  // origin 为其他值时不得误伤（只有 "subagent" 才是子代理）。
  const h4 = loadSessionApi();
  h4.ctx = makeCtx(
    { a: { id: "a", displayTitle: "A", updatedAt: 2, origin: "user" }, b: { id: "b", displayTitle: "B", updatedAt: 1, origin: "" } },
    { items: [], archivedSessionIds: [] },
  );
  eq("非 subagent 的 origin 不受影响", h4.api.sessionRows().map((r) => r.id), ["a", "b"]);

  // blank 为假值（undefined / false）不得被误剔除。
  const h5 = loadSessionApi();
  h5.ctx = makeCtx(
    { a: { id: "a", displayTitle: "A", updatedAt: 2, blank: false }, b: { id: "b", displayTitle: "B", updatedAt: 1 } },
    { items: [], archivedSessionIds: [] },
  );
  eq("blank 为 false / 缺省时保留", h5.api.sessionRows().map((r) => r.id), ["a", "b"]);
}

console.log("\n[5] 筛选条构成（workspaceRowsFrom）");
{
  const h = loadSessionApi();
  const rows = [
    { id: "a", workspaceId: "w1" },
    { id: "b", workspaceId: "w1" },
    { id: "c", workspaceId: "w2" },
    { id: "d", workspaceId: "" },
  ];
  const snapshot = {
    items: [
      { workspaceId: "w1", title: "项目甲", path: "/p1" },
      { workspaceId: "w2", title: h.api.DEFAULT_WORKSPACE_TITLE, path: "/p2" },
      { workspaceId: "w3", title: "空区", path: "/p3" },
    ],
  };
  const chips = h.api.workspaceRowsFrom(snapshot, rows);
  eq("首项是「全部工作区」，计数为会话总数", [chips[0].scope, chips[0].count], [h.api.SCOPE_ALL, 4]);
  eq("每个工作区一项，顺序沿用 Host 顺序", chips.slice(1, 4).map((c) => c.scope), ["w1", "w2", "w3"]);
  eq("w1 计数为 2", chips[1].count, 2);
  eq("w3 计数为 0（空工作区仍出现）", chips[3].count, 0);
  eq("默认工作区被标记", chips[2].isDefault, true);
  eq("非默认工作区不被标记", chips[1].isDefault, false);
  eq("末项是「未分组」，计数为无归属会话数", [chips[chips.length - 1].scope, chips[chips.length - 1].count], [h.api.SCOPE_UNGROUPED, 1]);
  eq("快照为 null 时返回空数组（整条降级）", h.api.workspaceRowsFrom(null, rows), []);
}

console.log("\n[6] 无未分组会话时不出现「未分组」项");
{
  const h = loadSessionApi();
  const chips = h.api.workspaceRowsFrom(
    { items: [{ workspaceId: "w1", title: "甲", path: "/p" }] },
    [{ id: "a", workspaceId: "w1" }],
  );
  ok("未分组项缺席", !chips.some((c) => c.scope === h.api.SCOPE_UNGROUPED));
  eq("仅「全部」+ 一个工作区", chips.length, 2);
}

console.log("\n[7] 范围筛选（scopeSessionRows）");
{
  const h = loadSessionApi();
  const rows = [
    { id: "a", workspaceId: "w1" },
    { id: "b", workspaceId: "w2" },
    { id: "c", workspaceId: "" },
  ];
  eq("全部：原样返回", h.api.scopeSessionRows(rows, h.api.SCOPE_ALL).map((r) => r.id), ["a", "b", "c"]);
  eq("具体工作区：只留该区", h.api.scopeSessionRows(rows, "w1").map((r) => r.id), ["a"]);
  eq("未分组：只留无归属", h.api.scopeSessionRows(rows, h.api.SCOPE_UNGROUPED).map((r) => r.id), ["c"]);
  eq("未知工作区：空列表", h.api.scopeSessionRows(rows, "w9"), []);
}

console.log("\n[8] 默认范围优先级（resolveDefaultScope）");
{
  const h = loadSessionApi();
  const chips = [{ scope: h.api.SCOPE_ALL }, { scope: "w1" }];
  eq("记忆值仍有效 → 用之", h.api.resolveDefaultScope("w1", "w2", chips), "w1");
  eq("记忆值已失效 → 回落到源会话工作区", h.api.resolveDefaultScope("gone", "w1", chips), "w1");
  eq("源会话无工作区 → 全部工作区", h.api.resolveDefaultScope("gone", "", chips), h.api.SCOPE_ALL);
  eq("无记忆值 + 源会话有工作区 → 源会话工作区", h.api.resolveDefaultScope("", "w1", chips), "w1");
  eq("记忆值为「未分组」且该项存在 → 用之", h.api.resolveDefaultScope(h.api.SCOPE_UNGROUPED, "", [{ scope: h.api.SCOPE_ALL }, { scope: h.api.SCOPE_UNGROUPED }]), h.api.SCOPE_UNGROUPED);
}

console.log("\n[9] buildPromptContent 兜底与降级");
{
  const h = loadSessionApi();
  // 1. 转码失败的跨域/网络图片（模拟 node/无 DOM 环境下无法转 Base64），自动以 Markdown 链接兜底进入正文，且 items.length 不为 0
  const p1 = await h.api.buildPromptContent("", [{ url: "https://example.com/arch.png", name: "架构图" }]);
  eq("纯网络图片且转码失败：自动生成 Markdown 文本项", p1.items.length, 1);
  eq("纯网络图片项为文本类型", p1.items[0].type, "text");
  eq("纯网络图片项正文为 Markdown 语法", p1.items[0].text, "![架构图](https://example.com/arch.png)");
  eq("原始图片被记录进 skipped", p1.skipped.length, 1);

  // 2. 正文中已含有该图片 URL 时不重复追加
  const p2 = await h.api.buildPromptContent("参考 ![架构图](https://example.com/arch.png)", [{ url: "https://example.com/arch.png", name: "架构图" }]);
  eq("已含 URL 时不重复追加", p2.items[0].text, "参考 ![架构图](https://example.com/arch.png)");

  // 3. 有正文且有新网络图片：追加至正文末尾
  const p3 = await h.api.buildPromptContent("正文说明", [{ url: "https://example.com/demo.png", name: "示例文档" }]);
  eq("新图片追加到正文末尾", p3.items[0].text, "正文说明\n\n![示例文档](https://example.com/demo.png)");

  // 4. Data URL 可正常解析为多模态 image 项
  const dotData = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const p4 = await h.api.buildPromptContent("带图", [{ url: dotData, name: "像素点" }]);
  eq("Data URL 产出两个 item（image + text）", p4.items.length, 2);
  eq("第一个 item 为 image 类型", p4.items[0].type, "image");
  eq("image 项的 mediaType 为 image/png", p4.items[0].mediaType, "image/png");
  eq("image 项的 name 为 像素点", p4.items[0].name, "像素点");
  eq("Data URL 不进 skipped", p4.skipped.length, 0);

  // 5. dataUrlToFile 自动补齐后缀
  const f1 = h.api.dataUrlToFile(dotData, "architecture");
  eq("无后缀名称自动补全 .png", f1 && f1.name, "architecture.png");
  const f2 = h.api.dataUrlToFile(dotData, "diagram.png");
  eq("已有后缀名称不重复追加", f2 && f2.name, "diagram.png");

  // 6. 工作区图片：正文兜底引用消息里原本写的地址，不把插件内部的 api/file 路由写进转发正文
  const wsUrl = "http://127.0.0.1:19387/api/file?path=%2Fws%2Fshot.png";
  const p6 = await h.api.buildPromptContent("看这张", [{ url: wsUrl, altUrl: "http://127.0.0.1:19387/shot.png", authored: "shot.png", name: "截图" }]);
  eq("正文兜底用消息原本写的相对路径", p6.items[0].text, "看这张\n\n![截图](shot.png)");
  const p7 = await h.api.buildPromptContent("看这张", [{ url: wsUrl, authored: "/ws/abs.png", name: "绝对图" }]);
  eq("正文兜底保留原本写的绝对路径", p7.items[0].text, "看这张\n\n![绝对图](/ws/abs.png)");
  const p8 = await h.api.buildPromptContent("看这张", [{ url: "blob:http://127.0.0.1:19387/abc", authored: "blob:http://127.0.0.1:19387/abc", name: "附件" }]);
  eq("blob 附件不进正文", p8.items[0].text, "看这张");
}

const summary = `=== ${passed} passed, ${failures.length} failed ===`;
console.log(`\n${summary}`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
