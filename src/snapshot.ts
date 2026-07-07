// -----------------------------------------------------------------------------
// snapshot.ts — accessibility snapshot capture, ref-invariant diff, and
// per-tab snapshot store for agent-side change feedback.
// -----------------------------------------------------------------------------

import type { Frame, Page } from "patchright";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SnapshotResult {
  text: string;
  generation: number;
}

// -----------------------------------------------------------------------------
// Per-tab generation counter and snapshot store
// -----------------------------------------------------------------------------

const genCounter = new Map<number, number>();
const snapshotStore = new Map<number, string>();

// -----------------------------------------------------------------------------
// captureSnapshot
// -----------------------------------------------------------------------------

/**
 * Capture an accessibility snapshot of the page or frame (or a selector's
 * subtree) via `ctx.locator(…).ariaSnapshot({ mode: "ai" })`.
 *
 * Returns the YAML snapshot text and an incrementing per-tab generation
 * counter (starts at 1 on first capture of each tab).
 *
 * @param ctx   Playwright Page or Frame
 * @param tabId Numeric tab identifier (used for generation counter + store)
 * @param opts  Optional selector (default: "body"), maxChars (default: 8000),
 *              and noTruncate (default: false — when true, returns the raw
 *              untruncated text for use as an internal store baseline).
 */
export async function captureSnapshot(
  ctx: Page | Frame,
  tabId: number,
  opts?: { selector?: string; maxChars?: number; noTruncate?: boolean },
): Promise<SnapshotResult> {
  const selector = opts?.selector ?? "body";
  const maxChars = opts?.maxChars ?? 8000;

  // ariaSnapshot({ mode: "ai" }) is an internal option not yet in the
  // Playwright TS types — cast to any to satisfy the compiler.
  // Compact ref format: Playwright ai-mode emits [ref=eN]; we show @eN (saves
  // ~6 chars/element). Resolution unchanged — toSelector maps @eN → aria-ref=eN.
  const raw = (await ctx.locator(selector).ariaSnapshot({ mode: "ai" } as any)).replace(
    /\[ref=(e\d+)\]/g,
    "@$1",
  );

  const generation = (genCounter.get(tabId) ?? 0) + 1;
  genCounter.set(tabId, generation);

  // Skip truncation when caller wants the full tree for internal storage.
  if (opts?.noTruncate) return { text: raw, generation };

  const { text, truncatedLines } = truncateAtLine(raw, maxChars);
  if (truncatedLines > 0) {
    const notice = `…[${truncatedLines} more lines — call snapshot with a selector to scope]`;
    let out = text + notice;
    // Respect maxChars inclusive of the notice. When the notice itself consumes
    // most of the budget, do a second truncation with the remaining headroom.
    if (out.length > maxChars) {
      const effective = maxChars - notice.length;
      if (effective >= 1) {
        const { text: trimmed } = truncateAtLine(raw, effective);
        out = trimmed + notice;
      }
      // Hard clip as last resort (notice alone exceeds maxChars).
      if (out.length > maxChars) {
        out = out.slice(0, maxChars);
      }
    }
    return { text: out, generation };
  }

  return { text, generation };
}

// -----------------------------------------------------------------------------
// truncateAtLine — exported for unit testing
// -----------------------------------------------------------------------------

/**
 * Truncate `text` to at most `maxChars` characters, cutting at a line
 * boundary (after a newline) so the result is a valid partial snapshot.
 *
 * Guarantees at least one line is kept, even if it exceeds maxChars.
 */
export function truncateAtLine(
  text: string,
  maxChars: number,
): { text: string; truncatedLines: number } {
  if (text.length <= maxChars) return { text, truncatedLines: 0 };

  let kept = 0;
  const lines = text.split("\n");

  // Always keep at least the first line.
  let accum = lines[0] + "\n";
  kept = 1;

  for (let i = 1; i < lines.length; i++) {
    const candidate = accum + lines[i] + "\n";
    if (candidate.length <= maxChars) {
      accum = candidate;
      kept = i + 1;
    } else {
      break;
    }
  }

  return { text: accum, truncatedLines: lines.length - kept };
}

// -----------------------------------------------------------------------------
// diffSnapshots — ref-invariant, line-based diff
// -----------------------------------------------------------------------------

// Strip @eN markers so ref-churn doesn't count as a change.
const REF_RE = /\s*@e\d+/g;

function normalizeLine(line: string): string {
  return line.replace(REF_RE, "");
}

// Extract the "role+name" prefix for best-effort change-pairing.
// ariaSnapshot output is captured as: `- textbox "Search": value @e1`
// The prefix is everything before the colon (the element identity), or
// the whole line if there's no colon.
function rolePrefix(normalized: string): string {
  const colonIdx = normalized.indexOf(":");
  return colonIdx === -1 ? normalized : normalized.slice(0, colonIdx);
}

/**
 * Diff two accessibility snapshots (YAML text) and return a compact,
 * ref-invariant change summary.
 *
 * Rules:
 * - @eN markers are stripped before comparison so ref regeneration
 *   does not count as a change.
 * - Identical (after normalization) → "(no visible change)".
 * - Removed + added lines whose normalized role+name prefix matches are
 *   paired as `~ <line>` (changed state).
 * - Unpaired added lines → `+ <line>`.
 * - Unpaired removed lines → `- <line>`.
 * - Output indentation is preserved from the new side (or old for removals).
 * - Capped at maxChars (default 2000) INCLUSIVE of the truncation notice.
 * - When either side exceeds 1500 lines, falls back to a simple set-diff
 *   (loses positional ordering but avoids O(n*m) DP cost).
 */
export function diffSnapshots(prev: string, next: string, opts?: { maxChars?: number }): string {
  const maxChars = opts?.maxChars ?? 2000;
  const prevRaw = prev.split("\n");
  const nextRaw = next.split("\n");

  const prevNorm = prevRaw.map(normalizeLine);
  const nextNorm = nextRaw.map(normalizeLine);

  // Fast path: identical after normalization.
  if (prevNorm.join("\n") === nextNorm.join("\n")) {
    return "(no visible change)";
  }

  // Fallback: plain set-diff for very large snapshots (>1500 lines either side).
  // LCS DP would allocate O(n*m) — impractical with limited memory.
  if (prevRaw.length > 1500 || nextRaw.length > 1500) {
    return diffLargeSnapshots(prevRaw, nextRaw, prevNorm, nextNorm, maxChars);
  }

  return lcsDiff(prevRaw, nextRaw, prevNorm, nextNorm, maxChars);
}

// -----------------------------------------------------------------------------
// LCS diff — proper DP backtracking producing aligned edit script
// -----------------------------------------------------------------------------

interface DiffEntry {
  kind: "+" | "-" | "=" | "~";
  raw: string;
}

/**
 * LCS DP + backtracking that produces a correct, aligned edit script.
 * Backtracks through the DP table from dp[n][m] → dp[0][0], naturally
 * handling middle insertions/deletions by traversing the table edges.
 */
function lcsDiff(
  prevRaw: string[],
  nextRaw: string[],
  prevNorm: string[],
  nextNorm: string[],
  maxChars: number,
): string {
  const n = prevNorm.length;
  const m = nextNorm.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from<number>({ length: m + 1 }).fill(0),
  );

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (prevNorm[i - 1] === nextNorm[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build edit script in reverse order.
  const rev: DiffEntry[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && prevNorm[i - 1] === nextNorm[j - 1]) {
      rev.push({ kind: "=", raw: nextRaw[j - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      // Addition — took the "down" path in DP (prefer additions when equal)
      rev.push({ kind: "+", raw: nextRaw[j - 1] });
      j--;
    } else {
      // Deletion
      rev.push({ kind: "-", raw: prevRaw[i - 1] });
      i--;
    }
  }

  const entries = rev.reverse();

  // Pair adjacent remove+add entries whose role prefix matches → "~".
  const paired: (DiffEntry | null)[] = entries;
  for (let k = 0; k < paired.length - 1; k++) {
    const a = paired[k];
    if (!a || a.kind !== "-") continue;

    // Look ahead (skip "=" entries in between — common context)
    let p = k + 1;
    while (p < paired.length && paired[p] !== null && (paired[p] as DiffEntry).kind === "=") p++;
    const b = p < paired.length ? paired[p] : null;
    if (!b || b.kind !== "+") continue;

    if (rolePrefix(normalizeLine(a.raw)) === rolePrefix(normalizeLine(b.raw))) {
      paired[k] = null;
      b.kind = "~";
    }
  }

  // Render, preserving indentation.
  const outputLines: string[] = [];
  for (const e of paired) {
    if (!e) continue;
    if (e.kind === "=") continue;
    const indent = e.raw.match(/^(\s*)/)?.[1] ?? "";
    outputLines.push(`${indent}${e.kind} ${e.raw.trimStart()}`);
  }

  if (outputLines.length === 0) return "(no visible change)";

  return capOutput(
    outputLines.join("\n"),
    maxChars,
    "…diff truncated — call snapshot for full state",
  );
}

/**
 * Plain set-diff for very large snapshots (>1500 lines). Shows which lines
 * were added / removed without positional context or ~ pairing.
 */
function diffLargeSnapshots(
  prevRaw: string[],
  nextRaw: string[],
  prevNorm: string[],
  nextNorm: string[],
  maxChars: number,
): string {
  const prevSet = new Set(prevNorm);
  const nextSet = new Set(nextNorm);

  const outputLines: string[] = [];

  for (let i = 0; i < prevNorm.length; i++) {
    if (!nextSet.has(prevNorm[i])) {
      const indent = prevRaw[i].match(/^(\s*)/)?.[1] ?? "";
      outputLines.push(`${indent}- ${prevRaw[i].trimStart()}`);
    }
  }

  for (let i = 0; i < nextNorm.length; i++) {
    if (!prevSet.has(nextNorm[i])) {
      const indent = nextRaw[i].match(/^(\s*)/)?.[1] ?? "";
      outputLines.push(`${indent}+ ${nextRaw[i].trimStart()}`);
    }
  }

  if (outputLines.length === 0) return "(no visible change)";

  return capOutput(
    outputLines.join("\n"),
    maxChars,
    "…diff truncated — call snapshot for full state",
  );
}

/**
 * Truncate output to maxChars, respecting the suffix length.
 * Total output length is guaranteed ≤ maxChars.
 */
function capOutput(raw: string, maxChars: number, suffix: string): string {
  if (raw.length <= maxChars) return raw;
  const effective = Math.max(1, maxChars - suffix.length);
  const { text } = truncateAtLine(raw, effective);
  let out = text + suffix;
  // Hard-clip when truncateAtLine keeps a line longer than effective
  // (truncateAtLine guarantees at least one full line).
  if (out.length > maxChars) out = out.slice(0, maxChars);
  return out;
}

// -----------------------------------------------------------------------------
// applyIntent — goal-scoped filter layered on top of filterTree
// -----------------------------------------------------------------------------

const INTENT_KEYWORDS: Record<string, RegExp> = {
  login: /\b(user|email|e-mail|pass|login|log in|sign in|sign-in|otp|2fa|remember)\b/i,
  search: /\b(search|query|find|filter|sort|go)\b/i,
  read_content: /\b(article|content|body|main|read|more)\b/i,
  fill_form: /\b(name|address|phone|city|zip|country|state|submit|save|continue|next)\b/i,
  navigate: /\b(home|menu|nav|back|next|previous|page|tab|link)\b/i,
  buy: /\b(cart|checkout|buy|purchase|price|add to|pay|order|quantity)\b/i,
  extract_data: /\b(table|row|column|list|item|result|data|export)\b/i,
};

const INTENT_ROLES: Record<string, Set<string>> = {
  login: new Set(["textbox", "checkbox", "button", "link"]),
  search: new Set(["textbox", "searchbox", "combobox", "button"]),
  read_content: new Set(["heading", "paragraph", "article", "link", "list", "listitem"]),
  fill_form: new Set(["textbox", "combobox", "checkbox", "radio", "button", "option", "listbox"]),
  navigate: new Set(["link", "button", "tab", "menuitem"]),
  buy: new Set(["button", "link", "textbox", "spinbutton", "combobox"]),
  extract_data: new Set(["table", "row", "cell", "list", "listitem", "link", "heading"]),
};

/** Goal-scoped filter layered on top of filterTree. Keeps a line when its role is
 * in the intent role set OR its text matches the intent keywords; retains ancestors;
 * conservative (nameless structural lines kept; unknown intent = passthrough). */
export function applyIntent(text: string, intent: string): string {
  const roles = INTENT_ROLES[intent];
  const kw = INTENT_KEYWORDS[intent];
  if (!roles || !kw) return text;

  const lines = text.split("\n");
  const keep = Array.from<boolean>({ length: lines.length }).fill(false);
  const stack: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const ind = indentOf(line);
    while (stack.length && indentOf(lines[stack[stack.length - 1]]) >= ind) stack.pop();
    const role = lineRole(line);
    if (roles.has(role) || kw.test(line)) {
      keep[i] = true;
      for (const a of stack) keep[a] = true;
    }
    stack.push(i);
  }

  const out = lines.filter((_, i) => keep[i]);
  return out.length ? out.join("\n") : text;
}

// -----------------------------------------------------------------------------
// Per-tab snapshot store
// -----------------------------------------------------------------------------

/** Store the latest snapshot text for a tab. */
export function storeSnapshot(tabId: number, text: string): void {
  snapshotStore.set(tabId, text);
}

/** Retrieve the stored snapshot for a tab, or undefined. */
export function getStoredSnapshot(tabId: number): string | undefined {
  return snapshotStore.get(tabId);
}

/**
 * Clear stored snapshot and generation counter for a tab.
 * Called on tab close and navigation (reset triggers a fresh base).
 */
export function clearSnapshot(tabId: number): void {
  snapshotStore.delete(tabId);
  genCounter.delete(tabId);
}

/**
 * Clear all snapshot state (generation counters + stored snapshots).
 * Called on browser stop or soft-reset when all tabs are destroyed.
 */
export function clearAllSnapshots(): void {
  snapshotStore.clear();
  genCounter.clear();
}

// -----------------------------------------------------------------------------
// filterTree — interactive / all / visible snapshot filtering
// -----------------------------------------------------------------------------

const INTERACTIVE_ROLES = new Set([
  "link",
  "button",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "searchbox",
  "textarea",
  "select",
]);

export function lineRole(line: string): string {
  const m = line.match(/^\s*-\s+([a-z]+)/);
  return m ? m[1] : "";
}

export function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Filter the ai-mode snapshot tree by element role.
 *
 * - "all" — passthrough, no filtering.
 * - "interactive" — keeps only actionable roles (buttons, links, inputs, etc.)
 *   plus every structural ancestor on their path so the tree remains valid.
 * - "visible" — drops lines that contain [hidden].
 *
 * Returns a fallback message when interactive filtering yields no results
 * so the agent knows to retry with filter:"all".
 */
export function filterTree(text: string, filter: "interactive" | "all" | "visible"): string {
  if (filter === "all") return text;
  const lines = text.split("\n");
  if (filter === "visible") return lines.filter((l) => !/\[hidden\]/.test(l)).join("\n");

  // "interactive": keep actionable roles + all their ancestors.
  const keep = Array.from<boolean>({ length: lines.length }).fill(false);
  const stack: number[] = []; // index stack of ancestor lines (by indent)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const ind = indentOf(line);
    // Pop ancestors that are at same or deeper indent than this line.
    while (stack.length && indentOf(lines[stack[stack.length - 1]]) >= ind) stack.pop();
    if (INTERACTIVE_ROLES.has(lineRole(line))) {
      keep[i] = true;
      // Mark every ancestor on the current path.
      for (const a of stack) keep[a] = true;
    }
    stack.push(i);
  }

  const out = lines.filter((_, i) => keep[i]);
  return out.length ? out.join("\n") : '(no interactive elements — retry with filter:"all")';
}

// -----------------------------------------------------------------------------
// truncateForDisplay — filter-then-truncate helper for the snapshot handler
// -----------------------------------------------------------------------------

/**
 * Truncate text for display, appending the standard "more lines" notice when
 * the tree is cut. The returned string respects maxChars inclusive of the notice.
 * Extracted from captureSnapshot's truncation path so the snapshot handler can
 * filter THEN truncate without calling captureSnapshot twice.
 */
export function truncateForDisplay(text: string, maxChars: number): string {
  const { text: truncated, truncatedLines } = truncateAtLine(text, maxChars);
  if (truncatedLines === 0) return text;

  const notice = `…[${truncatedLines} more lines — call snapshot with a selector to scope]`;
  let out = truncated + notice;
  if (out.length > maxChars) {
    const effective = maxChars - notice.length;
    if (effective >= 1) {
      const { text: trimmed } = truncateAtLine(text, effective);
      out = trimmed + notice;
    }
    if (out.length > maxChars) out = out.slice(0, maxChars);
  }
  return out;
}
