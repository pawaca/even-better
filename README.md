# even-better

Mirror a terminal coding-agent session (Claude Code or Codex) onto **Even
Realities G2** glasses. even-better speaks the same HTTP/SSE protocol as
`@evenrealities/even-terminal`, so the stock Even App connects by scanning a QR
code — but instead of spawning a new agent, it **mirrors an agent you're already
running inside a terminal multiplexer** ([herdr](https://herdr.dev) or
[cmux](https://github.com/manaflow-ai/cmux)). The terminal session and the
glasses are the same process: what you see in the pane streams to the glasses,
and prompts from the glasses are typed into the pane.

```
┌── herdr / cmux ───────┐      ┌── even-better ─────────┐      ┌── Even App ──┐
│ claude / codex panes  │◄────►│ HTTP + SSE             │◄────►│  → G2 glasses │
│ (your live sessions)  │socket│ even-terminal protocol │ WiFi │              │
└───────────────────────┘      └────────────────────────┘      └──────────────┘
```

> Unofficial project — not affiliated with or endorsed by Even Realities,
> Anthropic, herdr, or cmux. The wire protocol is a clean-room, compatible
> implementation of what `@evenrealities/even-terminal` speaks; no code from that
> package is included.

## Prerequisites

- **macOS** (primary target), with one terminal multiplexer running and at least
  one `claude` or `codex` agent live in a pane — even-better mirrors those; it
  never spawns an agent itself. Either:
  - **[herdr](https://herdr.dev)**, or
  - **[cmux](https://github.com/manaflow-ai/cmux)** (agent hooks must be
    installed — Claude Code is automatic, Codex needs `cmux hooks codex install`).
- **Node.js ≥ 18** and **pnpm**.
- **Even Realities G2** glasses paired with the **Even App** on your phone.
- For remote access: the matching CLI (`tailscale`, `cloudflared`, `ngrok`,
  `bore`, or the built-in `ssh` for pinggy) — see [Remote access](#remote-access-off-your-wi-fi).

## Quick start

```bash
pnpm install
pnpm start          # prints a QR code — scan it with the Even App
```

That's it — the glasses now show your live agent. Prompts you send from the
glasses are typed into the pane; the agent's replies stream back.

If both herdr and cmux are running, pick one with `MUX=herdr` or `MUX=cmux`.

## What it does

- **Mirrors, never spawns.** No extra agent process and no extra token spend
  beyond what your terminal session already uses. Model, permission mode, and
  everything else follow whatever the pane's agent is configured with.
- **Lossless output.** It reads the agent's structured session transcript
  (Claude/Codex jsonl) as the source of truth, so what reaches the glasses
  matches the pane without screen-scraping guesswork. (It falls back to reading
  the screen only briefly, before the session's transcript is available.)
- **Interactive.** Permission prompts and questions become menus on the glasses
  you can answer; the answer is sent back into the pane. Prompts and interrupts
  from the glasses drive the same pane.

For how this is built, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Configuration

Everything is optional — `pnpm start` works with no flags.

| Var | Default | Meaning |
| --- | --- | --- |
| `MUX` | auto | Multiplexer backend: `herdr` or `cmux`. Auto-detects; if both are present, prompts on a TTY (set this to choose) |
| `PORT` | `auto` | HTTP port. Unset/`auto`/`0` asks the OS for a free port; set a number only when you need a fixed one |
| `BIND_HOST` | `auto` | Local bind/QR host: `auto`, `lan`, `local`, `tailscale`, or a literal IP. `PUBLIC_ACCESS` requires `auto` or loopback |
| `PUBLIC_ACCESS` | `none` | Public access provider: `none`, `tailscale-funnel`, `pinggy`, `bore`, `ngrok`, `cloudflared` |
| `PUBLIC_BASE_URL` | – | Existing external URL to put in the QR instead of starting `PUBLIC_ACCESS` (named tunnels, reverse proxies). Requires a fixed `PORT` |
| `BRIDGE_TOKEN` | ephemeral | Bearer token encoded into the QR. Unset means a fresh per-process token every launch |
| `LOG` | `normal` | Logging mode: `off`, `normal`, `debug`, or `trace` |
| `LOG_FILE` | `/tmp/even-better-<id>.events.log` | JSONL event log path |
| `QR` | `1` | Print a QR code. Set `0` to print only the URL |

The phone must be able to reach your machine over the network (same LAN,
Tailscale, etc.).

**Security.** The endpoint can drive a coding agent — i.e. run code on your
machine — guarded only by the bearer token. On a trusted home LAN the default QR
is fine; on an untrusted network use `BIND_HOST=tailscale`. See
[SECURITY.md](SECURITY.md).

## Remote access (off your Wi-Fi)

- **`BIND_HOST=tailscale` (recommended)** — private, WireGuard-encrypted, stable
  IP, no time limit, nothing exposed publicly. Best for regular use.
- **`PUBLIC_ACCESS=tailscale-funnel`** — public HTTPS at your stable `*.ts.net`
  name; the phone needs no client and SSE works. Requires Funnel enabled in the
  Tailscale admin console once.
- **`PUBLIC_ACCESS=pinggy`** — quick public access over the built-in `ssh`, zero
  install, supports SSE. Free tunnels rotate every 60 min. `bore`/`ngrok` also
  work (`ngrok` needs an authtoken).
- **Cloudflare** — the *quick* provider (`cloudflared`, trycloudflare.com) **does
  not support SSE**. Use a **named tunnel** pointed at the local URL instead
  (fixed `PORT` + `PUBLIC_BASE_URL=https://<your-hostname>`).

## Protocol surface

even-terminal-compatible endpoints under `/api`: `GET /events` (SSE) ·
`GET /sessions` · `GET /info` · `POST /prompt` · `POST /permission-response` ·
`POST /question-response` · `POST /interrupt` · `GET /status` · `GET /messages` ·
`GET /sessions/:id/history` · `GET /update-check`. Field-level reference in
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## Troubleshooting

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Caveats

- Cost isn't computed (token counts are reported; `costUsd` is always 0).
- A pane whose transcript isn't readable yet (e.g. a fresh agent before its
  session id exists) falls back to lossy screen scraping until it is.
- Permission menus are read from the screen; exotic prompts fall back to a
  "check your terminal" notification.
- even-better only *mirrors* — it won't start a brand-new session from the
  glasses; it picks the focused pane.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

[MIT](LICENSE)
