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
afterAll(async () => {
  await browser?.close();
});

function tools(baseUrl?: string) {
  const specs: ToolSpec[] = [];
  const manager = {
    getPage: async () => page,
    resolveTab: () => 9701,
    dialogNotice: () => "",
    setTabLastUrl: () => {},
  } as unknown as BrowserManager;
  const env = EnvSchema.parse({
    BROWSER_MODE: "local",
    SETTLE_TIMEOUT_MS: 0,
    ACT_LLM_BASE_URL: baseUrl,
    ACT_LLM_MODEL: "fixture",
  });
  interaction((s) => specs.push(s), manager, env);
  act((s) => specs.push(s), manager, env);
  return (name: string) => specs.find((s) => s.name === name)!;
}

for (const method of ["click", "act"]) {
  for (const shape of ["below viewport", "pseudo-element"]) {
    test(`${method} clicks a control ${shape}`, async () => {
      await page.setContent(
        shape === "below viewport"
          ? '<div style="height:2400px"></div><button id="pay" onclick="this.dataset.clicked=\'yes\'">Pay</button>'
          : '<style>#pay{position:relative;width:24px;height:24px;padding:0;border:0}#pay::before{content:"";position:absolute;inset:0;background:blue}</style><button id="pay" aria-label="Pay" onclick="this.dataset.clicked=\'yes\'"></button>',
      );
      if (shape === "below viewport") {
        expect(
          await page.locator("#pay").evaluate((el) => el.getBoundingClientRect().top),
        ).toBeGreaterThan(720);
      } else {
        expect(
          await page.locator("#pay").evaluate((el) => getComputedStyle(el, "::before").content),
        ).toBe('""');
      }
      const llm = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          const input = (await request.json()) as { messages: { content: string }[] };
          const ref = input.messages
            .map((m) => m.content)
            .join("\n")
            .match(/@?(e\d+)/)?.[1];
          return Response.json({
            choices: [
              { message: { content: JSON.stringify({ action: "click", ref, reason: "Pay" }) } },
            ],
          });
        },
      });
      try {
        const tool = tools(`http://127.0.0.1:${llm.port}`)(method);
        const result = await tool.handler(
          method === "click"
            ? { selector: "#pay", timeout: 1000 }
            : { instruction: "Click Pay", maxSteps: 1 },
        );
        expect(result.isError).not.toBe(true);
        expect(await page.locator("#pay").getAttribute("data-clicked")).toBe("yes");
      } finally {
        await llm.stop(true);
      }
    });
  }
}

test("fill selects a visible label whose value differs", async () => {
  await page.setContent(
    '<select id="country"><option value="ca">Canada</option><option value="us">United States</option></select>',
  );
  const result = await tools()("fill").handler({
    fields: [{ selector: "#country", kind: "selectLabel", value: "United States" }],
  });
  expect(result.isError).not.toBe(true);
  expect(await page.locator("#country").inputValue()).toBe("us");
});

test("fill select accepts a label-only string like the engine", async () => {
  await page.setContent('<select id="country"><option value="ca">Canada</option><option value="us">United States</option></select>');
  await page.locator("#country").selectOption("United States");
  expect(await page.locator("#country").inputValue()).toBe("us");
  await page.locator("#country").selectOption("ca");
  const result = await tools()("fill").handler({ timeout: 300, fields: [{ selector: "#country", kind: "select", value: "United States" }] });
  expect(result.isError).not.toBe(true);
  expect(await page.locator("#country").inputValue()).toBe("us");
});

for (const kind of ["select", "selectLabel"]) {
  test(`fill ${kind} uses the engine's label whitespace normalization`, async () => {
    await page.setContent('<select id="country"><option value="ca">Canada</option><option value="us" label="  United\u200b States\u00ad ">US</option></select>');
    await page.locator("#country").selectOption(kind === "select" ? " United   States " : { label: " United   States " });
    expect(await page.locator("#country").inputValue()).toBe("us");
    await page.locator("#country").selectOption("ca");
    const result = await tools()("fill").handler({ timeout: 300, fields: [{ selector: "#country", kind, value: " United   States " }] });
    expect(result.isError).not.toBe(true);
    expect(await page.locator("#country").inputValue()).toBe("us");
  });
}

for (const kind of ["select", "selectLabel", "selectIndex"]) {
  test(`fill ${kind} rejects a missing option without clearing state or change events`, async () => {
    await page.setContent(
      '<select id="country" data-changes="0" onchange="this.dataset.changes=String(Number(this.dataset.changes)+1)"><option value="ca">Canada</option><option value="us">United States</option></select>',
    );
    const start = performance.now();
    const result = await tools()("fill").handler({
      timeout: 1000,
      fields: [{ selector: "#country", kind, value: kind === "selectIndex" ? "99" : "missing" }],
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Option not found");
    expect(JSON.stringify(result)).toContain("2 options");
    expect(JSON.stringify(result)).toContain("Canada");
    expect(JSON.stringify(result)).toContain("United States");
    expect(performance.now() - start).toBeGreaterThanOrEqual(900);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(await page.locator("#country").inputValue()).toBe("ca");
    expect(await page.locator("#country").getAttribute("data-changes")).toBe("0");
  }, 15000);
}

for (const kind of ["select", "selectLabel", "selectIndex"]) {
  test(`fill ${kind} waits for an option added after the call starts`, async () => {
    await page.setContent(
      '<select id="country" data-changes="0" onchange="this.dataset.changes=String(Number(this.dataset.changes)+1)"><option value="ca">Canada</option></select>',
    );
    const pending = tools()("fill").handler({
      fields: [
        {
          selector: "#country",
          kind,
          value: kind === "selectLabel" ? "United States" : kind === "selectIndex" ? "1" : "us",
        },
      ],
    });
    await page.evaluate(() => {
      setTimeout(() => {
        const select = document.querySelector("select")!;
        select.add(new Option("United States", "us"));
      }, 800);
    });
    await page.locator('option[value="us"]').waitFor({ state: "attached", timeout: 2000 });
    const result = await pending;
    expect(result.isError).not.toBe(true);
    expect(await page.locator("#country").inputValue()).toBe("us");
    expect(await page.locator("#country").getAttribute("data-changes")).toBe("1");
  });
}

test("fill reports the actual option when an earlier label collides with a requested value", async () => {
  await page.setContent('<select id="country"><option value="zzz">ca</option><option value="ca">Canada</option></select>');
  const result = await tools()("fill").handler({ fields: [{ selector: "#country", kind: "select", value: "ca" }] });
  expect(result.isError).not.toBe(true);
  expect(await page.locator("#country").inputValue()).toBe("zzz");
  expect(result.content[0].text).toContain('"value":"zzz"');
  expect(result.content[0].text).toContain('"label":"ca"');
});

test("fill reports every actual selection in a multiple select", async () => {
  await page.setContent('<select id="country" multiple onchange="this.options[0].selected=true;this.options[1].selected=true"><option value="zzz">ca</option><option value="ca">Canada</option><option value="us">United States</option></select>');
  const result = await tools()("fill").handler({ fields: [{ selector: "#country", kind: "select", value: "ca" }] });
  expect(result.isError).not.toBe(true);
  expect(await page.locator("#country").evaluate((el) => Array.from((el as HTMLSelectElement).selectedOptions).map((option) => option.value))).toEqual(["zzz", "ca"]);
  expect(result.content[0].text).toContain('"value":"zzz","label":"ca"');
  expect(result.content[0].text).toContain('"value":"ca","label":"Canada"');
});

for (const kind of ["select", "selectLabel", "selectIndex"]) {
  test(`fill ${kind} refuses success when a change handler selects an unrelated option`, async () => {
    await page.setContent('<select id="country" data-changes="0" onchange="this.dataset.changes=String(Number(this.dataset.changes)+1);this.value=\'zzz\'"><option value="zzz">Other</option><option value="ca">Canada</option></select>');
    const result = await tools()("fill").handler({ fields: [{ selector: "#country", kind, value: kind === "selectLabel" ? "Canada" : kind === "selectIndex" ? "1" : "ca" }] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Selection mismatch");
    expect(result.content[0].text).toContain('"value":"zzz"');
    expect(result.content[0].text).toContain('"label":"Other"');
    expect(result.content[0].text).not.toContain("Filled 1/1");
    expect(result.content[0].text).not.toContain("ok:");
    expect(await page.locator("#country").inputValue()).toBe("zzz");
    expect(await page.locator("#country").getAttribute("data-changes")).toBe("1");
  });
}

test("act reports the actual option when a requested value matches an earlier label", async () => {
  await page.setContent('<select id="country" aria-label="Country"><option value="zzz">ca</option><option value="ca">Canada</option></select>');
  const llm = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const input = await request.json() as { messages: { content: string }[] };
    const ref = input.messages.map((m) => m.content).join("\n").match(/@?(e\d+)/)?.[1];
    return Response.json({ choices: [{ message: { content: JSON.stringify({ action: "fill", ref, value: "ca", reason: "Select country" }) } }] });
  } });
  try {
    const result = await tools(`http://127.0.0.1:${llm.port}`)("act").handler({ instruction: "Select ca", maxSteps: 1 });
    expect(result.isError).not.toBe(true);
    expect(await page.locator("#country").inputValue()).toBe("zzz");
    expect(result.content[0].text).toContain('"value":"zzz"');
    expect(result.content[0].text).toContain('"label":"ca"');
  } finally { await llm.stop(true); }
});
