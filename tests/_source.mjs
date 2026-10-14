// lib/client.js 的切片工具。
//
// 测试都是按「段落标记」从 client.js 里切出自包含片段再 eval 的。文案层
// （LOCALE_NS / MF_ZH / MF_EN / registerLocale / t）本身只依赖 console，是自包含的，
// 但源码里凡是 t("key") 的地方都需要它；所以任何切片都应该把 localeSrc 一起带进
// eval 作用域，否则会以 "t is not defined" 崩掉。
//
// 关键约束：切片一律走 slice()，标记缺失 / 顺序颠倒必须抛错。
// 裸 src.indexOf(mark) 在标记被改名时会返回 -1，src.slice(k, -1) 会静默切出一大段
// 错误内容（甚至照样包含被测函数名），于是断言全绿而覆盖早已失效。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const CLIENT_PATH = path.join(here, "..", "lib", "client.js");
export const src = fs.readFileSync(CLIENT_PATH, "utf8");

/** 段落标记行（client.js 里的「尺子」）。 */
export const marker = (label) => "\t\t// ---------------------------------------------------------------- " + label;

/** client.js 里全部段落标记，按源码顺序。 */
export const MARKERS = {
	locale: marker("文案（Client locale 服务）"),
	icons: marker("图标"),
	primitives: marker("自有原语"),
	styles: marker("样式"),
	store: marker("轻量 store"),
	extract: marker("文案 / 内容提取"),
	session: marker("会话业务"),
	longPress: marker("长按 2 秒"),
	batchUnits: marker("批量多选：消息单元"),
	batchBar: marker("批量工具条"),
	forwardModal: marker("转发弹窗"),
	draft: marker("草稿落地（目标会话内）"),
	slotViews: marker("槽组件"),
	domObserver: marker("DOM 观察：用户消息按钮 + 多选装饰"),
	entry: marker("插件入口"),
};

/** 按段落标记切一段源码；标记缺失或顺序颠倒直接抛错，避免静默切出错误片段。 */
export function slice(fromMarker, toMarker) {
	const i = src.indexOf(fromMarker);
	if (i < 0) throw new Error(`找不到起始段落标记: ${JSON.stringify(fromMarker)}`);
	const j = src.indexOf(toMarker);
	if (j < 0) throw new Error(`找不到结束段落标记: ${JSON.stringify(toMarker)}`);
	if (j <= i) throw new Error(`段落标记顺序颠倒（结束标记出现在起始标记之前）: ${JSON.stringify(fromMarker)} -> ${JSON.stringify(toMarker)}`);
	return src.slice(i, j);
}

/** 按段落标题切片（marker(label) 的简写）。 */
export function section(fromLabel, toLabel) {
	return slice(marker(fromLabel), marker(toLabel));
}

/** 文案层源码，拼在任何被 eval 的片段前面。 */
export const localeSrc = slice(MARKERS.locale, MARKERS.icons);

/** react-dom 拿到 + portalToBody()，自有原语与浮层组件都依赖它。 */
export const portalSrc = slice(
	"\t\t/** react-dom 只用于把底部多选条挂到 body",
	"\t\t/** apply() 注入的插件上下文",
);

/** 图标组件 + §自有原语（Mf*）整段，都是纯声明，不碰任何 Harness 私有模块。 */
export const widgetSrc = slice(MARKERS.icons, MARKERS.styles);

/** makeStore / batchStore / notify，多选相关的 store 原语。 */
export const storeSrc = slice(MARKERS.store, MARKERS.extract);

// 提取层以一行代码（不是段落标记）开头：它和下面的段落是同一节的两半。
const MD_SEL_START = "\t\tconst MD_SEL = ";

/** 文本 / 图片提取层（MD_SEL .. extractAssistantFromAnchor / resolveUserContainer）。 */
export const extractionSrc = slice(MD_SEL_START, MARKERS.session);

/** 多选单元识别（collectUnits / unitIdForNode / mergeUnits / 摘要工具）。 */
export const batchUnitsSrc = slice(MARKERS.batchUnits, MARKERS.batchBar);

/** DOM 观察层（setupUserMessageButtons / setupBatchDecorator）。 */
export const decoratorSrc = slice(MARKERS.domObserver, MARKERS.entry);
