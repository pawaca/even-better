import { test } from "node:test";
import assert from "node:assert/strict";
import { backstopOnPrompt } from "../src/hook-backstop.js";
import type { BackstopState } from "../src/hook-backstop.js";

const st = (o: Partial<BackstopState> = {}): BackstopState => ({
  hookActive: true,
  appState: "idle",
  ...o,
});

test("backstopOnPrompt: a prompt while idle (self-hook) re-opens busy", () => {
  assert.equal(backstopOnPrompt(st({ appState: "idle" })), "busy");
});

test("backstopOnPrompt: inert off the self-hook path", () => {
  assert.equal(backstopOnPrompt(st({ appState: "idle", hookActive: false })), null);
});

test("backstopOnPrompt: never disturbs a live busy/awaiting turn", () => {
  assert.equal(backstopOnPrompt(st({ appState: "busy" })), null);
  assert.equal(backstopOnPrompt(st({ appState: "awaiting" })), null);
});
