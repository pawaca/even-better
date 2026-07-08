import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlTail, sinceFilter } from "../src/jsonl-tail.js";
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

test("sinceFilter drops older entries, keeps newer and un-timestamped ones", () => {
  const since = Date.parse("2026-01-01T00:00:00Z");
  const filtered = sinceFilter(parse, since);
  assert.deepEqual(filtered(JSON.stringify({ timestamp: "2025-12-31T23:59:59Z" })), []); // older → dropped
  assert.equal(texts(filtered(JSON.stringify({ timestamp: "2026-01-02T00:00:00Z" }))).length, 1); // newer → kept
  assert.equal(texts(filtered(JSON.stringify({ type: "meta" }))).length, 1); // no timestamp → passes through
});

test("sinceFilter with no since is a passthrough (same function)", () => {
  assert.equal(sinceFilter(parse, undefined), parse);
});

test("JsonlTail fromStart caps the read to the last maxReplayBytes", async () => {
  const f = scratch("AAAA\nBBBB\nRECENT\n"); // 17 bytes; last 7 ≈ "RECENT\n"
  const tail = new JsonlTail(f, parse, true, 7);
  const got = texts(await tail.readNew());
  assert.ok(got.includes("RECENT")); // recent tail read
  assert.ok(!got.includes("AAAA") && !got.includes("BBBB")); // old history never read
});
