# Phase 1 — Self-installed agent hooks (herdr/cmux)

> **Status: proposal / not implemented.** Design for moving the *agent-semantic*
> signals (turn status + session id) off the multiplexer and onto even-better's
> own Claude/Codex hooks. Phase 1 keeps herdr/cmux for terminal control and only
> swaps the signal source; tmux (and any terminal) is Phase 2 and becomes small
> once this is proven.

## Why

Today status (`busy`/`idle`/`awaiting`) and the session id come *from the mux*:
herdr's `agent_session` + classifier, cmux's `*-hook-sessions.json`. That couples
us to each backend's agent-awareness and its quirks (zombie pids, fork-session
gaps, `agent_session` timing — each cost a debugging round). It also blocks tmux,
which is agent-unaware.

Decoupling the semantic layer into **our own hooks** gives: one code path across
backends, the ability to support *any* terminal (Phase 2), and deletion of the
fragile mux-specific parsing. The mux collapses to three terminal primitives:
**discover, send, read-screen.**

## Scope

- **In:** Claude + Codex, under **herdr and cmux only**. Status + session sourced
  from our hooks. Terminal control (list/send/read) unchanged.
- **Out:** tmux (Phase 2). Removing screen menu detection — **Codex exec/patch
  approvals stay screen** (`capture`/`parseMenu`); they are not hook events.

## The hook (shape follows herdr's `herdr-agent-state.sh`)

A small script installed into the agent config; on each event it reads the hook
payload from stdin, **self-identifies its pane**, and reports to even-better.

```sh
# read stdin payload, resolve pane id from whichever mux set it, POST to us
pane_id="${CMUX_PANEL_ID:-${HERDR_PANE_ID:-}}"     # Phase 2 adds ${TMUX_PANE}
# report {mux, paneId, sessionId, transcriptPath, event, cwd, pid, ts} -> local endpoint
```

Report is **fire-and-forget** — it must never block the agent's turn (hooks run
synchronously inside it; herdr/cmux both cap with a timeout and swallow errors).

## Correlation — env primary + PID fallback

The crux, resolved by reading both reference implementations:

- **Primary: the pane-id env var**, which each mux sets in its pane and which
  **equals even-better's `paneId`** — proven for cmux (`CMUX_PANEL_ID` ==
  `surfaceId` == `paneId`) and herdr (source: `cmd.env(HERDR_PANE_ID_ENV_VAR,
  &identity.pane_id)`, and `pane_id` is what `agent.list` returns). herdr relies
  on this env var alone.
- **Fallback: PID → pane.** cmux's routing teaches the lesson — the env can be
  stale on resume / in a subprocess, so it also binds by caller PID/TTY
  (*"a PID lives in exactly one surface"*). We map the hook's `pid` to a pane via
  the mux's pane process info when the env is missing/stale.
- **Never** route to the focused pane (cmux's explicit no-op — mis-delivers onto
  an unrelated session).

even-better maps the resolved `paneId` to its `PaneBridge`.

## Transport

even-better exposes a tiny **loopback/unix-socket endpoint** the hook reports to
(token-scoped to avoid cross-talk). Not the public SSE port.

## Event → state mapping

Claude and Codex expose the **same hook event set** (verified — Codex's
`CoreHookEventName` = `SessionStart, UserPromptSubmit, Stop, PreToolUse,
PostToolUse, PermissionRequest, PreCompact, PostCompact, SubagentStart,
SubagentStop`), so the mapping is uniform across both. The legacy Codex
`notify = turn-ended` channel is **not** needed — `UserPromptSubmit`/`Stop` cover
the turn boundary directly.

| Agent event | State / action |
|---|---|
| `SessionStart` | session id **+ `transcript_path`** → upgrade to transcript |
| `UserPromptSubmit` | `busy` (turn start) |
| `Stop` | `idle` (turn boundary — **not** session end) |
| `PreToolUse` / `PermissionRequest` | `awaiting` (claude); **Codex exec/patch approvals stay screen** |
| `SubagentStart` / `SubagentStop` | **ignore** — never drive/revive the main pane (herdr's note) |
| `Pre/PostCompact`, `PostToolUse` | not consumed (available if needed) |

Two pitfalls both references flag: **`Stop` ≠ session end** (don't clear the
session on a turn boundary), and **subagent events must not drive the main pane.**

Bonus: the payload carries **`transcript_path`**, so we get the jsonl path
directly and can **retire the `findSessionFile` directory scan**.

## Install / uninstall

- **Auto-install on first run**, merged into `~/.claude/settings.json` (standard
  `hooks`, as agentcraft/confirmo do) and `~/.codex/hooks.json`, behind a
  **consent prompt**, idempotent, tagged with a marker (cmux uses a
  `# cmux-…-hook-trust-<uuid>` fence) for clean **uninstall**.
- **Coexists** with cmux/herdr's own hooks (both fire; we consume ours per the
  `providesAgentStatus` note below) and third-party hooks — additive, never
  clobber existing entries.

## What the mux still does (Phase 1)

`listPanes` (discover), `typeAndSubmit` (send), `read` (screen menus). Its
**status stream and session id become unused** — sourced from hooks instead. On
cmux/herdr the mux keeps installing *its* hooks too; we simply don't consume its
status (one authoritative source per bridge).

## Retirement (after Phase 1 is stable)

- cmux hook-sessions parsing: `foldHookSessions`, `isStaleZombie`, `bareSession`.
- herdr `agent_session` handling in `watchStatus`.
- `findSessionFile` / `findCodexSessionFile` scans (path now from the hook).
- `watchStatus`'s status normalization (status now from hooks).

Keep: `listPanes`, `send`, `read`; the `Multiplexer` seam shrinks accordingly.

## Open items

Two technical unknowns are now **resolved** (verified against the herdr/codex
sources):

1. ~~`HERDR_PANE_ID` == even-better's herdr `paneId`~~ — **confirmed** from herdr
   source (`cmd.env(HERDR_PANE_ID_ENV_VAR, &identity.pane_id)`; `pane_id` is the
   `agent.list` identity).
2. ~~Codex busy/idle event names~~ — **confirmed**: Codex fires `UserPromptSubmit`
   and `Stop` natively (`CoreHookEventName`), same as Claude; the legacy
   `notify = turn-ended` channel is unnecessary.

Remaining (a build-time UX requirement, not a technical unknown):

3. **Consent + trust** — auto-installing into the user's agent config needs
   explicit opt-in, a stable marker fence, and a reliable uninstall.

## Validation

Phase 1 is done when, **under both herdr and cmux**, status + session come purely
from our hooks (mux status/session disabled) and behaviour matches or beats today
— busy/idle timing, transcript upgrade, awaiting — verified via `tools/app-sim.ts`
recordings on each backend.

## Then Phase 2

tmux backend = the three terminal primitives only: discover
(`list-panes -F '#{pane_current_command} #{pane_pid}'`), send (`send-keys`), read
(`capture-pane`). The semantic layer is already done and proven here.

---

References: herdr `src/integration/assets/{claude,codex}/herdr-agent-state.sh`
([ogulcancelik/herdr](https://github.com/ogulcancelik/herdr)); cmux
`CLI/CMUXCLI+AgentHook*.swift`, `CMUXCLI+ClaudeHookWorkspaceRouting.swift`
([manaflow-ai/cmux](https://github.com/manaflow-ai/cmux)).
