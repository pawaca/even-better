# even-better

Bridge your existing [herdr](https://herdr.dev) agent sessions to Even Realities
G2 glasses. Speaks the same HTTP/SSE protocol as
`@evenrealities/even-terminal`, so the stock Even App connects by scanning the
QR code — but instead of spawning a new agent via the Claude Agent SDK, it
mirrors the agents **already running inside herdr**. The terminal session and
the glasses session are literally the same process: what you see in the pane is
what streams to the glasses, and prompts from the glasses are typed into the
pane.

```
┌── herdr ──────────────┐      ┌── bridge ──────────────┐      ┌── Even App ──┐
│ claude / codex panes  │◄────►│ HTTP + SSE :3456       │◄────►│  → G2 glasses │
│ (your live sessions)  │socket│ even-terminal protocol │ WiFi │              │
└───────────────────────┘      └────────────────────────┘      └──────────────┘
```

> Unofficial project — not affiliated with or endorsed by Even Realities,
> Anthropic, or herdr. The wire protocol is a clean-room compatible
> implementation of what `@evenrealities/even-terminal` speaks; no code from
> that package is included.

## Prerequisites

- macOS (tested) with [herdr](https://herdr.dev) running, and at least one
  `claude` (or `codex`) agent running in a herdr pane — the bridge mirrors
  those; it never spawns agents itself.
- Node.js ≥ 18 and `pnpm`.
- Even Realities G2 glasses paired with the Even App on your phone.
- Depending on `ACCESS`: nothing extra for `lan`/`local`; the `tailscale` CLI
  for `tailscale`/`tailscale-funnel`; the matching CLI for other tunnels
  (`ssh` for pinggy, `cloudflared`, `bore`, `ngrok`).

## How it works

- **Discovery** — `agent.list` over herdr's unix socket
  (`~/.config/herdr/herdr.sock`); every agent pane becomes a "session"
  (session id = pane id, e.g. `w1:pQ`).
- **Output (transcript-first)** — for claude and codex panes, the structured
  session transcript is the primary source: assistant text -> `text_delta`,
  tool calls -> `tool_start` + a one-line summary, tool results -> `tool_end`
  with truncated output, token usage -> result counts. Claude transcripts live
  under `~/.claude/projects/*/<session>.jsonl`; Codex rollout transcripts live
  under `${CODEX_HOME:-~/.codex}/sessions/**/rollout-*<session>.jsonl`.
  Structured sources are lossless and avoid screen-scraping heuristics. Screen
  polling (visible, 300ms, volatile-filter + multiset diff) remains only as a
  fallback while herdr has not exposed a session id yet or when the transcript
  file cannot be found; a 2s probe switches over automatically once available.
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
| `ACCESS` | `lan` | How the phone reaches the bridge — sets both the bind and the single QR: `lan` (same Wi-Fi), `local` (same machine), `tailscale`, `tailscale-funnel` (or `funnel`), `pinggy`, `bore`, `ngrok`, `cloudflared`, or a literal IP |
| `MUX` | auto | Multiplexer backend: `herdr` or `cmux`. Unset: uses whichever one is present; if both are, prompts on a TTY and errors without one (set this to choose) |
| `HERDR_SOCKET_PATH` | `~/.config/herdr/herdr.sock` | herdr API socket |
| `CMUX_BIN` | app bundle / `cmux` on PATH | cmux CLI used when `MUX=cmux`. cmux mirrors agents whose session ids it captured via `cmux hooks setup --agent claude\|codex` |
| `CODEX_HOME` | `~/.codex` | Codex home used to find rollout transcripts |
| `DEFAULT_PROVIDER` | focused herdr agent | Provider hint encoded in the QR; it does not spawn or switch the underlying agent |
| `EVENT_LOG` | `/tmp/even-better-events.log` | JSONL log of app requests, SSE events, and diagnostics |
| `EVENT_LOG_TEXT` | `1` | Set `0` to omit high-volume `text_delta` rows from `EVENT_LOG` |
| `DEBUG_STREAM` | `1` | Set `0` to silence capture/send/drop stream tracing |
| `NO_QR` | – | `1` disables the QR banner |
| `VERBOSE` | – | `1` logs every SSE event |

The phone must reach your machine over the network (same LAN, Tailscale, etc.).

**Security note.** The API can drive Claude Code (i.e. run code on your machine),
guarded only by the bearer token. On a trusted home LAN the default `ACCESS=lan`
is fine. On an untrusted network (office, public Wi-Fi) use `ACCESS=tailscale`:
the port stays invisible to the LAN and is reachable only over the private,
WireGuard-encrypted tailnet, so the token never travels in the clear and nothing
can port-scan you into an agent session.

The bearer token is persisted at `~/.config/even-better/token` (mode 0600) so you
scan the QR once; rotate it by deleting that file (or set `BRIDGE_TOKEN`).

## Remote access (off your Wi-Fi)

- **`ACCESS=tailscale` (recommended)** — private, WireGuard-encrypted, stable IP,
  no time limit. Nothing exposed publicly. Scan the one QR. Best for regular use.
- **`ACCESS=tailscale-funnel`** (shorthand: `funnel`) — public HTTPS at your stable
  `*.ts.net` name; the **phone needs no client**, SSE works (verified), and it
  tears the tunnel down when the bridge exits. Requires Funnel enabled in the
  Tailscale admin console once. Best no-install remote option. The bridge runs
  `tailscale funnel <PORT>` in the foreground, scrapes the public URL, and runs
  `tailscale funnel reset` on exit so a crashed child does not leave the local
  bridge publicly exposed.
- **`ACCESS=pinggy`** — quick public tunnel over the built-in `ssh`, zero install,
  supports SSE. Free tunnels rotate every 60 min. Good for a one-off share.
  `bore`/`ngrok` also work (`bore` is plain HTTP; `ngrok` needs an authtoken).
- **Cloudflare** — its *quick* tunnel (`ACCESS=cloudflared`, trycloudflare.com)
  **does not support SSE**, so live output will not stream. To use Cloudflare,
  set up a **named tunnel** pointed at `localhost:<PORT>` (SSE works, and you can
  put Cloudflare Access auth in front of a stable hostname); then connect via
  `https://<your-hostname>?token=<TOKEN>&defaultProvider=claude`.

## Protocol surface (even-terminal compatible)

`GET /api/events` (SSE) · `GET /api/sessions` · `GET /api/info` ·
`GET /api/update-check` · `POST /api/prompt` · `POST /api/permission-response` ·
`POST /api/question-response` · `POST /api/interrupt` · `GET /api/status` ·
`GET /api/messages` · `GET /api/sessions/:id/history`

## Troubleshooting

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for runbooks covering:
why a pane fell back to `ScreenTimeline`, how `provider` relates to the real
herdr agent, how to read `EVENT_LOG`, and how to verify Tailscale Funnel/SSE.

## Caveats

- Cost isn't computed (`result.costUsd` is always 0); token counts are reported.
- For panes without a readable transcript (for example, a fresh agent before
  herdr exposes its session id), output falls back to lossy screen scraping
  until the transcript is available.
- Permission menus are parsed heuristically from the screen; exotic prompts
  fall back to a "check your terminal" notification.
- The bridge only *mirrors* agents — starting a brand-new session from the
  glasses picks the focused herdr agent pane instead of spawning anything.
- Never calls `server.*` socket methods (reload/stop are excluded by an
  allowlist in `src/herdr.ts`).

## License

[MIT](LICENSE)
