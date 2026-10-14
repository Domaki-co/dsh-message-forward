// 入口集成测试：把整个 lib/client.js 当成浏览器产物跑一遍。
//
// 前面的套件都是「切片段再 eval」，只能证明片段自身能解析。这一套补上真正的端到端路径：
// 用 stub 的 window.__ModuleLoader__ 接下模块定义，用真实 react / react-dom 满足 require，
// 再用 mock ctx 调用 apply()，检查
//   - 槽位 / 命令 / 词表是不是按规范挂上去的；
//   - DOM 注入路径在真实 DSH DOM 契约下能不能生效；
//   - 每个资源是不是都返回了清理函数，卸载后有没有留下 DOM 残留（含迟到的定时器）。
// 依赖 jsdom / react / react-dom 缺失时整套跳过。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("SKIP  test-entry.mjs  (jsdom 未安装)");
  process.exit(0);
}
const require = createRequire(import.meta.url);
try {
  require("react");
  require("react-dom");
} catch {
  console.log("SKIP  test-entry.mjs  (react / react-dom 未安装)");
  console.log("      cd tests && npm i --no-save jsdom react@18 react-dom@18");
  process.exit(0);
}

let passed = 0;
const failures = [];
function ok(label, condition) {
  if (condition) { passed += 1; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}`); }
}
function eq(label, actual, expected) {
  ok(`${label} (${JSON.stringify(actual)} === ${JSON.stringify(expected)})`, actual === expected);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- 真实 DSH 聊天 DOM 契约（与 test-decorator.mjs 用的是同一份） --------------
const dom = new JSDOM(`<!doctype html><html><head></head><body>
 <div id="root">
  <div class="icaHSq_flowItem" data-chat-flow-key="u1" data-chat-flow-kind="user" data-chat-turn="1">
    <div class="IzP3Va_userRow">
      <div class="IzP3Va_bubble">第一条提问</div>
      <div class="ppByMG_actions" data-clock="start"><button>c</button></div>
    </div>
  </div>
  <div class="icaHSq_flowItem" data-chat-flow-key="a1" data-chat-flow-kind="assistant-step" data-chat-turn="1">
    <div class="ppByMG_text">第一条回答</div>
  </div>
 </div>
</body></html>`, { pretendToBeVisual: true, url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
try { globalThis.navigator = dom.window.navigator; } catch { /* Node 26 getter-only */ }
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const src = fs.readFileSync(path.join(root, "lib", "client.js"), "utf8");

// =============================================================================
console.log("\n[1] 浏览器产物被模块加载器接住");
let definition = null;
dom.window.__ModuleLoader__ = { load: (def) => { definition = def; } };
try {
  new Function("window", "document", "MutationObserver", src)(
    dom.window, dom.window.document, dom.window.MutationObserver);
} catch (err) {
  console.log("FAIL  lib/client.js 在浏览器环境下执行时报错:", err && err.message);
  process.exit(1);
}
ok("__ModuleLoader__.load 被调用", !!definition);
eq("注册的模块 id 等于包名", definition && definition.id, pkg.name);
ok("factory 是函数", definition && typeof definition.factory === "function");

const exportsObj = definition.factory((name) => require(name));
ok("工厂返回 apply", typeof exportsObj.apply === "function");
// 规范：工厂求值阶段必须无副作用 —— 样式表不能在 factory 里就往 head 塞节点。
ok("工厂求值阶段不碰 DOM（样式表交给 apply 注册）",
  dom.window.document.getElementById("dsh-message-forward-styles") === null
  && dom.window.document.head.querySelectorAll("style").length === 0);
ok("工厂返回 inject", Array.isArray(exportsObj.inject));
ok("客户端半边不导出 name（协议与出货插件一致：只有 apply / inject）", exportsObj.name === undefined);
// dsh.client.inject 声明的是「包名」，客户端 inject 声明的是「服务名」，两者不是同一套符号，
// 所以这里断言的是服务集合本身；包与服务的对应关系由 test-conformance 的 peer 检查兜底。
eq("inject 声明的服务集合完整（slots / locale / sessions / workspaces / uiWorkspace）",
  JSON.stringify([...exportsObj.inject].sort()),
  JSON.stringify(["locale", "sessions", "slots", "uiWorkspace", "workspaces"]));

// =============================================================================
console.log("\n[2] apply(ctx) 按规范注册资源，并且每个都返回清理函数");
const calls = { slots: [], effects: [], commands: [], locale: [] };
const scope = {
  get: (name) => (name === "commandUi"
    ? { register: (cmd) => { calls.commands.push(cmd); return () => {}; } }
    : undefined),
  effect: (fn, label) => {
    const dispose = fn();
    calls.effects.push({ label, dispose });
    return dispose;
  },
};
const localeService = {
  register: (ns, dicts) => { calls.locale.push({ ns, dicts }); return () => {}; },
  bind: (ns) => (key) => key, // 故意不翻译：t() 应回落到内置词表
};
const ctx = {
  get: (name) => (name === "locale" ? localeService : undefined),
  effect: (fn, label) => {
    const dispose = fn();
    calls.effects.push({ label, dispose });
    return dispose;
  },
  inject: (deps, cb) => { cb(scope); },
  slots: {
    inject: (parent, cb) => { const entry = cb(); calls.slots.push({ parent, entry }); return entry; },
    register: (opts, component) => ({ opts, component, dispose: () => {} }),
  },
};

try {
  exportsObj.apply(ctx);
} catch (err) {
  console.log("FAIL  apply(ctx) 抛出异常:", err && err.stack);
  process.exit(1);
}
ok("apply(ctx) 正常返回", true);

// --- 槽位 -------------------------------------------------------------------
eq("注册了 3 个槽位", calls.slots.length, 3);
ok("槽位名与父槽一致（写错名字会静默失效）",
  calls.slots.every((s) => s.entry.opts.name === s.parent));
eq("槽位与 id 的对应关系",
  JSON.stringify(calls.slots.map((s) => [s.parent, s.entry.opts.id])),
  JSON.stringify([
    ["conversation.chat.assistant-actions", "forward-action"],
    ["conversation.session.header.utilities", "forward-header-utility"],
    ["conversation.input.overlay", "forward-overlay"],
  ]));
ok("每个槽位都带 locale: LOCALE_NS（拿到渲染器的 t 座位）",
  calls.slots.every((s) => s.entry.opts.locale === pkg.name));
ok("每个槽位都带数字 order", calls.slots.every((s) => typeof s.entry.opts.order === "number"));
ok("每个槽位都挂了组件函数", calls.slots.every((s) => typeof s.entry.component === "function"));

// --- 词表 -------------------------------------------------------------------
eq("词表注册了一次", calls.locale.length, 1);
eq("词表命名空间是包名", calls.locale[0]?.ns, pkg.name);
eq("词表同时注册 zh / en", JSON.stringify(Object.keys(calls.locale[0]?.dicts || {})), '["zh","en"]');
ok("词表非空且 zh/en 键一致",
  Object.keys(calls.locale[0].dicts.zh).length > 0
  && Object.keys(calls.locale[0].dicts.zh).length === Object.keys(calls.locale[0].dicts.en).length);

// --- 命令 -------------------------------------------------------------------
eq("/forward 命令注册了一次", calls.commands.length, 1);
const cmd = calls.commands[0] || {};
eq("命令名是 forward", cmd.name, "forward");
ok("label 是函数（渲染时才取文案）",
  typeof cmd.label === "function" && typeof cmd.label() === "string" && cmd.label().length > 0);
ok("命令文案不是裸 key（locale 服务不翻译时回落到内置词表）",
  typeof cmd.label === "function" && !/^[a-z]+\.[a-z]+$/.test(cmd.label()));
ok("available() 返回 true", typeof cmd.available === "function" && cmd.available() === true);
eq("命令是 action 形态", cmd.ui?.kind, "action");
ok("run 是函数", typeof cmd.ui?.run === "function");

// --- 清理函数 ---------------------------------------------------------------
eq("ctx.effect 被用了 6 次（词表 / 命令 / 用户消息按钮 / 多选装饰 / 样式表 / 草稿队列）", calls.effects.length, 6);
const cleanups = calls.effects.map((e) => e.dispose);
eq("每一次 ctx.effect 都拿回了清理函数（规范：注册即返回清理）",
  cleanups.filter((d) => typeof d === "function").length, calls.effects.length);
ok("effect 都带了可以定位的 label",
  calls.effects.every((e) => typeof e.label === "string" && e.label.startsWith(pkg.name)));
ok("标签能区分不同资源", new Set(calls.effects.map((e) => e.label)).size === calls.effects.length);
console.log("       标签:", calls.effects.map((e) => e.label.replace(`${pkg.name}: `, "")).join(" | "));

// =============================================================================
console.log("\n[3] DOM 注入路径：用户消息按钮 + 多选装饰");
{
  // apply() 里的首次 scan() 是同步的，所以此刻按钮应该已经插好了。
  const btn = dom.window.document.querySelector(".dsh-mf-user-btn");
  ok("用户消息操作行被插入了转发按钮", !!btn);
  if (btn) {
    eq("按钮插在原有按钮之后（不抢占首个位置）",
      btn.previousElementSibling && btn.previousElementSibling.tagName, "BUTTON");
    eq("按钮类名是 .dsh-mf-btn（与槽位里的按钮同一套样式）",
      btn.className, "dsh-mf-btn dsh-mf-user-btn");
    eq("aria-label 走词表（不是硬编码中文）", btn.getAttribute("aria-label"), calls.locale[0].dicts.zh["action.forwardMessage"]);
    eq("title 走词表", btn.getAttribute("title"), calls.locale[0].dicts.zh["action.forwardMessageTip"]);
    ok("按钮里是内联 SVG（不 require 任何图标包）", !!btn.querySelector("svg path"));
    eq("重复 scan 不会插第二个按钮", (() => {
      dom.window.document.body.appendChild(dom.window.document.createElement("span"));
      return dom.window.document.querySelectorAll(".dsh-mf-user-btn").length;
    })(), 1);
  }
  eq("未进入多选模式时不留勾选框", dom.window.document.querySelectorAll(".dsh-mf-check").length, 0);

  // 长按（右键等价路径）应进入多选模式，随后由 store 订阅触发装饰
  if (btn) {
    btn.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sleep(160); // decorate 是 80ms 防抖的
    ok("进入多选模式后 body 带上 dsh-mf-batch-active",
      dom.window.document.body.className.includes("dsh-mf-batch-active"));
    ok("进入多选模式后消息上出现勾选框",
      dom.window.document.querySelectorAll(".dsh-mf-check").length > 0);
    const box = dom.window.document.querySelector(".dsh-mf-check");
    eq("勾选框是可访问的 checkbox 角色", box && box.getAttribute("role"), "checkbox");
    eq("勾选框带 tabindex（键盘可达）", box && box.getAttribute("tabindex"), "0");
    // 长按是「以这条消息为起点」进入多选，所以被长按的那条默认已选中。
    eq("被长按的消息默认已选中", box && box.getAttribute("aria-checked"), "true");
    eq("选中态的 title 走词表", box && box.getAttribute("title"), calls.locale[0].dicts.zh["action.unselectMessage"]);
    ok("选中态带 .selected 与 .dsh-mf-unit-selected",
      !!box && box.classList.contains("selected")
      && box.parentElement.classList.contains("dsh-mf-unit-selected"));
    ok("宿主元素被标上 .dsh-mf-check-host", !!dom.window.document.querySelector(".dsh-mf-check-host"));

    // 点勾选框应取消选择，并把 aria / title 一起翻回去
    if (box) {
      box.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await sleep(120);
      eq("点一下取消选择：aria-checked=false", box.getAttribute("aria-checked"), "false");
      eq("取消选择后的 title 走词表", box.getAttribute("title"), calls.locale[0].dicts.zh["action.selectMessage"]);
      eq("取消选择后 .selected 被摘掉", box.classList.contains("selected"), false);
    }
  }
}

// =============================================================================
console.log("\n[4] 卸载路径：清理函数跑完不留残留，迟到的定时器也不能复活装饰");
{
  const styleBefore = dom.window.document.getElementById("dsh-message-forward-styles");
  ok("样式表由 apply 的 ctx.effect 注入 head",
    !!styleBefore && styleBefore.parentNode === dom.window.document.head);
  ok("注入的是真实样式内容（不是空 style 占位）",
    !!styleBefore && styleBefore.textContent.includes(".dsh-mf-bar"));

  let threw = null;
  for (const dispose of cleanups) {
    try { dispose(); } catch (err) { threw = threw || err; }
  }
  ok("所有清理函数都能安全执行（不会在卸载时炸掉）", threw === null);
  if (threw) console.log("       >", threw && threw.message);

  eq("卸载后样式表从 head 摘除（清理函数真的生效）",
    dom.window.document.getElementById("dsh-message-forward-styles"), null);
  eq("卸载后 head 里没有残留的插件样式节点",
    dom.window.document.head.querySelectorAll("style").length, 0);
  eq("立刻检查：body 上没有残留的 dsh-mf-* 元素",
    dom.window.document.querySelectorAll("body [class*='dsh-mf-']").length, 0);
  eq("立刻检查：批量模式 class 已摘掉",
    dom.window.document.body.className.includes("dsh-mf-batch-active"), false);

  // 防抖定时器若没被取消，会在卸载后把装饰重新插回来 —— 这里等一下再看一次。
  dom.window.document.body.appendChild(dom.window.document.createElement("span"));
  await sleep(220);
  eq("等 220ms 后再检查：迟到的 observer/定时器没有复活装饰",
    dom.window.document.querySelectorAll("body [class*='dsh-mf-']").length, 0);
}

// =============================================================================
// 草稿 ack 与多选快照这两条契约发生在 overlay / 工具条这些「真实 host 才渲染得出来」的
// 组件里：jsdom 里既没有 slot 渲染器也拿不到模块内部的 draftHub，所以这一节退一步，
// 对源码结构下断言 —— 锁的是调用顺序（ack 必须晚于 setDraft 成功、合并必须走快照），
// 而不是实现细节。
console.log("\n[5] 草稿 ack 与多选快照：调用顺序契约");
{
  const MARK = "\t\t// " + "-".repeat(64) + " ";
  const cut = (from, to) => src.slice(src.indexOf(MARK + from), src.indexOf(MARK + to));
  const storeSeg = cut("轻量 store", "文案 / 内容提取");
  const modalSeg = cut("转发弹窗", "草稿落地（目标会话内）");
  const draftSeg = cut("草稿落地（目标会话内）", "槽组件");
  const unitSeg = cut("批量多选：消息单元", "批量工具条");
  const barSeg = cut("批量工具条", "转发弹窗");

  const setAt = draftSeg.indexOf("inputActions.setDraft(pending.text");
  const ackAt = draftSeg.indexOf("draftHub.resolve(sessionId)");
  ok("overlay 只有在 setDraft 之后才 ack（ack 位置晚于 setDraft 调用）", setAt > -1 && ackAt > setAt);
  const missAt = draftSeg.indexOf('typeof inputActions.setDraft !== "function"');
  const attachAt = draftSeg.indexOf("addAttachments");
  ok("inputActions.setDraft 缺失时 return（不会落到 addAttachments 形成半应用）",
    missAt > -1 && attachAt > missAt && draftSeg.slice(missAt, attachAt).includes("return;"));
  ok("成功提示不再由 overlay 直接发（只按 ack 结果发一次）", !draftSeg.includes("notify("));

  const reqAt = modalSeg.indexOf("draftHub.request(");
  const jumpAt = modalSeg.indexOf("jumpToSession(finalTarget)");
  const awaitAt = modalSeg.indexOf("await deliver");
  ok("投递链顺序仍是 request → jump → 等 ack（jump 没有被 ack 等待挤掉）",
    reqAt > -1 && jumpAt > reqAt && awaitAt > jumpAt);
  ok("ack 之前不发成功提示；失败走 notify.draftNotFilled",
    modalSeg.indexOf("notify.draftFilled") > awaitAt && modalSeg.indexOf("notify.draftNotFilled") > awaitAt);

  const takeBody = storeSeg.slice(storeSeg.indexOf("take(sessionId) {"), storeSeg.indexOf("resolve(sessionId) {"));
  ok("take() 交出的是副本，pending 原地保留",
    takeBody.includes("return { sessionId: p.sessionId"));
  ok("take() 只在超过 TTL 时才丢 pending",
    takeBody.includes("DRAFT_PENDING_TTL_MS")
    && takeBody.indexOf("this.pending = null;") > takeBody.indexOf("DRAFT_PENDING_TTL_MS"));

  ok("合并存在快照通道", unitSeg.includes("function snapshotForUnit("));
  ok("mergeUnits 走快照通道（不再只看当前 DOM）",
    unitSeg.slice(unitSeg.indexOf("function mergeUnits(")).includes("snapshotForUnit("));
  ok("旧的「按当前 DOM 过滤选中单元」的合并表达式已消失",
    !unitSeg.includes("units.filter((u) => selectedIds.has(u.id))"));
  ok("快照缓存随多选进入 / 退出一起清空（有界）",
    ((unitSeg + barSeg).match(/resetSelectionCache\(\)/g) || []).length >= 3);
  ok("有单元既不在 DOM 也无快照时会给出可见提示",
    barSeg.includes("notify.mergeIncomplete") && barSeg.includes("merged.missing > 0"));
  ok("全选 / 清空都走同一条快照路径",
    barSeg.includes("replaceSelection(units)") && barSeg.includes("replaceSelection([])"));
}

// =============================================================================
console.log(`\n=== ${passed} passed, ${failures.length} failed ===`);
if (failures.length) {
  for (const f of failures) console.log("  -", f);
  process.exit(1);
}
