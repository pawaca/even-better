// Stage 3b of docs/HOOK-MIGRATION.md: the CONSERVATIVE transcript-quiescence backstop —
// SAFE HALF ONLY. A self-hook is normally reliable (synchronous local socket), but a turn's
// start hook can be missed (even-better restarts, or a turn's `UserPromptSubmit` is dropped).
// This backstop recovers that one case WITHOUT guessing:
//   - the transcript shows a new turn's USER PROMPT while we think idle → re-open busy.
// It keys strictly off the `prompt` event, not any content, because a new turn always begins
// with the user's prompt in the transcript, whereas the trailing `say`/`tool` of a
// just-closed turn (jsonl can lag the `Stop` hook by more than the close drain) is NOT a
// prompt — so late tail events can't re-open a closed turn (PR #35 review).
//
// The mirror case — closing a turn whose `Stop` was dropped — is deliberately NOT built:
// there is no safe signal for it. A quiet transcript can't distinguish "turn finished" from
// "model reasoning silently", so any time-based close would fire mid-thought and land the
// late answer in a new turn, corrupting the app transcript. A dropped `Stop` therefore
// lingers as a harmless busy indicator until the next real signal. (Recovering a turn that
// was already RUNNING when even-better attached is the startup snapshot's job, not this.)
// Pure so the policy is unit-tested without a running agent.

/** The minimal bridge state the backstop policy reads. */
export interface BackstopState {
  /** SELF_HOOK is driving this pane (the per-pane cutover fired). Off ⇒ the backstop is
   *  inert, so the default path is unaffected. */
  hookActive: boolean;
  /** The bridge's current app state. */
  appState: "idle" | "busy" | "awaiting";
}

/** On a transcript PROMPT event (a new user turn): should the backstop re-open a turn whose
 *  start hook we missed? Only from a settled idle on the self-hook path. Never touches a live
 *  busy/awaiting (a normal hook-driven turn goes busy before its prompt is mirrored). The
 *  caller must invoke this ONLY for `prompt` events — trailing `say`/`tool` of a closed turn
 *  must not re-open it. */
export function backstopOnPrompt(s: BackstopState): "busy" | null {
  return s.hookActive && s.appState === "idle" ? "busy" : null;
}
