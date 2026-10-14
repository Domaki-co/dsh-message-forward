// 多选装饰器测试。
//
// 关键要求：装饰 / 清理断言必须跑 lib/client.js 里**真实**的函数（setupBatchDecorator），
// 而不是在测试里重写一遍实现——重写的副本在实现被改坏时照样全绿，等于没有覆盖。
// 这里用 fake 依赖（document / getComputedStyle / MutationObserver）+ 真实 batchStore
// 驱动装饰器，再分别走「退出多选」与「返回的 cleanup」两条真实路径，断言宿主行上的
// 注入节点、注入类名、注入的内联 position 都被清干净。
import { batchUnitsSrc, decoratorSrc, extractionSrc as extractionSlice, localeSrc, src, storeSrc } from "./_source.mjs";
import { loadJsdom } from "./_deps.mjs";

const JSDOM = await loadJsdom("test-decorator.mjs");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "\n      " + extra : ""}`);
};

// ---------- 1. 源码级不变量（不是行为证据，行为证据在下面） ----------
ok("portalToBody helper exists", /function portalToBody\(node\)/.test(src));
ok("portalToBody guards on createPortal being a function",
  /typeof reactDom\.createPortal === "function"/.test(src));
ok("react-dom require is wrapped in try/catch (no hard dependency)",
  /try\s*\{\s*reactDom = require\("react-dom"\);\s*\}\s*catch/.test(src));
ok("BatchToolbarPortal wrapper exists", /function BatchToolbarPortal\(\)/.test(src));
ok("both render sites use the portal wrapper",
  (src.match(/h\(BatchToolbarPortal\)/g) || []).length === 2,
  "sites: " + (src.match(/h\(BatchToolbarPortal\)/g) || []).length);
// the only h(BatchToolbar) left must be the one INSIDE BatchToolbarPortal
const directSites = [...src.matchAll(/h\(BatchToolbar\)/g)].length;
ok("the only direct BatchToolbar render is inside the portal wrapper",
  directSites === 1 && /function BatchToolbarPortal\(\)\s*\{\s*const node = h\(BatchToolbar\);/.test(src),
  "direct render sites: " + directSites);

// ---------- 2. 真实代码路径 ----------
const dom = new JSDOM(`<!doctype html><html><head></head><body>
<div data-conversation-scroll><div class="icaHSq_column">
 <div class="icaHSq_flowItem" data-chat-flow-key="u1" data-chat-flow-kind="user" data-chat-turn="1">
   <div class="IzP3Va_userRow" style="display:flex;gap:8px"><div class="IzP3Va_bubble">第一条提问</div>
   <div class="ppByMG_actions" data-clock="start"><button>c</button></div></div>
 </div>
 <div class="icaHSq_flowItem" data-chat-flow-key="u2" data-chat-flow-kind="user" data-chat-turn="2">
   <div class="IzP3Va_userRow" style="position:absolute"><div class="IzP3Va_bubble">第二条提问</div></div>
 </div>
 <div class="icaHSq_flowItem" data-chat-flow-key="tt1" data-chat-flow-kind="turn-tail" data-chat-turn="1">
   <div class="TurnTailNodeView_root" data-turn-tail="1">
     <div class="ppByMG_actions" data-clock="end"><button id="b1">f</button></div>
   </div>
 </div>
</div></div>
</body></html>`, { pretendToBeVisual: true });

const { window } = dom;
const doc = window.document;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 切片全部来自 _source.mjs（标记缺失 / 顺序颠倒会直接抛错），不在这里裸 indexOf。
const api = new Function("document", "window", "getComputedStyle", "Node", "MutationObserver", `
  ${localeSrc}
  ${storeSrc}
  ${extractionSlice}
  ${batchUnitsSrc}
  ${decoratorSrc}
  return { setupBatchDecorator, batchStore, collectUnits };
`)(doc, window, window.getComputedStyle.bind(window), window.Node, window.MutationObserver);

const units = api.collectUnits();
ok("collectUnits sees all three hosts", units.length === 3,
  "units=" + units.map((u) => u.id).join(","));
const userHost = units.find((u) => u.id === "u:u1").element;
const absoluteHost = units.find((u) => u.id === "u:u2").element;
const asstHost = units.find((u) => u.id === "a:1").element;
ok("user unit host carries the userRow class", /userRow/.test(userHost.className),
  "class=" + userHost.className);

const styleBefore = {
  user: userHost.getAttribute("style"),
  absolute: absoluteHost.getAttribute("style"),
  asst: asstHost.getAttribute("style"),
};
const checkBox = (host) => host.querySelector(":scope > .dsh-mf-check");
const cleanSnapshot = () => ({
  boxes: doc.querySelectorAll(".dsh-mf-check").length,
  hostClass: doc.querySelectorAll(".dsh-mf-check-host").length,
  selected: doc.querySelectorAll(".dsh-mf-unit-selected").length,
  bodyActive: doc.body.classList.contains("dsh-mf-batch-active"),
});

// --- 进入多选：真实 decorate() 在 setupBatchDecorator() 末尾同步跑一次 ---
api.batchStore.set({ isActive: true, selectedIds: new Set(["u:u1"]) });
const cleanup = api.setupBatchDecorator();
ok("真实装饰：宿主拿到装订线 class", userHost.classList.contains("dsh-mf-check-host"));
ok("真实装饰：注入节点是宿主的直接子元素", checkBox(userHost) === userHost.querySelector(".dsh-mf-check")
  && !!checkBox(userHost), "box=" + !!checkBox(userHost));
ok("真实装饰：注入节点带 unitId / role / aria-checked",
  checkBox(userHost).dataset.unitId === "u:u1"
  && checkBox(userHost).getAttribute("role") === "checkbox"
  && checkBox(userHost).getAttribute("aria-checked") === "true",
  "unitId=" + checkBox(userHost).dataset.unitId + " aria=" + checkBox(userHost).getAttribute("aria-checked"));
ok("真实装饰：选中项拿到 selected class + 宿主标记",
  checkBox(userHost).classList.contains("selected") && userHost.classList.contains("dsh-mf-unit-selected"));
ok("真实装饰：checkbox 里有内层方块元素", !!checkBox(userHost).querySelector(".dsh-mf-check-box"));
ok("真实装饰：未选中的单元 aria-checked=false（≠ selected）",
  checkBox(asstHost).getAttribute("aria-checked") === "false"
  && !checkBox(asstHost).classList.contains("selected"));
ok("真实装饰：static 宿主补上内联定位并打标记",
  userHost.style.position === "relative" && userHost.dataset.dshMfPos === "1",
  "position=" + userHost.style.position + " marker=" + userHost.dataset.dshMfPos);
ok("真实装饰：已定位（absolute）的宿主不被覆盖内联样式",
  absoluteHost.style.position === "absolute" && !absoluteHost.dataset.dshMfPos
  && absoluteHost.getAttribute("style") === styleBefore.absolute,
  "position=" + absoluteHost.style.position + " style=" + JSON.stringify(absoluteHost.getAttribute("style")));
ok("真实装饰：宿主原有的内联属性（display/gap）没被清掉",
  /display/.test(userHost.getAttribute("style")) && /gap/.test(userHost.getAttribute("style")),
  "style=" + JSON.stringify(userHost.getAttribute("style")));
ok("真实装饰：body 进入批量态", doc.body.classList.contains("dsh-mf-batch-active"));

// --- 真实点击路径：document 上的捕获监听翻转选中态 ---
const asstBox = checkBox(asstHost);
asstBox.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
ok("真实点击：点勾选框把该单元加入选中集",
  api.batchStore.state.selectedIds.has("a:1") && api.batchStore.state.selectedIds.has("u:u1"),
  "selected=" + [...api.batchStore.state.selectedIds].join(","));
await sleep(120);
ok("真实点击后：防抖重绘把 aria-checked 同步成 true",
  asstBox.getAttribute("aria-checked") === "true" && asstBox.classList.contains("selected"));
asstBox.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
ok("真实点击：再点一次取消选中（不新建实例，也不误伤别的单元）",
  !api.batchStore.state.selectedIds.has("a:1") && api.batchStore.state.selectedIds.has("u:u1")
  && checkBox(asstHost) === asstBox,
  "selected=" + [...api.batchStore.state.selectedIds].join(","));
await sleep(120);
ok("真实点击后：取消选中同步到 aria-checked", asstBox.getAttribute("aria-checked") === "false");

// --- 退出多选：走真实的 store -> 防抖 -> clearDecorations() ---
api.batchStore.set({ isActive: false });
await sleep(150);
const afterExit = cleanSnapshot();
ok("退出多选后：注入节点、宿主 class、选中标记、body 批量态全部清空",
  afterExit.boxes === 0 && afterExit.hostClass === 0 && afterExit.selected === 0 && !afterExit.bodyActive,
  JSON.stringify(afterExit));
ok("退出多选后：补上的内联定位被回收，DSH 原有的内联属性原样留着",
  userHost.style.position === "" && !userHost.dataset.dshMfPos
  && !/position/.test(userHost.getAttribute("style") || "")
  && /display/.test(userHost.getAttribute("style")) && /gap/.test(userHost.getAttribute("style")),
  "style=" + JSON.stringify(userHost.getAttribute("style")) + " before=" + JSON.stringify(styleBefore.user));
ok("退出多选后：absolute 宿主的样式从未被动过",
  absoluteHost.getAttribute("style") === styleBefore.absolute);
ok("退出多选后：宿主回到 static（清理掉空 style 属性）",
  window.getComputedStyle(asstHost).position === "static" && asstHost.getAttribute("style") === styleBefore.asst,
  "style=" + JSON.stringify(asstHost.getAttribute("style")));

// 第一个装饰器实例到此功成身退：先跑它自己的 cleanup()，否则它的 observer 还活着，
// 会干扰下面第二次进入多选的断言。
cleanup();

// --- 卸载路径：真实 cleanup() 必须同样清干净，且迟到的防抖不能再装饰回来 ---
api.batchStore.set({ isActive: true, selectedIds: new Set(["a:1"]) });
const cleanup2 = api.setupBatchDecorator();
ok("再次进入多选：装饰可重复施加", checkBox(userHost) !== null && checkBox(asstHost) !== null);
cleanup2();
const afterTeardown = cleanSnapshot();
ok("cleanup() 后：注入节点 / 类名 / body 批量态全部清空",
  afterTeardown.boxes === 0 && afterTeardown.hostClass === 0 && !afterTeardown.bodyActive,
  JSON.stringify(afterTeardown));
ok("cleanup() 后：内联 position 已回收，其它宿主样式与无 style 宿主都回到原状",
  !/position/.test(userHost.getAttribute("style") || "")
  && absoluteHost.getAttribute("style") === styleBefore.absolute
  && asstHost.getAttribute("style") === styleBefore.asst,
  "user=" + JSON.stringify(userHost.getAttribute("style"))
  + " absolute=" + JSON.stringify(absoluteHost.getAttribute("style"))
  + " asst=" + JSON.stringify(asstHost.getAttribute("style")));

doc.body.appendChild(doc.createElement("div"));
await sleep(150);
ok("cleanup() 之后迟到的防抖不会再装饰回来（observer 已断开）",
  doc.querySelectorAll(".dsh-mf-check").length === 0 && !doc.body.classList.contains("dsh-mf-batch-active"));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
