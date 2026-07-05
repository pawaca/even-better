import { reflowTables, stripBoxBorders, renderForGlasses } from "../src/render.js";

const t = (name: string, got: string, want: string) => {
  const ok = got === want;
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) { console.log("  got :", JSON.stringify(got)); console.log("  want:", JSON.stringify(want)); }
};

// markdown table → vertical
t("md-table",
  reflowTables("| Name | Age | City |\n|------|-----|------|\n| Alice | 30 | NYC |\n| Bob | 25 | LA |"),
  "• Alice\n  Age: 30\n  City: NYC\n• Bob\n  Age: 25\n  City: LA");

// prose around a table is preserved
t("md-with-prose",
  reflowTables("Here:\n| A | B |\n|---|---|\n| 1 | 2 |\nDone."),
  "Here:\n• 1\n  B: 2\nDone.");

// non-table passes through
t("no-table", reflowTables("just a line\nwith | a pipe but no table"), "just a line\nwith | a pipe but no table");

// empty cells skipped
t("empty-cells",
  reflowTables("| K | V | X |\n|---|---|---|\n| a | | z |"),
  "• a\n  X: z");

// box borders stripped, cell text kept
t("box-strip",
  stripBoxBorders("╭────────┬────────╮\n│ Name   │ Age    │\n├────────┼────────┤\n│ Alice  │ 30     │\n╰────────┴────────╯"),
  "  Name  Age\n  Alice  30");

// pipeline: markdown table reflowed even with trailing prose
t("pipeline",
  renderForGlasses("| Metric | Value |\n|--------|-------|\n| Latency | 42ms |"),
  "• Latency\n  Value: 42ms");

import { chunkForGlasses } from "../src/render.js";
const tc=(name:string,got:unknown,want:unknown)=>console.log(`${JSON.stringify(got)===JSON.stringify(want)?"✅":"❌"} ${name}`);
tc("short-single", chunkForGlasses("hi\nthere", 240), ["hi\nthere"]);
tc("no-split-line", chunkForGlasses("aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc", 15), ["aaaaaaaaaa","bbbbbbbbbb","cccccccccc"]);
tc("pack-lines", chunkForGlasses("a\nb\nc\nd", 3), ["a\nb","c\nd"]);
tc("long-line-whole", chunkForGlasses("short\nthisisaverylonglinethatexceeds", 10), ["short","thisisaverylonglinethatexceeds"]);
