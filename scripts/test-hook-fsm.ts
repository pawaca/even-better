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

test("tracker: StopFailure closes with closeError (latest-wins)", () => {
  const t = new HookTurnTracker();
  t.apply(rep("UserPromptSubmit", 100));
  assert.equal(t.apply(rep("StopFailure", 200)).status, "closeError");
});

test("tracker: session id + transcript path pass through from any report", () => {
  const t = new HookTurnTracker();
  const e = t.apply(rep("SessionStart", 10, { sessionId: "abc", transcriptPath: "/x.jsonl" }));
  assert.equal(e.sessionId, "abc");
  assert.equal(e.transcriptPath, "/x.jsonl");
  assert.equal(e.status, undefined); // SessionStart carries no status
  assert.equal(t.currentSession(), "abc");
});

test("tracker: an unchanged session id is surfaced once, not re-emitted", () => {
  const t = new HookTurnTracker();
  assert.equal(t.apply(rep("SessionStart", 10, { sessionId: "abc" })).sessionId, "abc");
  assert.equal(t.apply(rep("UserPromptSubmit", 20, { sessionId: "abc" })).sessionId, undefined);
  assert.equal(t.apply(rep("Stop", 30, { sessionId: "abc" })).sessionId, undefined);
  assert.equal(t.currentSession(), "abc");
});

test("tracker: a genuine session change (higher seq) is surfaced for retarget", () => {
  const t = new HookTurnTracker();
  t.apply(rep("SessionStart", 10, { sessionId: "abc" }));
  const e = t.apply(rep("SessionStart", 20, { sessionId: "def", transcriptPath: "/def.jsonl" }));
  assert.equal(e.sessionId, "def"); // switched — surface it
  assert.equal(e.transcriptPath, "/def.jsonl");
  assert.equal(t.currentSession(), "def");
});

test("tracker: a stale (lower-seq) session id does not revert the session", () => {
  const t = new HookTurnTracker();
  t.apply(rep("SessionStart", 20, { sessionId: "def" }));
  assert.equal(t.apply(rep("UserPromptSubmit", 10, { sessionId: "abc" })).sessionId, undefined);
  assert.equal(t.currentSession(), "def");
});

test("tracker: a subagent session never becomes the main session", () => {
  const t = new HookTurnTracker();
  t.apply(rep("SessionStart", 10, { sessionId: "main" }));
  assert.equal(t.apply(rep("SubagentStart", 20, { sessionId: "sub" })).sessionId, undefined);
  assert.equal(t.currentSession(), "main");
  // a later main-session report at higher seq still surfaces only on a real change
  assert.equal(t.apply(rep("Stop", 30, { sessionId: "main" })).sessionId, undefined);
  assert.equal(t.currentSession(), "main");
});

test("tracker: subagent events never touch the main pane's status or transcript", () => {
  const t = new HookTurnTracker();
  t.apply(rep("UserPromptSubmit", 100, { sessionId: "main" })); // main session busy
  const e = t.apply(rep("SubagentStop", 200, { sessionId: "sub", transcriptPath: "/sub.jsonl" }));
  assert.equal(e.sessionId, undefined); // subagent metadata not surfaced
  assert.equal(e.transcriptPath, undefined);
  assert.equal(e.status, undefined);
  assert.equal(t.current(), "busy"); // main turn untouched
  assert.equal(t.apply(rep("Stop", 300)).status, "idle"); // main still closes
});
