import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMenu, classifyMenu, isCodexApprovalScreen } from "../src/parse.js";

// Representative screens captured live from the real TUIs. The highlighted
// option carries a per-agent selection marker: `❯` (claude), `›` (codex).

const claudePerm = [
  " Do you want to create note.txt?",
  " ❯ 1. Yes",
  "   2. Yes, allow all edits during this session (shift+tab)",
  "   3. No",
].join("\n");

// codex marks the highlighted option with `›`; a 3-option approval mis-parsed
// into a 2-option "question" before the marker was handled.
const codexApprove = [
  "  Would you like to run the following command?",
  "  $ touch approve-me.txt",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for commands that start with `touch approve-me.txt` (p)",
  "  3. No, and tell Codex what to do differently (esc)",
].join("\n");

const codexTrust = ["› 1. Yes, continue", "  2. No, quit"].join("\n");

const cp = parseMenu(claudePerm);
test("claude: 3 options parsed", () => assert.ok(cp?.options.length === 3, cp?.options ? String(cp.options) : undefined));
test("claude: classified permission", () => assert.ok(cp ? classifyMenu(cp).kind === "permission" : false));

const ca = parseMenu(codexApprove);
test("codex: highlighted (›) option not dropped → 3 options", () => assert.ok(ca?.options.length === 3, ca?.options ? String(ca.options) : undefined));
test("codex: option 1 is the Yes (not swallowed by the › marker)", () => assert.ok(ca?.options[0]?.digit === "1"));
const cac = ca ? classifyMenu(ca) : null;
test("codex: classified permission (not question)", () => assert.ok(cac?.kind === "permission", cac ? String(cac) : undefined));
test("codex: allow=1, allowAlways=2, deny=3", () => assert.ok(
  cac?.allow?.digit === "1" && cac?.allowAlways?.digit === "2" && cac?.deny?.digit === "3", cac ? String(cac) : undefined));

const ct = parseMenu(codexTrust);
test("codex trust: 2 options parsed", () => assert.ok(ct?.options.length === 2, ct?.options ? String(ct.options) : undefined));

// A codex prompt echo reuses the `›` prefix and may be numbered. It must not be
// taken as the menu when a real dialog is also on screen (take the last valid
// contiguous 1,2,3 run), nor on its own.
const echoAboveMenu = [
  "› 1. update the readme",
  "  2. add more tests",
  "",
  "  Would you like to run the following command?",
  "  $ touch x.txt",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again (p)",
  "  3. No, and tell Codex what to do differently (esc)",
].join("\n");
const em = parseMenu(echoAboveMenu);
test("echo above menu: picks the real 3-option dialog, not the echo", () => assert.ok(
  em?.options.length === 3 && em?.options[0]?.label.startsWith("Yes, proceed"), em?.options ? String(em.options) : undefined));

// A lone numbered prompt echo (not a contiguous ≥2 run from 1) is not a menu.
const echoOnly = ["› 1. do the thing I asked", "", "some other output line"].join("\n");
test("lone numbered echo → not a menu", () => assert.ok(parseMenu(echoOnly) === null));

// Scattered / non-sequential N. lines are not a menu.
const scattered = ["1. alpha", "unrelated line", "unrelated line", "3. gamma"].join("\n");
test("non-sequential scattered → not a menu", () => assert.ok(parseMenu(scattered) === null));

// isCodexApprovalScreen — the coarse codex-blocked trigger (codex approvals are
// not hooks, so the screen is the only signal).
const codexExecScreen = [
  "  Would you like to run the following command?",
  "  $ touch x.txt",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again (p)",
  "  3. No, and tell Codex what to do differently (esc)",
  "  Press enter to confirm or esc to cancel",
].join("\n");
const codexPatchScreen = [
  "  Would you like to make the following edits?",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for these files (a)",
  "  3. No, and tell Codex what to do differently (esc)",
  "  Press enter to confirm or esc to cancel",
].join("\n");
const codexWorking = ["• Working (12s • esc to interrupt)", "› Run the shell command"].join("\n");
// The question can appear in ordinary prose — must NOT trigger without a dialog.
const codexProse = ["• I can do that. Would you like to run the tests first?", "› _"].join("\n");
// The footer STRING can appear in output (e.g. editing this repo's docs) — but
// without an adjacent numbered menu it is not a live dialog.
const codexFooterEcho = [
  "• Edited docs/PERMISSIONS.md (+1 -0)",
  '    "Press enter to confirm or esc to cancel" is the anchor.',
  "› _",
].join("\n");
// Footer text AND an UNMARKED numbered prose list (no ❯/› selected row) — output,
// not a live chooser.
const codexFooterPlusProseList = [
  "• Options I considered (see: press enter to confirm or esc to cancel):",
  "  1. rewrite the parser",
  "  2. add a flag",
  "› _",
].join("\n");
test("codex approval screen (exec) detected", () => assert.ok(isCodexApprovalScreen(codexExecScreen)));
test("codex approval screen (patch) detected", () => assert.ok(isCodexApprovalScreen(codexPatchScreen)));
test("codex working screen not detected", () => assert.ok(!isCodexApprovalScreen(codexWorking)));
test("codex prose 'would you like to run' (no footer) not detected", () => assert.ok(!isCodexApprovalScreen(codexProse)));
test("codex footer text in output (no menu) not detected", () => assert.ok(!isCodexApprovalScreen(codexFooterEcho)));
test("codex footer + unmarked prose list (no › row) not detected", () => assert.ok(!isCodexApprovalScreen(codexFooterPlusProseList)));
// Footer text far ABOVE a `› N.` prompt echo (codex reuses › for input) — not a
// live dialog, since the footer isn't just below the marked row.
const codexFooterFarFromMarkedEcho = [
  "  docs note: press enter to confirm or esc to cancel.",
  "  line", "  line", "  line", "  line", "  line", "  line", "  line", "  line",
  "› 1. my first idea",
  "  2. my second idea",
].join("\n");
test("codex footer far from marked › row not detected", () => assert.ok(!isCodexApprovalScreen(codexFooterFarFromMarkedEcho)));
// A stale `› N.` echo above the live dialog must not hide the real approval row.
const codexStaleEchoAboveDialog = [
  "› 1. an earlier numbered prompt echo",
  "  2. still visible from before",
  "  ...more output...",
  "  Would you like to run the following command?",
  "  $ touch x.txt",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again (p)",
  "  3. No, and tell Codex what to do differently (esc)",
  "  Press enter to confirm or esc to cancel",
].join("\n");
test("codex live dialog below a stale › echo IS detected", () => assert.ok(isCodexApprovalScreen(codexStaleEchoAboveDialog)));
test("claude permission not codex-detected", () => assert.ok(!isCodexApprovalScreen(claudePerm)));
