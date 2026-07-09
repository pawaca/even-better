import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addClaudeHooks,
  removeClaudeHooks,
  hookCommand,
  CLAUDE_EVENTS,
  HOOK_MARKER,
} from "../src/hook-install.js";

const CMD = hookCommand("/home/u/.even-better/even-better-hook.sh", "claude");

// Extract the command strings installed for one event, via unknown-narrowing.
function cmds(settings: Record<string, unknown>, event: string): string[] {
  const hooks = settings.hooks;
  if (typeof hooks !== "object" || hooks === null) return [];
  const arr = (hooks as Record<string, unknown>)[event];
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const block of arr) {
    if (typeof block !== "object" || block === null) continue;
    const inner = (block as { hooks?: unknown }).hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      if (typeof h === "object" && h !== null && typeof (h as { command?: unknown }).command === "string") {
        out.push((h as { command: string }).command);
      }
    }
  }
  return out;
}

test("hookCommand references the script (the uninstall marker)", () => {
  assert.ok(CMD.includes(HOOK_MARKER));
  assert.ok(CMD.endsWith(" claude"));
});

test("addClaudeHooks adds our command to every event without clobbering existing ones", () => {
  const before = {
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "other-tool" }] }] },
    permissions: { allow: [] },
  };
  const after = addClaudeHooks(before, CMD);
  // existing PreToolUse hook preserved, ours appended
  assert.deepEqual(cmds(after, "PreToolUse").sort(), ["other-tool", CMD].sort());
  // installed for every event
  for (const ev of CLAUDE_EVENTS) assert.ok(cmds(after, ev).includes(CMD), `missing on ${ev}`);
  // unrelated keys untouched
  assert.deepEqual(after.permissions, { allow: [] });
});

test("addClaudeHooks is idempotent — re-install never duplicates our block", () => {
  const twice = addClaudeHooks(addClaudeHooks({}, CMD), CMD);
  for (const ev of CLAUDE_EVENTS) {
    const ours = cmds(twice, ev).filter((c) => c.includes(HOOK_MARKER));
    assert.equal(ours.length, 1, `duplicate on ${ev}`);
  }
});

test("removeClaudeHooks strips only ours and round-trips to the original", () => {
  const original = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "other-tool" }] }] } };
  const installed = addClaudeHooks(original, CMD);
  assert.deepEqual(removeClaudeHooks(installed), original);
});

test("removeClaudeHooks drops emptied events and the hooks key when nothing remains", () => {
  const removed = removeClaudeHooks(addClaudeHooks({}, CMD));
  assert.equal(removed.hooks, undefined);
});
