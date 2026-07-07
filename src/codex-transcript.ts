import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Timeline } from "./spine.js";
import { JsonlTail } from "./jsonl-tail.js";

// Tail a Codex interactive rollout transcript
// ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-...<id>.jsonl, or
// ~/.codex/sessions when CODEX_HOME is unset). This is the structured source for
// Codex panes; screen scraping remains only a fallback before herdr detects the
// session id or when a rollout file cannot be found.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readDirEntries(dir: string) {
  return readdirSync(dir, { withFileTypes: true });
}

function codexHome(): string {
  const raw = process.env.CODEX_HOME?.trim();
  return raw ? raw : join(homedir(), ".codex");
}

export function findCodexSessionFile(sessionId: string): string | null {
  const root = join(codexHome(), "sessions");
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

/** The model a Codex session is running, from the rollout `turn_context` record's
 *  `payload.model` (a required field upstream) — structured, instead of "Unknown".
 *  Full-file scan; fine for the infrequent /info call. */
export function readCodexModel(sessionId: string): string | undefined {
  const file = findCodexSessionFile(sessionId);
  if (!file) return undefined;
  let model: string | undefined;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes("turn_context") || !line.includes('"model"')) continue;
      try {
        const e = JSON.parse(line) as { payload?: { model?: unknown } };
        if (typeof e.payload?.model === "string") model = e.payload.model;
      } catch {
        // skip unparseable line
      }
    }
  } catch {
    // file gone
  }
  return model;
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
  message?: unknown;
  last_agent_message?: unknown;
  content?: unknown;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: unknown;
  input?: unknown;
  action?: unknown;
  query?: unknown;
  output?: unknown;
  tools?: unknown;
  status?: string;
  reason?: string;
  num_turns?: number;
  info?: {
    last_token_usage?: CodexUsage;
    total_token_usage?: CodexUsage;
  };
}

interface CodexEntry {
  timestamp?: string;
  type?: string;
  payload?: CodexPayload;
}

type MessageSource = "response_item" | "event_msg" | "task_complete";

const MESSAGE_DEDUPE_MS = 30_000;

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

function parseCustomInput(input: unknown): Record<string, unknown> {
  if (isRecord(input)) return input;
  return input === undefined || input === null ? {} : { input };
}

function parseWebSearchInput(payload: CodexPayload): Record<string, unknown> {
  if (isRecord(payload.action)) return payload.action;
  if (typeof payload.query === "string") return { type: "search", query: payload.query };
  return {};
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

function usageFrom(u: CodexUsage | undefined): { input: number; output: number } | null {
  if (!u) return null;
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
}

function usageKey(u: { input: number; output: number }): string {
  return `${u.input}:${u.output}`;
}

function webSearchOutput(input: Record<string, unknown>): string {
  if (typeof input.url === "string") return `Opened ${input.url}`;
  if (typeof input.query === "string") return `Searched ${input.query}`;
  if (Array.isArray(input.queries) && input.queries.length) return `Searched ${String(input.queries[0])}`;
  return "Web search completed";
}

function toolSearchLabel(tool: unknown): string | null {
  if (!isRecord(tool)) return null;
  const candidates = [tool.namespace, tool.server, tool.name, tool.id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function toolSearchOutput(tools: unknown): string {
  if (!Array.isArray(tools)) return outputText(tools);
  const count = tools.length;
  const labels = [...new Set(tools.map(toolSearchLabel).filter((v): v is string => v !== null))];
  if (!labels.length) return `Found ${count} tools`;
  const shown = labels.slice(0, 5);
  const suffix = labels.length > shown.length ? `, +${labels.length - shown.length} more` : "";
  return `Found ${count} tools: ${shown.join(", ")}${suffix}`;
}

function outputIsPending(status: string | undefined): boolean {
  return status === "in_progress" || status === "pending" || status === "running";
}

function outputOk(status: string | undefined): boolean {
  return status !== "failed" && status !== "incomplete";
}

function webSearchIsRunning(status: string | undefined): boolean {
  return status === "searching" || outputIsPending(status);
}

interface WebSearchState {
  started: boolean;
  completed: boolean;
}

export class CodexEntryParser {
  private lastTotalUsage: { input: number; output: number } | null = null;
  private lastUsageSnapshot = "";
  private recentMessages = new Map<string, { at: number; source: MessageSource }>();
  private webSearches = new Map<string, WebSearchState>();
  private startedToolSearches = new Set<string>();

  parse(line: string): AgentEvent[] {
    let entry: CodexEntry;
    try {
      entry = JSON.parse(line) as CodexEntry;
    } catch {
      return [];
    }

    const payload = entry.payload;
    if (!payload) return [];

    if (entry.type === "event_msg") {
      if (payload.type === "token_count") return this.parseUsage(payload);
      if (payload.type === "user_message") {
        return this.parseChatMessage("user", outputText(payload.message), "event_msg", entry);
      }
      if (payload.type === "agent_message") {
        return this.parseChatMessage("assistant", outputText(payload.message), "event_msg", entry);
      }
      if (payload.type === "task_complete") {
        return this.parseChatMessage("assistant", outputText(payload.last_agent_message), "task_complete", entry);
      }
      if (payload.type === "web_search_end") return this.parseWebSearch(payload);
      if (payload.type === "turn_aborted") {
        const reason = payload.reason?.trim();
        const text = reason === "interrupted" ? "Interrupted by user" : `Turn aborted${reason ? `: ${reason}` : ""}`;
        return [{ t: "turnEnd", success: false, text }];
      }
      if (payload.type === "thread_rolled_back") {
        const n = typeof payload.num_turns === "number" && payload.num_turns > 0 ? payload.num_turns : 1;
        return [{ t: "turnEnd", success: false, text: `Rolled back ${n} turn${n === 1 ? "" : "s"}` }];
      }
      return [];
    }

    if (entry.type !== "response_item") return [];

    if (payload.type === "message") {
      if (payload.role === "user") {
        return this.parseChatMessage("user", contentText(payload.content, "input_text"), "response_item", entry);
      }
      if (payload.role === "assistant") {
        return this.parseChatMessage("assistant", contentText(payload.content, "output_text"), "response_item", entry);
      }
      return [];
    }

    if (payload.type === "function_call") {
      const id = payload.call_id ?? payload.id;
      const name = payload.name;
      if (!id || !name) return [];
      return [{ t: "tool", id, name, input: parseArguments(payload.arguments) }];
    }

    if (payload.type === "custom_tool_call") {
      const id = payload.call_id ?? payload.id;
      const name = payload.name;
      if (!id || !name) return [];
      return [{ t: "tool", id, name, input: parseCustomInput(payload.input) }];
    }

    if (payload.type === "web_search_call") return this.parseWebSearch(payload);

    if (payload.type === "tool_search_call") {
      const id = payload.call_id ?? payload.id;
      if (!id || !this.rememberToolSearch(id)) return [];
      return [{ t: "tool", id, name: "tool_search", input: parseArguments(payload.arguments) }];
    }

    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const id = payload.call_id;
      if (!id) return [];
      return [{ t: "toolResult", id, output: outputText(payload.output), ok: outputOk(payload.status) }];
    }

    if (payload.type === "tool_search_output") {
      const id = payload.call_id;
      if (!id || outputIsPending(payload.status)) return [];
      return [{ t: "toolResult", id, output: toolSearchOutput(payload.tools ?? payload.output), ok: outputOk(payload.status) }];
    }

    return [];
  }

  private parseWebSearch(payload: CodexPayload): AgentEvent[] {
    const id = payload.call_id ?? payload.id;
    if (!id) return [];
    const prev = this.webSearches.get(id);
    if (prev?.completed) return [];

    const input = parseWebSearchInput(payload);
    const terminal = payload.type === "web_search_end" || !webSearchIsRunning(payload.status);
    const events: AgentEvent[] = [];

    if (!prev?.started) events.push({ t: "tool", id, name: "WebSearch", input });
    this.rememberWebSearch(id, { started: true, completed: terminal });
    if (terminal) {
      events.push({ t: "toolResult", id, output: webSearchOutput(input), ok: outputOk(payload.status) });
    }
    return events;
  }

  private rememberWebSearch(id: string, state: WebSearchState): void {
    this.webSearches.set(id, state);
    if (this.webSearches.size > 500) {
      const first = this.webSearches.keys().next().value;
      if (typeof first === "string") this.webSearches.delete(first);
    }
  }

  private rememberToolSearch(id: string): boolean {
    if (this.startedToolSearches.has(id)) return false;
    this.startedToolSearches.add(id);
    if (this.startedToolSearches.size > 500) {
      const first = this.startedToolSearches.values().next().value;
      if (typeof first === "string") this.startedToolSearches.delete(first);
    }
    return true;
  }

  private parseChatMessage(
    role: "user" | "assistant",
    raw: string,
    source: MessageSource,
    entry: CodexEntry,
  ): AgentEvent[] {
    const text = raw.trim();
    if (!text || (role === "user" && text.trimStart().startsWith("<"))) return [];
    if (this.isDuplicateMessage(role, text, source, entry)) return [];
    return role === "user" ? [{ t: "prompt", text }] : [{ t: "say", text }];
  }

  private isDuplicateMessage(
    role: "user" | "assistant",
    text: string,
    source: MessageSource,
    entry: CodexEntry,
  ): boolean {
    const at = entry.timestamp ? Date.parse(entry.timestamp) : Date.now();
    const now = Number.isFinite(at) ? at : Date.now();
    const key = `${role}:${text}`;
    const prev = this.recentMessages.get(key);
    this.recentMessages.set(key, { at: now, source });
    if (this.recentMessages.size > 200) {
      const cutoff = now - MESSAGE_DEDUPE_MS;
      for (const [k, v] of this.recentMessages) if (v.at < cutoff) this.recentMessages.delete(k);
    }
    return prev !== undefined && prev.source !== source && Math.abs(now - prev.at) <= MESSAGE_DEDUPE_MS;
  }

  private parseUsage(payload: CodexPayload): AgentEvent[] {
    const total = usageFrom(payload.info?.total_token_usage);
    if (total) {
      const prev = this.lastTotalUsage;
      this.lastTotalUsage = total;
      const delta = prev
        ? { input: Math.max(0, total.input - prev.input), output: Math.max(0, total.output - prev.output) }
        : usageFrom(payload.info?.last_token_usage);
      if (!delta) return [];
      if (delta.input === 0 && delta.output === 0) return [];
      return [{ t: "usage", usage: delta }];
    }

    const last = usageFrom(payload.info?.last_token_usage);
    if (!last) return [];
    const key = usageKey(last);
    if (key === this.lastUsageSnapshot) return [];
    this.lastUsageSnapshot = key;
    return [{ t: "usage", usage: last }];
  }
}

export function parseCodexEntry(line: string): AgentEvent[] {
  return new CodexEntryParser().parse(line);
}

export class CodexTranscriptTimeline implements Timeline {
  private tail: JsonlTail;
  private parser = new CodexEntryParser();

  constructor(filePath: string) {
    this.tail = new JsonlTail(filePath, (line) => this.parser.parse(line));
  }

  poll(): Promise<AgentEvent[]> {
    return this.tail.readNew();
  }

  dispose(): void {
    // stateless file tail — nothing to release
  }
}
