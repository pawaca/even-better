// Stage 3b of docs/HOOK-MIGRATION.md: the CONSERVATIVE transcript-quiescence backstop —
// SAFE HALF ONLY. A self-hook is normally reliable (synchronous local socket), but can be
// missed if even-better restarts mid-turn or a turn ends without firing `Stop`. This backstop
// recovers the one such case it can detect WITHOUT guessing:
//   - a dropped `UserPromptSubmit` / a whole turn delivered `Stop`-first: the transcript shows
//     new content while we wrongly think idle → re-open busy.
// The mirror case — closing a turn whose `Stop` was dropped — was deliberately NOT built:
// there is no safe signal for it. A quiet transcript can't distinguish "turn finished" from
// "model reasoning silently", so any time-based close would fire mid-thought and land the late
// answer in a new turn, corrupting the app transcript (see PR #35 review). A dropped `Stop`
// therefore lingers as a harmless busy indicator until the next real signal, rather than risking
// corruption. Pure so the policy is unit-tested without a running agent.

/** The minimal bridge state the backstop policy reads. */
export interface BackstopState {
  /** SELF_HOOK is driving this pane (the per-pane cutover fired). Off ⇒ the backstop is
   *  inert, so the default path is unaffected. */
  hookActive: boolean;
  /** The bridge's current app state. */
  appState: "idle" | "busy" | "awaiting";
  /** A turn close is in progress: `state` has flipped to idle but `emitTurnResult` is still
   *  draining its final text (a ~1.1s transcript catch-up wait). Content during that window
   *  is the CLOSING turn's tail, not a new turn — so the backstop must not re-open on it. */
  closing: boolean;
}

/** On a transcript CONTENT event: should the backstop re-open a turn the hooks missed?
 *  Only from a settled idle on the self-hook path — content while idle means the
 *  `UserPromptSubmit` (or a Stop-first whole turn) was dropped. Never touches a live
 *  busy/awaiting (so it can't disturb a normal hook-driven turn, which goes busy before its
 *  content arrives), nor while a close is still draining its final text (`closing`). */
export function backstopOnContent(s: BackstopState): "busy" | null {
  return s.hookActive && s.appState === "idle" && !s.closing ? "busy" : null;
}
