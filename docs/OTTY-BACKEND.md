# otty multiplexer backend — probe results and verdict

**Status: PROBED (2026-07, otty 1.2.3 / `TERM_PROGRAM_VERSION`). Verdict: BLOCKED
upstream — do not implement `src/otty.ts` yet.**

otty exposes **no per-pane self-identification primitive**, and both of the things
even-better needs from a `Multiplexer` — routing a self-hook report to a pane, and
knowing which panes run an agent — depend on one. Everything else (pane I/O) is
solid. §5 lists the single upstream change that would unblock this.

Read `docs/ARCHITECTURE.md` for *why* the `Multiplexer` seam exists and
`docs/MULTIPLEXERS.md` for how herdr and cmux map to it — otty would be a third
implementation of the same interface (`src/multiplexer.ts:40-72`).

> Every claim below is **observed against the real binary** (two probe rounds run
> inside otty; raw logs `/tmp/otty-probe.txt`, `/tmp/otty-probe2.txt`). Where the
> published docs disagree with what the binary does, **observed wins** — same rule
> as `docs/MULTIPLEXERS.md`. Notable doc/binary disagreements are called out inline.

---

## 0. What otty is

A **GPU-accelerated GUI terminal emulator** (tabs/splits/panes, config file,
AppleScript, an `otty` CLI) with **first-class agent hooks** for Claude Code /
Codex / OpenCode. It is *not* a headless multiplexer like herdr/cmux — it is the
terminal the user looks at. even-better would mirror it to the glasses in parallel.

Shape-wise otty is **cmux-like** (CLI-driven, no rule classifier) and would be
**`SELF_HOOK`-only**: it has no agent transcript session id and no event stream, so
even-better's own hooks would have to own busy/idle/closeError and the session
cutover. That part is fine. The blocker is narrower and harder — see §2D.

---

## 1. The interface, mapped to otty (confirmed)

| Method | otty command | Status |
|---|---|---|
| `name` | `"otty"` | — |
| `listPanes()` | **`otty pane list --json`** (docs say `otty panes` — **wrong**, no such command) | ⚠️ **no agent detection possible** — see §2D |
| `read(id, lines)` | `otty pane capture --pane <id> --lines <n>` | ✅ works; **viewport-only** (§4 P2) |
| `send(id, text, keys)` | `otty pane send-keys --pane <id> "<text>" key:Enter` | ✅ syntax confirmed (`[PARTS]...` positional, `--bracketed-paste` available) |
| `sessionId(id)` | none → `undefined` | ✅ as planned — from `SELF_HOOK` cutover |
| `exists(id)` | `otty pane show --pane <id>` | ✅ missing pane → `error: No pane matched selector`, **exit 4** |
| `watchStatus()` | **poll** | ✅ no event stream exists (§4 P6); design in §2B |
| `explain?()` | *omit* | no rule classifier |
| `interactionKind?()` | from `classifyMenu` on the captured screen | — |
| `dispose?()` | clear poll timers | — |

**Response envelope:** every `--json` call returns `{"command": "...", "data": …,
"ok": true}` — `data` is an array for `list`, an object for `show`, a string for
`capture`.

**Pane object — the complete field set:**
```
active, cols, cwd, id, index, process, rows, tab_id, window_id
```
`id` looks like `p_19f5add7a24_2`; `tab_id` / `window_id` similarly prefixed.
**There is no `pid` and no `tty`.** `process` is **not** a process name — it is the
pane **title**, which agents overwrite with their current task (observed on one
pane over time: `"✳ Claude Code"` → `"⠂ Probe otty CLI capabilities and report
findings"` → `"✳ 分析取消非IM渠道presentFile工具方案"`).

---

## 2. Design decisions

### A. Session id from `SELF_HOOK` — unchanged, still correct

otty's pane id ≠ the agent transcript UUID, so `sessionId()` returns `undefined`
and the session must arrive via even-better's own hook (`hookSessionKnown` cutover,
`bridge.ts`). With `SELF_HOOK=0` an otty backend would have no content source at
all. **This decision survives the probe** — but it is moot until §2D is solved,
because the hook report cannot be routed to a pane in the first place.

### B. No event stream ⇒ `watchStatus()` polls; awaiting is screen-only — **confirmed**

Probed and confirmed (§4 P4/P6): otty has **no event stream** (`events` /
`subscribe` / `stream` are all unrecognized subcommands) and **no point-in-time
state query**:
- `otty state <KIND> key=value` is a **write** — "Report an agent's lifecycle state
  (used by hooks and integrations)", e.g. `otty state:claude session-id=abc
  state=processing`. It takes no `--pane`.
- `otty watch <COMMAND>` is **"run a command with a progress badge"**, not an
  agent-idle waiter. (The published docs describing `otty watch:<agent> <id>` as
  blocking-until-idle with exit codes 0/4/9 do **not** match the binary's `watch`.)

So the awaiting detector must be **the screen**: blind `otty pane capture` on an
interval → a **strict per-agent visible-blocker predicate** → `routeStatus(awaiting)`.
`parseMenu` (`parse.ts`) alone is **not** that predicate — it accepts any contiguous
`1.`/`2.` run, so ordinary numbered output would false-trigger `awaiting` and send
response keys into a running agent. Gate on a real chooser: **codex** →
`isCodexApprovalScreen`; **claude** → a new, equally strict predicate (selection
cursor `❯` + confirm prompt). `watchStatus` also emits the busy/idle **edge that
clears an awaiting** (menu gone ⇒ busy mid-turn, idle if the turn ended), mirroring
cmux's `checkCodexApproval` — `PaneBridge` lets the mux drive busy/idle *while*
awaiting, so deferring all busy/idle to `SELF_HOOK` would strand the pane.

This decision is fully specified and implementable — it is not the blocker.

### C. Dual hooks (otty's + even-better's) — **untested**

otty installs its own hooks into `~/.claude/settings.json` / `~/.codex/hooks.json`
("nothing else in those files is touched"; uninstall "cleanly removes Otty's
entries" ⇒ entry-scoped append), and even-better's `addHookEntries`
(`hook-install.ts`) also appends entry-scoped — so claude coexistence should be
clean. **The codex `trusted_hash` risk is unverified** (probe P7 was deliberately
not run): trust is keyed `[hooks.state]."<path>:<snake_event>:<i>:<j>"` — by
*position* — so appending even-better's entries may shift `(i,j)` and invalidate
otty's already-trusted entries. Only worth testing if §2D is ever unblocked.

### D. 🚫 BLOCKER — otty has no way for a process to learn its own pane

**This kills the backend as designed.** even-better needs a pane id for two things:
route a self-hook report to a bridge, and know which panes run an agent. Neither is
possible.

**The hook-routing path (`src/index.ts:549` routes only on a non-empty `r.paneId`;
`src/hook-report.ts:11-13` fills it from a mux env var — cmux `CMUX_SURFACE_ID`,
herdr `HERDR_PANE_ID`) has no otty equivalent. Four independent dead ends:**

1. **No env var.** otty's *complete* shell-integration export vocabulary is
   `OTTY_BIN_DIR`, `OTTY_CLI_ALIASES`, `OTTY_FISH_XDG_ORIG`, `OTTY_FISH_XDG_RESTORE`,
   `OTTY_FLAGS_DIR`, `OTTY_JUMP_PREV`, `OTTY_PROGRESS_COMMANDS`,
   `OTTY_SHELL_INTEGRATION`, `OTTY_SSH_INTEGRATION`, `OTTY_STRIP_CJK_WRAP_PAD`,
   `OTTY_ZSH_ZDOTDIR` (+ `TERM_PROGRAM=otty`, `CW_TERM=otty`). **None is a pane id.**
   `OTTY_BIN_DIR`/`OTTY_FLAGS_DIR` point at `…/T/otty-shell-<N>/…`, but `<N>` is the
   **Otty app's own pid** (`26634 → /Applications/Otty.app/Contents/MacOS/Otty`,
   PPID 1) — one directory per *app instance*, shared by every pane.
2. **No `pid` / `tty` in the API** (§1) — so `resolvePaneId`'s pid fallback
   (`hook-report.ts:82`, which matches a report's pid against a pane's pid) has
   nothing to match on.
3. **No OSC pane-id query.** The only sequences otty emits are `133;A-D` (semantic
   prompt), `7` (cwd), `9;4` (progress). There is no pane-id query/response escape.
4. **No caller-resolving CLI, and the default is actively dangerous.** Bare
   `otty pane show` resolves to the **focused pane, not the caller's** — observed
   5/5 from a non-focused pane, each time returning *a different agent's* pane
   (a live Codex session's screen) with `ok: true`, and the answer **moved when the
   user switched tabs mid-probe**. otty's own shell integration corroborates this:
   `otty-integration.zsh:127-133` has `jump` deliberately avoid the CLI path because
   it would inject `cd` into *"the focused pane"*, using `builtin cd` locally
   instead — the author knows the CLI targets focus, not the caller.
   Every selector keyword is rejected (exit 4): `self`, `current`, `@self`, `.`,
   `active`, `focused`, `me`, `this`, `@current`, `0`, `1`, `%0`. Only a raw pane id
   resolves. The word "selector" appears in help (`Pane id or selector`) but no
   selector syntax is documented and `otty completions zsh` emits `_default` for
   every pane/tab/window slot — **there is a default resolution (the focused pane)
   but no name to request it by.**

> **`otty pane show` is unsafe as a self-identification primitive.** It does not
> merely fail — it returns *another agent's* pane, with `ok: true`, and the answer
> races the user's mouse. A hook reporting state from it would attribute status to
> whichever pane the user happens to be looking at.

**Agent detection is blocked by the same root cause.** `process` is a title the
agent overwrites, so `listPanes()` cannot say which panes run claude/codex, nor
which agent type. (Under cmux this doesn't matter — discovery is hook-only — but
that only works *because* the cmux hook knows its surface id.)

**The one remaining route is a hack:** capture-fingerprinting — have the agent emit
a unique marker, then scan every pane's `capture` for it. It is constrained by
capture being **viewport-only** (the marker scrolls away), it pollutes the agent's
transcript, and it must be redone whenever the mapping could change. Not worth
building.

---

## 3. What would unblock this (upstream ask)

**One small otty change closes the whole blocker.** Any *one* of:

1. **Inject a per-pane id env var** (e.g. `OTTY_PANE_ID=p_19f5add7a24_2`) into the
   pane's environment, inherited by child processes. This is exactly what cmux
   (`CMUX_SURFACE_ID`) and herdr (`HERDR_PANE_ID`) do, and it is the cleanest —
   even-better's hook script would read it with no new CLI calls, and agent
   discovery becomes hook-only (the cmux model). **Preferred.**
2. **Expose `pid` (and/or `tty`) in `otty pane list --json`.** Then `resolvePaneId`'s
   existing pid fallback works unchanged, and agent detection can read the real
   process instead of the title.
3. **Add a caller-resolving selector** (e.g. `--pane @caller`) that resolves by the
   calling process's tty/ancestry rather than focus. otty already performs
   caller→pane attribution internally — `otty state:<kind>` takes no `--pane`, yet
   otty routes it to the right tab's badge — so the mapping exists; it just isn't
   exposed or requestable.

Until one of these lands, `src/otty.ts` should not be written. Parking is the right
call: everything else in this doc is ready to execute the moment identity exists.

---

## 4. Probe results (observed)

| Probe | Question | Answer |
|---|---|---|
| P1 | pane discovery, fields, pid? | **`otty pane list --json`** (`otty panes` doesn't exist). Envelope `{command,data,ok}`. Fields: `active, cols, cwd, id, index, process, rows, tab_id, window_id`. **No pid, no tty.** `process` = display **title**, agent-overwritten. |
| P2 | capture: plain text? `--lines` semantics? | Plain text (or `{…,"data":"<text>"}` with `--json`). `--lines N` = **last N lines**. Default, `--lines 0`, and `--lines 10000` all return the **same 56 lines** ⇒ **viewport-only; scrollback is unreachable**. Extra flags: `--scope`, `--ansi`, `--trim`. |
| P3 | send-keys syntax | `otty pane send-keys [--pane <id>] [PARTS]...` — "Text and key parts (e.g., `"hello" key:Enter`)". `--bracketed-paste` available. Key tokens `key:Enter` etc. per help. |
| P4 | any state read? | **No.** `state <KIND> key=value` is a hook **write** (no `--pane`). `watch <COMMAND>` = "run a command with progress badge", **not** an idle waiter — the published `watch:<agent> <id>` blocking semantics do not match the binary. |
| P5 | `pane show` on a missing pane | `error: No pane matched selector`, **exit 4**. (`pane show` validates correctly — but see the `tab show` bug in §5.) |
| P6 | event stream? | **None.** `events` / `subscribe` / `stream` → `unrecognized subcommand`, exit 2. |
| P7 | codex `/hooks` re-trust coexistence | **Not run** (deferred — pointless while §2D blocks). |
| P8 | per-pane id env var? | **No.** Full `OTTY_*` vocabulary in §2D.1 — none is a pane id; the `otty-shell-<N>` dirs are keyed by the **Otty app pid**, shared across panes. |
| P8b | can a process learn its own pane id? | **No.** Env ✗, API pid/tty ✗, OSC ✗, caller-resolving CLI ✗ (bare `pane show` = **focused** pane; every selector keyword rejected). |

---

## 5. Traps and upstream bugs found (worth keeping regardless)

- **`pane.active` does NOT mean focused.** It is scoped *per tab* — 22 of 24 panes
  reported `active: true` simultaneously. The truly focused pane requires
  intersecting all three levels: `window.focused && tab.active && pane.active` —
  and even that only says where the *user* is, never where *you* are.
- **`otty tab show` silently ignores its selector — an upstream bug.** A bogus id,
  another tab's real id, and the positional form all return **the active tab** with
  `ok: true` / exit 0:
  ```
  $ otty tab show --tab bogus-tab-xyz --json
  { "command": "tab show", "data": { "active": true, "id": "t_19f5f5e897e_16", … }, "ok": true }
  ---exit:0
  ```
  This is worse than `pane show`'s honest exit-4: it returns plausible,
  confidently-wrong data with no error to trip on. Worth reporting upstream.
- **Bare `otty pane show` = the focused pane** (§2D.4) — never the caller. Any
  integration that treats it as "my pane" will silently attribute to whatever the
  user is looking at, and will race the mouse.
- **`capture` is viewport-only** — `--lines 10000` still returns the viewport, so
  scrollback cannot be reached through it.
- **The published docs disagree with the binary** in at least three places:
  `otty panes` (doesn't exist; it's `pane list`), `otty watch:<agent>` blocking
  until idle with exit 0/4/9 (the binary's `watch` runs a command with a badge), and
  a "selector" vocabulary that has no implementation.
