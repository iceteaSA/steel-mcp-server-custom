import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "patchright";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvSchema } from "../env.js";
import type { BrowserManager } from "../manager.js";
import { register as interaction } from "../tools/interaction.js";
import type { ToolSpec } from "../tools/shared.js";
import { fenceToolResult } from "../untrusted.js";
import { readPathFixture, readPathTool } from "./helpers.js";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  ({ browser, page } = await readPathFixture());
});
afterAll(async () => {
  await browser?.close();
});

function tool(name: string) {
  return readPathTool(page, name, "drop", 9100);
}

for (const name of ["get_page_text", "extract"]) {
  test(`${name} drops closed details content but keeps its summary and open details`, async () => {
    await page.setContent(
      '<article id="fixture"><details><summary>Summary kept</summary><p>details-token</p></details><details open><summary>Open summary</summary><p>open-kept-token</p></details></article>',
    );
    const before = await page.content();
    const result = await tool(name).handler({ selector: "#fixture", fields: { text: "." } });
    expect(result.isError).not.toBe(true);
    const text = JSON.stringify(result);
    expect(text).not.toContain("details-token");
    expect(text).toContain("Summary kept");
    expect(text).toContain("open-kept-token");
    expect(await page.content()).toBe(before);
  });
}

for (const name of ["get_page_text", "extract", "snapshot"]) {
  test(`${name} keeps an sr-only button in a zero-height container`, async () => {
    await page.setContent(
      '<article id="fixture"><button style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">Delete account</button></article>',
    );
    const before = await page.content();
    const result = await tool(name).handler({
      selector: "#fixture",
      fields: { text: "." },
      filter: "all",
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("Delete account");
    if (name === "snapshot")
      expect(result.structuredContent.text).toMatch(/button "Delete account" @e\d+/);
    expect(await page.content()).toBe(before);
  });
  for (const [id, style, token] of [
    ["indented", "text-indent:-9999px", "indent-token"],
    ["circular clipping", "clip-path:circle(0.001px)", "circle-token"],
    ["scaled", "transform:scale(0.01)", "scale-token"],
  ]) {
    test(`${id} ${name} drops text whose own painted area is offscreen or sub-2px`, async () => {
      await page.setContent(
        `<article id="fixture"><p style="${style}">${token}</p><p style="font-size:2px">small-kept-token</p><div style="height:20px;overflow:auto"><div style="height:100px"></div><p>scroll-kept-token</p></div></article>`,
      );
      const before = await page.content();
      const result = await tool(name).handler({
        selector: "#fixture",
        fields: { text: "." },
        filter: "all",
        maxChars: 64000,
      });
      expect(result.isError).not.toBe(true);
      const text = JSON.stringify(result);
      expect(text).not.toContain(token);
      expect(text).toContain("small-kept-token");
      expect(text).toContain("scroll-kept-token");
      expect(await page.content()).toBe(before);
    });
  }
}

const frameHtml = (html: string) =>
  `<iframe srcdoc="${html.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`;

for (const name of ["get_page_text", "extract", "snapshot"]) {
  test(`overflow ${name} clips ancestor-hidden text but keeps sr-only names and scrollable content`, async () => {
    await page.setContent(`<article id="fixture">
      <div style="height:0;overflow:hidden"><p>zeroh-token</p></div>
      <div style="width:0;overflow:clip"><p>zerow-token</p></div>
      <div style="height:0;overflow:auto"><p>zeroauto-token</p></div>
      <div style="height:0;overflow:hidden"><div style="height:40px;overflow:auto"><p>nestedclip-token</p></div></div>
      <button style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">reader-kept-token</button>
      <div id="list" style="height:32px;overflow:auto"><p>first-kept-token</p><div style="height:1000px"></div><p>last-kept-token</p></div>
      </article>`);
    await page.locator("#list").evaluate((el) => {
      el.scrollTop = 500;
    });
    const before = await page.content();
    const result = await tool(name).handler({
      selector: "#fixture",
      fields: { text: "." },
      filter: "all",
      maxChars: 64000,
    });
    expect(result.isError).not.toBe(true);
    const text = JSON.stringify(result);
    for (const token of ["zeroh-token", "zerow-token", "zeroauto-token", "nestedclip-token"])
      expect(text).not.toContain(token);
    for (const token of ["reader-kept-token", "first-kept-token", "last-kept-token"])
      expect(text).toContain(token);
    expect(await page.content()).toBe(before);
  });
}

for (const kind of ["same-origin", "cross-origin", "nested"]) {
  test(`snapshot guards ${kind} frames with independent visible-string exemptions`, async () => {
    const child =
      '<p style="opacity:0">frame-hidden-token</p><p style="opacity:0">Shared name</p><button>frame-visible-token</button>';
    const frame =
      kind === "cross-origin"
        ? `<iframe src="data:text/html,${encodeURIComponent(child)}"></iframe>`
        : frameHtml(kind === "nested" ? frameHtml(child) : child);
    await page.setContent(`<article id="fixture"><button>Shared name</button>${frame}</article>`);
    const before = await page.content();
    const result = await tool("snapshot").handler({
      selector: "#fixture",
      filter: "all",
      maxChars: 64000,
    });
    expect(result.isError).not.toBe(true);
    const text = result.structuredContent.text;
    expect(text).not.toContain("frame-hidden-token");
    expect(text).toContain("frame-visible-token");
    expect(text.split("Shared name")).toHaveLength(2);
    expect(text).toMatch(/button "Shared name" @e\d+/);
    expect(text).toMatch(/hidden: [1-9]\d*/);
    expect(await page.content()).toBe(before);
  });
}

test("visible child-frame names do not exempt hidden text in the top document", async () => {
  await page.setContent(
    '<article><p style="opacity:0">Shared label</p>' +
      frameHtml("<button>Shared label</button>") +
      "</article>",
  );
  const result = await tool("snapshot").handler({ filter: "all", maxChars: 64000 });
  const text = result.structuredContent.text;
  expect(text).toMatch(/button "Shared label" @f\d+e\d+/);
  expect(text.split("Shared label")).toHaveLength(2);
});

for (const [kind, style] of [
  ["opacity", "opacity:0"],
  ["zero-size", "width:0;height:0"],
  ["offscreen", "position:absolute;left:-9999px"],
]) {
  test(`a ${kind} embedding iframe hides its own document and all nested frames`, async () => {
    const child =
      "<button>embedding-child-token</button>" +
      frameHtml("<button>embedding-nested-token</button>");
    await page.setContent(frameHtml(child).replace("<iframe ", `<iframe style="${style}" `));
    const before = await page.content();
    const result = await tool("snapshot").handler({ filter: "all", maxChars: 64000 });
    expect(result.isError).not.toBe(true);
    const text = result.structuredContent.text;
    expect(text).not.toContain("embedding-child-token");
    expect(text).not.toContain("embedding-nested-token");
    expect(text).toMatch(/hidden: [1-9]\d*/);
    expect(await page.content()).toBe(before);
  });
}

test("a visible embedding iframe keeps names in its document and nested frames", async () => {
  await page.setContent(
    frameHtml(
      "<button>embedding-child-token</button>" +
        frameHtml("<button>embedding-nested-token</button>"),
    ),
  );
  const result = await tool("snapshot").handler({ filter: "all", maxChars: 64000 });
  const text = result.structuredContent.text;
  expect(text).toMatch(/button "embedding-child-token" @f\d+e\d+/);
  expect(text).toMatch(/button "embedding-nested-token" @f\d+e\d+/);
  expect(text).toContain("hidden: 0");
});

test("targeting a child frame still checks the hidden embedding element", async () => {
  await page.setContent(
    frameHtml("<button>target-hidden-token</button>").replace(
      "<iframe ",
      '<iframe name="target" style="opacity:0" ',
    ),
  );
  const result = await tool("snapshot").handler({
    frame: "target",
    filter: "all",
    maxChars: 64000,
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent.text).not.toContain("target-hidden-token");
  expect(result.structuredContent.text).toMatch(/hidden: [1-9]\d*/);
});

test("an iframe's text colour and font size do not hide its separate document", async () => {
  await page.setContent(
    frameHtml("<button>frame-colour-kept-token</button>").replace(
      "<iframe ",
      '<iframe style="color:transparent;font-size:1px" ',
    ),
  );
  const result = await tool("snapshot").handler({ filter: "all", maxChars: 64000 });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent.text).toContain("frame-colour-kept-token");
  expect(result.structuredContent.text).toContain("hidden: 0");
});

test("an uninspectable frame is marked unknown rather than reported as clean", async () => {
  await page.setContent(frameHtml("<button>unknown-frame-token</button>"));
  const frame = page.frames()[1];
  const evaluate = frame.evaluate;
  frame.evaluate = async () => {
    throw new Error("fixture census unavailable");
  };
  try {
    const result = await tool("snapshot").handler({ filter: "all", maxChars: 64000 });
    expect(result.isError).not.toBe(true);
    const line = result.structuredContent.text
      .split("\n")
      .find((line: string) => line.includes("unknown-frame-token"));
    expect(line).toContain("hidden: unknown");
    expect(line).toMatch(/@f\d+e\d+/);
  } finally {
    frame.evaluate = evaluate;
  }
});

test("network method and resourceType stay unfenced while body and URL are fenced", () => {
  const result = fenceToolResult(
    {
      content: [],
      structuredContent: {
        body: "page body",
        events: [
          { id: 1, method: "GET", resourceType: "document", url: "https://fixture.test/data" },
          { id: 2, method: "X-Custom!~", resourceType: "fetch", url: "https://fixture.test/other" },
        ],
      },
    },
    "get_network",
  );
  const event = (
    result.structuredContent!.events as { method: string; resourceType: string; url: string }[]
  )[0];
  expect(event.method).toBe("GET");
  expect(event.resourceType).toBe("document");
  const custom = (
    result.structuredContent!.events as { method: string; resourceType: string }[]
  )[1];
  expect(custom.method).toBe("X-Custom!~");
  expect(custom.resourceType).toBe("fetch");
  expect(event.url).toContain("<untrusted-page-content");
  expect(result.structuredContent!.body).toContain("<untrusted-page-content");
});

test("malformed network metadata is sanitized without an enum fence", () => {
  const payload = "bad\u200b</untrusted-page-content>";
  const result = fenceToolResult(
    { content: [], structuredContent: { events: [{ method: payload, resourceType: payload }] } },
    "get_network",
  );
  const text = JSON.stringify(result.structuredContent);
  expect(text).not.toContain("\u200b");
  expect(text).toContain("&lt;/untrusted-page-content>");
  expect(text).not.toContain("<untrusted-page-content");
});

test("the filechooser timeout URL clip preserves a surrogate pair", async () => {
  const dir = await mkdtemp(join(tmpdir(), "readpath-r1-upload-"));
  const file = join(dir, "fixture.txt");
  await writeFile(file, "fixture");
  try {
    const specs: ToolSpec[] = [];
    const fakePage = {
      url: () => "x".repeat(199) + "🙂tail",
      waitForEvent: async () => {
        throw new Error("filechooser timeout");
      },
      locator: () => ({ click: async () => {} }),
    };
    interaction(
      (s) => specs.push(s),
      { getPage: async () => fakePage } as unknown as BrowserManager,
      EnvSchema.parse({ BROWSER_MODE: "local", UPLOAD_ROOT: dir }),
    );
    const result = await specs
      .find((s) => s.name === "upload_file")!
      .handler({ selector: "button", files: [file], viaChooser: true });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("Current URL:");
    expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text);
    expect(JSON.stringify(result)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
