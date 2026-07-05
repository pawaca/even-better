// Terminal text parsing: volatile-line filtering, tail diffing, and
// permission/question menu extraction from rendered TUI screens.

// Lines that redraw constantly (spinners, prompt boxes, status bars) must not
// reach the glasses as content — they'd spam text_delta on every frame.
const VOLATILE_PATTERNS: RegExp[] = [
  /^\s*❯/, // claude prompt line
  /^\s*▌/, // codex prompt line
  /^[\s─═╌┄┈]{6,}$/, // horizontal rules
  /esc to interrupt/i,
  /shift\+tab to cycle/i,
  /^\s*⏵⏵/, // claude bypass-permissions bar
  /\? for shortcuts/i,
  /ctrl\+[a-z] to /i,
  /^\s*\[[^\]]{2,30}\]\s+📦/, // "[Opus 4.6] 📦 repo [branch]" status bar
  /^\s*[✢✳✶✻✽∗·]\s/, // working/thinking spinner line "✻ Inferring…", "· Shimmying…"
  /^\s*⏺?\s*(Running|Ran)\s+\d+\s+shell command/i, // transient "Running 2 shell commands…"
  /…\s*\(\d+m?\s?\d*s?\)\s*$/, // command line re-rendered with elapsed-time suffix "… (3s)"
  /^\s*>\s/, // user prompt echo — the app already renders user_prompt itself
  /^\s*[⠀-⣿]/, // braille spinner frames
  /\(esc to/i, // wrapped fragment of "(esc to interrupt · …)"
  /^\s*interrupt\b.*[)·]/, // continuation row of a wrapped spinner line
  /🧠\s*\d+%/, // context meter
  /[↓↑]\s*[\d.]+k?\s*tokens/i, // live token counter fragments
  /tokens? used/i,
  /^\s*⎿\s+Running…/i, // in-flight tool status line
  /^[~/].*\svia\s/, // starship-style "path via lang" shell prompt line
];

export function filterVolatile(lines: string[]): string[] {
  return lines.filter((l) => !VOLATILE_PATTERNS.some((re) => re.test(l)));
}

/**
 * Diff two snapshots of a scrolling terminal window. Both are the tail of the
 * same append-mostly stream: `curr` is `prev` scrolled up by d lines with new
 * content appended. Align by finding the scroll offset d that maximises the
 * run of agreeing lines from the top; everything in `curr` past that run is
 * new. (Suffix-matching does NOT work here: shell/agent prompt blocks repeat
 * after every command, so prev's tail also matches the freshly-drawn prompt at
 * the bottom of curr, skipping the real content between them.)
 */
export function diffNewLines(prev: string[], curr: string[]): string[] {
  if (prev.length === 0) return [];
  // Multiset diff: a line is "new" when it occurs more times in curr than in
  // prev. This is the only scheme that survives how TUIs actually draw:
  // - in-place repaints that ADD content (claude paints tool boxes mid-screen
  //   without scrolling) → new lines emitted exactly once
  // - in-place repaints that keep content (spinner tick above a code block)
  //   → counts unchanged, nothing re-emitted, no tail spam
  // - scrolling, window replacement, recent-region resets → handled, since
  //   position is ignored entirely
  // Repeated identical lines (e.g. several "}" rows in code) stay correct
  // because counts, not membership, are compared. Blank lines are ignored.
  const prevCount = new Map<string, number>();
  for (const l of prev) {
    if (!l.trim()) continue;
    prevCount.set(l, (prevCount.get(l) ?? 0) + 1);
  }
  const currCount = new Map<string, number>();
  const added: string[] = [];
  for (const l of curr) {
    if (!l.trim()) continue;
    const n = (currCount.get(l) ?? 0) + 1;
    currCount.set(l, n);
    if (n > (prevCount.get(l) ?? 0)) added.push(l);
  }
  return added;
}

export interface MenuOption {
  digit: string;
  label: string;
}

export interface ParsedMenu {
  title: string;
  options: MenuOption[];
}

/**
 * Parse a numbered selection menu from a rendered TUI screen (claude/codex
 * permission prompts and AskUserQuestion forms both render as "N. label"
 * lists). Returns null when no plausible menu is on screen.
 */
export function parseMenu(text: string): ParsedMenu | null {
  const lines = text.split("\n");
  const options: MenuOption[] = [];
  let firstOptionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:❯\s*)?(\d)[.)]\s+(.+?)\s*$/);
    if (m) {
      if (firstOptionIdx === -1) firstOptionIdx = i;
      options.push({ digit: m[1], label: m[2] });
    }
  }
  if (options.length < 2) return null;

  // Title: nearest content line above the first option.
  let title = "";
  for (let i = firstOptionIdx - 1; i >= 0 && firstOptionIdx - i < 8; i--) {
    const l = lines[i].trim();
    if (!l || /^[─═╌┄┈\s]+$/.test(l)) continue;
    title = l.replace(/^[│┃]\s*/, "").replace(/\s*[│┃]$/, "");
    break;
  }
  return { title, options };
}

export interface ClassifiedMenu {
  kind: "permission" | "question";
  allow?: MenuOption;
  allowAlways?: MenuOption;
  deny?: MenuOption;
}

/**
 * Decide whether a parsed menu is a yes/no permission prompt or an arbitrary
 * question form, and locate the digit for each decision.
 */
export function classifyMenu(menu: ParsedMenu): ClassifiedMenu {
  let allow: MenuOption | undefined;
  let allowAlways: MenuOption | undefined;
  let deny: MenuOption | undefined;
  for (const o of menu.options) {
    const l = o.label.toLowerCase();
    if (/^yes\b/.test(l)) {
      if (/always|don'?t ask|during this session/.test(l)) {
        allowAlways = allowAlways ?? o;
      } else {
        allow = allow ?? o;
      }
    } else if (/^(no|cancel|deny)\b/.test(l)) {
      deny = deny ?? o;
    }
  }
  if (allow && deny) return { kind: "permission", allow, allowAlways, deny };
  return { kind: "question" };
}

/** Extract "[Opus 4.6]"-style model names from a claude pane status bar. */
export function extractModel(text: string): string {
  const m = text.match(/\[((?:Opus|Sonnet|Haiku|Fable)[^\]]{0,20})\]/);
  return m ? m[1] : "";
}

/**
 * Heuristic final-answer extraction when a turn completes: take the last
 * assistant block (claude renders them with a "⏺" bullet), else the trailing
 * non-volatile lines.
 */
export function extractResult(lines: string[]): string {
  const content = filterVolatile(lines);
  let start = -1;
  for (let i = content.length - 1; i >= 0; i--) {
    if (/^\s*⏺/.test(content[i])) {
      start = i;
      break;
    }
  }
  const block = start >= 0 ? content.slice(start) : content.slice(-15);
  return block
    .join("\n")
    .replace(/^\s*⏺\s?/, "")
    .trim();
}
