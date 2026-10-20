#!/usr/bin/env node
/**
 * 宿主 DOM 契约漂移检测（本地 / 离线 / 零依赖）
 *
 * 为什么要这个脚本：本插件靠宿主渲染出来的 DOM 属性定位每一行消息（见
 * lib/client.js 的 assistantTurnNodes 与 1836-1848 的选择器常量）。宿主升级或重构时
 * 这些属性可能悄悄改名，插件不会抛错，只会"少转发 / 转发错行"，而 tests/ 里的回归
 * 测试全部是自己造的 DOM，发现不了这种漂移。本脚本直接读安装好的宿主 bundle，
 * 逐条核对插件真正依赖的标识符还在不在。
 *
 * 用法：
 *   node tests/host-drift.mjs                              # 检测本机安装的宿主
 *   DSH_HOST_ASAR=/path/to/app.asar node tests/host-drift.mjs
 *   node tests/host-drift.mjs --self-test                   # 自检：合成完整/残缺 bundle，应得 0 / 1
 *
 * 退出码：0 = 无硬依赖漂移（或 SKIP：宿主不存在）；1 = 有硬依赖漂移。
 *
 * 分级（决定是否影响退出码）：
 *   required  插件核心路径上没有等价替代，缺失 = 功能失效或静默错行 → 失败
 *   enum      data-chat-flow-kind 的取值，缺失 = 认错行 → 失败
 *   fallback  只出现在 OR 兜底选择器里，插件还有同类分支可用 → 缺失只告警
 *   canary    构建期哈希类名等"指纹"，变化说明宿主重新构建过、需人工复核 → 只告警
 *
 * 局限（别把它当兼容性证明）：只核对 DOM 契约这一条轴，不覆盖 API / 生命周期 / 样式。
 * 枚举值按两种形态分别计数：CSS 选择器形态（data-chat-flow-kind=V）与 kind 比较形态
 * （kind === "V"）。任一命中即 PASS，但证据列把两边次数都印出来；只靠 kind 比较判定时
 * 会在那一行显式标注——宿主的其它领域也有同名取值（如 message.source.kind === "user"），
 * 只数一种形态会把"属性改名了"读成"还在"。
 */

import { closeSync, mkdtempSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_ASAR = "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar";
const ASAR = process.env.DSH_HOST_ASAR || DEFAULT_ASAR;
const CHUNK = 8 << 20;
const PEEK = 300; // 重叠窗口：跨块匹配 + 邻近证据都要靠它

// sample 既是"这条契约在宿主里长什么样"的说明，也是 --self-test 合成 fixture 的原料。
const CHECKS = [
	{
		id: "data-chat-flow-kind", level: "required", ref: "lib/client.js:2058,2062",
		match: /data-chat-flow-kind/g,
		sample: 'el.closest("[data-chat-flow-kind], [data-chat-flow-key]")',
	},
	{
		id: "data-chat-flow-key", level: "required", ref: "lib/client.js:2058,2815,4009,4159",
		match: /data-chat-flow-key/g,
		sample: '"[data-chat-flow-key]:not([data-chat-group-key])"',
	},
	{
		id: "data-chat-turn", level: "required", ref: "lib/client.js:2059,2087,4159",
		match: /data-chat-turn(?![\w-])/g,
		sample: 'row.getAttribute("data-chat-turn")',
	},
	{
		id: "data-turn-tail", level: "required", ref: "lib/client.js:2130,2832,2861,3905",
		match: /data-turn-tail(?![\w-])/g,
		sample: '{ "data-turn-tail": data.turn }',
	},
	{
		id: "data-conversation-scroll", level: "required", ref: "lib/client.js:2060",
		match: /data-conversation-scroll/g,
		sample: 'list.closest("[data-conversation-scroll]")',
	},
	{
		id: "data-clock=start", level: "required", ref: "lib/client.js:3980,4034",
		match: /data-clock(?![\w-])/g, near: /start/,
		sample: '{ "data-clock": clock, x: clock === "start" }',
	},
	{
		id: "data-markdown-variant=compact", level: "required", ref: "lib/client.js:1845,1917",
		match: /data-markdown-variant\s*=\s*["']?compact(?![\w-])/g,
		sample: "[data-markdown-variant=compact]",
	},
	{
		id: "data-variant=think", level: "required", ref: "lib/client.js:1844,1916",
		match: /(?:data-variant\s*=\s*["']?think(?![\w-]))|(?:["']?data-variant["']?\s*:\s*["']think["'])/g,
		sample: '{ "data-variant": "think" }',
	},
	// 6 个取值缺一个，认行就会错（2050-2090 的 kind 判断）
	{ id: "flow-kind: assistant-step", level: "enum", ref: "lib/client.js:2065", value: "assistant-step" },
	{ id: "flow-kind: turn-process", level: "enum", ref: "lib/client.js:2065", value: "turn-process" },
	{ id: "flow-kind: user", level: "enum", ref: "lib/client.js:2078", value: "user" },
	{ id: "flow-kind: steering", level: "enum", ref: "lib/client.js:2078", value: "steering" },
	{ id: "flow-kind: turn-trigger", level: "enum", ref: "lib/client.js:2078,2083", value: "turn-trigger" },
	{ id: "flow-kind: turn-tail", level: "enum", ref: "lib/client.js:2083", value: "turn-tail" },
	{
		id: "data-turn-process-inline", level: "fallback", ref: "lib/client.js:1844（THINK_SEL 的一支）",
		match: /data-turn-process-inline(?![\w-])/g,
		sample: "[data-turn-process-inline][hidden]",
	},
	{
		id: "data-process-activity", level: "fallback", ref: "lib/client.js:1847,1928（仅退化路径）",
		match: /data-process-activity(?![\w-])/g,
		sample: '{ "data-process-activity": activity }',
	},
	{
		id: "data-step-process", level: "fallback", ref: "lib/client.js:1848（IMG_SEL 的一支）",
		match: /data-step-process(?![\w-])/g,
		sample: '{ "data-step-process": true }',
	},
	{
		id: "data-image-viewer", level: "fallback", ref: "lib/client.js:4164（大图选择器最后一项）",
		match: /data-image-viewer(?![\w-])/g,
		sample: "[data-image-viewer]",
	},
	{
		id: "class icaHSq_flowItem", level: "canary", ref: "lib/client.js:2051（注释）,4159 用子串 flowItem",
		match: /icaHSq_flowItem/g,
		sample: ".icaHSq_flowItem",
	},
	{
		id: "class IzP3Va_userRow", level: "canary", ref: "lib/client.js:2148,2814,2863 用子串 userRow",
		match: /IzP3Va_userRow/g,
		sample: ".IzP3Va_userRow",
	},
	{
		id: "class ppByMG_actions", level: "canary", ref: "lib/client.js:1929 用子串 actions",
		match: /ppByMG_actions/g,
		sample: ".ppByMG_actions",
	},
];

for (const c of CHECKS) {
	if (c.value) {
		c.match = new RegExp('data-chat-flow-kind\\s*=\\s*["\']?' + c.value + "(?![\\w-])", "g");
		c.cmp = new RegExp('\\bkind\\s*===?\\s*["\']' + c.value + '[\"\']', "g");
		c.sample = "[data-chat-flow-kind=" + c.value + ']\nnode.kind === "' + c.value + '"';
	}
}

const HARD = new Set(["required", "enum"]);

function readHostMeta(bundle) {
	const fd = openSync(bundle, "r");
	try {
		const head = Buffer.alloc(16);
		readSync(fd, head, 0, 16, 0);
		const pickleSize = head.readUInt32LE(4);
		const jsonLen = head.readUInt32LE(12);
		if (!(pickleSize > 0) || !(jsonLen > 0) || jsonLen + 8 > pickleSize || jsonLen > 64 * 1024 * 1024) return {};
		const jsonBuf = Buffer.alloc(jsonLen);
		readSync(fd, jsonBuf, 0, jsonLen, 16);
		const tree = JSON.parse(jsonBuf.toString("utf8"));
		const node = tree && tree.files && tree.files.dsh && tree.files.dsh.files && tree.files.dsh.files["package.json"];
		if (!node || typeof node.size !== "number") return {};
		const buf = Buffer.alloc(node.size);
		readSync(fd, buf, 0, node.size, 8 + pickleSize + Number(node.offset || 0));
		return { version: JSON.parse(buf.toString("utf8")).version };
	} finally {
		closeSync(fd);
	}
}

function scan(bundle) {
	const size = statSync(bundle).size;
	const fd = openSync(bundle, "r");
	const hits = CHECKS.map(() => ({ n: 0, cmp: 0, near: 0 }));
	try {
		for (let offset = 0; offset < size; offset += CHUNK) {
			const want = Math.min(CHUNK + PEEK, size - offset);
			const buf = Buffer.allocUnsafe(want);
			const got = readSync(fd, buf, 0, want, offset);
			const text = buf.toString("latin1", 0, got); // latin1 保持 1 字节 = 1 字符，窗口按字节算
			const edge = Math.min(CHUNK, got); // 只统计起点落在本块内的匹配，重叠区留给下一块
			for (let i = 0; i < CHECKS.length; i++) {
				const check = CHECKS[i];
				const bucket = hits[i];
				for (const pair of [["n", check.match], ["cmp", check.cmp]]) {
					const key = pair[0];
					const re = pair[1];
					if (!re) continue;
					re.lastIndex = 0;
					let m;
					while ((m = re.exec(text)) !== null) {
						if (m.index >= edge) break;
						bucket[key]++;
						const window = text.slice(Math.max(0, m.index - PEEK), m.index + m[0].length + PEEK);
						if (key === "n" && check.near && check.near.test(window)) bucket.near++;
						if (m[0].length === 0) re.lastIndex++;
					}
				}
			}
		}
	} finally {
		closeSync(fd);
	}
	return { size, hits };
}

function fmtBytes(n) {
	return n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + " MiB" : n + " B";
}

function judge(check, hit) {
	if (check.value) {
		const evidence = "选择器 " + hit.n + " 处 / kind 比较 " + hit.cmp + " 处";
		if (hit.n === 0 && hit.cmp === 0) return { ok: false, evidence: "完全找不到（" + evidence + "）" };
		if (hit.n === 0) return { ok: true, evidence: evidence + "（属性取值只被 kind 比较形态确认）" };
		return { ok: true, evidence };
	}
	if (check.near) {
		if (hit.n > 0 && hit.near > 0) return { ok: true, evidence: hit.n + " 处，其中 " + hit.near + " 处邻近出现 start" };
		if (hit.n > 0) return { ok: false, evidence: hit.n + " 处属性存在，但邻近窗口内找不到 start" };
		return { ok: false, evidence: "完全找不到" };
	}
	if (hit.n > 0) return { ok: true, evidence: hit.n + " 处" };
	return { ok: false, evidence: "完全找不到" };
}

function run() {
	if (!safeStat(ASAR)) {
		console.log("SKIP  宿主 bundle 不存在：" + ASAR);
		console.log("      这不是失败：本检测只对装了宿主桌面客户端的开发机有意义。");
		console.log("      若宿主装在别处，用 DSH_HOST_ASAR=<app.asar 路径> 指过去。");
		return 0;
	}
	console.log("宿主 DOM 契约漂移检测 — dsh-message-forward");
	console.log("宿主 bundle：" + ASAR + "（" + fmtBytes(statSync(ASAR).size) + "）");
	let meta = {};
	try {
		meta = readHostMeta(ASAR);
	} catch (err) {
		meta = {};
	}
	console.log("宿主版本：  " + (meta.version || "读不出（asar 头解析失败，不影响下面的检查）"));
	if (meta.version) {
		const pkg = JSON.parse(readFileSafe("./package.json"));
		const declared = (pkg.dsh && pkg.dsh.compatibility && pkg.dsh.compatibility.dshReleases) || {};
		const state = declared[meta.version];
		console.log("兼容矩阵：  " + (state ? "已声明 " + meta.version + " = " + state : "未声明 " + meta.version + "（未核对过，不等于不兼容）"));
	}
	const started = Date.now();
	const { hits } = scan(ASAR);
	console.log("扫描：      1 遍、" + hits.length + " 条契约、" + ((Date.now() - started) / 1000).toFixed(1) + "s\n");

	const W = [10, 9, 32];
	const row = (a, b, c, d) => a.padEnd(W[0]) + b.padEnd(W[1]) + c.padEnd(W[2]) + d;
	console.log(row("状态", "级别", "标识符", "证据"));
	console.log("-".repeat(110));
	const tally = { required: [0, 0], enum: [0, 0], fallback: [0, 0], canary: [0, 0] };
	const drifted = [];
	const missingSoft = [];
	CHECKS.forEach((check, i) => {
		const verdict = judge(check, hits[i]);
		const hard = HARD.has(check.level);
		let status;
		if (verdict.ok) status = "PASS";
		else if (hard) status = "DRIFT";
		else status = "MISS";
		tally[check.level][0] += verdict.ok ? 1 : 0;
		tally[check.level][1] += 1;
		if (status === "DRIFT") drifted.push(check);
		if (status === "MISS") missingSoft.push(check);
		console.log(row(status, check.level, check.id, verdict.evidence + " · " + check.ref));
	});

	const parts = ["required", "enum", "fallback", "canary"].map((k) => k + " " + tally[k][0] + "/" + tally[k][1]);
	console.log("");
	if (drifted.length > 0) {
		console.log("结论：检测到 " + drifted.length + " 处硬依赖漂移（" + parts.join(" · ") + "）→ 插件在这个宿主上会静默少转发或错行。");
		console.log("建议动作：先跑 grep -a -o 'data-[a-z-]*' \"" + ASAR + "\" | sort | uniq -c | sort -rn | head -40");
		console.log("          找到改名后的属性，改 lib/client.js 的 assistantTurnNodes（2050-2090）与选择器常量（1836-1848），再补 tests/ 的 DOM fixture。");
		console.log("          改完把 package.json 的 dsh.compatibility.dshReleases 里对应版本标回 compatible。");
		return 1;
	}
	const soft = missingSoft.length > 0 ? "；" + missingSoft.length + " 项兜底/指纹缺失（" + missingSoft.map((c) => c.id).join("、") + "）不影响功能" : "";
	console.log("结论：没有硬依赖漂移（" + parts.join(" · ") + "）" + soft + "。");
	console.log("建议动作：无需动作。宿主升级后重跑一次；准备发版时把这条的 exit 0 当作兼容性证据之一。");
	return 0;
}

function safeStat(path) {
	try {
		const st = statSync(path);
		return st.isFile();
	} catch (err) {
		return false;
	}
}

function readFileSafe(path) {
	const fd = openSync(path, "r");
	try {
		const st = statSync(path);
		const buf = Buffer.alloc(st.size);
		readSync(fd, buf, 0, st.size, 0);
		return buf.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

// ---- --self-test：证明这道门真的会变红 -------------------------------------
function buildAsar(path, content) {
	const body = Buffer.from(content, "latin1");
	const json = Buffer.from(
		JSON.stringify({ files: { dsh: { files: { "package.json": { size: body.length, offset: "0" } } } } }),
		"utf8"
	);
	const header = Buffer.alloc(16);
	header.writeUInt32LE(4, 0);
	header.writeUInt32LE(json.length + 10, 4);
	header.writeUInt32LE(json.length, 12);
	writeFileSync(path, Buffer.concat([header, json, Buffer.alloc(2), body]));
}

function selfTest() {
	const dir = mkdtempSync(join(tmpdir(), "dsh-host-drift-"));
	const full = join(dir, "full.asar");
	const broken = join(dir, "broken.asar");
	buildAsar(full, CHECKS.map((c) => c.sample).join("\n"));
	buildAsar(broken, CHECKS.filter((c) => c.id !== "data-variant=think").map((c) => c.sample).join("\n"));
	const cases = [
		{ name: "完整 fixture", asar: full, want: 0, must: "PASS" },
		{ name: "缺 data-variant=think 的 fixture", asar: broken, want: 1, must: "DRIFT" },
		{ name: "宿主不存在", asar: join(dir, "nope.asar"), want: 0, must: "SKIP" },
	];
	let failed = 0;
	for (const item of cases) {
		const res = spawnSync(process.execPath, [new URL(import.meta.url).pathname], {
			env: { ...process.env, DSH_HOST_ASAR: item.asar },
			encoding: "utf8",
		});
		const out = (res.stdout || "") + (res.stderr || "");
		const ok = res.status === item.want && out.includes(item.must);
		if (!ok) failed++;
		console.log((ok ? "PASS " : "FAIL ") + item.name + "  期望 exit " + item.want + " 且输出含 " + item.must + "，实际 exit " + res.status);
		if (!ok) console.log(out.split("\n").slice(0, 40).join("\n"));
	}
	console.log(failed === 0 ? "\n自检通过：这道门既能绿也能红。" : "\n自检失败：" + failed + " 个用例不符。");
	return failed === 0 ? 0 : 1;
}

if (process.argv.includes("--self-test")) process.exit(selfTest());
process.exit(run());
