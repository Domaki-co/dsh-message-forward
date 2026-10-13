// Regression guard: every --dsw-alias-* token the plugin's CSS references must be a REAL DSH token.
// A missing token silently falls back to the hardcoded value, which is how the batch bar ended up
// with a dark background paired with theme-coloured (dark-in-light-theme) text => invisible buttons.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "lib", "client.js");
const REAL = path.join(here, "dsh-theme-tokens.txt");

const src = fs.readFileSync(SRC, "utf8");
const real = new Set(
  fs.readFileSync(REAL, "utf8").split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("//"))
    .map((s) => (s.startsWith("--") ? s : "--" + s))
);

// --- pull the CSS template literal out of the bundle ---
const start = src.indexOf("const CSS = `");
const end = src.indexOf("`;", start);
if (start < 0 || end < 0) throw new Error("could not locate CSS template literal");
const css = src.slice(start + "const CSS = `".length, end);
console.log("CSS bytes:", css.length, " real DSH tokens known:", real.size);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "\n      " + extra : ""}`);
};

// --- 1. no unknown tokens anywhere in the CSS ---
const used = [...new Set([...css.matchAll(/--dsw-alias-[a-z0-9-]+/g)].map((m) => m[0]))].sort();
const unknown = used.filter((t) => !real.has(t));
ok("all referenced tokens exist in DSH", unknown.length === 0,
  unknown.length ? "UNKNOWN: " + unknown.join(", ") : `checked ${used.length} tokens`);

// --- 2. no bare token reference without a fallback is fine, but a MISSING token is fatal ---
// (guards the exact class of bug: token typo'd -> fallback silently used)
const banned = ["--dsw-alias-bg-elevated", "--dsw-alias-bg-hover", "--dsw-alias-bg-primary",
                "--dsw-alias-bg-secondary", "--dsw-alias-border-secondary"];
const stillThere = banned.filter((t) => css.includes(t));
ok("the five bogus tokens are gone", stillThere.length === 0,
  stillThere.length ? "STILL PRESENT: " + stillThere.join(", ") : "removed");

// --- 3. the batch bar must not mix a hardcoded dark bg with theme text ---
const barRule = css.match(/\.dsh-mf-bar\s*\{([^}]*)\}/);
ok("found .dsh-mf-bar rule", !!barRule);
if (barRule) {
  const body = barRule[1];
  const bg = (body.match(/background:\s*([^;]+);/) || [])[1] || "";
  const fg = (body.match(/color:\s*([^;]+);/) || [])[1] || "";
  console.log("      .dsh-mf-bar background:", bg.trim());
  console.log("      .dsh-mf-bar color:     ", fg.trim());
  ok("bar background uses a real token", /var\(--dsw-alias-bg-overlay\)/.test(bg), bg.trim());
  ok("bar background has no hardcoded dark fallback", !/rgba\(2[0-9],\s*2[0-9],\s*3[0-9]/.test(bg), bg.trim());
  ok("bar text uses a real token", /var\(--dsw-alias-label-primary\)/.test(fg), fg.trim());
  ok("bar text has no hardcoded white fallback", !/#fff/i.test(fg), fg.trim());
}

// --- 4. bar buttons must be self-contained (not color:inherit over an unknown bg) ---
const btnRule = css.match(/\.dsh-mf-bar-btn\s*\{([^}]*)\}/);
ok("found .dsh-mf-bar-btn rule", !!btnRule);
if (btnRule) {
  const body = btnRule[1];
  const bg = (body.match(/background:\s*([^;]+);/) || [])[1] || "";
  const fg = (body.match(/color:\s*([^;]+);/) || [])[1] || "";
  console.log("      .dsh-mf-bar-btn background:", bg.trim());
  console.log("      .dsh-mf-bar-btn color:     ", fg.trim());
  ok("bar button has its own background token", /var\(--dsw-alias-bg-layer-2\)/.test(bg), bg.trim());
  ok("bar button has its own text token (not inherit)", /var\(--dsw-alias-label-primary\)/.test(fg), fg.trim());
  ok("bar button no longer uses color:inherit", !/color:\s*inherit/.test(body));
}

// --- 5. primary button must pair a fill token with the inverted label ---
const primRule = css.match(/\.dsh-mf-bar-btn\.dsh-mf-primary\s*\{([^}]*)\}/);
ok("found primary button rule", !!primRule);
if (primRule) {
  const body = primRule[1];
  ok("primary uses button-primary-fill", /var\(--dsw-alias-button-primary-fill\)/.test(body));
  ok("primary text uses inverted label", /var\(--dsw-alias-label-primary-inverted\)/.test(body));
}

// --- 6. checkbox must be inside the host box (not at a negative offset that gets clipped) ---
const checkRule = css.match(/\.dsh-mf-check\s*\{([^}]*)\}/);
ok("found .dsh-mf-check rule", !!checkRule);
if (checkRule) {
  const body = checkRule[1];
  const left = (body.match(/left:\s*(-?[\d.]+px)/) || [])[1];
  console.log("      .dsh-mf-check left:", left);
  ok("checkbox is not at a negative left offset", left && !left.startsWith("-"), String(left));
}
const boxRule = css.match(/\.dsh-mf-check-box\s*\{([^}]*)\}/);
ok("found .dsh-mf-check-box rule", !!boxRule);
if (boxRule) {
  const body = boxRule[1];
  ok("checkbox box has a visible border token", /var\(--dsw-alias-label-secondary\)/.test(body));
  ok("checkbox box has a shadow for contrast on any backdrop", /box-shadow:/.test(body));
  ok("checkbox box uses box-sizing:border-box", /box-sizing:\s*border-box/.test(body));
}

// --- 7. the selected checkmark must use the inverted label (visible on brand fill) ---
ok("checkmark uses inverted label token",
  /\.dsh-mf-check\.selected \.dsh-mf-check-box::after\s*\{[^}]*var\(--dsw-alias-label-primary-inverted\)/s.test(css));

// --- 8. the forward modal must adapt to the window (bug: content pushed the card off-screen) ---
// primitives' Modal card is width:min(380px,100%) with no max-height, so the plugin has to
// cap it itself. The doubled class beats primitives' own rule regardless of <style> order.
const dlg = css.match(/\.dsh-mf-dialog\.dsh-mf-dialog\s*\{([^}]*)\}/);
ok("found .dsh-mf-dialog.dsh-mf-dialog rule (doubled class for specificity)", !!dlg);
if (dlg) {
  ok("dialog widens past the primitives 380px default", /width:\s*min\(720px,\s*100%\)/.test(dlg[1]));
  ok("dialog is capped against the Modal padding box", /max-height:\s*100%/.test(dlg[1]));
}
ok("dialog class is actually passed to Modal",
  /className:\s*"dsh-mf-dialog"/.test(src) && /contentClassName:\s*"dsh-mf-content"/.test(src));
const modalBody = css.match(/\.dsh-mf-dialog\.dsh-mf-dialog\s+\.dsh-mf-modal-body\s*\{([^}]*)\}/);
ok("found the dialog-scoped .dsh-mf-modal-body rule", !!modalBody);
if (modalBody) {
  ok("body scrolls internally", /overflow-y:\s*auto/.test(modalBody[1]));
  ok("body can actually shrink (min-height:0)", /min-height:\s*0/.test(modalBody[1]));
  ok("body has a vh fallback AND a dvh value", /calc\(100vh - 240px\)[\s\S]*calc\(100dvh - 240px\)/.test(modalBody[1]));
}
ok("content wrapper can shrink", /\.dsh-mf-content\s*\{[^}]*min-height:\s*0/s.test(css));
ok("editor height follows the viewport", /\.dsh-mf-edit\s*\{[^}]*max-height:\s*min\(300px,\s*32dvh\)/s.test(css));
ok("session list height follows the viewport", /\.dsh-mf-list\s*\{[^}]*max-height:\s*min\(240px,\s*26dvh\)/s.test(css));
ok("footer actions are pinned right and wrap on narrow windows",
  /\.dsh-mf-footer-actions\s*\{[^}]*margin-left:\s*auto/.test(css) && /\.dsh-mf-footer\s*\{[^}]*flex-wrap:\s*wrap/s.test(css));

// --- 9. the quick-pick panel: role badges must be distinguishable, list must scroll ---
// The panel is what makes long answers selectable without scrolling to them, so it has to
// stay inside the bar (flex-basis:100%) and scroll internally instead of growing the bar.
const pickerRule = css.match(/\.dsh-mf-picker\s*\{([^}]*)\}/);
ok("found .dsh-mf-picker rule", !!pickerRule);
if (pickerRule) {
  ok("picker takes a full row of the bar", /flex-basis:\s*100%/.test(pickerRule[1]));
  ok("picker can shrink (min-width:0)", /min-width:\s*0/.test(pickerRule[1]));
}
const pickerList = css.match(/\.dsh-mf-picker-list\s*\{([^}]*)\}/);
ok("found .dsh-mf-picker-list rule", !!pickerList);
if (pickerList) {
  ok("picker list scrolls internally", /overflow-y:\s*auto/.test(pickerList[1]));
  ok("picker list height follows the viewport", /max-height:\s*min\(300px,\s*38dvh\)/.test(pickerList[1]));
  ok("picker list contains its overscroll", /overscroll-behavior:\s*contain/.test(pickerList[1]));
}
// role badges: user vs model must not share a colour, or the panel fails its whole purpose
const badgeUser = css.match(/\.dsh-mf-pick-badge-user\s*\{([^}]*)\}/);
const badgeModel = css.match(/\.dsh-mf-pick-badge-model\s*\{([^}]*)\}/);
ok("found both role badge rules", !!badgeUser && !!badgeModel);
if (badgeUser && badgeModel) {
  const cu = (badgeUser[1].match(/color:\s*([^;]+);/) || [])[1] || "";
  const cm = (badgeModel[1].match(/color:\s*([^;]+);/) || [])[1] || "";
  console.log("      user badge colour: ", cu.trim());
  console.log("      model badge colour:", cm.trim());
  ok("user and model badges use different colours", cu.trim() !== cm.trim() && cu !== "" && cm !== "");
}
ok("picker items are real buttons (keyboard reachable)",
  /\.dsh-mf-pick-item\s*\{[^}]*cursor:\s*pointer/s.test(css));
ok("picker item text is clamped to a few lines",
  /\.dsh-mf-pick-text\s*\{[^}]*-webkit-line-clamp:\s*3/s.test(css));
// the count is now a button that opens the panel
ok("count control is a button, not a span",
  /className:\s*"dsh-mf-bar-count-btn"/.test(src) &&
  /\.dsh-mf-bar-count-btn\s*\{[^}]*cursor:\s*pointer/s.test(css));
ok("picker open state is carried in the batch store",
  /const batchStore = makeStore\(\{[^}]*pickerOpen:\s*false/.test(src));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
