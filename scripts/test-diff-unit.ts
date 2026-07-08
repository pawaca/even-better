import { test } from "node:test";
import assert from "node:assert/strict";
import { diffNewLines, filterVolatile, normalizeLine } from "../src/parse.js";

test("in-place-tick", () => assert.deepEqual(diffNewLines(["A", "B", "code1", "code2"], ["A", "B", "code1", "code2"]), []));
test("repaint-add ", () => assert.deepEqual(diffNewLines(["A", "B", "C"], ["A", "B", "box1", "box2", "C"]), ["box1", "box2"]));
test("scroll      ", () => assert.deepEqual(diffNewLines(["A", "B", "C", "D", "E"], ["C", "D", "E", "F", "G"]), ["F", "G"]));
test("dup-lines   ", () => assert.deepEqual(diffNewLines(["A", "}"], ["A", "}", "B", "}"]), ["B", "}"]));
test("fast-scroll ", () => assert.deepEqual(diffNewLines(["A", "B"], ["X", "Y", "Z"]), ["X", "Y", "Z"]));
test("filter      ", () => assert.deepEqual(filterVolatile([
  "· Shimmying… (esc to",
  "⏺ real assistant text",
  "✻ Inferring…",
  "> 用户说的话回显",
]), ["⏺ real assistant text"]));
test("filter-prompt", () => assert.deepEqual(filterVolatile(["> old prompt", "› codex prompt", "assistant"]), ["assistant"]));
// tool-call lines must survive the filter now
test("keep-tool   ", () => assert.deepEqual(filterVolatile([
  "  Running 1 shell command…",
  "  ⎿  $ echo real-command",
]), ["  Running 1 shell command…", "  ⎿  $ echo real-command"]));
// duration suffix normalization: finished variant == running variant
test("norm-trunc  ", () => assert.deepEqual(normalizeLine("     deltas = [e for e in events… (3s)"), "     deltas = [e for e in events…"));
test("norm-box    ", () => assert.deepEqual(normalizeLine("  ⎿  $ echo hi (0s)"), "  ⎿  $ echo hi"));
test("norm-keep   ", () => assert.deepEqual(normalizeLine("正文里提到 (3s) 不在行尾x"), "正文里提到 (3s) 不在行尾x"));
test("norm-plain  ", () => assert.deepEqual(normalizeLine("plain text ends (3s)"), "plain text ends (3s)"));

// audit round: unclosed duration suffix, lone bullet
test("norm-uncls  ", () => assert.deepEqual(normalizeLine('     deltas = [e for e in events… (3s'), "     deltas = [e for e in events…"));
test("norm-uncls2 ", () => assert.deepEqual(normalizeLine('     deltas = [e for e in events… (4s'), "     deltas = [e for e in events…"));
test("filter-bullet", () => assert.deepEqual(filterVolatile(["⏺", "  ⏺  ", "⏺ real text"]), ["⏺ real text"]));
