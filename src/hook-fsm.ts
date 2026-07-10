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

/** What a report yields: a status change (if any, after seq ordering) and/or the
 *  session id + transcript path it carried (for the transcript upgrade). */
export interface HookEffect {
  status?: HookStatus;
  sessionId?: string;
  transcriptPath?: string;
}

/**
 * Per-pane, order-tolerant tracker. Reports are detached, so they can arrive out of
 * order; each carries a monotonic `seq`. Status is resolved **latest-wins by seq**:
 * a status event with a higher seq than the last applied one wins; a stale lower-seq
 * one is ignored. This keeps the final state correct in every ordering — a late
 * `UserPromptSubmit` after `Stop` stays idle, a new-turn `UserPromptSubmit` opens the
 * turn, a `Stop` with no prior start still closes.
 *
 * Status AND session id are both resolved latest-wins by seq. Session id is surfaced
 * only on a real CHANGE — first-seen, or a switch (a `/clear` or resume swapped the
 * pane's jsonl) — so the bridge retargets its transcript tail exactly when the session
 * actually moves; unchanged repeats and stale lower-seq reports are suppressed (a late
 * report can't revert the session). Subagent events are dropped so they never drive the
 * main pane. (A whole turn arriving Stop-first would skip a transient busy indicator;
 * the content still lands via the transcript and the Stage 3b backstop re-derives busy —
 * see the design's "residual" note.)
 */
export class HookTurnTracker {
  private lastStatusSeq = Number.NEGATIVE_INFINITY;
  private status: HookStatus | null = null;
  private lastSessionSeq = Number.NEGATIVE_INFINITY;
  private sessionId: string | null = null;

  apply(report: HookReport): HookEffect {
    const effect: HookEffect = {};

    // Subagent events must NEVER touch the main pane — not its transcript or status
    // (event map + herdr's note). A subagent runs under its own session id.
    if (report.event === "SubagentStart" || report.event === "SubagentStop") return effect;

    // Transcript path passes through (informational; the bridge resolves the file from
    // the session id, so this never drives the tail on its own).
    if (report.transcriptPath) effect.transcriptPath = report.transcriptPath;

    // Session id: latest-wins by seq, surfaced only on a real change (see class note).
    if (report.sessionId && report.seq > this.lastSessionSeq) {
      this.lastSessionSeq = report.seq;
      if (report.sessionId !== this.sessionId) {
        this.sessionId = report.sessionId;
        effect.sessionId = report.sessionId;
      }
    }

    // Status: latest-wins by seq.
    const cls = classifyStatus(report);
    if (cls !== null && report.seq > this.lastStatusSeq) {
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

  /** Current session id (null until the first session-bearing report). */
  currentSession(): string | null {
    return this.sessionId;
  }
}
