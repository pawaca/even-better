import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export interface TranscriptEvent {
  kind: "user_prompt" | "text" | "tool_use" | "tool_result";
  text?: string; // user_prompt / text / tool_result output
  toolId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  usage?: { input: number; output: number };
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | { type: string; text?: string }[];
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

/** Parse one jsonl line into zero or more transcript events. */
export function parseEntry(line: string): TranscriptEvent[] {
  let entry: Entry;
  try {
    entry = JSON.parse(line) as Entry;
  } catch {
    return [];
  }
  if (entry.isSidechain) return []; // sub-agent internal traffic
  const content = entry.message?.content;
  const events: TranscriptEvent[] = [];

  if (entry.type === "user") {
    if (typeof content === "string") {
      // terminal-typed prompt; skip harness/command wrappers
      if (content.trim() && !content.trimStart().startsWith("<")) {
        events.push({ kind: "user_prompt", text: content });
      }
      return events;
    }
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "tool_result" && b.tool_use_id) {
          events.push({
            kind: "tool_result",
            toolId: b.tool_use_id,
            text: resultText(b),
          });
        } else if (b.type === "text" && b.text?.trim() && !b.text.trimStart().startsWith("<")) {
          events.push({ kind: "user_prompt", text: b.text });
        }
      }
      return events;
    }
    return events;
  }

  if (entry.type === "assistant" && Array.isArray(content)) {
    const u = entry.message?.usage;
    const usage = u
      ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 }
      : undefined;
    for (const b of content) {
      if (b.type === "text" && b.text?.trim()) {
        events.push({ kind: "text", text: b.text, usage });
      } else if (b.type === "tool_use" && b.id && b.name) {
        events.push({
          kind: "tool_use",
          toolId: b.id,
          toolName: b.name,
          input: b.input ?? {},
          usage,
        });
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
    case "Read":
      return `Read ${s(input.file_path)}`;
    case "Edit":
      return `Edit ${s(input.file_path)}`;
    case "Write":
      return `Write ${s(input.file_path)}`;
    case "Glob":
      return `Glob ${s(input.pattern)}`;
    case "Grep":
      return `Grep ${s(input.pattern)}`;
    case "WebFetch":
      return `Fetch ${s(input.url)}`;
    case "WebSearch":
      return `Search ${s(input.query)}`;
    case "Task":
    case "Agent":
      return `Agent: ${s(input.description ?? input.prompt)}`;
    case "TodoWrite":
      return "Update todos";
    default: {
      const first = Object.values(input).find((v) => typeof v === "string");
      return first ? `${name}: ${s(first, 80)}` : name;
    }
  }
}

/**
 * Incremental transcript tailer: remembers the byte offset and returns only
 * events appended since the last call. Starts at the current end of file
 * (history is not replayed).
 */
export class TranscriptTail {
  private offset: number;
  private partial = "";

  constructor(readonly filePath: string) {
    this.offset = statSync(filePath).size;
  }

  async readNew(): Promise<TranscriptEvent[]> {
    const size = statSync(this.filePath).size;
    if (size < this.offset) {
      // truncated/rotated — restart from the end
      this.offset = size;
      this.partial = "";
      return [];
    }
    if (size === this.offset) return [];
    const chunk = await new Promise<string>((resolve, reject) => {
      let data = "";
      createReadStream(this.filePath, { start: this.offset, end: size - 1, encoding: "utf8" })
        .on("data", (d) => (data += d))
        .on("end", () => resolve(data))
        .on("error", reject);
    });
    this.offset = size;
    const text = this.partial + chunk;
    const lines = text.split("\n");
    this.partial = lines.pop() ?? ""; // last element may be an incomplete line
    const out: TranscriptEvent[] = [];
    for (const line of lines) {
      if (line.trim()) out.push(...parseEntry(line));
    }
    return out;
  }
}
