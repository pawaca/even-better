import { paneRead } from "../src/herdr.js";
import { readFileSync } from "node:fs";
// needles assembled at runtime so command echoes never contain the literals
const p3 = ["PROBE3", "ALPHA"].join("-");
const p5 = ["PROBE5", "QQQZZZ"].join("-");

// 1. what was the single PROBE3 hit in the bridge event log?
const lines = readFileSync("/tmp/bridge-sim-r3.log", "utf8").split("\n");
for (const l of lines) {
  if (l.includes("PROBE3")) {
    const e = JSON.parse(l);
    console.log(`bridge-log hit: dir=${e.dir} type=${e.msg?.type ?? e.msg?.path}`);
    const text = typeof e.msg?.text === "string" ? e.msg.text : JSON.stringify(e.msg);
    console.log("  content:", text.slice(0, 200));
  }
}

// 2. poll visible for the prose-only needle
for (let i = 0; i < 12; i++) {
  const vis = await paneRead("w1:pQ", "visible", 120);
  const rows = vis.split("\n");
  const hits = rows.filter((r) => r.includes(p5) && !r.includes("join"));
  if (hits.length) {
    console.log(`poll ${i}: prose needle PRESENT: ${JSON.stringify(hits[0].slice(0, 100))}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log("prose needle NEVER seen in visible within 6s");
