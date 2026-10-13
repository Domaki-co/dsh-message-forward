// Harness: load the plugin's extraction layer into a realistic DSH DOM and assert behaviour.
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const SRC = path.join(here, "..", "lib", "client.js");
const src = fs.readFileSync(SRC, "utf8");

// --- carve out the pure extraction layer (MD_SEL .. extractUserFromContainer) ---
const startMark = "\t\tconst MD_SEL = ";
const endMark = "\t\t// ---------------------------------------------------------------- 会话业务";
const i = src.indexOf(startMark);
const j = src.indexOf(endMark);
if (i < 0 || j < 0 || j < i) throw new Error("could not locate extraction layer");
const extractionSrc = src.slice(i, j);
console.log("extraction layer bytes:", extractionSrc.length);

// --- realistic DSH chat DOM -------------------------------------------------
// Mirrors ui-chat: column > flowItem rows; the turn tail's inner root holds the action row.
const dom = new JSDOM(`<!doctype html><html><body>
<div data-conversation-scroll>
 <div class="icaHSq_scroll">
  <div class="icaHSq_column">

   <div class="icaHSq_flowItem" data-chat-anchor-key="u1" data-chat-flow-key="u1"
        data-chat-flow-kind="user" data-chat-turn="1">
     <div data-slot="conversation.chat.node">
       <div class="IzP3Va_userRow">
         <div class="IzP3Va_userStack">
           <div class="IzP3Va_bubble">你好，帮我看看这个 bug</div>
         </div>
         <div class="ppByMG_actions" data-clock="start"><button>copy</button></div>
       </div>
     </div>
   </div>

   <div class="icaHSq_flowItem" data-chat-anchor-key="t1" data-chat-flow-key="t1"
        data-chat-flow-kind="turn-trigger" data-chat-turn="1">
     <div data-slot="conversation.chat.node"><span>trigger</span></div>
   </div>

   <div class="icaHSq_flowItem" data-chat-anchor-key="g1" data-chat-flow-key="g1"
        data-chat-flow-kind="turn-process" data-chat-turn="1">
     <div data-slot="conversation.chat.node">
       <div class="HiSsxa_root" data-variant="think" data-state="ok">
         <div class="HiSsxa_summary"><span class="HiSsxa_summaryText">已思考 3 秒</span></div>
         <div class="HiSsxa_thinkBody">先复现，再定位。</div>
       </div>
     </div>
   </div>

   <div class="icaHSq_flowItem" data-chat-anchor-key="a1" data-chat-flow-key="a1"
        data-chat-flow-kind="assistant-step" data-chat-turn="1">
     <div data-slot="conversation.chat.node">
       <div class="rkta1W_root">
         <div class="markdown" data-markdown-variant="body">
           <p>问题出在 <code>assistantTurnNodes</code> 的兄弟节点查找层级。</p>
           <p>修复后即可转发。</p>
         </div>
       </div>
     </div>
   </div>

   <div class="icaHSq_flowItem" data-chat-anchor-key="tt1" data-chat-flow-key="tt1"
        data-chat-flow-kind="turn-tail" data-chat-turn="1">
     <div class="TurnTailNodeView_root" data-turn-tail="1" data-actions-reveal="always">
       <div class="ppByMG_actions" data-clock="end">
         <button id="copybtn">copy</button>
         <button id="fwdbtn" class="dsh-mf-btn">forward</button>
       </div>
     </div>
   </div>

   <div class="icaHSq_flowItem" data-chat-anchor-key="u2" data-chat-flow-key="u2"
        data-chat-flow-kind="user" data-chat-turn="2">
     <div data-slot="conversation.chat.node">
       <div class="IzP3Va_userRow">
         <div class="IzP3Va_userStack"><div class="IzP3Va_bubble">第二条用户消息</div></div>
         <div class="ppByMG_actions" data-clock="start"><button>copy</button></div>
       </div>
     </div>
   </div>

   <div class="icaHSq_flowItem" data-chat-anchor-key="a2" data-chat-flow-key="a2"
        data-chat-flow-kind="assistant-step" data-chat-turn="2">
     <div data-slot="conversation.chat.node">
       <div class="rkta1W_root">
         <div class="markdown" data-markdown-variant="body"><p>第二条模型回复</p></div>
       </div>
     </div>
   </div>

   <div class="icaHSq_flowItem" data-chat-anchor-key="tt2" data-chat-flow-key="tt2"
        data-chat-flow-kind="turn-tail" data-chat-turn="2">
     <div class="TurnTailNodeView_root" data-turn-tail="2" data-actions-reveal="always">
       <div class="ppByMG_actions" data-clock="end">
         <button id="fwdbtn2" class="dsh-mf-btn">forward</button>
       </div>
     </div>
   </div>

  </div>
 </div>
</div>
</body></html>`, { pretendToBeVisual: true });

const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.Element = window.Element;

// --- evaluate the extraction layer in this DOM -----------------------------
const factory = new Function(
  "document", "Node", "Element",
  extractionSrc + "\n; return { assistantTurnNodes, extractAssistantFromAnchor, extractUserFromContainer, collectText, collectImages, lastAssistantAnchor, extractLastAssistantTurn };"
);
const api = factory(window.document, window.Node, window.Element);

// --- assertions ------------------------------------------------------------
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      got=${JSON.stringify(got)}${ok ? "" : `\n     want=${JSON.stringify(want)}`}`);
};
const checkHas = (name, got, needle) => {
  const ok = typeof got === "string" && got.includes(needle);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      got=${JSON.stringify(got)}`);
};
const checkNotHas = (name, got, needle) => {
  const ok = typeof got === "string" && !got.includes(needle);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      got=${JSON.stringify(got)}`);
};

const btn1 = window.document.getElementById("fwdbtn");
const btn2 = window.document.getElementById("fwdbtn2");

// the anchor the plugin actually uses
const anchor1 = btn1.closest("[data-turn-tail]");
console.log("\nanchor1 tag:", anchor1.tagName, "data-turn-tail=", anchor1.getAttribute("data-turn-tail"));
console.log("anchor1 parent kind:", anchor1.parentElement.getAttribute("data-chat-flow-kind"));

const r1 = api.extractAssistantFromAnchor(anchor1);
console.log("\n--- turn 1 ---");
checkHas("turn1: contains reply text", r1.text, "assistantTurnNodes");
checkNotHas("turn1: excludes user message", r1.text, "帮我看看这个 bug");
checkNotHas("turn1: excludes thinking summary", r1.text, "已思考 3 秒");
checkNotHas("turn1: excludes thinking body", r1.text, "先复现");

const r2 = api.extractAssistantFromAnchor(btn2.closest("[data-turn-tail]"));
console.log("\n--- turn 2 ---");
check("turn2: exact text", r2.text, "第二条模型回复");

// header button path: last assistant turn in document
const last = api.extractLastAssistantTurn();
console.log("\n--- header path ---");
check("lastAssistantTurn: exact text", last.text, "第二条模型回复");

// user side must still work
console.log("\n--- user side ---");
const u1row = window.document.querySelectorAll("[data-clock='start']")[0];
const u1 = api.extractUserFromContainer(u1row);
check("user1: bubble text", u1.text, "你好，帮我看看这个 bug");
const u2row = window.document.querySelectorAll("[data-clock='start']")[1];
check("user2: bubble text", api.extractUserFromContainer(u2row).text, "第二条用户消息");

// node walk sanity: turn-process rows are kept (images), assistant-step carries the text
console.log("\n--- node walk ---");
const nodes = api.assistantTurnNodes(anchor1);
const kinds = nodes.map((n) => n.getAttribute("data-chat-flow-kind"));
check("turn1 node kinds", kinds.join(","), "turn-process,assistant-step");
check("turn1 text node is assistant-step", kinds[kinds.length - 1], "assistant-step");

// ---- grouped nesting: members live inside a ChatGroupSeat, not the column ----
console.log("\n--- grouped nesting ---");
const groupDom = new JSDOM(`<!doctype html><html><body>
<div data-conversation-scroll><div class="icaHSq_scroll"><div class="icaHSq_column">
 <div class="icaHSq_flowItem" data-chat-flow-key="u9" data-chat-flow-kind="user" data-chat-turn="9">
   <div class="IzP3Va_userRow"><div class="IzP3Va_bubble">分组前的提问</div></div>
 </div>
 <div class="icaHSq_flowItem" data-chat-flow-key="g9" data-chat-flow-kind="turn-process" data-chat-turn="9"
      data-chat-group-key="g9" data-step-process data-group-expanded-mode>
   <div class="ChatGroupSeat_root" data-chat-group-key="g9" data-chat-flow-key="g9" data-chat-turn="9" data-step-process>
     <div data-step-process-body><div class="ChatGroupSeat_content" data-step-process-content data-chat-flow="">
       <div class="icaHSq_flowItem" data-chat-flow-key='["g9","reasoning"]' data-chat-flow-kind="assistant-step" data-chat-turn="9">
         <div class="HiSsxa_root" data-variant="think"><div class="HiSsxa_thinkBody">分组内的思考</div></div>
       </div>
       <div class="icaHSq_flowItem" data-chat-flow-key='["g9","response"]' data-chat-flow-kind="assistant-step" data-chat-turn="9">
         <div class="markdown" data-markdown-variant="body"><p>分组内的正式回答</p></div>
       </div>
     </div></div>
   </div>
 </div>
 <div class="icaHSq_flowItem" data-chat-flow-key="tt9" data-chat-flow-kind="turn-tail" data-chat-turn="9">
   <div class="TurnTailNodeView_root" data-turn-tail="9" data-actions-reveal="always">
     <div class="ppByMG_actions" data-clock="end"><button id="gbtn" class="dsh-mf-btn">f</button></div>
   </div>
 </div>
</div></div></div></body></html>`, { pretendToBeVisual: true });

globalThis.document = groupDom.window.document;
globalThis.Node = groupDom.window.Node;
globalThis.Element = groupDom.window.Element;
const apiG = new Function("document", "Node", "Element",
  extractionSrc + "\n; return { assistantTurnNodes, extractAssistantFromAnchor };"
)(groupDom.window.document, groupDom.window.Node, groupDom.window.Element);

const gAnchor = groupDom.window.document.getElementById("gbtn").closest("[data-turn-tail]");
const gr = apiG.extractAssistantFromAnchor(gAnchor);
checkHas("grouped: finds answer inside group seat", gr.text, "分组内的正式回答");
checkNotHas("grouped: excludes pre-group user msg", gr.text, "分组前的提问");
checkNotHas("grouped: excludes inner thinking", gr.text, "分组内的思考");

// ---- fallback: no assistant-step at all -> still yields something ----
console.log("\n--- fallback (no assistant-step) ---");
const fbDom = new JSDOM(`<!doctype html><html><body>
<div data-conversation-scroll><div class="icaHSq_column">
 <div class="icaHSq_flowItem" data-chat-flow-key="u7" data-chat-flow-kind="user" data-chat-turn="7">
   <div class="IzP3Va_userRow"><div class="IzP3Va_bubble">问</div></div>
 </div>
 <div class="icaHSq_flowItem" data-chat-flow-key="x7" data-chat-flow-kind="turn-error" data-chat-turn="7">
   <div class="turnErrorRow">回合失败：请求超时</div>
 </div>
 <div class="icaHSq_flowItem" data-chat-flow-key="tt7" data-chat-flow-kind="turn-tail" data-chat-turn="7">
   <div class="TurnTailNodeView_root" data-turn-tail="7"><div class="ppByMG_actions" data-clock="end"><button id="fbtn">f</button></div></div>
 </div>
</div></div></body></html>`, { pretendToBeVisual: true });
const apiF = new Function("document", "Node", "Element",
  extractionSrc + "\n; return { extractAssistantFromAnchor };"
)(fbDom.window.document, fbDom.window.Node, fbDom.window.Element);
const fr = apiF.extractAssistantFromAnchor(fbDom.window.document.getElementById("fbtn").closest("[data-turn-tail]"));
checkHas("fallback: surfaces turn-error text", fr.text, "请求超时");
checkNotHas("fallback: excludes the user row", fr.text, "问");

// ---- reasoning must never be forwarded (folded group + inline reasoning) ----
// Regression for "转发里混进了思考链": DSH renders one assistant-step twice, once under
// groupPart="reasoning" and once under "response"; the folded reasoning row carries hidden,
// and textOf's textContent fallback used to resurrect its body. The inline case is the
// ProcessReasoning wrapper inside the response row, whose body is a compact markdown block.
console.log("\n--- reasoning exclusion (folded + inline) ---");
const rDom = new JSDOM(`<!doctype html><html><body>
<div data-conversation-scroll><div class="icaHSq_column">
 <div class="icaHSq_flowItem" data-chat-flow-key="u5" data-chat-flow-kind="user" data-chat-turn="5">
   <div class="IzP3Va_userRow"><div class="IzP3Va_bubble">帮我看看</div></div>
 </div>
 <div class="icaHSq_flowItem" data-chat-flow-key="g5" data-chat-flow-kind="turn-process" data-chat-turn="5"
      data-chat-group-key="g5" data-step-process>
   <div class="ChatGroupSeat_root" data-chat-group-key="g5" data-step-process>
     <div data-step-process-body hidden>
       <div class="ChatGroupSeat_content" data-step-process-content>
         <div class="icaHSq_flowItem" data-chat-group-part="reasoning" data-chat-flow-kind="assistant-step"
              data-chat-turn="5" hidden data-turn-process-hidden="true">
           <div class="HiSsxa_root" data-variant="think" data-state="ok" data-expanded>
             <div class="HiSsxa_thinkBody">
               <div class="markdown" data-markdown-variant="compact"><p>折叠中的思考链正文</p></div>
             </div>
           </div>
         </div>
       </div>
     </div>
   </div>
 </div>
 <div class="icaHSq_flowItem" data-chat-flow-key="a5" data-chat-flow-kind="assistant-step"
      data-chat-turn="5" data-chat-group-part="response">
   <div class="gKv1-q_root"><div class="gKv1-q_body">
     <div data-turn-process-inline>
       <div class="markdown" data-markdown-variant="compact"><p>内联思考链正文</p></div>
     </div>
     <div class="markdown" data-markdown-variant="body"><p>真正的回答正文</p></div>
   </div></div>
 </div>
 <div class="icaHSq_flowItem" data-chat-flow-key="tt5" data-chat-flow-kind="turn-tail" data-chat-turn="5">
   <div class="TurnTailNodeView_root" data-turn-tail="5"><div class="ppByMG_actions" data-clock="end"><button id="rbtn">f</button></div></div>
 </div>
</div></div></body></html>`, { pretendToBeVisual: true });
const apiR = new Function("document", "Node", "Element",
  extractionSrc + "\n; return { extractAssistantFromAnchor, assistantTurnNodes };"
)(rDom.window.document, rDom.window.Node, rDom.window.Element);
const rAnchor = rDom.window.document.getElementById("rbtn").closest("[data-turn-tail]");
const rr = apiR.extractAssistantFromAnchor(rAnchor);
check("reasoning: exact text is the answer only", rr.text, "真正的回答正文");
checkNotHas("reasoning: excludes folded reasoning body", rr.text, "折叠中的思考链正文");
checkNotHas("reasoning: excludes inline reasoning body", rr.text, "内联思考链正文");
check("reasoning: the reasoning row is not even a candidate node",
  apiR.assistantTurnNodes(rAnchor).map((n) => n.getAttribute("data-chat-flow-kind")).join(","),
  "turn-process,assistant-step");

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
