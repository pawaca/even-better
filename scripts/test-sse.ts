import { coalesceReplay, emit, sseHandler } from "../src/sse.js";
import type { Request, Response } from "express";

let failed = 0;
const t = (name: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${name}: ${JSON.stringify(got)}`);
};

// consecutive text_delta merge; a non-text event breaks the run; order and the
// first delta's id are preserved.
t(
  "coalesce runs, keep non-text boundaries",
  coalesceReplay([
    { id: 1, msg: { type: "user_prompt", text: "hi" } },
    { id: 2, msg: { type: "text_delta", text: "Hel" } },
    { id: 3, msg: { type: "text_delta", text: "lo" } },
    { id: 4, msg: { type: "tool_start", toolId: "a" } },
    { id: 5, msg: { type: "text_delta", text: "world" } },
  ]),
  [
    { id: 1, msg: { type: "user_prompt", text: "hi" } },
    { id: 2, msg: { type: "text_delta", text: "Hello" } },
    { id: 4, msg: { type: "tool_start", toolId: "a" } },
    { id: 5, msg: { type: "text_delta", text: "world" } },
  ],
);

t("empty buffer", coalesceReplay([]), []);

// a trailing run flushes
t(
  "trailing text flushes",
  coalesceReplay([
    { id: 1, msg: { type: "text_delta", text: "a" } },
    { id: 2, msg: { type: "text_delta", text: "b" } },
  ]),
  [{ id: 1, msg: { type: "text_delta", text: "ab" } }],
);

// no text_delta → passthrough unchanged
t(
  "no text passthrough",
  coalesceReplay([
    { id: 1, msg: { type: "status", state: "idle" } },
    { id: 2, msg: { type: "tool_end", toolId: "a" } },
  ]),
  [
    { id: 1, msg: { type: "status", state: "idle" } },
    { id: 2, msg: { type: "tool_end", toolId: "a" } },
  ],
);

// sseHandler replays the buffered history on a fresh connect WITHOUT needReplay —
// this is the reconnect fix: a returning client rebuilds its view. Mock req/res.
{
  const sid = "test-reconnect-session";
  emit(sid, { type: "user_prompt", text: "hi" });
  emit(sid, { type: "text_delta", text: "He" });
  emit(sid, { type: "text_delta", text: "llo" });
  emit(sid, { type: "tool_start", toolId: "x" });
  emit(sid, { type: "result" });

  const writes: string[] = [];
  let closeCb: (() => void) | undefined;
  const res = {
    setHeader() {},
    flushHeaders() {},
    write(s: string) {
      writes.push(s);
      return true;
    },
    socket: { on() {} },
  } as unknown as Response;
  const req = {
    query: { sessionId: sid }, // note: no needReplay
    headers: {},
    on(ev: string, cb: () => void) {
      if (ev === "close") closeCb = cb;
    },
  } as unknown as Request;

  sseHandler(req, res);
  closeCb?.(); // clear the heartbeat interval so this test can exit

  const replayed = writes
    .filter((w) => w.startsWith("id:"))
    .map((w) => JSON.parse(w.split("data: ")[1].split("\n")[0]));
  t(
    "sseHandler replays coalesced history on plain connect",
    replayed,
    [
      { type: "user_prompt", text: "hi" },
      { type: "text_delta", text: "Hello" },
      { type: "tool_start", toolId: "x" },
      { type: "result" },
    ],
  );
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
