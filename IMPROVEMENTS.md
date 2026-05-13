# Steel MCP Server — Improvement Plan

> Based on analysis of 2,320 tool calls across 54 sessions (1,948 OpenCode + 372 OpenClaw),
> cross-referenced with approaches from Microsoft Playwright MCP, bb-browser, fetcher-mcp,
> Browserbase/Stagehand, and industry best practices from Speakeasy, The New Stack, and
> MCP Standards Server.

---

## Executive Summary

The Steel MCP server works. But our usage data shows **three systemic problems**:

1. **`evaluate` returns unbounded output** — no truncation, no file fallback (250 calls, some 42KB+)
2. **Agents use multi-call patterns where single-call alternatives exist** — `go_to_url` + `get_page_text` is the #1 pair (167 occurrences), when a combined tool could halve that
3. **Tool schema bloat** — 27 tools with verbose descriptions loaded into every conversation, consuming context before any work begins

The highest-impact improvements target the **top 5 tools by call volume** (1,611 of 2,320 calls = 69%):

| Tool | Calls | Issue |
|------|-------|-------|
| `get_page_text` | 507 | Good defaults, but no Readability extraction mode |
| `go_to_url` | 481 | Minimal output, but always requires a follow-up read call |
| `new_tab` | 292 | Good output, but agents chain `new_tab` → `new_tab` 114 times (batch tab opening) |
| `evaluate` | 250 | **No output truncation at all** — biggest context bomb |
| `scroll` | 107 | Returns nothing useful — agents always need a follow-up read |

---

## Priority 1: High Impact, Low Effort

### 1.1 CAPTCHA wait-and-retry in `go_to_url`

**Problem:** When `go_to_url` hits a CAPTCHA/bot wall, it immediately returns `isError`
(or worse, doesn't even detect it — see below). CapSolver is loaded and can auto-solve
most CAPTCHAs in 3-10 seconds, but the tool never waits for it.

In this session, 2 Google searches hit `/sorry` CAPTCHA pages. The agent immediately
gave up and switched to Bing, wasting calls and losing time.

**Two sub-problems:**

1. **Detection gap:** `isBotWall()` only matches Cloudflare patterns. Google's `/sorry`
   page, reCAPTCHA embeds, hCaptcha, and other common challenges are NOT detected.
   The regexes need expanding:
   - Title: add `unusual traffic|are you a robot|captcha|human verification`
   - URL: add `\/sorry\/index|google\.com\/sorry|recaptcha\/api|hcaptcha\.com|challenges\.cloudflare\.com`

2. **No wait for CapSolver:** When a bot wall IS detected, the tool should poll for
   resolution before returning `isError`. CapSolver solves most challenges in 3-10s.
   Add a wait loop:
   ```
   detect bot wall → wait 2s → re-check title/URL → repeat up to 15s total
   if solved (title changed, URL changed): continue with normal response
   if still blocked after 15s: return isError with clear message
   ```

**What others do:**
- The skill doc already says "CapSolver handles Google `/sorry` pages transparently —
  wait a few seconds after the redirect and the page loads with results." But the
  tool doesn't implement this wait.

**Effort:** ~40 lines in `go_to_url` handler + expand regexes in `helpers.ts`.
**Impact:** Eliminates CAPTCHA-induced workflow breaks. Agents stop bailing to Bing.

### 1.2 Add output truncation to `evaluate`

**Problem:** `evaluate` returns `JSON.stringify(result, null, 2)` with zero truncation.
Our data shows outputs up to 42KB. A `querySelectorAll` returning 500 elements dumps
the entire serialized DOM.

**What others do:**
- Playwright MCP: `browser_evaluate` has an optional `filename` param to save results
  to file instead of returning inline
- MCP Standards Server: Multiple format variants (full/condensed/reference/summary)

**Fix:**
```typescript
// Add maxChars param (default 10000, matching get_page_text)
// Add outputMode: "file" fallback
const text = result === undefined ? "undefined" : JSON.stringify(result, null, 2);
if (maxChars > 0 && text.length > maxChars) {
  if (outputMode === "file") {
    // write to file, return path
  }
  return {
    content: [{
      type: "text",
      text: text.slice(0, maxChars) +
        `\n\n[TRUNCATED — ${text.length.toLocaleString()} total chars. ` +
        `Use maxChars: 0 with outputMode: "file" for full output.]`
    }]
  };
}
```

**Effort:** ~30 lines. **Impact:** Prevents 250 calls/session from dumping unbounded context.

### 1.3 Add `readPage` param to `go_to_url`

**Problem:** The #1 call sequence is `go_to_url` → `get_page_text` (167 occurrences).
Every navigation requires two round trips. Agents waste a tool call just to read
what they navigated to.

**What others do:**
- Browserbase MCP: Only 6 tools total — `navigate` returns nothing, but `extract`
  does the reading. Their philosophy: fewer tools, each does one thing.
- bb-browser: `site` commands return structured JSON by default — nav+extract in one call.
- fetcher-mcp: `fetch_url` does nav + Readability extraction + markdown conversion in
  a single call. This is their only tool and it's highly effective.

**Fix:** Add optional `readPage` boolean (default `false`) to `go_to_url`:
```typescript
// When readPage is true, automatically extract page text after navigation
// Uses same logic as get_page_text with smart content-area detection
go_to_url(url: "https://example.com", readPage: true, maxChars: 5000)
// Returns: "Navigated to ...\nTitle: ...\n---\n<page text>"
```

**Also add `extractContent` param** (inspired by fetcher-mcp) that uses Mozilla's
Readability algorithm to extract just the article body, stripping nav/ads/footer.
This alone could reduce average `get_page_text` output by 60-80%.

**Effort:** ~80 lines (integrate `@mozilla/readability` + `linkedom`/`jsdom`).
**Impact:** Eliminates ~167 redundant follow-up calls per session pattern.

### 1.4 HTTP 404 / error page detection in `go_to_url`

**Problem:** This session had **15 calls** to `go_to_url` that hit GitHub 404 pages.
The tool returned them as successful navigations (`"Title: Page not found · GitHub"`).
The agent treated each as success and kept guessing URL variants.

**Fix:** After navigation, check for common error page signals and return `isError: true`:
```
- Title matches: /page not found|404|not found|error \d{3}/i
- HTTP status: Intercept response status via page.on('response') — if main frame
  response is 4xx/5xx, flag it
- GitHub-specific: title contains "Page not found" or "404"
```

Return format:
```
{ isError: true, content: [{ type: "text",
  text: "HTTP 404 — Page not found. URL: <url>\nTitle: <title>" }] }
```

This lets agents fail fast instead of burning calls on dead URLs.

**Effort:** ~30 lines. **Impact:** Would have saved 15 calls (23%) in this session alone.

### 1.5 Lower `get_page_text` default `maxChars` from 10000 to 5000

**Problem:** 10,000 chars is generous. Our usage data shows most useful extractions
are under 5,000 chars. The agent can always ask for more.

**What others do:**
- fetcher-mcp: No default limit, but has `maxLength` param
- Playwright MCP: Uses accessibility snapshots (structured, not raw text) — inherently compact

**Fix:** Change default in schema. Non-breaking — just a default change.

**Effort:** 1 line. **Impact:** ~50% reduction in average `get_page_text` output.

---

## Priority 2: High Impact, Medium Effort

### 2.1 Add Readability content extraction mode

**Problem:** `get_page_text` returns raw page text including nav bars, footers, cookie
banners, sidebars. The smart auto-detection (`main` → `article` → `[role=main]` → `body`)
helps but still pulls non-article content within those containers.

**What others do:**
- fetcher-mcp: Built-in Readability algorithm (`extractContent: true` by default).
  "Intelligent Content Extraction: Built-in Readability algorithm automatically
  extracts the main content from web pages, removing ads, navigation, and other
  non-essential elements."
- bb-browser: Platform-specific adapters that extract exactly the structured data needed

**Fix:** Add `extractContent: boolean` param to `get_page_text` (default `false` for
backwards compat, but the skill doc should recommend `true`):
```typescript
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

if (extractContent) {
  const html = await page.content();
  const { document } = parseHTML(html);
  const reader = new Readability(document);
  const article = reader.parse();
  if (article) {
    // Return article.textContent (or convert to markdown)
    text = article.textContent;
  }
}
```

**Also apply to the `readPage` option on `go_to_url`** — when `readPage: true`,
default to Readability extraction.

**Effort:** ~100 lines + 2 deps (`@mozilla/readability`, `linkedom`).
**Impact:** 60-80% reduction in noise for article/documentation pages.

### 2.2 Add `maxChars` and `outputMode` to `evaluate`

Extends 1.1 — full implementation with file output support.

### 2.3 Merge scroll + read into one call

**Problem:** Agents call `scroll` (107 times) → then immediately `get_page_text` or
`evaluate` to see what's now visible. The scroll output is useless ("Scrolled down by 500 pixels.
Position: 3000px / 11640px").

**What others do:**
- Playwright MCP: `browser_snapshot` captures the accessibility tree after any action.
  Every mutating tool returns a fresh snapshot automatically.
- bb-browser: Scroll isn't even a separate tool — `eval` handles it.

**Fix:** Add `readAfterScroll: boolean` param to `scroll` (default `false`):
```typescript
scroll(direction: "down", pixels: 500, readAfterScroll: true, maxChars: 3000)
// Returns: "Scrolled down by 500px. Position: 3000/11640 (26%)\n---\n<visible text>"
```

**Effort:** ~40 lines. **Impact:** Eliminates ~50 follow-up reads per session.

---

## Priority 3: Medium Impact, Higher Effort

### 3.1 Tool description compression

**Problem:** 27 tools with verbose descriptions are loaded into every conversation.
The New Stack reports "tool metadata takes 40-50% of available context."

**What others do:**
- Browserbase MCP: Only **6 tools** total (`start`, `end`, `navigate`, `act`,
  `observe`, `extract`). Radically minimal.
- Playwright MCP: Uses `--caps` flag to enable tool groups (core, pdf, vision,
  devtools, storage, network). Only core is loaded by default.
- MCP Standards Server: "Load minimal schemas first and expand them only when used."

**Fix (phased):**

**Phase 1 — Shorter descriptions:** Trim every tool description to 1-2 sentences max.
Move detailed usage notes to the skill doc (which is loaded on-demand, not at tool
registration time).

Example — current `get_page_text` description is 310 chars. Reduce to:
```
"Extract text from page. Auto-detects main content. Use selector to scope, matchAll
for structured list extraction. Defaults: maxChars=5000, maxEntries=20."
```

**Phase 2 — Capability groups:** Add `--caps` flag (Playwright-style):
- `core` (default): `go_to_url`, `get_page_text`, `get_links`, `click`, `fill`,
  `evaluate`, `scroll`, `wait_for`, `new_tab`, `close_tabs`, `list_tabs`
- `screenshots`: `get_screenshot`
- `profiles`: `create_profile`, `save_profile`, `delete_profile`, `list_profiles`
- `credentials`: `credentials`, `use_credential`
- `advanced`: `get_attrs`, `get_console`, `cookies`, `download_file`, `history`
- `lifecycle`: `start_browser`, `stop_browser`, `captcha_status`, `smoke_test`

**Effort:** Phase 1: 2-3 hours. Phase 2: 1 day.
**Impact:** 30-50% reduction in tool schema context overhead.

### 3.2 Batch URL fetching

**Problem:** Agents chain `new_tab` → `new_tab` → `new_tab` 114 times in sequence
to open multiple URLs. Then they read each tab separately.

**What others do:**
- fetcher-mcp: `fetch_urls` tool — batch fetches multiple URLs in parallel,
  returns combined results with clear separation.

**Fix:** Add `fetch_urls` tool:
```typescript
fetch_urls(
  urls: ["https://a.com", "https://b.com", "https://c.com"],
  extractContent: true,
  maxCharsPerPage: 3000
)
// Returns combined results, one per URL
```

**Effort:** ~150 lines. **Impact:** Replaces 3-6 tool calls with 1 for research workflows.

### 3.3 Structured extraction mode (inspired by Browserbase `extract`)

**Problem:** Agents use `evaluate` with complex JS (96 times in OpenClaw alone) to extract
structured data — product prices, search results, article metadata. This is fragile and
produces huge context when JS expressions are pasted back and forth.

**What others do:**
- Browserbase/Stagehand: `extract` tool with natural language `instruction` param.
  The server uses an internal LLM (Gemini Flash Lite) to figure out the extraction.
  "Extract data from the page" with `{ instruction: "get product names and prices" }`.
- bb-browser: Per-platform adapters that return structured JSON natively.

**Fix:** Add `extract` tool (simpler version — no internal LLM, just CSS+schema):
```typescript
extract(
  selector: ".product-card",
  fields: {
    name: "h3",
    price: ".price",
    rating: "[data-rating]@data-rating",
    url: "a@href"
  },
  limit: 20
)
// Returns: [{name: "...", price: "...", rating: "4.5", url: "..."}, ...]
```

This is a declarative alternative to `evaluate` that produces clean, bounded output.

**Effort:** ~200 lines. **Impact:** Replaces fragile JS evaluate patterns with
deterministic, truncated extraction.

---

## Priority 4: Nice to Have

### 4.1 Resource blocking (media/fonts/css)

fetcher-mcp: "Automatically blocks unnecessary resources (images, stylesheets, fonts,
media) to reduce bandwidth usage and improve performance."

Add `disableMedia: boolean` param to `go_to_url` and `new_tab`.

### 4.2 Markdown output mode for `get_page_text`

fetcher-mcp supports `returnHtml` toggle. We should add a `format: "text" | "markdown"`
option. Markdown preserves link structure and headings while being more compact than HTML.

### 4.3 Accessibility snapshot mode (Playwright-style)

Playwright MCP's core innovation is `browser_snapshot` — captures the accessibility tree
instead of raw text. This gives the LLM a structured, ref-numbered view of the page that's
inherently compact and deterministic. Major architectural shift but would be the biggest
single improvement for context efficiency.

### 4.4 Progressive tool disclosure

Add a `browser_tools` meta-tool that returns available tools on demand rather than loading
all 27 schemas upfront. The MCP Standards Server pattern: "Load minimal schemas first and
expand them only when a tool is actually used."

---

## Implementation Order

| # | Change | Effort | Context Savings | Priority |
|---|--------|--------|-----------------|----------|
| 1 | CAPTCHA wait-and-retry + expanded bot-wall detection | 1 hr | High (stops workflow breaks) | P1 |
| 2 | `evaluate` output truncation (maxChars + file) | 30 min | High (unbounded → capped) | P1 |
| 3 | `go_to_url` readPage param | 2 hrs | High (eliminates 167 pairs) | P1 |
| 4 | Lower `get_page_text` default maxChars 10K→5K | 5 min | Medium (~50% per call) | P1 |
| 5 | 404 / error page detection in `go_to_url` | 1 hr | Medium (stops blind retries) | P1 |
| 6 | Readability extraction (`extractContent`) | 4 hrs | High (60-80% noise reduction) | P2 |
| 7 | `scroll` readAfterScroll param | 1 hr | Medium (eliminates ~50 pairs) | P2 |
| 8 | Tool description compression | 2 hrs | Medium (30-50% schema overhead) | P3 |
| 9 | Capability groups (`--caps`) | 1 day | Medium (load only what's needed) | P3 |
| 10 | `fetch_urls` batch tool | 4 hrs | Medium (replaces tab chaining) | P3 |
| 11 | `extract` structured extraction | 1 day | High (replaces fragile evaluate) | P3 |
| 12 | Resource blocking, markdown output | 2 hrs | Low-Medium | P4 |

---

## Case Study: This Session's Steel Usage

This improvement plan was itself researched using Steel. The session's own tool calls
provide a perfect real-world case study of the problems identified above.

### Raw Numbers

| Metric | Value |
|--------|-------|
| Total Steel calls | **66** |
| Total context consumed | **95 KB** (part data) / **68 KB** (output text) |
| `go_to_url` calls | **40** (61% of all calls) |
| `get_page_text` calls | **16** (but 67% of output bytes) |
| 404 "Page not found" navigations | **15** (23% of all calls — pure waste) |
| Google CAPTCHA blocks | **2** (navigated, hit `/sorry`, had to switch to Bing) |
| Calls that produced zero useful content | **~22** (404s + CAPTCHAs + retries) |

### What Went Wrong

**1. Blind URL guessing (15 wasted calls)**

The agent tried to find repos by guessing URL patterns (`nichochar/open-browser-use`,
`nichochar/browser-use-mcp-server`, `nichochar/mocha-browser-mcp`, etc.) — 15 calls
that all returned "Page not found". A single GitHub search would have found the right
repos in 1 call.

**Improvement needed:** The _skill_ doc should guide agents to search first, never guess
repo URLs. But the _tool_ could also help: `go_to_url` should detect 404/not-found pages
and return a clear signal (`isError: true` or a `status: 404` field) so the agent stops
retrying variants. Currently it returns `"Navigated to ...\nTitle: Page not found"` which
the agent treats as success.

**2. go_to_url → get_page_text pair (9 occurrences)**

Every time a real page was found, two calls were needed: navigate then read. With the
proposed `readPage` param, these 9 pairs would collapse to 9 single calls — saving
9 round trips and ~9 tool-call context entries.

**3. Scroll + re-read (1 occurrence)**

`scroll(down, 3000)` → `get_page_text(maxChars: 6000)` — the classic pattern. After
scrolling, the full page text was re-fetched because scroll returns nothing useful
("Scrolled down by 3000 pixels. Position: 3000px / 11640px").

**4. Duplicate page reads**

The New Stack article was read twice — once truncated at 8000 chars, then scrolled and
re-read at 6000 chars, then finally saved to file with `maxChars: 0`. Three calls for
one article. With Readability extraction, a single call would have extracted just the
article body (~4KB clean).

**5. Google CAPTCHA → no automatic recovery**

Two Google searches hit `/sorry` CAPTCHA pages. The CapSolver extension was loaded
(verified with `captcha_status`), but Google's challenge wasn't auto-solved. The agent
had to manually switch to Bing. The tool should detect the Google sorry redirect
as a bot wall (which it partially does, but the agent didn't interpret the signal
correctly because the URL didn't match the existing `/cdn-cgi/challenge-platform/`
pattern).

### What Would Have Been Different With Improvements

| Scenario | Actual calls | With improvements | Savings |
|----------|-------------|-------------------|---------|
| 15 × guessed 404 URLs | 15 | 0 (search-first pattern + 404 detection) | 15 calls |
| 9 × nav + read pairs | 18 | 9 (`readPage: true`) | 9 calls |
| 1 × scroll + re-read | 2 | 1 (`readAfterScroll: true`) | 1 call |
| 3 × read same article | 3 | 1 (Readability extraction) | 2 calls |
| 2 × Google CAPTCHA | 2+ | 0 (detect + auto-fallback or clearer signal) | 2+ calls |
| **Total** | **66** | **~37** | **~29 calls (44% reduction)** |

Context savings would be even larger — the 15 wasted 404 navigations consumed ~7 KB of
context for zero information gain.

---

## References

- [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp) — accessibility snapshots, `--caps` groups, CLI+SKILLS pattern
- [bb-browser](https://github.com/nichochar/bb-browser) — `--json` output, `--jq` filtering, per-platform adapters (note: repo was at `epiral/bb-browser` on GitHub during research)
- [fetcher-mcp](https://github.com/jae-jae/fetcher-mcp) — Readability extraction, `disableMedia`, `fetch_urls` batch, `maxLength`
- [Browserbase MCP](https://github.com/browserbase/mcp-server-browserbase) — 6-tool minimal surface, `extract` with natural language
- [10 Strategies to Reduce MCP Token Bloat](https://thenewstack.io/how-to-reduce-mcp-token-bloat/) — progressive disclosure, schema minimization
- [MCP Standards Server Token Optimization](https://williamzujkowski.github.io/mcp-standards-server/token-optimization/) — format variants, progressive loading, budget management
