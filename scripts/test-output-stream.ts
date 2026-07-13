import { test } from "node:test";
import assert from "node:assert/strict";
import { OutputStream, frameEnd } from "../src/output-stream.js";

// text reconstructs seamlessly; an event interleaves in order
const got: object[] = [];
const os = new OutputStream((m) => got.push(m), 5);
os.text("Hello");
os.event({ type: "tool_start", name: "Bash" });
os.text("World");
await os.drain();
const text = got.filter((m) => (m as any).type === "text_delta").map((m) => (m as any).text).join("");
test("text reconstructs", () => assert.ok(text === "HelloWorld", JSON.stringify(text)));
const evtIdx = got.findIndex((m) => (m as any).type === "tool_start");
const beforeEvt = got.slice(0, evtIdx).map((m) => (m as any).text).join("");
test("event ordered after first block", () => assert.ok(beforeEvt === "Hello", JSON.stringify(beforeEvt)));

// clear() drops everything pending
const got2: object[] = [];
const os2 = new OutputStream((m) => got2.push(m), 5);
os2.text("this is a long string that will not all flush at once");
os2.clear();
await new Promise((r) => setTimeout(r, 40));
test("clear stops output", () => assert.ok(got2.length <= 2, `emitted ${got2.length} before clear`));

// emoji not split across frames (surrogate pairs stay intact per frame)
const got3: string[] = [];
const os3 = new OutputStream((m) => got3.push((m as any).text), 5);
os3.text("🎉🎊🥳🚀✨");
await os3.drain();
const joined = got3.join("");
test("emoji intact", () => assert.ok(joined === "🎉🎊🥳🚀✨" && got3.every((s) => !s.includes("�")), JSON.stringify(joined)));

// frameEnd: frames end at word boundaries so a word never spans two frames.
test("frameEnd extends to finish a word longer than step (no split)", () => {
  const chars = [..."hello world"]; // step 3 lands mid-"hello"
  assert.equal(chars.slice(0, frameEnd(chars, 0, 3)).join(""), "hello "); // whole word + its space
});

test("frameEnd returns the whole remainder on the last frame", () => {
  const chars = [..."ab cd"];
  assert.equal(frameEnd(chars, 0, 99), 5); // beyond end → whole
});

test("frameEnd keeps a long word whole when its space is within reach", () => {
  const chars = [..."supercalifragilistic more"]; // 20-char word, then a space (within MAX_WORD_EXTEND)
  assert.equal(chars.slice(0, frameEnd(chars, 0, 5)).join(""), "supercalifragilistic "); // whole word + space
});

test("frameEnd does NOT extend a spaceless run (CJK/long token) — keeps step pacing", () => {
  const chars = [..."这是一段没有空格的中文长文本会被逐步分帧而不是一次性蹦出来"]; // no spaces
  assert.equal(frameEnd(chars, 0, 5), 5); // no space within reach → raw step boundary, still paced
  const url = [..."https://example.com/a/very/long/path/that/has/no/spaces/at/all/here"];
  assert.equal(frameEnd(url, 0, 6), 6); // long token also paced, not one burst
});

test("streaming a spaced sentence never splits a word across frames", async () => {
  const parts: string[] = [];
  const os = new OutputStream((m) => parts.push((m as { text?: string }).text ?? ""), 1);
  const sentence = "the quick brown fox jumps over the lazy dog and runs away";
  os.text(sentence);
  await os.drain();
  assert.equal(parts.join(""), sentence); // lossless
  // every frame except the last ends at whitespace (or is a whole long token with none)
  for (const p of parts.slice(0, -1)) {
    if (/\s/.test(p)) assert.ok(/\s$/.test(p), `frame not ending at a boundary: ${JSON.stringify(p)}`);
  }
});

// flush() preserves order and releases pending text immediately.
const got4: object[] = [];
const os4 = new OutputStream((m) => got4.push(m), 50);
os4.text("abcdef");
os4.event({ type: "tool_end", name: "Bash" });
os4.text("ghijkl");
await new Promise((r) => setTimeout(r, 5));
os4.flush();
const got4Text = got4.filter((m) => (m as any).type === "text_delta").map((m) => (m as any).text).join("");
const got4EventIdx = got4.findIndex((m) => (m as any).type === "tool_end");
test("flush reconstructs text", () => assert.ok(got4Text === "abcdefghijkl", JSON.stringify(got4Text)));
test("flush keeps event order", () => assert.ok(got4EventIdx > 0 && got4EventIdx < got4.length - 1, JSON.stringify(got4)));
