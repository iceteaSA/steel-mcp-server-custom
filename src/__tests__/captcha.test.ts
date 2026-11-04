import { describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import { createContext, runInContext } from "node:vm";
import type { Page } from "patchright";
import { awaitCaptcha, detectCaptcha, injectCaptchaToken, formatCaptchaResult } from "../captcha.js";

function fixture(html: string) {
  const { window } = parseHTML(`<html><head></head><body>${html}</body></html>`);
  const context = createContext({ window, document: window.document, URL, Event: window.Event, location: { href: "https://example.test/form" } });
  const page = {
    evaluate: async (fn: Function | string, arg?: unknown) => {
      context.arg = arg;
      return runInContext(typeof fn === "string" ? fn : `(${fn.toString()})(arg)`, context);
    },
    title: async () => "Form", url: () => "https://example.test/form",
    frames: () => [],
  } as unknown as Page;
  return { page, window, context };
}

describe("CAPTCHA local HTML detection and injection", () => {
  for (const [type, html, field] of [
    ["reCAPTCHA v2", '<div class="g-recaptcha" data-sitekey="public-key" data-callback="done"></div><textarea id="g-recaptcha-response" name="g-recaptcha-response"></textarea>', "g-recaptcha-response"],
    ["Turnstile", '<div class="cf-turnstile" data-sitekey="public-key" data-callback="done"></div><input name="cf-turnstile-response">', "cf-turnstile-response"],
    ["hCaptcha", '<div class="h-captcha" data-sitekey="public-key" data-callback="done"></div><textarea name="h-captcha-response"></textarea>', "h-captcha-response"],
  ]) {
    it(`detects and injects ${type} without returning its token`, async () => {
      const f = fixture(html);
      f.context.received = "";
      runInContext('window.done = (token) => { received = token; }', f.context);
      const detected = await detectCaptcha(f.page);
      expect(detected?.type).toBe(type);
      expect(detected?.siteKey).toBe("public-key");
      expect(await injectCaptchaToken(f.page, "private-token", detected!)).toBe(true);
      expect(f.window.document.querySelector(`[name="${field}"]`)?.getAttribute("value") ?? (f.window.document.querySelector(`[name="${field}"]`) as HTMLTextAreaElement)?.value).toBe("private-token");
      expect(f.context.received).toBe("private-token");
      const after = await detectCaptcha(f.page);
      expect(after?.hasToken).toBe(true);
      expect(JSON.stringify(after)).not.toContain("private-token");
    });
  }
  it("detects anchor iframe k and invisible mode", async () => {
    const f = fixture('<iframe src="https://www.google.com/recaptcha/api2/anchor?k=anchor-key&size=invisible&sa=login"></iframe>');
    expect(await detectCaptcha(f.page)).toMatchObject({ type: "reCAPTCHA v2", siteKey: "anchor-key", invisible: true, action: "login" });
  });
  it("detects v3 render site key without treating render=explicit as a key", async () => {
    expect(await detectCaptcha(fixture('<script src="https://www.google.com/recaptcha/api.js?render=v3-key"></script>').page)).toMatchObject({ type: "reCAPTCHA v3", siteKey: "v3-key" });
    expect(await detectCaptcha(fixture('<script src="https://www.google.com/recaptcha/api.js?render=explicit"></script>').page)).toBeNull();
  });
  it("detects Turnstile iframe without inventing a site key", async () => {
    expect(await detectCaptcha(fixture('<iframe src="https://challenges.cloudflare.com/widget"></iframe>').page)).toMatchObject({ type: "Turnstile", siteKey: "" });
  });
  it("does not inject into a page without a widget or field", async () => {
    const f = fixture("<form><input name=email></form>");
    expect(await detectCaptcha(f.page)).toBeNull();
    expect(await injectCaptchaToken(f.page, "private-token", { type: "reCAPTCHA v2", siteKey: "x", hasToken: false, state: "detected" })).toBe(false);
  });
});

describe("extension CAPTCHA wait", () => {
  it("returns immediately with no CAPTCHA", async () => {
    const result = await awaitCaptcha(fixture("<p>normal</p>").page, { timeoutMs: 100 });
    expect(result.status).toBe("none");
    expect(formatCaptchaResult(result)).toBe("");
  });
  for (const state of ["solved", "error"]) {
    it(`waits for a fake extension transition to ${state}`, async () => {
      const f = fixture('<div class="g-recaptcha" data-sitekey="public-key"></div><div id="capsolver-solver-tip-button" data-state="solving"><span class="capsolver-solver-info">failed</span></div>');
      const timer = setTimeout(() => f.window.document.querySelector("#capsolver-solver-tip-button")!.setAttribute("data-state", state), 20);
      try {
        const result = await awaitCaptcha(f.page, { timeoutMs: 500, pollIntervalMs: 10 });
        expect(result.status).toBe(state === "solved" ? "solved" : "failed");
        expect(formatCaptchaResult(result)).toContain(state === "solved" ? "solved in" : "not solved");
      } finally { clearTimeout(timer); }
    });
  }
  it("reports timeout with an actionable line", async () => {
    const f = fixture('<div class="h-captcha" data-sitekey="public-key"></div>');
    const result = await awaitCaptcha(f.page, { timeoutMs: 20, pollIntervalMs: 5 });
    expect(result.status).toBe("timeout");
    expect(formatCaptchaResult(result)).toContain("solve_captcha");
    expect(formatCaptchaResult(result)).toContain("start_browser");
  });
  it("recognizes an existing token without waiting", async () => {
    const f = fixture('<div class="g-recaptcha" data-sitekey="key"></div><textarea name="g-recaptcha-response">already-solved</textarea>');
    expect((await awaitCaptcha(f.page, { timeoutMs: 10 })).status).toBe("solved");
  });
});
