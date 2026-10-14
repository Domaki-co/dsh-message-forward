/**
 * dsh-message-forward —— host 半边（有意为之的空实现）。
 *
 * 这是一个纯客户端插件：转发逻辑全部跑在浏览器里（lib/client.js，通过
 * package.json 的 `dsh.client` 声明），host 侧没有任何服务、工具或事件需要注册。
 *
 * 但仍然必须导出 apply()，原因有两个：
 *   1. 插件规范（cordis-plugin-development/references/practices.md）只承认两种 host
 *      导出形态——`export function apply(ctx)`（可附带 `export const inject` / `Config`）
 *      或默认导出一个服务类，两者不可混用。`export const name` 之类的额外导出不属于
 *      任一形态，插件的 id 由 cordis.patch.yml 的 insert 行决定，不由模块导出决定。
 *   2. 本包的 cordis.patch.yml 会把 dsh-message-forward 自己插进 composition，被插入的
 *      模块必须是一个合法 Cordis 插件（换句话说：必须有 apply）。只有「只做组合、
 *      自己不进场」的 bundle 才可以写成 `export {}`，例如
 *      @deepseek-ai/dsh-experimental-voice-input-bundle。
 *
 * 这里不做任何事，也刻意不写日志：把一行 "initialized" 打在每次启动上没有任何信息量。
 */

/**
 * Host 半边入口。客户端半边由 `dsh.client` 声明驱动，与本函数无关。
 *
 * @param {unknown} _ctx Cordis 上下文（本插件不使用）。
 * @returns {void}
 */
export function apply(_ctx) {
	// 有意为空：见文件头注释。
}
