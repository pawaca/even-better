import { paneRead } from "../src/herdr.js";
const raw = await paneRead("w1:pQ", "recent_unwrapped", 300);
const hits = raw.split("\n").filter((l) => /round2|ROUND2/.test(l));
console.log("pane lines mentioning round2:");
for (const h of hits) console.log(JSON.stringify(h));
