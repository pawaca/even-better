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
| `watchStatus()` | **poll** (otty has no event stream) | Emits **only `awaiting` + `closed`**; busy/idle/closeError are deferred to `SELF_HOOK`. See decision B. |
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

### B. No event stream ⇒ `watchStatus()` is a poller that reports only `awaiting`/`closed`

cmux gets all status from `cmux events`. otty has none — only blocking
`otty watch:<agent>` (exit 0 on idle) and query `otty state:<agent>`. But
`SELF_HOOK` already owns busy/idle/closeError, so otty's `watchStatus` does **not**
emit those. It covers the two things the invariant assigns to the mux:

- **`awaiting`** (permission/question menu). Per the interaction-layer invariant,
  **the screen is authoritative** (a hook's PermissionRequest is only a candidate).
  Generalize cmux's codex-approval poll (`cmux.ts` `checkCodexApproval`) from
  codex-only to **all agent panes**:
  1. *cheap gate:* poll `otty state:<agent> <id>` (~700 ms). Ⓟ whether it reports
     `awaiting-input`/`busy` — if it does, only capture the screen when it hints a
     block; if it doesn't, fall back to a blind capture poll while the pane is
     believed busy.
  2. *authoritative confirm:* `otty pane capture` → `parseMenu`/`classifyMenu`
     (`parse.ts`). Confirmed visible menu ⇒ `routeStatus(awaiting)` + set kind;
     menu cleared ⇒ back to busy/idle.
  This keeps the screen authoritative (satisfies the invariant) and uses
  `otty state:` only to avoid capturing every tick.
- **`closed`** (pane gone): pane disappears from `otty panes` / `pane show` errors.

> The otty `watchStatus` ≈ cmux's `checkCodexApproval` state machine, promoted from
> "codex only" to "every agent pane", with the data source swapped from the events
> stream to an `otty state:` gate + `capture` confirm.

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

# P4 — agent lifecycle state (decides the §2B gate)
otty state:claude <id>
otty state:codex <id>
# → need: output format; does it expose busy / idle / awaiting-input?

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
```

**Fill-in table (paste concrete answers):**

| Ⓟ | Question | Answer |
|---|---|---|
| P1 | pane-id / cwd / process / focused field names | |
| P2 | capture is plain text? `--lines 0` semantics | |
| P3 | bare-key works? token names | |
| P4 | `otty state:` exposes awaiting-input/busy/idle? format | |
| P5 | `pane show` on a missing pane → ? | |
| P6 | any `otty events` stream? | |
| P7 | codex `/hooks` re-trust needed? both hooks fire? | |

---

## 5. Open questions / risks (revisit after probes)

- **P4 is load-bearing for §2B.** If `otty state:` does not expose an
  awaiting/blocked signal, the awaiting poll must blind-capture the screen on an
  interval while a turn is believed busy — heavier, and it needs a "believed busy"
  signal that only `SELF_HOOK` provides (the bridge would have to hint the mux, a
  new coupling). Prefer a state signal; fall back to blind capture only if forced.
- **P6 changes the whole shape.** A real `otty events`-style stream would let
  `watchStatus` subscribe (cmux-style) instead of poll — collapses most of §2B.
- **P7 (codex trust).** If appending shifts indices and breaks otty's trust, we
  either document the one-time re-`/hooks`, or order even-better's entries *after*
  otty's so indices are stable — TBD once we see the real `hooks.json` layout.
- **Cross-platform.** Use the `otty` **CLI** (cross-platform), never AppleScript
  (`do script` can't do the separate-key menu grammar, and it's macOS-only).
- **Non-goal for v1:** the cwd→transcript fallback (decision A). Ship
  `SELF_HOOK`-only first.
