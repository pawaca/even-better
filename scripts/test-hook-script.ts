import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHookEndpoint } from "../src/hook-endpoint.js";
import type { HookReport } from "../src/hook-report.js";

const SCRIPT = join(dirname(dirname(fileURLToPath(import.meta.url))), "assets", "even-better-hook.sh");

function haveTool(cmd: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// The hook script shells out to python3 + sh; skip on a runner without them.
const runnable = haveTool("python3") && haveTool("sh");

/** Run the hook with a payload on stdin + the given env; resolve when it exits. */
function runHook(env: Record<string, string>, payload: string): Promise<number> {
  return new Promise((resolve) => {
    const child = execFile("sh", [SCRIPT, "claude"], { env: { ...process.env, ...env } }, () => {});
    child.on("close", (code) => resolve(code ?? 0));
    child.stdin?.end(payload);
  });
}

test("hook script reports a parsed event to the endpoint with the env pane id", { skip: !runnable }, async () => {
  const sock = join(mkdtempSync(join(tmpdir(), "eb-hook-")), "h.sock");
  process.env.EVEN_BETTER_HOOK_SOCKET = sock;
  let resolveReport: (r: HookReport) => void = () => {};
  const got = new Promise<HookReport>((res) => {
    resolveReport = res;
  });
  const server = await startHookEndpoint((r) => resolveReport(r)); // resolves once bound
  try {
    await runHook(
      { EVEN_BETTER_HOOK_SOCKET: sock, CMUX_SURFACE_ID: "TESTPANE" },
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "sess-1", tool_name: null }),
    );
    const r = await got;
    assert.equal(r.paneId, "TESTPANE");
    assert.equal(r.mux, "cmux");
    assert.equal(r.agent, "claude");
    assert.equal(r.event, "UserPromptSubmit");
    assert.equal(r.sessionId, "sess-1");
    assert.ok(r.seq > 0);
  } finally {
    server.close();
  }
});

test("hook exits fast (non-blocking) when the endpoint socket is absent", { skip: !runnable }, async () => {
  const start = Date.now();
  const code = await runHook(
    { EVEN_BETTER_HOOK_SOCKET: join(tmpdir(), "eb-does-not-exist.sock"), CMUX_SURFACE_ID: "P" },
    JSON.stringify({ hook_event_name: "Stop" }),
  );
  const ms = Date.now() - start;
  assert.equal(code, 0); // always exit 0 — never fail the agent's turn
  assert.ok(ms < 1000, `hook took ${ms}ms with no endpoint (should be near-instant)`);
});
