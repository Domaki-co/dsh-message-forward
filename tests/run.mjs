#!/usr/bin/env node
// Regression suite runner for dsh-message-forward.
//   node tests/run.mjs
// Requires jsdom (see tests/README.md for the one-time setup).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = ["test-extract.mjs", "test-batch.mjs", "test-css-tokens.mjs", "test-decorator.mjs"];

let failed = 0;
for (const suite of suites) {
  const r = spawnSync(process.execPath, [path.join(here, suite)], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const summary = (out.match(/^=== .* ===$/m) || ["(no summary)"])[0];
  const bad = r.status !== 0;
  if (bad) failed++;
  console.log(`${bad ? "FAIL" : "PASS"}  ${suite.padEnd(20)} ${summary}`);
  if (bad) console.log(out.split("\n").filter((l) => /^FAIL/.test(l)).join("\n"));
}
console.log(failed === 0 ? "\nAll suites passed." : `\n${failed} suite(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
