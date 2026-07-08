import { test } from "node:test";
import assert from "node:assert/strict";
import { emit, getMessages } from "../src/sse.js";

// emit buffers into a per-session ring; getMessages(after) replays from it. These
// are what a reconnecting client is served from (no live client is attached here).

test("emit buffers with incrementing ids; getMessages(after) filters by id", () => {
  const sid = "test-sse-basic";
  emit(sid, { type: "text_delta", text: "a" });
  emit(sid, { type: "text_delta", text: "b" });
  emit(sid, { type: "result" });
  const all = getMessages(sid, 0);
  assert.deepEqual(
    all.map((m) => (m as { id: number }).id),
    [1, 2, 3],
  );
  assert.equal((all[0] as { type: string }).type, "text_delta");
  assert.deepEqual(
    getMessages(sid, 1).map((m) => (m as { id: number }).id),
    [2, 3], // only id > 1
  );
});

test("getMessages for an unknown session is empty", () => {
  assert.deepEqual(getMessages("test-sse-unknown", 0), []);
});

test("the ring buffer caps at 500 per session, dropping the oldest", () => {
  const sid = "test-sse-cap";
  for (let i = 0; i < 550; i++) emit(sid, { type: "text_delta", text: String(i) });
  const all = getMessages(sid, 0);
  assert.equal(all.length, 500); // MAX_MESSAGES_PER_SESSION
  assert.equal((all[0] as { id: number }).id, 51); // first 50 evicted, ids 51..550 remain
});
