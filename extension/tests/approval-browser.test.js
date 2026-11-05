import { expect, it } from "bun:test";
import { unpackedExtensionBrowser, mockChrome } from "./browser-fixture.js";
import { PNG } from "./png-fixture.js";

for (const mode of ["light", "dark", "force-dark"]) {
  it(`renders the unpacked approval label in ${mode}, enabled and disabled`, async () => {
    const { context, origin } = await unpackedExtensionBrowser(mode === "force-dark");
    try {
      for (const populated of [false, true]) {
        const page = await context.newPage();
        await page.emulateMedia({ colorScheme: mode === "light" ? "light" : "dark" });
        const requests = populated ? [{ id: "one", site: "https://example.com", domains: ["example.com"], profile: "work", caller: { agent: "Agent" }, reason: "Read account", expires: Date.now() + 300000 }] : [];
        await page.addInitScript(mockChrome, { requests });
        await page.goto(`${origin}/approval.html?id=one`);
        await page.waitForFunction(() => document.getElementById("status").textContent || document.getElementById("review").querySelector("h2"));
        const button = page.getByRole("button", { name: "Approve sign-in transfer", exact: true });
        expect(await button.innerText()).toBe("Approve sign-in transfer");
        expect(await button.isVisible()).toBe(true);
        expect(await button.isDisabled()).toBe(!populated);
        const style = await button.evaluate((element) => {
          const css = getComputedStyle(element);
          const range = document.createRange(); range.selectNodeContents(element);
          const rect = range.getBoundingClientRect();
          return { color: css.color, background: css.backgroundColor, font: parseFloat(css.fontSize), width: rect.width, height: rect.height };
        });
        expect(style.color).not.toBe(style.background);
        expect(style.font).toBeGreaterThan(0);
        expect(style.width).toBeGreaterThan(100);
        expect(style.height).toBeGreaterThan(10);
        const pixels = await PNG(await button.screenshot());
        console.log(JSON.stringify({ mode, populated, ...style, ...pixels }));
        expect(pixels.labelPixels).toBeGreaterThan(50);
        await page.close();
      }
    } finally { await context.close(); }
  }, 30000);
}

it("keeps the approval label inside the first 900 pixels of a wide window", async () => {
  const { context, origin } = await unpackedExtensionBrowser();
  try {
    const page = await context.newPage();
    await page.addInitScript(mockChrome);
    const labels = [];
    for (const width of [2560, 3200, 3440]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.goto(`${origin}/approval.html?id=missing`);
      const label = await page.locator("#approve").evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const { x, right, width } = range.getBoundingClientRect();
        return { x, right, width };
      });
      console.log(JSON.stringify({ viewport: width, label }));
      labels.push(label);
    }
    for (const label of labels) {
      expect(label.x).toBeGreaterThanOrEqual(0);
      expect(label.right).toBeLessThan(900);
    }
  } finally { await context.close(); }
});
