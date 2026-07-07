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
  /^\s*⏺\s*$/, // lone bullet painted before its text streams in
  /^\s*[>›]\s/, // user prompt echo — the app already renders user_prompt itself
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
 * Strip the elapsed-time suffix Claude Code appends to command lines when
 * they finish ("⎿ $ cmd… (3s)"). Filtering such lines loses the tool call's
 * first line for fast commands (the only capture already carries the suffix);
 * normalizing instead makes the finished variant identical to the running
 * one, so the multiset diff neither re-emits nor drops it.
 */
// Trailing "(3s)" / "(1m 4s)" / width-cut "(3s" elapsed-time suffix.
const DURATION_TAIL = /\s*\((?:\d+m\s*)?\d+(?:\.\d+)?s\)?\s*$/;

/** Strip the elapsed-time suffix from any line, for dedupe-key purposes:
 *  in-progress commands re-render every second with a new duration, and the
 *  suffix can land on any wrapped continuation row of the command box. */
export function stripDurationTail(l: string): string {
  return l.replace(DURATION_TAIL, "");
}

export function normalizeLine(l: string): string {
  // Width truncation can also cut the suffix itself, leaving "… (3s" with no
  // closing paren — and the seconds tick each redraw, so every variant would
  // re-emit. Accept an unclosed paren when the ellipsis directly precedes it.
  if (/…\s*\((?:\d+m\s*)?\d+(?:\.\d+)?s\)?\s*$/.test(l)) {
    return stripDurationTail(l);
  }
  if (/^\s*⎿/.test(l) && /\((?:\d+m\s*)?\d+(?:\.\d+)?s\)\s*$/.test(l)) {
    return stripDurationTail(l);
  }
  return l;
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
 * lists). The highlighted option carries a selection marker — `❯` for claude,
 * `›` for codex — which must be skipped, else that option is missed (and for a
 * 3-option codex approval that mis-parses into a 2-option "question", verified
 * live). Because codex reuses `›` as its *input-line* prefix too, options are
 * accepted only as a contiguous 1,2,3,… run (see below), so a numbered prompt
 * echo is not mistaken for a menu. Returns null when none is on screen.
 */
export function parseMenu(text: string): ParsedMenu | null {
  const lines = text.split("\n");
  // Every "N. label" / "N) label" line, minus a leading selection marker.
  const hits: { idx: number; digit: number; label: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:[❯›]\s*)?(\d)[.)]\s+(.+?)\s*$/);
    if (m) hits.push({ idx: i, digit: Number(m[1]), label: m[2] });
  }
  // A real menu is a CONTIGUOUS run numbered 1,2,3,…. Requiring that rejects a
  // `› N.` codex *prompt echo* (the same marker prefixes user input) and stray
  // stale options elsewhere on screen — otherwise those form a fake menu that
  // keeps `menuGone()` from ever clearing. Keep the LAST valid run (the live
  // dialog paints at the bottom, above the input line).
  let best: { idx: number; digit: number; label: string }[] = [];
  let run: { idx: number; digit: number; label: string }[] = [];
  for (const h of hits) {
    const prev = run[run.length - 1];
    if (prev && h.idx - prev.idx <= 2 && h.digit === prev.digit + 1) {
      run.push(h);
    } else {
      if (run.length >= 2 && run[0].digit === 1) best = run;
      run = h.digit === 1 ? [h] : [];
    }
  }
  if (run.length >= 2 && run[0].digit === 1) best = run;
  if (best.length < 2) return null;

  const options: MenuOption[] = best.map((h) => ({ digit: String(h.digit), label: h.label }));
  const firstOptionIdx = best[0].idx;

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

/**
 * Coarse detector for a codex tool-approval prompt on the visible screen.
 * Codex delivers exec/patch approvals as protocol `EventMsg`s (not hooks) that
 * never reach the cmux event stream and are not persisted to the rollout, so the
 * screen is the only signal the cmux backend can see (see `docs/PERMISSIONS.md`).
 * Anchored on the decision **footer** + the "Would you like to …" question — not
 * the option text — to stay coarse and robust; the bridge still runs `parseMenu`
 * to build the actual request.
 */
export function isCodexApprovalScreen(text: string): boolean {
  const footer = /enter to confirm\b/i.test(text) && /esc to cancel\b/i.test(text);
  const question = /would you like to (run|make|apply|allow)\b/i.test(text);
  return footer || question;
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
