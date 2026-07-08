import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlTail } from "../src/jsonl-tail.js";
import type { AgentEvent } from "../src/spine.js";

// each non-empty line → one `say` event carrying its text, so tests can read it back
const parse = (line: string): AgentEvent[] => [{ t: "say", text: line } as AgentEvent];
const texts = (evs: AgentEvent[]): string[] => evs.map((e) => (e as { text: string }).text);

const scratch = (initial: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "eb-tail-"));
  const f = join(dir, "s.jsonl");
  writeFileSync(f, initial);
  return f;
};

test("JsonlTail starts at EOF — pre-existing content is not replayed", async () => {
  const f = scratch("old-1\nold-2\n");
  const tail = new JsonlTail(f, parse);
  assert.deepEqual(await tail.readNew(), []);
});

test("JsonlTail returns only appended lines, once", async () => {
  const f = scratch("old\n");
  const tail = new JsonlTail(f, parse);
  appendFileSync(f, "new-1\nnew-2\n");
  assert.deepEqual(texts(await tail.readNew()), ["new-1", "new-2"]);
  assert.deepEqual(await tail.readNew(), []); // nothing new on the next poll
});

test("JsonlTail holds back a partial line until its newline arrives", async () => {
  const f = scratch("");
  const tail = new JsonlTail(f, parse);
  appendFileSync(f, "half"); // no trailing newline yet
  assert.deepEqual(await tail.readNew(), []);
  appendFileSync(f, "-done\n");
  assert.deepEqual(texts(await tail.readNew()), ["half-done"]);
});

test("JsonlTail restarts from the end when the file is truncated", async () => {
  const f = scratch("a\nb\n");
  const tail = new JsonlTail(f, parse);
  appendFileSync(f, "c\n");
  await tail.readNew(); // consume c
  writeFileSync(f, ""); // truncate/rotate
  assert.deepEqual(await tail.readNew(), []); // reset, no replay
  appendFileSync(f, "fresh\n");
  assert.deepEqual(texts(await tail.readNew()), ["fresh"]);
});

test("JsonlTail with fromStart replays existing content, then tails", async () => {
  const f = scratch("a\nb\n");
  const tail = new JsonlTail(f, parse, true); // fromStart: read from byte 0
  assert.deepEqual(texts(await tail.readNew()), ["a", "b"]); // the first turn isn't lost
  appendFileSync(f, "c\n");
  assert.deepEqual(texts(await tail.readNew()), ["c"]); // then it tails new lines
});
