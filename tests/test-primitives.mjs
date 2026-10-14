// 自有原语（Mf*）与浮层组件的真实渲染测试。
//
// 背景：插件规范（cordis-plugin-development/references/practices.md）禁止 require
// @deepseek-ai/dsh-client-ui-primitives 等 Harness Client 包，所以 lib/client.js 里
// 的 Button / Input / Modal / Toast / Tooltip 是按 primitives 的标记、行为与主题令牌
// 自己重写的。这一套是手写 JS，一旦抛错整个槽位会被清空（"slot entry crashed in ..."），
// 因此在浏览器之外用真实 React + jsdom 把每个组件的 DOM 结构、ARIA 与交互跑一遍。
//
// 依赖 react / react-dom 只用于本地测试，不写进 package.json：
//   cd tests && npm i --no-save jsdom react@18 react-dom@18
// 缺依赖时整套跳过（退出码仍是 0），不影响其它套件。
import fs from "node:fs";
import { createRequire } from "node:module";
import { localeSrc, portalSrc, widgetSrc } from "./_source.mjs";

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("SKIP  test-primitives.mjs  (jsdom 未安装)");
  process.exit(0);
}

const require = createRequire(import.meta.url);
let React, ReactDOMClient, act;
try {
  React = require("react");
  ReactDOMClient = require("react-dom/client");
  act = React.act || require("react-dom/test-utils").act;
} catch (err) {
  console.log("SKIP  test-primitives.mjs  (react / react-dom 未安装)");
  console.log("      cd tests && npm i --no-save jsdom react@18 react-dom@18");
  process.exit(0);
}

// --- jsdom first: React DOM reads document / window at require time -----------
const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 26 自带的 globalThis.navigator 只有 getter，不能直接赋值；React DOM 只用到它
// 的 userAgent，Node 自带的那份就够，不用换成 jsdom 的。
try { globalThis.navigator = dom.window.navigator; } catch { /* getter-only，忽略 */ }
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// React 自己也必须晚于 jsdom 生效后再取一次（client runtime 会读 document）
React = require("react");
ReactDOMClient = require("react-dom/client");

let passed = 0;
const failures = [];
function ok(label, condition) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}
function eq(label, actual, expected) {
  ok(`${label} (${JSON.stringify(actual)} === ${JSON.stringify(expected)})`, actual === expected);
}

// --- 把 §图标 + §自有原语 从 client.js 里切出来，配上真实 react / react-dom -----
const preamble = [
  'const React = require("react");',
  "const { createElement: h, cloneElement, Fragment, useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } = React;",
  // reactDom / portalToBody 由下面的 portalSrc 片段提供，别在这里重复声明。
].join("\n");

const harness = new Function(
  "require",
  `${preamble}
${localeSrc}
${portalSrc}
${widgetSrc}
return { MfButton, MfInput, MfModal, MfToast, MfTooltip, MF_FOCUSABLE, MF_TOAST_FADE_MS,
         ForwardIcon, PlusIcon, SearchIcon, WarnIcon, CheckIcon, CloseIcon };`,
);

let api;
try {
  api = harness(require);
} catch (err) {
  console.log("FAIL  切片求值抛出异常:", err && err.message);
  process.exit(1);
}
const {
  MfButton, MfInput, MfModal, MfToast, MfTooltip, MF_TOAST_FADE_MS,
  ForwardIcon, PlusIcon, SearchIcon, WarnIcon, CheckIcon, CloseIcon,
} = api;
ok("切成出来的组件全部是函数（导出名没被改名）",
  typeof MfButton === "function" && typeof MfInput === "function" && typeof MfModal === "function"
  && typeof MfToast === "function" && typeof MfTooltip === "function" && typeof CloseIcon === "function");
eq("MF_TOAST_FADE_MS 与 primitives 的 FADE_MS 一致", MF_TOAST_FADE_MS, 1000);

const root = ReactDOMClient.createRoot(document.getElementById("root"));
const flush = () => act(() => {});
// 测试文件自己的 h；harness 里那份只作用于被 eval 的切片。
const h = React.createElement;
function render(node) {
  act(() => root.render(node));
  return document.getElementById("root");
}

// =============================================================================
console.log("\n[1] MfButton —— 变体 / 尺寸 / icon / disabled / 事件透传");
{
  const host = render(
    h(MfButton, { variant: "primary", size: "sm", icon: h(CheckIcon), "aria-label": "确认", "data-x": "1" }, "确认"),
  );
  const btn = host.querySelector("button");
  ok("渲染出原生 button", !!btn);
  eq("type=button（避免表单里误提交）", btn.getAttribute("type"), "button");
  eq("类名带变体与尺寸", btn.className, "dsh-mf-button dsh-mf-button-primary dsh-mf-button-sm");
  eq("icon 包在 .dsh-mf-button-icon 里", !!btn.querySelector("span.dsh-mf-button-icon svg"), true);
  eq("children 文本保留", btn.textContent.trim(), "确认");
  eq("aria-label 透传", btn.getAttribute("aria-label"), "确认");
  eq("未知属性透传", btn.getAttribute("data-x"), "1");
  eq("默认变体是 ghost 且尺寸 md", (() => {
    render(h(MfButton, null, "x"));
    return document.querySelector("#root button").className;
  })(), "dsh-mf-button dsh-mf-button-ghost dsh-mf-button-md");

  render(h(MfButton, { disabled: true }, "禁用"));
  eq("disabled 落到真实属性上", document.querySelector("#root button").disabled, true);

  let clicks = 0;
  render(h(MfButton, { onClick: () => { clicks += 1; } }, "点我"));
  act(() => { document.querySelector("#root button").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  eq("onClick 透传", clicks, 1);
}

// =============================================================================
console.log("\n[2] MfInput —— 包装结构 / icon / input 属性");
{
  const host = render(
    h(MfInput, { icon: h(api.SearchIcon), placeholder: "搜索", value: "abc", onChange: () => {} }),
  );
  const wrap = host.querySelector("span.dsh-mf-input");
  ok("外层是 span.dsh-mf-input", !!wrap);
  ok("icon 在 .dsh-mf-input-icon 里", !!wrap.querySelector("span.dsh-mf-input-icon svg"));
  const input = wrap.querySelector("input.dsh-mf-input-field");
  ok("真实 input 带 .dsh-mf-input-field", !!input);
  eq("placeholder 透传", input.getAttribute("placeholder"), "搜索");
  eq("value 受控", input.value, "abc");
}

// =============================================================================
console.log("\n[3] MfModal —— portal / 结构 / 关闭路径 / 焦点回收");
{
  render(h(MfModal, { open: false, onClose: () => {}, title: "x" }, "body"));
  eq("open=false 什么都不渲染", document.querySelector(".dsh-mf-modal-root"), null);

  let closed = 0;
  const body = h("div", { className: "dsh-mf-modal-body" }, "内容");
  render(h(MfModal, {
    open: true,
    onClose: () => { closed += 1; },
    title: "转发消息",
    closeLabel: "关闭",
    className: "dsh-mf-dialog-extra",
    contentClassName: "dsh-mf-content-extra",
    footer: h("div", { className: "dsh-mf-modal-footer" }, "底部"),
    children: body,
  }));

  const portalRoot = document.body.querySelector(".dsh-mf-modal-root");
  ok("浮层 portal 到 document.body（不留在 #root 里）", !!portalRoot && !document.getElementById("root").querySelector(".dsh-mf-modal-root"));
  eq("外框 role=presentation", portalRoot.getAttribute("role"), "presentation");
  ok("有遮罩 .dsh-mf-modal-mask", !!portalRoot.querySelector("div.dsh-mf-modal-mask"));
  const dialog = portalRoot.querySelector("div.dsh-mf-dialog");
  ok("有 .dsh-mf-dialog 卡片", !!dialog);
  eq("dialog role", dialog.getAttribute("role"), "dialog");
  eq("dialog aria-modal", dialog.getAttribute("aria-modal"), "true");
  eq("dialog aria-label 取 title", dialog.getAttribute("aria-label"), "转发消息");
  ok("自定义 className 与自有类名共存", dialog.className.indexOf("dsh-mf-dialog-extra") >= 0);
  eq("标题在 h2.dsh-mf-modal-title", dialog.querySelector("h2.dsh-mf-modal-title").textContent, "转发消息");
  const closeBtn = dialog.querySelector("button.dsh-mf-modal-close");
  ok("有关闭按钮且是原生 button", !!closeBtn && closeBtn.getAttribute("type") === "button");
  eq("关闭按钮 aria-label 取 closeLabel", closeBtn.getAttribute("aria-label"), "关闭");
  ok("关闭按钮里是 CloseIcon", !!closeBtn.querySelector("svg"));
  const content = dialog.querySelector("div.dsh-mf-content");
  ok("contentClassName 加到 .dsh-mf-content 上", !!content && content.className.indexOf("dsh-mf-content-extra") >= 0);
  ok("children 直接挂在 content 下（不再多包一层 body，避免双 padding）",
    !!content.querySelector("div.dsh-mf-modal-body")
    && content.querySelector("div.dsh-mf-modal-body").parentElement === content);
  ok("footer 是 content 的兄弟节点（CSS 的收缩链依赖它）",
    !!dialog.querySelector(".dsh-mf-modal-footer") && dialog.querySelector(".dsh-mf-modal-footer").parentElement === dialog);

  act(() => { closeBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  eq("点关闭按钮触发 onClose", closed, 1);

  act(() => {
    document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  eq("Esc 触发 onClose", closed, 2);

  act(() => {
    document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, repeat: true }));
  });
  eq("长按 Esc（repeat）不重复关闭", closed, 2);

  act(() => {
    document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, ctrlKey: true }));
  });
  eq("带修饰键的 Esc 不关闭", closed, 2);
}

// =============================================================================
console.log("\n[4] MfToast —— 色调 / 结构 / 自动消失");
{
  render(h(MfToast, { text: "已转发", tone: "success", holdMs: 3400, onDone: () => {} }));
  const toast = document.body.querySelector("div.dsh-mf-toast");
  ok("toast portal 到 body", !!toast);
  eq("role=alert", toast.getAttribute("role"), "alert");
  eq("停留时长走 CSS 变量", toast.style.getPropertyValue("--dsh-mf-toast-hold"), "3400ms");
  ok("成功色调用 .dsh-mf-toast-icon-success + 内置对勾", !!toast.querySelector("span.dsh-mf-toast-icon-success svg"));
  eq("文案在 .dsh-mf-toast-text 里", toast.querySelector("span.dsh-mf-toast-text").textContent, "已转发");
  eq("默认不是 success 色调", (() => {
    render(h(MfToast, { text: "普通提示", icon: h(api.WarnIcon), holdMs: 10, onDone: () => {} }));
    const t2 = document.body.querySelector("div.dsh-mf-toast");
    return t2.querySelector("span.dsh-mf-toast-icon-success") === null;
  })(), true);

  let done = 0;
  render(h(MfToast, { text: "自动消失", holdMs: 0, onDone: () => { done += 1; } }));
  await new Promise((resolve) => setTimeout(resolve, MF_TOAST_FADE_MS + 120));
  eq("holdMs + FADE_MS 后调用 onDone（清理定时器不会提前触发）", done, 1);
  render(null);
}

// =============================================================================
console.log("\n[5] MfTooltip —— 只在提示时才 portal，且不吞掉子元素自己的 ref");
{
  const ownRef = React.createRef();
  render(
    h(MfTooltip, { label: "转发这条回复", side: "bottom" },
      h("button", { ref: ownRef, type: "button", className: "dsh-mf-btn" }, "x")),
  );
  eq("未悬停时不渲染气泡", document.body.querySelector(".dsh-mf-tooltip"), null);
  ok("子元素自己的 ref 仍然拿到 DOM 节点（React 18 element.ref 路径）",
    !!ownRef.current && ownRef.current.className === "dsh-mf-btn");

  const btn = document.querySelector("#root button.dsh-mf-btn");
  act(() => { btn.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true })); });
  const bubble = document.body.querySelector("div.dsh-mf-tooltip");
  ok("聚焦后气泡出现", !!bubble);
  eq("role=tooltip", bubble && bubble.getAttribute("role"), "tooltip");
  eq("data-side 透传到气泡上（CSS 变换依赖它）", bubble && bubble.getAttribute("data-side"), "bottom");
  eq("提示文案在 .dsh-mf-tooltip-label 里", bubble.querySelector("span.dsh-mf-tooltip-label").textContent, "转发这条回复");

  act(() => { btn.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })); });
  eq("失焦后气泡收起", document.body.querySelector(".dsh-mf-tooltip"), null);

  // label 支持函数（槽位里传的是 t() 结果，这里验证 callable 形态）
  render(h(MfTooltip, { label: () => "函数式文案" }, h("button", { type: "button" }, "y")));
  act(() => { document.querySelector("#root button").dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true })); });
  eq("label 可以是函数", document.body.querySelector(".dsh-mf-tooltip span.dsh-mf-tooltip-label").textContent, "函数式文案");
  render(null);
}

// =============================================================================
console.log("\n[6] 切片自检：这段源码里不许出现被规范禁止的 require");
{
  const full = fs.readFileSync(new URL("./_source.mjs", import.meta.url), "utf8");
  ok("_source.mjs 本身不 require 任何 @deepseek-ai/*", full.indexOf("@deepseek-ai") < 0);
  const forbidden = /require\(\s*["']@deepseek-ai\//.test(widgetSrc + portalSrc + localeSrc);
  ok("图标 / 自有原语 / 浮层切片里没有 @deepseek-ai/* 依赖", !forbidden);
}

// =============================================================================
console.log(`\n=== ${passed} passed, ${failures.length} failed ===`);
if (failures.length) {
  for (const f of failures) console.log("  -", f);
  process.exit(1);
}
