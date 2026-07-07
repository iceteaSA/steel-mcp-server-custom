import { z } from "zod";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { Impit } from "impit";
import type { BrowserManager, Env } from "../manager.js";
import { globalWait, withBackgroundTab, writeToFile } from "../utils.js";
import {
  capText,
  cleanErrorMessage,
  dedupeLinks,
  detectErrorPage,
  extractPageContent,
  findTitle,
  isSpaShell,
  pickPrimaryLink,
  validateExpression,
  WALK_CONTENT_BLOCK_SRC,
  type Link,
} from "../helpers.js";
import type { ToolRegistrar } from "./shared.js";
import {
  frameTarget,
  resolveFrame,
  tabTarget,
  tabTargetForce,
  toSelector,
  decorateRefError,
} from "./shared.js";
import {
  captureSnapshot,
  diffSnapshots,
  filterTree,
  getStoredSnapshot,
  storeSnapshot,
  truncateForDisplay,
  applyIntent,
} from "../snapshot.js";

// Singleton — configured once, reused across calls.
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

/**
 * Pure extraction pipeline shared by the HTTP fast-path and the browser
 * path. Runs Readability on the parsed linkedom document, then falls back
 * to extractPageContent if Readability returned nothing.
 */
function extractFromHtml(
  html: string,
  titleHint: string,
  extractContent: boolean,
): { text: string; title: string } {
  const { document: dom } = parseHTML(html);
  let text = "";
  let articleTitle = "";
  if (extractContent) {
    const reader = new Readability(dom as any);
    const article = reader.parse();
    if (article) {
      articleTitle = article.title ?? "";
      text = (article.textContent ?? "")
        .replace(/[^\S\n]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (articleTitle && text) text = `# ${articleTitle}\n\n${text}`;
    }
  }
  if (!text) {
    const result = extractPageContent({ selector: null, mode: "innerText" }, dom as any);
    text = (result.text ?? "")
      .replace(/[^\S\n]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  const domTitle = (dom as any)?.querySelector?.("title")?.textContent ?? "";
  const title = (titleHint || domTitle || articleTitle).trim();
  return { text, title };
}

/**
 * HTTP fast-path using impit's TLS fingerprint impersonation. No JS, no
 * cookies — designed for server-rendered / static HTML where it's ~10x
 * faster than spinning a browser tab.
 *
 * The `client` param is injectable for unit tests; production callers omit
 * it and a real Impit client is constructed. Returns a `path: "http"`
 * result with the extracted text plus an `escalated` flag the caller
 * checks to decide whether to retry in a real browser.
 */
export interface FetchResult {
  url: string;
  title: string;
  text: string;
  path: "http" | "browser";
  escalated?: boolean;
  status?: number;
}

export async function fetchHttp(
  url: string,
  opts: {
    client?: any;
    timeout?: number;
    extractContent?: boolean;
    maxCharsPerPage?: number;
  } = {},
): Promise<FetchResult> {
  const extractContent = opts.extractContent ?? true;
  const maxCharsPerPage = opts.maxCharsPerPage ?? 0;
  const client = opts.client ?? new Impit({ browser: "chrome", timeout: opts.timeout ?? 15_000 });
  const response = await client.fetch(url, { redirect: "follow" });
  const status: number = response.status;
  const html: string = await response.text();
  // Decide escalation on the FULL extracted text + html. A tiny
  // maxCharsPerPage must not turn a real article into a false-positive
  // shell — that would trigger an unnecessary browser-path retry.
  const { text: fullText, title } = extractFromHtml(html, "", extractContent);
  const escalated = isSpaShell(html, fullText, status);
  // Cap only the returned text — keep the escalation decision anchored
  // to the un-truncated content.
  let outText = fullText;
  if (maxCharsPerPage > 0 && outText.length > maxCharsPerPage) {
    outText =
      outText.slice(0, maxCharsPerPage) +
      `\n[TRUNCATED — ${fullText.length.toLocaleString()} total]`;
  }
  const tag = `[http${status === 200 ? "" : ` ${status}`}]`;
  const contentText = `${tag} ${title || url}\nURL: ${url}\n\n${outText}`;
  return { url, title: title || url, text: contentText, path: "http", escalated, status };
}

// Dependency-injection seam for the fetch_urls handler. Tests inject fakes
// through these fields instead of mutating the global module registry via
// bun's mock.module() — which leaks into other test files that share a
// process. See src/__tests__/fetch_urls.test.ts for usage.
export interface RunFetchUrlsDeps {
  fetchHttp?: typeof fetchHttp;
}

export async function runFetchUrls(
  args: {
    urls: string[];
    extractContent?: boolean;
    maxCharsPerPage?: number;
    mode?: "auto" | "browser" | "http";
  },
  mgr: BrowserManager,
  env: Env,
  deps: RunFetchUrlsDeps = {},
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { results: FetchResult[] };
}> {
  const { urls, extractContent = true, maxCharsPerPage = 3000, mode = "auto" } = args;
  const fetchHttpFn = deps.fetchHttp ?? fetchHttp;
  const results: string[] = [];
  const structured: FetchResult[] = [];

  // Browser path: original behavior — open a real background tab.
  const fetchBrowser = async (url: string): Promise<FetchResult> => {
    return withBackgroundTab(mgr, async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await globalWait(env);

      const pageTitle = await page.title().catch(() => "");
      const errorStatus = detectErrorPage(pageTitle);
      if (errorStatus) {
        const msg = `[browser] ${url}\n[HTTP ${errorStatus} — ${pageTitle}]`;
        return { url, title: pageTitle, text: msg, path: "browser" as const };
      }

      const html = await page.content();
      const { text, title } = extractFromHtml(html, pageTitle, extractContent);

      if (maxCharsPerPage > 0 && text.length > maxCharsPerPage) {
        const truncated =
          text.slice(0, maxCharsPerPage) + `\n[TRUNCATED — ${text.length.toLocaleString()} total]`;
        return {
          url,
          title: title || pageTitle || url,
          text: `[browser] ${title || pageTitle || url}\nURL: ${url}\n\n${truncated}`,
          path: "browser" as const,
        };
      }
      return {
        url,
        title: title || pageTitle || url,
        text: `[browser] ${title || pageTitle || url}\nURL: ${url}\n\n${text}`,
        path: "browser" as const,
      };
    });
  };

  const fetchOne = async (url: string): Promise<FetchResult> => {
    if (mode === "browser") return fetchBrowser(url);
    if (mode === "http") {
      try {
        return await fetchHttpFn(url, { extractContent, maxCharsPerPage });
      } catch (err) {
        const error = err as Error;
        const msg = `[http] ${url}\n[ERROR: ${cleanErrorMessage(error)}]`;
        return { url, title: url, text: msg, path: "http", escalated: false };
      }
    }
    // mode === "auto": try HTTP, escalate on shell/challenge.
    let httpResult: FetchResult;
    try {
      httpResult = await fetchHttpFn(url, { extractContent, maxCharsPerPage });
    } catch (err) {
      // HTTP path failed entirely — fall back to browser.
      try {
        const br = await fetchBrowser(url);
        // Browser path was used (even though HTTP fell through) — note
        // this in structuredContent but label the user-visible prefix
        // [browser] since the browser path actually served the page.
        const note = `[browser] HTTP fast-path failed; browser served this URL (${cleanErrorMessage(err as Error)})`;
        return {
          ...br,
          text: `${note}\n\n${br.text}`,
          escalated: true,
        };
      } catch (err2) {
        const err2Msg = `[browser] ${url}\n[ERROR: ${cleanErrorMessage(err2 as Error)}]`;
        return { url, title: url, text: err2Msg, path: "browser", escalated: false };
      }
    }
    if (httpResult.escalated) {
      try {
        const br = await fetchBrowser(url);
        // Spec: prefix is `[browser]` when browser actually served the
        // URL (even if auto escalated). escalated:true so structured
        // consumers know auto chose to switch paths.
        return { ...br, escalated: true };
      } catch (escalationErr) {
        // Browser escalation failed — keep whatever the http path gave us
        // so the caller at least sees the raw HTML/text shell response.
        // Surface the underlying error in the structured response for debugging.
        const fallbackText = `${httpResult.text}\n\n[escalation failed: ${cleanErrorMessage(escalationErr as Error)}]`;
        return { ...httpResult, text: fallbackText, escalated: false };
      }
    }
    return httpResult;
  };

  const settled = await Promise.allSettled(urls.map(fetchOne));
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") {
      results.push(r.value.text);
      structured.push({
        url: r.value.url,
        title: r.value.title,
        text: r.value.text,
        path: r.value.path,
        escalated: r.value.escalated ?? false,
      });
    } else {
      const errText = `## ${urls[i]}\n[ERROR: ${cleanErrorMessage(r.reason)}]`;
      results.push(errText);
      structured.push({
        url: urls[i],
        title: urls[i],
        text: errText,
        path: "browser" as const,
        escalated: false,
      });
    }
  }

  return {
    content: [{ type: "text" as const, text: results.join("\n\n---\n\n") }],
    structuredContent: { results: structured },
  };
}

/** Snapshot filter schema (no zod default — the handler owns the effective default). */
export const snapshotFilterSchema = z
  .enum(["interactive", "all", "visible"])
  .optional()
  .describe(
    "Element filter. interactive (default): only actionable elements + structural ancestors (3-5x fewer nodes). all: full tree. visible: drop hidden.",
  );

export function register(register: ToolRegistrar, mgr: BrowserManager, env: Env): void {
  // get_page_text -------------------------------------------------------------
  register({
    name: "get_page_text",
    title: "Get Page Text",
    description: `Extract text from the current page, auto-detecting the main content area. Use extractContent for Readability-based article extraction (strips nav/ads/footer), or matchAll for structured list scraping. Use as the primary content-reading tool after navigation. Do NOT use to read URLs or links — use get_links for structured link extraction. Pass frame to target an iframe by name, URL substring, or child-frame index (0-based, excludes main). Use snapshot to list available frames.

CONTEXT BUDGET — output capped at maxChars (default 5K). Use outputMode: "file" for large pages.`,
    toolset: "core",
    inputSchema: {
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector to scope extraction (e.g. 'article', 'main', '#content'). Defaults to auto-detect.",
        ),
      extractContent: z
        .boolean()
        .default(false)
        .optional()
        .describe(
          "Use Mozilla Readability to extract article body, stripping nav/ads/footer/sidebars. Best for article and documentation pages. Default: false.",
        ),
      format: z
        .enum(["text", "markdown"])
        .default("text")
        .optional()
        .describe(
          "Output format. 'text' (default) = plain text. 'markdown' = lightweight markdown with headings and links preserved (best with extractContent: true).",
        ),
      maxChars: z
        .number()
        .default(5000)
        .optional()
        .describe(
          "Maximum characters to return inline. Default: 5000. Set to 0 for no limit (use with outputMode: 'file').",
        ),
      outputMode: z
        .enum(["inline", "file"])
        .default("inline")
        .optional()
        .describe("Return text inline (default) or save to file and return path."),
      outputPath: z
        .string()
        .optional()
        .describe(
          "File path when outputMode is 'file'. Defaults to OUTPUT_DIR/page_text_{timestamp}.txt.",
        ),
      includeLinks: z
        .boolean()
        .default(false)
        .optional()
        .describe("Append link URLs in brackets after each anchor's text. Default: false."),
      matchAll: z
        .boolean()
        .default(false)
        .optional()
        .describe(
          "If true, return a JSON array with one entry per element matching selector (querySelectorAll). Each entry: {text, title?, primaryLink?, links?}. title = text of anchor whose href matches primaryLink (use as headline). primaryLink picks the first link whose URL path depth >= 2 (skips nav/category). links = deduped [{text, href}] when includeLinks=true. maxChars applied per-entry. Designed for list-page scraping (article cards, product tiles, search results) in a single call. Default: false (returns single first match as string).",
        ),
      maxEntries: z
        .number()
        .default(20)
        .optional()
        .describe(
          "When matchAll=true, cap on number of entries returned. Default: 20. Set to 0 for no cap.",
        ),
      pretty: z
        .boolean()
        .default(false)
        .optional()
        .describe(
          "When matchAll=true, pretty-print the inline JSON (2-space indent). Default: false (compact — one entry per line).",
        ),
      ...tabTarget,
      ...frameTarget,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async ({
      selector,
      extractContent = false,
      format = "text",
      maxChars = 5000,
      outputMode = "inline",
      outputPath,
      includeLinks = false,
      matchAll = false,
      maxEntries = 20,
      pretty = false,
      tabId,
      owner,
      frame,
    }) => {
      try {
        const page = await mgr.getPage({ tabId, owner });
        const ctx = resolveFrame(page, frame);

        // --- extractContent: Readability-based article extraction ----------
        if (extractContent && !matchAll) {
          const html = await ctx.content();
          const { document: dom } = parseHTML(html);
          const reader = new Readability(dom as any);
          const article = reader.parse();
          let text: string;
          if (format === "markdown" && article?.content) {
            text = turndown.turndown(article.content).trim();
            if (article.title) text = `# ${article.title}\n\n${text}`;
          } else {
            text = article
              ? (article.textContent ?? "")
                  .replace(/[^\S\n]+/g, " ")
                  .replace(/\n{3,}/g, "\n\n")
                  .trim()
              : "";
            if (article?.title && text) text = `# ${article.title}\n\n${text}`;
          }

          if (text) {
            if (outputMode === "file") {
              const filePath = await writeToFile(
                Buffer.from(text, "utf8"),
                `page_article_${Date.now()}.txt`,
                env,
                outputPath,
              );
              return {
                content: [
                  {
                    type: "text",
                    text: `Article extracted to: ${filePath}\nTotal chars: ${text.length.toLocaleString()}`,
                  },
                ],
              };
            }
            const truncated = maxChars > 0 && text.length > maxChars;
            const output = truncated ? text.slice(0, maxChars) : text;
            return {
              content: [
                {
                  type: "text",
                  text:
                    output +
                    (truncated
                      ? `\n\n[TRUNCATED — ${text.length.toLocaleString()} total chars, showing first ${maxChars.toLocaleString()}. Use maxChars: 0 with outputMode: "file" for full content.]`
                      : ""),
                },
              ],
            };
          }
          // Readability failed — fall through to standard extraction
        }

        // --- matchAll: per-element structured output -----------------------
        if (matchAll) {
          const rawEntries = await ctx.evaluate(
            ({
              sel,
              withLinks,
              walkerSrc,
            }: {
              sel: string | null;
              withLinks: boolean;
              walkerSrc: string;
            }) => {
              // Rebuild the shared walkContentBlock in the browser context so
              // we don't leak module references across the page.evaluate
              // boundary. See helpers.ts WALK_CONTENT_BLOCK_SRC.
              const walker = new Function("return (" + walkerSrc + ")")();
              const roots = sel ? Array.from(document.querySelectorAll(sel)) : [document.body];
              return roots.map((root: Element) =>
                walker(root, {
                  includeLinks: withLinks,
                  // matchAll returns structured {text, links} — anchor URLs
                  // are surfaced via rawLinks, not as inline markers in text.
                  markHrefsInText: false,
                  // matchAll's pre-shared-walker behavior: aggressive
                  // whitespace collapse inside anchor text (incl. newlines).
                  collapseWhitespaceInAnchors: true,
                }),
              );
            },
            {
              sel: selector ?? null,
              withLinks: includeLinks,
              walkerSrc: WALK_CONTENT_BLOCK_SRC,
            },
          );

          type MatchEntry = {
            text: string;
            title?: string;
            primaryLink?: string;
            links?: Link[];
          };
          const entries: MatchEntry[] = rawEntries.map((r) => {
            const entry: MatchEntry = { text: capText(r.text, maxChars) };
            if (includeLinks) {
              const links = dedupeLinks(r.rawLinks);
              entry.links = links;
              const primary = pickPrimaryLink(links);
              if (primary) {
                entry.primaryLink = primary;
                const title = findTitle(primary, links);
                if (title) entry.title = title;
              }
            }
            return entry;
          });

          const totalMatched = entries.length;
          const capped =
            maxEntries > 0 && entries.length > maxEntries ? entries.slice(0, maxEntries) : entries;

          if (outputMode === "file") {
            const json = JSON.stringify(capped, null, 2);
            const filePath = await writeToFile(
              Buffer.from(json, "utf8"),
              `page_sections_${Date.now()}.json`,
              env,
              outputPath,
            );
            return {
              content: [
                {
                  type: "text",
                  text: `Page sections saved to: ${filePath}\nMatched: ${totalMatched}\nReturned: ${capped.length}`,
                },
              ],
            };
          }

          const truncated = capped.length < totalMatched;
          const body =
            capped.length === 0
              ? `[]${selector ? `\n(selector "${selector}" matched no elements)` : ""}`
              : pretty
                ? JSON.stringify(capped, null, 2)
                : "[\n" + capped.map((e) => JSON.stringify(e)).join(",\n") + "\n]";
          return {
            content: [
              {
                type: "text",
                text:
                  body +
                  (truncated
                    ? `\n[CAPPED — ${totalMatched} total sections matched, returning first ${capped.length}. Raise maxEntries or use outputMode: "file" for full list.]`
                    : ""),
              },
            ],
          };
        }

        // --- single-match path (original behavior) ------------------------
        const effectiveSelector: string | null = selector ?? null;
        type SingleResult = { __noMatch?: boolean; text?: string; usedSelector?: string };
        const rawResult: SingleResult = await ctx.evaluate(extractPageContent, {
          selector: effectiveSelector,
          includeLinks,
          mode: includeLinks ? ("walk" as const) : ("innerText" as const),
        });

        if (rawResult.__noMatch) {
          return {
            content: [
              {
                type: "text",
                text: `(selector "${selector}" matched no elements)`,
              },
            ],
          };
        }
        let text: string = (rawResult.text ?? "")
          .replace(/[^\S\n]+/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

        if (outputMode === "file") {
          const filePath = await writeToFile(
            Buffer.from(text, "utf8"),
            `page_text_${Date.now()}.txt`,
            env,
            outputPath,
          );
          return {
            content: [
              {
                type: "text",
                text: `Page text saved to: ${filePath}\nTotal chars: ${text.length.toLocaleString()}`,
              },
            ],
          };
        }

        const truncated = maxChars > 0 && text.length > maxChars;
        const output = truncated ? text.slice(0, maxChars) : text;
        return {
          content: [
            {
              type: "text",
              text:
                output +
                (truncated
                  ? `\n\n[TRUNCATED — ${text.length.toLocaleString()} total chars, showing first ${maxChars.toLocaleString()}. Use maxChars: 0 with outputMode: "file" to get full content.]`
                  : ""),
            },
          ],
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });

  // fetch_urls ----------------------------------------------------------------
  register({
    name: "fetch_urls",
    title: "Fetch URLs",
    description: `Batch-fetch 1-10 URLs in parallel with Readability article extraction. Returns combined text per URL — ideal for research workflows without the overhead of chaining new_tab + get_page_text per URL. Uses background tabs that are auto-cleaned up. Do NOT use for interactive pages (login, forms) — use go_to_url + fill for those.

CONTEXT BUDGET — output capped at maxCharsPerPage per URL (default 3K per URL).`,
    toolset: "extract",
    inputSchema: {
      urls: z.array(z.string()).min(1).max(10).describe("Array of URLs to fetch (1-10)."),
      extractContent: z
        .boolean()
        .default(true)
        .optional()
        .describe("Use Readability to extract article body per page. Default: true."),
      maxCharsPerPage: z
        .number()
        .default(3000)
        .optional()
        .describe("Max chars per page. Default: 3000."),
      mode: z
        .enum(["auto", "browser", "http"])
        .default("auto")
        .optional()
        .describe(
          'Fetch strategy. "http" = TLS-impersonated HTTP via impit (fast, no browser; misses JS-rendered content). "browser" = real browser tab per URL (always works, slower). "auto" (default) = try http first, escalate to browser when the HTTP result looks like an SPA shell or anti-bot challenge. Each URL result is prefixed with [http] or [browser] to show which path served it.',
        ),
    },
    outputSchema: {
      results: z.array(
        z.object({
          url: z.string(),
          title: z.string(),
          text: z.string(),
          path: z.enum(["http", "browser"]),
          escalated: z.boolean().optional(),
        }),
      ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async ({ urls, extractContent = true, maxCharsPerPage = 3000, mode = "auto" }) => {
      try {
        return await runFetchUrls({ urls, extractContent, maxCharsPerPage, mode }, mgr, env);
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(err) }] };
      }
    },
  });

  // get_links -----------------------------------------------------------------
  register({
    name: "get_links",
    title: "Get Links",
    description: `Extract all links from the page as a structured [{text, href}] array, deduped by href (first non-empty text wins). Filter with urlPattern (JS regex) to narrow results. Use to discover navigation targets, API endpoints, or downloadable files. Do NOT use for page text — use get_page_text for content extraction.

CONTEXT BUDGET — output capped at limit (default 50).`,
    toolset: "extract",
    inputSchema: {
      selector: z
        .string()
        .optional()
        .describe(
          "CSS scope for anchor search (e.g. 'main', 'article', '#results'). Defaults to document.body.",
        ),
      urlPattern: z
        .string()
        .optional()
        .describe(
          "Optional JS regex pattern (without slashes) to filter hrefs. Case-insensitive. Examples: '/articles/[a-z-]+-\\\\d{8}', 'example\\\\.com/.+/\\\\d{4}/\\\\d{2}/'.",
        ),
      limit: z
        .number()
        .default(50)
        .optional()
        .describe("Max results. Default: 50. Set 0 for no cap."),
      ...tabTarget,
    },
    outputSchema: {
      links: z.array(
        z.object({
          text: z.string(),
          href: z.string(),
        }),
      ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async ({ selector, urlPattern, limit = 50, tabId, owner }) => {
      try {
        if (urlPattern) {
          try {
            new RegExp(urlPattern, "i");
          } catch (reErr) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `urlPattern is not a valid regex: ${(reErr as Error).message}`,
                },
              ],
            };
          }
        }
        const page = await mgr.getPage({ tabId, owner });
        const rawLinks = await page.evaluate(
          ({ sel, pat }: { sel: string | null; pat: string | null }) => {
            const roots: Element[] = sel
              ? Array.from(document.querySelectorAll(sel))
              : [document.body];
            if (roots.length === 0) return [];
            const re = pat ? new RegExp(pat, "i") : null;
            const out: Array<{ text: string; href: string }> = [];
            for (const root of roots) {
              const anchors = Array.from(root.querySelectorAll("a[href]"));
              for (const a of anchors) {
                const href = (a as HTMLAnchorElement).href;
                if (!href) continue;
                if (re && !re.test(href)) continue;
                const text = (a.textContent ?? "").replace(/\s+/g, " ").trim();
                out.push({ text, href });
              }
            }
            return out;
          },
          { sel: selector ?? null, pat: urlPattern ?? null },
        );

        const links: Link[] = dedupeLinks(rawLinks);
        const capped = limit > 0 ? links.slice(0, limit) : links;
        const truncated = capped.length < links.length;
        const body =
          capped.length === 0
            ? `[]${selector ? `\n(no anchors found in elements matching "${selector}"${urlPattern ? ` for pattern /${urlPattern}/i` : ""})` : urlPattern ? `\n(no anchors matched pattern /${urlPattern}/i)` : ""}`
            : "[\n" + capped.map((l) => JSON.stringify(l)).join(",\n") + "\n]";
        const structured = capped.map((l) => ({ text: l.text, href: l.href }));
        return {
          content: [
            {
              type: "text",
              text:
                body +
                (truncated
                  ? `\n[CAPPED — ${links.length} total links matched, returning first ${capped.length}. Raise limit.]`
                  : ""),
            },
          ],
          structuredContent: { links: structured },
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });

  // get_attrs -----------------------------------------------------------------
  register({
    name: "get_attrs",
    title: "Get Attributes",
    description: `Extract specific attributes from elements matching a CSS selector or snapshot ref. Special attrs: "text" = innerText, "html" = outerHTML. Use for data-*, aria-*, src, alt, href, or structured data extraction — returns a JSON array of objects. Pass a ref from snapshot instead of a selector to target elements directly. Do NOT use for simple link lists — get_links is faster and deduplicates. Pass frame to target an iframe by name, URL substring, or child-frame index (0-based, excludes main). Use snapshot to list available frames.

CONTEXT BUDGET — output capped at limit (default 50 elements). Use maxCharsPerAttr to bound long values.`,
    toolset: "extract",
    inputSchema: {
      selector: z
        .string()
        .optional()
        .describe("CSS selector for elements to extract from (e.g. 'article', '.product-card')."),
      ref: z
        .string()
        .optional()
        .describe("Accessibility ref from snapshot (e.g. 'e5'). Use instead of selector."),
      attrs: z
        .array(z.string())
        .describe(
          "Attribute names to extract. Special: 'text' = innerText (visible text with proper whitespace), 'html' = outerHTML. Examples: ['href', 'data-id'], ['src', 'alt', 'text'].",
        ),
      limit: z
        .number()
        .default(50)
        .optional()
        .describe("Max elements to return. Default: 50. 0 = no cap."),
      maxCharsPerAttr: z
        .number()
        .default(2000)
        .optional()
        .describe(
          "Max characters per attribute value before truncation with '…[truncated]'. Default: 2000. Applies to all attrs including 'html' (outerHTML).",
        ),
      ...tabTarget,
      ...frameTarget,
    },
    outputSchema: {
      results: z.array(z.record(z.string(), z.string().nullable())),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async ({
      selector,
      ref,
      attrs,
      limit = 50,
      maxCharsPerAttr = 2000,
      tabId,
      owner,
      frame,
    }) => {
      let sel = "";
      try {
        sel = toSelector({ selector, ref });
        const page = await mgr.getPage({ tabId, owner });
        const ctx = resolveFrame(page, frame);

        // aria-ref is a Playwright-internal selector engine — it is not
        // visible to ctx.evaluate / querySelectorAll.  When a ref-based
        // selector is given, resolve element handles via locator first.
        const isRef = sel.startsWith("aria-ref=");
        let results: Array<Record<string, string | null>>;

        if (isRef) {
          // Ref addresses exactly one element.  locator.evaluate() auto-waits
          // and throws on timeout (stale ref) — never silently return [].
          const record = await ctx.locator(sel).evaluate(
            (el, { attrNames, maxChars }) => {
              const trunc = (s: string | null): string | null => {
                if (s === null) return null;
                if (maxChars <= 0 || s.length <= maxChars) return s;
                return s.slice(0, maxChars) + "…[truncated]";
              };
              const out: Record<string, string | null> = {};
              for (const name of attrNames) {
                if (name === "text") {
                  const raw = (el as HTMLElement).innerText ?? el.textContent ?? "";
                  out[name] = trunc(
                    raw
                      .replace(/[^\S\n]+/g, " ")
                      .replace(/\n{3,}/g, "\n\n")
                      .trim(),
                  );
                } else if (name === "html") {
                  out[name] = trunc((el as HTMLElement).outerHTML ?? null);
                } else {
                  out[name] = trunc((el as Element).getAttribute(name));
                }
              }
              return out;
            },
            { attrNames: attrs, maxChars: maxCharsPerAttr },
          );
          results = [record];
        } else {
          results = await ctx.evaluate(
            ({
              sel: cssSel,
              attrNames,
              maxChars,
            }: {
              sel: string;
              attrNames: string[];
              maxChars: number;
            }) => {
              const nodes = Array.from(document.querySelectorAll(cssSel));
              const trunc = (s: string | null): string | null => {
                if (s === null) return null;
                if (maxChars <= 0 || s.length <= maxChars) return s;
                return s.slice(0, maxChars) + "…[truncated]";
              };
              return nodes.map((el) => {
                const out: Record<string, string | null> = {};
                for (const name of attrNames) {
                  if (name === "text") {
                    const raw = (el as HTMLElement).innerText ?? el.textContent ?? "";
                    out[name] = trunc(
                      raw
                        .replace(/[^\S\n]+/g, " ")
                        .replace(/\n{3,}/g, "\n\n")
                        .trim(),
                    );
                  } else if (name === "html") {
                    out[name] = trunc((el as HTMLElement).outerHTML ?? null);
                  } else {
                    out[name] = trunc((el as Element).getAttribute(name));
                  }
                }
                return out;
              });
            },
            { sel: sel, attrNames: attrs, maxChars: maxCharsPerAttr },
          );
        }

        const capped = limit > 0 ? results.slice(0, limit) : results;
        const truncated = capped.length < results.length;
        const body =
          capped.length === 0
            ? `[]\n(selector "${sel}" matched no elements)`
            : "[\n" + capped.map((r) => JSON.stringify(r)).join(",\n") + "\n]";
        return {
          content: [
            {
              type: "text",
              text:
                body +
                (truncated
                  ? `\n[CAPPED — ${results.length} total matches, returning first ${capped.length}. Raise limit.]`
                  : ""),
            },
          ],
          structuredContent: { results: capped },
        };
      } catch (err) {
        const error = err as Error;
        return {
          isError: true,
          content: [{ type: "text", text: decorateRefError(error, sel) }],
        };
      }
    },
  });

  // evaluate ------------------------------------------------------------------
  register({
    name: "evaluate",
    title: "Evaluate JavaScript",
    description: `Run arbitrary JavaScript in the page context and return the result as JSON — an escape hatch when other tools don't cover a use case. Must be an expression; wrap multi-line logic in an IIFE: (() => { ... })(). With selector, the expression gets \`el\` bound to the first match. Do NOT use for routine scraping — use get_page_text, get_links, get_attrs, or extract instead. Pass frame to run inside an iframe by name, URL substring, or child-frame index (0-based, excludes main). Use snapshot to list available frames.

CONTEXT BUDGET — output capped at maxChars (default 10K). Use outputMode: "file" for large results.`,
    toolset: "extract",
    inputSchema: {
      expression: z
        .string()
        .describe(
          "JavaScript expression to evaluate in the page context. Must return a JSON-serialisable value. If `selector` is set, reference the matched element as `el`.",
        ),
      selector: z
        .string()
        .optional()
        .describe(
          "Optional CSS selector. When set, the expression runs with `el` bound to the first matching element (null if none).",
        ),
      maxChars: z
        .number()
        .default(10000)
        .optional()
        .describe(
          "Maximum characters of output to return inline. Default: 10000. Set to 0 for no limit.",
        ),
      outputMode: z
        .enum(["inline", "file"])
        .default("inline")
        .optional()
        .describe("Return result inline (default) or save to file and return path."),
      outputPath: z
        .string()
        .optional()
        .describe(
          "File path when outputMode is 'file'. Defaults to OUTPUT_DIR/eval_{timestamp}.json.",
        ),
      waitAfter: z
        .boolean()
        .default(false)
        .optional()
        .describe(
          "Call the global wait after evaluation (useful if the expression triggers async side effects). Default: false.",
        ),
      ...tabTargetForce,
      ...frameTarget,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async ({
      expression,
      selector,
      maxChars = 10000,
      outputMode = "inline",
      outputPath,
      waitAfter = false,
      tabId,
      owner,
      force,
      frame,
    }) => {
      try {
        // Syntax-check the expression before sending to the browser.
        const syntaxError = validateExpression(expression);
        if (syntaxError) {
          return {
            isError: true,
            content: [{ type: "text", text: syntaxError }],
          };
        }

        const page = await mgr.getPage({ tabId, owner, force });
        const ctx = resolveFrame(page, frame);
        let result: unknown;
        if (selector) {
          const wrapped = `(function(){ const el = document.querySelector(${JSON.stringify(
            selector,
          )}); if (!el) return null; return (${expression}); })()`;
          result = await ctx.evaluate(wrapped);
        } else {
          result = await ctx.evaluate(expression);
        }
        if (waitAfter) await globalWait(env);
        const text = result === undefined ? "undefined" : JSON.stringify(result, null, 2);

        if (outputMode === "file") {
          const filePath = await writeToFile(
            Buffer.from(text, "utf8"),
            `eval_${Date.now()}.json`,
            env,
            outputPath,
          );
          return {
            content: [
              {
                type: "text",
                text: `Eval result saved to: ${filePath}\nSize: ${text.length.toLocaleString()} chars`,
              },
            ],
          };
        }

        if (maxChars > 0 && text.length > maxChars) {
          return {
            content: [
              {
                type: "text",
                text:
                  text.slice(0, maxChars) +
                  `\n\n[TRUNCATED — ${text.length.toLocaleString()} total chars, showing first ${maxChars.toLocaleString()}. Use maxChars: 0 or outputMode: "file" for full output.]`,
              },
            ],
          };
        }

        return { content: [{ type: "text", text }] };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });

  // extract -------------------------------------------------------------------
  register({
    name: "extract",
    title: "Declarative Extract",
    description: `Declarative structured extraction from repeating elements. Pass a CSS selector (or snapshot ref) and a field map (field name → sub-selector or sub-selector@attribute) to produce a JSON array of records. Use "." as the field spec to extract the root element's own text. When using a ref from snapshot, nested field-map selectors remain CSS-relative (scoped to the ref's subtree). Replaces fragile evaluate() for scraping lists, tables, or repeating DOM structures — do NOT use for single-element extraction (use get_attrs or get_page_text). Pass frame to target an iframe by name, URL substring, or child-frame index (0-based, excludes main). Use snapshot to list available frames.

CONTEXT BUDGET — output capped at limit (default 20 items).`,
    toolset: "extract",
    inputSchema: {
      selector: z
        .string()
        .optional()
        .describe("CSS selector for the repeating elements (e.g. '.product-card', 'tr.result')."),
      ref: z
        .string()
        .optional()
        .describe("Accessibility ref from snapshot (e.g. 'e5'). Use instead of selector."),
      fields: z
        .record(z.string(), z.string())
        .describe(
          "Map of field name → CSS sub-selector or sub-selector@attribute. " +
            "Plain selector extracts innerText. Use @attr to extract an attribute " +
            "(e.g. 'a@href', '[data-id]@data-id', 'img@src'). " +
            "Use '.' for the root element's own text.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .default(20)
        .optional()
        .describe("Max items to return. Default: 20."),
      ...tabTarget,
      ...frameTarget,
    },
    outputSchema: {
      results: z.array(z.record(z.string(), z.string().nullable())),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async ({ selector, ref, fields, limit = 20, tabId, owner, frame }) => {
      let sel = "";
      try {
        sel = toSelector({ selector, ref });
        const page = await mgr.getPage({ tabId, owner });
        const ctx = resolveFrame(page, frame);

        // aria-ref is a Playwright-internal selector engine — invisible to
        // ctx.evaluate / querySelectorAll.  Resolve element handles via
        // locator when a ref-based selector is given.
        const isRef = sel.startsWith("aria-ref=");
        let results: Array<Record<string, string | null>>;

        if (isRef) {
          // Ref addresses exactly one element.  locator.evaluate() auto-waits
          // and throws on timeout (stale ref) — never silently return [].
          // Field-map parser is inlined so the evaluated function stays
          // self-contained: Playwright serializes it to the browser, where
          // module-scope references are not available.
          const record = await ctx.locator(sel).evaluate(
            (root, { fieldMap }) => {
              const rec: Record<string, string | null> = {};
              for (const [name, spec] of Object.entries(fieldMap)) {
                const atIdx = spec.lastIndexOf("@");
                let subSel: string;
                let attr: string | null = null;
                if (atIdx > 0) {
                  subSel = spec.slice(0, atIdx);
                  attr = spec.slice(atIdx + 1);
                } else if (spec === ".") {
                  rec[name] = root.textContent?.trim() ?? null;
                  continue;
                } else {
                  subSel = spec;
                }
                const el = root.querySelector(subSel);
                if (!el) {
                  rec[name] = null;
                } else if (attr) {
                  rec[name] = el.getAttribute(attr);
                } else {
                  rec[name] = el.textContent?.trim() ?? null;
                }
              }
              return rec;
            },
            { fieldMap: fields as Record<string, string> },
          );
          results = [record];
        } else {
          // Same parser inlined for the multi-root path — passing a Node
          // module-scope function into ctx.evaluate produces
          // ReferenceError in the browser isolate.
          results = await ctx.evaluate(
            (args) => {
              const roots = Array.from(document.querySelectorAll(args.sel)).slice(0, args.maxItems);
              return roots.map((root) => {
                const record: Record<string, string | null> = {};
                for (const [name, spec] of Object.entries(args.fieldMap)) {
                  const atIdx = spec.lastIndexOf("@");
                  let subSel: string;
                  let attr: string | null = null;
                  if (atIdx > 0) {
                    subSel = spec.slice(0, atIdx);
                    attr = spec.slice(atIdx + 1);
                  } else if (spec === ".") {
                    record[name] = root.textContent?.trim() ?? null;
                    continue;
                  } else {
                    subSel = spec;
                  }
                  const el = root.querySelector(subSel);
                  if (!el) {
                    record[name] = null;
                  } else if (attr) {
                    record[name] = el.getAttribute(attr);
                  } else {
                    record[name] = el.textContent?.trim() ?? null;
                  }
                }
                return record;
              });
            },
            { sel, fieldMap: fields as Record<string, string>, maxItems: limit },
          );
        }

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `[]\n(selector "${sel}" matched no elements)` }],
            structuredContent: { results: [] },
          };
        }

        const json = "[\n" + results.map((r) => JSON.stringify(r)).join(",\n") + "\n]";
        return {
          content: [{ type: "text", text: json }],
          structuredContent: { results },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: decorateRefError(err as Error, sel) }],
        };
      }
    },
  });

  // snapshot -------------------------------------------------------------------
  register({
    name: "snapshot",
    title: "Page Snapshot",
    description: `See the page as an accessibility tree with stable element refs (@eN). THE preferred first look at any page: ~10x cheaper than get_page_text for understanding structure, and refs feed click/fill/get_attrs/extract directly (pass ref instead of selector). Refs expire on navigation or page mutation — take a fresh snapshot after either. Pass frame to target an iframe by name, URL substring, or child-frame index (0-based, excludes main); the output appends a frames section listing child frames when present. Default filter "interactive" shows only actionable elements (3-5x fewer nodes).

CONTEXT BUDGET — default 8K chars; scope with selector for big pages.`,
    toolset: "core",
    inputSchema: {
      selector: z
        .string()
        .optional()
        .describe("Scope to a subtree (CSS selector). Default: whole page."),
      maxChars: z
        .number()
        .optional()
        .describe(
          "Cap output (default 8000). Over-budget output is truncated at a line boundary — scope with selector instead of raising this.",
        ),
      filter: snapshotFilterSchema,
      diff: z
        .boolean()
        .optional()
        .describe(
          "Return only elements changed since the last snapshot of this tab (delta), not the full tree. Returns the raw delta of the full tree; filter and intent are not applied in diff mode.",
        ),
      intent: z
        .enum(["login", "search", "read_content", "fill_form", "navigate", "buy", "extract_data"])
        .optional()
        .describe(
          "Goal-scoped filter applied AFTER interactive/visible filter (e.g. 'login' keeps only form elements + login-related text).",
        ),
      ...tabTarget,
      ...frameTarget,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async ({ selector, maxChars, filter, diff, intent, tabId, owner, frame }) => {
      try {
        const resolvedTabId = mgr.resolveTab({ tabId, owner });
        const page = await mgr.getPage({ tabId, owner });
        const ctx = resolveFrame(page, frame);

        // Capture the full untruncated tree.
        const result = await captureSnapshot(ctx, resolvedTabId, { selector, noTruncate: true });

        // ----- diff mode: return delta vs stored baseline -----
        // Diff operates on the full raw tree so no change is missed.
        // Filter and intent are not applied in diff mode.
        if (diff && frame === undefined) {
          const prev = getStoredSnapshot(resolvedTabId);
          storeSnapshot(resolvedTabId, result.text);
          if (prev === undefined) {
            const shown = truncateForDisplay(result.text, maxChars ?? 8000);
            return {
              content: [{ type: "text", text: `(no baseline — captured fresh)\n${shown}` }],
            };
          }
          const delta = diffSnapshots(prev, result.text, { maxChars: maxChars ?? 8000 });
          return { content: [{ type: "text", text: delta }] };
        }

        // Store the raw tree (no frames block) — baseline must not include
        // the frames metadata or actionFeedback diffs will phantom-diff it
        // every time child frame URLs change.
        if (frame === undefined) {
          storeSnapshot(resolvedTabId, result.text);
        }

        // When an intent is given, its own role set narrows the FULL tree (base
        // "all"), so content intents (read_content / extract_data) aren't pre-stripped
        // by the interactive default. An explicit filter arg is still honored.
        const baseFilter = intent ? (filter ?? "all") : (filter ?? "interactive");
        const filtered = filterTree(result.text, baseFilter);
        const scoped = intent ? applyIntent(filtered, intent) : filtered;

        // Build the frames block first so we can reserve its budget — maxChars
        // must be a hard cap on the whole output, frames included.
        const childFrames = page.frames().slice(1);
        let framesBlock = "";
        if (childFrames.length > 0) {
          const list = childFrames
            .map((f, i) => `[${i}] name="${f.name()}" url=${f.url()}`)
            .join("\n");
          framesBlock = `\n--- frames ---\n${list}`;
        }
        const contentBudget = Math.max(200, (maxChars ?? 8000) - framesBlock.length);
        const displayText = truncateForDisplay(scoped, contentBudget);
        const output = displayText + framesBlock;

        return { content: [{ type: "text", text: output }] };
      } catch (err) {
        const error = err as Error;
        return {
          isError: true,
          content: [{ type: "text", text: cleanErrorMessage(error) }],
        };
      }
    },
  });

  // page_state — lightweight page observation ---------------------------------
  register({
    name: "page_state",
    title: "Page State",
    toolset: "core",
    description: `Lightweight page observation (url, title, scroll%, element counts) — ~48 tokens, no full snapshot. Use to check "did the page change?" cheaply.

CONTEXT BUDGET — tiny fixed output.`,
    inputSchema: {
      ...tabTarget,
    },
    outputSchema: {
      url: z.string().optional(),
      title: z.string().optional(),
      scrollPercent: z.number().optional(),
      elementCount: z.number().optional(),
      interactiveCount: z.number().optional(),
      hasDialog: z.boolean().optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async ({ tabId, owner }) => {
      try {
        const page = await mgr.getPage({ tabId, owner });
        const s = await page.evaluate(() => {
          const de = document.documentElement;
          const max = de.scrollHeight - de.clientHeight;
          const interactive = document.querySelectorAll(
            "a[href],button,input,select,textarea,[role=button],[role=link],[role=textbox],[tabindex]:not([tabindex='-1'])",
          ).length;
          return {
            url: location.href,
            title: document.title,
            scrollPercent: max > 0 ? Math.round((de.scrollTop / max) * 100) : 0,
            elementCount: document.querySelectorAll("*").length,
            interactiveCount: interactive,
          };
        });

        // Dialogs are auto-resolved immediately by the per-tab policy (see
        // handle_dialog), so there is no meaningful "pending dialog" to report.
        // Fixed false in v1.
        const hasDialog = false;

        const out = { ...s, hasDialog };
        return {
          content: [{ type: "text", text: JSON.stringify(out) }],
          structuredContent: out,
        };
      } catch (err) {
        const error = err as Error;
        return {
          isError: true,
          content: [{ type: "text", text: cleanErrorMessage(error) }],
        };
      }
    },
  });
}
