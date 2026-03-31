# Steel MCP Server — Customisation Spec

**Repo to fork:** https://github.com/steel-dev/steel-mcp-server  
**Purpose:** Customise for local/self-hosted Steel Browser with better tooling for AI assistant contexts — specifically: context-budget awareness, configurable data limits, and output routing (inline vs file vs URL).

---

## Core Design Principles

### 1. Context Budget Awareness

Screenshots and page text can be enormous. Agents should never be forced to load large binary/text blobs into their context window when they don't need to. Every tool that produces large output should support an `outputMode` parameter:

| `outputMode` | Behaviour |
|---|---|
| `"inline"` | Return data directly in MCP response (default for small outputs) |
| `"file"` | Save to a local file path and return only the path |
| `"url"` | Upload/serve and return a URL (future) |

Default behaviour: if the output exceeds a size threshold, automatically fall back to `"file"` mode and warn the agent.

### 2. Configurable Data Limits

Every tool should expose explicit knobs so the agent can request exactly what it needs:
- Image: quality, scale, viewport size, full-page vs viewport-only, format
- Text: max characters, CSS selector scoping, strip/keep whitespace

### 3. Graceful Degradation

If inline output would exceed `maxInlineBytes` (default: 500KB), automatically save to file and return the path instead, with a note in the text content explaining what happened.

---

## Environment Variables (server-level config)

Add these to control global defaults without code changes:

| Variable | Default | Description |
|---|---|---|
| `STEEL_LOCAL` | `"false"` | `"true"` for self-hosted Steel |
| `STEEL_BASE_URL` | `localhost:3000` (local) or `api.steel.dev` | Steel API base URL |
| `STEEL_API_KEY` | *(optional in local mode)* | API key (not needed for local) |
| `GLOBAL_WAIT_SECONDS` | `2` | Default post-action wait |
| `MAX_INLINE_BYTES` | `512000` (500KB) | Max bytes before auto-falling back to file output |
| `DEFAULT_SCREENSHOT_QUALITY` | `80` | JPEG quality 1–100 (PNG ignores this) |
| `DEFAULT_VIEWPORT_WIDTH` | `1280` | Viewport width in px |
| `DEFAULT_VIEWPORT_HEIGHT` | `720` | Viewport height in px |
| `OUTPUT_DIR` | `/tmp/steel-mcp` | Directory for file-mode outputs |

---

## Required Changes

---

### 1. New tool: `screenshot`

Returns a screenshot with full control over format, size, and output routing.

```typescript
{
  name: "screenshot",
  description: `Capture a screenshot of the current page.

OUTPUT MODES — use 'outputMode' to control context budget:
- "inline": Returns base64 image data directly in the response. Fine for small/compressed screenshots. Will auto-downgrade to "file" if output exceeds maxInlineBytes.
- "file": Saves PNG to disk and returns only the file path. Use this when you will upload the file separately (e.g. to Discord) rather than reading the image into context.

REDUCING SIZE — for large pages, use scale < 1.0, jpeg format, lower quality, or viewport-only (fullPage: false).`,

  inputSchema: {
    type: "object",
    properties: {
      outputMode: {
        type: "string",
        enum: ["inline", "file"],
        description: "How to return the screenshot. Use 'file' to avoid loading image data into agent context. Default: 'inline' (auto-downgrades to 'file' if too large).",
        default: "inline",
      },
      outputPath: {
        type: "string",
        description: "File path to save the screenshot when outputMode is 'file'. Defaults to OUTPUT_DIR/screenshot_{timestamp}.png.",
      },
      format: {
        type: "string",
        enum: ["png", "jpeg"],
        description: "Image format. JPEG produces smaller files (use with quality). Default: 'png'.",
        default: "png",
      },
      quality: {
        type: "number",
        description: "JPEG quality 1–100. Only used when format is 'jpeg'. Default: 80.",
        minimum: 1,
        maximum: 100,
        default: 80,
      },
      fullPage: {
        type: "boolean",
        description: "Capture the full scrollable page (true) or just the visible viewport (false). Full page can be very large. Default: false.",
        default: false,
      },
      scale: {
        type: "number",
        description: "Device scale factor. Use 0.5 to halve resolution and file size. Range: 0.1–3.0. Default: 1.0.",
        minimum: 0.1,
        maximum: 3.0,
        default: 1.0,
      },
      clip: {
        type: "object",
        description: "Capture only a region of the page. Optional.",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
        },
        required: ["x", "y", "width", "height"],
      },
      maxInlineBytes: {
        type: "number",
        description: "Max bytes before auto-switching to file mode. Default: 512000 (500KB). Set lower to protect context budget.",
        default: 512000,
      },
    },
    required: [],
  },
}
```

**Handler logic:**

```typescript
case "screenshot": {
  const {
    outputMode = "inline",
    outputPath,
    format = "png",
    quality = 80,
    fullPage = false,
    scale = 1.0,
    clip,
    maxInlineBytes = parseInt(process.env.MAX_INLINE_BYTES ?? "512000"),
  } = args as any;

  // Remove visual overlays
  await page.evaluate(() => {
    document.querySelectorAll("[data-label]").forEach((el) => el.remove());
  });

  // Apply scale via viewport
  const vp = page.viewport() ?? { width: 1280, height: 720 };
  await page.setViewport({ ...vp, deviceScaleFactor: scale });

  const screenshotOpts: any = { type: format, fullPage };
  if (format === "jpeg") screenshotOpts.quality = quality;
  if (clip) screenshotOpts.clip = clip;

  const buffer = await page.screenshot(screenshotOpts) as Buffer;

  // Restore default viewport
  await page.setViewport({ ...vp, deviceScaleFactor: 1 });

  // Determine output mode (auto-downgrade if too large)
  const effectiveMode =
    outputMode === "inline" && buffer.length > maxInlineBytes ? "file" : outputMode;

  if (effectiveMode === "file") {
    const dir = process.env.OUTPUT_DIR ?? "/tmp/steel-mcp";
    await fs.mkdir(dir, { recursive: true });
    const filePath = outputPath ?? path.join(dir, `screenshot_${Date.now()}.${format}`);
    await fs.writeFile(filePath, buffer);
    return {
      content: [
        {
          type: "text",
          text: `Screenshot saved to file: ${filePath}\nSize: ${buffer.length.toLocaleString()} bytes\n\n` +
            (outputMode === "inline" ? `(Auto-switched to file mode: output exceeded ${maxInlineBytes.toLocaleString()} bytes)` : ""),
        },
      ],
    };
  }

  // Inline mode
  return {
    content: [
      {
        type: "image",
        data: buffer.toString("base64"),
        mimeType: `image/${format}`,
      },
    ],
  };
}
```

---

### 2. New tool: `get_page_text`

Returns visible page text with selector scoping and length limits.

```typescript
{
  name: "get_page_text",
  description: `Get visible text content from the current page.

CONTEXT BUDGET — use 'maxChars' to limit how much text is loaded into context. For large pages, use a CSS selector to scope to the relevant section only.

Use 'outputMode: "file"' to save the full text to disk without loading it into context at all.`,

  inputSchema: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector to scope extraction (e.g. 'article', 'main', '#content'). Defaults to document.body.",
      },
      maxChars: {
        type: "number",
        description: "Maximum characters to return. Truncates with a notice. Default: 10000. Set to 0 for no limit (use with outputMode: 'file').",
        default: 10000,
      },
      outputMode: {
        type: "string",
        enum: ["inline", "file"],
        description: "Return text inline (default) or save to file and return path. Use 'file' to avoid loading large text into context.",
        default: "inline",
      },
      outputPath: {
        type: "string",
        description: "File path when outputMode is 'file'. Defaults to OUTPUT_DIR/page_text_{timestamp}.txt.",
      },
      includeLinks: {
        type: "boolean",
        description: "Include link text with URLs appended in brackets. Default: false.",
        default: false,
      },
    },
    required: [],
  },
}
```

**Handler logic:**

```typescript
case "get_page_text": {
  const {
    selector,
    maxChars = 10000,
    outputMode = "inline",
    outputPath,
    includeLinks = false,
  } = args as any;

  let text: string;

  if (includeLinks) {
    text = await page.evaluate((sel) => {
      const root = sel ? document.querySelector(sel) : document.body;
      if (!root) return "";
      const walk = (node: Element): string => {
        if (node.tagName === "A") {
          const href = (node as HTMLAnchorElement).href;
          return `${node.textContent?.trim()} [${href}]`;
        }
        return Array.from(node.childNodes).map((n) =>
          n.nodeType === 3 ? n.textContent ?? "" : walk(n as Element)
        ).join(" ");
      };
      return walk(root);
    }, selector ?? null);
  } else {
    text = await page.evaluate((sel) => {
      const root = sel ? document.querySelector(sel) : document.body;
      return root?.innerText ?? "";
    }, selector ?? null);
  }

  text = text.replace(/\s+/g, " ").trim();

  if (outputMode === "file") {
    const dir = process.env.OUTPUT_DIR ?? "/tmp/steel-mcp";
    await fs.mkdir(dir, { recursive: true });
    const filePath = outputPath ?? path.join(dir, `page_text_${Date.now()}.txt`);
    await fs.writeFile(filePath, text, "utf8");
    return {
      content: [{ type: "text", text: `Page text saved to: ${filePath}\nTotal chars: ${text.length.toLocaleString()}` }],
    };
  }

  const truncated = maxChars > 0 && text.length > maxChars;
  const output = truncated ? text.slice(0, maxChars) : text;

  return {
    content: [
      {
        type: "text",
        text: output + (truncated ? `\n\n[TRUNCATED — ${text.length.toLocaleString()} total chars, showing first ${maxChars.toLocaleString()}. Use maxChars: 0 with outputMode: "file" to get full content.]` : ""),
      },
    ],
  };
}
```

---

### 3. Fix `save_unmarked_screenshot` — return base64 inline

Currently returns only a resource URI. Add inline base64 image to the response so agents can actually see the screenshot.

```typescript
// In the save_unmarked_screenshot handler, after: const buffer = await page.screenshot();
return {
  content: [
    {
      type: "text",
      text: `Screenshot saved as resource: screenshot://${resourceName}`,
    },
    {
      type: "image",
      data: (buffer as Buffer).toString("base64"),
      mimeType: "image/png",
    },
  ],
};
```

---

### 4. Fix Steel SDK — no crash without `STEEL_API_KEY` in local mode

```typescript
// In src/index.ts, replace the Steel client initialisation:
const steelConfig: ConstructorParameters<typeof Steel>[0] = {
  baseURL: steelBaseURL,
  steelAPIKey: steelKey ?? (steelLocal ? "local" : undefined),
};

if (!steelKey && !steelLocal) {
  throw new Error("STEEL_API_KEY is required when STEEL_LOCAL is not 'true'");
}

const steel = new Steel(steelConfig);
```

---

### 5. Fix default `STEEL_BASE_URL` for local mode

```typescript
// In src/index.ts:
const steelBaseURL =
  process.env.STEEL_BASE_URL ??
  (steelLocal ? "http://localhost:3000" : "https://api.steel.dev");
```

---

### 6. Update tool descriptions with agent guidance

Every tool description should include a **"CONTEXT BUDGET"** section explaining:
- When to use `outputMode: "file"` (large outputs, passing to a pipeline, uploading elsewhere)
- When `inline` is appropriate (small, needs immediate visual inspection)
- How to scope requests to avoid bloated responses

Example pattern to follow for all tools:
```
CONTEXT BUDGET — [one sentence about output size risk].
Use 'outputMode: "file"' when [condition]. Use 'inline' when [condition].
Reduce output size by [specific parameter advice].
```

---

## Build Instructions

```bash
# Install deps (if not already done)
npm install

# Add required Node.js imports at top of src/index.ts:
import fs from "fs/promises";
import path from "path";

# Build
npm run build

# Test with local Steel
STEEL_LOCAL=true STEEL_BASE_URL=http://10.1.1.1:3000 node dist/index.js
```

---

## mcporter config

```json
"steel": {
  "command": "node",
  "args": ["/path/to/forked-steel-mcp-server/dist/index.js"],
  "env": {
    "STEEL_LOCAL": "true",
    "STEEL_BASE_URL": "http://10.1.1.1:3000",
    "GLOBAL_WAIT_SECONDS": "2",
    "MAX_INLINE_BYTES": "512000",
    "OUTPUT_DIR": "/home/openclaw/.openclaw/workspace/steel-output"
  }
}
```

---

## Summary of Changes

| # | Tool / Area | Type | Description |
|---|---|---|---|
| 1 | `screenshot` | NEW | Returns PNG/JPEG with full control: format, quality, scale, clip, full-page, inline vs file output |
| 2 | `get_page_text` | NEW | Returns page text with selector scoping, maxChars limit, inline vs file output |
| 3 | `save_unmarked_screenshot` | MODIFIED | Also returns base64 inline (not just resource URI) |
| 4 | Steel SDK init | FIXED | No crash when `STEEL_API_KEY` missing in local mode |
| 5 | `STEEL_BASE_URL` default | FIXED | Defaults to `localhost:3000` when `STEEL_LOCAL=true` |
| 6 | All tool descriptions | MODIFIED | Add "CONTEXT BUDGET" guidance sections |
| — | New env vars | NEW | `MAX_INLINE_BYTES`, `OUTPUT_DIR`, `DEFAULT_SCREENSHOT_QUALITY`, `DEFAULT_VIEWPORT_WIDTH/HEIGHT` |
