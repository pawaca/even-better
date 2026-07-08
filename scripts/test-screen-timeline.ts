import { test } from "node:test";
import assert from "node:assert/strict";
import { ScreenTimeline } from "../src/screen-timeline.js";
import type { AgentEvent } from "../src/spine.js";

// Drive ScreenTimeline.poll() off scripted screens (last screen repeats). The
// diff/volatile/normalize primitives have their own suite (test-diff-unit); this
// covers the poll() wrapper: prime-without-emit, then diff-emit new lines.
const scripted = (screens: string[]): ScreenTimeline => {
  let i = 0;
  return new ScreenTimeline({
    read: async () => screens[Math.min(i++, screens.length - 1)],
    windowLines: 40,
  });
};
const texts = (evs: AgentEvent[]): string[] => evs.map((e) => (e as { text: string }).text);

test("the first poll primes the baseline and emits nothing", async () => {
  const s = scripted(["line-1\nline-2"]);
  assert.deepEqual(await s.poll(), []); // content already on screen at attach is not replayed
});

test("a newly-added line is emitted as one say event", async () => {
  const s = scripted(["a\nb", "a\nb\nc"]);
  await s.poll(); // prime a, b
  assert.deepEqual(texts(await s.poll()), ["c"]);
});

test("an unchanged screen emits nothing on the next poll", async () => {
  const s = scripted(["a\nb", "a\nb\nc"]);
  await s.poll();
  await s.poll(); // emit c
  assert.deepEqual(await s.poll(), []); // no new lines
});
