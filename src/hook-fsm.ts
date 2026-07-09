// Stage 2 of docs/HOOK-MIGRATION.md: the pure event→state layer over hook reports.
// Two pieces, both unit-tested without a running agent and NOT yet wired to the
// bridge (Stage 3 feeds these into the existing turn machine):
//   - classifyStatus: the event→status table.
//   - HookTurnTracker: per-pane, order-tolerant (seq-ordered) status + session.
// The candidate/confirm + IDLE_GRACE_MS debounce live downstream in the bridge;
// this layer only classifies and orders.

import type { HookReport } from "./hook-report.js";

/** Candidate turn status a single hook event maps to. `closeError` = the turn
 *  ended on an API error (Claude `StopFailure`); the bridge closes it (result +
 *  idle). `awaiting` is a *candidate* (the bridge confirms the menu surfaced). */
export type HookStatus = "busy" | "idle" | "awaiting" | "closeError";

/** Map a hook event to its candidate status, or null when it doesn't affect turn
 *  status. Pure. Mirrors the event→state table + the PreToolUse tool-name special
 *  case (only AskUserQuestion/ExitPlanMode are interactive; every other PreToolUse
 *  is ordinary busy work). SessionStart / PostToolUse / compaction / subagent
 *  events carry no status change. */
export function classifyStatus(report: HookReport): HookStatus | null {
  switch (report.event) {
    case "UserPromptSubmit":
      return "busy";
    case "Stop":
      return "idle";
    case "StopFailure":
      return "closeError";
    case "PermissionRequest":
      return "awaiting";
    case "PreToolUse":
      return report.toolName === "AskUserQuestion" || report.toolName === "ExitPlanMode"
        ? "awaiting"
        : "busy";
    default:
      // SessionStart, PostToolUse, PreCompact, PostCompact, SubagentStart,
      // SubagentStop, Notification, … — no turn-status effect.
      return null;
  }
}

/** What a report yields after ordering: a status change (if any, post seq-ordering)
 *  and/or the session id + transcript path it carried (for the transcript upgrade). */
export interface HookEffect {
  status?: HookStatus;
  sessionId?: string;
  transcriptPath?: string;
}

/**
 * Per-pane, order-tolerant tracker. Reports are detached, so they can arrive out of
 * order; each carries a monotonic `seq`. Status is resolved **latest-wins by seq**:
 * a status event with a higher seq than the last applied one wins; a lower-seq
 * (stale) one is ignored. This is *not* naive stale-drop of the event — it keeps the
 * final state correct in every ordering:
 *   - a late `UserPromptSubmit` (lower seq) after a `Stop` ⇒ stays idle (turn ended);
 *   - a new-turn `UserPromptSubmit` (higher seq) after a `Stop` ⇒ opens the turn;
 *   - a `Stop` with no prior start ⇒ closes to idle anyway.
 * (The only cost is skipping a transient busy indicator when a whole turn's events
 * arrive Stop-first — which needs the start report delayed past its own Stop, a
 * turn-duration a local ms socket send does not produce, so it does not occur in
 * practice. Even then the content still lands via the transcript, and Stage 3's
 * periodic transcript-quiescence backstop re-derives busy from that content, so the
 * busy/idle lifecycle is not lost. A short seq reorder buffer is the deferred
 * escalation if it is ever observed. See the design's "residual" note.) Session
 * id/path are extracted (seq-ordered) from any report, independent of status.
 */
export class HookTurnTracker {
  private lastStatusSeq = Number.NEGATIVE_INFINITY;
  private lastSessionSeq = Number.NEGATIVE_INFINITY;
  private status: HookStatus | null = null;

  apply(report: HookReport): HookEffect {
    const effect: HookEffect = {};

    // Session metadata is seq-ordered too: on a pane that switched sessions, a
    // delayed lower-seq report from the *old* session must not return its stale
    // transcript over a newer SessionStart and attach the pane to the old jsonl.
    if ((report.sessionId || report.transcriptPath) && report.seq > this.lastSessionSeq) {
      this.lastSessionSeq = report.seq;
      if (report.sessionId) effect.sessionId = report.sessionId;
      if (report.transcriptPath) effect.transcriptPath = report.transcriptPath;
    }

    const cls = classifyStatus(report);
    // Gate status by the session boundary too: a delayed status from a prior session
    // (seq below the latest session-bearing report) must not drive the new session's
    // UI. The session block above already advanced lastSessionSeq to this report's
    // seq when it is current, so an in-order report passes (seq >= itself) while a
    // stale old-session one (seq < boundary) is dropped.
    if (cls !== null && report.seq > this.lastStatusSeq && report.seq >= this.lastSessionSeq) {
      this.lastStatusSeq = report.seq;
      if (cls !== this.status) {
        this.status = cls;
        effect.status = cls;
      }
    }
    return effect;
  }

  /** Current effective status (null until the first status event). */
  current(): HookStatus | null {
    return this.status;
  }
}
