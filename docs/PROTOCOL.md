# even-terminal protocol (as spoken by even-better)

even-better is a **clean-room** implementation of the wire protocol the stock
Even app speaks with `@evenrealities/even-terminal` — there is no SDK dependency,
so this file is the reference for what we actually emit and accept. The transport
is plain JSON: outbound events are Server-Sent Events on `GET /api/events`
(`id: <n>\ndata: <json>\n\n`); inbound is ordinary HTTP. Replay on reconnect is
driven by `?needReplay=true` / `GET /messages?after=N`, **not** by `Last-Event-ID`
(neither server honors it — see [Transport & resilience](#transport--resilience)).
The `type` field is the whole contract — the app owns the visual, we only choose
the type and fill its fields.

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

## Transport & resilience

> **Verified as of:** even-terminal **0.8.1** (official npm dist, `routes/events.js`)
> · even-better `main` + `src/sse.ts` (`retry:` + diagnostics).
> even-better is **byte-compatible** with the package's SSE format; every
> difference below is an **intentional deviation — do not "fix" it back**.

**SSE wire format** (must stay identical — the app's EventSource parser is fixed):
- On connect: a comment line `:ok\n\n` **before anything else**.
- Per message: `id: N\ndata: {json}\n\n`.
- Heartbeat: `:heartbeat\n\n` every **15 s** per client; a write-throw drops the client.
- Headers: `text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`,
  `X-Accel-Buffering: no`, flushed before `:ok`.
- Comment lines (`:ok`, `:heartbeat`) have no `id:`/`data:` — ignored by EventSource per spec (never dispatched as a message). Their real value is keeping idle-timeout network layers (proxies, NAT, mobile radios) from treating the connection as dead — a network-stack effect, **not** an EventSource-spec guarantee. (`src/sse.ts`)

**Ring buffer & replay:**
- Per-session FIFO, `MAX_MESSAGES_PER_SESSION = 500`, **in-memory only** (lost on restart).
- Replay is triggered by `?needReplay=true` **only** — never delta-from-id.
- ⚠️ **Deviation:** the package replays the *whole* buffer; even-better caps to the
  **last 20** (`REPLAY_MAX`, `src/sse.ts`) to avoid flooding the glasses after a long
  disconnect. Precise unbounded catch-up is available via `GET /api/messages?after=N`.

**Dead-client / half-open detection:**
- Both drop a client on a `res.write()` throw (broadcast + heartbeat paths) and on `req.on('close')`.
- ⚠️ **Deviation (even-better):** a `socket.on('error')` errno log (how the socket
  died) + diagnostics — `reconnect_gap`, connection `lived` time, "no live client —
  buffering", "write/heartbeat failed — dropped dead client". (`src/sse.ts`)
- ❗ The server **cannot quickly detect a half-open socket** (phone off Wi-Fi): the
  15s heartbeat keeps the socket non-idle so TCP keepalive never fires, and Node
  exposes no `TCP_USER_TIMEOUT`, so an unacked write only fails on TCP's
  multi-minute retransmit timeout. This is an **app-side limitation** — see below.

**Auth:** the stream mounts under the same bearer middleware as all `/api`;
EventSource cannot set headers, so it requires `?token=`. even-better uses
`timingSafeEqual` + an ephemeral per-process token unless `BRIDGE_TOKEN` is set
explicitly; the package uses plain `!==` + an ephemeral per-process token.

### Reconnect / resume — measured

Diagnosed live via the `src/sse.ts` logging read off the server pane with
`cmux read-screen`:

- The Even app **never sends `Last-Event-ID`** (`lastEventId=-` on every connect),
  **never sets `needReplay=true`** on reconnect, and **never polls
  `/messages?after`** for live sessions (3 `/messages` calls in a full day's log —
  2 stale herdr sessions + 1 manual probe). So **on SSE reconnect the app receives
  nothing from the gap**: append-only events (`text_delta`/`result`/`tool_*`)
  buffered during a drop are lost; single-slot widgets (`status`/`running_stats`)
  self-heal on the next emit. The app uses none of the three catch-up mechanisms,
  so **no server-side replay can reach it** without a client change.
- **The real failure is interactivity, not content.** A half-open SSE socket
  (phone off Wi-Fi / suspended) leaves the app's EventSource believing it is still
  connected, so it never reconnects → the glass session goes unresponsive and
  **stays stuck** (tapping into it does nothing). Losing a few buffered events is
  acceptable; a stuck session is not.
- **What the server can and can't do:** un-sticking a frozen session is
  fundamentally **app-side** — the server can neither detect the half-open socket
  quickly (above) nor force a network-down phone's EventSource to reconnect (a
  server-side close can't reach it until the network returns, and even then the
  app must notice). So the server does the honest, limited things:
  - `retry: 2000` on connect — once the app *does* notice the drop, EventSource
    reconnects in 2s and keeps retrying. (`src/sse.ts`)
  - `socket.on('error')` + `[sse]` diagnostics for observability. (`src/sse.ts`)
  - No gap replay — reconnect content loss is acceptable; the priority is
    "reconnect and keep interacting".
- **Observed:** clean disconnects (the common case — app backgrounds / graceful
  close) reconnect on their own fine, including a 16-min inactivity gap. **Zero
  half-open events captured** across the diagnostic window — so the "stuck" case is
  rarer here than the clean-drop case, and it remains an app-side gap the server
  cannot close.

**Intentional deviations from 0.8.1 (do not revert):** last-20 replay cap;
immediate `status` snapshot pushed on connect (else an app connecting while idle
waits forever for a transition); `retry: 2000` + socket-error logging; timing-safe
token comparison; always-500 `/prompt` errors; stubbed `/update-check` &
`/sessions/:id/history`; no `/debug/*` or `/metrics` routes.

## Host limitation: one agent type per connection

even-better reports a **single** `provider` to the app — `/api/info` and the QR
connection default both derive it from the focused/first agent
(`providerForAgent(target)`, `focusedOrFirstBridge`). `/api/sessions` *does*
return every pane tagged with its own `provider`, but a connected app is
configured for one type, so **only that agent type's sessions surface on the
glasses**. Two agent types cannot be shown at once; to see the other, make it the
focused agent so `/info` reports it (i.e. switch the host's type). Prerequisite —
the agent must also be tracked by the mux (`docs/MULTIPLEXERS.md` §Prerequisites).

## Not wire types

Grepping `type: "..."` also hits two values that are **not** protocol events:
`search` is the input of a Codex `web_search` tool call (it rides inside a
`tool_start` `detail.input`), and `input_text` is a parameter name in the Codex
transcript parser. Neither is emitted to the app.
