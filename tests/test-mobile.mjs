// Regression guard: the plugin must stay usable on a phone-sized viewport.
//
// Two classes of bug this locks down:
//
//  1. Floating layers that overflow the viewport. MfTooltip anchors itself at the
//     element's CENTRE and then renders with translateX(-50%). With no clamping, a
//     trigger near either edge pushes half the bubble off-screen — and the two real
//     entry points (the assistant action row, which sits at the right end, and the
//     session header, which sits at the left) are exactly those two cases.
//
//  2. Touch targets below the mobile floor. dsh-mobile enforces 44x44 under
//     `@media (max-width:720px)`; a 26px icon button is a mis-tap magnet.
//
// The geometry assertions below re-implement clampCenter() and check it against the
// same arithmetic the browser performs, so a regression in either the function or the
// CSS transform pairing shows up here rather than on someone's phone.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "lib", "client.js");
const src = fs.readFileSync(SRC, "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "\n      " + extra : ""}`);
};

// --- pull the CSS template literal out of the bundle ---
const cssStart = src.indexOf("const CSS = `");
const cssEnd = src.indexOf("`;", cssStart);
if (cssStart < 0 || cssEnd < 0) throw new Error("could not locate CSS template literal");
const css = src.slice(cssStart + "const CSS = `".length, cssEnd);

// --- the mobile breakpoint block, if present ---
const mobileMatch = css.match(/@media\s*\(max-width:\s*720px\)\s*\{([\s\S]*)\n\t\t\t\}\s*$/);
const mobile = mobileMatch ? mobileMatch[1] : "";
ok("a max-width:720px breakpoint exists (aligned with dsh-mobile)", !!mobileMatch);

// ---------------------------------------------------------------------------
// 1. clampCenter(): the tooltip must be pulled back inside the viewport.
// ---------------------------------------------------------------------------
const fnMatch = src.match(/function clampCenter\(([\s\S]*?)\n\t\t\}/);
ok("found clampCenter() in client.js", !!fnMatch);

if (fnMatch) {
  // Evaluate the real function body rather than a copy, so the test tracks the source.
  const clampCenter = new Function(`${fnMatch[0]}\nreturn clampCenter;`)();

  const VW = 375;                 // iPhone SE logical width
  const MARGIN = 8;
  const W = 187.5;                // tooltip max-width: 50vw

  // The bubble spans [c - W/2, c + W/2]; after clamping it must sit inside the viewport.
  const spans = (center) => [center - W / 2, center + W / 2];
  const inside = ([l, r]) => l >= -0.001 && r <= VW + 0.001;

  // Trigger at the right end of the assistant action row (the real case that overflowed).
  const right = clampCenter(343, W, VW, MARGIN);
  ok("right-edge trigger is clamped back inside", inside(spans(right)),
    `center 343 -> ${right.toFixed(1)}, span [${spans(right).map((n) => n.toFixed(0)).join(", ")}]`);

  // Trigger at the left end of the session header.
  const left = clampCenter(33, W, VW, MARGIN);
  ok("left-edge trigger is clamped back inside", inside(spans(left)),
    `center 33 -> ${left.toFixed(1)}, span [${spans(left).map((n) => n.toFixed(0)).join(", ")}]`);

  // A centre trigger must be left alone (no gratuitous shifting).
  ok("centred trigger is not shifted", clampCenter(VW / 2, W, VW, MARGIN) === VW / 2);

  // A bubble wider than the viewport degrades to centred rather than flipping sides.
  const wide = clampCenter(10, VW + 100, VW, MARGIN);
  ok("over-wide bubble degrades to centred", Math.abs(wide - VW / 2) < 0.001);

  // Exhaustive sweep: no trigger position may produce an overflowing bubble.
  let worst = null;
  for (let c = -50; c <= VW + 50; c += 0.5) {
    const [l, r] = spans(clampCenter(c, W, VW, MARGIN));
    const over = Math.max(0 - l, r - VW);
    if (over > 0.001 && (!worst || over > worst.over)) worst = { c, over };
  }
  ok("no trigger position overflows (sweep -50..425)", !worst,
    worst ? `worst: center ${worst.c} overflows by ${worst.over.toFixed(1)}px` : "swept 951 positions");
}

// ---------------------------------------------------------------------------
// 2. The CSS transform must actually consume the shift variable.
// ---------------------------------------------------------------------------
// Setting left without composing the shift into transform would silently do nothing,
// because [data-side="bottom"] already owns translateX(-50%).
const bottomRule = css.match(/\.dsh-mf-tooltip\[data-side="bottom"\]\s*\{([^}]*)\}/);
ok("found the bottom-side tooltip transform", !!bottomRule);
if (bottomRule) {
  ok("bottom transform composes the shift variable",
    /translateX\(\s*calc\(\s*-50%\s*\+\s*var\(--dsh-mf-tooltip-shift/.test(bottomRule[1]),
    bottomRule[1].trim());
}
const topRule = css.match(/\.dsh-mf-tooltip\[data-side="top"\]\s*\{([^}]*)\}/);
ok("top transform composes the shift variable",
  !!topRule && /var\(--dsh-mf-tooltip-shift/.test(topRule[1]));

// The component must write the variable and measure the bubble after mount.
ok("MfTooltip writes --dsh-mf-tooltip-shift",
  /"--dsh-mf-tooltip-shift":\s*shift\s*\+\s*"px"/.test(src));
ok("MfTooltip measures the bubble in a layout effect",
  /useLayoutEffect\(\(\)\s*=>\s*\{[\s\S]{0,600}?bubbleRef\.current/.test(src));
ok("useLayoutEffect is imported from React",
  /useLayoutEffect,/.test(src.slice(0, src.indexOf("} = React;"))));

// ---------------------------------------------------------------------------
// 3. Modal footer: the four action buttons must not sit flush against the
//    dialog edge, and on a phone they must not be crushed into one row.
// ---------------------------------------------------------------------------
// The footer wrapper had NO CSS rule at all, so it inherited the dialog's 720px
// width with zero horizontal padding — the buttons ended up hard against the edge.
const footerRule = css.match(/\.dsh-mf-footer\s*\{([^}]*)\}/);
ok("footer has its own rule", !!footerRule);
if (footerRule) {
  ok("footer carries the same 24px gutter as header/body",
    /padding:\s*0 24px/.test(footerRule[1]),
    footerRule[1].trim().replace(/\s+/g, " "));
  // Regression: without box-sizing the 100% width PLUS 48px padding overflows the
  // dialog by 48px, and the dialog's overflow:hidden eats it on the right — the
  // left gutter looks right while the last button sits flush against the edge.
  ok("footer is border-box so its 100% width absorbs the padding",
    /box-sizing:\s*border-box/.test(footerRule[1]),
    "width:100% + padding:0 24px in content-box = 48px overflow");
}
ok("footer action group can wrap on its own",
  /\.dsh-mf-footer-actions\s*\{[^}]*flex-wrap:\s*wrap/s.test(css));
ok("footer action group can shrink below its content width",
  /\.dsh-mf-footer-actions\s*\{[^}]*min-width:\s*0/s.test(css));
ok("the modal footer wrapper can shrink too",
  /\.dsh-mf-modal-footer\s*\{[^}]*min-width:\s*0/s.test(css));

// Regression: the dialog is a flex item of .dsh-mf-modal-root. Its default
// min-width:auto floors it at min-content width, which overrode
// width:min(720px,100%) and stretched the card past the viewport.
const wideDialog = css.match(/\.dsh-mf-dialog\.dsh-mf-dialog\s*\{([^}]*)\}/);
ok("wide dialog rule exists", !!wideDialog);
if (wideDialog) {
  ok("wide dialog keeps its 720px cap", /width:\s*min\(720px,\s*100%\)/.test(wideDialog[1]), wideDialog[1].trim());
  ok("wide dialog opts out of the flex min-width:auto floor",
    /min-width:\s*0/.test(wideDialog[1]),
    "without min-width:0 the flex item ignores width:min(720px,100%)");
}

// ---------------------------------------------------------------------------
// 4. Touch targets: 44px floor under the mobile breakpoint.
// ---------------------------------------------------------------------------
if (mobile) {
  const rule = (sel) => {
    const m = mobile.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
    return m ? m[1] : "";
  };

  // Icon buttons keep a small visual box but gain a 44x44 hit area via ::after,
  // so the message row layout is not blown up by the tap target.
  const btn = rule(".dsh-mf-btn");
  ok("mobile enlarges the icon button", /width:\s*32px/.test(btn) && /height:\s*32px/.test(btn));
  ok("mobile gives the icon button a 44x44 hit area",
    /\.dsh-mf-btn::after/.test(mobile) && /width:\s*44px/.test(mobile) && /height:\s*44px/.test(mobile));

  // Modal / picker close buttons are standalone, so they can simply be 44px.
  const close = mobile.match(/\.dsh-mf-modal-close,\s*\n\s*\.dsh-mf-picker-close\s*\{([^}]*)\}/);
  ok("mobile enlarges standalone close buttons to 44px",
    !!close && /width:\s*44px/.test(close[1]) && /height:\s*44px/.test(close[1]));

  // Bar buttons are text buttons; the floor is on min-height. They share a grouped
  // rule with .dsh-mf-bar-count-btn, so match either selector in the list.
  const barBtn = mobile.match(/\.dsh-mf-bar-btn,?\s*\n?\s*(?:\.dsh-mf-bar-count-btn)?\s*\{([^}]*)\}/);
  ok("mobile raises bar buttons to a 44px min-height",
    !!barBtn && /min-height:\s*44px/.test(barBtn[1]),
    barBtn ? barBtn[1].trim().split("\n").map((s) => s.trim()).join(" ") : "rule not found");

  // The checkbox gutter must widen with the checkbox, or the larger hit area
  // overlaps the message text.
  const host = rule(".dsh-mf-check-host");
  const check = rule(".dsh-mf-check");
  ok("mobile widens the checkbox gutter", /padding-left:\s*40px/.test(host));
  ok("mobile enlarges the checkbox hit area", /width:\s*32px/.test(check));

  // Bottom bar must clear the iPhone home indicator.
  const bar = rule(".dsh-mf-bar");
  ok("mobile bar respects safe-area-inset-bottom",
    /env\(safe-area-inset-bottom/.test(bar), bar.trim().split("\n").filter((l) => l.includes("bottom")).join(" "));

  // The quick-pick panel must not eat half the screen on a short phone.
  const pickerList = rule(".dsh-mf-picker-list");
  ok("mobile caps the picker list below the desktop height",
    /max-height:\s*min\(240px,\s*30dvh\)/.test(pickerList), pickerList.trim());

  // Narrower modal padding buys back content width.
  const root = rule(".dsh-mf-modal-root");
  ok("mobile tightens the modal padding", /padding:\s*12px/.test(root));

  // The four footer buttons get a two-column grid instead of being crushed
  // into a single row of tiny text.
  const footer = rule(".dsh-mf-footer");
  ok("mobile tightens the footer gutter", /padding:\s*0 16px/.test(footer), footer.trim());
  ok("mobile lays the footer buttons out as a two-column grid",
    /grid-template-columns:\s*1fr 1fr/.test(mobile) && /\.dsh-mf-footer-actions\s*\{[\s\S]{0,200}?display:\s*grid/.test(mobile));
  ok("mobile makes each footer button fill its cell",
    /\.dsh-mf-footer-actions\s+\.dsh-mf-button\s*\{[^}]*width:\s*100%/.test(mobile));
}

// ---------------------------------------------------------------------------
// 4. The desktop rules must be untouched (the breakpoint is additive).
// ---------------------------------------------------------------------------
ok("desktop tooltip max-width is unchanged", /\.dsh-mf-tooltip\s*\{[^}]*max-width:\s*50vw/s.test(css));
ok("desktop picker list height is unchanged",
  /\.dsh-mf-picker-list\s*\{[^}]*max-height:\s*min\(300px,\s*38dvh\)/s.test(css));
ok("desktop bar has no safe-area offset",
  /\.dsh-mf-bar\s*\{[^}]*bottom:\s*22px/s.test(css));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
