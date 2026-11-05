import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "patchright";
import { EnvSchema } from "../env.js";
import type { BrowserManager } from "../manager.js";
import { register as interaction } from "../tools/interaction.js";
import { register as act } from "../tools/act.js";
import type { ToolSpec } from "../tools/shared.js";
import { readPathFixture } from "./helpers.js";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  ({ browser, page } = await readPathFixture());
});
afterAll(async () => { await browser?.close(); });

function tools(baseUrl?: string) {
  const specs: ToolSpec[] = [];
  const manager = {
    getPage: async () => page,
    resolveTab: () => 9701,
    dialogNotice: () => "",
    setTabLastUrl: () => {},
  } as unknown as BrowserManager;
  const env = EnvSchema.parse({
    BROWSER_MODE: "local", SETTLE_TIMEOUT_MS: 0,
    ACT_LLM_BASE_URL: baseUrl, ACT_LLM_MODEL: "fixture",
  });
  interaction((s) => specs.push(s), manager, env);
  act((s) => specs.push(s), manager, env);
  return (name: string) => specs.find((s) => s.name === name)!;
}

for (const method of ["click", "act"]) {
  for (const shape of ["below viewport", "pseudo-element"]) {
    test(`${method} clicks a control ${shape}`, async () => {
      await page.setContent(shape === "below viewport"
        ? '<div style="height:2400px"></div><button id="pay" onclick="this.dataset.clicked=\'yes\'">Pay</button>'
        : '<style>#pay{position:relative;width:24px;height:24px;padding:0;border:0}#pay::before{content:"";position:absolute;inset:0;background:blue}</style><button id="pay" aria-label="Pay" onclick="this.dataset.clicked=\'yes\'"></button>');
      if (shape === "below viewport") {
        expect(await page.locator("#pay").evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThan(720);
      } else {
        expect(await page.locator("#pay").evaluate((el) => getComputedStyle(el, "::before").content)).toBe('""');
      }
      const llm = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
        const input = await request.json() as { messages: { content: string }[] };
        const ref = input.messages.map((m) => m.content).join("\n").match(/@?(e\d+)/)?.[1];
        return Response.json({ choices: [{ message: { content: JSON.stringify({ action: "click", ref, reason: "Pay" }) } }] });
      } });
      try {
        const tool = tools(`http://127.0.0.1:${llm.port}`)(method);
        const result = await tool.handler(method === "click" ? { selector: "#pay", timeout: 1000 } : { instruction: "Click Pay", maxSteps: 1 });
        expect(result.isError).not.toBe(true);
        expect(await page.locator("#pay").getAttribute("data-clicked")).toBe("yes");
      } finally { await llm.stop(true); }
    });
  }
}

test("fill selects a visible label whose value differs", async () => {
  await page.setContent('<select id="country"><option value="ca">Canada</option><option value="us">United States</option></select>');
  const result = await tools()("fill").handler({ fields: [{ selector: "#country", kind: "selectLabel", value: "United States" }] });
  expect(result.isError).not.toBe(true);
  expect(await page.locator("#country").inputValue()).toBe("us");
});

for (const kind of ["select", "selectLabel", "selectIndex"]) {
  test(`fill ${kind} rejects a missing option without clearing state or change events`, async () => {
    await page.setContent('<select id="country" data-changes="0" onchange="this.dataset.changes=String(Number(this.dataset.changes)+1)"><option value="ca">Canada</option><option value="us">United States</option></select>');
    const start = performance.now();
    const result = await tools()("fill").handler({ fields: [{ selector: "#country", kind, value: kind === "selectIndex" ? "99" : "missing" }] });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Option not found");
    expect(performance.now() - start).toBeLessThan(2000);
    expect(await page.locator("#country").inputValue()).toBe("ca");
    expect(await page.locator("#country").getAttribute("data-changes")).toBe("0");
  }, 15000);
}
