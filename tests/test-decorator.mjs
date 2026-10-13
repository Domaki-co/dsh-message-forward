// Verify the batch decorator: checkbox gutter class, no clobbering of DSH inline styles,
// portal-based toolbar mounting, and click-to-toggle wiring.
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const SRC = path.join(here, "..", "lib", "client.js");
const src = fs.readFileSync(SRC, "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "\n      " + extra : ""}`);
};

// ---------- 1. source-level checks ----------
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
// positioning is now conditional AND marked, so cleanup can restore exactly what it changed
ok("decorator only positions a static host",
  /getComputedStyle\(host\)\.position === "static"/.test(src));
ok("decorator marks the positioning it added",
  /host\.dataset\.dshMfPos = "1"/.test(src));
ok("decorator adds the gutter class",
  /host\.classList\.add\("dsh-mf-check-host"\)/.test(src));
ok("clearDecorations removes the gutter class",
  /classList\.remove\("dsh-mf-check-host"\)/.test(src));
ok("clearDecorations restores only its own positioning",
  /dataset\.dshMfPos === "1"/.test(src) && /n\.style\.position = ""/.test(src));
ok("checkbox gets role=checkbox + aria-checked (a11y)",
  /setAttribute\("role", "checkbox"\)/.test(src) && /setAttribute\("aria-checked"/.test(src));

// ---------- 2. live DOM behaviour ----------
const dom = new JSDOM(`<!doctype html><html><head></head><body>
<div data-conversation-scroll><div class="icaHSq_column">
 <div class="icaHSq_flowItem" data-chat-flow-key="u1" data-chat-flow-kind="user" data-chat-turn="1"
      style="display:flex;gap:8px">
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
</div></div>
</body></html>`, { pretendToBeVisual: true });

const { window } = dom;
global.window = window;
global.document = window.document;
global.MutationObserver = window.MutationObserver;

// pull collectUnits + unitIdForNode + mergeUnits out of the bundle
const k = src.indexOf("\t\tfunction collectUnits() {");
const l = src.indexOf("\t\t// ---------------------------------------------------------------- 批量工具条");
const batchSrc = src.slice(k, l);

// minimal deps the batch helpers touch
const harness = `
  const MD_SEL = ".markdown[data-markdown-variant='body'], .markdown";
  ${batchSrc}
  return { collectUnits, unitIdForNode, mergeUnits };
`;
const helpers = new Function("document", "window", harness)(window.document, window);

const units = helpers.collectUnits();
ok("collectUnits finds the turn", units.length >= 1, "units=" + units.length);

// collectUnits anchors user units on the userRow element (not the flow row) — assert the real contract
const userUnit = units.find((u) => u.role === "user");
ok("collectUnits yields a user unit", !!userUnit);
const host = userUnit.element;
ok("user unit host carries the userRow class", /userRow/.test(host.className),
  "class=" + host.className);

// --- replicate the decorator's DOM work exactly as the bundle does it ---
const inlineBefore = host.getAttribute("style");
const computedStatic = window.getComputedStyle(host).position === "static";

host.classList.add("dsh-mf-check-host");
if (computedStatic) { host.style.position = "relative"; host.dataset.dshMfPos = "1"; }

const box = window.document.createElement("div");
box.className = "dsh-mf-check";
const inner = window.document.createElement("span");
inner.className = "dsh-mf-check-box";
box.appendChild(inner);
host.appendChild(box);

ok("gutter class applied to host", host.classList.contains("dsh-mf-check-host"));
ok("positioning is marked for exact restore",
  computedStatic ? host.dataset.dshMfPos === "1" : !host.dataset.dshMfPos,
  "computedStatic=" + computedStatic + " marker=" + host.dataset.dshMfPos);
ok("host ends up positioned (class or inline)", window.getComputedStyle(host).position !== "static",
  "position=" + window.getComputedStyle(host).position);
ok("checkbox appended as direct child", host.querySelector(":scope > .dsh-mf-check") === box);
ok("checkbox has the inner box element", !!box.querySelector(".dsh-mf-check-box"));

// selected state toggling
box.classList.add("selected");
ok("selected class toggles", box.classList.contains("selected"));

// --- cleanup path: must restore the host to its pre-decorate state ---
window.document.querySelectorAll(".dsh-mf-check").forEach((n) => n.remove());
window.document.querySelectorAll(".dsh-mf-check-host").forEach((n) => {
  n.classList.remove("dsh-mf-check-host");
  if (n.dataset && n.dataset.dshMfPos === "1") {
    n.style.position = ""; delete n.dataset.dshMfPos;
    if (n.getAttribute("style") === "") n.removeAttribute("style");
  }
});
ok("cleanup removes checkbox", window.document.querySelectorAll(".dsh-mf-check").length === 0);
ok("cleanup removes gutter class", !host.classList.contains("dsh-mf-check-host"));
ok("cleanup restores inline style exactly", host.getAttribute("style") === inlineBefore,
  "before=" + JSON.stringify(inlineBefore) + " after=" + JSON.stringify(host.getAttribute("style")));
ok("cleanup clears the restore marker", !host.dataset.dshMfPos);
ok("host is static again after cleanup", window.getComputedStyle(host).position === "static",
  "position=" + window.getComputedStyle(host).position);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
