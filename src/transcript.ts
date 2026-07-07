import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Timeline, Usage } from "./spine.js";
import { JsonlTail } from "./jsonl-tail.js";

/** The model a Claude session is running, from the last assistant record's
 *  `message.model` in the jsonl — the structured source, instead of scraping the
 *  status bar. Full-file scan; fine for the infrequent /info call, undefined if
 *  no session file / no model line yet. */
export function readClaudeModel(sessionId: string): string | undefined {
  const file = findSessionFile(sessionId);
  if (!file) return undefined;
  let model: string | undefined;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"model"')) continue;
      try {
        const e = JSON.parse(line) as { message?: { model?: unknown } };
        if (typeof e.message?.model === "string") model = e.message.model;
      } catch {
        // skip unparseable line
      }
    }
  } catch {
    // file gone
  }
  return model;
}

// Tail a Claude Code session transcript (~/.claude/projects/*/<id>.jsonl).
// The transcript is the authoritative record of a session: user prompts,
// assistant text, tool calls with full input, tool results with full output.
// Screen scraping cannot match this fidelity (volatile chrome, wrapping,
// collapsed tool output), so for claude panes the transcript is the primary
// content source; the screen is only consulted for pending permission menus.

export function findSessionFile(sessionId: string): string | null {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const p = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | { type: string; text?: string }[];
  is_error?: boolean; // set by Claude Code on a failed tool_result (query.ts)
}

interface Entry {
  type?: string;
  isSidechain?: boolean;
  message?: {
    content?: ContentBlock[] | string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}

function resultText(block: ContentBlock): string {
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

/** Parse one jsonl line into zero or more spine AgentEvents. */
export function parseEntry(line: string): AgentEvent[] {
  let entry: Entry;
  try {
    entry = JSON.parse(line) as Entry;
  } catch {
    return [];
  }
  if (entry.isSidechain) return []; // sub-agent internal traffic
  const content = entry.message?.content;
  const events: AgentEvent[] = [];

  if (entry.type === "user") {
    if (typeof content === "string") {
      // terminal-typed prompt; skip harness/command wrappers
      if (content.trim() && !content.trimStart().startsWith("<")) {
        events.push({ t: "prompt", text: content });
      }
      return events;
    }
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "tool_result" && b.tool_use_id) {
          events.push({ t: "toolResult", id: b.tool_use_id, output: resultText(b), ok: b.is_error !== true });
        } else if (b.type === "text" && b.text?.trim() && !b.text.trimStart().startsWith("<")) {
          events.push({ t: "prompt", text: b.text });
        }
      }
      return events;
    }
    return events;
  }

  if (entry.type === "assistant" && Array.isArray(content)) {
    const u = entry.message?.usage;
    // Attach usage to the first emitted event of this message only (see spine).
    let usage = u ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 } : undefined;
    const take = (): Usage | undefined => {
      const v = usage;
      usage = undefined;
      return v;
    };
    for (const b of content) {
      if (b.type === "text" && b.text?.trim()) {
        events.push({ t: "say", text: b.text, usage: take() });
      } else if (b.type === "tool_use" && b.id && b.name) {
        events.push({ t: "tool", id: b.id, name: b.name, input: b.input ?? {}, usage: take() });
      }
      // thinking blocks are deliberately skipped
    }
  }
  return events;
}

/** One-line human summary of a tool call for the glasses display. */
export function summarizeTool(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown, max = 120): string =>
    String(v ?? "")
      .replace(/\s+/g, " ")
      .slice(0, max);
  switch (name) {
    case "Bash":
      return `$ ${s(input.command)}`;
    case "exec_command":
    case "functions.exec_command":
      return `$ ${s(input.cmd ?? input.command)}`;
    case "Read":
      return `Read ${s(input.file_path)}`;
    case "Edit":
      return `Edit ${s(input.file_path)}`;
    case "Write":
      return `Write ${s(input.file_path)}`;
    case "apply_patch":
    case "functions.apply_patch":
      return "Apply patch";
    case "Glob":
      return `Glob ${s(input.pattern)}`;
    case "Grep":
      return `Grep ${s(input.pattern)}`;
    case "WebFetch":
      return `Fetch ${s(input.url)}`;
    case "WebSearch":
      if (typeof input.url === "string") return `Open ${s(input.url)}`;
      if (Array.isArray(input.queries) && input.queries.length) return `Search ${s(input.queries[0])}`;
      return `Search ${s(input.query)}`;
    case "tool_search":
    case "tool_search_tool":
    case "functions.tool_search_tool":
      return `Search tools ${s(input.query)}`;
    case "Task":
    case "Agent":
      return `Agent: ${s(input.description ?? input.prompt)}`;
    case "TodoWrite":
      return "Update todos";
    case "update_plan":
    case "functions.update_plan":
      return "Update plan";
    case "view_image":
    case "functions.view_image":
      return `View image ${s(input.path)}`;
    case "multi_tool_use.parallel": {
      const n = Array.isArray(input.tool_uses) ? input.tool_uses.length : 0;
      return n ? `Run ${n} tools` : "Run tools";
    }
    default: {
      const first = Object.values(input).find((v) => typeof v === "string");
      return first ? `${name}: ${s(first, 80)}` : name;
    }
  }
}

/** Timeline over a Claude Code session transcript: structured, lossless, no
 *  heuristics. Returns null-safe by construction (caller checks the file). */
export class TranscriptTimeline implements Timeline {
  private tail: JsonlTail;
  constructor(filePath: string) {
    this.tail = new JsonlTail(filePath, parseEntry);
  }
  poll(): Promise<AgentEvent[]> {
    return this.tail.readNew();
  }
  dispose(): void {
    // stateless file tail — nothing to release
  }
}
