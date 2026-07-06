import { diffNewLines, filterVolatile, normalizeLine } from "../src/parse.js";

const t = (name: string, got: string[] | string, want: string[] | string) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "✅" : "❌"} ${name}: ${JSON.stringify(got)}`);
};

t("in-place-tick", diffNewLines(["A", "B", "code1", "code2"], ["A", "B", "code1", "code2"]), []);
t("repaint-add ", diffNewLines(["A", "B", "C"], ["A", "B", "box1", "box2", "C"]), ["box1", "box2"]);
t("scroll      ", diffNewLines(["A", "B", "C", "D", "E"], ["C", "D", "E", "F", "G"]), ["F", "G"]);
t("dup-lines   ", diffNewLines(["A", "}"], ["A", "}", "B", "}"]), ["B", "}"]);
t("fast-scroll ", diffNewLines(["A", "B"], ["X", "Y", "Z"]), ["X", "Y", "Z"]);
t("filter      ", filterVolatile([
  "· Shimmying… (esc to",
  "⏺ real assistant text",
  "✻ Inferring…",
  "> 用户说的话回显",
]), ["⏺ real assistant text"]);
t("filter-prompt", filterVolatile(["> old prompt", "› codex prompt", "assistant"]), ["assistant"]);
// tool-call lines must survive the filter now
t("keep-tool   ", filterVolatile([
  "  Running 1 shell command…",
  "  ⎿  $ echo real-command",
]), ["  Running 1 shell command…", "  ⎿  $ echo real-command"]);
// duration suffix normalization: finished variant == running variant
t("norm-trunc  ", normalizeLine("     deltas = [e for e in events… (3s)"), "     deltas = [e for e in events…");
t("norm-box    ", normalizeLine("  ⎿  $ echo hi (0s)"), "  ⎿  $ echo hi");
t("norm-keep   ", normalizeLine("正文里提到 (3s) 不在行尾x"), "正文里提到 (3s) 不在行尾x");
t("norm-plain  ", normalizeLine("plain text ends (3s)"), "plain text ends (3s)");

// audit round: unclosed duration suffix, lone bullet
t("norm-uncls  ", normalizeLine('     deltas = [e for e in events… (3s'), "     deltas = [e for e in events…");
t("norm-uncls2 ", normalizeLine('     deltas = [e for e in events… (4s'), "     deltas = [e for e in events…");
t("filter-bullet", filterVolatile(["⏺", "  ⏺  ", "⏺ real text"]), ["⏺ real text"]);
