// Stage 3b of docs/HOOK-MIGRATION.md: the CONSERVATIVE transcript-quiescence backstop.
// A safety net for the self-hook status path — it recovers the two lifecycle residuals the
// hook path deliberately doesn't repair (see bridge onHookReport):
//   - a dropped `UserPromptSubmit` / a whole turn delivered `Stop`-first: the transcript
//     shows new content while we wrongly think idle → re-open busy.
//   - a backstop-opened turn (or a dropped `Stop` on one) that never closes: sustained
//     transcript quiescence → close idle.
// It is deliberately narrow: it only ever acts on the self-hook path (`hookActive`), only
// re-opens from a SETTLED idle, and only closes a turn NO hook drove — a hook-driven turn
// is closed by its own `Stop`, never second-guessed. Pure so the policy is unit-tested
// without a running agent; the bridge owns the timers/state it reads.

/** The minimal bridge state the backstop policy reads. */
export interface BackstopState {
  /** SELF_HOOK is driving this pane (the per-pane cutover fired). Off ⇒ the backstop is
   *  inert, so the default path is unaffected. */
  hookActive: boolean;
  /** The bridge's current app state. */
  appState: "idle" | "busy" | "awaiting";
  /** The current busy turn was opened by THIS backstop (content re-opened a settled idle),
   *  not by a hook / app prompt / mux. Only such a turn is closed by quiescence — a normally
   *  opened turn is closed by its own Stop and never second-guessed. */
  turnBackstopOpened: boolean;
  /** An idle-grace close is already scheduled — don't stack another. */
  idlePending: boolean;
  /** A turn close is in progress: `state` has flipped to idle but `emitTurnResult` is still
   *  draining its final text (a ~1.1s transcript catch-up wait). Content during that window
   *  is the CLOSING turn's tail, not a new turn — so the backstop must not re-open on it. */
  closing: boolean;
  /** A tool is mid-run: `pendingTools` holds a `tool_start` with no matching `tool_end`.
   *  A long tool (e.g. a 60s Bash) produces no transcript activity while it runs, so
   *  time-since-content alone would falsely look quiescent — don't close while one is open. */
  toolsPending: boolean;
}

/** How long the transcript must stay quiet before the backstop closes a turn NO hook
 *  drove. Deliberately GENEROUS — far larger than a plausible silent gap within a live
 *  turn (deep reasoning, a long-running tool) so a real turn is never closed early; it
 *  only bounds how long a dropped-hook turn lingers as busy. */
export const QUIESCENCE_MS = 30_000;

/** On a transcript CONTENT event: should the backstop re-open a turn the hooks missed?
 *  Only from a settled idle on the self-hook path — content while idle means the
 *  `UserPromptSubmit` (or a Stop-first whole turn) was dropped. Never touches a live
 *  busy/awaiting, so it can't disturb a normal hook-driven turn (which goes busy before
 *  its content arrives), nor while a close is still draining its final text (`closing`). */
export function backstopOnContent(s: BackstopState): "busy" | null {
  return s.hookActive && s.appState === "idle" && !s.closing ? "busy" : null;
}

/** On a periodic tick: should the backstop close a turn the hooks left open? Only a
 *  turn THIS backstop opened (`turnBackstopOpened`), only after sustained quiescence, and
 *  never when an idle-grace close is already pending. Returns null for a normally opened
 *  turn (hook / app prompt / mux) — its own Stop owns the close — so a live flow is never
 *  overridden. */
export function backstopOnQuiescence(
  s: BackstopState,
  msSinceContent: number,
  quiescenceMs: number = QUIESCENCE_MS,
): "idle" | null {
  if (!s.hookActive) return null;
  if (s.appState !== "busy") return null;
  if (!s.turnBackstopOpened) return null;
  if (s.idlePending) return null;
  if (s.toolsPending) return null; // a long tool is still running — not actually quiescent
  return msSinceContent > quiescenceMs ? "idle" : null;
}
