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
│ claude / codex panes  │◄────►│ HTTP + SSE :auto       │◄────►│  → G2 glasses │
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
- Depending on `BIND_HOST`/`PUBLIC_ACCESS`: nothing extra for `lan`/`local`; the
  `tailscale` CLI for `tailscale`/`tailscale-funnel`; the matching CLI for other providers
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
  under `$CODEX_HOME/sessions/**/rollout-*<session>.jsonl` when `CODEX_HOME` is
  set, otherwise `~/.codex/sessions/**/rollout-*<session>.jsonl`.
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
| `PORT` | `auto` | HTTP port. Unset/`auto`/`0` asks the OS for a free port; set a number only when you need a fixed port |
| `BIND_HOST` | `auto` | Local bind/QR host: `auto`, `lan`, `local`, `tailscale`, or a literal IP. `auto` binds LAN for direct mode and loopback for tunnels/public base URLs; `PUBLIC_ACCESS` requires `auto` or loopback |
| `PUBLIC_ACCESS` | `none` | Public access provider to start: `none`, `tailscale-funnel`, `pinggy`, `bore`, `ngrok`, `cloudflared` |
| `PUBLIC_BASE_URL` | – | Existing external URL to put in the QR instead of starting `PUBLIC_ACCESS`, useful for named tunnels and reverse proxies. Requires a fixed `PORT` |
| `BRIDGE_TOKEN` | ephemeral | Bearer token encoded into the QR. Unset means a fresh per-process token every launch |
| `INSTANCE_ID` | process id | Instance label used in the banner, default event log path, and generated Funnel path |
| `LOG` | `normal` | Logging mode: `off`, `normal`, `debug`, or `trace` |
| `LOG_FILE` | `/tmp/even-better-<INSTANCE_ID>.events.log` | JSONL event log path |
| `QR` | `1` | Print a QR code. Set `0` to print only the URL |
| `MUX` | auto | Multiplexer backend: `herdr` or `cmux`. Unset: uses whichever one is present; if both are, prompts on a TTY and errors without one (set this to choose) |

The phone must reach your machine over the network (same LAN, Tailscale, etc.).

**Security note.** The API can drive Claude Code (i.e. run code on your machine),
guarded only by the bearer token. Tokens are not persisted by default; every
launch gets a fresh token unless you explicitly set `BRIDGE_TOKEN`. On a trusted
home LAN the default direct LAN QR is fine. On an untrusted network (office,
public Wi-Fi) use `BIND_HOST=tailscale`:
the port stays invisible to the LAN and is reachable only over the private,
WireGuard-encrypted tailnet, so the token never travels in the clear and nothing
can port-scan you into an agent session.

## Remote access (off your Wi-Fi)

- **`BIND_HOST=tailscale` (recommended)** — private, WireGuard-encrypted, stable IP,
  no time limit. Nothing exposed publicly. Scan the one QR. Best for regular use.
- **`PUBLIC_ACCESS=tailscale-funnel`** — public HTTPS at your stable
  `*.ts.net` name; the **phone needs no client**, SSE works (verified), and it
  tears only its own Funnel mapping down when the bridge exits. Requires Funnel
  enabled in the Tailscale admin console once. The bridge auto-picks one of
  Tailscale's public ports (`443`, `8443`, `10000`); if they are all occupied by
  Funnel, it falls back to mounting this instance at `/eb/<INSTANCE_ID>/`.
  Public access providers proxy to `127.0.0.1`, so do not combine this with
  `BIND_HOST=lan`, `BIND_HOST=tailscale`, or another non-loopback bind.
- **`PUBLIC_ACCESS=pinggy`** — quick public access over the built-in `ssh`, zero install,
  supports SSE. Free tunnels rotate every 60 min. Good for a one-off share.
  `bore`/`ngrok` also work (`bore` is plain HTTP; `ngrok` needs an authtoken).
- **Cloudflare** — its *quick* provider (`PUBLIC_ACCESS=cloudflared`, trycloudflare.com)
  **does not support SSE**, so live output will not stream. To use Cloudflare,
  set up a **named tunnel** pointed at the printed local URL (SSE works, and you
  can put Cloudflare Access auth in front of a stable hostname), then start with
  a fixed port and `PUBLIC_BASE_URL=https://<your-hostname>`.

## Protocol surface (even-terminal compatible)

`GET /api/events` (SSE) · `GET /api/sessions` · `GET /api/info` ·
`GET /api/update-check` · `POST /api/prompt` · `POST /api/permission-response` ·
`POST /api/question-response` · `POST /api/interrupt` · `GET /api/status` ·
`GET /api/messages` · `GET /api/sessions/:id/history`

## Troubleshooting

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for runbooks covering:
why a pane fell back to `ScreenTimeline`, how `provider` relates to the real
herdr agent, how to read `LOG_FILE`, and how to verify Tailscale Funnel/SSE.

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
