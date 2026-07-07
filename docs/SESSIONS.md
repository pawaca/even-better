# Harness session storage (Claude Code + Codex)

The **source of truth** for the structured transcripts even-better tails — the
on-disk session logs that make "transcript-first" possible. This documents *the
fields even-better actually depends on* and *what breaks if the harness changes
them*, not the full upstream schema (which is internal/undocumented).

> **Verified as of:** Claude Code CLI **2.1.201** · Codex CLI **0.142.5** ·
> even-better `main`. Claims tagged 🟢 **source** (harness's own code — Claude
> Code from a local reconstructed tree, Codex from `openai/codex`), 🔵 **live**
> (real on-disk jsonl here), ⚙️ **code** (even-better's parser). External refs
> cite `path::symbol`; even-better refs cite `src/file:line`.
>
> **Forward-compat is the core risk:** both parsers **silently drop** unknown
> record/field types (zero events, zero errors). A CLI upgrade that renames a
> field or adds a block type produces no error until the parser is updated. On
> each CLI bump, diff a fresh jsonl against the "consumed" lists below.

---

## 1. Claude Code — `TranscriptTimeline` (`src/transcript.ts`)

**Location** 🔵: `~/.claude/projects/<slugified-cwd>/<sessionId>.jsonl` — one file
per session id; the directory is a sanitized cwd.

**How located** ⚙️: `findSessionFile` (`src/transcript.ts:14-22`) does **not** know
the slug rule — it stats every dir under `~/.claude/projects` for
`<dir>/<sessionId>.jsonl`. O(#projects), no cache. (The mux only hands us the
session **id**, never a path — see [§3](#3-no-transcript-path).)

**Records consumed** ⚙️ (`src/transcript.ts:24-107`):
- `type` — only `user` / `assistant` are parsed; **all other record types**
  (`last-prompt`, `mode`, `permission-mode`, `attachment`, `ai-title`, `system`)
  fall through to `[]`.
- `isSidechain:true` — dropped wholesale (sub-agent / Task traffic).
- `message.content` — **string OR array of blocks**; a string prompt starting
  with `<` (harness wrapper) is filtered.
- Content blocks: `type` (`text`/`tool_use`/`tool_result`), `text`, `id`, `name`,
  `input`, `tool_use_id`, `content`. `tool_result.content` is **string or array**
  (both handled, `resultText`). `thinking` blocks skipped.
- `message.usage.input_tokens` / `output_tokens` **only** — cache/reasoning
  fields ignored; usage attached to the first emitted block then nulled.

**Field-consumption notes (recently wired ✅ / still unused):**
- 🟢✅ **`tool_result.is_error` is now read.** The canonical error block is
  `{ type:"tool_result", content, is_error:true, tool_use_id }` (Claude Code
  `query.ts::createUserMessage`, and `QueryEngine.ts` sets `is_error` true/false).
  even-better emits `ok: b.is_error !== true` (`src/transcript.ts`), so a failed
  Claude tool call is reported as failed. (Was hardcoded `ok:true` before PR #8;
  the Codex path already read status — see §2.)
- 🟢✅ **`message.model` now read.** Every assistant record carries it (observed
  `claude-opus-4-8`); `readClaudeModel` (`src/transcript.ts`) feeds `/api/info`,
  with the status-bar scrape (`extractModel`) kept only as a pre-session fallback —
  see [§4](#4-screen--structured).
- Also available-but-unused: `AskUserQuestion` `tool_use.input.questions[]`
  (`{question, header, multiSelect, options[].{label, description}}`) — richer
  than the on-screen menu (has per-option `description`), captured into
  `pendingTools` but not used to build the question — see [§4](#4-screen--structured).

---

## 2. Codex — `CodexTranscriptTimeline` (`src/codex-transcript.ts`)

**Location** 🔵: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
when `CODEX_HOME` is set, otherwise
`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`.

**How located** ⚙️: `findCodexSessionFile` (`src/codex-transcript.ts:20-44`) does a
recursive DFS under `sessions/` matching the filename suffix `<sessionId>.jsonl`
(does not prune by the `YYYY/MM/DD` structure).

**Records consumed** ⚙️:
- Line 0 `session_meta` (`session_id`, `cli_version`, `cwd`, …) and `turn_context`
  are **not parsed** (fall through) — see the model gap below.
- `event_msg` payloads used: `token_count`, `user_message`, `agent_message`,
  `task_complete`, `web_search_end`, `turn_aborted`, `thread_rolled_back`. **Not**
  used: `task_started`, `mcp_tool_call_end` (tool completion comes from
  `response_item.function_call_output`, not the mcp event).
- `response_item` payloads used: `message` (user/assistant), `function_call`,
  `custom_tool_call`, `web_search_call`, `tool_search_call`,
  `function_call_output`, `custom_tool_call_output`, `tool_search_output`.
  **`reasoning` items never matched** → reasoning invisible by design.
- `function_call.arguments` is a **JSON-encoded string**, not an object
  (`parseArguments` JSON.parses with a fallback).
- `token_count`: reads `info.last_token_usage` + `info.total_token_usage`, and of
  those only `input_tokens`/`output_tokens` (prefers `total_token_usage` as a
  delta vs the prior total; else `last_token_usage` snapshot with dedup).
  `cached_input_tokens`/`reasoning_output_tokens` ignored.

**Codex dedup** ⚙️: the same text arrives twice (`event_msg.{user,agent}_message`
**and** `response_item.message`); `isDuplicateMessage` suppresses the second
within `MESSAGE_DEDUPE_MS=30s` (`src/codex-transcript.ts:88`) across *different*
sources (`isDuplicateMessage`, `src/codex-transcript.ts:327-343`).
`tool_search_call` deduped by `call_id` (`startedToolSearches`, `:306-310`).

**Contract gaps:**
- 🟢🔵✅ **`model` now read.** Codex persists it in the `turn_context` record as a
  **required** field: `pub model: String` in
  `codex-rs/protocol/src/protocol.rs::TurnContextItem` → wire
  `turn_context.payload.model` (🔵 observed `gpt-5.5`). `readCodexModel`
  (`src/codex-transcript.ts`) reads it for `/api/info` — was always `"Unknown"`
  before PR #8.
- Codex tool status IS read (`outputOk()` on `function_call_output`) — unlike the
  Claude path (§1). Documenting the asymmetry so it isn't "fixed" into symmetry.

---

## <a id="3-no-transcript-path"></a>3. There is no transcript **path** from the mux

Both multiplexers hand even-better only a session **id**, so the filesystem scan
(§1/§2) is load-bearing, not a lazy shortcut:
- **herdr** 🟢: `agent_session.value` is always the session UUID; herdr builds a
  `Path` kind only for agents named `pi`/`omp`, never claude/codex
  (`herdr src/agent_resume.rs::session_ref_from_report`).
- **cmux** 🟢: `<agent>-hook-sessions.json` *does* persist
  `sessions[id].transcriptPath`, **but it is not reliably present** — fork-session
  launches skip the SessionStart upsert until the first prompt, and cmux's own
  `AgentChatTranscriptResolver` existence-checks it and falls back to a
  derived/scanned path. Our scan mirrors that fallback. **Do not assume
  `transcriptPath` is always populated.**

`Multiplexer.PaneInfo` (`src/multiplexer.ts:19-26`) therefore exposes only an
optional `sessionId`, no `transcriptPath`. See `docs/MULTIPLEXERS.md §6`.

---

## <a id="4-screen--structured"></a>4. Screen → structured migration checklist

**Invariant:** screen heuristics (`parseMenu`, `classifyMenu`, `extractModel`,
`extractResult`, dedup, volatile-line filter) must **never** run over a structured
transcript — they are screen-only fallbacks. These are the residual screen
dependencies and whether a structured source can replace them:

| Screen dependency | Recovers | Structured source | Status |
|---|---|---|---|
| `extractModel` (`/api/info`) | model name (status-bar regex, claude-only → codex "Unknown") | claude `message.model`; codex `turn_context.payload.model` | ✅ **wired (PR #8)** — scrape is fallback-only |
| `parseMenu`/`classifyMenu` for **AskUserQuestion** | question + option labels | claude `tool_use.input.questions[]` (already in `pendingTools`, has per-option `description`) | **available, unwired** |
| `parseMenu`/`classifyMenu` for **plain permission menus** | menu title + Yes/No/allow-always option text | **none** — the TUI choice text is never in the jsonl | **none** (screen is sole source) |
| `extractResult` (`emitTurnResult`) | final turn text | claude `lastProseBlock` / codex `turnResultText` (used first when a transcript exists) | **none needed** (only the pre-session-id window) |

**Already structured (done):** codex tool completion via
`response_item.function_call_output`; prose via `lastProseBlock` before any screen
fallback; all dedup/volatile/echo-suppression confined to `ScreenTimeline`.

Wired in PR #8: `/api/info` model (`readClaudeModel`/`readCodexModel`) +
`tool_result.is_error`. Still unwired: AskUserQuestion options from
`tool_use.input.questions[]` (lower value / higher risk — deferred).

---

## 5. Re-derivation recipe

```bash
# Claude: inspect a real session + the record/field types we rely on
ls -t ~/.claude/projects/*/*.jsonl | head -1
python3 -c "import json,sys,collections; f=sorted(__import__('glob').glob('$HOME/.claude/projects/*/*.jsonl'))[-1]; \
  c=collections.Counter(json.loads(l).get('type') for l in open(f)); print(c)"   # record types
# is_error present on error tool_result blocks (Claude Code source: query.ts::createUserMessage)

# Codex: model lives in turn_context, tokens in token_count
ROLL=$(ls -t "${CODEX_HOME:-$HOME/.codex}"/sessions/**/rollout-*.jsonl 2>/dev/null | head -1)
grep -o '"model":"[^"]*"' "$ROLL" | sort -u          # turn_context.payload.model
# codex source: codex-rs/protocol/src/protocol.rs::TurnContextItem (pub model: String)

# Round-trip our parser against current jsonl:
npx tsx scripts/test-transcript.ts
```
