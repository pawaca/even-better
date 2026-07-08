import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bareSession,
  isStaleZombie,
  foldHookSessions,
  type HookSessionsFile,
  type SurfaceMeta,
} from "../src/cmux.js";

const UUID = "019f3c39-6bc3-7310-b4e1-6aef5d500810";
const UUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ── bareSession: normalize prefixed/bare session ids to the trailing UUID ──
test("bareSession strips a source prefix from a uuid", () => {
  assert.equal(bareSession(`claude-${UUID}`), UUID);
  assert.equal(bareSession(`codex-${UUID}`), UUID);
});
test("bareSession passes a bare uuid through", () => {
  assert.equal(bareSession(UUID), UUID);
});
test("bareSession falls back to a leading-source strip for non-uuid ids", () => {
  assert.equal(bareSession("foo-bar"), "bar");
  assert.equal(bareSession("plain"), "plain");
});

// ── isStaleZombie: dead pid + not restorable = hide; isAlive is injectable ──
const alive = (pid: number): boolean => pid === 100; // 100 alive, everything else dead
test("isStaleZombie: an alive pid is not a zombie", () => {
  assert.equal(isStaleZombie({ pid: 100 }, alive), false);
});
test("isStaleZombie: a dead pid that is not restorable is a zombie", () => {
  assert.equal(isStaleZombie({ pid: 200, isRestorable: false }, alive), true);
});
test("isStaleZombie: a dead pid that IS restorable is kept (hibernated)", () => {
  assert.equal(isStaleZombie({ pid: 200, isRestorable: true }, alive), false);
});
test("isStaleZombie: an entry with no pid is not a zombie", () => {
  assert.equal(isStaleZombie({ isRestorable: false }, alive), false);
});

// ── foldHookSessions: build the routing maps from a parsed hook file ──
const fold = (data: HookSessionsFile) => {
  const out = {
    surfaceMeta: new Map<string, SurfaceMeta>(),
    sessionToSurface: new Map<string, string>(),
    workspaceToSurface: new Map<string, string>(),
  };
  foldHookSessions("codex", data, out, alive);
  return out;
};

test("fold: a live active session maps surface, session, and workspace", () => {
  const out = fold({
    activeSessionsBySurface: { s1: { sessionId: UUID } },
    sessions: { [UUID]: { pid: 100, cwd: "/w", workspaceId: "w1" } },
  });
  assert.equal(out.surfaceMeta.get("s1")?.session, UUID);
  assert.equal(out.surfaceMeta.get("s1")?.cwd, "/w");
  assert.equal(out.sessionToSurface.get(UUID), "s1");
  assert.equal(out.workspaceToSurface.get("w1"), "s1");
});

test("fold: a stale zombie in the active index is skipped", () => {
  const out = fold({
    activeSessionsBySurface: { s1: { sessionId: UUID } },
    sessions: { [UUID]: { pid: 200, isRestorable: false } }, // dead, not restorable
  });
  assert.equal(out.surfaceMeta.size, 0);
});

test("fold: a restorable dead-pid session is kept (hibernated, not a zombie)", () => {
  const out = fold({
    activeSessionsBySurface: { s1: { sessionId: UUID } },
    sessions: { [UUID]: { pid: 200, isRestorable: true } },
  });
  assert.equal(out.surfaceMeta.get("s1")?.session, UUID);
});

test("fold: a --command session (only in sessions, pid-alive) is mapped", () => {
  const out = fold({ sessions: { [UUID_B]: { surfaceId: "s2", pid: 100 } } });
  assert.equal(out.surfaceMeta.get("s2")?.session, UUID_B);
});

test("fold: a --command session with a dead pid is dropped", () => {
  const out = fold({ sessions: { [UUID_B]: { surfaceId: "s2", pid: 200 } } });
  assert.equal(out.surfaceMeta.size, 0);
});

test("fold: a restorable session reachable only via the workspace index is mapped", () => {
  // pid dead so the sessions loop skips it; restorable so the workspace loop keeps it.
  const out = fold({
    activeSessionsByWorkspace: { w1: { sessionId: UUID } },
    sessions: { [UUID]: { surfaceId: "s3", pid: 200, isRestorable: true } },
  });
  assert.equal(out.surfaceMeta.get("s3")?.session, UUID);
});

test("fold: first writer per surface wins (active over the sessions loop)", () => {
  const out = fold({
    activeSessionsBySurface: { s1: { sessionId: UUID } },
    sessions: { [UUID]: { pid: 100 }, [UUID_B]: { surfaceId: "s1", pid: 100 } },
  });
  assert.equal(out.surfaceMeta.get("s1")?.session, UUID); // active's session, not UUID_B
});
