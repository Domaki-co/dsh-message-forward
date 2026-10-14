// 测试依赖探测。凡是需要 jsdom / react 的套件都从这里取，保证「缺依赖」在每一套里
// 都是同一个语义：打印 SKIP 并以 0 退出。SKIP 到底算不算失败由 run.mjs 决定
// （默认算失败，显式 --allow-skip 才放行），套件自己不做这个判断。
import { createRequire } from "node:module";

export const INSTALL_HINT = "cd tests && npm i --no-save jsdom react@18 react-dom@18";

/** 依赖缺失：打印 SKIP + 安装提示，以 0 退出（交回给 run.mjs 判定）。 */
export function skipSuite(suite, missing) {
	console.log(`SKIP  ${suite}  (${missing} 未安装)`);
	console.log(`      ${INSTALL_HINT}`);
	process.exit(0);
}

/** jsdom 是软依赖：缺失时整套 SKIP。 */
export async function loadJsdom(suite) {
	try {
		return (await import("jsdom")).JSDOM;
	} catch {
		skipSuite(suite, "jsdom");
	}
}

/** react / react-dom 是软依赖：缺失时整套 SKIP。 */
export function loadReact(suite) {
	const require = createRequire(import.meta.url);
	try {
		const React = require("react");
		return {
			React,
			ReactDOM: require("react-dom"),
			ReactDOMClient: require("react-dom/client"),
			act: React.act || require("react-dom/test-utils").act,
		};
	} catch {
		skipSuite(suite, "react / react-dom");
	}
}
