# otty multiplexer backend — probe results and verdict

**Status: PROBED first-hand (2026-07, otty 1.2.3). Verdict: BLOCKED on a single
unimplemented AppleScript property — `tab.tty` returns an empty string. Everything
else needed is present and working.**

The design is complete and ready to build; it is gated on one upstream bug, not on
a missing feature. See §3.

Read `docs/ARCHITECTURE.md` for *why* the `Multiplexer` seam exists and
`docs/MULTIPLEXERS.md` for how herdr and cmux map to it — otty would be a third
implementation of the same interface (`src/multiplexer.ts:40-72`).

> Every claim below is **observed against the real binary**, most of it from a
> claude session running *inside* an otty pane. Where the published docs disagree
> with the binary, **observed wins** — same rule as `docs/MULTIPLEXERS.md`. Notable
> doc/binary disagreements are called out inline.

---

## 0. What otty is, and the key structural fact

A **GPU-accelerated GUI terminal emulator** (tabs/splits/panes, config file,
AppleScript, an `otty` CLI) with **first-class agent hooks** for Claude Code /
Codex / OpenCode. It is *not* a headless multiplexer like herdr/cmux — it is the
terminal the user looks at.

**The structural fact that drives every decision here: otty's AppleScript layer
exposes strictly MORE than its CLI.** The CLI has pane-level I/O but no process
identity; AppleScript has `processes`, `tty`, `contents`, `history` at tab level.
Its own dictionary header says so: *"Everything maps onto Otty's existing session
plumbing (the same primitives the `otty` CLI / IPC layer uses)."* So the backend is
a **hybrid**: AppleScript for identity, CLI for I/O.

> ⚠️ An earlier revision of this plan ruled AppleScript out on principle ("CLI only
> — `do script` can't express the key grammar, and AppleScript is macOS-only"). That
> was the single wrong call that produced a false "no identity is possible" verdict:
> the probes that followed never looked at AppleScript. `do script` indeed can't do
> the menu key grammar — but AppleScript doesn't need to. It only supplies identity;
> the CLI still does `capture`/`send-keys`.

otty would be **`SELF_HOOK`-only**: it exposes no agent transcript session id and no
event stream, so even-better's hooks must own busy/idle/closeError and the session
cutover (§2A/§2B). That part is settled and fine.

---

## 1. The interface, mapped to otty (observed)

| Method | Source | Status |
|---|---|---|
| `name` | `"otty"` | — |
| `listPanes()` | CLI **`otty pane list --json`** + AppleScript `processes` | ✅ CLI gives panes; **AppleScript supplies the agent detection** the CLI can't (§2D) |
| `read(id, lines)` | CLI `otty pane capture --pane <id> --lines <n>` | ✅ works; **viewport-only** (AppleScript `history` has full scrollback if ever needed) |
| `send(id, text, keys)` | CLI `otty pane send-keys --pane <id> "<text>" key:Enter` | ✅ `[PARTS]...` positional; `--bracketed-paste` available. **CLI only** — AppleScript `do script` can't express keys |
| `sessionId(id)` | none → `undefined` | ✅ as designed — session arrives via `SELF_HOOK` cutover |
| `exists(id)` | CLI `otty pane show --pane <id>` | ✅ missing pane → `error: No pane matched selector`, **exit 4** |
| `watchStatus()` | **poll** | ✅ no event stream exists (§4 P6); design in §2B |
| `explain?()` | *omit* | no rule classifier |
| `interactionKind?()` | `classifyMenu` on the captured screen | — |
| `dispose?()` | clear poll timers | — |

**CLI response envelope:** `{"command": "...", "data": …, "ok": true}` — `data` is an
array for `list`, an object for `show`, a string for `capture`.

**CLI pane object — complete field set:**
`active, cols, cwd, id, index, process, rows, tab_id, window_id`.
`id` = `p_19f5add7a24_2`. **No `pid`, no `tty`.** `process` is **not** a process name
— it is the pane **title**, which agents overwrite with their current task (observed
on one pane over time: `"✳ Claude Code"` → `"⠂ Probe otty CLI capabilities…"` →
`"✳ 分析取消非IM渠道presentFile工具方案"`). **CLI tab objects** add `pane_count` and
`title` but likewise carry no session, agent state, or pid.

**AppleScript `tab` — the identity layer** (`/Applications/Otty.app/Contents/Resources/Otty.sdef`):

| Property | Works? | Notes |
|---|---|---|
| `processes` | ✅ | **Real process names**, unlike the CLI's title. Observed: `zsh` + `2.1.210` (claude reports its version), `zsh` + `codex-aarch64-apple-darwin`, `zsh` + `btop`. |
| `id` | ✅ | `19f5add7a24_2` — the CLI's tab id **minus the `t_` prefix**. sdef: *"also usable as a selector with the `otty` CLI"*. |
| `contents` / `history` | ✅ | Visible screen / full scrollback (3252 chars observed). `history` beats the CLI's viewport-only `capture`. |
| `busy`, `working directory`, rows/cols, `custom title`, `selected` | ✅ | `busy` is useless for turn status (an agent is a foreground process for its whole session). |
| **`tty`** | ❌ **returns `""`** | **The blocker.** See §2D. |

There is **no `pane` class** in AppleScript — it is tab-level only (Terminal.app
compatibility). Tabs may hold several panes (`pane_count: 2` observed).

---

## 2. Design decisions

### A. Session id from `SELF_HOOK` — settled

otty's pane id ≠ the agent transcript UUID, so `sessionId()` returns `undefined` and
the session arrives via even-better's own hook (`hookSessionKnown` cutover,
`bridge.ts`). With `SELF_HOOK=0` an otty backend has no content source at all — the
boot banner must warn when `MUX=otty` and `SELF_HOOK` is unset.

### B. No event stream ⇒ `watchStatus()` polls; awaiting is screen-only — settled

Observed (§4 P4/P6): otty has **no event stream** (`events`/`subscribe`/`stream` are
unrecognized subcommands) and **no point-in-time state query**:
- `otty state <KIND> key=value` is a **write** — "Report an agent's lifecycle state
  (used by hooks and integrations)". It takes no `--pane`.
- `otty watch <COMMAND>` **runs a command with a progress badge** — it is not an
  agent-idle waiter. (The published docs describing `otty watch:<agent> <id>` as
  blocking-until-idle with exit 0/4/9 do **not** match the binary.)

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

### C. Dual hooks (otty's + even-better's) — untested, low risk

otty's hook is a readable, code-signed script
(`/Applications/Otty.app/Contents/Resources/agent-integration/claude/otty-hook.sh`)
registered in `~/.claude/settings.json`. It calls
`otty-cli state:claude session-id=<sid> state=<state> bypass=<0|1>` — note it sends
**no pane id and no pid** (the `$PPID` it receives is used only locally, to detect
`--dangerously-skip-permissions` via `ps -o args=`). even-better's `addHookEntries`
also appends entry-scoped, so claude coexistence should be clean. The codex
`trusted_hash` risk is unverified (trust is keyed by *position* —
`[hooks.state]."<path>:<snake_event>:<i>:<j>"` — so appending may shift `(i,j)`).
Worth testing only once §2D is unblocked.

> That otty routes a hook carrying **only a session id** to the correct tab's badge
> proves otty maintains `session-id ↔ tab` internally and resolves the caller
> server-side. The capability is there; none of it is exposed to third parties.

### D. 🚫 BLOCKER — `tab.tty` is declared, documented, and returns `""`

even-better needs a pane id for two things: route a self-hook report to a bridge
(`src/index.ts:549` routes only on a non-empty `r.paneId`; `src/hook-report.ts:11-13`
fills it from a mux env var — cmux `CMUX_SURFACE_ID`, herdr `HERDR_PANE_ID`), and
know which panes run an agent.

**Agent detection is solved** by AppleScript `processes` (real names). ✅

**Routing has exactly one designed path, and it is one property away from working:**

```
report.pid  (HookReport.pid — the hook's parent = the agent)
  → ps -o tty= -p <pid>                 → /dev/ttysNNN
  → AppleScript: match tab whose tty == that
  → tab.id (e.g. 19f5add7a24_2) + "t_"  → CLI tab id
  → otty pane list --json, filter tab_id → the pane id
```

Verified first-hand from a claude session inside an otty pane — the OS side of the
chain is intact:
```
64835 32121 ttys036  claude --dangerously-skip-permissions --resume 58c97098-…
32121 32118 ttys036  -zsh                 ← the pane's shell
32118 26634 ttys036  /usr/bin/login -qflp wuxin /bin/zsh -fc cd '/Users/wuxin/…'
26634     1 ??       /Applications/Otty.app/Contents/MacOS/Otty
```
The agent and its pane's shell share `ttys036`. Every link resolves — **except the
one that maps a tty back to a tab.**

**`tab.tty` returns an empty string on 25/25 tabs.** Not `missing value`, not an
error — exit 0, empty. Even the sdef's *own* header example fails:
```
$ osascript -e 'tell application "Otty" to get tty of selected tab of front window'
          # → "" (exit 0)
$ osascript -e 'tell application "Otty" to get {id, busy, working directory} of tab 1 of window 1'
19f5add7a24_2, true, /Users/wuxin/Works/driven-agent      # other properties work fine
```
while the dictionary declares it:
```xml
<property name="tty" code="oTty" type="text" access="r"
          description="The tty device path of the tab's shell (e.g. /dev/ttys003).">
    <cocoa key="tty"/>
</property>
```
It is a **stub** — a shipped, declared, documented property with no implementation.

**Every other identity route is genuinely absent** (all observed):
1. **No pane-id env var.** otty's complete export vocabulary — `OTTY_BIN_DIR`,
   `OTTY_CLI_ALIASES`, `OTTY_FISH_XDG_ORIG`, `OTTY_FISH_XDG_RESTORE`,
   `OTTY_FLAGS_DIR`, `OTTY_JUMP_PREV`, `OTTY_PROGRESS_COMMANDS`,
   `OTTY_SHELL_INTEGRATION`, `OTTY_SSH_INTEGRATION`, `OTTY_STRIP_CJK_WRAP_PAD`,
   `OTTY_ZSH_ZDOTDIR` (+ `TERM_PROGRAM=otty`, `CW_TERM=otty`) — has none. The
   `…/T/otty-shell-<N>/…` dirs are keyed by the **Otty app's pid** (`26634 → Otty`,
   PPID 1), one per *app instance*, shared by every pane.
2. **No `pid`/`tty` in the CLI API** — so `resolvePaneId`'s pid fallback
   (`hook-report.ts:82`) has nothing to match on.
3. **No OSC pane-id query.** Only `133;A-D` (semantic prompt), `7` (cwd), `9;4`
   (progress) are emitted.
4. **No caller-resolving CLI — and its default is dangerous.** Bare `otty pane show`
   resolves to the **focused pane, not the caller's**: observed 5/5 from a
   non-focused pane returning *another agent's* live session with `ok: true`, and the
   answer **moved when the user switched tabs mid-probe**. otty's own shell
   integration works around this same hazard — `otty-integration.zsh:127-133` has
   `jump` avoid the CLI path because it would inject `cd` into *"the focused pane"*.
   Every selector keyword is rejected (exit 4): `self`, `current`, `@self`, `.`,
   `active`, `focused`, `me`, `this`, `@current`, `0`, `1`, `%0`. Only raw ids
   resolve; `otty completions zsh` emits `_default` for every slot. There is a
   default resolution (focused) but **no name to request any other**.

**Remaining unknown (only matters after the fix):** `tty` is documented as "the
**tab's shell**" (singular), but a tab may hold several panes. If an agent sits in
the second pane of a split, its tty may not match any tab's. Mitigation: the tab
match still narrows the search to that tab's panes (`pane_count` was 1 for nearly
every observed tab), where cwd or a content check disambiguates cheaply.

---

## 3. What unblocks this (upstream)

**One bug fix: implement `tab.tty`.** It is already declared in `Otty.sdef`,
documented with an example device path, and used in the dictionary header's own
usage sample — it just returns `""`. This is a **bug report against a shipped,
documented API**, not a feature request. With it, §2D's chain closes and
`src/otty.ts` is buildable as specified here.

Equivalent alternatives, if upstream prefers (any *one* suffices):
- **Inject a per-pane id env var** (e.g. `OTTY_PANE_ID`), as cmux (`CMUX_SURFACE_ID`)
  and herdr (`HERDR_PANE_ID`) do. Cleanest of all — the hook script reads it with no
  extra process calls and no AppleScript.
- **Add `pid`/`tty` to `otty pane list --json`** — then `resolvePaneId`'s existing
  pid fallback works unchanged.
- **Add a caller-resolving selector** (e.g. `--pane @caller`). otty already performs
  caller→pane attribution internally for `state:<kind>` (§2C), so the mapping exists;
  it is simply not requestable.

**Until then: park `src/otty.ts`.** A content-fingerprint workaround (match the
transcript against each tab's `contents`/`history`) is possible but not worth
building — it is heuristic, and the upstream fix is a one-liner.

**A second, unrelated bug worth reporting:** `otty tab show` silently ignores its
selector (§5).

---

## 4. Probe results (observed)

| Probe | Question | Answer |
|---|---|---|
| P1 | pane discovery, fields, pid? | **`otty pane list --json`** (`otty panes` doesn't exist). Envelope `{command,data,ok}`. Fields: `active, cols, cwd, id, index, process, rows, tab_id, window_id`. **No pid, no tty.** `process` = agent-overwritten **title**. |
| P2 | capture semantics | Plain text (`--json` wraps as `{…,"data":"<text>"}`). `--lines N` = **last N lines**. Default, `--lines 0`, `--lines 10000` all return the **same 56 lines** ⇒ **viewport-only**. Flags: `--scope`, `--ansi`, `--trim`. AppleScript `history` reaches scrollback. |
| P3 | send-keys syntax | `otty pane send-keys [--pane <id>] [PARTS]...` — "Text and key parts (e.g. `"hello" key:Enter`)". `--bracketed-paste` available. |
| P4 | any state read? | **No.** `state <KIND> key=value` is a hook **write** (no `--pane`); `watch <COMMAND>` runs a command with a badge, **not** an idle waiter. |
| P5 | `pane show` on a missing pane | `error: No pane matched selector`, **exit 4**. (`tab show` does *not* validate — §5.) |
| P6 | event stream? | **None.** `events`/`subscribe`/`stream` → `unrecognized subcommand`, exit 2. |
| P7 | codex `/hooks` re-trust coexistence | **Not run** — deferred until §2D is unblocked. |
| P8 | per-pane id env var? | **No** — full vocabulary in §2D.1; `otty-shell-<N>` is keyed by the **Otty app pid**, shared across panes. |
| P9 | can a process learn its own pane? | **Not today.** Designed route = `pid → tty → tab → pane`; blocked solely by `tab.tty` returning `""` (25/25 tabs). Env ✗, CLI pid/tty ✗, OSC ✗, caller selector ✗. |
| P10 | AppleScript identity layer | `processes` ✅ (real names — **agent detection solved**), `id` ✅ (CLI id minus `t_`), `contents`/`history` ✅, `busy`/`cwd` ✅, **`tty` ❌ empty**. No `pane` class — tab-level only. |

---

## 5. Traps and upstream bugs found (worth keeping regardless)

- **`tab.tty` is a declared, documented stub returning `""`** (§2D) — the one thing
  standing between this plan and a working backend.
- **`otty tab show` silently ignores its selector — an upstream bug.** A bogus id,
  another tab's real id, and the positional form all return **the active tab** with
  `ok: true` / exit 0:
  ```
  $ otty tab show --tab bogus-tab-xyz --json
  { "command": "tab show", "data": { "active": true, "id": "t_19f5f5e897e_16", … }, "ok": true }
  ---exit:0
  ```
  Worse than `pane show`'s honest exit-4: plausible, confidently-wrong data with no
  error to trip on.
- **Bare `otty pane show` = the focused pane**, never the caller — and it moves as
  the user clicks (§2D.4).
- **`pane.active` does NOT mean focused.** It is scoped *per tab* — 22 of 24 panes
  reported `active: true` at once. True focus needs
  `window.focused && tab.active && pane.active`, and even that says where the *user*
  is, never where *you* are.
- **`capture` is viewport-only** — `--lines 10000` still returns the viewport.
- **The published docs disagree with the binary** in at least three places:
  `otty panes` (doesn't exist — it's `pane list`), `otty watch:<agent>` blocking
  until idle with exit 0/4/9 (the binary's `watch` runs a command with a badge), and
  a "selector" vocabulary with no implementation.
