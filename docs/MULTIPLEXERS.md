# Multiplexer socket contract (herdr + cmux)

The **source of truth** for the two multiplexer backends even-better mirrors: what
each exposes over its socket/CLI, and how those map to the neutral `Multiplexer`
interface (`src/multiplexer.ts`). Read `docs/ARCHITECTURE.md` for *why* the seam
exists; this doc is *what the backends actually do*.

> **Verified as of:** herdr **0.7.1** (`Cargo.toml`; shallow-clone HEAD → wire
> protocol **16** in `src/protocol/wire.rs`) · cmux **0.64.17** (build 97,
> `9ed29d81a`) · even-better `main` (post-#6). Every non-obvious claim
> cites its source: even-better code as `src/file:line`; external code as
> `<repo> path::symbol` against a pinned clone; or a **repro** command. When
> upstream docs, `--help`, and observed behavior disagree, **observed/source
> wins** — see [Discrepancies](#discrepancies). Re-derivation recipe at the end.

Provenance tags: 🟢 **source** (read the backend's own code) · 🔵 **live**
(ran it here) · ⚙️ **code** (even-better consumes it).

---

## Prerequisites: agent hooks must be installed, or the agent is invisible

even-better can only mirror an agent the **multiplexer already tracks**, which
depends on per-agent hooks. This is the first thing to check when "my agent
doesn't show up." (🔵 verified on this machine + 🟢 cmux source.)

| Mux + agent | Setup | How / gotcha |
|---|---|---|
| **cmux + claude** | none — automatic | cmux ships `cmux-claude-wrapper`; a per-surface PATH shim (`$TMPDIR/cmux-cli-shims/<surface>/claude`) intercepts `claude` and injects `--settings {hooks:…}` at launch. **claude-only** — there is no codex wrapper/shim. |
| **cmux + codex** | `cmux hooks codex install` (once) | Writes cmux's hooks into `~/.codex/hooks.json` (appends alongside herdr's, doesn't overwrite). **Then codex registers only on its _first prompt_**, not at launch: it fires `SessionStart`/`UserPromptSubmit` lazily, so a fresh unprompted codex stays invisible until you send it one message. |
| **herdr + claude** | install herdr's hook | `~/.claude/settings.json` → `herdr-agent-state.sh session`. |
| **herdr + codex** | install herdr's hook | `~/.codex/hooks.json` → `herdr-agent-state.sh session`. |

So: **cmux auto-detects claude only; codex needs a one-time install + a first
prompt. herdr needs a per-agent hook install for both.** Without the hook the
agent's session id never reaches the mux socket, so `sessionId()`/`listPanes()`
cannot see it.

**Related host limitation (one agent type at a time):** even-better's `/api/info`
and the QR connection report a **single** `provider` — the focused/first agent's
type (`focusedOrFirstBridge`). `/api/sessions` returns *both* types (each tagged
`provider`), but the connected app configures for one, so only that type's
sessions surface on the glasses. To see the other agent, make it the focused agent
(switch the host's type). Details in `docs/PROTOCOL.md`.

---

## 1. The interface, mapped to both backends

`Multiplexer` (`src/multiplexer.ts:39-67`): 7 required methods, 3 optional. Both
`HerdrMultiplexer` (`src/herdr.ts`) and `CmuxMultiplexer` (`src/cmux.ts`)
implement all 7 required; the 3 optional split by backend.

| Method | herdr | cmux | Notes / asymmetry |
|---|---|---|---|
| `name` | `"herdr"` | `"cmux"` | Selected at boot (`index.ts` `selectMux`): `MUX=` env forces; else a single detected backend is auto-picked (`herdrAvailable()` = socket connect, `cmuxAvailable()` = `cmux ping`); **both detected → interactive prompt on a TTY** (blank/invalid answer defaults to herdr, probed first), **or a hard error requiring `MUX=` with no TTY** — no silent tie-break. |
| `listPanes()` | RPC `agent.list` → `agents[]` → `PaneInfo` (`herdr.ts` `HerdrMultiplexer.listPanes`) | derives from `~/.cmuxterm/{claude,codex}-hook-sessions.json` (`cmux.ts` `refreshMaps`) | **Fundamental asymmetry:** herdr enumerates *live panes* in one RPC; cmux *reconstructs* panes from on-disk hook state + pid liveness. |
| `watchStatus()` | subscribe `pane.agent_status_changed` + `pane.closed` (`events.subscribe`) | one long-lived `cmux events --reconnect --no-heartbeat --no-ack --category agent --category surface` child, routing `agent.hook.*` + `surface.*` | herdr = a real status field; cmux = **hook-name-driven** (see [§3](#3-cmux)). |
| `read(id, lines)` | RPC `pane.read`, `source` ∈ `visible\|recent\|recent_unwrapped` | `cmux read-screen --surface <id>` | herdr wire enum is **snake_case** (source-confirmed below). |
| `send(id, text, keys)` | RPC `pane.send_input` `{text, keys[]}` | `cmux send --surface <id> -- <text>` + `cmux send-key --surface <id> -- <key>` | **Invariant (both):** multi-key sequences are separate presses with a gap, never bundled (`pressAndVerify`, `src/bridge.ts`). |
| `sessionId(id)` | `agent.list`/`pane.get` → `agent_session.value` | `cmux surface resume get --json --surface <id>` → `resume_binding.checkpoint_id` | **Neither exposes a transcript path** (source-confirmed) — the jsonl filesystem scan is load-bearing, not a skipped optimization. |
| `exists(id)` | `pane.get` (`paneExists`) | `surface resume get` succeeds (`cmux.ts` `exists`) | |
| `explain?()` | **herdr only** — RPC `agent.explain` | *not implemented* (no rule classifier) | By design: herdr status is region-rule inference; cmux status is hook events. |
| `interactionKind?()` | *not implemented* | **cmux only** — `permission`\|`question` from the hook that opened the blocker (`cmux.ts`) | herdr recovers kind via screen `classifyMenu`. |
| `dispose?()` | *not implemented* (socket sub released on close) | **cmux only** — kills the `cmux events` child (`cmux.ts`) | |

Shared helper `typeAndSubmit(mux, id, text)` (`src/multiplexer.ts`) composes
`send`+`read` (type → wait for echo → Enter); used for prompt injection.

---

## 2. herdr

**Transport.** JSON-RPC over a Unix socket, one request line → one response line.
Path: `HERDR_SOCKET_PATH` else `~/.config/herdr/herdr.sock` (`src/herdr.ts`).
🟢 The full CLI is documented by `herdr <sub> --help`; the raw protocol lives at
`herdr.dev/docs/socket-api/`.

**SAFE_METHODS allowlist** (`src/herdr.ts:19-30`, ⚙️): `agent.list`, `pane.get`,
`pane.read`, `pane.send_input`, `events.subscribe`, `agent.explain`, plus
`workspace.create`/`workspace.close`/`pane.report_agent` **reserved for the
self-test only — zero call sites**. `server.*` is excluded end-to-end.
> **Invariant — never call `server.*`:** `server.reload_config`/`server.stop`
> kill the running herdr. Keep new methods inside the allowlist.

**agent_status vocabulary — exactly 4 states.** 🟢 `enum AgentState { Idle,
Working, Blocked, Unknown }` (herdr `src/detect/mod.rs::AgentState`). "done" is a
*notification/sound* concept, **not** a detection state. even-better maps
`working→busy`, `blocked→awaiting`, everything else (`idle`/`unknown`)→`idle`
(`mapHerdrStatus`, `src/herdr.ts`).

**`pane.read` sources — snake_case wire values.** 🟢 herdr
`src/api/schema/common.rs::ReadSource` is `#[serde(rename_all="snake_case")]` →
`visible`, `recent`, `recent_unwrapped`, `detection`. `detection` is sugar over
`recent` fixed to viewport rows (`src/pane/terminal.rs::detection_text`) — even-better
doesn't use it. even-better only sends `visible` (`getMux().read`).

**Key names are CASE-INSENSITIVE.** 🟢 `pane.send_input` keys go
`encode_api_keys → parse_api_key → normalize_api_key_alias(trim) → parse_key_combo`,
and `parse_key_combo` does `key_str.to_lowercase()` before matching (herdr
`src/config/keybinds.rs::parse_key_combo`, `src/app/api_helpers.rs`). Aliases:
`enter`|`return`, `esc`|`escape`. So even-better's capitalized `"Enter"`,
`"Escape"`, `"Down"` are all valid.

**events.subscribe surface.** 🟢 herdr's `Subscription` enum supports **24**
event types (6 workspace + 3 worktree + 5 tab + 9 pane + 1 layout — herdr
`src/api/schema/events.rs::Subscription`);
even-better subscribes to just `pane.agent_status_changed` and `pane.closed`.
(`PaneOutputChanged` exists in `EventKind` but is *not* directly subscribable —
only matchable in `events.wait`.)

**No transcript path over the socket.** 🟢 `AgentSessionInfo{source, agent,
kind:Id|Path, value}` — but `session_ref_from_report()` only builds `Path` for
agents named `pi`/`omp`; **claude/codex always get `Id` only** (herdr
`src/agent_resume.rs`, `src/api/schema/agents.rs`). So `agent_session.value` is
always the session UUID; the jsonl path is not obtainable from herdr.

**id format.** 🔵 Live ids are `w1`, `w1:t1`, `w1:p1`, `w654cdbe81c27d1:pW` — **not**
the `1`/`1:1`/`1-1` the skill shows. even-better treats them as opaque strings, so
it's unaffected, but **do not quote `1-1` as a literal**.
> **Invariant — ids compact:** herdr ids are reassigned when panes/tabs/workspaces
> close; never treat them as durable. even-better re-derives per bridge session.

**self-test method shapes** (allowlisted, uncalled) 🟢: `workspace.create` →
`WorkspaceCreated{workspace, tab, root_pane}`; `workspace.close` → `Ok{}`;
`pane.report_agent(_session)` → `Ok{}` (state observed via events).

---

## 3. cmux

**Transport.** The `cmux` CLI talks to the running app over a control socket
(`CMUX_SOCKET_PATH` else `~/.local/state/cmux/cmux.sock`). even-better shells the
CLI (`CMUX_BIN` else the app bundle else PATH) and detects liveness with
**`cmux ping`** (`cmuxAvailable`, `src/cmux.ts`) — a probe, not a hard-coded
socket path, because the default path differs by build.

**Status is hook-driven, not a status field.** even-better runs one shared
`cmux events` child and maps `agent.hook.*` → status (`src/cmux.ts` `onEvent`):

| hook | → status | note |
|---|---|---|
| `UserPromptSubmit`, `PreToolUse` | `busy` | except the tool-name special cases below |
| `Stop` | `idle` | |
| `PermissionRequest`, `AskUserQuestion` | `awaiting` (kind `permission`/`question`) | |
| `PreToolUse` where `tool_name ∈ {AskUserQuestion, ExitPlanMode}` | `awaiting` (`question`) | see skip-permissions below |
| `Notification` | *dropped* | ambiguous (also fires for idle reminders), carries no message |
| `surface.closed` | `closed` | |

**Every `agent.hook.*` is delivered TWICE.** 🟢 `TerminalController.v2FeedPush`
publishes each event unconditionally with `phase="received"` (on receipt) then
`phase="completed"` (after `FeedCoordinator.ingestBlocking` returns) — for *every*
hook, including fire-and-forget telemetry (cmux `Sources/TerminalController.swift`,
`Sources/Feed/FeedCoordinator.swift`). 🔵 Confirmed live: `received`/`completed`
counts match 1:1 per hook type.
> **Invariant — dedupe by phase:** even-better acts on `phase==="received"` only
> (`src/cmux.ts` `onEvent`). Processing both double-drives every transition — a
> duplicate `busy` after `Stop` cancels the idle debounce with no re-arm
> (stranding the turn, glasses keep timing) and re-emits interactive menus.

**category is always `"agent"`.** 🟢 `publishWorkstreamEvent` is the single
`agent.hook.*` publish site and hardcodes `category:"agent"` with no branch on
hook name (cmux `Sources/CmuxEventPublishing.swift`). So even-better's
`--category agent --category surface` filter is complete.

**PermissionRequest / AskUserQuestion / ExitPlanMode — and skip-permissions.**
🟢 Claude Code has **no native `AskUserQuestion` or `ExitPlanMode` hook**; cmux
re-tags the generic `PermissionRequest` hook by `tool_name` into wire events
`("AskUserQuestion"|"ExitPlanMode", actionable:true)` (cmux
`CLI/FeedEventClassifier.swift::dedicatedApprovalEvent`). **Crucially, under
`--dangerously-skip-permissions` (permission_mode `bypassPermissions`), Claude
fires NEITHER `PermissionRequest` NOR `Notification`**, so `PreToolUse` carrying
`tool_name` is the *only* needs-input signal (cmux's own regression fix #6606,
`CLI/cmux.swift`). This is why even-better routes `PreToolUse{AskUserQuestion,
ExitPlanMode}` → awaiting: it is **required**, not redundant, whenever the agent
runs with skip-permissions (the default under cmux on this machine).

**Codex approval is architecturally different.** 🟢 The wire hook vocabulary is
unified (codex snake_case → same PascalCase names, same received/completed
wrapper), **but** codex's own `permission_request` hook is classified
`.toolStart` (non-actionable, so codex's auto-reviewer isn't short-circuited);
codex's real blocking approval comes from a **separate**
`CLI/CodexTeamsApprovalBridge.swift` that synthesizes its own
`hook_event_name:"PermissionRequest"` from app-server JSON-RPC — bypassing the
classifier. (even-better's cmux path is claude-shaped; codex-in-cmux interactive
approval is **unverified end-to-end** — see [Open](#open).)

**agent.hook payload fields** 🟢 (`Sources/CmuxEventPublishing.swift::workstreamPayload`):
always `session_id, hook_event_name, _source, workspace_id, cwd, tool_name`;
`tool_input`/`context`/`extra_fields` redacted to null + a `_length` counterpart.
Note `session_id` is prefixed (`claude-<uuid>`); even-better strips it to the bare
UUID (`bareSession`, `src/cmux.ts`).

**hook-sessions file — three indices.** 🟢 `~/.cmuxterm/<agent>-hook-sessions.json`
holds `sessions{}`, `activeSessionsByWorkspace`, `activeSessionsBySurface`.
`upsert` always writes `sessions[id]`; the active-index maps are written only when
`markActive:true`, and at SessionStart `markActive = !isForkSessionLaunch &&
(isClearSessionStart || canReplaceStoppedSession)` — **false for a fresh agent**
(cmux `CLI/cmux.swift`). Promotion to the active index happens at the first
`UserPromptSubmit`.
> **Invariant — read all three sources:** a `cmux new-workspace --command`-launched
> agent (and any launched-but-unprompted session) lands **only in `sessions{}`**,
> not `activeSessionsBySurface`. even-better's `refreshMaps` unions
> activeSessionsBySurface + pid-alive `sessions{}` + activeSessionsByWorkspace
> (`src/cmux.ts`); reading only the surface index misses those panes.

**resume binding — nested only.** 🟢 `surface resume get` emits `kind`/`checkpoint_id`
**only nested under `resume_binding`**, never top-level (cmux
`Packages/macOS/CmuxControlSocket/.../ControlCommandCoordinator+Surface3.swift::surfaceResumeBindingPayload`).
even-better also accepts a top-level shape defensively (`sessionId`, `src/cmux.ts`),
but that fallback guards a **non-existent case** and can be simplified (the
cited cmux#6285 is an unrelated fish-shell bug, not a resume-shape skew).

**transcriptPath exists but is unreliable.** 🟢 `sessions[id].transcriptPath` is
persisted at SessionStart from the hook's `transcript_path`, but fork-session
launches skip the upsert until first `UserPromptSubmit`; cmux's own
`AgentChatTranscriptResolver` existence-checks it and falls back to a derived/
scanned path. even-better's filesystem scan mirrors exactly this fallback — the
"skip the scan via transcriptPath" idea is **not safe** (do not pursue).

---

## <a id="discrepancies"></a>4. Discrepancies (docs/`--help`/comments vs source/live)

| Area | Docs / comment say | Source / live | Authoritative |
|---|---|---|---|
| herdr id format | `1`, `1:1`, `1-1` (SKILL.md) | `w1`, `w1:p1`, … | 🔵 live (0.7.1) |
| herdr `pane.read` source | `recent-unwrapped` (hyphen; docs+`--help`) | wire is `recent_unwrapped` (underscore); hyphen errors over the raw socket (CLI translates) | 🟢 source (`ReadSource` serde) |
| herdr `--json` on `agent list`/`get` | assumed a `--json` flag | `agent list`/`pane list` emit JSON **unconditionally**; `--json` on list/get **errors**. Only `agent explain` has a real `--json` | 🔵 live |
| cmux `surface resume` | absent from `cli-contract.md` | real + load-bearing (`surface resume get\|show\|set\|clear`) | 🔵 live `--help` |
| cmux AskUserQuestion "only via PreToolUse on some builds" | even-better comment | on 0.64.17 both the dedicated hook AND `PreToolUse{AskUserQuestion}` fire; PreToolUse is the *sole* signal only under skip-permissions | 🟢 source (#6606) |
| cmux `resume_binding` top-level skew (#6285) | code comment | nested-only; #6285 misattributed | 🟢 source (refuted) |

---

## 5. Invariants (each cost a debugging round)

1. **Never call `server.*` on herdr** — kills it. (§2)
2. **herdr ids compact** — re-derive, never persist. (§2)
3. **cmux: act on `phase==="received"` only** — else double-driven transitions strand turns / re-emit menus. (§3)
4. **cmux: read all three hook-session indices** — `--command`/unprompted agents live only in `sessions{}`. (§3)
5. **cmux `PreToolUse{AskUserQuestion,ExitPlanMode}`→awaiting is required under skip-permissions** — the only needs-input signal there. (§3)
6. **Multi-key sequences = separate presses with a gap** — bundling races the TUI highlight. (§1)
7. **Neither backend gives a transcript path** — the jsonl scan is load-bearing. (§1, §2, §3)

---

## <a id="open"></a>6. Open (needs a live run, not source)

- **cmux `PermissionRequest` / `ExitPlanMode` end-to-end** — never observed live (this machine runs claude with `--dangerously-skip-permissions`, which suppresses them). Verify with a claude session **without** skip-permissions that hits a real approval / plan-mode.
- **codex-in-cmux interactive approval** — routes through the separate `CodexTeamsApprovalBridge`, not the claude-shaped hook path even-better implements. Unverified against a live codex-in-cmux session.

---

## Re-derivation recipe

```bash
# herdr (Rust) — clone + confirm
git clone --depth 1 https://github.com/ogulcancelik/herdr
rg -n "enum AgentState" src/detect/mod.rs                    # 4 states
rg -n "enum ReadSource" -A6 src/api/schema/common.rs         # snake_case wire
rg -n "fn parse_key_combo" -A25 src/config/keybinds.rs       # to_lowercase → case-insensitive
herdr agent list                                             # live: JSON unconditionally; ids are w1:pN

# cmux (Swift) — clone + confirm
git clone --depth 1 https://github.com/manaflow-ai/cmux
rg -n "publishWorkstreamEvent|category: \"agent\"" Sources/CmuxEventPublishing.swift
rg -n "phase: \"received\"|phase: \"completed\"" Sources/TerminalController.swift
rg -n "dedicatedApprovalEvent|ExitPlanMode|AskUserQuestion" CLI/FeedEventClassifier.swift
rg -n "bypassPermissions" CLI/cmux.swift                     # skip-permissions suppresses PermissionRequest+Notification
cmux ping                                                    # live: PONG when running
tail -n 4000 ~/.cmuxterm/events.jsonl | \
  python3 -c "import sys,json,collections;c=collections.Counter(json.loads(l).get('name') for l in sys.stdin);print(c.most_common(20))"
```
