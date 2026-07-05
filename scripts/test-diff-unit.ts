import { diffNewLines, filterVolatile } from "../src/parse.js";

// 1. in-place redraw (spinner tick) must NOT re-emit the tail
console.log("in-place:", JSON.stringify(
  diffNewLines(["A", "B", "spin1", "code1", "code2"], ["A", "B", "spin2", "code1", "code2"])));
// 2. scroll + append
console.log("scroll:  ", JSON.stringify(
  diffNewLines(["A", "B", "C", "D", "E"], ["C", "D", "E", "F", "G"])));
// 3. pure append
console.log("append:  ", JSON.stringify(
  diffNewLines(["A", "B", "C"], ["A", "B", "C", "D"])));
// 4. volatile: wrapped spinner + thinking status filtered
console.log("filter:  ", JSON.stringify(filterVolatile([
  "✻ Inferring… (esc to",
  "interrupt · ↑ 2.3k tokens)",
  "real content line",
  "✽ Thinking…",
])));
