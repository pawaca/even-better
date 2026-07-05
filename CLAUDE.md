# even-better

Mirror a terminal coding-agent session onto Even Realities G2 glasses. A local
HTTP/SSE server speaks the `@evenrealities/even-terminal` protocol so the stock
Even app connects by QR scan, but instead of spawning a new agent via the SDK it
**mirrors an agent already running inside a terminal multiplexer** (herdr today).
The terminal session and the glasses are the same process.

## Architecture

Producer → spine → consumer. Read `docs/ARCHITECTURE.md` before any structural
change — it is the source of truth and explains *why* the seams are where they are.

```
Multiplexer(herdr) × Agent(claude)  →  AgentEvent stream  →  Sink (render + SSE)
        the Source (produces events)        the spine          the consumer
```

- **`spine.ts`** — `AgentEvent` (`prompt|say|tool|toolResult`) + `Timeline`. The
  provider-neutral vocabulary; nothing downstream of it knows jsonl vs screen.
- **`transcript.ts`** — `TranscriptTimeline`: parses Claude's session jsonl.
  Structured, lossless, **no heuristics**.
- **`screen-timeline.ts`** — `ScreenTimeline`: TUI-scraping fallback. **All**
  fragile heuristics (diff, volatile-line filter, dedup, echo suppression) live
  here and nowhere else.
- **`render.ts`** — pure `string→string` glasses transforms (table reflow, box
  strip). Applied before emit.
- **`herdr.ts`** — the multiplexer socket client (RPC + subscribe).
- **`bridge.ts`** — `PaneBridge`: the core. Turn lifecycle, token accounting,
  the permission/question interaction state machine.
- **`sse.ts` / `index.ts`** — even-terminal SSE fan-out + HTTP server.
- **`parse.ts`** — screen menu parsing (`parseMenu`/`classifyMenu`).

## Commands

- `pnpm start` — run the server (prints QR). No build step; runs via `tsx`.
- `pnpm check` — `tsc --noEmit`. Must pass before every commit.
- `npx tsx scripts/test-transcript.ts` (and `test-render`, `test-diff-unit`,
  `test-widgets`) — pure-function unit tests. Run the relevant one after touching
  its module.
- End-to-end: `scripts/app-sim.ts` records what a connected app receives;
  `scripts/analyze-sim.py` scores a recording. See "Verification" below.

## Critical invariants (each cost a debugging round — do not relearn them)

- **Never call `server.*` on the herdr socket** (`server.reload_config` /
  `server.stop` kill herdr). `herdr.ts` enforces a `SAFE_METHODS` allowlist — keep
  new methods inside it.
- **Multi-key sequences must be SEPARATE presses with a gap.** Bundling
  `["Down","Enter"]` into one `send_input` races the TUI highlight and picks the
  wrong option. See `pressAndVerify` in `bridge.ts`.
- **Claude menus don't respond to number keys.** Enter confirms the highlighted
  option (default = option 1), arrows move it, Escape cancels. Digits are only
  fallbacks. This is the measured grammar in `respondPermission`.
- **Transcript-first; screen is fallback only.** Prefer the jsonl
  (`TranscriptTimeline`); drop to `ScreenTimeline` only when no session id exists
  yet. Dedup/filtering are **screen artifacts** — they must not run over a
  structured source, so they stay inside `ScreenTimeline`, never in the core.
- **Text is append-only on the app side.** Once a `text_delta` is sent it cannot
  be edited. This is *why* we buffer whole prose blocks from the jsonl and
  `renderForGlasses` them before sending — we can fix a table only because we hold
  the complete block first.
- **Tools are shown with `tool_start` only (no `tool_end`).** `tool_start` gives
  the distinct tool color and carries the command as `summary`; `tool_end` is
  dropped because the app labels it "tool end:" (noise). Still track
  `pendingTools` for permission descriptions.
- **Content events are paced.** `text_delta`/`tool_start` go through a queue
  (`paced()`, one per `PACE_MS`) so long answers reveal gradually; `result`/idle
  wait for it to drain. Widgets (status/stats/task_progress) bypass the queue.
- **Interaction timeouts do not auto-deny.** A blocked pane stays `awaiting`
  until the user answers or the menu clears — no SDK forces a decision on us.

## even-terminal protocol: four consumption semantics

The app renders each event type differently. Emit the right one:

| Semantic | Events | App behavior |
|----------|--------|--------------|
| Append (immutable) | `text_delta` `user_prompt` `result` `notification` | added to the transcript |
| Keyed update | `tool_start`→`tool_end` (shared `toolId`) | one bubble, running→done — we avoid it (see tools invariant) |
| Single-slot widget | `status` `running_stats` `task_progress` | overwrites one UI element |
| Interactive | `permission_request` `user_question` ⇄ responses | menu + reply |

Map `TodoWrite` to `task_progress`, not a tool bubble (`todoProgress` in
`bridge.ts`). Emit `running_stats` every 10s during a turn.

## Code style

- Strict TypeScript. `any` is forbidden — use `unknown` + narrowing.
- ESM only (`import ... from "./x.js"` with the `.js` extension).
- **User-facing strings default to English** (notification titles/messages).
- Match existing style; surgical changes only — every changed line should trace
  to the task. Comments state constraints the code can't, not narration.

## Verification (before declaring a nontrivial change done)

`pnpm check` is necessary but not sufficient — the real test is what the glasses
app receives. Drive it end-to-end:

1. Start a test server on an unused port: `PORT=3457 BRIDGE_TOKEN=... EVENT_LOG=/tmp/eb.log pnpm start`.
2. Create a scratch herdr workspace (`workspace.create` over the socket), run
   `claude` in its pane, let the session-probe upgrade it to the transcript.
3. Record with `scripts/app-sim.ts <port> <token> <paneId> <out.jsonl>`, drive a
   turn via `POST /api/prompt`, then inspect the recording (or `EVENT_LOG`) to
   confirm the exact events the app got.
4. Clean up the scratch workspace (`workspace.close`) afterward.

`EVENT_LOG` records every in/out/diag line — the first place to look when the
glasses show something wrong. `DEBUG_STREAM=1` traces capture/send/drop per line.

## Extension roadmap — what NOT to build yet

`docs/ARCHITECTURE.md` defines `Multiplexer` and `AgentAdapter` interfaces for
cmux and codex. **Do not extract them until that work actually starts** — the bar
for a new abstraction is a named second implementation, not symmetry. No
`Renderer`/`Transport` interfaces while there is one device and one protocol;
keep render as pure functions.

## Git

- Conventional commits (`feat:`/`fix:`/`refactor:`/`docs:`/`chore:`).
- Run `pnpm check` + the relevant unit test before committing.
