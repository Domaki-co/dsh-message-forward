#!/usr/bin/env node
// Regression suite runner for dsh-message-forward.
//
//   node tests/run.mjs                 # SKIP（缺依赖）算失败：默认要求完整覆盖
//   node tests/run.mjs --allow-skip    # 显式放行 SKIP：exit 0，但打印被跳过的覆盖
//
// jsdom / react / react-dom 只是本地测试依赖（见 tests/README.md），缺了套件会自己打印
// SKIP 并以 0 退出。「缺一个包 = 全绿 exit 0」是最危险的失败形态——被跳过的恰好是唯一
// 真正执行 apply() 与渲染的那几套——所以这里默认把 SKIP 当成失败，只有显式传
// --allow-skip 才放行。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = [
  "test-conformance.mjs",
  "test-extract.mjs",
  "test-session.mjs",
  "test-batch.mjs",
  "test-css-tokens.mjs",
  "test-mobile.mjs",
  "test-decorator.mjs",
  "test-primitives.mjs",
  "test-entry.mjs",
];
const INSTALL_HINT = "cd tests && npm i --no-save jsdom react@18 react-dom@18";

const allowSkip = process.argv.slice(2).includes("--allow-skip");

const skipped = [];
let failed = 0;
for (const suite of suites) {
  const r = spawnSync(process.execPath, [path.join(here, suite)], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const summary = (out.match(/^=== .* ===$/m) || ["(no summary)"])[0];
  // 套件的 SKIP 契约：打印 SKIP 且 exit 0（非 0 退出说明是崩了，不算 SKIP）。
  const skip = /^SKIP/m.test(out) && r.status === 0;
  const bad = !skip && r.status !== 0;
  if (bad) failed++;
  if (skip) skipped.push(suite);
  const verdict = bad ? "FAIL" : skip ? (allowSkip ? "SKIP" : "FAIL(skip)") : "PASS";
  console.log(`${verdict.padEnd(10)} ${suite.padEnd(20)} ${skip ? "(依赖缺失)" : summary}`);
  if (bad) console.log(out.split("\n").filter((l) => /^FAIL/.test(l)).join("\n"));
  if (skip) console.log(out.split("\n").filter((l) => /SKIP|npm i/.test(l)).join("\n"));
}

const blocked = !allowSkip && skipped.length > 0;
if (skipped.length) {
  console.log("");
  console.log(`${allowSkip ? "WARNING" : "ERROR"}: ${skipped.length} 个套件被跳过（依赖缺失）：${skipped.join(", ")}`);
  console.log("  被跳过的套件里 test-primitives 用真实 React 渲染原语，test-entry 才是唯一真正");
  console.log("  执行 apply() 的端到端覆盖：它们绿了不代表插件跑得起来。");
  console.log(`  安装依赖：${INSTALL_HINT}`);
  console.log(allowSkip
    ? "  已显式传 --allow-skip：本次按跳过放行，exit 0。"
    : "  SKIP 默认判为失败；确认要带着这个缺口放行时才用 --allow-skip。");
}
if (failed) console.log(`\n${failed} suite(s) failed.`);
else if (blocked) console.log(`\nFAILED: ${skipped.length} suite(s) skipped (missing dependencies).`);
else console.log(`\nAll suites passed${skipped.length ? ` (${skipped.length} skipped, --allow-skip)` : ""}.`);
process.exit(failed === 0 && !blocked ? 0 : 1);
