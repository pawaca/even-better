# Architecture

This document proposes the target framework for herdr-even-bridge. It is a
design RFC, not a description of the current code — see "Migration" for how the
two relate. The goal is a bridge whose four axes of change (multiplexer, agent,
input parsing, output rendering) are independent, swappable seams rather than
branches inside one class.

## The problem with the current shape

Today all logic lives in `PaneBridge` (`src/bridge.ts`, ~800 lines). It reaches
directly into the herdr socket (17 call sites), parses Claude Code's jsonl
inline, scrapes the screen inline, and emits the even-terminal wire protocol
inline (15 call sites). Every one of the four things we expect to vary is
hard-wired into the same object:

- Adding **cmux** means threading a second socket dialect through every call.
- Adding **codex** means branching on `agent === "codex"` in a dozen places.
- Improving **glasses rendering** (tables reflow badly on 576×288) has no home —
  output is emitted as raw `text_delta` at the point of parsing.
- The **input model** is implicit: jsonl shapes leak straight into wire events.

The refactor is not about deleting working code — the parsing/dedup/permission
logic is hard-won and correct. It is about giving each concern a named seam so
the next capability is an *added file*, not an edit to the god class.

## Layered pipeline

```
┌────────────┐   PaneRef/status/keys   ┌──────────────┐   AgentEvent   ┌───────────┐   DisplayOp   ┌────────────┐
│ Multiplexer │ ──────────────────────> │ AgentAdapter │ ─────────────> │  Session  │ ────────────> │  Renderer  │
│  herdr      │ <────────────────────── │  claude      │                │  (core)   │               │  glasses   │
│  cmux       │      readScreen         │  codex       │                │           │               └─────┬──────┘
└────────────┘                          └──────────────┘                └───────────┘                     │ DisplayOp
                                                                                                          ▼
                                                                                                   ┌────────────┐
                                                                                                   │ Transport  │
                                                                                                   │ even-term  │
                                                                                                   └────────────┘
```

Data flows left to right; key injection (permission responses, prompts) flows
right to left through the same interfaces. The **Session** in the middle is
provider-agnostic: it knows about turns, dedup, and the interaction lifecycle,
but nothing about herdr, jsonl, or SSE.

## Seam 1 — Multiplexer (herdr → cmux → …)

"The thing that hosts panes and lets you observe and drive them." herdr and
cmux both expose a local socket with the same concepts: panes, per-pane agent
status detection, screen read, key injection.

```ts
interface Multiplexer {
  readonly name: string;                       // "herdr" | "cmux"
  listPanes(): Promise<PaneRef[]>;
  watch(paneId: string, h: PaneHandlers): Subscription;
  readScreen(paneId: string, opts?: ReadOpts): Promise<string>;
  sendKeys(paneId: string, keys: Key[]): Promise<void>;
  sendText(paneId: string, text: string): Promise<void>;
  // Optional capability — not every multiplexer classifies state. Absence
  // means the AgentAdapter must classify from the screen alone.
  explainState?(paneId: string): Promise<StateExplanation>;
}

interface PaneRef {
  id: string;                 // multiplexer-scoped pane id, e.g. "w1:pQ"
  agentKind?: string;         // "claude" | "codex" | undefined (plain shell)
  agentSessionId?: string;    // provider session id once known
  cwd: string;
  status: PaneStatus;         // "busy" | "idle" | "blocked" | "unknown"
}

type Key =
  | { text: string }                    // literal paste
  | { key: "Enter" | "Escape" | "Down" | "Up" | string };  // named key press

interface StateExplanation { rule?: string; state?: string; evidence?: string; }
```

Design notes:
- **Capabilities are optional methods**, not a lowest-common-denominator core.
  herdr has `explainState` (its detection-rule engine); a future cmux without
  one just omits it, and the agent adapter degrades to screen classification.
- The multiplexer never interprets *content* — it moves bytes and keys and
  reports coarse status. All meaning is added downstream.
- `Key[]` sequences are delivered as **separate presses with a gap** by the
  implementation (bundling `["Down","Enter"]` races the TUI highlight — a bug
  we already hit). The interface hides that; callers pass intent.

Current `src/herdr.ts` becomes `src/multiplexer/herdr.ts` implementing this;
`src/multiplexer/cmux.ts` is added later without touching anything else.

## Seam 2 — AgentAdapter (claude → codex → …)

"How to read a given agent's authoritative record, and how to drive its TUI
interactions." This is where agent-specific knowledge concentrates: where the
session log lives, how to parse it, what a permission menu looks like, and which
keys resolve it.

```ts
interface AgentAdapter {
  readonly kind: string;                       // "claude"
  // Preferred lossless source; null when unavailable (→ Session uses a
  // ScreenTimeline fallback built from Multiplexer.readScreen).
  openTimeline(sessionId: string): AgentTimeline | null;
  // Turn a blocked pane into a structured interaction request.
  interpretBlock(ctx: BlockContext): Interaction | null;
  // Given the user's decision, produce the key ladder to apply + verify.
  planResponse(interaction: Interaction, decision: Decision): KeyPlan[];
}

interface AgentTimeline {
  poll(): Promise<AgentEvent[]>;   // incremental; only new events since last call
  close(): void;
}

interface BlockContext {
  screen: string;                  // Multiplexer.readScreen()
  explanation?: StateExplanation;  // Multiplexer.explainState() if available
  pendingTools: ToolCall[];        // from the timeline — what awaits approval
}

interface KeyPlan { label: string; steps: Key[]; }  // steps applied then verified
```

The Claude adapter owns:
- `TranscriptTimeline` — the jsonl tailer/parser (current `src/transcript.ts`).
- `interpretBlock` — combine herdr's rule id (menu *type*), the pending
  `tool_call` (menu *content*), and screen parse (menu *choices*).
- `planResponse` — the measured key grammar: Enter confirms the highlighted
  default, Down+Enter picks option 2, Escape cancels; digits are fallbacks.

A codex adapter later implements the same three methods against `~/.codex/
sessions` and codex's own menu grammar. The Session does not change.

## Seam 3 — Normalized input model

Both the two problems the user named — "abstract the agent's raw info (jsonl)"
and "abstract the UI concerns (tools, block interaction)" — resolve to: **the
timeline is a stream of provider-neutral semantic events, and interaction is a
separate request/response cycle.**

```ts
type AgentEvent =
  | { kind: "user_prompt"; text: string }
  | { kind: "assistant_text"; text: string; usage?: Usage }
  | { kind: "tool_call"; id: string; name: string; input: JsonObject }
  | { kind: "tool_result"; id: string; output: string; isError?: boolean }
  | { kind: "thinking"; text: string }
  | { kind: "usage"; usage: Usage };
```

Two timelines produce this same type, so the Session is source-agnostic:

```
AgentTimeline
  ├─ TranscriptTimeline   (claude jsonl)   — high fidelity, structured tools
  └─ ScreenTimeline       (any agent)      — fallback via Multiplexer.readScreen;
                                             the current diff+volatile-filter+
                                             normalize pipeline, emitting coarse
                                             assistant_text / tool_call events
```

This reframes screen-scraping from "the primary mechanism" to "one Timeline
implementation used when no structured source exists." All the fragile heuristic
code (multiset diff, volatile filters, duration normalization) lives behind the
`ScreenTimeline` seam and stops leaking into the core.

**Interaction is not a timeline event** — it is a bounded request/response the
Session drives, because it needs live multiplexer status + key injection, not a
log:

```ts
interface Interaction {
  kind: "permission" | "question";
  toolName?: string;          // for permission: which tool
  description: string;        // structured, from the pending tool_call
  options: InteractionOption[];
}
type Decision = { choice: "allow" | "allow_always" | "deny" } | { optionIndex: number };
```

## Seam 4 — Renderer + Transport (glasses output)

Output splits into two responsibilities that today are fused:

- **Renderer**: semantic event → device-appropriate *display operations*. This
  is where 576×288 adaptation lives — the natural home for the table problem.
- **Transport**: display ops → wire protocol + client fan-out. even-terminal's
  SSE is one binding.

```ts
interface Renderer {
  render(ev: SemanticEvent): DisplayOp[];   // 1 event may expand/collapse to N ops
}

type DisplayOp =
  | { op: "text"; text: string }            // already reflowed for the target width
  | { op: "tool"; summary: string; output?: string }
  | { op: "status"; state: "busy" | "idle" | "awaiting" }
  | { op: "interaction"; interaction: Interaction }
  | { op: "result"; text: string; usage?: Usage };

interface Transport {
  send(sessionId: string, op: DisplayOp): void;
  attach(sessionId: string, client: Client): void;   // SSE subscribe + replay
}
```

A `GlassesRenderer` owns the transforms the raw stream cannot:
- **Tables** → detect markdown/box-drawing tables and reflow to a vertical
  `key: value` list (or drop borders + truncate columns to the panel width).
  This is the concrete fix for "tables render poorly," and it belongs *here*,
  not at the parse site.
- **Width-aware wrapping** at the real glyph width instead of terminal columns.
- **Long tool output** → collapse to a headline + N-line preview.
- Different devices (phone screen vs glasses) are different Renderers over the
  same event stream.

`EvenTerminalTransport` wraps the current `src/sse.ts` ring buffer + SSE fan-out
and maps `DisplayOp` → the `text_delta` / `tool_start` / `permission_request`
wire shapes. A different app protocol is a different Transport.

## Core — Session

The former `PaneBridge`, reduced to orchestration over the four interfaces:

```ts
class Session {
  constructor(private deps: {
    mux: Multiplexer;
    pane: PaneRef;
    agent: AgentAdapter;
    renderer: Renderer;
    transport: Transport;
  }) {}
  // owns: turn lifecycle (busy/idle), cross-turn dedup, interaction state
  // machine (detect → interpret → request → response → verify → fallback),
  // token accounting. Depends on NO concrete implementation.
}
```

Wiring is a small factory:

```ts
const mux = await detectMultiplexer();              // herdr | cmux (by env/socket)
for (const pane of await mux.listPanes()) {
  const agent = agentRegistry[pane.agentKind ?? ""] ?? new ScreenOnlyAgent();
  new Session({
    mux, pane, agent,
    renderer: new GlassesRenderer(),
    transport: evenTerminal,
  }).start();
}
```

## Target module layout

```
src/
  multiplexer/
    types.ts        # Multiplexer, PaneRef, Key, StateExplanation
    herdr.ts        # HerdrMultiplexer (from today's herdr.ts)
    cmux.ts         # later
    detect.ts       # pick by env (HERDR_ENV / CMUX_SOCKET_PATH)
  agent/
    types.ts        # AgentAdapter, AgentTimeline, AgentEvent, Interaction
    claude/
      index.ts      # ClaudeAdapter
      transcript.ts # TranscriptTimeline (from today's transcript.ts)
      menus.ts      # interpretBlock + planResponse (key grammar)
    codex/          # later
    screen/
      timeline.ts   # ScreenTimeline fallback (from today's parse.ts diff logic)
  render/
    types.ts        # Renderer, DisplayOp
    glasses.ts      # GlassesRenderer (table reflow, width wrap, truncation)
  transport/
    types.ts        # Transport, Client
    even-terminal.ts# EvenTerminalTransport (from today's sse.ts + wire mapping)
  core/
    session.ts      # Session orchestration (slimmed PaneBridge)
    manager.ts      # discovery + reconcile (from refreshAgents)
  server.ts         # HTTP wiring (from today's index.ts)
  log.ts            # unchanged
```

## Migration (incremental, each step ships green)

Ordered so every step is independently valuable and low-risk; none is a big-bang
rewrite.

1. **Extract `Multiplexer`.** Move `herdr.ts` behind the interface; `PaneBridge`
   depends on `Multiplexer` not raw calls. De-risks cmux, mechanical, no
   behavior change. *(highest value / lowest risk — do first)*
2. **Name the input model.** Promote `TranscriptEvent` to the shared
   `AgentEvent`; introduce `AgentTimeline` with `TranscriptTimeline` as the sole
   impl. Wrap the screen path as `ScreenTimeline` behind the same interface.
3. **Extract `AgentAdapter`.** Move claude's `interpretBlock`/`planResponse`/
   timeline selection into `ClaudeAdapter`. `Session` loses every `agent ===`
   branch.
4. **Introduce `Renderer` + `Transport`.** Start with a pass-through renderer
   (no behavior change), then add `GlassesRenderer` transforms — tables first,
   since that is the visible pain.
5. **Slim `PaneBridge` → `Session`.** What remains is orchestration over four
   interfaces.

Steps 1–3 are pure refactors (behavior-preserving, guarded by the existing
simulator E2E). Step 4 is where new *user-visible* quality (table reflow) lands.

## Non-goals / explicit tradeoffs

- **Not** removing screen-scraping — it is the honest fallback for agents/panes
  without a structured log. It moves behind `ScreenTimeline`, it does not die.
- **Not** a plugin system with dynamic loading. Registries are static maps;
  "extensible" here means "add a file + register it," not runtime discovery.
- **Not** abstracting the even-terminal protocol away prematurely. It stays the
  only Transport until a second consumer actually exists; the seam just makes
  that possible without touching the core.
