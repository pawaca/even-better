# Permission / interaction flow (claude + codex)

How even-better turns a blocked agent pane into a `permission_request` /
`user_question` on the glasses and injects the answer back. This is the **one**
interaction where even-better must both *detect*, *present*, and *respond* — so
it is where screen-scraping is hardest to avoid.

> **Verified as of** (🔵 driven live in scratch cmux panes this session): claude
> 2.1.x, codex 0.142.5. 🟢 = agent source (`openai/codex` clone), ⚙️ =
> even-better code (`src/file:line`).

---

## The three layers

Every approval is three separable steps. They have **different** data sources and
**different** reliability per agent:

```
① Trigger   detect "agent is blocked, awaiting a decision"  → state = awaiting
② Present   know "what is being approved" + "the options"    → permission_request
③ Respond   send the user's decision back                    → keypress
```

| Layer | claude | codex | source even-better uses |
|-------|--------|-------|-------------------------|
| ① Trigger | ✅ hook | ❌ **absent** (see root cause) | mux event (`agent.hook.*`) |
| ② Present · command | ✅ | ✅ | transcript `function_call`/`tool_use` (`pendingTools`) |
| ② Present · options | ✅ | ⏳ **PR #11** (not on `main`) | **screen** `parseMenu` (`src/parse.ts`) |
| ③ Respond | ✅ | ✅ | fixed keys `Enter`/`Down+Enter`/`Escape` |

---

## ① Trigger — why codex has none (root cause, 🟢 source-confirmed)

even-better flips a pane to `awaiting` only on `agent.hook.PermissionRequest`, or
`agent.hook.PreToolUse` when `tool_name ∈ {AskUserQuestion, ExitPlanMode}`
(`src/cmux.ts:346-370`). Claude's tool approval **is** a hook (cmux relays it), so
it works. Codex's is not:

- **Codex's shell/patch approval is a protocol `EventMsg`, not a hook.**
  `ExecApprovalRequest` / `ApplyPatchApprovalRequest` are `EventMsg` variants; the
  `PermissionRequest` **hook** is invoked only from `mcp_tool_call.rs`
  (`run_permission_request_hooks`) — i.e. **MCP tools only**. 🟢 So the injected
  cmux/herdr hook never fires for a command/patch approval. 🔵 Confirmed live: an
  open non-YOLO codex approval fired only `PreToolUse(Bash)` + `Stop`, **zero
  `PermissionRequest`**.
- **Those approval `EventMsg`s are not persisted to the rollout jsonl.**
  `wrapped_protocol_event_type(ExecApprovalRequest) → None`
  (🟢 `codex-rs/rollout-trace/src/protocol_event.rs`). So even-better's transcript
  tail cannot see them either.
- **In plain-TUI codex** (how it is normally run in a terminal pane), codex's own
  TUI renders the menu; cmux's `CodexTeamsApprovalBridge` — which *does* turn
  approvals into structured feed events — only fires for cmux's app-server-driven
  **agent-session** surfaces (`item/commandExecution/requestApproval` over
  JSON-RPC), not a plain `codex`. 🔵 No approval-bearing `feed.item.*` appeared on
  the event stream during the test. And even-better subscribes to `agent.hook.*`,
  not `feed.item.*`, anyway.

**Net:** for plain-TUI codex the approval exists in exactly one channel
even-better can reach — the **screen**. Not the hook stream, not the rollout.
This is an architecture constraint, not a config gap: **claude exposes approvals
via hooks; codex exposes them via a protocol/TUI channel even-better does not
subscribe to.** A structured codex trigger is therefore **not available** in this
setup — a coarse screen detector is the only option (like herdr's screen-based
`AgentState`, which cmux lacks).

---

## ② Present + ③ Respond — verified stable (🔵 live)

Both layers were driven end-to-end against real TUIs this session.

> **Codex ② depends on PR #11** (the `[❯›]` marker + contiguity fix). On `main`
> today `parseMenu` skips only `❯`, so a codex approval still mis-parses — the
> codex rows below hold **once #11 merges**, not before.

**② `parseMenu` / `classifyMenu` — 5 real menus, all correct** (with the `[❯›]`
marker fix from #11; the highlighted option is marked `❯` by claude and `›` by
codex — the regex must skip both, else it is dropped and a 3-option approval
mis-parses into a 2-option "question". #11 also requires a contiguous 1,2,3 run
so a `›` prompt echo is not read as a menu):

| menu | opts | classify |
|------|------|----------|
| claude trust | 2 | permission |
| claude Write approval | 3 | permission (allow/always/deny) |
| codex trust (`›`) | 2 | permission |
| codex exec approval (`›`, `(y)(p)(esc)` suffixes) | 3 | permission |
| codex apply_patch approval (`›`, "for these files") | 3 | permission |

Regression fixtures in `scripts/test-menu.ts`.

**③ Respond — fixed keys, all three decisions, both agents:**

| decision | keys | verified |
|----------|------|----------|
| allow | `Enter` (confirms highlighted opt 1) | claude → file created; codex → file created |
| deny | `Escape` | codex → patch **not** applied |
| allow-always | `Down` then `Enter` (separate presses) | codex → `›` moved to opt 2, command ran |

Codex's own footer ("Press enter to confirm or esc to cancel", opt 1 highlighted)
matches this grammar exactly, so `respondPermission`'s primary path works for both
agents. The digit fallback (`1`/`2`/`3`) is claude-shaped; codex uses letter
shortcuts (`y`/`p`/`esc`), so the fallback is codex-suboptimal — but the primary
`Enter`/arrow/`Escape` path is what runs.

---

## Residual fragilities (honest)

1. **Timing.** ③ sends keys after ① fires + a 400 ms paint wait (`emitBlockedMenu`)
   with `pressAndVerify` retries. A slow-painting menu (codex can escalate-reject-
   retry, taking 20 s+) can still be read/keyed before it is drawn. 🔵 Observed:
   keys sent before paint went into the void.
2. **English-keyword classification.** `classifyMenu` matches `yes`/`no`/`don't
   ask` — every tested menu is English; a reworded or localized menu would
   misclassify. Both agents render English today.
3. **Title heuristic.** "nearest non-separator line above" grabbed a stray
   "Security guide" on the claude trust screen — affects the *question* title,
   not permission classification.
4. **`AskUserQuestion` forms** (variable options, not the fixed allow/deny triad)
   still depend on reading option labels — for claude those labels are also in the
   transcript (`tool_use.input.questions[]`, the deferred structured-source item).

---

## Design direction

- **claude:** hook trigger (stable) + parse + fixed keys — solid as-is.
- **codex:** trigger **must** be a coarse screen detector (no structured source
  exists — §① above); keep ② command from the transcript + ③ fixed keys. The
  stability goal is a *coarse, anchor-based* "is an approval prompt on screen"
  check (e.g. "Would you like to run" / "Would you like to make the following
  edits"), **not** parsing options to decide blocked-ness.
- Demote `parseMenu` from "core dependency" toward "confirmation": present the
  **fixed** decision triad + transcript command; use the screen only for the
  coarse trigger and, where needed, question-form option labels.
