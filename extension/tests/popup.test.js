import { afterAll, beforeAll, expect, it } from "bun:test";
import { extensionBrowser, mockChrome } from "./browser-fixture.js";

let fixture;
beforeAll(async () => {
  fixture = await extensionBrowser();
});
afterAll(async () => {
  await fixture?.close();
});

async function popup(options) {
  const page = await fixture.browser.newPage({ timezoneId: "UTC" });
  await page.addInitScript(mockChrome, options);
  await page.goto(`${fixture.origin}/popup.html`);
  await page.waitForFunction(() =>
    document.getElementById("connection").textContent.includes("secret accepted"),
  );
  return page;
}

it("grants exactly both schemes for the current host and the selected parent", async () => {
  const page = await popup({ granted: false });
  try {
    await page.getByRole("button", { name: "Grant site access", exact: true }).click();
    await page.waitForFunction(() => calls.some(([type]) => type === "grant"));
    await page.locator("#parentPanel summary").click();
    await page.getByRole("button", { name: "Grant parent cookie access", exact: true }).click();
    await page.waitForFunction(() => calls.filter(([type]) => type === "grant").length === 2);
    expect(
      await page.evaluate(() =>
        JSON.parse(document.documentElement.dataset.calls).filter(([type]) => type === "grant"),
      ),
    ).toEqual([
      ["grant", { origins: ["https://login.example.com/*", "http://login.example.com/*"] }],
      ["grant", { origins: ["https://example.com/*", "http://example.com/*"] }],
    ]);
  } finally {
    await page.close();
  }
});

for (const allow of [true, false]) {
  it(`${allow ? "pushes only the selected site after" : "sends no push after refused"} host access`, async () => {
    const page = await popup({ granted: true, allow });
    try {
      await page.getByRole("button", { name: "Push this site", exact: true }).click();
      await page.waitForFunction(() => !document.getElementById("pushBtn").disabled);
      const grants = await page.evaluate(() =>
        JSON.parse(document.documentElement.dataset.calls).filter(([type]) => type === "grant"),
      );
      expect(grants).toEqual([
        ["grant", { origins: ["https://login.example.com/*", "http://login.example.com/*"] }],
      ]);
      const pushes = await page.evaluate(() =>
        JSON.parse(document.documentElement.dataset.calls).filter(
          ([kind, message]) => kind === "send" && message.type === "push",
        ),
      );
      if (allow) {
        expect(pushes).toHaveLength(1);
        expect(pushes[0][1]).toMatchObject({
          type: "push",
          profile: "work",
          includeStorage: true,
          sites: [
            {
              url: "https://login.example.com/",
              domain: "login.example.com",
              granted: true,
              cookieCount: 2,
              parents: [{ domain: "example.com", granted: false }],
            },
          ],
        });
        expect(await page.locator("#results").innerText()).toContain("2 cookies");
      } else {
        expect(pushes).toEqual([]);
        expect(await page.locator("#status").innerText()).toContain("No sign-in data was sent");
      }
    } finally {
      await page.close();
    }
  });
}

it("shows the session relay state on open and changes it without a popup reload", async () => {
  const since = Date.UTC(2026, 0, 1, 13, 42);
  const page = await popup({ relayState: { status: "disconnected", since } });
  try {
    expect(await page.locator("#relayState").count()).toBe(1);
    expect(await page.locator("#relayState").innerText()).toBe(
      "Relay down since 13:42 — requests cannot arrive",
    );
    await page.evaluate(() => {
      document.documentElement.dataset.relayState = JSON.stringify({ status: "connected" });
      dispatchEvent(new Event("mockRelayState"));
    });
    expect(await page.locator("#relayState").innerText()).toBe("Relay connected");
    await page.evaluate((since) => {
      document.documentElement.dataset.relayState = JSON.stringify({
        status: "disconnected",
        since,
      });
      dispatchEvent(new Event("mockRelayState"));
    }, since);
    expect(await page.locator("#relayState").innerText()).toBe(
      "Relay down since 13:42 — requests cannot arrive",
    );
  } finally {
    await page.close();
  }
});
