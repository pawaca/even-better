# even-terminal protocol (as spoken by even-better)

even-better is a **clean-room** implementation of the wire protocol the stock
Even app speaks with `@evenrealities/even-terminal` — there is no SDK dependency,
so this file is the reference for what we actually emit and accept. The transport
is plain JSON: outbound events are Server-Sent Events on `GET /api/events`
(`id: <n>\ndata: <json>\n\n`, `id` enabling Last-Event-ID resume); inbound is
ordinary HTTP. The `type` field is the whole contract — the app owns the visual,
we only choose the type and fill its fields.

## Outbound (server → glasses, over SSE)

Every event falls into one of four **consumption semantics**; the app renders by
which bucket a `type` belongs to. Emit the right one (see `bridge.ts`).

### 1. Append — immutable, added to the transcript

Once sent it cannot be edited (this is why prose is buffered and rendered whole
before emit — see `renderForGlasses`).

| type | fields | meaning |
|------|--------|---------|
| `text_delta` | `text` | assistant prose, streamed a few code points per tick |
| `user_prompt` | `text` | one user turn (typed from anywhere) |
| `result` | `success, text, sessionId, costUsd, provider, turns, durationMs, inputTokens, outputTokens` | a turn's closing summary |
| `notification` | `title, message` | an informational message (e.g. "respond in the terminal") |

### 2. Keyed update — one bubble, running → done (shared `toolId`)

`tool_start` opens a bubble; `tool_end` with the same `toolId` closes it. The app
labels and colours the tool event.

| type | fields |
|------|--------|
| `tool_start` | `name, toolId, summary, detail:{ input }` |
| `tool_end` | `name, toolId, summary, detail:{ input, output }` |

### 3. Single-slot widget — overwrites one UI element (never appends)

| type | fields | notes |
|------|--------|-------|
| `status` | `state: "busy" \| "idle", sessionId` | the thinking indicator |
| `running_stats` | `durationMs, inputTokens, outputTokens` | emitted every 10s during a turn |
| `task_progress` | `completed, total, current` | from `TodoWrite` / Codex `update_plan` (`todoProgress`/`planProgress`) |

### 4. Interactive — menu + reply, in pairs

The request opens a menu on the glasses; the app answers via an inbound endpoint
(below); the server then emits the paired result as an acknowledgement.

| request | fields | paired result | fields |
|---------|--------|---------------|--------|
| `permission_request` | `toolName, description, detail, toolUseId, options:[{ text, key }], suggestions` | `permission_result` | `toolName, summary, decision: "always" \| "allowed" \| "denied"` |
| `user_question` | `questions:[{ question, header, options:[{ label, description, preview }] }], toolUseId` | `question_answer` | `answers:{ answer }` |

## Inbound (glasses → server, plain HTTP)

All under `/api`, bearer-token auth (`?token=` or `Authorization: Bearer`).

| method | path | purpose |
|--------|------|---------|
| GET | `/events` | subscribe to the SSE stream (`?sessionId=`) |
| GET | `/sessions` | list agent panes |
| GET | `/info` | model / provider / version |
| GET | `/status` | one pane's state |
| GET | `/messages` | ring-buffer replay (`?after=`) |
| GET | `/update-check` | version check (static) |
| GET | `/sessions/:id/history` | history (currently empty) |
| POST | `/prompt` | inject a user turn (`{ text, sessionId }`) |
| POST | `/permission-response` | answer a `permission_request` (`{ sessionId, decision }`) |
| POST | `/question-response` | answer a `user_question` (`{ sessionId, answer }`) |
| POST | `/interrupt` | send Escape to the pane (`{ sessionId }`) |

## Not wire types

Grepping `type: "..."` also hits two values that are **not** protocol events:
`search` is the input of a Codex `web_search` tool call (it rides inside a
`tool_start` `detail.input`), and `input_text` is a parameter name in the Codex
transcript parser. Neither is emitted to the app.
