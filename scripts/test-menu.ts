import { parseMenu, classifyMenu } from "../src/parse.js";

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

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
