import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStatus, HookTurnTracker } from "../src/hook-fsm.js";
import type { HookReport } from "../src/hook-report.js";

function rep(event: string, seq: number, extra: Partial<HookReport> = {}): HookReport {
  return { agent: "claude", mux: "cmux", paneId: "P", event, seq, ...extra };
}

test("classifyStatus maps each event per the table", () => {
  assert.equal(classifyStatus(rep("UserPromptSubmit", 1)), "busy");
  assert.equal(classifyStatus(rep("Stop", 1)), "idle");
  assert.equal(classifyStatus(rep("StopFailure", 1)), "closeError");
  assert.equal(classifyStatus(rep("PermissionRequest", 1)), "awaiting");
  assert.equal(classifyStatus(rep("PreToolUse", 1, { toolName: "AskUserQuestion" })), "awaiting");
  assert.equal(classifyStatus(rep("PreToolUse", 1, { toolName: "ExitPlanMode" })), "awaiting");
  assert.equal(classifyStatus(rep("PreToolUse", 1, { toolName: "Bash" })), "busy"); // ordinary tool
  assert.equal(classifyStatus(rep("PreToolUse", 1)), "busy"); // no tool name → busy
  for (const e of ["SessionStart", "PostToolUse", "PreCompact", "PostCompact", "SubagentStart", "SubagentStop", "Notification"]) {
    assert.equal(classifyStatus(rep(e, 1)), null, e);
  }
});

test("tracker: an in-order turn goes busy → (stays busy) → idle", () => {
  const t = new HookTurnTracker();
  assert.equal(t.apply(rep("UserPromptSubmit", 100)).status, "busy");
  assert.equal(t.apply(rep("PreToolUse", 150, { toolName: "Bash" })).status, undefined); // already busy
  assert.equal(t.apply(rep("Stop", 200)).status, "idle");
  assert.equal(t.current(), "idle");
});

test("tracker: a late (lower-seq) UserPromptSubmit after Stop stays idle", () => {
  const t = new HookTurnTracker();
  t.apply(rep("Stop", 200));
  assert.equal(t.apply(rep("UserPromptSubmit", 100)).status, undefined); // stale — superseded
  assert.equal(t.current(), "idle");
});

test("tracker: a new-turn UserPromptSubmit (higher seq) after Stop opens the turn", () => {
  const t = new HookTurnTracker();
  t.apply(rep("Stop", 200));
  assert.equal(t.apply(rep("UserPromptSubmit", 300)).status, "busy");
});

test("tracker: a Stop with no prior start still closes to idle (close-unopened)", () => {
  const t = new HookTurnTracker();
  assert.equal(t.apply(rep("Stop", 50)).status, "idle");
});

test("tracker: a stale (lower-seq) Stop after a new busy is ignored", () => {
  const t = new HookTurnTracker();
  t.apply(rep("UserPromptSubmit", 300));
  assert.equal(t.apply(rep("Stop", 250)).status, undefined); // stale
  assert.equal(t.current(), "busy");
});

test("tracker: an unchanged status is not re-emitted", () => {
  const t = new HookTurnTracker();
  t.apply(rep("UserPromptSubmit", 100));
  assert.equal(t.apply(rep("UserPromptSubmit", 110)).status, undefined);
});

test("tracker: extracts session id + transcript path from any report, regardless of status", () => {
  const t = new HookTurnTracker();
  const e = t.apply(rep("SessionStart", 10, { sessionId: "abc", transcriptPath: "/x.jsonl" }));
  assert.equal(e.sessionId, "abc");
  assert.equal(e.transcriptPath, "/x.jsonl");
  assert.equal(e.status, undefined); // SessionStart carries no status
});

test("tracker: stale (lower-seq) session metadata is ignored after a newer SessionStart", () => {
  const t = new HookTurnTracker();
  t.apply(rep("SessionStart", 300, { sessionId: "new", transcriptPath: "/new.jsonl" }));
  const e = t.apply(rep("Stop", 200, { sessionId: "old", transcriptPath: "/old.jsonl" })); // delayed old session
  assert.equal(e.sessionId, undefined);
  assert.equal(e.transcriptPath, undefined);
});

test("tracker: a stale old-session status is ignored after a newer SessionStart", () => {
  const t = new HookTurnTracker();
  t.apply(rep("UserPromptSubmit", 200, { sessionId: "old" })); // old session goes busy
  t.apply(rep("SessionStart", 300, { sessionId: "new" })); // new session boundary
  const e = t.apply(rep("PermissionRequest", 250, { sessionId: "old" })); // delayed old-session status
  assert.equal(e.status, undefined); // must not drive the new session's UI
});

test("tracker: a real SessionStart recovers from an initial stale higher-seq old-session report", () => {
  const t = new HookTurnTracker();
  t.apply(rep("Stop", 350, { sessionId: "old" })); // first report is a delayed old-session status, high seq
  t.apply(rep("SessionStart", 300, { sessionId: "new" })); // the real new SessionStart, lower seq
  const e = t.apply(rep("UserPromptSubmit", 400, { sessionId: "new" }));
  assert.equal(e.status, "busy"); // recovered onto the new session
});

test("tracker: an older SessionStart does not switch back after a newer one", () => {
  const t = new HookTurnTracker();
  t.apply(rep("SessionStart", 300, { sessionId: "new" }));
  const e = t.apply(rep("SessionStart", 250, { sessionId: "old" })); // delayed older SessionStart
  assert.equal(e.sessionId, undefined); // must not switch back
});

test("tracker: a delayed higher-seq old-session report does not switch back (only SessionStart switches)", () => {
  const t = new HookTurnTracker();
  t.apply(rep("SessionStart", 100, { sessionId: "old" }));
  t.apply(rep("SessionStart", 300, { sessionId: "new" })); // switched to new
  const e = t.apply(rep("Stop", 350, { sessionId: "old" })); // delayed old-session hook, higher seq, not a SessionStart
  assert.equal(e.status, undefined); // must not flip back / drive UI
  assert.equal(e.sessionId, undefined); // old transcript not surfaced
});

test("tracker: a same-session non-status report doesn't fence out a lower-seq id-less status", () => {
  const t = new HookTurnTracker();
  t.apply(rep("SessionStart", 100, { sessionId: "s" }));
  t.apply(rep("UserPromptSubmit", 150, { sessionId: "s" })); // busy
  t.apply(rep("PostToolUse", 300, { sessionId: "s" })); // same session, no status, high seq, early
  const e = t.apply(rep("Stop", 250)); // same-session id-less Stop, lower seq
  assert.equal(e.status, "idle"); // must still close — same session
});

test("tracker: an id-less stale status from before a session change is rejected", () => {
  const t = new HookTurnTracker();
  t.apply(rep("SessionStart", 300, { sessionId: "new" }));
  const e = t.apply(rep("Stop", 250)); // id-less, older than the new session's start
  assert.equal(e.status, undefined);
});

test("tracker: an id-less status at/after the current session applies", () => {
  const t = new HookTurnTracker();
  t.apply(rep("SessionStart", 300, { sessionId: "new" }));
  assert.equal(t.apply(rep("UserPromptSubmit", 350)).status, "busy"); // id-less but current
});

test("tracker: subagent events never touch the main pane's session or status", () => {
  const t = new HookTurnTracker();
  t.apply(rep("UserPromptSubmit", 100, { sessionId: "main" })); // main session busy
  const e = t.apply(rep("SubagentStop", 200, { sessionId: "sub", transcriptPath: "/sub.jsonl" }));
  assert.equal(e.sessionId, undefined); // subagent metadata not surfaced
  assert.equal(e.transcriptPath, undefined);
  assert.equal(e.status, undefined);
  assert.equal(t.current(), "busy"); // main turn untouched
  assert.equal(t.apply(rep("Stop", 300, { sessionId: "main" })).status, "idle"); // main still closes
});

test("tracker: a same-session out-of-order status is still accepted (no false boundary)", () => {
  const t = new HookTurnTracker();
  t.apply(rep("SubagentStop", 300, { sessionId: "s" })); // ignored non-status, delivered early
  const e = t.apply(rep("UserPromptSubmit", 250, { sessionId: "s" })); // earlier same-session start, delayed
  assert.equal(e.status, "busy"); // same session, just out of order — must still enter busy
});

test("tracker: a current-session status past the boundary still applies", () => {
  const t = new HookTurnTracker();
  t.apply(rep("SessionStart", 300, { sessionId: "new" }));
  assert.equal(t.apply(rep("UserPromptSubmit", 350, { sessionId: "new" })).status, "busy");
});

test("tracker: newer session metadata (higher seq) wins", () => {
  const t = new HookTurnTracker();
  t.apply(rep("SessionStart", 100, { sessionId: "old", transcriptPath: "/old.jsonl" }));
  const e = t.apply(rep("SessionStart", 200, { sessionId: "new", transcriptPath: "/new.jsonl" }));
  assert.equal(e.sessionId, "new");
  assert.equal(e.transcriptPath, "/new.jsonl");
});

test("tracker: StopFailure closes with closeError (latest-wins)", () => {
  const t = new HookTurnTracker();
  t.apply(rep("UserPromptSubmit", 100));
  assert.equal(t.apply(rep("StopFailure", 200)).status, "closeError");
});
