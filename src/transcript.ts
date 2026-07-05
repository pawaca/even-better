import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Tail a Claude Code session transcript (~/.claude/projects/*/<id>.jsonl) for
// assistant prose. Screen mirroring cannot see prose in long turns — Claude
// Code stops rendering intermediate text blocks while tool activity dominates
// the viewport — but every message is appended to the jsonl in real time, so
// this is the lossless source for text. Tool activity still comes from the
// screen diff.

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
}

/** Extract assistant text blocks from one jsonl entry, if any. */
function assistantText(line: string): string[] {
  try {
    const entry = JSON.parse(line) as {
      type?: string;
      message?: { content?: ContentBlock[] | string };
    };
    if (entry.type !== "assistant") return [];
    const content = entry.message?.content;
    if (!Array.isArray(content)) return [];
    return content
      .filter((b) => b.type === "text" && b.text?.trim())
      .map((b) => b.text as string);
  } catch {
    return [];
  }
}

/**
 * Incremental transcript tailer: remembers the byte offset and returns only
 * assistant text blocks appended since the last call. Starts at the current
 * end of file (history is not replayed).
 */
export class TranscriptTail {
  private offset: number;
  private partial = "";

  constructor(readonly filePath: string) {
    this.offset = statSync(filePath).size;
  }

  async readNew(): Promise<string[]> {
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
    const out: string[] = [];
    for (const line of lines) {
      if (line.trim()) out.push(...assistantText(line));
    }
    return out;
  }
}
