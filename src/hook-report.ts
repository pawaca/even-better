// The normalized report our installed agent hook (`assets/even-better-hook.sh`)
// sends over the local socket, one per Claude/Codex lifecycle event. Kept pure and
// parser-only here so the routing/mapping logic stays unit-testable without a
// running agent. See docs/HOOK-MIGRATION.md.

export type Mux = "cmux" | "herdr" | "tmux" | "unknown";

export interface HookReport {
  agent: "claude" | "codex";
  mux: Mux;
  /** Pane id resolved by the hook from the mux's pane-id env var — equals
   *  even-better's `paneId` (cmux `CMUX_SURFACE_ID`, herdr `HERDR_PANE_ID`). */
  paneId: string;
  /** The agent's `hook_event_name` (SessionStart, UserPromptSubmit, Stop, …). */
  event: string;
  sessionId?: string;
  /** Present on most Claude events; Codex documents it as string|null, so callers
   *  must fall back to the transcript scan when absent (docs/HOOK-MIGRATION.md). */
  transcriptPath?: string;
  cwd?: string;
  /** Best-effort agent pid (the hook's parent), for the PID correlation fallback. */
  pid?: number;
  /** Wall-clock ms (informational). */
  ts?: number;
  /** Per-pane monotonic sequence (the hook stamps `time.time_ns()`); the endpoint
   *  orders lifecycle events by this since reports are detached (may arrive out of
   *  order). */
  seq: number;
  /** `tool_name` on PreToolUse — drives the AskUserQuestion/ExitPlanMode special
   *  case (every other PreToolUse is ordinary busy work). */
  toolName?: string;
}

/** Parse one socket line into a HookReport, or null if malformed / missing the
 *  routing essentials (agent, paneId, event). Pure — never throws. */
export function parseHookReport(line: string): HookReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const r = parsed as Record<string, unknown>;

  const agent = r.agent === "codex" ? "codex" : r.agent === "claude" ? "claude" : null;
  const paneId = typeof r.paneId === "string" ? r.paneId : "";
  const event = typeof r.event === "string" ? r.event : "";
  // paneId may be empty on an env-less (resumed/subprocess) hook — the pid fallback
  // in resolvePaneId recovers it, so only agent + event are structurally required.
  if (!agent || !event) return null;

  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const mux: Mux =
    r.mux === "cmux" || r.mux === "herdr" || r.mux === "tmux" ? r.mux : "unknown";

  return {
    agent,
    mux,
    paneId,
    event,
    seq: num(r.seq) ?? 0,
    sessionId: str(r.sessionId),
    transcriptPath: str(r.transcriptPath),
    cwd: str(r.cwd),
    pid: num(r.pid),
    ts: num(r.ts),
    toolName: str(r.toolName),
  };
}

/** Resolve a report to a known pane id: prefer the env-derived `paneId` (== the
 *  mux paneId); fall back to the hook's `pid` matching exactly one pane's pid when
 *  the env id is absent/unknown (resume/subprocess — cmux's "a pid lives in exactly
 *  one surface"). Never guesses the focused pane. Pure.
 *
 *  (Phase 1 covers cmux/herdr, where the mux's pane record carries the agent pid,
 *  so pid equality suffices; tmux's `pane_pid` is a shell ancestor — Phase 2 will
 *  match by process tree.) */
export function resolvePaneId(
  report: Pick<HookReport, "paneId" | "pid">,
  panes: ReadonlyArray<{ paneId: string; pid?: number }>,
): string | null {
  if (report.paneId && panes.some((p) => p.paneId === report.paneId)) return report.paneId;
  if (report.pid !== undefined) {
    const byPid = panes.filter((p) => p.pid !== undefined && p.pid === report.pid);
    if (byPid.length === 1) return byPid[0].paneId;
  }
  return null;
}
