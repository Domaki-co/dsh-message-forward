/* dsh-message-forward — client bundle (v0.2.0)
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
 */
window.__ModuleLoader__.load({
	id: "dsh-message-forward",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { createElement: h, useState, useEffect, useRef, useCallback, useMemo } = React;
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { Modal, Button, Toast, Tooltip, Input } = primitives;

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

			.dsh-mf-modal-body { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
			/* ---------------------------------------------------------------- 弹窗自适应
			   primitives 的 Modal 卡片是 width:min(380px,100%)、且没有 max-height，
			   内容一多就顶出窗口。这里按官方注释的做法接管（消费方用 max-height:100% 封顶，
			   而不是自己算视口）：
			     - 卡片：加宽到 720px，并按视口高度封顶；
			     - 正文区：接上 flex 收缩链（dialog > content > body 都要 min-height:0），
			       让正文内部滚动，头部标题与底部按钮在小窗口下始终可见。
			   选择器写成 .dsh-mf-dialog.dsh-mf-dialog 是为了稳定压过 primitives 的同名规则，
			   不依赖两边 <style> 的注入顺序。 */
			.dsh-mf-dialog.dsh-mf-dialog {
				width: min(720px, 100%);
				max-height: 100%;
			}
			.dsh-mf-dialog.dsh-mf-dialog .dsh-mf-content {
				min-height: 0;
				flex: 1 1 auto;
			}
			/* Modal 固定结构：content > [header, description?, body]，body 永远是最后一个子节点。
			   头部/描述不参与压缩，正文容器接上收缩链（min-height:0 才能真的缩下去）。 */
			.dsh-mf-dialog.dsh-mf-dialog .dsh-mf-content > *:not(:last-child) {
				flex: none;
			}
			.dsh-mf-dialog.dsh-mf-dialog .dsh-mf-content > *:last-child {
				min-height: 0;
				flex: 1 1 auto;
			}
			/* 底部按钮区是 content 的下一个兄弟（dialog > [content, footer]），
			   禁止它被压缩，否则小窗口下按钮会被挤没。 */
			.dsh-mf-dialog.dsh-mf-dialog > .dsh-mf-content ~ * {
				flex: none;
			}
			.dsh-mf-dialog.dsh-mf-dialog .dsh-mf-modal-body {
				min-height: 0;
				flex: 1 1 auto;
				overflow-y: auto;
				overscroll-behavior: contain;
				/* 兜底：万一 flex 收缩链没生效，也不让正文把卡片撑出视口。
				   头部/底部/外边距的固定开销约 240px，其余留给正文。 */
				max-height: calc(100vh - 240px);
				max-height: calc(100dvh - 240px);
			}
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
			/* 底部：窄窗口下目标提示与按钮组换行，按钮组右对齐并允许自身换行 */
			.dsh-mf-footer {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 10px;
				flex-wrap: wrap;
				width: 100%;
				min-width: 0;
			}
			.dsh-mf-footer-actions { justify-content: flex-end; margin-left: auto; }
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
		`;

		if (typeof document !== "undefined") {
			const TAG_ID = "dsh-message-forward-styles";
			let styleEl = document.getElementById(TAG_ID);
			if (!styleEl) {
				styleEl = document.createElement("style");
				styleEl.id = TAG_ID;
				document.head.appendChild(styleEl);
			}
			styleEl.textContent = CSS;
		}

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

		/** 草稿交接：跨会话没有公开的 setDraft API，只能交给目标会话的 overlay 组件执行 */
		const draftHub = {
			pending: null,
			listeners: new Set(),
			subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
			emit() {
				this.listeners.forEach((fn) => { try { fn(); } catch (err) { console.error("[dsh-forward] draft listener", err); } });
			},
			request(sessionId, text, files) {
				this.pending = { sessionId, text, files: files || [], at: Date.now() };
				this.emit();
				// 目标会话可能是刚刚才被打开（overlay 尚未挂载）：短时重试广播
				let tries = 0;
				const timer = setInterval(() => {
					tries += 1;
					if (!this.pending || this.pending.sessionId !== sessionId || tries > 40) { clearInterval(timer); return; }
					this.emit();
				}, 250);
			},
			take(sessionId) {
				const p = this.pending;
				if (!p || p.sessionId !== sessionId) return null;
				if (Date.now() - p.at > 60000) { this.pending = null; return null; }
				this.pending = null;
				return p;
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
						title: row.displayTitle || row.title || "未命名会话",
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
			if (!sessions || typeof sessions.create !== "function") throw new Error("会话服务不可用");
			const sourceId = forwardStore.state.payload && forwardStore.state.payload.sourceSessionId;
			const cwd = sessionCwd(sourceId);
			const id = await sessions.create(cwd ? { cwd } : {});
			if (!id || typeof id !== "string") throw new Error("新建会话失败");
			return id;
		}

		/** 真正把内容投递到目标会话（此处是之前所有「发送」失败的根因修复点） */
		async function deliverToSession(targetId, content) {
			const sessions = sessionsService();
			if (!sessions || typeof sessions.using !== "function") throw new Error("会话服务不可用");
			await sessions.using(targetId, { source: "dsh-message-forward" }, async (reference) => {
				const session = reference && reference.binding && reference.binding.session;
				if (!session || typeof session.prompt !== "function") throw new Error("无法获取目标会话的会话句柄");
				const result = await session.prompt(content, "queue");
				if (result && result.ok === false) {
					const err = result.error || {};
					throw new Error(err.message || err.code || "发送被目标会话拒绝");
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
			tip.textContent = "长按 2 秒：多选合并转发";
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

		function mergeUnits(units, selectedIds) {
			const chosen = units.filter((u) => selectedIds.has(u.id));
			const parts = [];
			const images = [];
			const seenImg = new Set();
			chosen.forEach((u, index) => {
				const snap = u.getSnapshot();
				const tag = snap.role === "user" ? "用户" : "模型";
				parts.push("【" + (index + 1) + "】" + tag + ":\n" + (snap.text || "(无文本内容)"));
				(snap.images || []).forEach((im) => {
					if (seenImg.has(im.url)) return;
					seenImg.add(im.url);
					images.push(im);
				});
			});
			return { text: parts.join("\n\n---\n\n"), images, count: chosen.length };
		}

		// ---------------------------------------------------------------- 批量工具条
		function BatchToolbar() {
			const [state, setState] = useState(batchStore.state);
			useEffect(() => batchStore.subscribe(setState), []);
			const unitsRef = useRef([]);
			const [, forceTick] = useState(0);
			const pickerOpen = !!state.pickerOpen;

			useEffect(() => {
				if (!state.isActive) return undefined;
				// 进入多选时清空摘要缓存：消息内容可能在上次退出后变过
				snippetCache.clear();
				const refresh = () => {
					const next = collectUnits();
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

			const toggleUnit = (id) => {
				const next = new Set(batchStore.state.selectedIds);
				if (next.has(id)) next.delete(id); else next.add(id);
				batchStore.set({ selectedIds: next });
			};

			const handleMerge = () => {
				const merged = mergeUnits(units, state.selectedIds);
				if (merged.count === 0) { notify("请先勾选要转发的消息", false); return; }
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
					h("span", { className: "dsh-mf-picker-title" }, "快捷选择"),
					h("span", { className: "dsh-mf-hint" },
						"共 " + units.length + " 条 · 每段最多 " + PICK_TEXT_MAX + " 字符"),
					h("button", {
						type: "button",
						className: "dsh-mf-picker-close",
						title: "收起",
						onClick: () => batchStore.set({ pickerOpen: false })
					}, "×")
				),
				units.length === 0
					? h("div", { className: "dsh-mf-empty" }, "当前会话还没有可选择的已加载消息")
					: h("div", { className: "dsh-mf-picker-list" },
						units.map((u, i) => {
							const isUser = u.role === "user";
							const isSel = state.selectedIds.has(u.id);
							const snippet = unitSnippet(u) || "(无文本内容)";
							return h("button", {
								key: u.id,
								type: "button",
								className: "dsh-mf-pick-item" + (isSel ? " selected" : ""),
								title: "点击" + (isSel ? "取消选择" : "选择") + "这条消息",
								onClick: () => toggleUnit(u.id)
							},
								h("span", { className: "dsh-mf-pick-badge " + (isUser ? "dsh-mf-pick-badge-user" : "dsh-mf-pick-badge-model") },
									isUser ? "用户" : "模型"),
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
					title: pickerOpen ? "收起快捷选择" : "展开快捷选择，直接勾选消息",
					onClick: () => batchStore.set({ pickerOpen: !batchStore.state.pickerOpen })
				},
					h("span", { className: "dsh-mf-bar-count" }, "已选 " + selected + " / " + units.length + " 条"),
					h("span", { className: "dsh-mf-bar-caret" }, pickerOpen ? "▲" : "▼")
				),
				h("button", { type: "button", className: "dsh-mf-bar-btn", onClick: () => batchStore.set({ selectedIds: new Set(units.map((u) => u.id)) }) }, "全选"),
				h("button", { type: "button", className: "dsh-mf-bar-btn", onClick: () => batchStore.set({ selectedIds: new Set() }) }, "清空"),
				h("button", { type: "button", className: "dsh-mf-bar-btn", onClick: () => batchStore.set({ isActive: false, selectedIds: new Set(), pickerOpen: false }) }, "退出 (Esc)"),
				h("button", {
					type: "button",
					className: "dsh-mf-bar-btn dsh-mf-primary",
					disabled: selected === 0,
					onClick: handleMerge
				}, "合并转发")
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
					setEditedText("以下是上游会话的产出结果，请作为参考背景：\n\n" + (payload ? payload.text || "" : ""));
				} else if (kind === "task") {
					setEditedText("请基于以下上游结果继续执行后续任务：\n\n" + (payload ? payload.text || "" : ""));
				} else if (kind === "code") {
					const text = editedText || "";
					const blocks = text.match(/```[\s\S]*?```/g);
					if (blocks && blocks.length > 0) {
						setEditedText(blocks.join("\n\n"));
						notify("已提取 " + blocks.length + " 个代码块", true);
					} else {
						notify("未检测到 Markdown 代码块", false);
					}
				} else {
					setEditedText(payload ? payload.text || "" : "");
				}
			}, [editedText, payload]);

			const handleExecute = useCallback(async (actionType) => {
				if (!payload || submitting) return;
				setSubmitting(true);
				try {
					let finalTarget = targetId;
					let targetTitle = "新建的会话";
					if (finalTarget === "__NEW_SESSION__") {
						finalTarget = await createTargetSession();
					} else {
						targetTitle = sessionTitle(finalTarget) || "目标会话";
					}

					let text = editedText.trim();
					const roleLabel = payload.role === "user" ? "用户消息" : payload.role === "batch" ? "合并消息" : "模型回复";
					const sourceLabel = payload.sourceTitle || sessionTitle(payload.sourceSessionId) || "未知会话";
					if (includeSource) text = "【转发自会话「" + sourceLabel + "」· " + roleLabel + "】\n\n" + text;

					if (!text && (!payload.images || payload.images.length === 0)) {
						notify("没有可转发的内容", false);
						setSubmitting(false);
						return;
					}

					if (actionType === "draft") {
						const files = [];
						for (const img of payload.images || []) {
							const file = await urlToFile(img.url, img.name);
							if (file) files.push(file);
						}
						draftHub.request(finalTarget, text, files);
						jumpToSession(finalTarget);
						closeForwardModal();
						notify("已切换到「" + targetTitle + "」并填入输入框，确认后发送", true);
						return;
					}

					const built = await buildPromptContent(text, payload.images);
					if (built.items.length === 0) {
						notify("没有可转发的内容（图片读取失败或无文本）", false);
						setSubmitting(false);
						return;
					}
					await deliverToSession(finalTarget, built.items);
					if (actionType === "send-and-jump") jumpToSession(finalTarget);
					closeForwardModal();
					const skippedNote = built.skipped.length > 0 ? "（" + built.skipped.length + " 张图片不支持，已跳过）" : "";
					notify("已转发到「" + targetTitle + "」" + skippedNote, true);
				} catch (err) {
					console.error("[dsh-forward] 转发失败", err);
					notify("转发失败：" + ((err && err.message) || String(err)), false);
				} finally {
					setSubmitting(false);
				}
			}, [payload, targetId, editedText, includeSource, submitting]);

			const toastNode = toast && h(Toast, {
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
			const badgeText = payload.role === "user" ? "用户消息" : payload.role === "batch" ? "合并 " + (payload.itemCount || 0) + " 条" : "模型回复";

			const body = h("div", { className: "dsh-mf-modal-body" },
				h("div", { className: "dsh-mf-card" },
					h("div", { className: "dsh-mf-row-between" },
						h("div", { className: "dsh-mf-row" },
							h("span", { className: badgeClass }, badgeText),
							h("span", { className: "dsh-mf-hint" }, "来自：" + (payload.sourceTitle || "当前会话")),
							images.length > 0 && h("span", { className: "dsh-mf-hint" }, "· " + images.length + " 张图片")
						),
						h("button", {
							type: "button",
							className: "dsh-mf-chip",
							onClick: () => {
								const sessionId = payload.sourceSessionId || "";
								closeForwardModal();
								batchStore.set({ isActive: true, selectedIds: new Set(), sessionId, pickerOpen: false });
								notify("已进入多选模式：点左侧圆点勾选，或点底部「已选 N 条」展开快捷选择", true);
							}
						}, "☷ 改为多选合并")
					),
					h("div", { className: "dsh-mf-row" },
						h("span", { className: "dsh-mf-hint" }, "快捷加工："),
						h("button", { type: "button", className: "dsh-mf-chip", onClick: () => applyTemplate("reference") }, "+ 作为参考背景"),
						h("button", { type: "button", className: "dsh-mf-chip", onClick: () => applyTemplate("task") }, "+ 作为任务输入"),
						h("button", { type: "button", className: "dsh-mf-chip", onClick: () => applyTemplate("code") }, "⚡ 仅保留代码块"),
						h("button", { type: "button", className: "dsh-mf-chip", onClick: () => applyTemplate("reset") }, "重置原文")
					),
					h("textarea", {
						className: "dsh-mf-edit",
						value: editedText,
						placeholder: "可在此裁剪内容或补充任务要求（发送前可自由编辑）",
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
					h("span", null, "附带来源标记（会话标题 + 消息角色）")
				),

				h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
					h("div", { className: "dsh-mf-row-between" },
						h("span", { style: { fontSize: "13px", fontWeight: 600 } }, "选择目标会话"),
						h("span", { className: "dsh-mf-hint" }, "共 " + filtered.length + " 个会话")
					),
					h(Input, {
						icon: h(SearchIcon),
						placeholder: "搜索会话标题或目录…",
						value: search,
						onChange: (e) => setSearch(e.target.value)
					}),
					h("div", { className: "dsh-mf-list" },
						h("div", {
							className: "dsh-mf-item" + (targetId === "__NEW_SESSION__" ? " selected" : ""),
							onClick: () => setTargetId("__NEW_SESSION__")
						},
							h("div", { className: "dsh-mf-row" }, h(PlusIcon), h("span", { className: "dsh-mf-item-title" }, "新建空白会话（干净上下文）")),
							targetId === "__NEW_SESSION__" && h(CheckIcon)
						),
						filtered.length === 0
							? h("div", { className: "dsh-mf-empty" }, rows.length === 0 ? "暂无可选会话" : "没有匹配的会话")
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
											row.running && h("span", null, "● 运行中"),
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
				h("span", { className: "dsh-mf-hint" }, "目标：" + (targetId === "__NEW_SESSION__" ? "新建会话" : sessionTitle(targetId) || "会话")),
				h("div", { className: "dsh-mf-row dsh-mf-footer-actions" },
					h(Button, { variant: "ghost", disabled: submitting, onClick: handleClose }, "取消"),
					h(Button, { variant: "outline", disabled: submitting, onClick: () => handleExecute("draft") }, "填入草稿并跳转"),
					h(Button, { variant: "outline", disabled: submitting, onClick: () => handleExecute("send-silent") }, "静默发送"),
					h(Button, { variant: "primary", disabled: submitting, onClick: () => handleExecute("send-and-jump") }, submitting ? "处理中…" : "发送并跳转")
				)
			);

			return h(React.Fragment, null,
				h(BatchToolbarPortal),
				toastNode,
				h(Modal, {
					open: true,
					title: payload.role === "batch" ? "合并转发" : "转发消息",
					closeLabel: "关闭",
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
						if (inputActions && typeof inputActions.setDraft === "function") {
							inputActions.setDraft(pending.text || "");
						} else {
							notify("已切到目标会话，但输入框未就绪，请手动粘贴", false);
						}
						if (pending.files && pending.files.length > 0 && inputActions && typeof inputActions.addAttachments === "function") {
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
						}
					} catch (err) {
						console.error("[dsh-forward] 草稿填入失败", err);
						notify("草稿填入失败：" + ((err && err.message) || String(err)), false);
					} finally {
						applyingRef.current = false;
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
						notify("已进入多选模式：点左侧圆点勾选，或点底部「已选 N 条」展开快捷选择", true);
					}
				});
			}, [messageId, sessionId]);

			return h(Tooltip, { label: "转发这条回复（长按 2 秒进入多选）", side: "bottom" },
				h("button", {
					ref: btnRef,
					type: "button",
					className: "dsh-mf-btn",
					"aria-label": "转发这条回复"
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
						notify("已进入多选模式：点左侧圆点勾选，或点底部「已选 N 条」展开快捷选择", true);
					}
				});
			}, [sessionId]);

			return h(Tooltip, { label: "转发本会话产出（长按 2 秒进入多选）", side: "bottom" },
				h("button", {
					ref: btnRef,
					type: "button",
					className: "dsh-mf-btn",
					"aria-label": "转发本会话产出"
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
				btn.setAttribute("aria-label", "转发这条消息");
				btn.setAttribute("title", "转发这条消息（长按 2 秒进入多选）");
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
						notify("已进入多选模式：点左侧圆点勾选，或点底部「已选 N 条」展开快捷选择", true);
					}
				});

				const firstBtn = row.querySelector("button");
				if (firstBtn && firstBtn.nextSibling) row.insertBefore(btn, firstBtn.nextSibling);
				else row.appendChild(btn);
			};

			const scan = () => {
				document.querySelectorAll("[data-clock='start']").forEach(decorate);
			};

			let scheduled = false;
			const schedule = () => {
				if (scheduled) return;
				scheduled = true;
				setTimeout(() => { scheduled = false; scan(); }, 120);
			};

			scan();
			const observer = new MutationObserver(schedule);
			observer.observe(document.body, { childList: true, subtree: true });
			return () => observer.disconnect();
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
					box.setAttribute("title", selected ? "取消选择这条消息" : "选择这条消息");
					host.classList.toggle("dsh-mf-unit-selected", selected);
				});
			};

			let scheduled = false;
			const schedule = () => {
				if (scheduled) return;
				scheduled = true;
				setTimeout(() => { scheduled = false; decorate(); }, 80);
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
				const next = new Set(batchStore.state.selectedIds);
				if (next.has(id)) next.delete(id); else next.add(id);
				batchStore.set({ selectedIds: next });
			};

			const observer = new MutationObserver(schedule);
			observer.observe(document.body, { childList: true, subtree: true });
			const unsubscribe = batchStore.subscribe(schedule);
			document.addEventListener("click", onClickCapture, true);
			decorate();

			return () => {
				observer.disconnect();
				unsubscribe();
				document.removeEventListener("click", onClickCapture, true);
				clearDecorations();
			};
		}

		// ---------------------------------------------------------------- 插件入口
		const name = "dsh-message-forward";
		const inject = ["slots", "sessions", "workspaces", "uiWorkspace"];

		function apply(ctx) {
			ctxRef = ctx;

			ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({
				name: "conversation.chat.assistant-actions",
				id: "forward-action",
				order: 15
			}, AssistantActionButton));

			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "forward-header-utility",
				order: 30
			}, HeaderUtilityButton));

			ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register({
				name: "conversation.input.overlay",
				id: "forward-overlay",
				order: 12
			}, ForwardOverlay));

			ctx.inject(["commandUi"], (scope) => {
				const commands = scope.get("commandUi");
				if (!commands || typeof commands.register !== "function") return;
				scope.effect(() => commands.register({
					name: "forward",
					label: () => "转发会话消息 (Forward)",
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

			try {
				console.info("[dsh-message-forward] ready — 转发入口：消息操作行 / 会话表头 / /forward 命令");
			} catch { /* ignore */ }
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
