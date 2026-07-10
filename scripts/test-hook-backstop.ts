import { test } from "node:test";
import assert from "node:assert/strict";
import { backstopOnContent } from "../src/hook-backstop.js";
import type { BackstopState } from "../src/hook-backstop.js";

const st = (o: Partial<BackstopState> = {}): BackstopState => ({
  hookActive: true,
  appState: "idle",
  closing: false,
  ...o,
});

test("backstopOnContent: content while idle (self-hook) re-opens busy", () => {
  assert.equal(backstopOnContent(st({ appState: "idle" })), "busy");
});

test("backstopOnContent: inert off the self-hook path", () => {
  assert.equal(backstopOnContent(st({ appState: "idle", hookActive: false })), null);
});

test("backstopOnContent: never disturbs a live busy/awaiting turn", () => {
  assert.equal(backstopOnContent(st({ appState: "busy" })), null);
  assert.equal(backstopOnContent(st({ appState: "awaiting" })), null);
});

test("backstopOnContent: doesn't re-open while a close is still draining", () => {
  // state flips to idle before emitTurnResult's 1.1s drain — trailing content in that window
  // is the closing turn's tail, not a new turn.
  assert.equal(backstopOnContent(st({ appState: "idle", closing: true })), null);
});
