import { Transformer } from "@napi-rs/image";
import { z } from "zod";
import type { BrowserManager, Env } from "../manager.js";
import { writeToFile } from "../utils.js";
import { cleanErrorMessage } from "../helpers.js";
import { captureSnapshot, filterTree } from "../snapshot.js";
import type { ToolRegistrar } from "./shared.js";
import { tabTarget } from "./shared.js";

/**
 * Post-process a screenshot buffer: resize to fit within maxWidth/maxHeight
 * and/or compress to meet maxFileBytes. Uses @napi-rs/image (Rust-based,
 * no viewport mutation needed).
 */
async function constrainImage(
  buffer: Buffer,
  format: "png" | "jpeg" | "webp",
  opts: {
    maxWidth?: number;
    maxHeight?: number;
    maxFileBytes?: number;
    quality: number;
  },
): Promise<Buffer> {
  const { maxWidth, maxHeight, maxFileBytes, quality } = opts;
  const needsResize = maxWidth || maxHeight;
  const needsCompress = maxFileBytes && buffer.length > maxFileBytes;

  if (!needsResize && !needsCompress) return buffer;

  let t = new Transformer(buffer);

  // Resize if dimensions exceeded
  if (needsResize) {
    const meta = await new Transformer(buffer).metadata();
    const origW = meta.width;
    const origH = meta.height;
    if (origW > 0 && origH > 0) {
      const scaleW = maxWidth ? Math.min(1, maxWidth / origW) : 1;
      const scaleH = maxHeight ? Math.min(1, maxHeight / origH) : 1;
      const scale = Math.min(scaleW, scaleH);
      if (scale < 1) {
        const newW = Math.round(origW * scale);
        const newH = Math.round(origH * scale);
        t = t.resize(newW, newH);
      }
    }
  }

  // Encode to target format
  let result: Buffer;
  if (format === "webp") {
    result = await t.webp(quality);
  } else if (format === "jpeg") {
    result = await t.jpeg(quality);
  } else {
    result = await t.png();
  }

  // If still too large and format supports quality, step down quality
  if (maxFileBytes && result.length > maxFileBytes && format !== "png") {
    let retryQuality = Math.max(10, quality - 20);
    for (let attempt = 0; attempt < 3 && result.length > maxFileBytes; attempt++) {
      const rt = new Transformer(buffer); // re-process from original
      if (needsResize) {
        const meta = await new Transformer(buffer).metadata();
        const scaleW = maxWidth ? Math.min(1, maxWidth / meta.width) : 1;
        const scaleH = maxHeight ? Math.min(1, maxHeight / meta.height) : 1;
        const scale = Math.min(scaleW, scaleH);
        if (scale < 1) rt.resize(Math.round(meta.width * scale), Math.round(meta.height * scale));
      }
      result = format === "webp" ? await rt.webp(retryQuality) : await rt.jpeg(retryQuality);
      retryQuality = Math.max(10, retryQuality - 15);
    }
  }

  return result;
}

export function register(register: ToolRegistrar, mgr: BrowserManager, env: Env): void {
  // get_screenshot ------------------------------------------------------------
  register({
    name: "get_screenshot",
    title: "Take Screenshot",
    description: `Capture a screenshot of the current page or a specific element, saving to file by default (inline base64 auto-downgrades above MAX_INLINE_BYTES). Supports full-page, element-level, and clipped captures with post-capture resize/compression. Use to visually verify page state, inspect layout, or capture evidence. Do NOT use to read page content — use get_page_text for text extraction.

CONTEXT BUDGET — default file mode keeps context small. Inline base64 auto-downgrades above MAX_INLINE_BYTES.`,
    toolset: "media",
    inputSchema: {
      outputMode: z
        .enum(["inline", "file"])
        .default("file")
        .optional()
        .describe(
          "How to return the screenshot. 'file' (default) saves to disk and returns only the path — prevents base64 from bloating context. 'inline' returns base64 data (auto-downgrades to 'file' if too large).",
        ),
      outputPath: z
        .string()
        .optional()
        .describe(
          "File path when outputMode is 'file'. Defaults to OUTPUT_DIR/screenshot_{timestamp}.{format}.",
        ),
      format: z
        .enum(["png", "jpeg", "webp"])
        .default("webp")
        .optional()
        .describe(
          "Image format. 'webp' (default) = smallest files, requires Chromium ≥ 88 (uses CDP directly). 'jpeg' = smaller than PNG, widely supported. 'png' = lossless, largest.",
        ),
      quality: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe(
          "Quality 1–100. Used for 'jpeg' and 'webp'. Default: DEFAULT_SCREENSHOT_QUALITY env var (80). Ignored for 'png'.",
        ),
      fullPage: z
        .boolean()
        .default(false)
        .optional()
        .describe(
          "Capture full scrollable page (true) or visible viewport only (false). Default: false.",
        ),
      scale: z
        .number()
        .min(0.1)
        .max(3.0)
        .default(1.0)
        .optional()
        .describe(
          "Viewport scale factor applied before capture. Use 0.5 to halve dimensions and file size. Range: 0.1–3.0. Default: 1.0.",
        ),
      clip: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        })
        .optional()
        .describe(
          "Capture only a rectangular region of the page. Optional. Mutually exclusive with `selector`.",
        ),
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector for a single element to screenshot. If set, captures just that element's bounding box — tighter output than fullPage + clip math. Mutually exclusive with `clip`.",
        ),
      maxWidth: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Max width in pixels. If the captured image is wider, it will be auto-scaled down (preserving aspect ratio). Applied via viewport scaling before capture.",
        ),
      maxHeight: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Max height in pixels. If the captured image is taller, it will be auto-scaled down (preserving aspect ratio). Applied via viewport scaling before capture.",
        ),
      maxFileBytes: z
        .number()
        .int()
        .min(1024)
        .optional()
        .describe(
          "Max file size in bytes. If exceeded, re-captures at progressively lower quality (jpeg/webp) or scale. Useful for keeping screenshots compact.",
        ),
      maxInlineBytes: z
        .number()
        .optional()
        .describe(
          "Max bytes before auto-switching to file mode. Default: MAX_INLINE_BYTES env var (512000). Set lower to protect context budget.",
        ),
      annotate: z
        .boolean()
        .optional()
        .describe(
          "Overlay numbered labels on interactive elements and return a number→ref/coordinate map. When true, labels are drawn onto the screenshot so you can correlate visual position to actionable targets (refs usable by click/click_at). The returned marks array maps number→{ref, x, y} (centre coordinates).",
        ),
      ...tabTarget,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async ({
      outputMode = "file",
      outputPath,
      format = "webp",
      quality,
      fullPage = false,
      scale = 1.0,
      clip,
      selector,
      maxWidth,
      maxHeight,
      maxFileBytes,
      maxInlineBytes,
      annotate,
      tabId,
      owner,
    }) => {
      try {
        if (clip && selector) {
          return {
            isError: true,
            content: [{ type: "text", text: "Pass either `clip` or `selector`, not both." }],
          };
        }
        if (clip) {
          const MAX_DIM = 16384;
          const issues: string[] = [];
          if (clip.width <= 0 || clip.height <= 0) {
            issues.push(`width/height must be > 0 (got ${clip.width}×${clip.height})`);
          }
          if (clip.width > MAX_DIM || clip.height > MAX_DIM) {
            issues.push(`width/height must be ≤ ${MAX_DIM} (got ${clip.width}×${clip.height})`);
          }
          if (clip.x < 0 || clip.y < 0) {
            issues.push(`x/y must be ≥ 0 (got ${clip.x},${clip.y})`);
          }
          if (issues.length > 0) {
            return {
              isError: true,
              content: [{ type: "text", text: `Invalid clip region: ${issues.join("; ")}` }],
            };
          }
        }
        const page = await mgr.getPage({ tabId, owner });
        const resolvedTabId = mgr.resolveTab({ tabId, owner });
        const effectiveQuality = quality ?? env.DEFAULT_SCREENSHOT_QUALITY;

        // Annotate — overlay numbered labels on interactive elements and return
        // a marks map so the agent can correlate visual position to refs.
        let marks: Array<{ n: number; ref: string; x: number; y: number }> | undefined;
        let annotateNote = "";
        if (annotate) {
          try {
            const snap = await captureSnapshot(page, resolvedTabId, {
              noTruncate: true,
            });
            const interactive = filterTree(snap.text, "interactive");
            // Extract all @eN refs from interactive lines.
            const refRe = /@e\d+/g;
            const refs = [...new Set(interactive.match(refRe) ?? [])];

            // Cap at MAX_MARKS to avoid N serial CDP round-trips on pages with
            // hundreds of interactive elements. Resolve boundingBoxes in parallel.
            const MAX_MARKS = 50;
            const refsToMark = refs.slice(0, MAX_MARKS);

            const resolved = await Promise.all(
              refsToMark.map(async (ref) => {
                const box = await page
                  .locator(`aria-ref=${ref.slice(1)}`)
                  .boundingBox()
                  .catch(() => null);
                return box ? { ref: ref.slice(1), box } : null;
              }),
            );

            const withBoxes = resolved.filter(
              (
                r,
              ): r is {
                ref: string;
                box: { x: number; y: number; width: number; height: number };
              } => r !== null,
            );

            const boxes = withBoxes.map((r, i) => ({
              n: i + 1,
              ref: r.ref,
              x: r.box.x,
              y: r.box.y,
              w: r.box.width,
              h: r.box.height,
            }));

            if (refs.length > MAX_MARKS) {
              annotateNote = ` (marked first ${MAX_MARKS} of ${refs.length} interactive elements)`;
            }

            marks = boxes.map((b) => ({
              n: b.n,
              ref: b.ref,
              x: b.x + b.w / 2,
              y: b.y + b.h / 2,
            }));

            // Inject labels — data passed as ARGUMENT (browser-isolate safe).
            // Each mark draws a red border + number badge via fixed-position divs.
            await page.evaluate(
              (items: Array<{ n: number; x: number; y: number; w: number; h: number }>) => {
                const layer = document.createElement("div");
                layer.id = "__mcp_marks";
                layer.style.cssText =
                  "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
                for (const m of items) {
                  const b = document.createElement("div");
                  b.style.cssText = `position:fixed;left:${m.x}px;top:${m.y}px;width:${m.w}px;height:${m.h}px;border:2px solid #e11;box-sizing:border-box`;
                  const lab = document.createElement("div");
                  lab.textContent = String(m.n);
                  lab.style.cssText = `position:fixed;left:${m.x}px;top:${Math.max(0, m.y - 14)}px;background:#e11;color:#fff;font:12px/14px monospace;padding:0 3px`;
                  layer.appendChild(b);
                  layer.appendChild(lab);
                }
                document.body.appendChild(layer);
              },
              boxes.map(({ n, x, y, w, h }) => ({ n, x, y, w, h })),
            );
          } catch {
            // Annotate is best-effort — silently skip on failure.
            marks = undefined;
          }
        }
        const effectiveMaxInlineBytes = maxInlineBytes ?? env.MAX_INLINE_BYTES;

        const origVp = page.viewportSize() ?? {
          width: env.DEFAULT_VIEWPORT_WIDTH,
          height: env.DEFAULT_VIEWPORT_HEIGHT,
        };

        let buffer: Buffer;
        try {
          // Apply explicit scale param (viewport-level, before capture)
          if (scale !== 1.0) {
            await page.setViewportSize({
              width: Math.round(origVp.width * scale),
              height: Math.round(origVp.height * scale),
            });
          }
          if (format === "webp") {
            const client = await page.context().newCDPSession(page);
            const cdpArgs: {
              format: "png" | "jpeg" | "webp";
              quality: number;
              captureBeyondViewport?: boolean;
              clip?: { x: number; y: number; width: number; height: number; scale: number };
            } = { format: "webp", quality: effectiveQuality };
            if (fullPage) cdpArgs.captureBeyondViewport = true;
            if (selector) {
              const locator = page.locator(selector).first();
              const count = await locator.count();
              if (count === 0) {
                return {
                  isError: true,
                  content: [{ type: "text", text: `selector "${selector}" matched no elements.` }],
                };
              }
              const box = await locator.boundingBox();
              if (!box) {
                return {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: `selector "${selector}" has no layout box (display:none?).`,
                    },
                  ],
                };
              }
              cdpArgs.clip = { ...box, scale: 1 };
            } else if (clip) {
              cdpArgs.clip = { ...clip, scale: 1 };
            }
            const { data } = await client.send("Page.captureScreenshot", cdpArgs);
            buffer = Buffer.from(data, "base64");
            await client.detach().catch(() => {});
          } else if (selector) {
            const locator = page.locator(selector).first();
            const count = await locator.count();
            if (count === 0) {
              return {
                isError: true,
                content: [{ type: "text", text: `selector "${selector}" matched no elements.` }],
              };
            }
            const elOpts: Parameters<typeof locator.screenshot>[0] = { type: format };
            if (format === "jpeg") elOpts.quality = effectiveQuality;
            buffer = await locator.screenshot(elOpts);
          } else {
            const opts: Parameters<typeof page.screenshot>[0] = { type: format, fullPage };
            if (format === "jpeg") opts.quality = effectiveQuality;
            if (clip) opts.clip = clip;
            buffer = await page.screenshot(opts);
          }
        } finally {
          if (scale !== 1.0) {
            await page.setViewportSize(origVp).catch(() => {});
          }
          // Remove annotate overlay, if any.
          if (annotate) {
            await page.evaluate(() => document.getElementById("__mcp_marks")?.remove());
          }
        }

        // Post-capture: resize + compress via @napi-rs/image (no viewport mutation)
        if (maxWidth || maxHeight || maxFileBytes) {
          buffer = await constrainImage(buffer, format, {
            maxWidth,
            maxHeight,
            maxFileBytes,
            quality: effectiveQuality,
          });
        }

        const effectiveMode =
          outputMode === "inline" && buffer.length > effectiveMaxInlineBytes ? "file" : outputMode;

        if (effectiveMode === "file") {
          const defaultName = `screenshot_${Date.now()}.${format}`;
          const filePath = await writeToFile(buffer, defaultName, env, outputPath);
          const autoNote =
            outputMode === "inline"
              ? `\n(Auto-switched to file mode: output exceeded ${effectiveMaxInlineBytes.toLocaleString()} bytes)`
              : "";
          const result: any = {
            content: [
              {
                type: "text",
                text: `Screenshot saved to: ${filePath}\nSize: ${buffer.length.toLocaleString()} bytes${annotateNote}${autoNote}`,
              },
            ],
          };
          if (marks && marks.length > 0) {
            result.structuredContent = { marks };
          }
          return result;
        }

        const result: any = {
          content: [
            { type: "text", text: `Screenshot taken.${annotateNote}` },
            {
              type: "image",
              data: buffer.toString("base64"),
              mimeType: `image/${format}`,
            },
          ],
        };
        if (marks && marks.length > 0) {
          result.structuredContent = { marks };
        }
        return result;
      } catch (err) {
        const error = err as Error;
        return { isError: true, content: [{ type: "text", text: cleanErrorMessage(error) }] };
      }
    },
  });
}
