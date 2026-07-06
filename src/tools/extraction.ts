import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { BrowserManager, Env } from "../manager.js";
import { globalWait, writeToFile } from "../utils.js";
import {
  capText,
  cleanErrorMessage,
  dedupeLinks,
  detectErrorPage,
  extractPageContent,
  findTitle,
  pickPrimaryLink,
  type Link,
} from "../helpers.js";

// Singleton — configured once, reused across calls.
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

export function register(server: McpServer, mgr: BrowserManager, env: Env): void {
  // get_page_text -------------------------------------------------------------
  server.tool(
    "get_page_text",
    `Extract text from page. Auto-detects main content. Use extractContent for Readability-based article extraction (strips nav/ads/footer). Use matchAll for structured list scraping.`,
    {
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
      tabId: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Optional tab ID. Omit to use the current active tab."),
    },
    async ({
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
    }) => {
      try {
        const page = await mgr.getPage(tabId);

        // --- extractContent: Readability-based article extraction ----------
        if (extractContent && !matchAll) {
          const html = await page.content();
          const { document: dom } = parseHTML(html);
          const reader = new Readability(dom as any);
          const article = reader.parse();
          let text: string;
          if (format === "markdown" && article?.content) {
            // Convert Readability's clean HTML to markdown via turndown
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
          const rawEntries = await page.evaluate(
            ({ sel, withLinks }: { sel: string | null; withLinks: boolean }) => {
              const roots = sel ? Array.from(document.querySelectorAll(sel)) : [document.body];
              const collect = (root: Element) => {
                const rawLinks: Array<{ text: string; href: string }> = [];
                const blockTags = new Set([
                  "P",
                  "DIV",
                  "LI",
                  "H1",
                  "H2",
                  "H3",
                  "H4",
                  "H5",
                  "H6",
                  "TR",
                  "BLOCKQUOTE",
                  "PRE",
                  "SECTION",
                  "ARTICLE",
                  "HEADER",
                  "FOOTER",
                  "NAV",
                  "ASIDE",
                  "MAIN",
                  "DETAILS",
                  "SUMMARY",
                  "FIGCAPTION",
                  "DT",
                  "DD",
                ]);
                const walk = (node: Element): string => {
                  if (node.tagName === "BR") return "\n";
                  if (node.tagName === "A") {
                    const href = (node as HTMLAnchorElement).href;
                    const txt = (node.textContent ?? "").replace(/\s+/g, " ").trim();
                    if (withLinks && href) rawLinks.push({ text: txt, href });
                    return txt;
                  }
                  const inner = Array.from(node.childNodes)
                    .map((n) => (n.nodeType === 3 ? (n.textContent ?? "") : walk(n as Element)))
                    .join("");
                  return blockTags.has(node.tagName) ? "\n" + inner + "\n" : inner;
                };
                const text = walk(root)
                  .replace(/[^\S\n]+/g, " ")
                  .replace(/\n{3,}/g, "\n\n")
                  .trim();
                return { text, rawLinks };
              };
              return roots.map(collect);
            },
            { sel: selector ?? null, withLinks: includeLinks },
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
        const rawResult: SingleResult = await page.evaluate(extractPageContent, {
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
  );

  // fetch_urls ----------------------------------------------------------------
  server.tool(
    "fetch_urls",
    `Batch-fetch multiple URLs in parallel. Returns combined text for each URL. Ideal for research workflows instead of chaining new_tab + get_page_text.`,
    {
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
    },
    async ({ urls, extractContent = true, maxCharsPerPage = 3000 }) => {
      try {
        const results: string[] = [];
        // Open tab WITHOUT url (avoids leak if goto throws inside _doNewTab),
        // then navigate in our own try/finally where tabId is known.
        const fetchOne = async (url: string): Promise<string> => {
          const { tabId, page } = await mgr.newTab(undefined);
          try {
            await page.goto(url, { waitUntil: "domcontentloaded" });
            await globalWait(env);

            const title = await page.title().catch(() => "");

            const errorStatus = detectErrorPage(title);
            if (errorStatus) {
              return `## ${url}\n[HTTP ${errorStatus} — ${title}]`;
            }

            let text = "";
            if (extractContent) {
              const html = await page.content();
              const { document: dom } = parseHTML(html);
              const reader = new Readability(dom as any);
              const article = reader.parse();
              text = article
                ? (article.textContent ?? "")
                    .replace(/[^\S\n]+/g, " ")
                    .replace(/\n{3,}/g, "\n\n")
                    .trim()
                : "";
              if (article?.title && text) text = `# ${article.title}\n\n${text}`;
            }
            if (!text) {
              const result = await page.evaluate(extractPageContent, {
                selector: null,
                includeLinks: false,
                mode: "innerText" as const,
              });
              text = result.text;
            }

            if (maxCharsPerPage > 0 && text.length > maxCharsPerPage) {
              text =
                text.slice(0, maxCharsPerPage) +
                `\n[TRUNCATED — ${text.length.toLocaleString()} total]`;
            }
            return `## ${title || url}\nURL: ${url}\n\n${text}`;
          } finally {
            await mgr.closeTab(tabId).catch(() => {});
          }
        };

        const settled = await Promise.allSettled(urls.map(fetchOne));
        for (let i = 0; i < settled.length; i++) {
          const r = settled[i];
          if (r.status === "fulfilled") {
            results.push(r.value);
          } else {
            results.push(`## ${urls[i]}\n[ERROR: ${cleanErrorMessage(r.reason)}]`);
          }
        }

        return { content: [{ type: "text", text: results.join("\n\n---\n\n") }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(err) }] };
      }
    },
  );

  // get_links -----------------------------------------------------------------
  server.tool(
    "get_links",
    `Extract links from page as [{text, href}]. Deduped by href. Use urlPattern to filter.`,
    {
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
      tabId: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Optional tab ID. Omit to use the current active tab."),
    },
    async ({ selector, urlPattern, limit = 50, tabId }) => {
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
        const page = await mgr.getPage(tabId);
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
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  );

  // get_attrs -----------------------------------------------------------------
  server.tool(
    "get_attrs",
    `Extract specific attributes from matched elements as JSON array. Special attrs: "text" = innerText, "html" = outerHTML. Use for data-*, aria-*, src, alt, or structured data.`,
    {
      selector: z
        .string()
        .describe("CSS selector for elements to extract from (e.g. 'article', '.product-card')."),
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
      tabId: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Optional tab ID. Omit to use the current active tab."),
    },
    async ({ selector, attrs, limit = 50, tabId }) => {
      try {
        const page = await mgr.getPage(tabId);
        const results = await page.evaluate(
          ({ sel, attrNames }: { sel: string; attrNames: string[] }) => {
            const nodes = Array.from(document.querySelectorAll(sel));
            return nodes.map((el) => {
              const out: Record<string, string | null> = {};
              for (const name of attrNames) {
                if (name === "text") {
                  const raw = (el as HTMLElement).innerText ?? el.textContent ?? "";
                  out[name] = raw
                    .replace(/[^\S\n]+/g, " ")
                    .replace(/\n{3,}/g, "\n\n")
                    .trim();
                } else if (name === "html") {
                  out[name] = (el as HTMLElement).outerHTML ?? null;
                } else {
                  out[name] = (el as Element).getAttribute(name);
                }
              }
              return out;
            });
          },
          { sel: selector, attrNames: attrs },
        );

        const capped = limit > 0 ? results.slice(0, limit) : results;
        const truncated = capped.length < results.length;
        const body =
          capped.length === 0
            ? `[]\n(selector "${selector}" matched no elements)`
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
        };
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  );

  // evaluate ------------------------------------------------------------------
  server.tool(
    "evaluate",
    `Run JavaScript in the page and return the result as JSON. Escape hatch for anything other tools don't cover. With selector: expression gets \`el\` bound to first match (null if none). Must be an expression, not a statement — wrap multi-line in IIFE: (() => { ... })()`,
    {
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
      tabId: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Optional tab ID. Omit to use the current active tab."),
    },
    async ({
      expression,
      selector,
      maxChars = 10000,
      outputMode = "inline",
      outputPath,
      waitAfter = false,
      tabId,
    }) => {
      try {
        const page = await mgr.getPage(tabId);
        let result: unknown;
        if (selector) {
          const wrapped = `(function(){ const el = document.querySelector(${JSON.stringify(
            selector,
          )}); if (!el) return null; return (${expression}); })()`;
          result = await page.evaluate(wrapped);
        } else {
          result = await page.evaluate(expression);
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
  );

  // extract -------------------------------------------------------------------
  server.tool(
    "extract",
    `Declarative structured extraction. Pass a CSS selector and a field map — returns JSON array of objects. Replaces fragile evaluate() patterns for scraping.`,
    {
      selector: z
        .string()
        .describe("CSS selector for the repeating elements (e.g. '.product-card', 'tr.result')."),
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
      tabId: z.number().int().min(1).optional().describe("Optional tab ID."),
    },
    async ({ selector, fields, limit = 20, tabId }) => {
      try {
        const page = await mgr.getPage(tabId);

        // Evaluate in browser — returns raw array of record objects.
        // Playwright's evaluate() typing requires the arg object shape to be
        // declared in the function signature, not inferred.
        const evalArg = {
          sel: selector,
          fieldMap: fields as Record<string, string>,
          maxItems: limit,
        };
        const results: Array<Record<string, string | null>> = await page.evaluate((args) => {
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
        }, evalArg);

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `[]\n(selector "${selector}" matched no elements)` }],
          };
        }

        const json = "[\n" + results.map((r) => JSON.stringify(r)).join(",\n") + "\n]";
        return { content: [{ type: "text", text: json }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: cleanErrorMessage(err as Error) }],
        };
      }
    },
  );
}
