import { diffNewLines, filterVolatile } from "../src/parse.js";

const t = (name: string, got: string[], want: string[]) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "✅" : "❌"} ${name}: ${JSON.stringify(got)}`);
};

// spinner tick above unchanged code must NOT re-emit the tail
t("in-place-tick", diffNewLines(["A", "B", "code1", "code2"], ["A", "B", "code1", "code2"]), []);
// tool box painted mid-screen without scrolling MUST be emitted (old algo lost this)
t("repaint-add ", diffNewLines(["A", "B", "C"], ["A", "B", "box1", "box2", "C"]), ["box1", "box2"]);
// scroll + append
t("scroll      ", diffNewLines(["A", "B", "C", "D", "E"], ["C", "D", "E", "F", "G"]), ["F", "G"]);
// repeated short lines in new code emit the right number of times
t("dup-lines   ", diffNewLines(["A", "}"], ["A", "}", "B", "}"]), ["B", "}"]);
// full window replacement (fast scroll) emits everything new
t("fast-scroll ", diffNewLines(["A", "B"], ["X", "Y", "Z"]), ["X", "Y", "Z"]);
// volatile: spinners including · variant and transient Running line
t("filter      ", filterVolatile([
  "· Shimmying… (esc to",
  "⏺ Running 1 shell command…",
  "⏺ real assistant text",
  "✻ Inferring…",
]), ["⏺ real assistant text"]);
