import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHookReport, resolvePaneId } from "../src/hook-report.js";

test("parseHookReport parses a valid report", () => {
  const r = parseHookReport(
    JSON.stringify({
      agent: "claude",
      mux: "cmux",
      paneId: "S1",
      event: "Stop",
      sessionId: "abc",
      seq: 123,
      pid: 42,
      toolName: "Bash",
    }),
  );
  assert.ok(r);
  assert.equal(r.agent, "claude");
  assert.equal(r.mux, "cmux");
  assert.equal(r.paneId, "S1");
  assert.equal(r.event, "Stop");
  assert.equal(r.seq, 123);
  assert.equal(r.sessionId, "abc");
  assert.equal(r.pid, 42);
  assert.equal(r.toolName, "Bash");
});

test("parseHookReport rejects malformed lines and missing essentials", () => {
  assert.equal(parseHookReport("not json"), null);
  assert.equal(parseHookReport("[]"), null);
  // note: a missing paneId is NOT rejected — it's valid for the env-less/pid path.
  assert.equal(parseHookReport(JSON.stringify({ paneId: "S1", event: "Stop" })), null); // no agent
  assert.equal(parseHookReport(JSON.stringify({ agent: "x", paneId: "S1", event: "Stop" })), null); // bad agent
  assert.equal(parseHookReport(JSON.stringify({ agent: "claude", paneId: "S1" })), null); // no event
});

test("parseHookReport defaults mux/seq and drops empty/null optionals", () => {
  const r = parseHookReport(
    JSON.stringify({ agent: "codex", paneId: "S1", event: "SessionStart", sessionId: "", transcriptPath: null }),
  );
  assert.ok(r);
  assert.equal(r.mux, "unknown");
  assert.equal(r.seq, 0);
  assert.equal(r.sessionId, undefined);
  assert.equal(r.transcriptPath, undefined);
});

test("parseHookReport accepts an env-less report (empty paneId) carrying a pid", () => {
  const r = parseHookReport(JSON.stringify({ agent: "claude", event: "SessionStart", paneId: "", pid: 77, seq: 5 }));
  assert.ok(r);
  assert.equal(r.paneId, "");
  assert.equal(r.pid, 77);
});

test("resolvePaneId prefers a known env paneId over pid", () => {
  const panes = [{ paneId: "S1", pid: 1 }, { paneId: "S2", pid: 9 }];
  assert.equal(resolvePaneId({ paneId: "S1", pid: 9 }, panes), "S1");
});

test("resolvePaneId falls back to a unique pid when the env id is unknown or empty", () => {
  const panes = [{ paneId: "S1", pid: 1 }, { paneId: "S2", pid: 9 }];
  assert.equal(resolvePaneId({ paneId: "STALE", pid: 9 }, panes), "S2");
  assert.equal(resolvePaneId({ paneId: "", pid: 9 }, panes), "S2"); // env-less report
});

test("resolvePaneId returns null when ambiguous or unmatched (never the focused pane)", () => {
  assert.equal(resolvePaneId({ paneId: "STALE", pid: 9 }, [{ paneId: "S1", pid: 9 }, { paneId: "S2", pid: 9 }]), null);
  assert.equal(resolvePaneId({ paneId: "STALE" }, [{ paneId: "S1", pid: 1 }]), null);
});
