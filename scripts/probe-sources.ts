import { paneRead } from "../src/herdr.js";
const recent = await paneRead("w1:pQ", "recent_unwrapped", 300);
const visible = await paneRead("w1:pQ", "visible", 120);
const check = (name: string, text: string) => {
  console.log(`${name}: ${text.split("\n").length} lines`);
  for (const p of ["正文形态", "引用行 marker", "炸出真相"]) {
    console.log(`  ${text.includes(p) ? "HAS " : "MISS"} ${p}`);
  }
};
check("recent_unwrapped(300)", recent);
check("visible(120)", visible);
