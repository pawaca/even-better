import { test } from "node:test";
import assert from "node:assert/strict";
import { reflowTables, stripBoxBorders, renderForGlasses } from "../src/render.js";

// markdown table → vertical
test("md-table", () => assert.equal(
  reflowTables("| Name | Age | City |\n|------|-----|------|\n| Alice | 30 | NYC |\n| Bob | 25 | LA |"),
  "• Alice\n  Age: 30\n  City: NYC\n• Bob\n  Age: 25\n  City: LA"));

// prose around a table is preserved
test("md-with-prose", () => assert.equal(
  reflowTables("Here:\n| A | B |\n|---|---|\n| 1 | 2 |\nDone."),
  "Here:\n• 1\n  B: 2\nDone."));

// non-table passes through
test("no-table", () => assert.equal(reflowTables("just a line\nwith | a pipe but no table"), "just a line\nwith | a pipe but no table"));

// empty cells skipped
test("empty-cells", () => assert.equal(
  reflowTables("| K | V | X |\n|---|---|---|\n| a | | z |"),
  "• a\n  X: z"));

// box borders stripped, cell text kept
test("box-strip", () => assert.equal(
  stripBoxBorders("╭────────┬────────╮\n│ Name   │ Age    │\n├────────┼────────┤\n│ Alice  │ 30     │\n╰────────┴────────╯"),
  "  Name  Age\n  Alice  30"));

// pipeline: markdown table reflowed even with trailing prose
test("pipeline", () => assert.equal(
  renderForGlasses("| Metric | Value |\n|--------|-------|\n| Latency | 42ms |"),
  "• Latency\n  Value: 42ms"));
