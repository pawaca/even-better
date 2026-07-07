import { parseMenu, classifyMenu, isCodexApprovalScreen } from "../src/parse.js";

let failed = 0;
const t = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) {
    failed++;
    if (detail !== undefined) console.log("  got:", JSON.stringify(detail));
  }
};

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
t("claude: 3 options parsed", cp?.options.length === 3, cp?.options);
t("claude: classified permission", cp ? classifyMenu(cp).kind === "permission" : false);

const ca = parseMenu(codexApprove);
t("codex: highlighted (›) option not dropped → 3 options", ca?.options.length === 3, ca?.options);
t("codex: option 1 is the Yes (not swallowed by the › marker)", ca?.options[0]?.digit === "1");
const cac = ca ? classifyMenu(ca) : null;
t("codex: classified permission (not question)", cac?.kind === "permission", cac);
t("codex: allow=1, allowAlways=2, deny=3",
  cac?.allow?.digit === "1" && cac?.allowAlways?.digit === "2" && cac?.deny?.digit === "3", cac);

const ct = parseMenu(codexTrust);
t("codex trust: 2 options parsed", ct?.options.length === 2, ct?.options);

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
t("echo above menu: picks the real 3-option dialog, not the echo",
  em?.options.length === 3 && em?.options[0]?.label.startsWith("Yes, proceed"), em?.options);

// A lone numbered prompt echo (not a contiguous ≥2 run from 1) is not a menu.
const echoOnly = ["› 1. do the thing I asked", "", "some other output line"].join("\n");
t("lone numbered echo → not a menu", parseMenu(echoOnly) === null);

// Scattered / non-sequential N. lines are not a menu.
const scattered = ["1. alpha", "unrelated line", "unrelated line", "3. gamma"].join("\n");
t("non-sequential scattered → not a menu", parseMenu(scattered) === null);

// isCodexApprovalScreen — the coarse codex-blocked trigger (codex approvals are
// not hooks, so the screen is the only signal).
const codexExecScreen = [
  "  Would you like to run the following command?",
  "  $ touch x.txt",
  "› 1. Yes, proceed (y)",
  "  Press enter to confirm or esc to cancel",
].join("\n");
const codexPatchScreen = [
  "  Would you like to make the following edits?",
  "› 1. Yes, proceed (y)",
  "  Press enter to confirm or esc to cancel",
].join("\n");
const codexWorking = ["• Working (12s • esc to interrupt)", "› Run the shell command"].join("\n");
// The question can appear in ordinary prose — it must NOT trigger without the footer.
const codexProse = ["• I can do that. Would you like to run the tests first?", "› _"].join("\n");
t("codex approval screen (exec) detected", isCodexApprovalScreen(codexExecScreen));
t("codex approval screen (patch) detected", isCodexApprovalScreen(codexPatchScreen));
t("codex working screen not detected", !isCodexApprovalScreen(codexWorking));
t("codex prose 'would you like to run' (no footer) not detected", !isCodexApprovalScreen(codexProse));
t("claude permission not codex-detected", !isCodexApprovalScreen(claudePerm));

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
