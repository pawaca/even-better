import { paneRead } from "../src/herdr.js";
for (let i = 0; i < 10; i++) {
  const vis = await paneRead("w1:pQ", "visible", 120);
  const hit = vis.includes("PROBE4-INSTANT-X");
  console.log(`poll ${i}: visible ${vis.split("\n").length} lines, PROBE4 ${hit ? "PRESENT" : "absent"}`);
  if (hit) {
    const idx = vis.split("\n").findIndex((l) => l.includes("PROBE4-INSTANT-X"));
    console.log("  context:", JSON.stringify(vis.split("\n").slice(Math.max(0,idx-1), idx+2)));
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
