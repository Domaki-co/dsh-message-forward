/* dsh-message-forward — client bundle (v0.2.1)
 * 会话消息转发：把某个会话里的「用户消息」或「模型回复」（文本 + 图片）
 * 转发到另一个会话，支持 静默发送 / 填入草稿 / 发送并跳转 / 多选合并转发。
 *
 * 实现要点（全部按 DSH 真实 API 校准）：
 *  - 助手消息入口：conversation.chat.assistant-actions 槽（ownerProps.messageId，标准 props 自带 sessionId）
 *  - 用户消息入口：DOM 注入到消息操作行 [data-clock='start']（DSH 未提供用户消息动作槽）
 *  - 会话级入口：conversation.session.header.utilities 槽
 *  - 发送：ctx.sessions.using(id, {source}, ref => ref.binding.session.prompt(content, "queue"))
 *  - 草稿：ctx.uiWorkspace.openSession(id) 后，由目标会话的 conversation.input.overlay 拿到该会话
 *          的 inputActions，调用 inputActions.setDraft(text) / addAttachments(ids) 真正落草稿
 *
 * 插件规范符合性（cordis-plugin-development 技能）：
 *  - 只 require 浏览器模块表里的基线运行时（react / react-dom），不加载任何 Harness Client 包；
 *    Button / Input / Modal / Toast / Tooltip 用 §自有原语 的 Mf* 副本 + --dsw-alias-* 令牌实现；
 *  - 用户可见文案全部走 Client locale 服务（LOCALE_NS = "dsh-message-forward"），
 *    组件内含内置 zh/en 词表兜底；
 *  - 所有资源（槽位、命令、词表、DOM 观察器、样式表）都经 ctx.effect / ctx.slots.inject 注册，
 *    返回各自的清理函数。
 */
window.__ModuleLoader__.load({
	id: "dsh-message-forward",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const {
			createElement: h,
			cloneElement,
			Fragment,
			useState,
			useEffect,
			useLayoutEffect,
			useRef,
			useCallback,
			useMemo
		} = React;

		/** 只 require 浏览器模块表里的基线运行时（react / react-dom）。
		 *
		 *  规范（cordis-plugin-development/references/practices.md）明确禁止插件
		 *  require 任何其它 Harness Client 包，包括 @deepseek-ai/dsh-client-ui-primitives：
		 *  这些包会随版本变化，纯 JS 插件没有类型检查兜底，且组件一旦抛错整个槽位会被
		 *  清空（slot entry crashed in '<slot>'）。
		 *  因此下面 §自有原语 里按 primitives 的标记 / 行为 / 主题令牌重写了一份
		 *  Mf* 组件（Button / Input / Modal / Toast / Tooltip），类名统一 .dsh-mf-* 前缀。 */

		/** react-dom 只用于把底部多选条挂到 body：祖先若有 transform/filter/backdrop-filter，
		 *  position:fixed 会被困在那个祖先里（皮肤类插件的毛玻璃正是这种情况），导致工具条错位或被裁剪。 */
		let reactDom = null;
		try { reactDom = require("react-dom"); } catch { reactDom = null; }

		/** 把浮层节点挂到 document.body；拿不到 react-dom 时原地渲染，功能不受影响。 */
		function portalToBody(node) {
			if (reactDom && typeof reactDom.createPortal === "function" && typeof document !== "undefined" && document.body) {
				return reactDom.createPortal(node, document.body);
			}
			return node;
		}

		/** apply() 注入的插件上下文：各组件通过它读 sessions / uiWorkspace / workspaces */
		let ctxRef = null;

		// ---------------------------------------------------------------- 文案（Client locale 服务）
		/** 规范要求：用户可见文案一律走 Client locale 服务，不得把字面量写死在组件里。
		 *  这里注册插件自己的命名空间（zh 为源语言，en 提供英文），t() 从服务取词并支持
		 *  {name} 插值；服务不可用或词条缺失时回落到内置词表，任何情况下都有字面量可用。
		 *  词表用 ctx.locale.register() 托管，注销交给 ctx.effect 统一回收。 */
		const LOCALE_NS = "dsh-message-forward";

		const MF_ZH = {
			"role.user": "用户",
			"role.model": "模型",

			"action.forwardReply": "转发这条回复",
			"action.forwardReplyTip": "转发这条回复（长按 2 秒进入多选）",
			"action.forwardOutput": "转发本会话产出",
			"action.forwardOutputTip": "转发本会话产出（长按 2 秒进入多选）",
			"action.forwardMessage": "转发这条消息",
			"action.forwardMessageTip": "转发这条消息（长按 2 秒进入多选）",
			"action.selectMessage": "选择这条消息",
			"action.unselectMessage": "取消选择这条消息",
			"action.selectMessageClick": "点击选择这条消息",
			"action.unselectMessageClick": "点击取消选择这条消息",

			"hint.longPress": "长按 2 秒：多选合并转发",

			"notify.pickFirst": "请先勾选要转发的消息",
			"notify.multiSelect": "已进入多选模式：点左侧圆点勾选，或点底部「已选 N 条」展开快捷选择",
			"notify.noContent": "没有可转发的内容",
			"notify.noContentImages": "没有可转发的内容（图片读取失败或无文本）",
			"notify.draftFilled": "已切换到「{title}」并填入输入框，确认后发送",
			"notify.draftNotFilled": "草稿未填入：「{title}」的输入框未就绪，请手动粘贴",
			"notify.mergeIncomplete": "已选 {selected} 条，其中 {missing} 条已滚出渲染窗口且无快照，已跳过（实际合并 {count} 条）",
			"notify.skippedImages": "（{count} 张图片不支持，已跳过）",
			"notify.forwarded": "已转发到「{title}」{skipped}",
			"notify.failed": "转发失败：{message}",

			"error.sessionsUnavailable": "会话服务不可用",
			"error.createSessionFailed": "新建会话失败",
			"error.noSessionHandle": "无法获取目标会话的会话句柄",
			"error.sendRejected": "发送被目标会话拒绝",

			"session.untitled": "未命名会话",
			"session.current": "当前会话",
			"session.newCreated": "新建的会话",
			"session.target": "目标会话",
			"session.unknown": "未知会话",
			"session.new": "新建会话",
			"session.label": "会话",

			"bar.quickSelect": "快捷选择",
			"bar.pickerMeta": "共 {total} 条 · 每段最多 {max} 字符",
			"bar.collapse": "收起",
			"bar.pickerExpand": "展开快捷选择，直接勾选消息",
			"bar.pickerCollapse": "收起快捷选择",
			"bar.empty": "当前会话还没有可选择的已加载消息",
			"bar.noText": "(无文本内容)",
			"bar.selected": "已选 {selected} / {total} 条",
			"bar.selectAll": "全选",
			"bar.clear": "清空",
			"bar.exit": "退出 (Esc)",
			"bar.merge": "合并转发",

			"modal.titleForward": "转发消息",
			"modal.titleBatch": "合并转发",
			"modal.close": "关闭",
			"modal.cancel": "取消",
			"modal.fillDraft": "填入草稿并跳转",
			"modal.sendSilent": "静默发送",
			"modal.sendAndJump": "发送并跳转",
			"modal.sending": "处理中…",
			"modal.roleUser": "用户消息",
			"modal.roleAssistant": "模型回复",
			"modal.roleBatch": "合并 {count} 条",
			"modal.roleBatchSource": "合并消息",
			"modal.from": "来自：{title}",
			"modal.imageCount": "· {count} 张图片",
			"modal.toBatch": "☷ 改为多选合并",
			"modal.quickProcess": "快捷加工：",
			"modal.asReference": "+ 作为参考背景",
			"modal.asTask": "+ 作为任务输入",
			"modal.reset": "重置原文",
			"modal.editorPlaceholder": "可在此裁剪内容或补充任务要求（发送前可自由编辑）",
			"modal.includeSource": "附带来源标记（会话标题 + 消息角色）",
			"modal.targetTitle": "选择目标会话",
			"modal.targetCount": "共 {count} 个会话",
			"modal.searchPlaceholder": "搜索会话标题或目录…",
			"modal.newSessionOption": "新建空白会话（干净上下文）",
			"modal.noSessions": "暂无可选会话",
			"modal.noMatch": "没有匹配的会话",
			"modal.running": "● 运行中",
			"modal.targetHint": "目标：{title}",

			"marker.reference": "以下是上游会话的产出结果，请作为参考背景：",
			"marker.task": "请基于以下上游结果继续执行后续任务：",
			"marker.source": "【转发自会话「{source}」· {role}】",
			"marker.block": "【{index}】{tag}:",

			"command.forward": "转发会话消息 (Forward)"
		};

		const MF_EN = {
			"role.user": "User",
			"role.model": "Model",

			"action.forwardReply": "Forward this reply",
			"action.forwardReplyTip": "Forward this reply (hold 2s for multi-select)",
			"action.forwardOutput": "Forward this session's output",
			"action.forwardOutputTip": "Forward this session's output (hold 2s for multi-select)",
			"action.forwardMessage": "Forward this message",
			"action.forwardMessageTip": "Forward this message (hold 2s for multi-select)",
			"action.selectMessage": "Select this message",
			"action.unselectMessage": "Deselect this message",
			"action.selectMessageClick": "Click to select this message",
			"action.unselectMessageClick": "Click to deselect this message",

			"hint.longPress": "Hold 2s: multi-select and merge",

			"notify.pickFirst": "Select the messages to forward first",
			"notify.multiSelect": "Multi-select is on: tick the dots on the left, or open quick select from the bar below",
			"notify.noContent": "Nothing to forward",
			"notify.noContentImages": "Nothing to forward (image read failed or no text)",
			"notify.draftFilled": "Switched to \"{title}\" and filled the composer; send to confirm",
			"notify.draftNotFilled": "Draft not filled: the composer of \"{title}\" is not ready, paste manually",
			"notify.mergeIncomplete": "{selected} selected; {missing} scrolled out of the render window with no snapshot and were skipped ({count} merged)",
			"notify.skippedImages": " ({count} unsupported image(s) skipped)",
			"notify.forwarded": "Forwarded to \"{title}\"{skipped}",
			"notify.failed": "Forwarding failed: {message}",

			"error.sessionsUnavailable": "Session service unavailable",
			"error.createSessionFailed": "Failed to create a session",
			"error.noSessionHandle": "Cannot obtain the target session handle",
			"error.sendRejected": "The target session rejected the send",

			"session.untitled": "Untitled session",
			"session.current": "Current session",
			"session.newCreated": "New session",
			"session.target": "Target session",
			"session.unknown": "Unknown session",
			"session.new": "New session",
			"session.label": "Session",

			"bar.quickSelect": "Quick select",
			"bar.pickerMeta": "{total} message(s) · up to {max} chars each",
			"bar.collapse": "Collapse",
			"bar.pickerExpand": "Open quick select to tick messages",
			"bar.pickerCollapse": "Close quick select",
			"bar.empty": "No loaded message to select in this session yet",
			"bar.noText": "(no text)",
			"bar.selected": "{selected} / {total} selected",
			"bar.selectAll": "Select all",
			"bar.clear": "Clear",
			"bar.exit": "Exit (Esc)",
			"bar.merge": "Merge and forward",

			"modal.titleForward": "Forward message",
			"modal.titleBatch": "Merge and forward",
			"modal.close": "Close",
			"modal.cancel": "Cancel",
			"modal.fillDraft": "Fill draft and jump",
			"modal.sendSilent": "Send silently",
			"modal.sendAndJump": "Send and jump",
			"modal.sending": "Working…",
			"modal.roleUser": "User message",
			"modal.roleAssistant": "Model reply",
			"modal.roleBatch": "{count} merged",
			"modal.roleBatchSource": "Merged messages",
			"modal.from": "From: {title}",
			"modal.imageCount": "· {count} image(s)",
			"modal.toBatch": "☷ Switch to multi-select",
			"modal.quickProcess": "Quick edit:",
			"modal.asReference": "+ As reference context",
			"modal.asTask": "+ As task input",
			"modal.reset": "Reset original",
			"modal.editorPlaceholder": "Trim the content or add task requirements here (editable before sending)",
			"modal.includeSource": "Include source marker (session title + message role)",
			"modal.targetTitle": "Choose target session",
			"modal.targetCount": "{count} session(s)",
			"modal.searchPlaceholder": "Search session title or directory…",
			"modal.newSessionOption": "New blank session (clean context)",
			"modal.noSessions": "No session to choose",
			"modal.noMatch": "No matching session",
			"modal.running": "● Running",
			"modal.targetHint": "Target: {title}",

			"marker.reference": "Below is the upstream session's output; use it as reference context:",
			"marker.task": "Continue with the following task based on the upstream result below:",
			"marker.source": "[Forwarded from \"{source}\" · {role}]",
			"marker.block": "[{index}] {tag}:",

			"command.forward": "Forward session messages"
		};

		let localeRef = null;
		let localeBound = null;

		/** 注册插件词表，返回 disposer；由 apply() 用 ctx.effect 托管。 */
		function registerLocale(scope) {
			const service = scope && typeof scope.get === "function" ? scope.get("locale") : scope;
			if (!service || typeof service.register !== "function") return () => {};
			localeRef = service;
			localeBound = null;
			try {
				return service.register(LOCALE_NS, { zh: MF_ZH, en: MF_EN });
			} catch (err) {
				console.warn("[dsh-forward] 插件文案注册失败（沿用内置词表）", err);
				return () => {};
			}
		}

		/** 取词：优先 Client locale 服务，其次内置词表；支持 {name} 插值。 */
		function t(key, params) {
			if (!localeBound && localeRef) {
				try { localeBound = localeRef.bind(LOCALE_NS); } catch { localeBound = null; }
			}
			if (localeBound) {
				try {
					const resolved = localeBound(key, params);
					// 词条缺失时服务原样返回 key，此时回落到内置词表
					if (typeof resolved === "string" && resolved !== key) return resolved;
				} catch { /* 文案服务异常不影响渲染 */ }
			}
			const template = MF_ZH[key] === undefined ? key : MF_ZH[key];
			if (!params) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
		}

		// ---------------------------------------------------------------- 图标
		function ForwardIcon({ size = 16 }) {
			return h("svg", {
				width: String(size),
				height: String(size),
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.8",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true
			},
				h("path", { d: "M13 5.2 20 12l-7 6.8" }),
				h("path", { d: "M20 12H4" })
			);
		}

		function PlusIcon({ size = 14 }) {
			return h("svg", {
				width: String(size),
				height: String(size),
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "2",
				strokeLinecap: "round",
				"aria-hidden": true
			},
				h("path", { d: "M12 5v14" }),
				h("path", { d: "M5 12h14" })
			);
		}

		function SearchIcon({ size = 14 }) {
			return h("svg", {
				width: String(size),
				height: String(size),
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "2",
				strokeLinecap: "round",
				"aria-hidden": true
			},
				h("circle", { cx: "11", cy: "11", r: "7" }),
				h("path", { d: "m20 20-3.2-3.2" })
			);
		}

		function WarnIcon({ size = 14 }) {
			return h("svg", {
				width: String(size),
				height: String(size),
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "2",
				strokeLinecap: "round",
				"aria-hidden": true
			},
				h("circle", { cx: "12", cy: "12", r: "9" }),
				h("path", { d: "M12 7.5v5" }),
				h("path", { d: "M12 16.2h.01" })
			);
		}

		function CheckIcon({ size = 14 }) {
			return h("svg", {
				width: String(size),
				height: String(size),
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "2",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true
			},
				h("path", { d: "m5 13 4 4L19 7" })
			);
		}

		function CloseIcon({ size = 14 }) {
			return h("svg", {
				width: String(size),
				height: String(size),
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "2",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true
			},
				h("path", { d: "M18 6 6 18" }),
				h("path", { d: "m6 6 12 12" })
			);
		}

		// ---------------------------------------------------------------- 自有原语
		/** 规范禁止插件 require 任何 Harness Client 包（含 dsh-client-ui-primitives），
		 *  所以这里按它的标记结构、交互行为和主题令牌重写插件自有的 Button / Input /
		 *  Modal / Toast / Tooltip 五个控件，类名统一 .dsh-mf-* 前缀，样式见下面 §样式。
		 *  行为对齐 primitives 的点：
		 *   - Modal：portal 到 body，遮罩点击与 Esc 关闭，Tab 在卡片内循环，关闭后把焦点还给触发元素；
		 *   - Toast：portal 到 body，pointer-events:none，停留 holdMs + 1000ms 淡出后回调 onDone；
		 *   - Tooltip：克隆唯一子元素挂 hover/focus，气泡 portal 到 body 并随 data-side 定位。 */

		/** class 拼接：默认类 + 调用方附加类，重复项只保留一份。 */
		function mfClass(base, extra) {
			if (!extra) return base;
			const added = String(extra).split(/\s+/).filter((name) => name && name !== base);
			return added.length ? base + " " + added.join(" ") : base;
		}

		/** 文本按钮：variant 取 ghost | outline | primary，尺寸取 md(36px) | sm(28px)。 */
		function MfButton({ variant = "ghost", size = "md", icon, disabled, className, children, onClick, ...rest }) {
			return h("button", {
				type: "button",
				className: mfClass("dsh-mf-button dsh-mf-button-" + variant + " dsh-mf-button-" + size, className),
				disabled: disabled === true,
				onClick,
				...rest
			},
				icon != null && h("span", { className: "dsh-mf-button-icon", "aria-hidden": true }, icon),
				children
			);
		}

		/** 带前置图标的文本输入框：span.dsh-mf-input > [span.dsh-mf-input-icon?, input.dsh-mf-input-field]。 */
		function MfInput({ icon, className, ...rest }) {
			return h("span", { className: mfClass("dsh-mf-input", className) },
				icon != null && h("span", { className: "dsh-mf-input-icon", "aria-hidden": true }, icon),
				h("input", { className: "dsh-mf-input-field", ...rest })
			);
		}

		const MF_FOCUSABLE = "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex=\"0\"]";
		const MF_TOAST_FADE_MS = 1000;

		/** 居中弹窗：结构对齐 primitives 的 Modal（root > mask + dialog > [content, footer]），
		 *  这样弹窗自适应样式可以只针对自己的类名，不必再猜对方的哈希类名。 */
		function MfModal({
			open,
			onClose,
			title,
			closeLabel,
			description,
			children,
			footer,
			className,
			contentClassName,
			headless = false
		}) {
			const dialogRef = useRef(null);
			const closeRef = useRef(onClose);
			closeRef.current = onClose;

			useEffect(() => {
				if (!open) return undefined;
				const element = dialogRef.current;
				const doc = (element && element.ownerDocument) || (typeof document === "undefined" ? null : document);
				if (!doc || !element) return undefined;
				const restoreTo = doc.activeElement;

				// 首个可聚焦元素：优先显式标记，其次第一个可聚焦项，最后退回卡片本身
				const autofocus = element.querySelector("[data-modal-autofocus]")
					|| element.querySelector(MF_FOCUSABLE)
					|| element;
				if (typeof autofocus.focus === "function") {
					try { autofocus.focus(); } catch { /* 元素尚不可聚焦 */ }
				}

				const onKeyDown = (event) => {
					if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
					if (event.key === "Escape" && !event.shiftKey) {
						event.preventDefault();
						if (!event.repeat) closeRef.current();
						return;
					}
					if (event.key !== "Tab") return;
					const items = Array.prototype.slice.call(element.querySelectorAll(MF_FOCUSABLE));
					const first = items[0] || element;
					const last = items[items.length - 1] || element;
					const active = doc.activeElement;
					const leaving = active === element || !element.contains(active);
					if (leaving || (event.shiftKey ? active === first : active === last)) {
						event.preventDefault();
						(event.shiftKey ? last : first).focus();
					}
				};

				doc.addEventListener("keydown", onKeyDown);
				return () => {
					doc.removeEventListener("keydown", onKeyDown);
					if (restoreTo && restoreTo.isConnected && typeof restoreTo.focus === "function") {
						try { restoreTo.focus(); } catch { /* 原焦点元素已不可聚焦 */ }
					}
				};
			}, [open]);

			if (!open) return null;

			const requestClose = () => closeRef.current();
			const node = h("div", { className: "dsh-mf-modal-root", role: "presentation" },
				h("div", { className: "dsh-mf-modal-mask", "aria-hidden": "true", onClick: requestClose }),
				h("div", {
					ref: dialogRef,
					tabIndex: -1,
					className: mfClass("dsh-mf-dialog", className),
					role: "dialog",
					"aria-modal": "true",
					"aria-label": title
				},
					headless ? children : h(Fragment, null,
						h("div", { className: mfClass("dsh-mf-content", contentClassName) },
							h("div", { className: "dsh-mf-modal-header" },
								h("h2", { className: "dsh-mf-modal-title" }, title),
								h("button", {
									type: "button",
									className: "dsh-mf-modal-close",
									"aria-label": closeLabel,
									onClick: requestClose
								}, h(CloseIcon, { size: 14 }))
							),
							description != null && h("p", { className: "dsh-mf-modal-description" }, description),
							// 正文容器由调用方自己提供（转发弹窗就是 .dsh-mf-modal-body），
							// 这里与 primitives 的 Modal 一致：不再额外包一层 div.body。
							children
						),
						footer != null && h("div", { className: "dsh-mf-modal-footer" }, footer)
					)
				)
			);
			return portalToBody(node);
		}

		/** 顶部提示条：不拦截点击，停留 holdMs 后交给 CSS 淡出，再回调 onDone。 */
		function MfToast({ text, icon, tone, holdMs = 3000, onDone }) {
			const doneRef = useRef(onDone);
			doneRef.current = onDone;
			useEffect(() => {
				const timer = setTimeout(() => {
					if (typeof doneRef.current === "function") doneRef.current();
				}, holdMs + MF_TOAST_FADE_MS);
				return () => clearTimeout(timer);
			}, [holdMs]);

			const node = h("div", {
				className: "dsh-mf-toast",
				role: "alert",
				// CSS 变量给淡出动画读，避免 JS 与动画时长脱钩
				style: { "--dsh-mf-toast-hold": holdMs + "ms" }
			},
				tone === "success"
					? h("span", { className: "dsh-mf-toast-icon dsh-mf-toast-icon-success", "aria-hidden": true }, h(CheckIcon, { size: 16 }))
					: (icon != null && h("span", { className: "dsh-mf-toast-icon", "aria-hidden": true }, icon)),
				h("span", { className: "dsh-mf-toast-text" }, text)
			);
			return portalToBody(node);
		}

		/** 视口内夹取：把以 center 为中心、宽 width 的浮层夹进 [margin, vw - margin]。
		 *  窄屏（手机）上气泡/提示贴着视口边缘时，不做夹取会有一半溢出屏幕被裁掉。 */
		function clampCenter(center, width, viewportWidth, margin = 8) {
			const half = width / 2;
			// 视口比浮层还窄时，退化为居中（左右各留 margin 已无意义）
			if (width + margin * 2 >= viewportWidth) return viewportWidth / 2;
			const min = half + margin;
			const max = viewportWidth - half - margin;
			return Math.min(Math.max(center, min), max);
		}

		/** 悬停 / 聚焦提示：克隆唯一子元素挂事件，气泡 portal 到 body。
		 *  气泡宽度依赖内容（max-width: 50vw），show() 时量不到，
		 *  因此先在 anchor 处渲染一帧，再用 layout effect 量宽并夹取。 */
		function MfTooltip({ label, side = "bottom", gap = 8, children }) {
			const anchorRef = useRef(null);
			const bubbleRef = useRef(null);
			const [anchor, setAnchor] = useState(null);
			const [shift, setShift] = useState(0);
			const text = typeof label === "function" ? label() : label;
			const child = Array.isArray(children) ? children[0] : children;
			// React 18 把 ref 放在 element 上，React 19 移到了 element.props 上；
			// 两种都要读，否则在 React 19 下会静默丢掉子元素自己的 ref。
			const childRef = !child ? null
				: (child.ref !== undefined && child.ref !== null ? child.ref
					: (child.props ? child.props.ref : null));

			const mergedRef = useCallback((element) => {
				anchorRef.current = element;
				if (typeof childRef === "function") childRef(element);
				else if (childRef && typeof childRef === "object") childRef.current = element;
			}, [childRef]);

			const show = useCallback(() => {
				const element = anchorRef.current;
				if (!element || typeof element.getBoundingClientRect !== "function") return;
				const rect = element.getBoundingClientRect();
				setAnchor({
					left: rect.left + rect.width / 2,
					top: rect.bottom + gap
				});
				setShift(0);
			}, [gap]);
			const hide = useCallback(() => {
				setAnchor(null);
				setShift(0);
			}, []);

			// 气泡挂载后量真实宽度，算出把中心夹进视口所需的横向位移。
			useLayoutEffect(() => {
				if (!anchor) return;
				const node = bubbleRef.current;
				if (!node || typeof node.getBoundingClientRect !== "function") return;
				const width = node.getBoundingClientRect().width;
				const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
				if (!width || !viewportWidth) return;
				const clamped = clampCenter(anchor.left, width, viewportWidth);
				const delta = clamped - anchor.left;
				// 只在真的越界时设值，避免无谓的重渲染循环
				setShift((prev) => (Math.abs(prev - delta) < 0.5 ? prev : delta));
			}, [anchor, text]);

			const trigger = cloneElement(child, {
				ref: mergedRef,
				onPointerEnter: show,
				onPointerLeave: hide,
				onFocus: show,
				onBlur: hide,
				onKeyDown: (event) => {
					if (event.key === "Escape") hide();
					if (typeof child.props.onKeyDown === "function") child.props.onKeyDown(event);
				}
			});

			if (!text || !anchor) return trigger;
			const bubble = h("div", {
				ref: bubbleRef,
				className: "dsh-mf-tooltip",
				role: "tooltip",
				"data-side": side,
				style: {
					left: anchor.left + "px",
					top: anchor.top + "px",
					// 用 CSS 变量承载位移，交给 transform 组合，避免覆盖 data-side 的居中位移
					"--dsh-mf-tooltip-shift": shift + "px"
				}
			}, h("span", { className: "dsh-mf-tooltip-label" }, text));
			return h(Fragment, null, trigger, portalToBody(bubble));
		}

		// ---------------------------------------------------------------- 样式
		const CSS = `
			.dsh-mf-btn {
				width: 26px;
				height: 26px;
				flex: 0 0 auto;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				padding: 0;
				border: none;
				border-radius: 6px;
				background: transparent;
				color: var(--dsw-alias-label-tertiary);
				cursor: pointer;
				position: relative;
				user-select: none;
				-webkit-user-select: none;
				transition: background-color .12s ease, color .12s ease;
			}
			.dsh-mf-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); color: var(--dsw-alias-label-secondary); }
			.dsh-mf-btn.dsh-mf-active { color: var(--dsw-alias-state-business-primary, #3b82f6); }
			.dsh-mf-btn svg { display: block; }
			.dsh-mf-ring-wrap {
				position: absolute;
				left: 50%;
				top: 50%;
				width: 40px;
				height: 40px;
				transform: translate(-50%, -50%);
				pointer-events: none;
				z-index: 30;
			}
			.dsh-mf-ring-svg { width: 40px; height: 40px; transform: rotate(-90deg); }
			.dsh-mf-ring-bg { fill: none; stroke: rgba(127,127,127,.28); stroke-width: 3; }
			.dsh-mf-ring-bar {
				fill: none;
				stroke: var(--dsw-alias-state-business-primary, #3b82f6);
				stroke-width: 3;
				stroke-linecap: round;
				stroke-dasharray: 87.96;
				stroke-dashoffset: 87.96;
				animation: dsh-mf-ring-fill linear forwards;
				animation-duration: var(--dsh-mf-ring-duration, 2000ms);
			}
			@keyframes dsh-mf-ring-fill { from { stroke-dashoffset: 87.96; } to { stroke-dashoffset: 0; } }
			.dsh-mf-ring-tip {
				position: absolute;
				left: 50%;
				top: calc(100% + 2px);
				transform: translateX(-50%);
				white-space: nowrap;
				font-size: 11px;
				line-height: 1.6;
				padding: 2px 8px;
				border-radius: 6px;
				background: var(--dsw-alias-bg-overlay, rgba(30,30,30,.94));
				color: var(--dsw-alias-label-primary, #fff);
				box-shadow: 0 4px 14px rgba(0,0,0,.24);
			}

			/* ---------------------------------------------------------------- 弹窗（自有原语 MfModal）
			   结构：root > [mask, dialog > [content > [header, description?, body], footer]]
			   卡片加宽到 720px 并按视口高度封顶；正文区接上 flex 收缩链
			   （dialog > content > body 都要 min-height:0），让正文内部滚动，
			   头部标题与底部按钮在矮窗口下始终可见。 */
			.dsh-mf-modal-root {
				pointer-events: auto;
				position: fixed;
				inset: 0;
				z-index: 1000;
				display: flex;
				align-items: center;
				justify-content: center;
				padding: 24px;
			}
			.dsh-mf-modal-mask { position: absolute; inset: 0; cursor: default; }
			.dsh-mf-modal-mask::after {
				content: "";
				position: absolute;
				inset: 0;
				background: var(--dsw-alias-bg-mask-1);
			}
			.dsh-mf-dialog {
				box-sizing: border-box;
				position: relative;
				z-index: 1;
				display: flex;
				flex-direction: column;
				gap: 20px;
				width: min(380px, 100%);
				max-height: 100%;
				padding: 0 0 24px;
				overflow: hidden;
				border: 0;
				border-radius: 12px;
				background: var(--dsw-alias-bg-layer-2);
				box-shadow: 0 12px 40px rgba(0,0,0,.28);
			}
			/* 转发弹窗要放长内容：加宽到 720px 并按视口高度封顶。
			   min-width: 0 是必需的：卡片是 .dsh-mf-modal-root(flex) 的子项，
			   默认 min-width:auto 会把它撑到内容的 min-content 宽度
			   （底部四个按钮 + 会话列表的固有宽度），于是 width:min(720px,100%)
			   被无视，卡片实际宽到 850px+ 并溢出视口。 */
			.dsh-mf-dialog.dsh-mf-dialog { width: min(720px, 100%); min-width: 0; max-height: 100%; }
			.dsh-mf-content {
				display: flex;
				flex-direction: column;
				width: 100%;
				min-height: 0;
				flex: 1 1 auto;
			}
			.dsh-mf-modal-header {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 8px;
				padding: 22px 14px 12px 24px;
			}
			.dsh-mf-modal-title {
				margin: 0;
				font-size: 16px;
				line-height: 24px;
				font-weight: 500;
				color: var(--dsw-alias-label-primary);
			}
			.dsh-mf-modal-close {
				flex: none;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				width: 28px;
				height: 28px;
				padding: 0;
				border: none;
				border-radius: 6px;
				background: transparent;
				color: var(--dsw-alias-label-secondary);
				cursor: pointer;
			}
			.dsh-mf-modal-close:hover { background: var(--dsw-alias-interactive-bg-hover); }
			.dsh-mf-modal-description {
				margin: 0;
				padding: 0 24px;
				font-size: 14px;
				line-height: 22px;
				color: var(--dsw-alias-label-primary);
			}
			/* Modal 固定结构：content > [header, description?, body]，body 永远是最后一个子节点。
			   头部/描述不参与压缩，正文容器接上收缩链（min-height:0 才能真的缩下去）。 */
			.dsh-mf-content > *:not(:last-child) { flex: none; }
			.dsh-mf-content > *:last-child { min-height: 0; flex: 1 1 auto; }
			/* 底部按钮区是 content 的下一个兄弟（dialog > [content, footer]），
			   禁止它被压缩，否则小窗口下按钮会被挤没。 */
			.dsh-mf-dialog > .dsh-mf-content ~ * { flex: none; }
			.dsh-mf-modal-body {
				display: flex;
				flex-direction: column;
				gap: 14px;
				min-width: 0;
				margin-top: 20px;
				padding: 0 24px;
				min-height: 0;
				flex: 1 1 auto;
				overflow-y: auto;
				overscroll-behavior: contain;
				/* 兜底：万一 flex 收缩链没生效，也不让正文把卡片撑出视口。
				   头部/底部/外边距的固定开销约 240px，其余留给正文。 */
				max-height: calc(100vh - 240px);
				max-height: calc(100dvh - 240px);
			}

			/* ---------------------------------------------------------------- 自有控件
			   Button / Input / Toast / Tooltip：按 primitives 的标记与令牌重写的自有副本，
			   类名全部走 .dsh-mf-* 前缀，只依赖 --dsw-alias-* 主题令牌（不套别人的哈希类名）。 */
			.dsh-mf-button {
				box-sizing: border-box;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				gap: 4px;
				flex: 0 0 auto;
				border: none;
				border-radius: 8px;
				padding: 0 14px;
				font-size: 14px;
				line-height: 22px;
				font-family: inherit;
				color: var(--dsw-alias-label-primary);
				background: transparent;
				cursor: pointer;
				transition: background-color .12s ease;
			}
			.dsh-mf-button-md { height: 36px; }
			.dsh-mf-button-sm { height: 28px; padding: 0 10px; font-size: 12px; line-height: 18px; border-radius: 6px; }
			.dsh-mf-button:disabled { cursor: not-allowed; opacity: .4; }
			.dsh-mf-button-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
			.dsh-mf-button-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
			.dsh-mf-button-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
			.dsh-mf-button-ghost:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
			.dsh-mf-button-outline { border: .5px solid var(--dsw-alias-border-l3); }
			.dsh-mf-button-outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
			.dsh-mf-button-icon { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; }
			.dsh-mf-input {
				display: inline-flex;
				align-items: center;
				gap: 6px;
				box-sizing: border-box;
				height: 32px;
				padding: 0 8px;
				border: .5px solid var(--dsw-alias-border-l4);
				border-radius: 8px;
				background: var(--dsw-alias-bg-layer-1);
			}
			.dsh-mf-input:focus-within { border-color: var(--dsw-alias-state-business-primary); }
			.dsh-mf-input-icon {
				display: inline-flex;
				align-items: center;
				justify-content: center;
				width: 16px;
				height: 16px;
				color: var(--dsw-alias-label-tertiary);
			}
			.dsh-mf-input-field {
				flex: 1 1 auto;
				min-width: 0;
				border: none;
				outline: none;
				background: transparent;
				font-size: 14px;
				line-height: 22px;
				font-family: inherit;
				color: var(--dsw-alias-label-primary);
			}
			.dsh-mf-input-field::placeholder { color: var(--dsw-alias-label-dimmed); }
			.dsh-mf-toast {
				position: fixed;
				top: 40px;
				left: 50%;
				z-index: 1100;
				pointer-events: none;
				display: flex;
				align-items: center;
				gap: 10px;
				width: max-content;
				max-width: min(640px, calc(100vw - 48px));
				padding: 12px 16px;
				border-radius: 12px;
				background: var(--dsw-alias-toast-bg);
				color: var(--dsw-alias-toast-label);
				font-size: 14px;
				line-height: 22px;
				box-shadow: 0 12px 40px rgba(0,0,0,.28);
				transform: translateX(-50%);
				animation: dsh-mf-toast-in 160ms ease-out, dsh-mf-toast-fade 1000ms ease var(--dsh-mf-toast-hold, 3000ms) forwards;
			}
			.dsh-mf-toast-icon { display: grid; place-items: center; flex: none; color: var(--dsw-alias-state-warn-label); }
			.dsh-mf-toast-icon-success { color: var(--dsw-alias-state-success-primary); }
			.dsh-mf-toast-text { min-width: 0; }
			@keyframes dsh-mf-toast-in {
				from { opacity: 0; transform: translate(-50%, -6px); }
				to { opacity: 1; transform: translate(-50%, 0); }
			}
			@keyframes dsh-mf-toast-fade { to { opacity: 0; visibility: hidden; } }
			@media (prefers-reduced-motion: reduce) {
				/* 减弱动效时去掉滑入，只保留淡出 */
				.dsh-mf-toast { animation: dsh-mf-toast-fade 1000ms ease var(--dsh-mf-toast-hold, 3000ms) forwards; }
			}
			.dsh-mf-tooltip {
				position: fixed;
				z-index: 100;
				display: inline-flex;
				align-items: center;
				gap: 8px;
				width: max-content;
				max-width: 50vw;
				padding: 3px 7px;
				border-radius: 6px;
				background: var(--dsw-alias-tooltip-bg);
				color: var(--dsw-alias-label-primary-foreground);
				font-size: 13px;
				line-height: 20px;
				white-space: pre-line;
				overflow-wrap: break-word;
				pointer-events: none;
				animation: dsh-mf-tooltip-in 150ms ease-in-out;
			}
			/* 横向位移走 CSS 变量，与 data-side 的居中位移组合；
			   变量由 MfTooltip 量宽后写入，把气泡夹进视口。 */
			.dsh-mf-tooltip[data-side="bottom"] { transform: translateX(calc(-50% + var(--dsh-mf-tooltip-shift, 0px))); }
			.dsh-mf-tooltip[data-side="top"] { transform: translate(calc(-50% + var(--dsh-mf-tooltip-shift, 0px)), -100%); }
			.dsh-mf-tooltip[data-side="right"] { transform: translateY(-50%); }
			@keyframes dsh-mf-tooltip-in { from { opacity: 0; } }
			.dsh-mf-card {
				display: flex;
				flex-direction: column;
				gap: 10px;
				padding: 12px;
				border-radius: 10px;
				border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));
				background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06));
			}
			.dsh-mf-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
			.dsh-mf-row-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
			/* 底部：目标提示与按钮组换行，按钮组右对齐并允许自身换行 */
			.dsh-mf-footer {
				box-sizing: border-box;
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 10px;
				flex-wrap: wrap;
				width: 100%;
				min-width: 0;
				/* 与 header / description / body 的 24px 横向内边距对齐。
				   少了这一条，四个按钮会直接怼在卡片边缘上。
				   注意 box-sizing 必须显式写：默认 content-box 下
				   width:100% + padding 0 24px 会撑出 48px，右侧被卡片的
				   overflow:hidden 裁掉，表现为「左边有间距、右边贴边」。 */
				padding: 0 24px;
			}
			/* 底部包装层：primitives 的 Modal 在 footer 外面包一层，
			   它自己没有 CSS 时是普通 block，宽度跟随卡片。
			   min-width:0 让内部的按钮组可以真正收缩换行，而不是把卡片撑宽。 */
			.dsh-mf-modal-footer { min-width: 0; }
			.dsh-mf-footer-actions {
				justify-content: flex-end;
				margin-left: auto;
				/* 按钮组自己也可以换行，窄屏下不会互相挤压 */
				flex-wrap: wrap;
				min-width: 0;
			}
			.dsh-mf-footer .dsh-mf-hint { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.dsh-mf-badge {
				display: inline-flex;
				align-items: center;
				gap: 4px;
				font-size: 11px;
				font-weight: 600;
				padding: 2px 8px;
				border-radius: 999px;
				background: rgba(59,130,246,.14);
				color: #3b82f6;
			}
			.dsh-mf-badge-user { background: rgba(16,185,129,.14); color: #10b981; }
			.dsh-mf-badge-batch { background: rgba(168,85,247,.16); color: #a855f7; }
			.dsh-mf-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
			.dsh-mf-chip {
				font-size: 11px;
				line-height: 1.8;
				padding: 1px 8px;
				border-radius: 999px;
				border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));
				background: transparent;
				color: var(--dsw-alias-label-secondary);
				cursor: pointer;
			}
			.dsh-mf-chip:hover { border-color: var(--dsw-alias-state-business-primary, #3b82f6); color: var(--dsw-alias-state-business-primary, #3b82f6); }
			.dsh-mf-edit {
				width: 100%;
				min-height: 120px;
				/* 跟随视口，窄/矮窗口下不再把弹窗顶出屏幕 */
				max-height: min(300px, 32dvh);
				resize: vertical;
				box-sizing: border-box;
				padding: 10px;
				border-radius: 8px;
				border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
				background: var(--dsw-alias-bg-base, transparent);
				color: var(--dsw-alias-label-primary);
				font-family: inherit;
				font-size: 13px;
				line-height: 1.6;
			}
			.dsh-mf-edit:focus { outline: none; border-color: var(--dsw-alias-state-business-primary, #3b82f6); }
			.dsh-mf-thumbs { display: flex; flex-wrap: wrap; gap: 8px; }
			.dsh-mf-thumb {
				width: 62px;
				height: 62px;
				object-fit: cover;
				border-radius: 8px;
				border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
			}
			.dsh-mf-check-line { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
			.dsh-mf-list {
				max-height: min(240px, 26dvh);
				overflow-y: auto;
				display: flex;
				flex-direction: column;
				gap: 4px;
				padding: 4px;
				border-radius: 8px;
				border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));
			}
			.dsh-mf-item {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 8px;
				padding: 7px 10px;
				border-radius: 7px;
				cursor: pointer;
				border: 1px solid transparent;
			}
			.dsh-mf-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
			.dsh-mf-item.selected { background: rgba(59,130,246,.12); border-color: rgba(59,130,246,.5); }
			.dsh-mf-item-title {
				font-size: 13px;
				color: var(--dsw-alias-label-primary);
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
			.dsh-mf-item-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); display: flex; gap: 8px; }
			.dsh-mf-empty { padding: 14px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary); }

			.dsh-mf-bar {
				position: fixed;
				left: 50%;
				bottom: 22px;
				transform: translateX(-50%);
				display: flex;
				align-items: center;
				justify-content: center;
				flex-wrap: wrap;
				gap: 8px;
				padding: 8px 10px;
				border-radius: 12px;
				z-index: 2147482000;
				max-width: min(92vw, 560px);
				box-sizing: border-box;
				background: var(--dsw-alias-bg-overlay);
				color: var(--dsw-alias-label-primary);
				border: 1px solid var(--dsw-alias-border-l2);
				box-shadow: 0 10px 34px rgba(0,0,0,.28);
				font-family: inherit;
				font-size: 12px;
				line-height: 1.4;
			}
			.dsh-mf-bar-count { font-weight: 600; white-space: nowrap; }
			.dsh-mf-bar-btn {
				font-family: inherit;
				font-size: 12px;
				line-height: 1.4;
				padding: 5px 10px;
				border-radius: 7px;
				border: 1px solid var(--dsw-alias-border-l2);
				background: var(--dsw-alias-bg-layer-2);
				color: var(--dsw-alias-label-primary);
				cursor: pointer;
				white-space: nowrap;
				transition: background-color .12s ease, border-color .12s ease, color .12s ease;
			}
			.dsh-mf-bar-btn:hover {
				background: var(--dsw-alias-interactive-bg-hover);
				border-color: var(--dsw-alias-border-l3);
			}
			.dsh-mf-bar-btn.dsh-mf-primary {
				background: var(--dsw-alias-button-primary-fill);
				border-color: var(--dsw-alias-button-primary-fill);
				color: var(--dsw-alias-label-primary-inverted);
				font-weight: 600;
			}
			.dsh-mf-bar-btn.dsh-mf-primary:hover {
				background: var(--dsw-alias-button-primary-hover);
				border-color: var(--dsw-alias-button-primary-hover);
			}
			.dsh-mf-bar-btn[disabled] { opacity: .5; cursor: not-allowed; }

			/* 计数按钮：点它展开「快捷选择」面板 */
			.dsh-mf-bar-count-btn {
				font-family: inherit;
				font-size: 12px;
				line-height: 1.4;
				display: inline-flex;
				align-items: center;
				gap: 4px;
				padding: 4px 9px;
				border-radius: 7px;
				border: 1px solid var(--dsw-alias-border-l2);
				background: var(--dsw-alias-bg-layer-2);
				color: var(--dsw-alias-label-primary);
				cursor: pointer;
				white-space: nowrap;
			}
			.dsh-mf-bar-count-btn:hover {
				background: var(--dsw-alias-interactive-bg-hover);
				border-color: var(--dsw-alias-border-l3);
			}
			.dsh-mf-bar-count-btn.open { border-color: var(--dsw-alias-brand-primary); }
			.dsh-mf-bar-caret { font-size: 9px; color: var(--dsw-alias-label-secondary); }

			/* 快捷选择面板：占满工具条一整行，列表内部滚动，不会把工具条顶出视口 */
			.dsh-mf-picker {
				flex-basis: 100%;
				width: 100%;
				min-width: 0;
				display: flex;
				flex-direction: column;
				gap: 6px;
				padding-bottom: 6px;
				border-bottom: 1px solid var(--dsw-alias-border-l2);
				text-align: left;
			}
			.dsh-mf-picker-head { display: flex; align-items: center; gap: 8px; }
			.dsh-mf-picker-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
			.dsh-mf-picker-close {
				margin-left: auto;
				width: 20px;
				height: 20px;
				display: flex;
				align-items: center;
				justify-content: center;
				border: 0;
				border-radius: 6px;
				background: transparent;
				color: var(--dsw-alias-label-secondary);
				cursor: pointer;
				font-size: 14px;
				line-height: 1;
			}
			.dsh-mf-picker-close:hover {
				background: var(--dsw-alias-interactive-bg-hover);
				color: var(--dsw-alias-label-primary);
			}
			.dsh-mf-picker-list {
				display: flex;
				flex-direction: column;
				gap: 3px;
				max-height: min(300px, 38dvh);
				overflow-y: auto;
				overscroll-behavior: contain;
			}
			.dsh-mf-pick-item {
				display: flex;
				align-items: flex-start;
				gap: 7px;
				width: 100%;
				box-sizing: border-box;
				padding: 6px 8px;
				border-radius: 7px;
				border: 1px solid transparent;
				background: transparent;
				color: var(--dsw-alias-label-primary);
				font-family: inherit;
				font-size: 12px;
				line-height: 1.45;
				text-align: left;
				cursor: pointer;
			}
			.dsh-mf-pick-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
			.dsh-mf-pick-item.selected {
				background: var(--dsw-alias-bg-multi-select, rgba(59,130,246,.10));
				border-color: var(--dsw-alias-brand-primary);
			}
			/* 角色徽章：一眼分清「用户」还是「模型」 */
			.dsh-mf-pick-badge {
				flex: 0 0 auto;
				margin-top: 1px;
				font-size: 10px;
				font-weight: 600;
				padding: 1px 6px;
				border-radius: 999px;
			}
			.dsh-mf-pick-badge-user { background: rgba(16,185,129,.16); color: #10b981; }
			.dsh-mf-pick-badge-model { background: rgba(59,130,246,.16); color: #3b82f6; }
			.dsh-mf-pick-index { flex: 0 0 auto; margin-top: 2px; font-size: 10px; color: var(--dsw-alias-label-tertiary); }
			.dsh-mf-pick-text {
				flex: 1 1 auto;
				min-width: 0;
				overflow: hidden;
				display: -webkit-box;
				-webkit-line-clamp: 3;
				-webkit-box-orient: vertical;
			}
			.dsh-mf-pick-mark { flex: 0 0 auto; margin-top: 2px; font-size: 10px; color: var(--dsw-alias-label-tertiary); }

			/* 勾选框宿主：进入多选时在消息行左侧留出一条装订线，
			   勾选框落在装订线里，既不会被父级 overflow 裁掉，也不压住正文。 */
			.dsh-mf-check-host {
				position: relative;
				padding-left: 32px;
			}
			.dsh-mf-check {
				position: absolute;
				left: 6px;
				top: 50%;
				transform: translateY(-50%);
				width: 22px;
				height: 22px;
				display: flex;
				align-items: center;
				justify-content: center;
				border-radius: 7px;
				cursor: pointer;
				z-index: 12;
			}
			.dsh-mf-check-box {
				width: 18px;
				height: 18px;
				box-sizing: border-box;
				border-radius: 50%;
				border: 2px solid var(--dsw-alias-label-secondary);
				background: var(--dsw-alias-bg-layer-1);
				box-shadow: 0 1px 4px rgba(0,0,0,.28);
				display: flex;
				align-items: center;
				justify-content: center;
				transition: background-color .12s ease, border-color .12s ease, transform .12s ease;
			}
			.dsh-mf-check:hover .dsh-mf-check-box {
				border-color: var(--dsw-alias-brand-primary);
				transform: scale(1.08);
			}
			.dsh-mf-check.selected .dsh-mf-check-box {
				background: var(--dsw-alias-brand-primary);
				border-color: var(--dsw-alias-brand-primary);
			}
			.dsh-mf-check.selected .dsh-mf-check-box::after {
				content: "";
				width: 8px;
				height: 4.5px;
				border-left: 2px solid var(--dsw-alias-label-primary-inverted);
				border-bottom: 2px solid var(--dsw-alias-label-primary-inverted);
				transform: rotate(-45deg) translate(0.5px, -1px);
			}
			body.dsh-mf-batch-active { cursor: default; }
			.dsh-mf-unit-selected {
				background: var(--dsw-alias-bg-multi-select, rgba(59,130,246,.10));
				border-radius: 10px;
			}

			/* ---------------------------------------------------------------- 移动端适配
			   断点与 dsh-mobile 对齐（720px），触摸目标对齐其 44px 下限。
			   手机上没有 hover，26px 的图标按钮误触率高；底部工具条还要避开
			   iPhone 的 Home 指示条（safe-area-inset-bottom）。 */
			@media (max-width: 720px) {
				/* 图标按钮：视觉尺寸保持克制，但用伪元素把可点区域撑到 44x44，
				   避免直接放大图标破坏消息行的排版。 */
				.dsh-mf-btn { width: 32px; height: 32px; }
				.dsh-mf-btn::after {
					content: "";
					position: absolute;
					left: 50%;
					top: 50%;
					width: 44px;
					height: 44px;
					transform: translate(-50%, -50%);
				}
				.dsh-mf-modal-close,
				.dsh-mf-picker-close { width: 44px; height: 44px; }

				/* 勾选框：装订线同步加宽，容纳放大后的点击区 */
				.dsh-mf-check { left: 2px; width: 32px; height: 32px; }
				.dsh-mf-check-box { width: 22px; height: 22px; }
				.dsh-mf-check-host { padding-left: 40px; }

				/* 工具条按钮：加高到 44px，并允许文字换行不撑破 */
				.dsh-mf-bar-btn,
				.dsh-mf-bar-count-btn {
					min-height: 44px;
					padding: 0 8px;
					font-size: 13px;
				}
				.dsh-mf-bar {
					/* 底部留出 Home 指示条 */
					bottom: calc(12px + env(safe-area-inset-bottom, 0px));
					gap: 6px;
					padding: 8px;
					max-width: calc(100vw - 16px);
					/* 五个控件（计数 / 全选 / 清空 / 退出 / 合并转发）在窄屏上
					   按 flex-wrap 会各自占满一行，堆成四排、把聊天区顶掉一大块。
					   改成两列网格：计数 + 全选 / 清空 / 退出 + 合并转发 = 两排。
					   宽度写死为视口宽减 16px（与上面的 max-width 同源），
					   否则 fixed 元素 shrink-to-fit 会按最长一行定宽，网格列宽随之漂移。 */
					display: grid;
					grid-template-columns: 1fr 1fr;
					width: calc(100vw - 16px);
				}
				/* 网格子项默认 min-width:auto，会被「已选 3 / 12 条」这类不换行文本撑破列宽 */
				.dsh-mf-bar > * { min-width: 0; }
				/* 按钮跨满整行：并排的两列按钮互相撑宽，窄屏上会溢出工具条 */
				.dsh-mf-bar-btn,
				.dsh-mf-bar-count-btn { width: 100%; justify-content: center; }
				/* 快捷选择面板本来就占满一整行，跨两列后不会被挤成半宽 */
				.dsh-mf-picker { grid-column: 1 / -1; }
				/* 快捷选择面板占满屏高比例过大，矮屏会盖住聊天区下半部分 */
				.dsh-mf-picker-list { max-height: min(240px, 30dvh); }
				.dsh-mf-list { max-height: min(200px, 22dvh); }

				/* 弹窗：手机上收紧内边距，把宽度让给内容 */
				.dsh-mf-modal-root { padding: 12px; }
				.dsh-mf-modal-header { padding: 16px 10px 10px 16px; }
				.dsh-mf-modal-description,
				.dsh-mf-modal-body { padding-left: 16px; padding-right: 16px; }
				.dsh-mf-modal-body { max-height: calc(100dvh - 200px); }
				.dsh-mf-edit { max-height: min(240px, 28dvh); }

				/* 底部按钮区：跟着一起收到 16px，并让四个按钮在窄屏上等宽铺满。
				   四个按钮横排会挤成一行小字，改为两列网格后每个都有足够点击面积。 */
				.dsh-mf-footer { padding: 0 16px; }
				.dsh-mf-footer-actions {
					display: grid;
					grid-template-columns: 1fr 1fr;
					gap: 8px;
					width: 100%;
					margin-left: 0;
				}
				.dsh-mf-footer-actions .dsh-mf-button { width: 100%; }

				/* 提示气泡在窄屏上占满可用宽度，避免长文案被压成细条 */
				.dsh-mf-tooltip { max-width: calc(100vw - 24px); }
			}
		`;

		/** 样式表：工厂求值阶段一律不碰 DOM，注册 / 摘除都放在 apply() 的 ctx.effect 里成对发生
		 *  （规范：Keep factories free of side effects）。 */

		// ---------------------------------------------------------------- 轻量 store
		function makeStore(initial) {
			let state = initial;
			const listeners = new Set();
			return {
				get state() { return state; },
				set(patch) {
					state = { ...state, ...patch };
					listeners.forEach((fn) => { try { fn(state); } catch (err) { console.error("[dsh-forward] store listener", err); } });
				},
				subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
			};
		}

		const forwardStore = makeStore({ isOpen: false, payload: null, toast: null });

		// pickerOpen：多选工具条上的「快捷选择」面板是否展开
		const batchStore = makeStore({ isActive: false, selectedIds: new Set(), sessionId: null, pickerOpen: false });

		/** 草稿交接：跨会话没有公开的 setDraft API，只能交给目标会话的 overlay 组件执行。
		 *  成功提示必须等 overlay 真正调用过 inputActions.setDraft 之后才发（ack），
		 *  否则会在 overlay 尚未挂载 / 输入框未就绪时假报成功。
		 *  因此 pending 不再「取走即丢」：只有 resolve() 确认应用后才清理，失败或超时仍留在
		 *  队列里由后续的广播 / overlay 重新挂载继续重试，重试受下面四个有界窗口约束。 */
		const DRAFT_BROADCAST_MS = 250;        // overlay 挂载可能滞后：重试广播的间隔
		const DRAFT_MAX_BROADCASTS = 40;       // 250ms × 40 ≈ 10s：广播窗口，到点停止重试
		const DRAFT_ACK_TIMEOUT_MS = 4000;     // 等不到 ack 就按「未填入」提示用户，不无限等
		const DRAFT_PENDING_TTL_MS = 30000;    // pending 最长保留 30s：超过后 take() 丢弃（重试的硬上限）

		const draftHub = {
			pending: null,
			listeners: new Set(),
			broadcastTimer: null,
			ackTimer: null,
			/** 等待 ack 的投递句柄：{ sessionId, settle(status) } */
			waiter: null,
			subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
			emit() {
				this.listeners.forEach((fn) => { try { fn(); } catch (err) { console.error("[dsh-forward] draft listener", err); } });
			},
			/** 卸载 / 重新投递前清理：定时器、未决等待者、待应用草稿一并作废。 */
			reset(status) {
				if (this.broadcastTimer !== null) { clearInterval(this.broadcastTimer); this.broadcastTimer = null; }
				if (this.ackTimer !== null) { clearTimeout(this.ackTimer); this.ackTimer = null; }
				this.pending = null;
				const w = this.waiter;
				this.waiter = null;
				if (w) w.settle(status || "cancelled");
			},
			/** 投递草稿；返回在 ack / 超时 / 卸载时 settle 的 Promise。
			 *  结局： "applied"   目标 overlay 已执行 setDraft（只有它能报成功）
			 *        "missing"   ack 窗口内没有任何 overlay 确认（等满 DRAFT_ACK_TIMEOUT_MS）
			 *        "cancelled" 插件卸载，或已被下一次投递取代 */
			request(sessionId, text, files) {
				this.reset("cancelled");
				this.pending = { sessionId, text, files: files || [], at: Date.now() };
				this.emit();
				let tries = 0;
				this.broadcastTimer = setInterval(() => {
					tries += 1;
					const p = this.pending;
					if (!p || p.sessionId !== sessionId || tries > DRAFT_MAX_BROADCASTS) {
						if (this.broadcastTimer !== null) { clearInterval(this.broadcastTimer); this.broadcastTimer = null; }
						return;
					}
					this.emit();
				}, DRAFT_BROADCAST_MS);
				return new Promise((resolve) => {
					this.waiter = { sessionId, settle: resolve };
					this.ackTimer = setTimeout(() => {
						this.ackTimer = null;
						const w = this.waiter;
						this.waiter = null;
						if (w) w.settle("missing");
					}, DRAFT_ACK_TIMEOUT_MS);
				});
			},
			/** overlay 取件。返回副本，pending 原地保留：只有 resolve(sessionId) 才算投递完成。
			 *  同一份 pending 因此可以被后续 overlay（或重新挂载的同名 overlay）继续尝试。 */
			take(sessionId) {
				const p = this.pending;
				if (!p || p.sessionId !== sessionId) return null;
				if (Date.now() - p.at > DRAFT_PENDING_TTL_MS) { this.pending = null; return null; }
				return { sessionId: p.sessionId, text: p.text, files: p.files, at: p.at };
			},
			/** ack API：由目标 overlay 在真正执行完 inputActions.setDraft 之后调用。
			 *  只承认「已应用」这一种 ack —— 失败 / 未就绪一律不 ack，pending 原地保留
			 *  等下一次广播重试，等待者最多等 DRAFT_ACK_TIMEOUT_MS 后收敛成 "missing"。
			 *  这样用户永远只收到一条（真）结果提示，不会有失败提示与迟到的成功提示打架。
			 *  返回 true 表示这次 ack 被采纳（sessionId 与当前 pending 对得上）。 */
			resolve(sessionId) {
				const p = this.pending;
				if (!p || p.sessionId !== sessionId) return false;
				if (this.broadcastTimer !== null) { clearInterval(this.broadcastTimer); this.broadcastTimer = null; }
				if (this.ackTimer !== null) { clearTimeout(this.ackTimer); this.ackTimer = null; }
				this.pending = null;
				const w = this.waiter;
				if (w && w.sessionId === sessionId) {
					this.waiter = null;
					w.settle("applied");
				}
				return true;
			}
		};

		function notify(text, ok) {
			forwardStore.set({ toast: { id: Date.now() + Math.random(), text, ok: ok !== false } });
		}
		function openForwardModal(payload) { forwardStore.set({ isOpen: true, payload }); }
		function closeForwardModal() { forwardStore.set({ isOpen: false }); }

		// ---------------------------------------------------------------- 文案 / 内容提取
		const MD_SEL = "[class*='markdown']";
		/** 思考链（ReasoningRow / ProcessReasoning）。
		 *  DSH 自己的 copy 按钮取的是 assistantText(closing.blocks)，只拼接 kind==="text" 的块，
		 *  天然不含 reasoning / tool-call。DOM 里对应的稳定标记是：
		 *   - [data-variant='think']           思考链根节点（ReasoningRow 自己打的标记）
		 *   - [data-turn-process-inline]       内联思考链的外层包装（ProcessReasoning）
		 *   - [data-markdown-variant='compact'] 思考链专用的紧凑 markdown 变体（正文用的是默认 body 变体）
		 *  class 名是构建期哈希，只作兜底。 */
		const THINK_SEL = "[data-variant='think'], [data-turn-process-inline], [class*='thinkBody'], [class*='reasoning'], [class*='thinking']";
		const THINK_MD_SEL = "[data-markdown-variant='compact']";
		/** 过程分组表头（“已思考 N 秒”）：不是正文，退化路径里必须剔掉 */
		const PROCESS_HEADER_SEL = "[data-process-activity]";
		const IMG_SEL = "[class*='gallery'] img, [class*='markdown'] img";

		function textOf(el) {
			if (!el) return "";
			// innerText 对隐藏/折叠节点返回空串，此时退回 textContent，避免漏掉折叠内容
			let raw = el.innerText;
			if (raw === undefined || raw === null || raw === "") raw = el.textContent;
			return String(raw || "").replace(/\u00a0/g, " ").trim();
		}

		function isNestedIn(el, sel) {
			const parent = el && el.parentElement;
			return !!(parent && parent.closest && parent.closest(sel));
		}

		/** 收集一段 DOM 里的正文：只取最外层 markdown 块，跳过思考链，避免重复 */
		function collectText(root) {
			if (!root || typeof root.querySelectorAll !== "function") return "";
			const blocks = [];
			root.querySelectorAll(MD_SEL).forEach((el) => {
				if (el.closest(THINK_SEL)) return;
				if (el.matches && el.matches(THINK_MD_SEL)) return;
				if (isNestedIn(el, MD_SEL)) return;
				const t = textOf(el);
				if (t) blocks.push(t);
			});
			if (blocks.length > 0) return blocks.join("\n\n");
			// 退化：整段可见文本（剔除思维链、过程表头、操作行、按钮）
			const clone = root.cloneNode(true);
			clone.querySelectorAll([
				THINK_SEL,
				THINK_MD_SEL,
				PROCESS_HEADER_SEL,
				"[class*='actions']",
				"[data-clock]",
				"button",
				"svg"
			].join(", ")).forEach((n) => n.remove());
			return textOf(clone);
		}

		/** 收集消息图片：只认消息画廊与 markdown 内的图片 */
		function collectImages(root) {
			const out = [];
			if (!root || typeof root.querySelectorAll !== "function") return out;
			const seen = new Set();
			root.querySelectorAll(IMG_SEL).forEach((img) => {
				const url = img.currentSrc || img.getAttribute("src") || "";
				if (!url || url.startsWith("data:image/svg")) return;
				if (!/^(https?:|blob:|file:|dsh:)/i.test(url) && !url.startsWith("data:image/")) return;
				if (seen.has(url)) return;
				seen.add(url);
				out.push({ url, name: img.getAttribute("alt") || "" });
			});
			return out;
		}

		/**
		 * 这一行是不是「思考链」而不是正文？
		 *
		 * DSH 把 assistant-step 拆成两种分组（ChatNodeSeat 的 groupPart）：
		 *   - groupPart="reasoning"：只含 reasoning 块的行（折叠态被 hidden 掉）
		 *   - groupPart="response" ：含 text 块的正式回答行
		 * 另外折叠/隐藏的行会被打上 hidden 属性，而 innerText 对 hidden 子树返回空串，
		 * 于是 textOf 的 textContent 兜底会把折叠中的思考链正文重新捞回来——这正是
		 * 「转发了思考链」的直接原因。所以这里按属性判定，不依赖构建期哈希类名。
		 */
		function isReasoningRow(row) {
			if (!row || !row.getAttribute) return false;
			if (row.getAttribute("data-chat-group-part") === "reasoning") return true;
			if (row.hasAttribute("hidden")) return true;
			if (row.getAttribute("data-turn-process-hidden") !== null) return true;
			return false;
		}

		/**
		 * 助手回合：收集锚点之前、同一 turn 的流式行。
		 *
		 * DSH 的真实结构是两层：
		 *   div.icaHSq_flowItem[data-chat-flow-kind][data-chat-turn]   <-- 行（真正的兄弟节点）
		 *     └─ div.TurnTailNodeView_root[data-turn-tail]           <-- 收尾行的内层（按钮就在这里）
		 * 所以必须先回到行层级再向前找，而不能从 [data-turn-tail] 直接看 previousElementSibling（那只会得到收尾行自己的内容）。
		 */
		function assistantTurnNodes(anchor) {
			const nodes = [];
			if (!anchor || typeof document === "undefined") return nodes;
			const anchorRow = anchor.closest("[data-chat-flow-kind], [data-chat-flow-key]") || anchor;
			const turn = anchorRow.getAttribute("data-chat-turn") || anchor.getAttribute("data-chat-turn");
			const scope = (anchorRow.closest && anchorRow.closest("[data-conversation-scroll]")) || document;
			const before = [];
			Array.prototype.forEach.call(scope.querySelectorAll("[data-chat-flow-kind]"), (row) => {
				if (row === anchorRow) return;
				if (anchorRow.compareDocumentPosition) {
					const pos = anchorRow.compareDocumentPosition(row);
					if (!(pos & 2)) return; // DOCUMENT_POSITION_PRECEDING：只留锚点之前的行
				}
				before.push(row);
			});
			// 起点：锚点之前最后一条用户消息 / 回合触发行
			let start = -1;
			before.forEach((row, index) => {
				const kind = row.getAttribute("data-chat-flow-kind");
				if (kind === "user" || kind === "steering" || kind === "turn-trigger") start = index;
			});
			for (let i = start + 1; i < before.length; i += 1) {
				const row = before[i];
				const kind = row.getAttribute("data-chat-flow-kind");
				if (kind === "turn-tail" || kind === "turn-trigger" || kind === "user" || kind === "steering") continue;
				// 思考链行（折叠态）与过程分组内被隐藏的行一律不进候选，
				// 否则 textOf 的 textContent 兜底会把折叠中的思考链正文捞回来。
				if (isReasoningRow(row)) continue;
				const t = row.getAttribute("data-chat-turn");
				if (turn !== null && t !== null && t !== turn) continue;
				nodes.push(row);
			}
			return nodes;
		}

		function extractAssistantFromAnchor(anchor) {
			const result = { text: "", images: [] };
			if (!anchor) return result;
			const nodes = assistantTurnNodes(anchor);
			const texts = [];
			const seenText = new Set();
			const seenImg = new Set();
			const pushImages = (node) => {
				collectImages(node).forEach((im) => {
					if (seenImg.has(im.url)) return;
					seenImg.add(im.url);
					result.images.push(im);
				});
			};
			const pushText = (node) => {
				const t = collectText(node);
				if (!t || seenText.has(t)) return;
				seenText.add(t);
				texts.push(t);
			};
			// 正文只取 assistant-step（唯一渲染回答 markdown 的行），
			// 避免把 turn-process 组的标题（“已思考 N 秒”等）当成正文。
			// assistantTurnNodes 已剔除 reasoning 分组行，所以这里剩下的 assistant-step
			// 就是 groupPart="response" 的正式回答行，与 DSH 官方 copy 的取文范围一致。
			// 图片与正文不同，可能落在 turn-process 行里，所以按行收集。
			nodes.forEach((node) => {
				if (node.getAttribute("data-chat-flow-kind") === "assistant-step") pushText(node);
				pushImages(node);
			});
			if (texts.length === 0) nodes.forEach(pushText);
			result.text = texts.join("\n\n").trim();
			return result;
		}

		function lastAssistantAnchor() {
			if (typeof document === "undefined") return null;
			const tails = document.querySelectorAll("[data-turn-tail]");
			return tails.length > 0 ? tails[tails.length - 1] : null;
		}

		/** 文档中最后一条有内容的模型回复（表头按钮 / slash 命令用） */
		function extractLastAssistantTurn() {
			if (typeof document === "undefined") return { text: "", images: [] };
			const tails = Array.from(document.querySelectorAll("[data-turn-tail]"));
			for (let i = tails.length - 1; i >= 0; i -= 1) {
				const data = extractAssistantFromAnchor(tails[i]);
				if (data.text || data.images.length > 0) return data;
			}
			return { text: "", images: [] };
		}

		function resolveUserContainer(actionsRow) {
			if (!actionsRow) return null;
			const candidates = [];
			if (actionsRow.closest) candidates.push(actionsRow.closest("[class*='userRow']"));
			if (actionsRow.parentElement && actionsRow.parentElement.closest) {
				candidates.push(actionsRow.parentElement.closest("[class*='userRow']"));
			}
			for (const c of candidates) {
				if (c && c.querySelector("[class*='bubble']")) return c;
			}
			if (candidates[0]) return candidates[0];
			return actionsRow.parentElement || null;
		}

		function extractUserFromContainer(actionsRow) {
			const root = resolveUserContainer(actionsRow);
			const result = { text: "", images: [] };
			if (!root) return result;
			const bubble = root.querySelector("[class*='bubble']");
			result.text = textOf(bubble);
			if (!result.text) result.text = collectText(root);
			result.images = collectImages(root);
			return result;
		}

		// ---------------------------------------------------------------- 会话业务
		function sessionsService() {
			try { return ctxRef && ctxRef.sessions ? ctxRef.sessions : null; } catch { return null; }
		}

		function sessionRows() {
			const sessions = sessionsService();
			try {
				const snapshot = sessions.list.getSnapshot();
				const byId = snapshot && snapshot.byId ? snapshot.byId : {};
				const archived = new Set();
				try {
					const ws = ctxRef.workspaces.list.getSnapshot();
					(ws && ws.archivedSessionIds ? ws.archivedSessionIds : []).forEach((id) => archived.add(id));
				} catch { /* workspaces 可选 */ }
				return Object.values(byId)
					.filter((row) => row && row.id && !archived.has(row.id))
					.map((row) => ({
						id: row.id,
						title: row.displayTitle || row.title || t("session.untitled"),
						updatedAt: row.updatedAt || 0,
						running: !!row.running,
						blank: !!row.blank,
						cwd: row.cwd || ""
					}))
					.sort((a, b) => b.updatedAt - a.updatedAt);
			} catch (err) {
				console.warn("[dsh-forward] 读取会话列表失败", err);
				return [];
			}
		}

		function sessionTitle(sessionId) {
			if (!sessionId) return "";
			try {
				const row = ctxRef.sessions.list.getSnapshot().byId[sessionId];
				return (row && (row.displayTitle || row.title)) || "";
			} catch { return ""; }
		}

		function sessionCwd(sessionId) {
			if (!sessionId) return "";
			try {
				const row = ctxRef.sessions.list.getSnapshot().byId[sessionId];
				return (row && row.cwd) || "";
			} catch { return ""; }
		}

		/** 图片 URL → prompt 图片线（base64），失败返回 null */
		function imageToPromptItem(url, name) {
			return new Promise((resolve) => {
				if (!url || typeof fetch === "undefined" || typeof FileReader === "undefined") return resolve(null);
				fetch(url).then((res) => res.blob()).then((blob) => {
					const blobType = String(blob.type || "").toLowerCase();
					const mediaType = blobType === "image/jpg" ? "image/jpeg" : blobType;
					if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType)) {
						console.warn("[dsh-forward] 跳过不支持的图片类型:", mediaType || "(unknown)");
						return resolve(null);
					}
					const reader = new FileReader();
					reader.onload = () => {
						const dataUrl = String(reader.result || "");
						const comma = dataUrl.indexOf(",");
						if (comma < 0) return resolve(null);
						const item = { type: "image", mediaType, data: dataUrl.slice(comma + 1) };
						if (name) item.name = name;
						resolve(item);
					};
					reader.onerror = () => resolve(null);
					reader.readAsDataURL(blob);
				}).catch((err) => {
					console.warn("[dsh-forward] 读取图片失败", err);
					resolve(null);
				});
			});
		}

		/** 图片 URL → File（草稿附件用） */
		async function urlToFile(url, name) {
			if (!url || typeof fetch === "undefined" || typeof File === "undefined") return null;
			try {
				const res = await fetch(url);
				const blob = await res.blob();
				const type = blob.type || "image/png";
				const ext = (type.split("/")[1] || "png").replace("jpeg", "jpg");
				const fileName = name || ("forwarded-" + Date.now() + "." + ext);
				return new File([blob], fileName, { type });
			} catch (err) {
				console.warn("[dsh-forward] 构造附件失败", err);
				return null;
			}
		}

		async function buildPromptContent(text, images) {
			const items = [];
			const skipped = [];
			for (const img of images || []) {
				const item = await imageToPromptItem(img.url, img.name);
				if (item) items.push(item); else skipped.push(img);
			}
			const body = String(text || "").trim();
			if (body) items.push({ type: "text", text: body });
			return { items, skipped };
		}

		async function createTargetSession() {
			const sessions = sessionsService();
			if (!sessions || typeof sessions.create !== "function") throw new Error(t("error.sessionsUnavailable"));
			const sourceId = forwardStore.state.payload && forwardStore.state.payload.sourceSessionId;
			const cwd = sessionCwd(sourceId);
			const id = await sessions.create(cwd ? { cwd } : {});
			if (!id || typeof id !== "string") throw new Error(t("error.createSessionFailed"));
			return id;
		}

		/** 真正把内容投递到目标会话（此处是之前所有「发送」失败的根因修复点） */
		async function deliverToSession(targetId, content) {
			const sessions = sessionsService();
			if (!sessions || typeof sessions.using !== "function") throw new Error(t("error.sessionsUnavailable"));
			await sessions.using(targetId, { source: "dsh-message-forward" }, async (reference) => {
				const session = reference && reference.binding && reference.binding.session;
				if (!session || typeof session.prompt !== "function") throw new Error(t("error.noSessionHandle"));
				const result = await session.prompt(content, "queue");
				if (result && result.ok === false) {
					const err = result.error || {};
					throw new Error(err.message || err.code || t("error.sendRejected"));
				}
			});
		}

		function jumpToSession(targetId) {
			try { ctxRef.uiWorkspace.openSession(targetId); } catch (err) { console.warn("[dsh-forward] 跳转会话失败", err); }
		}

		// ---------------------------------------------------------------- 长按 2 秒
		function createProgressRing(parentEl, duration) {
			const wrap = document.createElement("div");
			wrap.className = "dsh-mf-ring-wrap";
			wrap.style.setProperty("--dsh-mf-ring-duration", String(duration) + "ms");
			const svgNS = "http://www.w3.org/2000/svg";
			const svg = document.createElementNS(svgNS, "svg");
			svg.setAttribute("class", "dsh-mf-ring-svg");
			svg.setAttribute("viewBox", "0 0 34 34");
			const bg = document.createElementNS(svgNS, "circle");
			bg.setAttribute("class", "dsh-mf-ring-bg");
			bg.setAttribute("cx", "17");
			bg.setAttribute("cy", "17");
			bg.setAttribute("r", "14");
			const bar = document.createElementNS(svgNS, "circle");
			bar.setAttribute("class", "dsh-mf-ring-bar");
			bar.setAttribute("cx", "17");
			bar.setAttribute("cy", "17");
			bar.setAttribute("r", "14");
			svg.appendChild(bg);
			svg.appendChild(bar);
			const tip = document.createElement("div");
			tip.className = "dsh-mf-ring-tip";
			tip.textContent = t("hint.longPress");
			wrap.appendChild(svg);
			wrap.appendChild(tip);
			parentEl.appendChild(wrap);
			return wrap;
		}

		function bindLongPress(el, options) {
			const duration = options.duration || 2000;
			let timer = null;
			let ring = null;
			let pressing = false;
			let fired = false;
			let startX = 0;
			let startY = 0;

			const clear = () => {
				if (timer) { clearTimeout(timer); timer = null; }
				if (ring) { ring.remove(); ring = null; }
				pressing = false;
			};
			const pointOf = (e) => {
				if (e.touches && e.touches.length > 0) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
				return { x: e.clientX || 0, y: e.clientY || 0 };
			};
			const onStart = (e) => {
				if (e.type === "mousedown" && e.button !== 0) return;
				pressing = true;
				fired = false;
				const p = pointOf(e);
				startX = p.x;
				startY = p.y;
				if (typeof document !== "undefined") ring = createProgressRing(el, duration);
				timer = setTimeout(() => {
					fired = true;
					clear();
					try { options.onLongPress && options.onLongPress(e); }
					catch (err) { console.error("[dsh-forward] long press handler", err); }
				}, duration);
			};
			const onEnd = (e) => {
				if (!pressing) return;
				const wasFired = fired;
				clear();
				if (e.cancelable) e.preventDefault();
				if (e.stopPropagation) e.stopPropagation();
				if (!wasFired) {
					try { options.onSingleClick && options.onSingleClick(e); }
					catch (err) { console.error("[dsh-forward] click handler", err); }
				}
			};
			const onCancel = () => { clear(); };
			const onMove = (e) => {
				if (!pressing) return;
				const p = pointOf(e);
				if (Math.abs(p.x - startX) > 12 || Math.abs(p.y - startY) > 12) clear();
			};
			const onClick = (e) => { e.preventDefault(); e.stopPropagation(); };
			const onContext = (e) => {
				e.preventDefault();
				clear();
				try { options.onLongPress && options.onLongPress(e); }
				catch (err) { console.error("[dsh-forward] long press handler", err); }
			};
			const onKey = (e) => {
				if (e.key !== "Enter" && e.key !== " ") return;
				e.preventDefault();
				try { options.onSingleClick && options.onSingleClick(e); }
				catch (err) { console.error("[dsh-forward] click handler", err); }
			};

			el.addEventListener("mousedown", onStart);
			el.addEventListener("mouseup", onEnd);
			el.addEventListener("mouseleave", onCancel);
			el.addEventListener("mousemove", onMove);
			el.addEventListener("touchstart", onStart, { passive: true });
			el.addEventListener("touchend", onEnd);
			el.addEventListener("touchcancel", onCancel);
			el.addEventListener("click", onClick);
			el.addEventListener("contextmenu", onContext);
			el.addEventListener("keydown", onKey);

			return () => {
				clear();
				el.removeEventListener("mousedown", onStart);
				el.removeEventListener("mouseup", onEnd);
				el.removeEventListener("mouseleave", onCancel);
				el.removeEventListener("mousemove", onMove);
				el.removeEventListener("touchstart", onStart);
				el.removeEventListener("touchend", onEnd);
				el.removeEventListener("touchcancel", onCancel);
				el.removeEventListener("click", onClick);
				el.removeEventListener("contextmenu", onContext);
				el.removeEventListener("keydown", onKey);
			};
		}

		// ---------------------------------------------------------------- 批量多选：消息单元
		/** 快捷选择面板里每条消息的摘要上限（仅用于显示，不影响实际转发内容） */
		const PICK_TEXT_MAX = 150;

		/** 压成单行摘要；超长截断并加省略号 */
		function toSnippet(text, max) {
			const limit = max || PICK_TEXT_MAX;
			const flat = String(text || "").replace(/\s+/g, " ").trim();
			if (flat.length <= limit) return flat;
			return flat.slice(0, limit) + "…";
		}

		/** 摘要缓存：getSnapshot() 会跑完整的提取逻辑，不能每次渲染都算。
		 *  按单元 id 缓存，进入多选时清空（退出后内容才可能变）。 */
		const snippetCache = new Map();

		function unitSnippet(unit) {
			if (!unit) return "";
			const cached = snippetCache.get(unit.id);
			if (cached !== undefined) return cached;
			let text = "";
			try {
				const snap = unit.getSnapshot();
				text = snap && snap.text ? snap.text : "";
			} catch { text = ""; }
			const snippet = toSnippet(text);
			snippetCache.set(unit.id, snippet);
			return snippet;
		}

		function collectUnits() {
			if (typeof document === "undefined") return [];
			const units = [];
			const seen = new Set();

			document.querySelectorAll("[class*='userRow']").forEach((row) => {
				const flow = row.closest("[data-chat-flow-key]") || (row.parentElement && row.parentElement.closest("[data-chat-flow-key]"));
				const id = "u:" + ((flow && flow.getAttribute("data-chat-flow-key")) || row.getAttribute("data-chat-turn") || String(units.length));
				if (seen.has(id)) return;
				seen.add(id);
				units.push({
					id,
					role: "user",
					element: row,
					getSnapshot: () => {
						const bubble = row.querySelector("[class*='bubble']");
						let text = textOf(bubble);
						if (!text) text = collectText(row);
						return { role: "user", text: text.trim(), images: collectImages(row) };
					}
				});
			});

			document.querySelectorAll("[data-turn-tail]").forEach((tail) => {
				const id = "a:" + (tail.getAttribute("data-turn-tail") || String(units.length));
				if (seen.has(id)) return;
				seen.add(id);
				units.push({
					id,
					role: "assistant",
					element: tail,
					getSnapshot: () => {
						const data = extractAssistantFromAnchor(tail);
						return { role: "assistant", text: data.text, images: data.images };
					}
				});
			});

			units.sort((a, b) => {
				if (a.element !== b.element && typeof Node !== "undefined") {
					const pos = a.element.compareDocumentPosition(b.element);
					if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
					if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
				}
				return 0;
			});
			return units;
		}

		/** 由任意节点（按钮 / 操作行）定位到 collectUnits 里的同一个单元 id */
		function unitIdForNode(node) {
			if (!node || !node.closest || typeof document === "undefined") return null;
			let host = node.closest("[data-turn-tail]");
			if (!host) {
				host = node.closest("[class*='userRow']");
				if (!host && node.getAttribute && node.getAttribute("data-clock") === "start") {
					host = resolveUserContainer(node);
				}
			}
			if (!host) return null;
			const found = collectUnits().find((u) => u.element === host || (u.element.contains && u.element.contains(host)));
			return found ? found.id : null;
		}

		/** 已选单元的完整内容快照 + 会话顺序。
		 *  聊天列表是虚拟列表：滚出渲染窗口的行会被卸载，collectUnits() 之后就看不到它们了。
		 *  若合并只看「当下 DOM 里还渲染着的」单元，就会出现「已选 N 条、实际只合并了眼前几条」的静默丢块，
		 *  所以选中那一刻就把内容与顺序抓下来，DOM 卸载不影响合并。
		 *  生命周期与 snippetCache 一致：进入 / 退出多选时清空，并按选中集合增删，不会无界增长。 */
		const unitSnapshots = new Map();
		let selectionOrder = [];

		function resetSelectionCache() {
			unitSnapshots.clear();
			selectionOrder = [];
		}

		/** 把单元登记进「会话顺序」序列：新单元插到它前面最近的已知单元之后。
		 *  相邻渲染窗口有重叠，滚出视口的单元通常仍能找到锚点，合并顺序因此保持原样；
		 *  实在没有锚点就追加到末尾（顺序退化，但内容不丢）。 */
		function noteSelection(id, units) {
			if (!id || selectionOrder.indexOf(id) >= 0) return;
			const live = units || collectUnits();
			const pos = live.findIndex((u) => u.id === id);
			if (pos < 0) { selectionOrder.push(id); return; }
			for (let i = pos - 1; i >= 0; i -= 1) {
				const at = selectionOrder.indexOf(live[i].id);
				if (at >= 0) { selectionOrder.splice(at + 1, 0, id); return; }
			}
			for (let i = pos + 1; i < live.length; i += 1) {
				const at = selectionOrder.indexOf(live[i].id);
				if (at >= 0) { selectionOrder.splice(at, 0, id); return; }
			}
			selectionOrder.push(id);
		}

		/** 抓取单元的完整快照（勾选 / 全选 / 长按种子都汇聚到这里） */
		function captureUnitSnapshot(unit, units) {
			if (!unit || !unit.id) return false;
			noteSelection(unit.id, units);
			if (unitSnapshots.has(unit.id)) return true;
			try {
				const snap = (typeof unit.getSnapshot === "function" ? unit.getSnapshot() : null) || {};
				unitSnapshots.set(unit.id, {
					role: snap.role || unit.role || "assistant",
					text: snap.text || "",
					images: Array.isArray(snap.images) ? snap.images.slice() : []
				});
				return true;
			} catch (err) {
				console.warn("[dsh-forward] 单元快照失败（该单元退回实时提取）", err);
				return false;
			}
		}

		/** 按 id 现抓一次：id 来自 DOM 装饰，此刻该单元一定还在渲染窗口里 */
		function captureUnitById(id) {
			const units = collectUnits();
			const unit = units.find((u) => u.id === id);
			return unit ? captureUnitSnapshot(unit, units) : false;
		}

		/** 选中集合的唯一写入口：勾选时立刻抓完整快照，取消时连同顺序一起丢弃。 */
		function toggleSelectedUnit(id) {
			if (!id) return;
			const next = new Set(batchStore.state.selectedIds);
			if (next.has(id)) {
				next.delete(id);
				unitSnapshots.delete(id);
				selectionOrder = selectionOrder.filter((x) => x !== id);
			} else {
				next.add(id);
				captureUnitById(id);
			}
			batchStore.set({ selectedIds: next });
		}

		/** 整体替换选择（全选当前窗口 / 清空 / 长按种子）：先清缓存，再按给定顺序抓快照。 */
		function replaceSelection(units) {
			resetSelectionCache();
			const next = new Set();
			(units || []).forEach((u) => {
				if (!u || !u.id) return;
				next.add(u.id);
				captureUnitSnapshot(u, units);
			});
			batchStore.set({ selectedIds: next });
		}

		/** 补抓：窗口内已选、却还没有快照的单元（覆盖「先选中、缓存随后被清」这类时序）。 */
		function captureMissingSelected(units) {
			const selectedIds = batchStore.state.selectedIds;
			if (!selectedIds || selectedIds.size === 0) return;
			(units || []).forEach((u) => {
				if (selectedIds.has(u.id) && !unitSnapshots.has(u.id)) captureUnitSnapshot(u, units);
			});
		}

		/** 快照优先（DOM 卸载也算数），拿不到快照的退回实时提取；两者都没有才返回 null。 */
		function snapshotForUnit(id, unit) {
			const cached = unitSnapshots.get(id);
			if (cached) return cached;
			if (!unit || typeof unit.getSnapshot !== "function") return null;
			try {
				const snap = unit.getSnapshot() || {};
				return { role: snap.role || unit.role || "assistant", text: snap.text || "", images: snap.images || [] };
			} catch (err) {
				console.warn("[dsh-forward] 实时提取失败", err);
				return null;
			}
		}

		/** 合并选中单元：快照优先，DOM 卸载后仍能贡献完整内容；实时提取只是缺快照时的退路。
		 *  返回的 missing 是「已选、却既无快照也无实时内容」的条数，由调用方给出可见提示，绝不静默丢块。 */
		function mergeUnits(units, selectedIds) {
			const live = new Map((units || []).map((u) => [u.id, u]));
			const ordered = [];
			const seen = new Set();
			selectionOrder.forEach((id) => { if (selectedIds.has(id) && !seen.has(id)) { seen.add(id); ordered.push(id); } });
			(units || []).forEach((u) => { if (selectedIds.has(u.id) && !seen.has(u.id)) { seen.add(u.id); ordered.push(u.id); } });
			selectedIds.forEach((id) => { if (!seen.has(id)) { seen.add(id); ordered.push(id); } });

			const parts = [];
			const images = [];
			const seenImg = new Set();
			let count = 0;
			let missing = 0;
			ordered.forEach((id) => {
				const snap = snapshotForUnit(id, live.get(id));
				if (!snap) { missing += 1; return; }
				count += 1;
				const tag = snap.role === "user" ? t("role.user") : t("role.model");
				parts.push(t("marker.block", { index: count, tag }) + "\n" + (snap.text || t("bar.noText")));
				(snap.images || []).forEach((im) => {
					if (!im || seenImg.has(im.url)) return;
					seenImg.add(im.url);
					images.push(im);
				});
			});
			return { text: parts.join("\n\n---\n\n"), images, count, missing };
		}

		// ---------------------------------------------------------------- 批量工具条
		function BatchToolbar() {
			const [state, setState] = useState(batchStore.state);
			useEffect(() => batchStore.subscribe(setState), []);
			const unitsRef = useRef([]);
			const [, forceTick] = useState(0);
			const pickerOpen = !!state.pickerOpen;

			useEffect(() => {
				// 退出多选：摘要与快照缓存一起作废，不留跨轮次的陈旧内容
				if (!state.isActive) { resetSelectionCache(); return undefined; }
				// 进入多选时清空摘要 / 快照缓存：消息内容可能在上次退出后变过
				snippetCache.clear();
				resetSelectionCache();
				const refresh = () => {
					const next = collectUnits();
					// 已选但缺快照的（长按种子等）在这里补齐，之后滚出窗口也能整块合并
					captureMissingSelected(next);
					const nextIds = next.map((u) => u.id).join("|");
					const prevIds = unitsRef.current.map((u) => u.id).join("|");
					unitsRef.current = next;
					if (nextIds !== prevIds) forceTick((n) => n + 1);
				};
				refresh();
				const timer = setInterval(refresh, 500);
				return () => clearInterval(timer);
			}, [state.isActive]);

			useEffect(() => {
				if (!state.isActive) return undefined;
				const onKey = (e) => {
					if (e.key !== "Escape") return;
					// Esc 先收面板，再退出多选：避免一次按键直接丢掉整轮选择
					if (batchStore.state.pickerOpen) batchStore.set({ pickerOpen: false });
					else batchStore.set({ isActive: false, selectedIds: new Set(), pickerOpen: false });
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [state.isActive]);

			if (!state.isActive) return null;

			const units = unitsRef.current;
			const selected = state.selectedIds.size;

			const handleMerge = () => {
				const merged = mergeUnits(units, state.selectedIds);
				if (merged.count === 0) { notify(t("notify.pickFirst"), false); return; }
				// 有选中项既无快照也不在渲染窗口里：先如实告知，再按实际拿到的块数转发
				if (merged.missing > 0) notify(t("notify.mergeIncomplete", { selected: state.selectedIds.size, missing: merged.missing, count: merged.count }), false);
				const sessionId = state.sessionId || (forwardStore.state.payload && forwardStore.state.payload.sourceSessionId) || "";
				batchStore.set({ isActive: false, selectedIds: new Set(), sessionId: null, pickerOpen: false });
				openForwardModal({
					role: "batch",
					itemCount: merged.count,
					text: merged.text,
					images: merged.images,
					sourceSessionId: sessionId,
					sourceTitle: sessionTitle(sessionId)
				});
			};

			// 快捷选择面板：把已加载的消息按顺序列出来，带角色徽章 + 摘要，
			// 不必滚动到消息本身就能勾选（长回答/长会话的关键）。
			const picker = pickerOpen && h("div", { className: "dsh-mf-picker" },
				h("div", { className: "dsh-mf-picker-head" },
					h("span", { className: "dsh-mf-picker-title" }, t("bar.quickSelect")),
					h("span", { className: "dsh-mf-hint" },
						t("bar.pickerMeta", { total: units.length, max: PICK_TEXT_MAX })),
					h("button", {
						type: "button",
						className: "dsh-mf-picker-close",
						title: t("bar.collapse"),
						onClick: () => batchStore.set({ pickerOpen: false })
					}, "×")
				),
				units.length === 0
					? h("div", { className: "dsh-mf-empty" }, t("bar.empty"))
					: h("div", { className: "dsh-mf-picker-list" },
						units.map((u, i) => {
							const isUser = u.role === "user";
							const isSel = state.selectedIds.has(u.id);
							const snippet = unitSnippet(u) || t("bar.noText");
							return h("button", {
								key: u.id,
								type: "button",
								className: "dsh-mf-pick-item" + (isSel ? " selected" : ""),
								title: isSel ? t("action.unselectMessageClick") : t("action.selectMessageClick"),
								onClick: () => toggleSelectedUnit(u.id)
							},
								h("span", { className: "dsh-mf-pick-badge " + (isUser ? "dsh-mf-pick-badge-user" : "dsh-mf-pick-badge-model") },
									isUser ? t("role.user") : t("role.model")),
								h("span", { className: "dsh-mf-pick-index" }, "#" + (i + 1)),
								h("span", { className: "dsh-mf-pick-text" }, snippet),
								h("span", { className: "dsh-mf-pick-mark" }, isSel ? "✓" : "")
							);
						})
					)
			);

			return h("div", { className: "dsh-mf-bar" },
				picker,
				h("button", {
					type: "button",
					className: "dsh-mf-bar-count-btn" + (pickerOpen ? " open" : ""),
					title: pickerOpen ? t("bar.pickerCollapse") : t("bar.pickerExpand"),
					onClick: () => batchStore.set({ pickerOpen: !batchStore.state.pickerOpen })
				},
					h("span", { className: "dsh-mf-bar-count" }, t("bar.selected", { selected, total: units.length })),
					h("span", { className: "dsh-mf-bar-caret" }, pickerOpen ? "▲" : "▼")
				),
				h("button", { type: "button", className: "dsh-mf-bar-btn", onClick: () => replaceSelection(units) }, t("bar.selectAll")),
				h("button", { type: "button", className: "dsh-mf-bar-btn", onClick: () => replaceSelection([]) }, t("bar.clear")),
				h("button", { type: "button", className: "dsh-mf-bar-btn", onClick: () => batchStore.set({ isActive: false, selectedIds: new Set(), pickerOpen: false }) }, t("bar.exit")),
				h("button", {
					type: "button",
					className: "dsh-mf-bar-btn dsh-mf-primary",
					disabled: selected === 0,
					onClick: handleMerge
				}, t("bar.merge"))
			);
		}

		/** 底部多选条挂到 body，避免被聊天区祖先的 transform/filter/backdrop-filter 困住。 */
		function BatchToolbarPortal() {
			const node = h(BatchToolbar);
			return portalToBody(node);
		}

		// ---------------------------------------------------------------- 转发弹窗
		function ForwardModal() {
			const [state, setState] = useState(forwardStore.state);
			useEffect(() => forwardStore.subscribe(setState), []);
			const { isOpen, payload, toast } = state;

			const [search, setSearch] = useState("");
			const [targetId, setTargetId] = useState("__NEW_SESSION__");
			const [editedText, setEditedText] = useState("");
			const [includeSource, setIncludeSource] = useState(false);
			const [submitting, setSubmitting] = useState(false);
			const [rows, setRows] = useState([]);

			useEffect(() => {
				if (!isOpen || !payload) return;
				setEditedText(payload.text || "");
				setIncludeSource(false);
				setSearch("");
				setTargetId("__NEW_SESSION__");
				setSubmitting(false);
			}, [isOpen, payload]);

			useEffect(() => {
				if (!isOpen) return;
				setRows(sessionRows());
				const timer = setInterval(() => setRows(sessionRows()), 3000);
				return () => clearInterval(timer);
			}, [isOpen]);

			const filtered = useMemo(() => {
				const q = search.trim().toLowerCase();
				if (!q) return rows;
				return rows.filter((row) => (row.title + " " + row.cwd).toLowerCase().includes(q));
			}, [rows, search]);

			const handleClose = useCallback(() => {
				if (submitting) return;
				closeForwardModal();
			}, [submitting]);

			const applyTemplate = useCallback((kind) => {
				if (kind === "reference") {
					setEditedText(t("marker.reference") + "\n\n" + (payload ? payload.text || "" : ""));
				} else if (kind === "task") {
					setEditedText(t("marker.task") + "\n\n" + (payload ? payload.text || "" : ""));
				} else {
					setEditedText(payload ? payload.text || "" : "");
				}
			}, [payload]);

			const handleExecute = useCallback(async (actionType) => {
				if (!payload || submitting) return;
				setSubmitting(true);
				try {
					let finalTarget = targetId;
					let targetTitle = t("session.newCreated");
					if (finalTarget === "__NEW_SESSION__") {
						finalTarget = await createTargetSession();
					} else {
						targetTitle = sessionTitle(finalTarget) || t("session.target");
					}

					let text = editedText.trim();
					const roleLabel = payload.role === "user" ? t("modal.roleUser") : payload.role === "batch" ? t("modal.roleBatchSource") : t("modal.roleAssistant");
					const sourceLabel = payload.sourceTitle || sessionTitle(payload.sourceSessionId) || t("session.unknown");
					if (includeSource) text = t("marker.source", { source: sourceLabel, role: roleLabel }) + "\n\n" + text;

					if (!text && (!payload.images || payload.images.length === 0)) {
						notify(t("notify.noContent"), false);
						setSubmitting(false);
						return;
					}

					if (actionType === "draft") {
						const files = [];
						for (const img of payload.images || []) {
							const file = await urlToFile(img.url, img.name);
							if (file) files.push(file);
						}
						// 投递先挂上等待，再跳转（跳转会促使目标 overlay 挂载并 ack），
						// 成功提示只在目标真的执行过 setDraft 之后才发。
						const deliver = draftHub.request(finalTarget, text, files);
						jumpToSession(finalTarget);
						closeForwardModal();
						const outcome = await deliver;
						if (outcome === "applied") notify(t("notify.draftFilled", { title: targetTitle }), true);
						else if (outcome !== "cancelled") notify(t("notify.draftNotFilled", { title: targetTitle }), false);
						return;
					}

					const built = await buildPromptContent(text, payload.images);
					if (built.items.length === 0) {
						notify(t("notify.noContentImages"), false);
						setSubmitting(false);
						return;
					}
					await deliverToSession(finalTarget, built.items);
					if (actionType === "send-and-jump") jumpToSession(finalTarget);
					closeForwardModal();
					const skippedNote = built.skipped.length > 0 ? t("notify.skippedImages", { count: built.skipped.length }) : "";
					notify(t("notify.forwarded", { title: targetTitle, skipped: skippedNote }), true);
				} catch (err) {
					console.error("[dsh-forward] 转发失败", err);
					notify(t("notify.failed", { message: (err && err.message) || String(err) }), false);
				} finally {
					setSubmitting(false);
				}
			}, [payload, targetId, editedText, includeSource, submitting]);

			const toastNode = toast && h(MfToast, {
				key: toast.id,
				text: toast.text,
				tone: toast.ok ? "success" : undefined,
				icon: toast.ok ? undefined : h(WarnIcon, { size: 16 }),
				holdMs: 3400,
				onDone: () => forwardStore.set({ toast: null })
			});

			if (!isOpen || !payload) {
				return h(React.Fragment, null, h(BatchToolbarPortal), toastNode);
			}

			const images = payload.images || [];
			const badgeClass = payload.role === "user" ? "dsh-mf-badge dsh-mf-badge-user" : payload.role === "batch" ? "dsh-mf-badge dsh-mf-badge-batch" : "dsh-mf-badge";
			const badgeText = payload.role === "user" ? t("modal.roleUser") : payload.role === "batch" ? t("modal.roleBatch", { count: payload.itemCount || 0 }) : t("modal.roleAssistant");

			const body = h("div", { className: "dsh-mf-modal-body" },
				h("div", { className: "dsh-mf-card" },
					h("div", { className: "dsh-mf-row-between" },
						h("div", { className: "dsh-mf-row" },
							h("span", { className: badgeClass }, badgeText),
							h("span", { className: "dsh-mf-hint" }, t("modal.from", { title: payload.sourceTitle || t("session.current") })),
							images.length > 0 && h("span", { className: "dsh-mf-hint" }, t("modal.imageCount", { count: images.length }))
						),
						h("button", {
							type: "button",
							className: "dsh-mf-chip",
							onClick: () => {
								const sessionId = payload.sourceSessionId || "";
								closeForwardModal();
								batchStore.set({ isActive: true, selectedIds: new Set(), sessionId, pickerOpen: false });
								notify(t("notify.multiSelect"), true);
							}
						}, t("modal.toBatch"))
					),
					h("div", { className: "dsh-mf-row" },
						h("span", { className: "dsh-mf-hint" }, t("modal.quickProcess")),
						h("button", { type: "button", className: "dsh-mf-chip", onClick: () => applyTemplate("reference") }, t("modal.asReference")),
						h("button", { type: "button", className: "dsh-mf-chip", onClick: () => applyTemplate("task") }, t("modal.asTask")),
						h("button", { type: "button", className: "dsh-mf-chip", onClick: () => applyTemplate("reset") }, t("modal.reset"))
					),
					h("textarea", {
						className: "dsh-mf-edit",
						value: editedText,
						placeholder: t("modal.editorPlaceholder"),
						onChange: (e) => setEditedText(e.target.value)
					}),
					images.length > 0 && h("div", { className: "dsh-mf-thumbs" },
						images.map((img, i) => h("img", { key: i, src: img.url, alt: img.name || "", className: "dsh-mf-thumb" }))
					)
				),

				payload.role !== "batch" && h("label", { className: "dsh-mf-check-line" },
					h("input", {
						type: "checkbox",
						checked: includeSource,
						onChange: (e) => setIncludeSource(e.target.checked)
					}),
					h("span", null, t("modal.includeSource"))
				),

				h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
					h("div", { className: "dsh-mf-row-between" },
						h("span", { style: { fontSize: "13px", fontWeight: 600 } }, t("modal.targetTitle")),
						h("span", { className: "dsh-mf-hint" }, t("modal.targetCount", { count: filtered.length }))
					),
					h(MfInput, {
						icon: h(SearchIcon),
						placeholder: t("modal.searchPlaceholder"),
						value: search,
						onChange: (e) => setSearch(e.target.value)
					}),
					h("div", { className: "dsh-mf-list" },
						h("div", {
							className: "dsh-mf-item" + (targetId === "__NEW_SESSION__" ? " selected" : ""),
							onClick: () => setTargetId("__NEW_SESSION__")
						},
							h("div", { className: "dsh-mf-row" }, h(PlusIcon), h("span", { className: "dsh-mf-item-title" }, t("modal.newSessionOption"))),
							targetId === "__NEW_SESSION__" && h(CheckIcon)
						),
						filtered.length === 0
							? h("div", { className: "dsh-mf-empty" }, rows.length === 0 ? t("modal.noSessions") : t("modal.noMatch"))
							: filtered.map((row) => {
								const selected = targetId === row.id;
								const timeText = row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "";
								return h("div", {
									key: row.id,
									className: "dsh-mf-item" + (selected ? " selected" : ""),
									onClick: () => setTargetId(row.id)
								},
									h("div", { style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 } },
										h("span", { className: "dsh-mf-item-title" }, row.title),
										h("div", { className: "dsh-mf-item-meta" },
											row.running && h("span", null, t("modal.running")),
											timeText && h("span", null, timeText)
										)
									),
									selected && h(CheckIcon)
								);
							})
					)
				)
			);

			const footer = h("div", { className: "dsh-mf-footer" },
				h("span", { className: "dsh-mf-hint" }, t("modal.targetHint", { title: targetId === "__NEW_SESSION__" ? t("session.new") : sessionTitle(targetId) || t("session.label") })),
				h("div", { className: "dsh-mf-row dsh-mf-footer-actions" },
					h(MfButton, { variant: "ghost", disabled: submitting, onClick: handleClose }, t("modal.cancel")),
					h(MfButton, { variant: "outline", disabled: submitting, onClick: () => handleExecute("draft") }, t("modal.fillDraft")),
					h(MfButton, { variant: "outline", disabled: submitting, onClick: () => handleExecute("send-silent") }, t("modal.sendSilent")),
					h(MfButton, { variant: "primary", disabled: submitting, onClick: () => handleExecute("send-and-jump") }, submitting ? t("modal.sending") : t("modal.sendAndJump"))
				)
			);

			return h(React.Fragment, null,
				h(BatchToolbarPortal),
				toastNode,
				h(MfModal, {
					open: true,
					title: payload.role === "batch" ? t("modal.titleBatch") : t("modal.titleForward"),
					closeLabel: t("modal.close"),
					onClose: handleClose,
					// 卡片与正文区都挂上自己的 class，让插件的自适应规则能精确命中，
					// 不必去猜 primitives 的哈希类名。
					className: "dsh-mf-dialog",
					contentClassName: "dsh-mf-content",
					footer
				}, body)
			);
		}

		// ---------------------------------------------------------------- 草稿落地（目标会话内）
		function ForwardOverlay({ inputActions, sessionId }) {
			const [revision, setRevision] = useState(0);
			const applyingRef = useRef(false);

			useEffect(() => {
				const unsubscribe = draftHub.subscribe(() => setRevision((n) => n + 1));
				return () => { unsubscribe(); };
			}, []);

			useEffect(() => {
				if (!sessionId || applyingRef.current) return;
				const pending = draftHub.take(sessionId);
				if (!pending) return;
				applyingRef.current = true;
				let cancelled = false;
				const apply = async () => {
					try {
						if (!inputActions || typeof inputActions.setDraft !== "function") {
							// 输入框还没就绪：不 ack（ack 的含义是「真的填进去了」），pending
							// 留在 draftHub 里等下一次广播 / 重挂载继续重试。
							console.warn("[dsh-forward] 目标输入框未就绪，草稿保留待重试", sessionId);
							return;
						}
						inputActions.setDraft(pending.text || "");
					} catch (err) {
						console.error("[dsh-forward] 草稿填入失败", err);
						return;
					} finally {
						applyingRef.current = false;
					}
					// 到这里 setDraft 已经真的执行过，才有资格把「已填入」ack 给投递方。
					draftHub.resolve(sessionId);
					// 附件在 ack 之后处理：正文已落地，附件失败不推翻成功提示。
					if (!pending.files || pending.files.length === 0) return;
					if (typeof inputActions.addAttachments !== "function") return;
					try {
						const scoped = ctxRef.sessions.scope(sessionId);
						const conversation = scoped && scoped.get ? scoped.get("conversation") : null;
						if (conversation && typeof conversation.createDrafts === "function") {
							const descriptors = await conversation.createDrafts(sessionId, pending.files);
							const ids = (descriptors || []).map((d) => d && d.id).filter(Boolean);
							if (ids.length > 0) inputActions.addAttachments(ids);
						}
					} catch (err) {
						console.warn("[dsh-forward] 草稿附件注入失败（已忽略）", err);
					}
				};
				// 稍微延后，避开 composer 自身「恢复持久化草稿」的挂载时机
				const timer = setTimeout(() => { if (!cancelled) apply(); }, 60);
				return () => { cancelled = true; clearTimeout(timer); applyingRef.current = false; };
			}, [sessionId, inputActions, revision]);

			return h(ForwardModal);
		}

		// ---------------------------------------------------------------- 槽组件
		function AssistantActionButton({ messageId, sessionId }) {
			const btnRef = useRef(null);

			useEffect(() => {
				const btn = btnRef.current;
				if (!btn) return undefined;
				return bindLongPress(btn, {
					duration: 2000,
					onSingleClick: () => {
						const anchor = btn.closest("[data-turn-tail]") || btn.closest("[data-chat-flow-key]");
						const data = extractAssistantFromAnchor(anchor);
						openForwardModal({
							role: "assistant",
							messageId,
							text: data.text,
							images: data.images,
							sourceSessionId: sessionId,
							sourceTitle: sessionTitle(sessionId)
						});
					},
					onLongPress: () => {
						const unitId = unitIdForNode(btn);
						batchStore.set({
							isActive: true,
							sessionId,
							selectedIds: new Set(unitId ? [unitId] : []),
							pickerOpen: false
						});
						notify(t("notify.multiSelect"), true);
					}
				});
			}, [messageId, sessionId]);

			return h(MfTooltip, { label: t("action.forwardReplyTip"), side: "bottom" },
				h("button", {
					ref: btnRef,
					type: "button",
					className: "dsh-mf-btn",
					"aria-label": t("action.forwardReply")
				}, h(ForwardIcon))
			);
		}

		function HeaderUtilityButton({ sessionId }) {
			const btnRef = useRef(null);

			useEffect(() => {
				const btn = btnRef.current;
				if (!btn) return undefined;
				return bindLongPress(btn, {
					duration: 2000,
					onSingleClick: () => {
						const data = extractLastAssistantTurn();
						const fallback = (!data.text && data.images.length === 0) ? extractAssistantFromAnchor(lastAssistantAnchor()) : data;
						openForwardModal({
							role: "assistant",
							text: fallback.text,
							images: fallback.images,
							sourceSessionId: sessionId,
							sourceTitle: sessionTitle(sessionId)
						});
					},
					onLongPress: () => {
						batchStore.set({ isActive: true, sessionId, selectedIds: new Set(), pickerOpen: false });
						notify(t("notify.multiSelect"), true);
					}
				});
			}, [sessionId]);

			return h(MfTooltip, { label: t("action.forwardOutputTip"), side: "bottom" },
				h("button", {
					ref: btnRef,
					type: "button",
					className: "dsh-mf-btn",
					"aria-label": t("action.forwardOutput")
				}, h(ForwardIcon))
			);
		}

		// ---------------------------------------------------------------- DOM 观察：用户消息按钮 + 多选装饰
		function setupUserMessageButtons() {
			if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};

			const decorate = (row) => {
				if (!row || row.getAttribute("data-clock") !== "start") return;
				if (row.querySelector(".dsh-mf-user-btn")) return;
				const btn = document.createElement("button");
				btn.type = "button";
				btn.className = "dsh-mf-btn dsh-mf-user-btn";
				btn.setAttribute("aria-label", t("action.forwardMessage"));
				btn.setAttribute("title", t("action.forwardMessageTip"));
				const svgNS = "http://www.w3.org/2000/svg";
				const svg = document.createElementNS(svgNS, "svg");
				svg.setAttribute("width", "15");
				svg.setAttribute("height", "15");
				svg.setAttribute("viewBox", "0 0 24 24");
				svg.setAttribute("fill", "none");
				svg.setAttribute("stroke", "currentColor");
				svg.setAttribute("stroke-width", "1.8");
				svg.setAttribute("stroke-linecap", "round");
				svg.setAttribute("stroke-linejoin", "round");
				const p1 = document.createElementNS(svgNS, "path");
				p1.setAttribute("d", "M13 5.2 20 12l-7 6.8");
				const p2 = document.createElementNS(svgNS, "path");
				p2.setAttribute("d", "M20 12H4");
				svg.appendChild(p1);
				svg.appendChild(p2);
				btn.appendChild(svg);

				bindLongPress(btn, {
					duration: 2000,
					onSingleClick: () => {
						const data = extractUserFromContainer(row);
						const flow = row.closest("[data-chat-flow-key]");
						let sessionId = "";
						try {
							const snapshot = ctxRef.sessions.list.getSnapshot();
							const list = Object.values(snapshot.byId || {});
							const current = list.find((r) => r.retainedBy && r.retainedBy.mainView > 0);
							sessionId = (current && current.id) || "";
						} catch { /* ignore */ }
						openForwardModal({
							role: "user",
							text: data.text,
							images: data.images,
							sourceSessionId: sessionId,
							sourceTitle: sessionTitle(sessionId)
						});
						void flow;
					},
					onLongPress: () => {
						let sessionId = "";
						try {
							const snapshot = ctxRef.sessions.list.getSnapshot();
							const list = Object.values(snapshot.byId || {});
							const current = list.find((r) => r.retainedBy && r.retainedBy.mainView > 0);
							sessionId = (current && current.id) || "";
						} catch { /* ignore */ }
						const unitId = unitIdForNode(row);
						batchStore.set({ isActive: true, sessionId, selectedIds: new Set(unitId ? [unitId] : []), pickerOpen: false });
						notify(t("notify.multiSelect"), true);
					}
				});

				const firstBtn = row.querySelector("button");
				if (firstBtn && firstBtn.nextSibling) row.insertBefore(btn, firstBtn.nextSibling);
				else row.appendChild(btn);
			};

			const scan = () => {
				document.querySelectorAll("[data-clock='start']").forEach(decorate);
			};

			// 卸载时把自己插的按钮一并摘掉：只 disconnect 观察器会留下失效的按钮
			// （它们绑定的是已经卸载的 ctx），重新激活时 decorate() 又会因为
			// “已存在 .dsh-mf-user-btn” 直接跳过，于是永远用着旧按钮。
			const clearButtons = () => {
				document.querySelectorAll(".dsh-mf-user-btn").forEach((n) => n.remove());
			};

			// 观察器是 120ms 防抖的：卸载时必须连待执行的定时器一起取消，
			// 否则它会在卸载之后又扫一遍、把刚清掉的按钮重新插回来。
			let scheduled = false;
			let timer = null;
			const schedule = () => {
				if (scheduled) return;
				scheduled = true;
				timer = setTimeout(() => { scheduled = false; timer = null; scan(); }, 120);
			};

			scan();
			const observer = new MutationObserver(schedule);
			observer.observe(document.body, { childList: true, subtree: true });
			return () => {
				observer.disconnect();
				if (timer !== null) { clearTimeout(timer); timer = null; }
				scheduled = true; // 让任何迟到的一次 schedule() 直接返回
				clearButtons();
			};
		}

		function setupBatchDecorator() {
			if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};

			const clearDecorations = () => {
				document.querySelectorAll(".dsh-mf-check").forEach((n) => n.remove());
				document.querySelectorAll(".dsh-mf-check-host").forEach((n) => {
					n.classList.remove("dsh-mf-check-host");
					// 只回收我们自己补上的定位，DSH 原有的内联样式一律不动；
					// 清空后若 style 属性已空，连属性一起摘掉，避免留下 style=""
					if (n.dataset && n.dataset.dshMfPos === "1") {
						n.style.position = "";
						delete n.dataset.dshMfPos;
						if (n.getAttribute("style") === "") n.removeAttribute("style");
					}
				});
				document.querySelectorAll(".dsh-mf-unit-selected").forEach((n) => n.classList.remove("dsh-mf-unit-selected"));
				if (document.body) document.body.classList.remove("dsh-mf-batch-active");
			};

			const decorate = () => {
				const state = batchStore.state;
				if (!state.isActive) { clearDecorations(); return; }
				if (document.body) document.body.classList.add("dsh-mf-batch-active");
				collectUnits().forEach((unit) => {
					const host = unit.element;
					if (!host) return;
					// 用 class 留出左侧装订线；定位只在宿主本身没有定位时才补，
					// 否则覆盖 DSH 自己的 position 会破坏原布局。
					host.classList.add("dsh-mf-check-host");
					if (typeof getComputedStyle === "function" && getComputedStyle(host).position === "static") {
						host.style.position = "relative";
						host.dataset.dshMfPos = "1";
					}
					let box = host.querySelector(":scope > .dsh-mf-check");
					if (!box) {
						box = document.createElement("div");
						box.className = "dsh-mf-check";
						const inner = document.createElement("span");
						inner.className = "dsh-mf-check-box";
						box.appendChild(inner);
						host.appendChild(box);
					}
					box.dataset.unitId = unit.id;
					box.setAttribute("role", "checkbox");
					box.setAttribute("tabindex", "0");
					const selected = state.selectedIds.has(unit.id);
					box.classList.toggle("selected", selected);
					box.setAttribute("aria-checked", selected ? "true" : "false");
					box.setAttribute("title", selected ? t("action.unselectMessage") : t("action.selectMessage"));
					host.classList.toggle("dsh-mf-unit-selected", selected);
				});
			};

			let scheduled = false;
			let timer = null;
			const schedule = () => {
				if (scheduled) return;
				scheduled = true;
				timer = setTimeout(() => { scheduled = false; timer = null; decorate(); }, 80);
			};

			const onClickCapture = (e) => {
				if (!batchStore.state.isActive) return;
				const target = e.target;
				const box = target && target.closest ? target.closest(".dsh-mf-check") : null;
				if (!box) return;
				e.preventDefault();
				e.stopPropagation();
				const id = box.dataset.unitId;
				if (!id) return;
				toggleSelectedUnit(id);
			};

			const observer = new MutationObserver(schedule);
			observer.observe(document.body, { childList: true, subtree: true });
			const unsubscribe = batchStore.subscribe(schedule);
			document.addEventListener("click", onClickCapture, true);
			decorate();

			return () => {
				observer.disconnect();
				if (timer !== null) { clearTimeout(timer); timer = null; }
				scheduled = true; // 让任何迟到的一次 schedule() 直接返回
				unsubscribe();
				document.removeEventListener("click", onClickCapture, true);
				clearDecorations();
			};
		}

		// ---------------------------------------------------------------- 插件入口
		/** locale 是软依赖：拿不到服务时 t() 会回落到内置词表，功能不受影响。 */
		const inject = ["slots", "locale", "sessions", "workspaces", "uiWorkspace"];

		function apply(ctx) {
			ctxRef = ctx;

			// 词表注册：声明 locale 命名空间后，注册进该槽位的条目会随语言切换重渲染
			ctx.effect(() => registerLocale(ctx), "dsh-message-forward: locale dictionaries");

			ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({
				name: "conversation.chat.assistant-actions",
				id: "forward-action",
				order: 15,
				locale: LOCALE_NS
			}, AssistantActionButton));

			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "forward-header-utility",
				order: 30,
				locale: LOCALE_NS
			}, HeaderUtilityButton));

			ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register({
				name: "conversation.input.overlay",
				id: "forward-overlay",
				order: 12,
				locale: LOCALE_NS
			}, ForwardOverlay));

			ctx.inject(["commandUi"], (scope) => {
				const commands = scope.get("commandUi");
				if (!commands || typeof commands.register !== "function") return;
				scope.effect(() => commands.register({
					name: "forward",
					label: () => t("command.forward"),
					available: () => true,
					ui: {
						kind: "action",
						run: (session) => {
							const sessionId = (session && session.sessionId) || "";
							const data = extractLastAssistantTurn();
							openForwardModal({
								role: "assistant",
								text: data.text,
								images: data.images,
								sourceSessionId: sessionId,
								sourceTitle: sessionTitle(sessionId)
							});
						}
					}
				}), "dsh-message-forward: /forward command");
			});

			ctx.effect(() => setupUserMessageButtons(), "dsh-message-forward: user message buttons");
			ctx.effect(() => setupBatchDecorator(), "dsh-message-forward: batch decorator");
			// 样式表：工厂期不碰 DOM，注册与摘除在这里成对发生
			ctx.effect(() => {
				const TAG_ID = "dsh-message-forward-styles";
				if (typeof document === "undefined" || !document.head) return () => {};
				let styleEl = document.getElementById(TAG_ID);
				if (!styleEl) {
					styleEl = document.createElement("style");
					styleEl.id = TAG_ID;
					document.head.appendChild(styleEl);
				}
				styleEl.textContent = CSS;
				return () => {
					if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
				};
			}, "dsh-message-forward: stylesheet");
			// 草稿队列：卸载时收掉未兑现的 pending 与重试定时器（等待中的投递 settle 为 cancelled）
			ctx.effect(() => () => { draftHub.reset("cancelled"); }, "dsh-message-forward: draft queue");

			try {
				console.info("[dsh-message-forward] ready — 转发入口：消息操作行 / 会话表头 / /forward 命令");
			} catch { /* ignore */ }
		}

		// 客户端半边的导出协议与出货插件一致（如 dsh-session-log-export/lib/client.js）：
		// 只导出 apply / inject，模块 id 由 __ModuleLoader__.load({ id }) 决定。
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
