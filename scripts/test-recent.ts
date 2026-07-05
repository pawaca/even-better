import { paneRead } from "../src/herdr.js";
import { filterVolatile } from "../src/parse.js";
const raw = await paneRead("w1:pQ", "recent_unwrapped", 300);
const lines = raw.split("\n");
const kept = filterVolatile(lines);
console.log(`recent_unwrapped: ${lines.length} lines raw, ${kept.length} after filter`);
console.log("last 3 kept:", JSON.stringify(kept.slice(-3)));
