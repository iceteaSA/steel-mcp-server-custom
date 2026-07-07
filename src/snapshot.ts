// -----------------------------------------------------------------------------
// snapshot.ts — accessibility snapshot capture, ref-invariant diff, and
// per-tab snapshot store for agent-side change feedback.
// -----------------------------------------------------------------------------

import type { Page } from "playwright";

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
 * Capture an accessibility snapshot of the page (or a selector's subtree)
 * via `page.locator(…).ariaSnapshot({ mode: "ai" })`.
 *
 * Returns the YAML snapshot text and an incrementing per-tab generation
 * counter (starts at 1 on first capture of each tab).
 *
 * @param page  Playwright Page
 * @param tabId Numeric tab identifier (used for generation counter + store)
 * @param opts  Optional selector (default: "body") and maxChars (default: 8000)
 */
export async function captureSnapshot(
  page: Page,
  tabId: number,
  opts?: { selector?: string; maxChars?: number },
): Promise<SnapshotResult> {
  const selector = opts?.selector ?? "body";
  const maxChars = opts?.maxChars ?? 8000;

  // ariaSnapshot({ mode: "ai" }) is an internal option not yet in the
  // Playwright TS types — cast to any to satisfy the compiler.
  const raw = await page.locator(selector).ariaSnapshot({ mode: "ai" } as any);

  const generation = (genCounter.get(tabId) ?? 0) + 1;
  genCounter.set(tabId, generation);

  const { text, truncatedLines } = truncateAtLine(raw, maxChars);
  if (truncatedLines > 0) {
    const notice = `…[${truncatedLines} more lines — call snapshot with a selector to scope]`;
    return { text: text + notice, generation };
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

  // Walk lines, accumulating until the next line would push past maxChars.
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

// Strip [ref=eN] markers so ref-churn doesn't count as a change.
const REF_RE = /\s*\[ref=e\d+\]/g;

function normalizeLine(line: string): string {
  return line.replace(REF_RE, "");
}

// Extract the "role+name" prefix for best-effort change-pairing.
// ariaSnapshot lines look like: `- textbox "Search": value [ref=e1]`
// The prefix is everything before the colon (the element identity), or
// the whole line if there's no colon.
function rolePrefix(normalized: string): string {
  const colonIdx = normalized.indexOf(":");
  return colonIdx === -1 ? normalized : normalized.slice(0, colonIdx);
}

/**
 * Compute the longest common subsequence (DP, O(n*m)) of two line arrays.
 * Returns the set of indices in `a` that are part of the LCS.
 *
 * Falls back to a cheap set-based check when either array exceeds 1500 lines.
 */
function lcsIndices(a: string[], b: string[]): Set<number> {
  if (a.length > 1500 || b.length > 1500) {
    // Fallback: set-based — any line that appears (at least once) in b is
    // considered "common". This is O(n+m) and avoids allocating a 1500×1500
    // DP matrix.
    const bSet = new Set(b);
    const indices = new Set<number>();
    for (let i = 0; i < a.length; i++) {
      if (bSet.has(a[i])) indices.add(i);
    }
    return indices;
  }

  // Standard O(n*m) LCS DP.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from<number>({ length: m + 1 }).fill(0),
  );

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to collect LCS indices in `a`.
  const indices = new Set<number>();
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      indices.add(i - 1);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return indices;
}

/**
 * Diff two accessibility snapshots (YAML text) and return a compact,
 * ref-invariant change summary.
 *
 * Rules:
 * - [ref=eN] markers are stripped before comparison so ref regeneration
 *   does not count as a change.
 * - Identical (after normalization) → "(no visible change)".
 * - Removed + added lines whose normalized role+name prefix matches are
 *   paired as `~ <line>` (changed state).
 * - Unpaired added lines → `+ <line>`.
 * - Unpaired removed lines → `- <line>`.
 * - Output indentation is preserved from the new side (or old for removals).
 * - Capped at maxChars (default 2000) with a truncation notice.
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

  // LCS over normalized lines.
  const commonInPrev = lcsIndices(prevNorm, nextNorm);
  const commonInNext = lcsIndices(nextNorm, prevNorm);

  return renderLcsDiff(prevRaw, nextRaw, prevNorm, nextNorm, commonInPrev, commonInNext, maxChars);
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
      // Trimming the leading `- ` / `  - ` from the raw line for cleaner output
      // but keep enough context to identify the element.
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

  let result = outputLines.join("\n");
  if (result.length > maxChars) {
    const { text } = truncateAtLine(result, maxChars);
    result = text + "…diff truncated — call snapshot for full state";
  }
  return result;
}

interface DiffEntry {
  kind: "+" | "-" | "=" | "~";
  raw: string;
}

function renderLcsDiff(
  prevRaw: string[],
  nextRaw: string[],
  prevNorm: string[],
  _nextNorm: string[],
  commonInPrev: Set<number>,
  commonInNext: Set<number>,
  maxChars: number,
): string {
  // Walk both sequences and classify each line.
  const entries: DiffEntry[] = [];
  let pi = 0;
  let ni = 0;

  while (pi < prevRaw.length || ni < nextRaw.length) {
    if (pi < prevRaw.length && commonInPrev.has(pi)) {
      // This line is in LCS — it's common
      entries.push({ kind: "=", raw: nextRaw[ni] });
      pi++;
      ni++;
    } else if (pi < prevRaw.length && !commonInPrev.has(pi)) {
      // Removed (or will be paired as changed)
      entries.push({ kind: "-", raw: prevRaw[pi] });
      pi++;
    } else if (ni < nextRaw.length && !commonInNext.has(ni)) {
      // Added (or will be paired as changed)
      entries.push({ kind: "+", raw: nextRaw[ni] });
      ni++;
    } else {
      // Safety belt
      break;
    }
  }

  // Pass 2: pair up adjacent remove+add entries whose role prefix matches.
  const paired: (DiffEntry | null)[] = entries;
  for (let i = 0; i < paired.length - 1; i++) {
    const a = paired[i];
    if (!a || a.kind !== "-") continue;

    // Look ahead (skip any "=" entries in between)
    let j = i + 1;
    while (j < paired.length && paired[j] !== null && (paired[j] as DiffEntry).kind === "=") j++;
    const b = j < paired.length ? paired[j] : null;
    if (!b || b.kind !== "+") continue;

    const aRole = rolePrefix(normalizeLine(a.raw));
    const bRole = rolePrefix(normalizeLine(b.raw));

    if (aRole === bRole) {
      paired[i] = null;
      b.kind = "~";
    }
  }

  // Pass 3: render, preserving indentation.
  const outputLines: string[] = [];
  for (const e of paired) {
    if (!e) continue;
    const entry = e;
    if (entry.kind === "=") continue;

    const indent = entry.raw.match(/^(\s*)/)?.[1] ?? "";

    switch (entry.kind) {
      case "~":
        outputLines.push(`${indent}~ ${entry.raw.trimStart()}`);
        break;
      case "+":
        outputLines.push(`${indent}+ ${entry.raw.trimStart()}`);
        break;
      case "-":
        outputLines.push(`${indent}- ${entry.raw.trimStart()}`);
        break;
    }
  }

  if (outputLines.length === 0) return "(no visible change)";

  let result = outputLines.join("\n");
  if (result.length > maxChars) {
    const { text } = truncateAtLine(result, maxChars);
    result = text + "…diff truncated — call snapshot for full state";
  }

  return result;
}

// -----------------------------------------------------------------------------
// Per-tab snapshot store (used by diff-feedback consumers, e.g. C5)
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
