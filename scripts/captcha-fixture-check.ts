import { chromium } from "patchright";
import { strict as assert } from "node:assert";
import {
  awaitCaptcha,
  detectCaptcha,
  formatCaptchaResult,
  injectCaptchaToken,
} from "../src/captcha.js";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  for (const state of ["solved", "error"] as const) {
    await page.setContent(
      '<div class="g-recaptcha" data-sitekey="public-fixture-key"></div><textarea name="g-recaptcha-response"></textarea><div id="capsolver-solver-tip-button" data-state="solving"></div>',
    );
    await page.evaluate(
      (state) => {
        setTimeout(() => {
          document.querySelector("#capsolver-solver-tip-button")!.setAttribute("data-state", state);
          if (state === "solved")
            (document.querySelector('[name="g-recaptcha-response"]') as HTMLTextAreaElement).value =
              "fixture-token";
        }, 100);
      },
      state,
      undefined,
      false,
    );
    const result = await awaitCaptcha(page, { timeoutMs: 2000, pollIntervalMs: 20 });
    assert.equal(result.status, state === "solved" ? "solved" : "failed");
    console.log(formatCaptchaResult(result));
  }
  await page.goto("about:blank");
  await page.setContent(
    '<form><div class="cf-turnstile" data-sitekey="public-fixture-key" data-callback="fixtureDone"></div><input name="cf-turnstile-response"></form>',
  );
  await page.evaluate(
    "window.fixtureDone = (token) => { document.body.dataset.callbackLength = String(token.length); }",
    undefined,
    undefined,
    false,
  );
  const detection = await detectCaptcha(page);
  assert.equal(detection?.type, "Turnstile");
  assert.equal(await injectCaptchaToken(page, "fixture-token", detection!), true);
  assert.equal(await page.locator("body").getAttribute("data-callback-length"), "13");
  console.log("Turnstile field injection and page-world callback: passed");
  await page.goto("about:blank");
  await page.setContent('<div class="g-recaptcha" data-sitekey="public-fixture-key"></div>');
  await detectCaptcha(page);
  await page.evaluate(
    () => window.postMessage({ type: "capsolverCallback", callback: "captchaSolvedCallback" }, "*"),
    undefined,
    undefined,
    false,
  );
  const callbackResult = await awaitCaptcha(page, { timeoutMs: 2000, pollIntervalMs: 20 });
  assert.equal(callbackResult.status, "solved");
  console.log("Extension postMessage in page world: passed");
} finally {
  await browser.close();
}
