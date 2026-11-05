import { afterAll, beforeAll, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { extensionBrowser, installMockChrome } from "./browser-fixture.js";
import { isValidProfileName } from "../../src/helpers.js";

let fixture;
beforeAll(async () => {
  fixture = await extensionBrowser();
});
afterAll(async () => {
  await fixture?.close();
});

it("compiles every HTML pattern with Chromium's v flag and preserves server profile names", async () => {
  const page = await fixture.browser.newPage();
  try {
    const files = await readdir(new URL("../", import.meta.url), { recursive: true });
    for (const file of files.filter((name) => name.endsWith(".html"))) {
      const html = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      const patterns = [...html.matchAll(/\bpattern="([^"]*)"/g)].map((match) => match[1]);
      const errors = await page.evaluate(
        (patterns) =>
          patterns.flatMap((pattern) => {
            try {
              new RegExp(pattern, "v");
              return [];
            } catch (error) {
              return [error.message];
            }
          }),
        patterns,
      );
      expect({ file, errors }).toEqual({ file, errors: [] });
    }
    await installMockChrome(page);
    await page.goto(`${fixture.origin}/popup.html`);
    for (const [name, accepted] of [
      ["work", true],
      ["A_9-x", true],
      ["a".repeat(64), true],
      ["", false],
      ["a".repeat(65), false],
      ["a b", false],
      ["a/b", false],
      ["é", false],
    ]) {
      expect(isValidProfileName(name)).toBe(accepted);
      expect(
        await page.evaluate((value) => {
          const field = document.getElementById("profileName");
          return new RegExp(`^(?:${field.pattern})$`, "v").test(value);
        }, name),
      ).toBe(accepted);
    }
  } finally {
    await page.close();
  }
});

for (const populated of [false, true]) {
  it(`keeps the approval button's accessible name and visible label with ${populated ? "data" : "no data"}`, async () => {
    const page = await fixture.browser.newPage();
    try {
      const requests = populated
        ? [
            {
              id: "one",
              site: "https://example.com",
              domains: ["example.com"],
              profile: "work",
              caller: { agent: "Agent" },
              reason: "Read account",
              expires: Date.now() + 300000,
            },
          ]
        : [];
      await installMockChrome(page, { requests });
      await page.goto(`${fixture.origin}/approval.html?id=one`);
      await page.waitForFunction(
        () =>
          !document.getElementById("review").textContent.includes("Loading request") ||
          document.getElementById("status").textContent,
      );
      const button = page.getByRole("button", { name: "Approve sign-in transfer", exact: true });
      expect(await button.count()).toBe(1);
      expect(await button.innerText()).toBe("Approve sign-in transfer");
      expect(await button.isVisible()).toBe(true);
      expect(await button.isDisabled()).toBe(!populated);
      expect(
        await button.evaluate((element) => {
          const style = getComputedStyle(element);
          const range = document.createRange();
          range.selectNodeContents(element);
          return {
            color: style.color,
            background: style.backgroundColor,
            width: range.getBoundingClientRect().width,
            font: parseFloat(style.fontSize),
          };
        }),
      ).toMatchObject({ color: "rgb(255, 255, 255)", background: "rgb(22, 79, 196)" });
    } finally {
      await page.close();
    }
  });
}
