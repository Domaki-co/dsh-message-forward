// Harness: load the plugin's extraction layer into a realistic DSH DOM and assert behaviour.
import { extractionSrc as extractionSlice, localeSrc } from "./_source.mjs";
import { loadJsdom } from "./_deps.mjs";

const JSDOM = await loadJsdom("test-extract.mjs");

// 源码里的 t("key") 需要文案层；一起 eval 才不会 "t is not defined"
const extractionSrc = localeSrc + "\n" + extractionSlice;
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

// ---- images extraction & markdown preservation ----
console.log("\n--- images extraction & markdown preservation ---");
const imgDom = new JSDOM(`<!doctype html><html><body>
<div data-conversation-scroll><div class="icaHSq_column">
 <div class="icaHSq_flowItem" data-chat-flow-key="u10" data-chat-flow-kind="user" data-chat-turn="10">
   <div class="IzP3Va_userRow">
     <div class="IzP3Va_userStack">
       <div class="IzP3Va_bubble">请画一张架构图</div>
       <div class="IzP3Va_gallery"><img src="blob:http://localhost:3000/user-sketch.png" alt="草图"></div>
     </div>
     <div class="ppByMG_actions" data-clock="start"><button>copy</button></div>
   </div>
 </div>
 <div class="icaHSq_flowItem" data-chat-flow-key="a10" data-chat-flow-kind="assistant-step" data-chat-turn="10">
   <div class="markdown" data-markdown-variant="body">
     <p>这是设计架构图：</p>
     <p><img src="https://example.com/arch.png" alt="系统架构图"></p>
     <p>请查收。</p>
   </div>
 </div>
 <div class="icaHSq_flowItem" data-chat-flow-key="tt10" data-chat-flow-kind="turn-tail" data-chat-turn="10">
   <div class="TurnTailNodeView_root" data-turn-tail="10"><div class="ppByMG_actions" data-clock="end"><button id="imgbtn">f</button></div></div>
 </div>
 <div class="icaHSq_flowItem" data-chat-flow-key="a11" data-chat-flow-kind="assistant-step" data-chat-turn="11">
   <div class="markdown" data-markdown-variant="body">
     <p><img src="https://example.com/pure-chart.png" alt="纯图表"></p>
   </div>
 </div>
 <div class="icaHSq_flowItem" data-chat-flow-key="tt11" data-chat-flow-kind="turn-tail" data-chat-turn="11">
   <div class="TurnTailNodeView_root" data-turn-tail="11"><div class="ppByMG_actions" data-clock="end"><button id="purebtn">f</button></div></div>
 </div>
</div></div></body></html>`, { pretendToBeVisual: true });

const apiImg = new Function("document", "Node", "Element",
  extractionSrc + "\n; return { extractAssistantFromAnchor, extractUserFromContainer, collectImages, assistantTurnNodes };"
)(imgDom.window.document, imgDom.window.Node, imgDom.window.Element);

const imgAnchor1 = imgDom.window.document.getElementById("imgbtn").closest("[data-turn-tail]");
const rImg1 = apiImg.extractAssistantFromAnchor(imgAnchor1);
checkHas("assistant with image: preserves markdown image in text", rImg1.text, "![系统架构图](https://example.com/arch.png)");
checkHas("assistant with image: contains surrounding text", rImg1.text, "这是设计架构图：");
check("assistant with image: images array has url and alt", rImg1.images.length, 1);
check("assistant with image: image url matches", rImg1.images[0].url, "https://example.com/arch.png");
check("assistant with image: image name matches", rImg1.images[0].name, "系统架构图");

const imgAnchor2 = imgDom.window.document.getElementById("purebtn").closest("[data-turn-tail]");
const rImg2 = apiImg.extractAssistantFromAnchor(imgAnchor2);
check("pure image assistant: text is not empty and has markdown", rImg2.text, "![纯图表](https://example.com/pure-chart.png)");
check("pure image assistant: images array has 1 image", rImg2.images.length, 1);

const userRow = imgDom.window.document.querySelector("[data-clock='start']");
const uImg = apiImg.extractUserFromContainer(userRow);
check("user with gallery blob: bubble text is preserved without raw blob", uImg.text, "请画一张架构图");
check("user with gallery blob: images collected", uImg.images.length, 1);
check("user with gallery blob: url matches", uImg.images[0].url, "blob:http://localhost:3000/user-sketch.png");

// 4. 用户在气泡中内联 Markdown 图片语法时，正文保留该图片 Markdown
const u2Bubble = imgDom.window.document.createElement("div");
u2Bubble.className = "IzP3Va_bubble";
u2Bubble.innerHTML = "<p>看图：<img src=\"https://example.com/ref.png\" alt=\"参考\" /> 能行吗？</p>";
const u2Row = imgDom.window.document.createElement("div");
u2Row.className = "IzP3Va_userRow";
u2Row.appendChild(u2Bubble);
const uImg2 = apiImg.extractUserFromContainer(u2Row);
checkHas("user bubble with markdown img: preserves tag", uImg2.text, "![参考](https://example.com/ref.png)");

// 5. 锚点直接落在 assistant-step 行内时（如未来按钮挂载位置变化），自身节点被成功保留
const directStep = imgDom.window.document.querySelector("[data-chat-flow-key='a10']");
const directNodes = apiImg.assistantTurnNodes(directStep);
check("assistantTurnNodes directly on step: includes itself", directNodes.some((n) => n === directStep), true);

// ---- 工作区图片：markdown 相对路径补成宿主 api/file 路由 ----
console.log("\n--- workspace image resolution ---");
const wsDom = new JSDOM(`<!doctype html><html><body>
 <div class="markdown" data-markdown-variant="body">
   <p><img src="compressed_bunny-girl_1063x1594.jpg" alt="压缩后的图片"></p>
   <p><img src="/abs/already-absolute.png" alt="绝对"></p>
   <p><img src="dsh-resource://file/session/s1/sub/nested.png" alt="资源协议"></p>
   <p><img src="https://cdn.example.com/remote.png" alt="远程"></p>
   <p><img src="blob:http://127.0.0.1:19387/abc" alt="附件"></p>
 </div></body></html>`, { url: "http://127.0.0.1:19387/", pretendToBeVisual: true });

const WORKSPACE = "/Users/chen/Documents/deepseek-harness/default-workspace";
globalThis.ctxRef = {
  sessions: { list: { getSnapshot: () => ({ byId: { s1: { id: "s1", cwd: WORKSPACE, retainedBy: { mainView: 1 } } } }) } }
};
const apiWs = new Function("document", "Node", "Element",
  extractionSrc + "\n; return { collectImages, authoredImagePath, hostFileMediaUrl };"
)(wsDom.window.document, wsDom.window.Node, wsDom.window.Element);
const wsImages = apiWs.collectImages(wsDom.window.document.body);
delete globalThis.ctxRef;

const fileUrl = (p) => "http://127.0.0.1:19387/api/file?path=" + encodeURIComponent(p);
check("相对路径补成工作区绝对路径并经 api/file 取图", wsImages[0] && wsImages[0].url, fileUrl(WORKSPACE + "/compressed_bunny-girl_1063x1594.jpg"));
check("保留页面渲染地址作为备用", wsImages[0] && wsImages[0].altUrl, "http://127.0.0.1:19387/compressed_bunny-girl_1063x1594.jpg");
check("alt 文案照旧保留", wsImages[0] && wsImages[0].name, "压缩后的图片");
check("绝对路径直接走 api/file", wsImages[1] && wsImages[1].url, fileUrl("/abs/already-absolute.png"));
check("dsh-resource 会话地址解析到工作区", wsImages[2] && wsImages[2].url, fileUrl(WORKSPACE + "/sub/nested.png"));
check("远程 https 图保持原样", wsImages[3] && wsImages[3].url, "https://cdn.example.com/remote.png");
check("远程图不产生备用地址", wsImages[3] && wsImages[3].altUrl, undefined);
check("blob 附件保持原样", wsImages[4] && wsImages[4].url, "blob:http://127.0.0.1:19387/abc");
check("无会话时不臆造工作区路径", apiWs.authoredImagePath("lonely.png", ""), "");
check("拒绝协议相对地址", apiWs.authoredImagePath("//evil.example.com/x.png", "/ws"), "");
check("拒绝非文件 scheme", apiWs.authoredImagePath("javascript:alert(1)", "/ws"), "");
check("./ 前缀被折平", apiWs.authoredImagePath("./shot.png", "/ws"), "/ws/shot.png");

console.log(`
=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
