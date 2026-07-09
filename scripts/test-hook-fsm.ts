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

test("tracker: StopFailure closes with closeError (latest-wins)", () => {
  const t = new HookTurnTracker();
  t.apply(rep("UserPromptSubmit", 100));
  assert.equal(t.apply(rep("StopFailure", 200)).status, "closeError");
});
