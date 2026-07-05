import { OutputStream } from "../src/output-stream.js";
const t = (name: string, ok: boolean, extra = "") => console.log(`${ok ? "✅" : "❌"} ${name} ${extra}`);

// text reconstructs seamlessly; an event interleaves in order
const got: object[] = [];
const os = new OutputStream((m) => got.push(m), 5);
os.text("Hello");
os.event({ type: "tool_start", name: "Bash" });
os.text("World");
await os.drain();
const text = got.filter((m) => (m as any).type === "text_delta").map((m) => (m as any).text).join("");
t("text reconstructs", text === "HelloWorld", JSON.stringify(text));
const evtIdx = got.findIndex((m) => (m as any).type === "tool_start");
const beforeEvt = got.slice(0, evtIdx).map((m) => (m as any).text).join("");
t("event ordered after first block", beforeEvt === "Hello", JSON.stringify(beforeEvt));

// clear() drops everything pending
const got2: object[] = [];
const os2 = new OutputStream((m) => got2.push(m), 5);
os2.text("this is a long string that will not all flush at once");
os2.clear();
await new Promise((r) => setTimeout(r, 40));
t("clear stops output", got2.length <= 2, `emitted ${got2.length} before clear`);

// emoji not split across frames (surrogate pairs stay intact per frame)
const got3: string[] = [];
const os3 = new OutputStream((m) => got3.push((m as any).text), 5);
os3.text("🎉🎊🥳🚀✨");
await os3.drain();
const joined = got3.join("");
t("emoji intact", joined === "🎉🎊🥳🚀✨" && got3.every((s) => !s.includes("�")), JSON.stringify(joined));
