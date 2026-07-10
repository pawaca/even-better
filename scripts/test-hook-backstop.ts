import { test } from "node:test";
import assert from "node:assert/strict";
import { backstopOnContent, backstopOnQuiescence, QUIESCENCE_MS } from "../src/hook-backstop.js";
import type { BackstopState } from "../src/hook-backstop.js";

const st = (o: Partial<BackstopState> = {}): BackstopState => ({
  hookActive: true,
  appState: "idle",
  turnHookDriven: false,
  idlePending: false,
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

test("backstopOnQuiescence: closes a backstop-opened busy turn after the window", () => {
  assert.equal(backstopOnQuiescence(st({ appState: "busy" }), QUIESCENCE_MS + 1), "idle");
});

test("backstopOnQuiescence: waits for sustained quiescence", () => {
  assert.equal(backstopOnQuiescence(st({ appState: "busy" }), QUIESCENCE_MS - 1), null);
  assert.equal(backstopOnQuiescence(st({ appState: "busy" }), 0), null);
});

test("backstopOnQuiescence: never closes a HOOK-driven turn (its Stop owns the close)", () => {
  assert.equal(
    backstopOnQuiescence(st({ appState: "busy", turnHookDriven: true }), QUIESCENCE_MS * 10),
    null,
  );
});

test("backstopOnQuiescence: doesn't stack on an already-pending idle close", () => {
  assert.equal(
    backstopOnQuiescence(st({ appState: "busy", idlePending: true }), QUIESCENCE_MS + 1),
    null,
  );
});

test("backstopOnQuiescence: inert off the self-hook path and when not busy", () => {
  assert.equal(backstopOnQuiescence(st({ appState: "busy", hookActive: false }), QUIESCENCE_MS * 10), null);
  assert.equal(backstopOnQuiescence(st({ appState: "idle" }), QUIESCENCE_MS * 10), null);
  assert.equal(backstopOnQuiescence(st({ appState: "awaiting" }), QUIESCENCE_MS * 10), null);
});
