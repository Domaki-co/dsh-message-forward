// Verify the batch multi-select path (collectUnits / unitIdForNode / mergeUnits) against the same DOM.
import { batchUnitsSrc, extractionSrc as extractionSlice, localeSrc, src } from "./_source.mjs";
import { loadJsdom } from "./_deps.mjs";

const JSDOM = await loadJsdom("test-batch.mjs");

const extractionSrc = localeSrc + "\n" + extractionSlice;

// collectUnits / unitIdForNode / mergeUnits live after the session section; the shared slice
// starts at the section header so the snippet helpers (toSnippet / unitSnippet) come along too.
// localeSrc 已经拼在 extractionSrc 前面，这里只取本段（重复声明会直接报错）
const batchSrc = batchUnitsSrc;

const dom = new JSDOM(`<!doctype html><html><body>
<div data-conversation-scroll><div class="icaHSq_column">
 <div class="icaHSq_flowItem" data-chat-flow-key="u1" data-chat-flow-kind="user" data-chat-turn="1">
   <div class="IzP3Va_userRow"><div class="IzP3Va_bubble">第一条提问</div>
   <div class="ppByMG_actions" data-clock="start"><button>c</button></div></div>
 </div>
 <div class="icaHSq_flowItem" data-chat-flow-key="a1" data-chat-flow-kind="assistant-step" data-chat-turn="1">
   <div class="markdown" data-markdown-variant="body"><p>第一条回答</p></div>
 </div>
 <div class="icaHSq_flowItem" data-chat-flow-key="tt1" data-chat-flow-kind="turn-tail" data-chat-turn="1">
   <div class="TurnTailNodeView_root" data-turn-tail="1" data-actions-reveal="always">
     <div class="ppByMG_actions" data-clock="end"><button id="b1" class="dsh-mf-btn">f</button></div>
   </div>
 </div>
 <div class="icaHSq_flowItem" data-chat-flow-key="u2" data-chat-flow-kind="user" data-chat-turn="2">
   <div class="IzP3Va_userRow"><div class="IzP3Va_bubble">第二条提问</div>
   <div class="ppByMG_actions" data-clock="start"><button>c</button></div></div>
 </div>
 <div class="icaHSq_flowItem" data-chat-flow-key="a2" data-chat-flow-kind="assistant-step" data-chat-turn="2">
   <div class="markdown" data-markdown-variant="body"><p>第二条回答</p></div>
 </div>
 <div class="icaHSq_flowItem" data-chat-flow-key="tt2" data-chat-flow-kind="turn-tail" data-chat-turn="2">
   <div class="TurnTailNodeView_root" data-turn-tail="2" data-actions-reveal="always">
     <div class="ppByMG_actions" data-clock="end"><button id="b2" class="dsh-mf-btn">f</button></div>
   </div>
 </div>
</div></div></body></html>`, { pretendToBeVisual: true });

const w = dom.window;
globalThis.document = w.document;
globalThis.Node = w.Node;

const api = new Function("document", "Node", "Element",
  extractionSrc + "\n" + batchSrc +
  "\n; return { collectUnits, unitIdForNode, mergeUnits, toSnippet, unitSnippet, PICK_TEXT_MAX, snippetCache };"
)(w.document, w.Node, w.Element);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      got=${JSON.stringify(got)}${ok ? "" : `\n     want=${JSON.stringify(want)}`}`);
};

const units = api.collectUnits();
console.log("units:", units.map((u) => `${u.id}(${u.role})`).join("  "));
check("unit count", units.length, 4);
check("unit roles in document order", units.map((u) => u.role).join(","), "user,assistant,user,assistant");

const snaps = units.map((u) => u.getSnapshot().text);
check("user1 text", snaps[0], "第一条提问");
check("assistant1 text", snaps[1], "第一条回答");
check("user2 text", snaps[2], "第二条提问");
check("assistant2 text", snaps[3], "第二条回答");

// button -> unit id mapping (this is what long-press multi-select relies on)
const id1 = api.unitIdForNode(w.document.getElementById("b1"));
const id2 = api.unitIdForNode(w.document.getElementById("b2"));
console.log("btn1 ->", id1, " btn2 ->", id2);
check("btn1 maps to assistant unit 1", id1, "a:1");
check("btn2 maps to assistant unit 2", id2, "a:2");

// merging a user + assistant pair (ids come from collectUnits: user units are "u:<flowKey>")
const userId = units[2].id;
const asstId = units[3].id;
console.log("merging:", userId, "+", asstId);
const merged = api.mergeUnits(units, new Set([userId, asstId]));
console.log("merged text:\n" + merged.text);
check("merged count", merged.count, 2);
check("merged includes user", merged.text.includes("第二条提问"), true);
check("merged includes assistant", merged.text.includes("第二条回答"), true);
check("merged labels", merged.text.includes("用户") && merged.text.includes("模型"), true);
check("merged excludes unselected turn", merged.text.includes("第一条"), false);
// 块间分隔交给外层 <forwarded_context> 边界：正文自带的 --- 不再与分隔符混淆
check("merged blocks carry no --- separator", merged.text.includes("\n\n---\n\n"), false);
check("merged blocks keep numbered headers", merged.text.includes("【1】") && merged.text.includes("【2】"), true);

// 说话者清单：开标签的 speaker 属性要用它，不能笼统写「合并消息」
check("merged speakers list the roles that actually appear", merged.speakers.join(","), "user,model");
check("assistant-only merge does not claim a user message",
  api.mergeUnits(units, new Set([asstId])).speakers.join(","), "model");
check("user-only merge reports only the user", api.mergeUnits(units, new Set([userId])).speakers.join(","), "user");
check("handleMerge passes the speaker list into the modal payload",
  src.includes("speakers: merged.speakers,"), true);

// --- 快捷选择面板的摘要：每段最多 PICK_TEXT_MAX(150) 字符 ---
check("PICK_TEXT_MAX is 150", api.PICK_TEXT_MAX, 150);

check("short text passes through unchanged", api.toSnippet("你好"), "你好");
check("newlines and runs of spaces collapse to single spaces",
  api.toSnippet("第一行\n\n第二行\t 第三行"), "第一行 第二行 第三行");
check("leading/trailing whitespace is trimmed", api.toSnippet("   两边有空格   "), "两边有空格");

const long = "长".repeat(400);
const cut = api.toSnippet(long);
console.log("      snippet length:", cut.length, "(tail:", JSON.stringify(cut.slice(-3)) + ")");
check("over-long text is truncated to 150 chars + ellipsis", cut.length, 151);
check("truncated text keeps the first 150 chars", cut.slice(0, 150), "长".repeat(150));
check("truncated text ends with an ellipsis", cut.endsWith("…"), true);

check("exactly-at-limit text is NOT truncated", api.toSnippet("a".repeat(150)), "a".repeat(150));
check("one char over the limit IS truncated", api.toSnippet("a".repeat(151)).endsWith("…"), true);
check("empty/nullish input yields empty string",
  api.toSnippet("") === "" && api.toSnippet(null) === "" && api.toSnippet(undefined) === "", true);

// unitSnippet: 走 getSnapshot 拿正文并缓存（面板每帧渲染都调用它，必须只算一次）
api.snippetCache.clear();
let calls = 0;
const fakeUnit = {
  id: "test:cache",
  role: "assistant",
  getSnapshot: () => { calls += 1; return { role: "assistant", text: "缓存测试", images: [] }; }
};
const first = api.unitSnippet(fakeUnit);
const second = api.unitSnippet(fakeUnit);
check("unitSnippet returns the snapshot text", first, "缓存测试");
check("unitSnippet result is stable across calls", second, first);
check("getSnapshot is only called once (cached)", calls, 1);
check("cache is keyed by unit id", api.snippetCache.get("test:cache"), "缓存测试");

// getSnapshot 抛错时不能把面板整个带崩
const brokenUnit = { id: "test:broken", role: "user", getSnapshot: () => { throw new Error("boom"); } };
check("a throwing getSnapshot degrades to empty string", api.unitSnippet(brokenUnit), "");

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
