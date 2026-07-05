import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Timeline } from "./spine.js";
import { JsonlTail } from "./jsonl-tail.js";

// Tail a Codex interactive rollout transcript
// (~/.codex/sessions/YYYY/MM/DD/rollout-...<id>.jsonl). This is the structured
// source for Codex panes; screen scraping remains only a fallback before herdr
// detects the session id or when a rollout file cannot be found.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readDirEntries(dir: string) {
  return readdirSync(dir, { withFileTypes: true });
}

export function findCodexSessionFile(sessionId: string): string | null {
  const root = join(homedir(), ".codex", "sessions");
  if (!existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: ReturnType<typeof readDirEntries>;
    try {
      entries = readDirEntries(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
      } else if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`)) {
        return p;
      }
    }
  }
  return null;
}

interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface CodexContent {
  type?: string;
  text?: string;
}

interface CodexPayload {
  type?: string;
  role?: string;
  content?: unknown;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: unknown;
  output?: unknown;
  info?: {
    last_token_usage?: CodexUsage;
  };
}

interface CodexEntry {
  type?: string;
  payload?: CodexPayload;
}

function contentText(content: unknown, type: "input_text" | "output_text"): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const p = part as CodexContent;
    if (p.type === type && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("\n");
}

function parseArguments(args: unknown): Record<string, unknown> {
  if (isRecord(args)) return args;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (isRecord(parsed)) return parsed;
      return { value: parsed };
    } catch {
      return args ? { arguments: args } : {};
    }
  }
  return args === undefined || args === null ? {} : { value: args };
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

export function parseCodexEntry(line: string): AgentEvent[] {
  let entry: CodexEntry;
  try {
    entry = JSON.parse(line) as CodexEntry;
  } catch {
    return [];
  }

  const payload = entry.payload;
  if (!payload) return [];

  if (entry.type === "event_msg" && payload.type === "token_count") {
    const u = payload.info?.last_token_usage;
    if (!u) return [];
    return [{ t: "usage", usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 } }];
  }

  if (entry.type !== "response_item") return [];

  if (payload.type === "message") {
    if (payload.role === "user") {
      const text = contentText(payload.content, "input_text").trim();
      if (!text || text.trimStart().startsWith("<")) return [];
      return [{ t: "prompt", text }];
    }
    if (payload.role === "assistant") {
      const text = contentText(payload.content, "output_text").trim();
      return text ? [{ t: "say", text }] : [];
    }
    return [];
  }

  if (payload.type === "function_call") {
    const id = payload.call_id ?? payload.id;
    const name = payload.name;
    if (!id || !name) return [];
    return [{ t: "tool", id, name, input: parseArguments(payload.arguments) }];
  }

  if (payload.type === "function_call_output") {
    const id = payload.call_id;
    if (!id) return [];
    return [{ t: "toolResult", id, output: outputText(payload.output), ok: true }];
  }

  return [];
}

export class CodexTranscriptTimeline implements Timeline {
  private tail: JsonlTail;

  constructor(filePath: string) {
    this.tail = new JsonlTail(filePath, parseCodexEntry);
  }

  poll(): Promise<AgentEvent[]> {
    return this.tail.readNew();
  }

  dispose(): void {
    // stateless file tail — nothing to release
  }
}
