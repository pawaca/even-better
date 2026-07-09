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
- **Out:** tmux (Phase 2). Not *removing* screen menu detection — it stays as a
  fallback (`capture`/`parseMenu`), though Codex's `PermissionRequest` hook lets us
  drive most approvals structurally instead (see the event map).

## The hook (shape follows herdr's `herdr-agent-state.sh`)

A small script installed into the agent config; on each event it reads the hook
payload from stdin, **self-identifies its pane**, and reports to even-better.

```sh
# read stdin payload, resolve pane id from whichever mux set it, POST to us
pane_id="${CMUX_SURFACE_ID:-${CMUX_PANEL_ID:-${HERDR_PANE_ID:-}}}"   # Phase 2 adds ${TMUX_PANE}
# report {mux, paneId, sessionId, transcriptPath, event, cwd, pid, ts, seq} -> local endpoint
```

Report is **fire-and-forget, and that must be enforced by the hook itself** — the
agent runs hooks **synchronously** and its defaults are dangerous (Claude
command/http hooks block on a long default; Codex defaults to **600s** when
`timeout` is omitted). If even-better is stopped or the loopback endpoint stalls,
a synchronous `POST` from `UserPromptSubmit`/`PreToolUse` would **freeze the
agent's turn**. So the hook must: (1) set a **short per-hook timeout** (~2–5s, as
cmux's `hooks.json` does), (2) **background/detach** the report so control returns
immediately, and (3) **swallow all failures** (exit 0). Never rely on the mux to
bound this — under self-hooks it is Claude/Codex, not herdr/cmux, executing the
command.

**Ordering:** backgrounding (2) breaks the tie between the agent's synchronous hook
order and delivery order — a stalled `UserPromptSubmit` `POST` could land *after*
its `Stop`. Each report therefore carries a **per-pane monotonic `seq`** (herdr's
hook stamps `report_seq = time.time_ns()`). The endpoint must be **order-tolerant**,
which is **not** the same as naive stale-drop: dropping a lower-`seq`
`UserPromptSubmit` that arrives after its `Stop` would lose the turn-start entirely
(no busy, no result). It needs either a **short reorder buffer** keyed by `seq`, or
**turn state that can open from a late start and close an unopened turn** — the
exact mechanism is an implementation detail (see [Scope boundary](#scope-boundary--deferred-to-implementation)).

## Correlation — env primary + PID fallback

The crux, resolved by reading both reference implementations:

- **Primary: the pane-id env var**, which each mux sets in its pane and which
  **equals even-better's `paneId`** — proven for cmux (**`CMUX_SURFACE_ID`** ==
  `surfaceId` == `paneId`; the documented surface variable, also what cmux's own
  `send`/`read-screen` and Codex hook target — `CMUX_PANEL_ID` is observed as an
  equal alias, so prefer `CMUX_SURFACE_ID`) and herdr (source:
  `cmd.env(HERDR_PANE_ID_ENV_VAR, &identity.pane_id)`, and `pane_id` is what
  `agent.list` returns). herdr relies on this env var alone.
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
| `UserPromptSubmit` | **candidate** `busy` — a *blocked* prompt starts nothing (see note) |
| `Stop` | **candidate** `idle` — debounced, not committed instantly (see note) |
| `StopFailure` (Claude) | **close the turn** — turn ended on an **API error**; emit `result`/idle, stop stats |
| `PermissionRequest` | **candidate** `awaiting` — confirm the menu surfaces (see note) |
| `PreToolUse` where `tool_name ∈ {AskUserQuestion, ExitPlanMode}` | `awaiting` — these block on a menu with no dedicated event |
| `PreToolUse` (any other tool) | stays `busy` — ordinary approved work, **no menu**; must **not** emit awaiting |
| `SubagentStart` / `SubagentStop` | **ignore** — never drive/revive the main pane (herdr's note) |
| `Pre/PostCompact`, `PostToolUse` | not consumed (available if needed) |

`Stop` is **not** authoritative idle: a sibling `Stop` hook can return
`decision: "block"` to keep the agent going, and matching hooks run concurrently,
so our fire-and-forget reporter may send `Stop` while the turn actually continues.
Treat it as *candidate* idle and confirm through the existing **`IDLE_GRACE_MS`
debounce** — a subsequent `busy`/tool event cancels the pending idle. This reuses
the current turn-end invariant (bridge.ts) rather than committing `result` and
stopping stats mid-turn.

**Residual (accepted, = today's behaviour):** a *fixed* grace can't cover a sibling
`Stop` hook that runs **longer than the grace** and only then returns `block` — the
grace elapses, `result` fires, and the busy that would cancel it arrives too late.
The mux path has the same limitation (herdr reads idle during the hook wait), so
this is **parity, not a regression**, and it self-heals when the resumed turn emits
`busy`/content. A stronger guarantee (an **adaptive/longer grace**, or confirming
turn-end against **transcript quiescence** — final assistant message, no open tool
calls) is a tracked refinement; note the tension with the existing *"the final
block lands during the grace, do not cancel on content"* invariant, which is why a
naive content-based cancel is unsafe.

`UserPromptSubmit` → `busy` is also *candidate*: a `UserPromptSubmit` hook (ours or
a sibling) can `decision: "block"` and **erase the prompt** (Claude/Codex both
support this), so the agent never starts and **no `Stop` follows** — a naive `busy`
would strand the thinking / `running_stats` state. Confirm real activity began (the
first transcript/tool event) before holding busy, or fall back to idle if nothing
starts.

`StopFailure` is a distinct **Claude** hook event (the turn ended on an **API
error** — `rate_limit`, `overloaded`, `server_error`, …); `Stop` does **not** fire
then. Phase 1 must install and map it to a turn close (error `result` + idle), or a
pane that entered busy stays stuck after an API-error turn.

Note the tool-name special case: only `PermissionRequest` and `PreToolUse` for
`AskUserQuestion`/`ExitPlanMode` are interactive — **every other `PreToolUse` is
busy work** (Read/Bash under skip-permissions have no menu). This mirrors the
existing routing (`src/cmux.ts` `agent.hook.PreToolUse`, `docs/MULTIPLEXERS.md`);
mapping all `PreToolUse` to awaiting would emit a bogus permission flow.

**Codex `PermissionRequest` is a strong signal, but a _candidate_ — confirm the
prompt actually surfaces.** Contrary to the old cmux screen-only limitation, Codex
*does* fire a `PermissionRequest` hook when about to ask for approval (shell
escalation, `Bash`/`apply_patch` matchers) — so Phase 1 should use it instead of
guessing from the menu. But **all matching hooks run**, and a sibling approval hook
returning `allow` (proceed, no prompt) or `deny` (block) resolves it with **no menu
to answer** — only the no-decision case opens one. Since the plan also promises
coexistence with third-party hooks, treat `PermissionRequest` as *candidate*
`awaiting` and confirm the menu actually appears (screen) / that no other hook
decided **before** emitting an actionable permission state — same candidate-then-
confirm shape as `Stop`. Screen parsing is thus a **confirmation**, not merely a
fallback.

Two pitfalls both references flag: **`Stop` ≠ session end** (don't clear the
session on a turn boundary), and **subagent events must not drive the main pane.**

Bonus: the payload usually carries **`transcript_path`**, so we get the jsonl path
directly. But Codex documents this common field as `string | null` (present only
"if any"), so on a session/startup/resume hook that reports `null` we still need a
path. **Prefer the hook's `transcript_path`; fall back to the
`findSessionFile`/`findCodexSessionFile` scan when it is null/absent** — do not
remove the scan outright, or a null-path Codex pane would never upgrade and (under
the transcript-only invariant) show nothing on the glasses.

## Install / uninstall

- **Auto-install on first run**, merged into `~/.claude/settings.json` (standard
  `hooks`, as agentcraft/confirmo do) and **`$CODEX_HOME/hooks.json`** (falling
  back to `~/.codex/hooks.json` only when unset — mirror `codexHome()` in
  `src/codex-transcript.ts`, else a custom `CODEX_HOME` gets the hook in an unused
  file and never reports), behind a
  **consent prompt**, idempotent, tagged with a marker for clean **uninstall**.
- **Codex needs a trust step** — writing `hooks.json` is not enough: Codex **skips
  non-managed command hooks until the user trusts the exact definition** (reviewed
  via `/hooks`). cmux handles this by writing trust state into `config.toml`
  (`[hooks.state]` + a `# cmux-…-hook-trust-<uuid>` fence). Phase 1 must do the same
  (write the trusted-hook state) **or** walk the user through `/hooks`; otherwise a
  consenting Codex user still gets no `SessionStart`/status and their panes never
  upgrade.
- **Coexists** with cmux/herdr's own hooks (both fire; we consume ours per the
  `providesAgentStatus` note below) and third-party hooks — additive, never
  clobber existing entries.

## What the mux still does (Phase 1)

`listPanes` (discover), `typeAndSubmit` (send), `read` (screen menus). We stop
consuming its **busy/idle + session id** (hooks provide those — one authoritative
source per bridge), but the status subscription is **not** dropped: it still
carries the **`closed` lifecycle signal** (herdr `pane.closed` / cmux
`surface.closed` → `closed`), which `PaneBridge.onStatus` uses to dispose the
bridge. Self-installed hooks **do not fire when the pane/surface is closed**, so
without this a session would keep polling a dead pane until the next `/sessions`
reconcile. On cmux/herdr the mux keeps installing *its* hooks too; we
ignore its busy/idle **per-pane, once that pane's self-hook is observed** (see the
per-pane cutover gate below).

## Startup reconciliation (hooks are one-shot)

Hooks are *events*, not state — a `SessionStart` or `PermissionRequest` that fired
before even-better started (or across a restart) is gone (fire-and-forget, exits 0
when the endpoint is down). So hooks are the live fast path, but **startup and each
newly-discovered pane must reconcile current state from durable sources**, not wait
for the next hook:

- **session id / transcript** — from the mux's *persisted* discovery state, which
  Phase 1 keeps: cmux `*-hook-sessions.json` reliably gives the **`sessionId`**
  (a second reason to keep cmux discovery); the transcript is then located via the
  retained **`findSessionFile`/`findCodexSessionFile` scan**. Do **not** rely on the
  file's `transcriptPath` — it is *not reliably present* (fork-session launches skip
  the upsert until the first prompt; see `docs/SESSIONS.md §3`), which is why the
  scan is retained. herdr's `agent_session` is queryable from the socket at any
  time. So an already-running pane upgrades to its transcript immediately, without a
  fresh `SessionStart`.
- **open approval / `awaiting`** — from a **screen read** at discovery, but through
  the **same agent-specific classifier the live path uses**, not raw `parseMenu`:
  `parseMenu` intentionally accepts generic numbered runs, so an idle pane whose
  output merely ends in a numbered list would become a bogus actionable
  permission/question (and later inject keys). Require the stricter check —
  `isCodexApprovalScreen` (footer/marked-row) for Codex, `classifyMenu` for Claude —
  before flipping to `awaiting`.
- **busy/idle** — inferred from transcript quiescence (or a one-time status read).

Without this, a restart leaves every running session blank and any open approval
unanswerable until the pane next acts — so the reconcile path is **required** before
hooks become the sole live status/session source.

**This reconcile also runs periodically, as the recovery for a dropped report.**
Hooks are fire-and-forget and swallow failures (above), so a single `Stop` /
`UserPromptSubmit` whose `POST` was lost while even-better was running is gone — and
after cutover there is no mux busy/idle to catch it, so a bridge could stay busy or
idle wrongly until a restart. A low-frequency backstop that re-derives busy/idle
from **transcript activity** (the transcript is tailed anyway: new content ⇒ busy,
sustained quiescence ⇒ idle) and honours the retained mux `closed` signal
self-heals **most** dropped reports without a durable hook-side spool. The seq-ordered
hook reports remain the fast path; this is only the safety net.

The **residual**: a dropped turn-*start* for a turn that emits no intermediate
transcript records (e.g. an all-reasoning Codex turn) looks identical to idle, so the
backstop can't show busy until the final message lands. Closing that fully needs a
stronger delivery guarantee — durable retry/spool, or keeping the mux status as a
secondary until self-hook delivery is proven reliable — which is an implementation
choice (see [Scope boundary](#scope-boundary--deferred-to-implementation)), not
fixed by transcript quiescence alone.

## Per-pane cutover (hook-observed gate)

A running Claude/Codex process loads its hook config at launch and does **not
reliably hot-reload** it, so a pane that existed **before** install will never fire
our hooks. Startup reconciliation snapshots such a pane's current state, but its
future `UserPromptSubmit`/`Stop` never arrive — it would appear once, then go stale.

So the cutover is **per-pane, gated on observing the self-hook**: a pane keeps using
the **mux status/session** until even-better has seen at least one hook report from
it; only then does it switch to hook-sourced signals. Panes launched *after* install
fire the hook from the start; pre-existing panes are either restarted by the user or
stay on the mux fallback. This makes the migration gradual and reversible — and
means **"disable mux busy/idle" is a per-pane state, not a global switch**.

## Retirement (after Phase 1 is stable)

- herdr `agent_session` handling in `watchStatus` (session now from the hook).
- `watchStatus`'s **busy/idle** normalization (status now from hooks) — but **keep
  the `closed` branch** (see above).

**Not retired in Phase 1** (each has a live non-status role that must be re-sourced
first):

- **cmux `foldHookSessions` / hook-sessions parsing** — `cmux.listPanes()` is built
  *entirely* from `refreshMaps()` reading `~/.cmuxterm/*-hook-sessions.json`
  (`src/cmux.ts`), so it still powers **discovery**. It only sheds its
  session/status role in Phase 1; full retirement waits until cmux discovery is
  re-sourced (e.g. from our hook's `SessionStart` or a cmux surface-list API).
- **`findSessionFile` / `findCodexSessionFile`** — kept as the **fallback** for a
  null/absent hook `transcript_path` (Codex).

Keep: `listPanes`, `send`, `read`, and the `closed` signal; the `Multiplexer` seam
shrinks only where a hook fully replaces a role.

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

## Scope boundary — deferred to implementation

This is a **design doc**: it fixes the *approach* (self-hooks for status/session,
env-primary + PID correlation, per-pane hook-observed cutover, keep the mux for
discover/send/close, transcript-only fallback) and names the *major risks*. It is
**not** an implementation spec, and prose can't be compiled or tested — so the
following are settled **at implementation time, against real code + tests**, where
they are bounded, and are explicitly out of scope here:

- The exact **order-tolerant delivery** mechanism (reorder buffer vs. stateful turn
  handling) and the **dropped-report reliability** guarantee (transcript backstop
  vs. durable spool/retry vs. mux-as-secondary duration).
- Concrete **cadences/thresholds** (`IDLE_GRACE_MS`, backstop poll interval, hook
  timeout seconds, reorder window).
- The precise wiring of the reconcile classifiers and the endpoint/state machine.

Treat further edge-case enumeration at this layer as implementation review, not
design review.

## Then Phase 2 — new backends

With the semantic layer proven, a backend is just three terminal primitives:
**discover, send, read-screen**. For tmux:

- **discover:** `list-panes -a -F '#{pane_id} #{pane_current_command} #{pane_pid}'`
  — `#{pane_id}` (the `%NN` handle) is the **`paneId`** passed to send/read and the
  `Multiplexer` key; `#{pane_pid}` is *only* the PID-fallback correlation input,
  not a target.
- **send:** `send-keys -t <pane_id> -l "…"` + `Enter`.
- **read:** `capture-pane -p -t <pane_id>` (menus) — this captures the **visible**
  screen, which *is* the active alternate-screen TUI/menu (verified empirically on
  tmux 3.6a: default capture returns the alt-screen content). Do **not** add `-a`:
  it additionally dumps the normal-buffer scrollback (pre-TUI shell output) and
  would pollute `parseMenu`.

### Which backends, and why (rough reach vs. adapter cost)

Ordered by *new* users reachable × how cheap the adapter is. Popularity is
approximate (GitHub stars = awareness, not active users; distribution/default
status matters more for the top rows).

| Backend | Control surface | Reach (rough) | Priority |
|---|---|---|---|
| **tmux** | `list-panes`/`send-keys`/`capture-pane` (id-addressable) | millions (distro default, SSH) — also covers tmux-based agent tools like Claude Squad | **1st** |
| **iTerm2** | Python API (session id / send / contents) | ~millions of Mac devs (biggest "bare terminal, no mux" group) | 2nd — high reach, heavier API |
| **kitty** | `kitty @ ls`/`send-text`/`get-text` (JSON, id/match) | ~hundreds of thousands | 3rd — cleanest adapter |
| **WezTerm** | `wezterm cli list`/`send-text`/`get-text` (id) | ~hundreds of thousands | 3rd — cleanest adapter |
| **Zellij** | `zellij action write-chars`/`dump-screen` (**focus-based, not id-addressable**) | ~hundreds of thousands (growing) | later — extra friction |

Deliberately **not** targeted: GNU Screen (legacy/declining, crude `stuff`/
`hardcopy`), Ghostty/Alacritty (no built-in multiplexer — run tmux inside),
Warp and Electron agent apps (proprietary / no usable external control — same wall
as the Codex desktop app).

---

References: herdr `src/integration/assets/{claude,codex}/herdr-agent-state.sh`
([ogulcancelik/herdr](https://github.com/ogulcancelik/herdr)); cmux
`CLI/CMUXCLI+AgentHook*.swift`, `CMUXCLI+ClaudeHookWorkspaceRouting.swift`
([manaflow-ai/cmux](https://github.com/manaflow-ai/cmux)).
