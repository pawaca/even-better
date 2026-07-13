# otty multiplexer backend — execution plan

**Status: PLAN. Probes pending on a real otty install.** This doc is the design +
the exact probe checklist to run inside otty before any `src/otty.ts` is written.
Once the probes are filled in (§4), the confirmed parts fold into
`docs/MULTIPLEXERS.md` as a third backend section and this file can be deleted.

Read `docs/ARCHITECTURE.md` for *why* the `Multiplexer` seam exists and
`docs/MULTIPLEXERS.md` for how herdr and cmux map to it — otty is a third
implementation of the same `Multiplexer` interface (`src/multiplexer.ts:40-72`).

> Targets otty as documented at <https://docs.otty.sh/> (CLI + AppleScript
> reference, agents overview) as of 2026-07. **Every CLI field/flag below marked
> ⓅROBE is unconfirmed against the binary** — the docs give command names but not
> JSON schemas. Observed/source wins over docs (same rule as MULTIPLEXERS.md).

---

## 0. What otty is, and the one-line thesis

otty is a **GPU-accelerated GUI terminal emulator** (tabs/splits/panes, a config
file, AppleScript automation, a `otty` CLI) with **first-class agent hooks** for
Claude Code / Codex / OpenCode. It is *not* a headless multiplexer like herdr/cmux
— it is the terminal the user looks at on the Mac. even-better mirrors it to the
glasses in parallel; the only overlap between the two is that both install agent
lifecycle hooks (§ decision C).

**Thesis: otty is cmux-shaped (CLI-driven, no rule classifier) but built for
`SELF_HOOK=1`.** It is a *strong pane-I/O provider* (`otty panes` / `pane capture`
/ `pane send-keys`) and a *weak turn-status provider* — it exposes no continuous
event stream and no agent transcript session id. **`SELF_HOOK` fills exactly those
two gaps** (busy/idle/closeError from even-better's own hooks; the agent session
UUID from the hook's session cutover). So the otty backend **requires
`SELF_HOOK=1` to show content** (see decision A).

---

## 1. The interface, mapped to otty

`Multiplexer` (`src/multiplexer.ts:40-72`): 7 required methods, 3 optional.
Compare the herdr/cmux columns in `docs/MULTIPLEXERS.md` §1.

| Method | otty command | Notes |
|---|---|---|
| `name` | `"otty"` | Selected by `MUX=otty`, or auto-picked if `ottyAvailable()` and it is the only backend found (`index.ts` `selectMux`). |
| `listPanes()` | `otty panes --json` | One command → all panes with cwd + process names + focus. **Simpler than cmux** (no hook-file archaeology). Agent type from the process list (`claude`/`codex`). Ⓟ field names. |
| `watchStatus()` | **poll** (otty has no event stream) | Emits `awaiting`/`closed` **and the busy/idle edge that leaves an `awaiting`** (menu clear); it does not *independently* drive the turn's busy/idle — that's `SELF_HOOK`. See decision B. |
| `read(id, lines)` | `otty pane capture --pane <id> --lines <n>` | Direct map. Ⓟ whether `--lines 0` = viewport or full scrollback. |
| `send(id, text, keys)` | `otty pane send-keys --pane <id> -- "<text>"`, then one call per key `... -- key:Enter` | Text first, then keys **one at a time with a gap** (invariant — never bundle, see `pressAndVerify` in `bridge.ts`). otty key tokens are `key:Enter`/`key:Down`/… — nearly identical to even-better's `Key` names, so `KEY_MAP` is near-identity. Ⓟ bare-key (no text) form + token names. |
| `sessionId(id)` | **none** → `undefined` | otty's pane id is *otty's* session id, not the agent transcript UUID. Supplied by `SELF_HOOK` cutover instead. See decision A. |
| `exists(id)` | `otty pane show --pane <id>` (or presence in `otty panes`) | Ⓟ exit behavior when the pane is gone. |
| `explain?()` | *omit* | No rule classifier → blocked menus fall back to screen parsing (same as cmux). |
| `interactionKind?()` | from `classifyMenu` on the captured screen | Kind comes from screen parse, not a native event. |
| `dispose?()` | clear poll timers | Kill any `setInterval` poll loops on shutdown. |

Shared helper `typeAndSubmit(mux, id, text)` (`src/multiplexer.ts`) works unchanged
(it is pure `send`+`read`).

---

## 2. Three design decisions (where otty diverges from cmux)

### A. Session id comes from `SELF_HOOK`; **the otty backend requires `SELF_HOOK=1`**

otty's pane id ≠ the agent's transcript UUID, and even-better tails the jsonl by
UUID. So:

- `sessionId()` returns `undefined` natively.
- The agent's real session arrives via even-better's **own** self-hook and the
  existing `hookSessionKnown` cutover (`bridge.ts`) — the same path that already
  upgrades a pane to the transcript.
- **Consequence:** with `SELF_HOOK=0` the otty backend has *no content source* (no
  session ⇒ no transcript ⇒ nothing streamed, per the transcript-only invariant).
  Interaction menus (screen-read) still work, but prose/tools won't. The boot
  banner **must** warn when `MUX=otty` and `SELF_HOOK` is unset.
- *Optional* future fallback (not in v1): derive the transcript from cwd via the
  standard `~/.claude/projects/<cwd-slug>/*.jsonl` newest-file heuristic for the
  pre-hook window. Deferred — the hook is authoritative and the invariant prefers
  "no content until it resolves" over a guess.

### B. No event stream ⇒ `watchStatus()` is a poller for `awaiting`/`closed` (+ the awaiting-exit edge)

cmux gets all status from `cmux events`. otty has none — only blocking
`otty watch:<agent>` (exit 0 on idle) and query `otty state:<agent>`. `SELF_HOOK`
already owns the turn's busy/idle/closeError, so otty's `watchStatus` does **not**
*independently* drive those. But it still must emit the busy/idle **edge that
clears an `awaiting`**: `PaneBridge` deliberately lets the mux drive busy/idle
*while* the state is `awaiting` so a confirmed menu can clear (exactly what cmux's
`checkCodexApproval` does — `busy` when the blocker disappears mid-turn, `idle`
when the turn also ended; `cmux.ts` `checkCodexApproval`). Deferring **all**
busy/idle to `SELF_HOOK` would strand a pane in `awaiting` after the user approves.
So `watchStatus` covers the two things the invariant assigns to the mux, plus that
one exit edge:

- **`awaiting`** (permission/question menu). Per the interaction-layer invariant,
  **the screen is authoritative** (a hook's PermissionRequest is only a candidate).
  otty exposes **no point-in-time "is this pane blocked?" query**: `otty state:<agent>`
  is a *write* that otty's own hooks invoke to *report* lifecycle state (`key=value`),
  and `otty watch:<agent> <id>` *blocks* until idle (a gate, not a snapshot). So there
  is no cheap state gate to read — the awaiting detector is the **screen itself**,
  exactly like cmux's codex poll (`cmux.ts` `checkCodexApproval` reads the screen, not
  a state query): blind `otty pane capture` on an interval → `parseMenu`/`classifyMenu`
  (`parse.ts`). Confirmed visible menu ⇒ `routeStatus(awaiting)` + set kind; menu
  cleared ⇒ the busy/idle **exit edge** (busy if mid-turn, idle if the turn also ended).
  - **When to poll (open — see §5):** cmux arms its codex poll on the *busy* it learns
    from its own events; otty learns busy only from `SELF_HOOK`, not the mux. So either
    (a) poll every agent pane on a modest interval, or (b) let the bridge arm/disarm a
    per-pane menu-poll on its hook-driven busy/idle (a small bridge→mux seam). (b) is
    leaner; decide after P4.
- **`closed`** (pane gone): pane disappears from `otty panes` / `pane show` errors.

> The otty `watchStatus` ≈ cmux's `checkCodexApproval` state machine, promoted from
> "codex only" to "every agent pane", reading the **screen** (`otty pane capture`) —
> otty offers neither an events stream nor a point-in-time state query to lean on
> (`otty state:` writes, `otty watch:` blocks).

**Bootstrap note:** because `watchStatus` never emits busy/idle, before the first
self-hook report a pane looks idle and no turn opens. That is correct under
`SELF_HOOK=1` (the first `UserPromptSubmit` hook opens it). It is *why* decision A
requires `SELF_HOOK`.

### C. Dual hooks (otty's + even-better's) coexist by append — verify codex trust

otty installs its own lifecycle hooks into `~/.claude/settings.json` and
`~/.codex/hooks.json` ("nothing else in those files is touched"; uninstall
"cleanly removes Otty's entries" ⇒ entry-scoped append). even-better's
`addHookEntries` (`hook-install.ts`) also appends entry-scoped. So at the file
level both tools' hooks coexist and each reports to its own socket — **no
conflict for claude**.

**The one real risk is codex `trusted_hash`.** Codex trust is keyed
`[hooks.state]."<path>:<snake_event>:<i>:<j>".trusted_hash` — indexed by position.
Appending even-better's entries shifts `(i,j)` for entries after the insertion
point, which can invalidate otty's already-trusted entries and force a re-approve
via `/hooks`. **This must be checked live** (probe P7). Claude has no such
positional trust, so claude coexistence is expected to be clean.

### D. Hook→pane routing: otty needs a pane-id env var, or the pid fallback wired in

**This is a prerequisite for decision A, not a nice-to-have — it is the mechanism
that makes `SELF_HOOK` reach a bridge at all.** For a self-hook report to drive a
pane, it must resolve to an even-better `paneId`. The installed hook
(`assets/even-better-hook.sh`) fills `paneId` from a **mux-specific env var** —
cmux `CMUX_SURFACE_ID`, herdr `HERDR_PANE_ID` (`src/hook-report.ts:11-13`) — and
`src/index.ts` currently routes **only** on a non-empty `r.paneId`
(`index.ts:549`). The `resolvePaneId` pid fallback exists as a pure function
(`src/hook-report.ts:82`) but is **not yet wired into that routing** (noted there
as landing in a later stage). otty exports no such env var, so with no work every
otty hook report arrives with an empty `paneId` and is dropped ⇒ `hookSessionKnown`
never sets ⇒ decision A's whole premise fails silently.

Two ways to close it (choose after probe P8):

1. **env var (preferred if it exists).** If otty exports a stable per-pane id into
   the agent's environment (probe P8), teach the hook script to emit
   `mux:"otty"` + `paneId:$OTTY_…`, matching the cmux/herdr branches. Cleanest —
   reuses the existing env-primary routing untouched.
2. **pid fallback.** Wire `resolvePaneId` into `index.ts` routing **and** expose
   each pane's **agent pid** in `OttyMultiplexer.listPanes()` (requires
   `otty panes --json` to carry a pid — probe P1). An empty-`paneId` report then
   resolves by its `pid` matching exactly one pane. More moving parts, but works
   with no otty env var.

Track this as **blocking for v1**.

---

## 3. Implementation plan (after probes pass)

1. **`src/otty.ts`** — `OttyMultiplexer implements Multiplexer` + `ottyAvailable()`
   (binary present — check an `/Applications/otty.app/...` bundle path then PATH,
   mirroring `resolveCmuxBin` — **and** `otty panes --json` succeeds, proving otty
   is actually running; analogous to `cmux ping`). Keep the pure bits — panes-JSON
   → `PaneInfo`, agent detection, the menu-poll state machine — as exported pure
   functions for unit tests (mirror how `cmux.ts` exports `foldHookSessions`,
   `isStaleZombie`, `bareSession`).
2. **`src/index.ts`** — add `MUX=otty` to `selectMux`; add `ottyAvailable()` to the
   auto-detect list; extend the unknown-`MUX` error string. Add the banner warning
   when `MUX=otty` and `SELF_HOOK` is unset (decision A).
3. **`scripts/test-otty.ts`** — `node:test` unit suite for the pure functions
   (panes-JSON parse, agent detection, menu-poll transitions), in the `test-*.ts`
   style. `pnpm check` + this suite green before commit.
4. **E2E** (per CLAUDE.md "Verification"): `MUX=otty SELF_HOOK=1 pnpm start`, run
   claude inside otty, record with `tools/app-sim.ts`, drive a turn via
   `POST /api/prompt`, confirm text_delta / tool bubbles / a permission menu all
   arrive. Repeat once for codex (also validates decision C's `/hooks` trust
   coexistence).

---

## 4. PROBE CHECKLIST — run these inside otty, paste outputs back

Start an agent (claude, then codex) in an otty pane, then run each command. Paste
raw output under each. These resolve every Ⓟ above so field names/flags go into
code as facts, not guesses.

```
# P1 — pane discovery + agent/cwd/focus fields
otty panes --json
# → need: the id field, cwd field, process/command field, focused/active flag, tab id

# P2 — screen capture (interaction-layer source)
otty pane capture --pane <id> --lines 40
otty pane capture --pane <id> --lines 0
# → need: plain text? does --lines 0 mean viewport or whole scrollback?

# P3 — send: bare key (no text) + token names
otty pane send-keys --pane <id> -- key:Enter
otty pane send-keys --pane <id> -- key:Down
otty pane send-keys --pane <id> -- key:Escape
otty pane send-keys --pane <id> -- "echo hi" key:Enter
# → need: does a no-text key work? exact accepted tokens (Enter/Return? Down? Escape? Tab? Space?)

# P4 — what state:/watch: really are (decides §2B "when to poll")
#   DO NOT run `otty state:<agent> key=value` — per the CLI ref it WRITES lifecycle
#   state (it's the command otty's own hooks call), not a reader. Only inspect help:
otty --help                              # confirm the state:/watch: descriptions
otty watch:claude <id> --timeout-secs 1  # read side: does it just block until idle? exit code?
# → expect NO point-in-time "is it awaiting?" query ⇒ §2B awaiting = screen capture only

# P5 — exists probe
otty pane show --pane <id>
otty pane show --pane <bogus-id>   # what does a missing pane do — error / exit code?

# P6 — confirm there is (or isn't) an event stream
otty --help
otty events --help    # if this exists, watchStatus can subscribe instead of poll — big simplification

# P7 — dual-hook coexistence (decision C)
#   1. Note codex trust state in otty BEFORE installing even-better's hooks.
#   2. Run even-better's codex hook install (adds entries to ~/.codex/hooks.json).
#   3. Restart codex: does /hooks re-prompt trust for otty's entries too? Do otty's
#      hooks still fire? Does even-better's fire? (claude: confirm both fire, no prompt.)

# P8 — hook→pane routing (decision D — BLOCKING for v1)
env | grep -i otty     # inside the agent pane: does otty export a per-pane id env var?
# → if yes: the hook script reads it (route by env). if no: need the pid fallback,
#   so confirm P1's `otty panes --json` carries the agent process pid.
```

**Fill-in table (paste concrete answers):**

| Ⓟ | Question | Answer |
|---|---|---|
| P1 | pane-id / cwd / process / focused field names | |
| P2 | capture is plain text? `--lines 0` semantics | |
| P3 | bare-key works? token names | |
| P4 | state:/watch: true nature (write vs blocking read); any awaiting query? | |
| P5 | `pane show` on a missing pane → ? | |
| P6 | any `otty events` stream? | |
| P7 | codex `/hooks` re-trust needed? both hooks fire? | |
| P8 | otty per-pane id env var? else `panes --json` has agent pid? | |

---

## 5. Open questions / risks (revisit after probes)

- **P8/decision D is the top blocker.** Without an otty pane-id env var *or* the
  pid fallback wired in, no self-hook report reaches a bridge and the whole
  `SELF_HOOK`-only design is inert. Resolve P8 before any other work.
- **No otty state-read ⇒ the screen is the only awaiting signal (§2B).**
  `otty state:` is a hook *write* and `otty watch:` blocks until idle — neither is a
  point-in-time "is it blocked?" query. So the awaiting poll blind-captures the
  screen; the open part is *when* to poll: every agent pane on an interval, or a
  `SELF_HOOK`-armed per-pane poll (a bridge→mux seam). Resolve with P4.
- **P6 changes the whole shape.** A real `otty events`-style stream would let
  `watchStatus` subscribe (cmux-style) instead of poll — collapses most of §2B.
- **P7 (codex trust).** If appending shifts indices and breaks otty's trust, we
  either document the one-time re-`/hooks`, or order even-better's entries *after*
  otty's so indices are stable — TBD once we see the real `hooks.json` layout.
- **Cross-platform.** Use the `otty` **CLI** (cross-platform), never AppleScript
  (`do script` can't do the separate-key menu grammar, and it's macOS-only).
- **Non-goal for v1:** the cwd→transcript fallback (decision A). Ship
  `SELF_HOOK`-only first.
