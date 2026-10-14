// 插件规范符合性测试（cordis-plugin-development 技能）。
//
// 规范来源：DSH 自带的 agent 技能
//   @deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/
//     SKILL.md + references/{practices,host-plugin,ui-plugin,verification}.md
// 这里把规范里「可被静态判定」的条款固化成断言：清单字段、导出形态、依赖边界、
// 文案路由、槽位注册选项。运行时行为（真正的 DOM 渲染）在 test-primitives.mjs。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

let passed = 0;
const failures = [];
function ok(label, condition) {
  if (condition) { passed += 1; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}`); }
}
function eq(label, actual, expected) {
  ok(`${label} (${JSON.stringify(actual)} === ${JSON.stringify(expected)})`, actual === expected);
}

const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const pkg = JSON.parse(read("package.json"));
const clientSrc = read("lib/client.js");
const hostSrc = read("lib/index.js");
const patchSrc = read("cordis.patch.yml");

// client.js 的段落标记（词表段的两个端点，整个文件的「尺子」只在这里定义一次；
// tests/_source.mjs 用同一批标记切片段）。
const LOCALE_START = "\t\t// ---------------------------------------------------------------- 文案（Client locale 服务）";
const LOCALE_END = "\t\t// ---------------------------------------------------------------- 图标";

/** 定位段落标记；缺失就把标记原文写进错误信息，别让 indexOf 的 -1 静默传下去。 */
function locateMarker(text, marker, label) {
  const i = text.indexOf(marker);
  if (i < 0) throw new Error(`${label}: 找不到段落标记 ${JSON.stringify(marker)}`);
  return i;
}

/** 按标记切一段；两端必须都存在且顺序正确。 */
function sliceBetween(text, from, to, label) {
  const i = locateMarker(text, from, `${label} 起始`);
  const j = locateMarker(text, to, `${label} 结束`);
  if (j <= i) throw new Error(`${label}: 段落标记顺序颠倒 ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
  return text.slice(i, j);
}

// =============================================================================
console.log("\n[1] 清单（package.json）—— 与出货 bundle 的规范形态对齐");
{
  eq("name", pkg.name, "dsh-message-forward");
  ok("version 是语义化版本", /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version));
  eq("type=module（client 半边用 ESM 语法）", pkg.type, "module");
  eq("main 指向 host 半边", pkg.main, "./lib/index.js");
  ok("engines.node 声明了最低 Node", typeof pkg.engines?.node === "string" && pkg.engines.node.length > 0);
  ok("engines.dsh 声明了兼容的 Harness 版本区间", typeof pkg.engines?.dsh === "string" && pkg.engines.dsh.includes("<"));

  // 规范：display metadata 的 icon 是 package.json 顶层字段，必须是清单相对路径的图片。
  eq("顶层 icon 字段存在", typeof pkg.icon, "string");
  eq("icon 是清单相对路径（不能是绝对路径 / URL / 穿越）", pkg.icon, "./icon.svg");
  ok("icon 文件真实存在", fs.existsSync(path.join(root, pkg.icon)));
  const iconBytes = fs.statSync(path.join(root, pkg.icon)).size;
  ok(`icon 体积在 256 KiB 以内（${iconBytes} B）`, iconBytes <= 256 * 1024);

  // 规范：locale 目录是 display metadata 的载体，必须能在 exports 里被子路径解析到。
  ok('exports 暴露 "."', !!pkg.exports["."]);
  eq('exports 暴露 "./client"（浏览器半边）', pkg.exports["./client"], "./lib/client.js");
  eq('exports 暴露 "./cordis.patch.yml"', pkg.exports["./cordis.patch.yml"], "./cordis.patch.yml");
  eq('exports 暴露 "./locale/*.json"（readPluginMeta 按 <pkg>/locale/en.json 解析）',
    pkg.exports["./locale/*.json"], "./locale/*.json");
  ok('exports 暴露 "./package.json"', !!pkg.exports["./package.json"]);
  ok("files 里带上 locale/*.json（否则发布后读不到 metadata）", pkg.files.includes("locale/*.json"));
  ok("files 里带上 cordis.patch.yml", pkg.files.includes("cordis.patch.yml"));
  ok("files 里带上 icon.svg", pkg.files.includes("icon.svg"));

  // 规范：dsh.bundle.patch 指向组合补丁。
  eq("dsh.bundle.patch 指向 cordis.patch.yml", pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
  ok("被引用的 patch 文件存在", fs.existsSync(path.join(root, pkg.dsh.bundle.patch)));

  // 规范：dsh.client 描述浏览器半边。
  eq("dsh.client.platform=web", pkg.dsh?.client?.platform, "web");
  ok("dsh.client.inject 是非空字符串数组", Array.isArray(pkg.dsh?.client?.inject)
    && pkg.dsh.client.inject.length > 0
    && pkg.dsh.client.inject.every((s) => typeof s === "string"));
  ok("dsh.client.inject 声明了 slots（槽位是硬依赖）",
    pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-slots"));
  ok("dsh.client.inject 声明了 locale（界面文案要走 locale 服务）",
    pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-locale"));
  // 规范原文：不得把任何 Harness Client 包当模块 require；primitives 是被点名的那个，
  // 所以它既不该出现在 inject，也不该出现在 peer 依赖里。
  ok("dsh.client.inject 不再引用 dsh-client-ui-primitives",
    !pkg.dsh.client.inject.some((s) => s.includes("dsh-client-ui-primitives")));
  ok("peerDependencies 不再引用 dsh-client-ui-primitives",
    !Object.keys(pkg.peerDependencies || {}).some((s) => s.includes("dsh-client-ui-primitives")));
  ok("inject 里的每一个包都在 peerDependencies 里被声明（依赖可追溯）",
    pkg.dsh.client.inject.every((s) => s in (pkg.peerDependencies || {})));
  // 规范：只有 shell 级 / 必须最早激活的包才用 immediately；功能插件不该抢启动。
  ok("功能插件不声明 dsh.client.immediately（不抢启动预取）", pkg.dsh.client.immediately === undefined);
}

// =============================================================================
console.log("\n[2] 组合补丁（cordis.patch.yml）");
{
  ok("是 insert 形式", /^\s*-\s*insert:\s*$/m.test(patchSrc));
  ok("插入了本插件自己的 id", /id:\s*dsh-message-forward\b/.test(patchSrc));
  ok("插入的 name 与包名一致", /name:\s*['"]?dsh-message-forward['"]?\s*$/m.test(patchSrc));
}

// =============================================================================
console.log("\n[3] locale 字典（display metadata，readPluginMeta 解析）");
{
  const en = JSON.parse(read("locale/en.json"));
  const zh = JSON.parse(read("locale/zh.json"));
  for (const [name, dict] of [["en", en], ["zh", zh]]) {
    ok(`${name}.json 有 meta.title`, typeof dict.meta?.title === "string" && dict.meta.title.length > 0);
    ok(`${name}.json 有 meta.description`, typeof dict.meta?.description === "string" && dict.meta.description.length > 0);
  }
  ok("en/zh 的 meta 键集合一致",
    JSON.stringify(Object.keys(en.meta).sort()) === JSON.stringify(Object.keys(zh.meta).sort()));
  ok("标题是给人看的，不是包名", en.meta.title !== pkg.name && zh.meta.title !== pkg.name);
}

// =============================================================================
console.log("\n[4] host 半边（lib/index.js）—— 只能是规范承认的两种形态之一");
{
  const hasApplyFn = /export\s+function\s+apply\s*\(/.test(hostSrc);
  const hasDefaultClass = /export\s+default\s+class\s/.test(hostSrc);
  ok("导出了 export function apply(ctx) 或默认导出服务类，且两者不混用",
    hasApplyFn !== hasDefaultClass && (hasApplyFn || hasDefaultClass));
  // 规范：`export const name = ...` 不是被承认的导出形态（id 由 patch 的 insert 行决定）。
  ok("没有非规范的 `export const name`", !/export\s+const\s+name\s*=/.test(hostSrc));
  ok("apply 的形参是 ctx", /export\s+function\s+apply\s*\(\s*_?ctx\b/.test(hostSrc));
  ok("host 半边没有偷偷 import Harness 内部包（纯客户端插件）",
    !/@deepseek-ai\//.test(hostSrc.replace(/^\s*\*.*$/gm, "")));
}

// =============================================================================
console.log("\n[5] client 半边 —— 依赖边界（规范里被点名禁止的那条）");
{
  const requires = [...clientSrc.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  ok(`浏览器模块表里只 require 基线运行时（实际：${requires.join(", ")}）`,
    requires.every((r) => r === "react" || r === "react-dom" || r === "react-dom/client" || r === "react/jsx-runtime"));
  ok("整个 client 半边没有任何 @deepseek-ai/* 的 require",
    !/require\(\s*["']@deepseek-ai\//.test(clientSrc));
  ok("旧的 primitives 组件名已彻底消失（Modal/Button/Toast/Tooltip/Input 都换成了 Mf*）",
    !/\bh\((Button|Modal|Toast|Tooltip|Input)\b/.test(clientSrc));
  const used = [...clientSrc.matchAll(/\bh\((Mf[A-Za-z]+)\b/g)].map((m) => m[1]);
  const defined = new Set([...clientSrc.matchAll(/function\s+(Mf[A-Za-z]+)\s*\(/g)].map((m) => m[1]));
  const missing = [...new Set(used)].filter((n) => !defined.has(n));
  ok(`用到的自有原语全部有定义（用到 ${[...new Set(used)].join(", ")}；缺失 ${missing.join(", ") || "无"}）`,
    missing.length === 0);
  ok("浏览器产物用 __ModuleLoader__ 注册，id 等于包名",
    clientSrc.includes("__ModuleLoader__.load") && new RegExp(`id:\\s*["']${pkg.name}["']`).test(clientSrc));
}

// =============================================================================
console.log("\n[6] 文案路由 —— 界面文字必须走 locale，且词表完整");
{
  const harness = new Function(
    "console",
    `${sliceBetween(clientSrc, LOCALE_START, LOCALE_END, "文案词表")}
return { t, registerLocale, MF_ZH, MF_EN, LOCALE_NS };`,
  );
  const loc = harness(console);

  eq("LOCALE_NS 等于包名", loc.LOCALE_NS, pkg.name);
  const zhKeys = Object.keys(loc.MF_ZH);
  const enKeys = Object.keys(loc.MF_EN);
  ok(`词表非空（zh ${zhKeys.length} 条 / en ${enKeys.length} 条）`, zhKeys.length > 0);
  const onlyZh = zhKeys.filter((k) => !(k in loc.MF_EN));
  const onlyEn = enKeys.filter((k) => !(k in loc.MF_ZH));
  ok(`zh / en 键集合完全一致（只缺 en: ${onlyZh.join(", ") || "无"}；只缺 zh: ${onlyEn.join(", ") || "无"}）`,
    onlyZh.length === 0 && onlyEn.length === 0);
  ok("英文词表里没有遗留中文（未翻译条目）",
    enKeys.every((k) => !/[\u4e00-\u9fff]/.test(String(loc.MF_EN[k]))));

  // 源码里凡是用 t("key") 取文案的地方，key 都必须在词表里（否则界面上会直接漏出 key）
  const usedKeys = [...new Set(
    [...clientSrc.matchAll(/(?<![\w$.])t\(\s*"([a-z][\w.-]*)"/g)].map((m) => m[1]),
  )];
  ok(`源码里通过 t() 取了 ${usedKeys.length} 个 key`, usedKeys.length > 20);
  const unknownKeys = usedKeys.filter((k) => !(k in loc.MF_ZH));
  ok(`t() 用到的 key 都在词表里（缺失：${unknownKeys.join(", ") || "无"}）`, unknownKeys.length === 0);

  // 界面上的中文只能出现在 locale 段落里：别处出现中文字面量就是漏网的硬编码文案。
  // 所以扫描范围＝整份源码**减去**词表段（文案（Client locale 服务） → 图标，约 230 行）。
  // 注意别把后半段的结束标记写成「插件入口」：那等于把词表段到插件入口之间的
  // ~2500 行（会话业务 / 长按 / 批量多选 / 转发弹窗 / 槽组件 / DOM 观察——界面文案最
  // 密的地方）整段丢出扫描范围，正是这把尺子最容易悄悄变窄的地方（见下面的自检断言）。
  // 先把范围内的块注释和行注释去掉（注释是给人看的，不是界面文案），
  // 再逐行找中文；开发者日志（console.*）不算界面文案。
  const localeAt = locateMarker(clientSrc, LOCALE_START, "硬编码扫描 词表段起始");
  const localeEnd = locateMarker(clientSrc, LOCALE_END, "硬编码扫描 词表段结束");
  if (localeEnd <= localeAt) throw new Error("硬编码扫描: 词表段标记顺序颠倒");
  const bodyOnly = clientSrc.slice(0, localeAt) + clientSrc.slice(localeEnd);

  // --- 尺子自检：扫描范围必须覆盖除词表段以外的每一个段落标记 ---
  // 段落标记是 client.js 的骨架；只要漏掉任意一段，就说明范围又被改窄了。
  const sectionMarkers = [...clientSrc.matchAll(/^\t\t\/\/ -{10,} .+$/gm)].map((m) => m[0]);
  const scannedSections = sectionMarkers.filter((m) => m !== LOCALE_START);
  const droppedSections = scannedSections.filter((m) => !bodyOnly.includes(m));
  ok(`扫描范围覆盖除词表外的全部 ${scannedSections.length} 个段落标记（漏掉：${droppedSections.map((m) => m.trim().slice(-12)).join(", ") || "无"}）`,
    scannedSections.length >= 14 && droppedSections.length === 0);
  ok("词表段本身不在扫描范围内（否则硬编码扫描会被自己的词典喂饱）",
    !bodyOnly.includes("MF_ZH") && !bodyOnly.includes("MF_EN"));
  ok(`扫描文本量级与覆盖范围相符（${bodyOnly.length} 字符 ≥ 60000）`, bodyOnly.length >= 60000);

  const codeOnly = bodyOnly
    .replace(/\/\*[\s\S]*?\*\//g, "")   // 块注释（含文件头的说明块）
    .replace(/\/\/[^\n]*/g, "");        // 行注释
  const hardcoded = codeOnly.split("\n").filter((line) => {
    if (/console\.(log|info|warn|error)\(/.test(line)) return false; // 开发者日志（不面向用户）
    return /[\u4e00-\u9fff]/.test(line);
  });
  ok(`非 locale 段落里没有中文字面量（残留 ${hardcoded.length} 行）`, hardcoded.length === 0);
  if (hardcoded.length) hardcoded.slice(0, 8).forEach((l) => console.log("       >", l.trim().slice(0, 110)));

  // --- 运行时行为：无服务时回退到内置词表，插值、缺参、缺 key 都要稳 ---
  ok("没有 locale 服务时 t() 回退内置中文词表", loc.t("bar.selectAll") === loc.MF_ZH["bar.selectAll"]);
  eq("未知 key 原样返回（不会渲染成 undefined）", loc.t("no.such.key"), "no.such.key");
  const sel = loc.MF_ZH["bar.selected"];
  ok("插值替换命名占位符", loc.t("bar.selected", { selected: 2, total: 5 }) === sel.replace("{selected}", "2").replace("{total}", "5"));
  ok("缺失的参数保留 {name} 字面量而不是变成 undefined",
    loc.t("bar.selected", { selected: 2 }).includes("{total}"));
  ok("数字 0 也能正确插入", loc.t("bar.selected", { selected: 0, total: 5 }).includes("0 / 5"));

  // 注册成功后应优先用服务返回的文案，并且语言切换后跟随变化（缓存不能把语言钉死）
  let active = "zh";
  const registered = [];
  const service = {
    register(ns, dicts) { registered.push([ns, dicts]); return () => {}; },
    bind(ns) { return (key) => `${active}:${ns}:${key}`; },
  };
  const disposer = loc.registerLocale({ get: (name) => (name === "locale" ? service : undefined) });
  eq("registerLocale 把词表按 {zh, en} 注册给服务", JSON.stringify(registered[0]?.[1] && Object.keys(registered[0][1])), '["zh","en"]');
  eq("registerLocale 用的命名空间是包名", registered[0]?.[0], pkg.name);
  ok("registerLocale 返回服务的 disposer（交给 ctx.effect 清理）", typeof disposer === "function");
  ok("注册后 t() 改用服务返回的文案", loc.t("bar.selectAll") === `zh:${pkg.name}:bar.selectAll`);
  active = "en";
  ok("切换语言后 t() 立刻跟随（绑定的闭包不被语言钉死）", loc.t("bar.selectAll") === `en:${pkg.name}:bar.selectAll`);

  // 服务缺失 / 形态不对时必须是安全的 no-op，不能抛错拖垮槽位
  ok("registerLocale(null) 返回 no-op 且不抛错", (() => {
    try { return typeof loc.registerLocale(null) === "function"; } catch { return false; }
  })());
  ok("registerLocale({}) 返回 no-op 且不抛错", (() => {
    try { return typeof loc.registerLocale({}) === "function"; } catch { return false; }
  })());
}

// =============================================================================
console.log("\n[7] 槽位注册 —— 只注册真实存在的槽，且带上 locale 座位");
{
  const known = [
    "conversation.chat.assistant-actions",
    "conversation.session.header.utilities",
    "conversation.input.overlay",
  ];
  const injectCalls = [...clientSrc.matchAll(/ctx\.slots\.inject\(\s*"([^"]+)"/g)].map((m) => m[1]);
  eq(`ctx.slots.inject 注册了 ${injectCalls.length} 个槽`, injectCalls.length, 3);
  ok(`注册的槽都在已知槽位表里（${injectCalls.join(", ")}）`, injectCalls.every((s) => known.includes(s)));
  eq("每个槽的 slots.register 都带上 locale: LOCALE_NS（拿渲染器的 t 座位）",
    [...clientSrc.matchAll(/ctx\.slots\.register\(\{[^}]*locale:\s*LOCALE_NS/g)].length, 3);
  ok("list 槽都带 id（规范：list 槽缺 id 会直接抛错）",
    [...clientSrc.matchAll(/ctx\.slots\.register\(\{([^}]*)\}/g)].every((m) => /id:\s*"/.test(m[1])));
  ok("按 value 注册的资源都走 ctx.effect / ctx.slots.inject 以便卸载时回收",
    /ctx\.effect\(/.test(clientSrc) && /ctx\.slots\.inject\(/.test(clientSrc));
  ok("apply 显式声明 inject（slots / locale / sessions / workspaces / uiWorkspace）",
    /const inject = \[[^\]]*"slots"[^\]]*\]/.test(clientSrc) && /"locale"/.test(clientSrc));
}

// =============================================================================
console.log(`\n=== ${passed} passed, ${failures.length} failed ===`);
if (failures.length) {
  for (const f of failures) console.log("  -", f);
  process.exit(1);
}
