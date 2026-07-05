import { paneRead } from "../src/herdr.js";
const recent = await paneRead("w1:pQ", "recent_unwrapped", 300);
console.log("== recent_unwrapped RAW (all lines numbered) ==");
recent.split("\n").forEach((l, i) => console.log(`${String(i).padStart(3)} ${l.slice(0, 100)}`));
