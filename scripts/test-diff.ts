import { paneRead, sendInput } from "../src/herdr.js";
import { diffNewLines, filterVolatile } from "../src/parse.js";

const before = await paneRead("wB:p1", "visible", 120);
const prevLines = filterVolatile(before.split("\n"));
console.log("PREV last 5:", JSON.stringify(prevLines.slice(-5)));

await sendInput("wB:p1", "echo DIFF-TEST-XYZ", ["Enter"]);
await new Promise((r) => setTimeout(r, 1500));

const after = await paneRead("wB:p1", "visible", 120);
const currLines = filterVolatile(after.split("\n"));
console.log("CURR last 8:", JSON.stringify(currLines.slice(-8)));

const added = diffNewLines(prevLines, currLines);
console.log("ADDED:", JSON.stringify(added));
console.log("prev.len:", prevLines.length, "curr.len:", currLines.length);
