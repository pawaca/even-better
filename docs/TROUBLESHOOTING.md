# Troubleshooting

This file is a field guide for diagnosing what the glasses app actually
received and why a pane used a particular content source.

## First Checks

Start from the server banner:

```bash
PORT=3457 BRIDGE_TOKEN=test-token LOG_FILE=/tmp/even-better-events.log pnpm start
```

The banner prints:

- the instance id, local bind, actual local port, and local/public URL
- the token encoded in the QR
- the `LOG` mode and `LOG_FILE` path
- the herdr agents discovered by `agent.list`, including `agent`, `pane_id`,
  `agent_status`, and `cwd`

The app session id is the herdr `pane_id`, for example `w1:p1`. The `provider`
field is derived from the herdr agent name (`codex` -> `codex`, everything else
-> `claude`) and is mainly an even-terminal protocol/display hint. It does not
spawn or switch the real underlying agent; the bridge mirrors whichever herdr
pane it targets.

## Transcript vs ScreenTimeline

The bridge always prefers a structured transcript:

- Claude: `~/.claude/projects/*/<session>.jsonl`
- Codex: `$CODEX_HOME/sessions/**/rollout-*<session>.jsonl`, or
  `~/.codex/sessions/**/rollout-*<session>.jsonl` when `CODEX_HOME` is unset

For claude/codex the transcript is the **only** content source — there is no
screen fallback. Until the session id resolves **and** its transcript file exists,
the pane streams no content; the bridge retries the upgrade (session-id fetch +
file lookup) on its poll, and also upgrades immediately off a status event that
carries the session. On success it prints one of:

```text
[bridge w1:p1] tailing transcript /path/to/claude.jsonl
[bridge w1:p1] tailing codex transcript /path/to/rollout-....jsonl
```

If a claude/codex pane shows **no content**:

1. Check the startup banner has `agent : codex pane=...` (the pane is detected).
2. Check herdr is reporting an agent session id for that pane (herdr 0.7.2+ exposes
   it via built-in detection). No session id ⇒ no transcript ⇒ no content — the
   pane does **not** fall back to scraping the screen.
3. Check the rollout/jsonl file exists under `$CODEX_HOME/sessions` /
   `~/.codex/sessions` (codex) or `~/.claude/projects` (claude).
4. Watch the console for `tailing … transcript …`. Until that appears the pane
   streams nothing. Permission menus still work — those are read from the screen
   directly, independent of the content path.

## Reading LOG_FILE

`LOG_FILE` is JSONL. Each line looks like:

```json
{"t":"2026-07-06T00:00:00.000Z","dir":"out","sessionId":"w1:p1","msg":{"type":"tool_start"}}
```

`dir` values:

- `in`: an HTTP request from the app, such as `/api/prompt`
- `out`: an SSE event emitted to the app
- `diag`: internal diagnostics, mostly blocked-menu parsing and permission
  attempts

Useful commands:

```bash
tail -f /tmp/even-better-events.log
jq -c 'select(.sessionId=="w1:p1") | [.dir, .msg.type, .msg]' /tmp/even-better-events.log
```

Expected turn closeout order is:

```text
user_prompt -> text_delta/tool_start/tool_end... -> result -> status(idle)
```

`status(idle)` must come after the final `result`. If `text_delta` appears after
idle, the app can treat that text as new activity. The bridge drains and flushes
queued output before emitting `result` and then idle.

`LOG=normal` omits high-volume `text_delta` rows. `LOG=debug` records the full
JSONL stream. `LOG=trace` also prints capture/send/drop stream tracing and SSE
verbose output to the console.

## Duplicate Output

Structured transcript dedupe is intentionally narrow:

- `task_complete.last_agent_message` is a fallback for Codex and is dropped when
  the same assistant message already arrived from `response_item` or
  `event_msg`.
- Codex `web_search_call` and `tool_search_call` can update status for the same
  id. The parser emits one `tool_start` and waits for a terminal status before
  closing the bubble.
- `ScreenTimeline` owns screen-only heuristics: diffing, volatile-line filters,
  echo suppression, and multiset dedupe. Those heuristics do not run over a
  structured transcript.

When output looks duplicated, first identify the source (for claude/codex it is
always the transcript — they never scrape for content):

1. If the console says `tailing ... transcript`, inspect the corresponding
   transcript lines and `LOG_FILE`.
2. If not (a non-claude/codex pane on `ScreenTimeline`), enable default stream tracing
   and look for `capture`, `send`, and `drop` lines in the console.

## Stuck on Tokens or No Final Result

During a turn the bridge emits `running_stats` every 10 seconds. The turn is
closed only after herdr has stayed idle for the idle grace window, because herdr
can briefly report idle between tool calls.

If the app appears stuck:

1. Check `LOG_FILE` for a final `result` followed by `status` with
   `state: "idle"`.
2. If `result` is missing, check whether herdr is still reporting `working` or
   `blocked`.
3. If a tool bubble is still running, look for a missing `tool_end`. For Codex
   search tools, non-terminal statuses such as `in_progress` intentionally keep
   the bubble open until `completed`, `failed`, or `incomplete`.
4. If the pane is awaiting input, `dir:"diag"` entries include the parsed menu,
   pending tool summary, and screen tail used to create the app prompt.

## Tailscale and Funnel

Use `BIND_HOST=tailscale` when the phone is on your tailnet. The bridge binds
to the 100.64/10 Tailscale address and prints a private tailnet QR.

Use `PUBLIC_ACCESS=tailscale-funnel` when the phone cannot run a
Tailscale client. Requirements:

- `tailscale` CLI is installed and logged in
- the tailnet permits Funnel for the machine
- Tailscale Funnel has been enabled in the admin console once

The bridge starts on an auto-selected local port, runs Tailscale Funnel against
that local port, waits for a public `https://*.ts.net` URL, appends the token
query, and prints one QR. If no URL is seen after 15 seconds, the server prints
the tunnel output. Common causes are a disabled Funnel policy, an
unauthenticated CLI, or a Tailscale daemon that is not running.

Public access providers proxy to `127.0.0.1`, so `PUBLIC_ACCESS` must use the
default `BIND_HOST=auto` or an explicit loopback bind. Do not combine it with
`BIND_HOST=lan`, `BIND_HOST=tailscale`, or another non-loopback interface.

Funnel cleanup is targeted: on process exit the bridge runs the matching
`tailscale funnel --https=<port> [--set-path=<path>] off`. It must not run
`tailscale funnel reset`, because multiple bridge instances can share the same
Tailscale node.

The bridge selects one free public Funnel port from `443`, `8443`, and `10000`,
so up to three public bridge instances can coexist without URL paths. If those
ports are already occupied by Funnel, it falls back to mounting the instance at
`/eb/<INSTANCE_ID>/` and prints a warning because the app must preserve the
scanned URL path as its API base. Concurrent Funnel startups serialize this slot
selection with a local lock so two instances do not claim the same public port.

Cloudflare quick tunnels (`PUBLIC_ACCESS=cloudflared`, `trycloudflare.com`) are not
recommended for this app because they do not stream Server-Sent Events reliably.
Use a named Cloudflare Tunnel if Cloudflare is required. Named tunnels and other
external proxies require a fixed `PORT` because the bridge cannot update their
backend target when `PORT=auto` chooses a new local port.

## Manual Smoke Check

For a quick manual check without adding a full E2E harness:

```bash
PORT=3457 BRIDGE_TOKEN=test-token LOG_FILE=/tmp/even-better-events.log pnpm start
npx tsx tools/app-sim.ts 3457 test-token <pane-id> /tmp/even-better-sim.jsonl
```

Then send a prompt from the app or:

```bash
curl -sS \
  -H 'Authorization: Bearer test-token' \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"<pane-id>","text":"Say hello and then run pwd"}' \
  http://127.0.0.1:3457/api/prompt
```

Inspect `/tmp/even-better-events.log` or `/tmp/even-better-sim.jsonl` for
`user_prompt`, streamed text/tool events, `result`, and final idle status.
