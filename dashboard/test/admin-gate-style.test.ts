// The lock page text is large enough to read, and the box uses more of a desktop screen. It reads the style sheet, so a later edit cannot shrink it again without a failing test.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");

/** The declaration block of the first rule whose selector list includes `selector`. */
function block(selector: string, from = 0): string {
  const at = css.indexOf(selector, from);
  assert.ok(at >= 0, `rule for ${selector}`);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}
const px = (decl: string, prop: string): number => Number(new RegExp(`${prop}:\\s*(\\d+)px`).exec(decl)?.[1] ?? 0);

test("the help text on the lock page is at least 14 px", () => {
  const rule = block(".admin-gate .field-hint");
  assert.ok(px(rule, "font-size") >= 14, rule);
  assert.ok(px(block(".admin-gate .brand-sub"), "font-size") >= 14);
});

test("on a desktop the box is wider than 380 px, and a phone keeps the narrow box", () => {
  const narrow = block(".admin-gate-box {");
  assert.equal(px(narrow, "max-width"), 380);
  const media = css.indexOf("@media (min-width: 768px)", css.indexOf(".admin-gate .field label"));
  assert.ok(media > 0, "a desktop rule exists");
  assert.ok(px(block(".admin-gate-box", media), "max-width") >= 560);
});

test("no 11 px text is left inside the lock page rules", () => {
  const start = css.indexOf(".admin-gate {");
  const end = css.indexOf(".admin-unlocked");
  assert.doesNotMatch(css.slice(start, end), /font-size:\s*11px/);
});
