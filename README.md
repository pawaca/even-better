# herdr-even-bridge

Bridge your existing [herdr](https://herdr.dev) agent sessions to Even Realities
G2 glasses. Speaks the same HTTP/SSE protocol as
`@evenrealities/even-terminal`, so the stock Even App connects by scanning the
QR code — but instead of spawning a new agent via the Claude Agent SDK, it
mirrors the agents **already running inside herdr**. The terminal session and
the glasses session are literally the same process: what you see in the pane is
what streams to the glasses, and prompts from the glasses are typed into the
pane.

```
┌── herdr ──────────────┐      ┌── bridge ─────────┐      ┌── Even App ──┐
│ claude / codex panes  │◄────►│ HTTP + SSE :3456  │◄────►│  → G2 glasses │
│ (your live sessions)  │socket│ even-terminal 协议 │ WiFi │              │
└───────────────────────┘      └───────────────────┘      └──────────────┘
```

## How it works

- **Discovery** — `agent.list` over herdr's unix socket
  (`~/.config/herdr/herdr.sock`); every agent pane becomes a "session"
  (session id = pane id, e.g. `w1:pQ`).
- **Output** — polls `pane.read` (visible screen, 600ms), filters volatile TUI
  lines (spinners, prompt boxes, status bars), diffs snapshots by scroll
  alignment, and streams new lines as `text_delta` SSE events.
- **Status** — subscribes to `pane.agent_status_changed`
  (working→busy, blocked→awaiting, idle/done→idle + result).
- **Blocked screens** — when an agent blocks, the visible screen is parsed for
  a numbered menu; yes/no menus become `permission_request`, arbitrary menus
  become `user_question`. Responses press the matching digit key in the pane.
- **Prompts** — `POST /api/prompt` types the text into the pane and presses
  Enter (`pane.send_input`).
- **Interrupt** — sends Escape.

No Claude Agent SDK, no extra agent process, no extra token spend beyond what
your terminal session already uses. Model, permission mode, and everything else
follow whatever the pane's agent is configured with.

## Usage

```bash
pnpm install
pnpm start          # prints QR code — scan with the Even App
```

Environment variables:

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3456` | HTTP port (encoded into the QR) |
| `BRIDGE_TOKEN` | random | Bearer token (encoded into the QR) |
| `HERDR_SOCKET_PATH` | `~/.config/herdr/herdr.sock` | herdr API socket |
| `NO_QR` | – | `1` disables the QR banner |
| `VERBOSE` | – | `1` logs every SSE event |
| `DEBUG_POLL` | – | `1` logs poll diffs |

The phone must reach your machine over the network (same LAN, Tailscale, etc.).

## Protocol surface (even-terminal compatible)

`GET /api/events` (SSE) · `GET /api/sessions` · `GET /api/info` ·
`GET /api/update-check` · `POST /api/prompt` · `POST /api/permission-response` ·
`POST /api/question-response` · `POST /api/interrupt` · `GET /api/status` ·
`GET /api/messages` · `GET /api/sessions/:id/history`

## Caveats

- Output is reconstructed from the rendered terminal, not structured SDK
  events: tool call summaries, token stats, and cost are not available
  (`result.costUsd` is always 0).
- Permission menus are parsed heuristically from the screen; exotic prompts
  fall back to a "check your terminal" notification.
- The bridge only *mirrors* agents — starting a brand-new session from the
  glasses picks the focused herdr agent pane instead of spawning anything.
- Never calls `server.*` socket methods (reload/stop are excluded by an
  allowlist in `src/herdr.ts`).
