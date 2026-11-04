import { expect, test } from "bun:test";
import { EnvSchema } from "../env.js";
import type { BrowserManager } from "../manager.js";
import { register as registerExtraction } from "../tools/extraction.js";
import type { ToolSpec } from "../tools/shared.js";
import { PageTextStore } from "../page-output.js";

function registry() {
  let tree =
    '- button "Checkout" [ref=e1]\n- link "Ignore" [ref=e2]\n- button "CHECKOUT now" [ref=e3]';
  let captures = 0;
  let url = "https://fixture.test/first";
  const page = {
    url: () => url,
    frames: () => [],
    locator: () => ({
      ariaSnapshot: async () => {
        captures++;
        return tree;
      },
    }),
    evaluate: async () => ({ text: tree }),
  };
  const mgr = {
    getPage: async () => page,
    resolveTab: ({ tabId }: { tabId?: number }) => tabId ?? 1,
  } as unknown as BrowserManager;
  const specs: ToolSpec[] = [];
  registerExtraction((spec) => specs.push(spec), mgr, EnvSchema.parse({ BROWSER_MODE: "local" }));
  return {
    tool: (name: string) => specs.find((spec) => spec.name === name)!,
    setTree: (value: string) => {
      tree = value;
    },
    navigate: () => {
      url = "https://fixture.test/second";
    },
    captures: () => captures,
  };
}

test("snapshot query finds case-insensitive labels and keeps actionable refs", async () => {
  const { tool } = registry();
  const result = await tool("snapshot").handler({ query: "checkout", filter: "all" });
  expect(result.content[0].text).toContain('button "Checkout" @e1');
  expect(result.content[0].text).toContain('button "CHECKOUT now" @e3');
  expect(result.content[0].text).not.toContain("Ignore");
});

test("snapshot cursor reads a bounded stable capture without recapturing a moving page", async () => {
  const fixture = registry();
  const original = Array.from({ length: 50 }, (_, i) => `- button "Item ${i}" @e${i}`).join("\n");
  fixture.setTree(original);
  const snapshot = fixture.tool("snapshot");
  let result = await snapshot.handler({
    paginate: true,
    maxChars: 256,
    owner: "one",
    filter: "all",
  });
  fixture.setTree('- button "Changed" @e999');
  let recovered = "";
  let pages = 0;
  let cursor: string | undefined;
  do {
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.text.length).toBeLessThanOrEqual(256);
    recovered += result.structuredContent.text;
    pages++;
    cursor = result.structuredContent.nextCursor;
    if (!cursor) break;
    expect(pages).toBeLessThan(20);
    result = await snapshot.handler({ cursor, maxChars: 256, owner: "one", filter: "all" });
  } while (cursor !== undefined);
  expect(pages).toBeGreaterThan(1);
  expect(recovered).toBe(original);
  expect(fixture.captures()).toBe(1);
});

test("continuation rejects cross-owner, cross-tab, changed query, and navigated scopes", async () => {
  const fixture = registry();
  fixture.setTree("checkout ".repeat(100));
  const snapshot = fixture.tool("snapshot");
  const first = await snapshot.handler({
    query: "checkout",
    owner: "one",
    tabId: 1,
    maxChars: 256,
  });
  const cursor = first.structuredContent.nextCursor;
  expect(typeof cursor).toBe("string");
  for (const changes of [{ owner: "two" }, { tabId: 2 }, { query: "other" }]) {
    const result = await snapshot.handler({
      query: "checkout",
      owner: "one",
      tabId: 1,
      cursor,
      ...changes,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cursor");
  }
  fixture.navigate();
  expect(
    (await snapshot.handler({ query: "checkout", owner: "one", tabId: 1, cursor })).isError,
  ).toBe(true);
});

test("page text query and continuation preserve every character of a long line", async () => {
  const fixture = registry();
  const original = "needle " + "x".repeat(900);
  fixture.setTree("unrelated\n" + original);
  const tool = fixture.tool("get_page_text");
  const first = await tool.handler({ query: "needle", maxChars: 500 });
  expect(first.structuredContent.text).toBe(original.slice(0, 500));
  const second = await tool.handler({
    query: "needle",
    cursor: first.structuredContent.nextCursor,
    maxChars: 500,
  });
  expect(first.structuredContent.text + second.structuredContent.text).toBe(original);
  expect(second.structuredContent.nextCursor).toBeUndefined();
});

test("malformed cursors and incompatible continuation modes return tool errors", async () => {
  const { tool } = registry();
  for (const args of [
    { cursor: "not-a-cursor" },
    { paginate: true, matchAll: true },
    { query: "x", outputMode: "file" },
  ]) {
    const result = await tool("get_page_text").handler(args);
    expect(result.isError).toBe(true);
  }
});

test("continuation cache expires and evicts tokens without extending capture lifetime", () => {
  let now = 100;
  const store = new PageTextStore(() => now, 2, 50);
  const options = { scope: "tab:1", maxChars: 2 };
  const first = store.read("abcdefgh", options).structuredContent.nextCursor!;
  const second = store.read(undefined, { ...options, cursor: first }).structuredContent.nextCursor!;
  store.read("ijklmnop", options);
  expect(() => store.read(undefined, { ...options, cursor: first })).toThrow("cursor");
  now = 151;
  expect(() => store.read(undefined, { ...options, cursor: second })).toThrow("expired");
});

test("pagination rejects oversized captures, zero budgets, and empty queries", () => {
  const store = new PageTextStore();
  expect(() => store.read("x".repeat(1000001), { scope: "one", maxChars: 500 })).toThrow(
    "cache limit",
  );
  for (const maxChars of [0, -1, 0.5, 64001, NaN]) {
    expect(() => store.read("text", { scope: "one", maxChars })).toThrow("maxChars");
  }
  expect(() => store.read("text", { scope: "one", maxChars: 100, query: " " })).toThrow("query");
});

test("continuation preserves astral characters at every border position after UTF-8 transport", () => {
  for (let maxChars = 1; maxChars <= 32; maxChars++) {
    for (let border = 0; border < maxChars; border++) {
      const original = "a".repeat(border) + "\u{1f642}".repeat(maxChars + 1) + "\n\u{1f642}tail";
      const store = new PageTextStore();
      let cursor: string | undefined;
      let recovered = "";
      let chunks = 0;
      do {
        const result = store.read(cursor ? undefined : original, {
          scope: "unicode",
          maxChars,
          cursor,
        });
        const chunk = result.structuredContent.text;
        expect(chunk.length).toBeGreaterThan(0);
        expect(chunk.length).toBeLessThanOrEqual(maxChars === 1 ? 2 : maxChars);
        const transported = Buffer.from(chunk, "utf8").toString("utf8");
        expect(transported).toBe(chunk);
        recovered += transported;
        cursor = result.structuredContent.nextCursor;
        expect(++chunks).toBeLessThanOrEqual(original.length);
      } while (cursor);
      expect(recovered).toBe(original);
    }
  }
});

test("maxChars=1 returns a whole surrogate pair as one character and always advances", () => {
  const store = new PageTextStore();
  const first = store.read("\u{1f642}x", { scope: "one", maxChars: 1 });
  expect(first.structuredContent.text).toBe("\u{1f642}");
  expect(first.structuredContent.text.length).toBe(2);
  const second = store.read(undefined, {
    scope: "one",
    maxChars: 1,
    cursor: first.structuredContent.nextCursor,
  });
  expect(second.structuredContent.text).toBe("x");
  expect(second.structuredContent.nextCursor).toBeUndefined();
});

test("large continuation budgets do not split an astral character at either edge", () => {
  for (const maxChars of [127, 256, 500, 8000, 64000]) {
    for (const border of [0, 1, maxChars - 2, maxChars - 1, maxChars, maxChars + 1]) {
      const original = "a".repeat(border) + "\u{1f642}\u{1f642}end";
      const store = new PageTextStore();
      let cursor: string | undefined;
      let recovered = "";
      do {
        const result = store.read(cursor ? undefined : original, {
          scope: "large",
          maxChars,
          cursor,
        });
        const chunk = result.structuredContent.text;
        expect(chunk.length).toBeGreaterThan(0);
        expect(chunk.length).toBeLessThanOrEqual(maxChars);
        const transported = Buffer.from(chunk, "utf8").toString("utf8");
        expect(transported).toBe(chunk);
        recovered += transported;
        cursor = result.structuredContent.nextCursor;
      } while (cursor);
      expect(recovered).toBe(original);
    }
  }
});
