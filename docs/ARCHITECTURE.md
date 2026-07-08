# Architecture

A design note for even-better. It states the target shape and, just as
importantly, what it deliberately does *not* abstract. It supersedes an earlier
five-seam draft that over-built the output side; see "What I changed my mind
about" at the end.

## What this system actually is

One sentence: **it turns a live coding-agent-in-a-terminal into a
provider-neutral event stream, and renders that stream onto a tiny remote
display while relaying input back.**

That sentence names the real center of the design — the *event stream*.
Everything upstream of it exists to **produce** the stream; everything
downstream exists to **consume** it. So the right decomposition is not "four
coequal seams," it is a **spine with a producer side and a consumer side**, and
seams belong only where a second real implementation is coming.

```
        PRODUCER                    SPINE                    CONSUMER
  ┌───────────────────┐      ┌────────────────┐       ┌──────────────────┐
  │ Multiplexer × Agent│ ───► │   AgentEvent   │  ───► │       Sink       │
  │  = Source          │      │   (the spine)  │       │  render → app    │
  └───────────────────┘ ◄─── └────────────────┘  ◄─── └──────────────────┘
     prompt / respond / interrupt          replay / status
```

## The spine: a provider-neutral event vocabulary

This is the most important artifact and the smallest. Get it right and both
sides fall out of it. Two channels: a *timeline* of things that happened, and a
*control* channel for live state and interaction (which are request/response,
not log entries).

```ts
type AgentEvent =                                    // the timeline
  | { t: "prompt";     text: string }                // a user turn (typed anywhere)
  | { t: "say";        text: string; usage?: Usage } // assistant prose
  | { t: "tool";       id: string; name: string; input: JsonObject }
  | { t: "toolResult"; id: string; output: string; ok: boolean }
  | { t: "usage";      usage: Usage }                // standalone token delta
  | { t: "turnEnd";    success: boolean; text?: string };

type Signal =                                        // the control channel
  | { t: "state";       state: "busy" | "idle" | "blocked" }
  | { t: "interaction"; req: Interaction };          // awaits a respond()
```

Why this is the center: a `say` is a `say` whether it came from Claude's jsonl,
Codex's rollout log, or a scraped screen. The moment events are in this shape,
nothing downstream needs to know the provider. Turn tracking, token totals,
rendering, the app protocol — all speak only this.

## Producer side: one seam that composes two orthogonal concerns

A **Source** is "one agent, in one pane, presented as a live event stream plus a
command sink." It is the producer abstraction the core depends on:

```ts
interface Source {
  on(cb: (e: AgentEvent | Signal) => void): void;
  prompt(text: string): Promise<void>;
  respond(decision: Decision): Promise<void>;   // resolves a pending interaction
  interrupt(): Promise<void>;
  dispose(): void;
}
```

A Source is *built by composing two genuinely orthogonal things* — and both have
a real second implementation on the roadmap, which is what earns them interface
status:

```ts
interface Multiplexer {                 // pane I/O — herdr today, cmux next
  listPanes(): Promise<PaneRef[]>;
  watchStatus(paneId: string, cb: (s: PaneStatus) => void): Sub;
  read(paneId: string): Promise<string>;
  keys(paneId: string, seq: Key[]): Promise<void>;
  explain?(paneId: string): Promise<Explanation>;   // OPTIONAL capability
}

interface AgentAdapter {                // interpret one agent — claude/codex mappings exist today
  readonly kind: string;
  timeline(sessionId: string, mux: Multiplexer, paneId: string): Timeline;
  readInteraction(ctx: BlockContext): Interaction | null;   // what is the menu
  keyPlan(i: Interaction, d: Decision): Key[][];            // how to resolve it (ladder)
  screenHints?: ScreenHints;            // patterns the ScreenTimeline fallback uses
}
```

Three deliberate choices here:

1. **Multiplexer × Agent compose freely.** codex-in-herdr, claude-in-cmux — any
   pairing. Keeping them as two interfaces (not one "Source impl per combo")
   means N multiplexers + M agents cost N+M implementations, not N×M.

2. **Capabilities are optional methods, not a lowest common denominator.**
   herdr classifies pane state (`explain?`); a cmux that doesn't just omits it,
   and the agent falls back to reading the screen. No interface is dumbed down
   to what every backend can do.

3. **The best idea in the whole design: `Timeline` unifies jsonl and screen.**
   Both "tail the jsonl/rollout" and "scrape the TUI" are implementations of
   *produce `AgentEvent`s*:

   ```ts
   interface Timeline { poll(): Promise<AgentEvent[]>; dispose(): void; }
   //   TranscriptTimeline       — Claude jsonl: structured, lossless, no heuristics
   //   CodexTranscriptTimeline  — Codex rollout jsonl: structured, lossless, no screen heuristics
   //   ScreenTimeline           — content source ONLY for agents with no transcript
   //                              parser; claude/codex are transcript-only. The diff +
   //                              volatile-filter + dedup pipeline (screen artifacts).
   ```

   This demotes screen-scraping from "the mechanism" to "the fallback Timeline,"
   and — crucially — **all the fragile heuristics stop being core concerns.**
   Dedup, volatile-line filtering, duration normalization are *screen artifacts*;
   over a clean jsonl Timeline they simply do not run. They live behind
   `ScreenTimeline` and never touch the spine.

Interaction resolution (`respond`) lives *inside* the Source, because it needs
both halves: `AgentAdapter.keyPlan` (which keys) and `Multiplexer.keys` +
`watchStatus` (send them, verify the block cleared, walk the fallback ladder).
Keeping it in the Source means the core never coordinates mux and agent by hand.

## Consumer side: ONE thing, not two

Here is where I cut the earlier draft. It split output into `Renderer` +
`Transport` interfaces. That was speculative generality: there is **one** device
(glasses) and **one** app protocol (even-terminal), with no second consumer
planned. Two polymorphic interfaces for one implementation is ceremony.

So the consumer is a single **Sink** — "consume the event stream, render for the
device, push to the app":

```ts
interface Sink {
  handle(e: AgentEvent | Signal): void;
  attach(client: Client): void;      // SSE subscribe + ring-buffer replay
}
```

Rendering *is* important — the glasses are 576×288 and tables render badly — but
it is an **internal pipeline of pure transforms**, not a public interface:

```ts
// render: DisplayBlock → DisplayBlock, composed left to right
const render = pipe(reflowTables, wrapToWidth(GLASSES_COLS), truncateToolOutput);
```

`reflowTables` (box/markdown table → vertical `key: value`), width-aware
wrapping, and tool-output collapsing are ordinary functions you unit-test in
isolation. When a *second* device or protocol actually appears, extract the
`Renderer`/`Transport` interfaces then — the transforms are already pure, so the
extraction is mechanical. Not before.

## The core: a thin orchestrator

What remains between Source and Sink is small and provider-agnostic:

```ts
class Session {
  constructor(private source: Source, private sink: Sink) {
    source.on((e) => this.route(e));
  }
  // owns ONLY what is genuinely cross-cutting:
  //  - turn lifecycle: busy → idle boundary → synthesize the `result`
  //  - token accounting across a turn
  //  - forwarding prompt()/respond()/interrupt() from the app to the source
  // Does NOT dedup (that's ScreenTimeline), does NOT know herdr/jsonl/SSE.
}
```

Notice what left the core versus today's 800-line `PaneBridge`: dedup, volatile
filtering, menu parsing, key grammar, herdr calls, wire formatting — every one
of them now has a home on the producer or consumer side. The core is just the
turn state machine.

## Target module layout

```
src/
  spine.ts              # AgentEvent, Signal, Interaction, Decision — the vocabulary
  source/
    index.ts            # Source + factory (pick mux + agent for a pane)
    multiplexer.ts      # Multiplexer interface
    herdr.ts            # HerdrMultiplexer            (from today's herdr.ts)
    cmux.ts             # later
    agent.ts            # AgentAdapter interface
    claude.ts           # ClaudeAdapter + menu grammar (from bridge.ts + parse.ts)
    codex.ts            # CodexAdapter + rollout mapping (from codex-transcript.ts)
    timeline/
      transcript.ts     # TranscriptTimeline + CodexTranscriptTimeline
      screen.ts         # ScreenTimeline: diff+filter+dedup (from parse.ts+bridge.ts)
  sink/
    index.ts            # Sink: even-terminal SSE + ring buffer (from sse.ts+index.ts)
    render.ts           # pure transforms: reflowTables, wrapToWidth, truncate
  core/session.ts       # the thin orchestrator (slimmed PaneBridge)
  server.ts             # HTTP wiring (from index.ts)
  log.ts                # unchanged
```

## What to build now vs defer (honest sequencing)

Held to "would a senior engineer call this over-built?", most of this should be
deferred until the second implementation that justifies it actually arrives.
Build in this order; stop wherever the value stops paying for the churn:

1. **Done — define the spine + the `Timeline` seam.** Highest leverage, least
   code. Claude jsonl, Codex rollout jsonl, and screen scraping all produce
   `AgentEvent`s. This lifts screen heuristics out of the core.
2. **Done — the render transforms (`reflowTables` first).** The only change with
   *immediate user-visible* payoff: tables become readable on the glasses.
   Pure functions; no new interface needed.
3. **Done — extracted `Multiplexer` when cmux work started.** `src/multiplexer.ts`
   defines the interface + normalized `PaneStatus`; `HerdrMultiplexer` (in
   `herdr.ts`) and `CmuxMultiplexer` (`cmux.ts`) implement it; `index.ts` selects
   one at boot (`MUX` env, else auto). Kept flat at `src/` (matching today's
   layout), not the `src/source/` subtree — that reshuffle is part of step 4+.
   cmux has no pane classifier, so it omits the optional `explain()` and blocked
   menus fall back to screen parsing, exactly as this seam anticipated.
4. **Defer — extract `AgentAdapter` only when agent-specific behavior grows
   beyond timeline parsing and menu/key grammar.** Claude and Codex transcript
   producers exist today, but the full adapter interface is still not worth the
   churn while herdr is the only multiplexer and menus are still handled in the
   bridge.
5. **Probably never — `Renderer`/`Transport` interfaces.** Only if a second
   device or app protocol appears. The transforms being pure is enough until
   then.

Steps 3–5 are behavior-preserving and guarded by the existing simulator E2E.

## What I changed my mind about

- **Killed the `Renderer`/`Transport` split.** One consumer today → one Sink
  with an internal transform pipeline. Interfaces on speculation are ceremony.
- **Named the event stream as the spine, not one of four coequal seams.** The
  producer/consumer asymmetry is the real structure; pretending all four axes
  are equal obscured that the whole point is to reach the neutral vocabulary as
  early as possible and speak only it thereafter.
- **Moved dedup/filtering out of "core" into `ScreenTimeline`.** They are
  artifacts of scraping a redrawing TUI, not intrinsic to the bridge. Over a
  structured source they must not run at all.
- **Kept exactly two producer-side interfaces** (Multiplexer, Agent) because
  each has a *named, roadmapped* second implementation — that, not symmetry, is
  the bar for introducing an abstraction.
