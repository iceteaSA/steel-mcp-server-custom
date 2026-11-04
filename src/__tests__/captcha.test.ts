import { describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import { createContext, runInContext } from "node:vm";
import type { Frame, Page } from "patchright";
import * as helpers from "../helpers.js";
import type { BrowserManager, Env } from "../manager.js";
import { register as registerInteraction } from "../tools/interaction.js";
import { register as registerNavigation } from "../tools/navigation.js";
import { register as registerCaptcha } from "../tools/captcha.js";
import { runAct, type RunActDeps } from "../tools/act.js";
import type { ToolSpec } from "../tools/shared.js";
import {
  awaitCaptcha,
  detectCaptcha,
  injectCaptchaToken,
  formatCaptchaResult,
  solveCaptcha,
  captchaTimeoutMs,
} from "../captcha.js";

function fixture(html: string) {
  const dom = parseHTML(`<html><head></head><body>${html}</body></html>`);
  const location = { href: "https://example.test/form" };
  const history = {
    pushState: (_data: unknown, _unused: string, url?: string | URL | null) => {
      if (url) location.href = new URL(String(url), location.href).href;
    },
    replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
      if (url) location.href = new URL(String(url), location.href).href;
    },
  };
  // linkedom window proxies share Node globals. Use a separate event target per page.
  const window = Object.assign(new dom.window.EventTarget(), {
    document: dom.document,
    Event: dom.window.Event,
    location,
    history,
  });
  const context = createContext({
    window,
    document: window.document,
    URL,
    Event: window.Event,
    location,
    history,
  });
  const page = {
    evaluate: async (fn: Function | string, arg?: unknown) => {
      context.arg = arg;
      return runInContext(typeof fn === "string" ? fn : `(${fn.toString()})(arg)`, context);
    },
    title: async () => "Form",
    url: () => location.href,
    frames: () => [],
  } as unknown as Page;
  return { page, window, context };
}

describe("CAPTCHA local HTML detection and injection", () => {
  for (const [type, html, field] of [
    [
      "reCAPTCHA v2",
      '<div class="g-recaptcha" data-sitekey="public-key" data-callback="done"></div><textarea id="g-recaptcha-response" name="g-recaptcha-response"></textarea>',
      "g-recaptcha-response",
    ],
    [
      "Turnstile",
      '<div class="cf-turnstile" data-sitekey="public-key" data-callback="done"></div><input name="cf-turnstile-response">',
      "cf-turnstile-response",
    ],
    [
      "hCaptcha",
      '<div class="h-captcha" data-sitekey="public-key" data-callback="done"></div><textarea name="h-captcha-response"></textarea>',
      "h-captcha-response",
    ],
  ]) {
    it(`detects and injects ${type} without returning its token`, async () => {
      const f = fixture(html);
      f.context.received = "";
      runInContext("window.done = (token) => { received = token; }", f.context);
      const detected = await detectCaptcha(f.page);
      expect(detected?.type).toBe(type);
      expect(detected?.siteKey).toBe("public-key");
      expect(await injectCaptchaToken(f.page, "private-token", detected!)).toBe(true);
      expect(
        f.window.document.querySelector(`[name="${field}"]`)?.getAttribute("value") ??
          (f.window.document.querySelector(`[name="${field}"]`) as HTMLTextAreaElement)?.value,
      ).toBe("private-token");
      expect(f.context.received).toBe("private-token");
      const after = await detectCaptcha(f.page);
      expect(after?.hasToken).toBe(true);
      expect(JSON.stringify(after)).not.toContain("private-token");
    });
  }
  it("detects anchor iframe k and invisible mode", async () => {
    const f = fixture(
      '<iframe src="https://www.google.com/recaptcha/api2/anchor?k=anchor-key&size=invisible&sa=login"></iframe>',
    );
    expect(await detectCaptcha(f.page)).toMatchObject({
      type: "reCAPTCHA v2",
      siteKey: "anchor-key",
      invisible: true,
      action: "login",
    });
  });
  it("detects v3 render site key without treating render=explicit as a key", async () => {
    expect(
      await detectCaptcha(
        fixture('<script src="https://www.google.com/recaptcha/api.js?render=v3-key"></script>')
          .page,
      ),
    ).toMatchObject({ type: "reCAPTCHA v3", siteKey: "v3-key" });
    expect(
      await detectCaptcha(
        fixture('<script src="https://www.google.com/recaptcha/api.js?render=explicit"></script>')
          .page,
      ),
    ).toBeNull();
  });
  it("detects Turnstile iframe without inventing a site key", async () => {
    expect(
      await detectCaptcha(
        fixture('<iframe src="https://challenges.cloudflare.com/widget"></iframe>').page,
      ),
    ).toMatchObject({ type: "Turnstile", siteKey: "" });
  });
  it("does not inject into a page without a widget or field", async () => {
    const f = fixture("<form><input name=email></form>");
    expect(await detectCaptcha(f.page)).toBeNull();
    expect(
      await injectCaptchaToken(f.page, "private-token", {
        type: "reCAPTCHA v2",
        siteKey: "x",
        hasToken: false,
        state: "detected",
      }),
    ).toBe(false);
  });
});

describe("R1 CAPTCHA signal scope and exits", () => {
  function message(f: ReturnType<typeof fixture>, type: string) {
    f.context.messageType = type;
    runInContext(
      '{ const event = new window.Event("message"); event.source = window; event.data = {type: messageType}; window.dispatchEvent(event); }',
      f.context,
    );
  }
  it("review probe A: a detected signal cannot stall a plain SPA view", async () => {
    const f = fixture('<div class="g-recaptcha" data-sitekey="key"></div>');
    await detectCaptcha(f.page);
    message(f, "capsolverDetectedCallback");
    f.window.document.body.innerHTML = "<p>plain view after route change</p>";
    expect((await awaitCaptcha(f.page, { timeoutMs: 30, pollIntervalMs: 5 })).status).toBe("none");
  });
  it("review probe B: a solved signal cannot hide a fresh unsolved Turnstile", async () => {
    const f = fixture('<div class="g-recaptcha" data-sitekey="key"></div>');
    await detectCaptcha(f.page);
    message(f, "capsolverCallback");
    f.window.document.body.innerHTML =
      '<div class="cf-turnstile" data-sitekey="fresh-key"></div><input name="cf-turnstile-response">';
    const result = await awaitCaptcha(f.page, { timeoutMs: 30, pollIntervalMs: 5 });
    expect(result).toMatchObject({ status: "timeout", type: "Turnstile", siteKey: "fresh-key" });
  });
  for (const navigation of [
    "pushState",
    "replaceState",
    "popstate",
    "pageshow",
    "url",
    "widget-key",
    "widget-node",
    "document",
  ] as const) {
    it(`invalidates solved state on ${navigation} changes`, async () => {
      const f = fixture('<div class="cf-turnstile" data-sitekey="key"></div>');
      await detectCaptcha(f.page);
      message(f, "capsolverCallback");
      expect((await detectCaptcha(f.page))?.state).toBe("solved");
      if (navigation === "pushState" || navigation === "replaceState")
        runInContext(`window.history.${navigation}({}, "", location.href)`, f.context);
      else if (navigation === "popstate")
        runInContext('window.dispatchEvent(new window.Event("popstate"))', f.context);
      else if (navigation === "pageshow")
        runInContext(
          'const event = new window.Event("pageshow"); event.persisted = true; window.dispatchEvent(event)',
          f.context,
        );
      else if (navigation === "url") f.window.location.href = "https://example.test/other";
      else if (navigation === "widget-key")
        f.window.document.querySelector(".cf-turnstile")!.setAttribute("data-sitekey", "new-key");
      else if (navigation === "widget-node")
        f.window.document.body.innerHTML = '<div class="cf-turnstile" data-sitekey="key"></div>';
      else {
        const dom = parseHTML(
          '<html><body><div class="cf-turnstile" data-sitekey="key"></div></body></html>',
        );
        f.context.document = dom.document;
        f.window.document = dom.document;
      }
      expect((await awaitCaptcha(f.page, { timeoutMs: 20, pollIntervalMs: 5 })).status).toBe(
        "timeout",
      );
    });
  }
  it("does not invalidate a signal on an ordinary pageshow", async () => {
    const f = fixture('<div class="g-recaptcha" data-sitekey="key"></div>');
    await detectCaptcha(f.page);
    message(f, "capsolverCallback");
    runInContext('window.dispatchEvent(new window.Event("pageshow"))', f.context);
    expect((await awaitCaptcha(f.page, { timeoutMs: 20 })).status).toBe("solved");
  });
  it("ignores a late completion from the prior route until the new widget is detected", async () => {
    const f = fixture('<div class="g-recaptcha" data-sitekey="old-key"></div>');
    await detectCaptcha(f.page);
    message(f, "capsolverDetectedCallback");
    runInContext('history.pushState({}, "", "/new")', f.context);
    f.window.document.body.innerHTML = '<div class="cf-turnstile" data-sitekey="new-key"></div>';
    await detectCaptcha(f.page);
    message(f, "capsolverCallback");
    expect((await awaitCaptcha(f.page, { timeoutMs: 20, pollIntervalMs: 5 })).status).toBe(
      "timeout",
    );
    message(f, "capsolverDetectedCallback");
    message(f, "capsolverCallback");
    expect((await awaitCaptcha(f.page, { timeoutMs: 20 })).status).toBe("solved");
  });
  it("rejects an old solved tip after navigation but accepts a fresh solving-to-solved transition", async () => {
    const f = fixture(
      '<div class="cf-turnstile" data-sitekey="key"></div><div id="capsolver-solver-tip-button" data-state="solved"></div>',
    );
    expect((await detectCaptcha(f.page))?.state).toBe("solved");
    runInContext('history.pushState({}, "", "/new")', f.context);
    expect((await detectCaptcha(f.page))?.state).not.toBe("solved");
    const tip = f.window.document.querySelector("#capsolver-solver-tip-button")!;
    tip.setAttribute("data-state", "solving");
    expect((await detectCaptcha(f.page))?.state).toBe("solving");
    tip.setAttribute("data-state", "solved");
    expect((await detectCaptcha(f.page))?.state).toBe("solved");
  });
  it("keeps a fresh failure callback newer than the solving tip after a route reset", async () => {
    const f = fixture(
      '<div class="cf-turnstile" data-sitekey="key"></div><div id="capsolver-solver-tip-button" data-state="solving"></div>',
    );
    await detectCaptcha(f.page);
    runInContext('history.pushState({}, "", "/new")', f.context);
    message(f, "capsolverDetectedCallback");
    message(f, "capsolverFailedCallback");
    expect(await awaitCaptcha(f.page, { timeoutMs: 20, pollIntervalMs: 5 })).toMatchObject({
      status: "failed",
      error: "extension reported an error",
    });
  });
  for (const mode of ["before", "during"] as const) {
    it(`reports a frame detached ${mode} inspection without a timeout`, async () => {
      let calls = 0;
      let detached = mode === "before";
      const frame = {
        url: () => "https://example.test/frame",
        isDetached: () => detached,
        evaluate: async () => {
          calls++;
          if (mode === "during" && calls === 1)
            return { type: "Turnstile", siteKey: "key", state: "solving", hasToken: false };
          detached = true;
          throw new Error("Frame was detached");
        },
      } as unknown as Frame;
      const result = await awaitCaptcha(frame, { timeoutMs: 50, pollIntervalMs: 5 });
      expect(result).toMatchObject({ status: "failed", error: "frame detached" });
      expect(calls).toBe(mode === "before" ? 0 : 2);
    });
  }
  for (const [title, url] of [
    ["Just a moment...", "https://example.test"],
    ["Form", "https://www.google.com/sorry/index"],
  ]) {
    it(`waits on the bot-wall fallback for ${title} ${url}`, async () => {
      const f = fixture("<p>challenge</p>");
      Object.assign(f.page, { title: async () => title, url: () => url });
      expect(await awaitCaptcha(f.page, { timeoutMs: 20, pollIntervalMs: 5 })).toMatchObject({
        status: "timeout",
        type: "bot wall",
        state: "detected",
      });
    });
  }
  it("reports page closed instead of a generic inspection failure", async () => {
    const f = fixture("<p>closed</p>");
    Object.assign(f.page, {
      isClosed: () => true,
      evaluate: async () => {
        throw new Error("Target closed");
      },
    });
    expect(await awaitCaptcha(f.page, { timeoutMs: 20 })).toMatchObject({
      status: "failed",
      error: "page closed",
    });
  });
  it("reports an initial inspection failure without retrying until timeout", async () => {
    const f = fixture("<p>unavailable</p>");
    Object.assign(f.page, {
      evaluate: async () => {
        throw new Error("Execution context unavailable");
      },
    });
    expect(await awaitCaptcha(f.page, { timeoutMs: 20 })).toMatchObject({
      status: "failed",
      error: "could not inspect CAPTCHA state",
    });
  });
  it("does not expose obsolete title-poll constants as a second timeout source", () => {
    expect("CAPTCHA_WAIT_TOTAL_MS" in helpers).toBe(false);
    expect("CAPTCHA_POLL_INTERVAL_MS" in helpers).toBe(false);
  });
  for (const change of ["removed", "key", "url", "frame"] as const) {
    it(`rejects a ${change} change before token injection`, async () => {
      const html =
        '<div class="g-recaptcha" data-sitekey="key"></div><textarea name="g-recaptcha-response"></textarea>';
      const f = fixture(change === "frame" ? "<p>parent</p>" : html);
      const first = fixture(html);
      const second = fixture(html);
      if (change === "frame") Object.assign(f.page, { frames: () => [f.page, first.page] });
      let calls = 0;
      const result = await solveCaptcha(f.page, {
        apiKey: "private-key",
        fetch: (async (_url: string | URL | Request, _init?: RequestInit) => {
          calls++;
          if (change === "removed") f.window.document.body.innerHTML = "<p>new page</p>";
          if (change === "key")
            f.window.document
              .querySelector(".g-recaptcha")!
              .setAttribute("data-sitekey", "other-key");
          if (change === "url") f.window.location.href = "https://example.test/other";
          if (change === "frame") Object.assign(f.page, { frames: () => [f.page, second.page] });
          return Response.json({
            errorId: 0,
            status: "ready",
            solution: { token: "private-token" },
          });
        }) as typeof fetch,
      });
      expect(result).toMatchObject({
        status: "failed",
        injected: false,
        error: "page or widget changed before token injection",
      });
      expect(calls).toBe(1);
    });
  }
  it("returns sanitized HTTP API descriptions through the tool error allow-list", async () => {
    const f = fixture('<div class="g-recaptcha" data-sitekey="public-site-key"></div>');
    const result = await solveCaptcha(f.page, {
      apiKey: "private-key",
      fetch: (async (_url: string | URL | Request, _init?: RequestInit) =>
        Response.json(
          {
            errorId: 1,
            errorCode: "ERROR_INVALID_TASK_DATA",
            errorDescription:
              "invalid task data: invalid websiteKey (public-site-key); clientKey=private-key",
          },
          { status: 400 },
        )) as typeof fetch,
    });
    expect(result.error).toContain(
      "CapSolver ERROR_INVALID_TASK_DATA: invalid task data: invalid websiteKey",
    );
    expect(result.error).not.toMatch(/public-site-key|private-key/);
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
      const f = fixture(
        '<div class="g-recaptcha" data-sitekey="public-key"></div><div id="capsolver-solver-tip-button" data-state="solving"><span class="capsolver-solver-info">failed</span></div>',
      );
      const timer = setTimeout(
        () =>
          f.window.document
            .querySelector("#capsolver-solver-tip-button")!
            .setAttribute("data-state", state),
        20,
      );
      try {
        const result = await awaitCaptcha(f.page, { timeoutMs: 500, pollIntervalMs: 10 });
        expect(result.status).toBe(state === "solved" ? "solved" : "failed");
        expect(formatCaptchaResult(result)).toContain(
          state === "solved" ? "solved in" : "not solved",
        );
      } finally {
        clearTimeout(timer);
      }
    });
  }
  it("reports timeout with an actionable line", async () => {
    const f = fixture('<div class="h-captcha" data-sitekey="public-key"></div>');
    const result = await awaitCaptcha(f.page, { timeoutMs: 20, pollIntervalMs: 5 });
    expect(result.status).toBe("timeout");
    expect(formatCaptchaResult(result)).toContain("solve_captcha");
    expect(formatCaptchaResult(result)).toContain("start_browser");
  });
  it("bounds a stalled browser evaluation by the CAPTCHA timeout", async () => {
    const f = fixture('<div class="g-recaptcha" data-sitekey="key"></div>');
    Object.assign(f.page, { evaluate: () => new Promise(() => {}) });
    const result = await Promise.race([
      awaitCaptcha(f.page, { timeoutMs: 10 }),
      new Promise<{ status: string }>((resolve) =>
        setTimeout(() => resolve({ status: "unbounded" }), 100),
      ),
    ]);
    expect(result.status).toBe("timeout");
  });
  it("recognizes an existing token without waiting", async () => {
    const f = fixture(
      '<div class="g-recaptcha" data-sitekey="key"></div><textarea name="g-recaptcha-response">already-solved</textarea>',
    );
    expect((await awaitCaptcha(f.page, { timeoutMs: 10 })).status).toBe("solved");
  });
  it("does not mistake a previous widget token for a second solved widget", async () => {
    const f = fixture(
      '<form><div class="g-recaptcha" data-sitekey="first-key"></div><textarea name="g-recaptcha-response">old-token</textarea></form><form><div class="cf-turnstile" data-sitekey="second-key"></div><input name="cf-turnstile-response"></form>',
    );
    const result = await awaitCaptcha(f.page, { timeoutMs: 10, pollIntervalMs: 5 });
    expect(result.status).toBe("timeout");
    expect(result.type).toBe("Turnstile");
  });
  it("keeps response tokens scoped to their widget when two keys share a form", async () => {
    const f = fixture(
      '<form><div class="g-recaptcha" data-sitekey="first-key"><textarea name="g-recaptcha-response">old-token</textarea></div><div class="g-recaptcha" data-sitekey="second-key"><textarea name="g-recaptcha-response"></textarea></div></form>',
    );
    expect(await detectCaptcha(f.page)).toMatchObject({ siteKey: "second-key", hasToken: false });
    await injectCaptchaToken(f.page, "new-token", (await detectCaptcha(f.page))!);
    expect(
      (
        f.window.document.querySelector(
          '[data-sitekey="first-key"] textarea',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("old-token");
    expect(
      (
        f.window.document.querySelector(
          '[data-sitekey="second-key"] textarea',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("new-token");
  });
  it("recognizes callback messages in the page world without replacing callbacks", async () => {
    const f = fixture('<div class="g-recaptcha" data-sitekey="key"></div>');
    await detectCaptcha(f.page);
    runInContext(
      'window.captchaSolvedCallback = () => "original"; const event = new window.Event("message"); event.source = window; event.data = {type: "capsolverCallback"}; window.dispatchEvent(event);',
      f.context,
    );
    expect((await awaitCaptcha(f.page, { timeoutMs: 10 })).status).toBe("solved");
    expect(runInContext("window.captchaSolvedCallback()", f.context)).toBe("original");
  });
  it("detects callback failure messages", async () => {
    const f = fixture(
      '<div class="g-recaptcha" data-sitekey="key"></div><div id="capsolver-solver-tip-button" data-state="solving"></div>',
    );
    await detectCaptcha(f.page);
    runInContext(
      'const event = new window.Event("message"); event.source = window; event.data = {type: "capsolverFailedCallback"}; window.dispatchEvent(event);',
      f.context,
    );
    expect((await awaitCaptcha(f.page, { timeoutMs: 10 })).status).toBe("failed");
  });
  it("uses 90 seconds by default and validates the environment override", () => {
    const previous = process.env.CAPTCHA_WAIT_TOTAL_MS;
    try {
      delete process.env.CAPTCHA_WAIT_TOTAL_MS;
      expect(captchaTimeoutMs()).toBe(90000);
      process.env.CAPTCHA_WAIT_TOTAL_MS = "2345";
      expect(captchaTimeoutMs()).toBe(2345);
      process.env.CAPTCHA_WAIT_TOTAL_MS = "invalid";
      expect(captchaTimeoutMs()).toBe(90000);
    } finally {
      if (previous === undefined) delete process.env.CAPTCHA_WAIT_TOTAL_MS;
      else process.env.CAPTCHA_WAIT_TOTAL_MS = previous;
    }
  });
});

describe("explicit CAPTCHA API fallback", () => {
  function api() {
    const tasks: Record<string, unknown>[] = [];
    return {
      tasks,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        tasks.push(JSON.parse(String(init?.body)).task);
        return Response.json({ errorId: 0, status: "ready", solution: { token: "private-token" } });
      }) as typeof fetch,
    };
  }
  for (const [type, html, taskType] of [
    [
      "reCAPTCHA v2",
      '<div class="g-recaptcha" data-sitekey="key" data-size="invisible" data-action="login" data-s="extra"></div>',
      "ReCaptchaV2TaskProxyLess",
    ],
    [
      "reCAPTCHA v3",
      '<script src="https://www.google.com/recaptcha/api.js?render=v3-key"></script><textarea name="g-recaptcha-response"></textarea>',
      "ReCaptchaV3TaskProxyLess",
    ],
    [
      "Turnstile",
      '<form><div class="cf-turnstile" data-sitekey="key" data-action="login" data-cdata="extra"></div></form>',
      "AntiTurnstileTaskProxyLess",
    ],
  ]) {
    it(`creates and injects a ${type} task without returning secrets`, async () => {
      const f = fixture(html);
      const mock = api();
      const result = await solveCaptcha(f.page, {
        fetch: mock.fetch,
        apiKey: "private-key",
        timeoutMs: 100,
      });
      expect(result.status).toBe("solved");
      expect(result.injected).toBe(true);
      expect(mock.tasks[0].type).toBe(taskType);
      expect(mock.tasks[0].websiteURL).toBe("https://example.test/form");
      expect(JSON.stringify(result)).not.toMatch(/private-token|private-key/);
      if (type === "Turnstile")
        expect(mock.tasks[0].metadata).toEqual({ action: "login", cdata: "extra" });
      if (type === "reCAPTCHA v2")
        expect(mock.tasks[0]).toMatchObject({
          isInvisible: true,
          pageAction: "login",
          recaptchaDataSValue: "extra",
        });
    });
  }
  it("does not spend for an existing token", async () => {
    const f = fixture(
      '<div class="g-recaptcha" data-sitekey="key"></div><textarea name="g-recaptcha-response">existing-token</textarea>',
    );
    const mock = api();
    expect((await solveCaptcha(f.page, { fetch: mock.fetch })).status).toBe("solved");
    expect(mock.tasks).toHaveLength(0);
  });
  it("reuses a token even if the widget element has been removed", async () => {
    const mock = api();
    const result = await solveCaptcha(
      fixture('<textarea name="g-recaptcha-response">private-token</textarea>').page,
      { fetch: mock.fetch },
    );
    expect(result.status).toBe("solved");
    expect(result.type).toBe("reCAPTCHA v2");
    expect(mock.tasks).toHaveLength(0);
  });
  it("waits for the extension before spending", async () => {
    const f = fixture(
      '<div class="g-recaptcha" data-sitekey="key"></div><div id="capsolver-solver-tip-button" data-state="solving"></div>',
    );
    const mock = api();
    const timer = setTimeout(
      () =>
        f.window.document
          .querySelector("#capsolver-solver-tip-button")!
          .setAttribute("data-state", "solved"),
      10,
    );
    try {
      expect((await solveCaptcha(f.page, { fetch: mock.fetch, timeoutMs: 100 })).status).toBe(
        "solved",
      );
      expect(mock.tasks).toHaveLength(0);
    } finally {
      clearTimeout(timer);
    }
  });
  it("does not create another task when extension solving times out", async () => {
    const f = fixture('<div id="capsolver-solver-tip-button" data-state="solving"></div>');
    const mock = api();
    expect((await solveCaptcha(f.page, { fetch: mock.fetch, timeoutMs: 10 })).status).toBe(
      "timeout",
    );
    expect(mock.tasks).toHaveLength(0);
  });
  it("reports unsupported hCaptcha and missing site keys without spending", async () => {
    const mock = api();
    for (const html of [
      '<div class="h-captcha" data-sitekey="key"></div>',
      '<iframe src="https://challenges.cloudflare.com/widget"></iframe>',
    ]) {
      const result = await solveCaptcha(fixture(html).page, { fetch: mock.fetch });
      expect(result.status).toBe("unsupported");
      expect(result.error).toBeTruthy();
    }
    expect(mock.tasks).toHaveLength(0);
  });
  it("fails clearly without an API key", async () => {
    const result = await solveCaptcha(
      fixture('<div class="g-recaptcha" data-sitekey="key"></div>').page,
      { apiKey: "" },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toBe("CAPSOLVER_API_KEY is not configured");
  });
  it("coalesces concurrent explicit calls for the same page", async () => {
    const f = fixture('<div class="g-recaptcha" data-sitekey="key"></div>');
    const mock = api();
    const [a, b] = await Promise.all([
      solveCaptcha(f.page, { fetch: mock.fetch, apiKey: "private-key" }),
      solveCaptcha(f.page, { fetch: mock.fetch, apiKey: "private-key" }),
    ]);
    expect(a.status).toBe("solved");
    expect(b).toEqual(a);
    expect(mock.tasks).toHaveLength(1);
  });
  it("reports a remaining CAPTCHA instead of claiming a half-solved page is solved", async () => {
    const f = fixture(
      '<form><div class="g-recaptcha" data-sitekey="key"></div></form><form><div class="cf-turnstile" data-sitekey="other-key"></div></form>',
    );
    const mock = api();
    const result = await solveCaptcha(f.page, { fetch: mock.fetch, apiKey: "private-key" });
    expect(result.status).toBe("failed");
    expect(result.injected).toBe(true);
    expect(result.error).toContain("another CAPTCHA remains");
    expect(mock.tasks).toHaveLength(1);
  });
});

describe("CAPTCHA tool integration", () => {
  function tools() {
    const f = fixture(
      '<input id="field" type="text"><button id="button">Submit</button><div class="g-recaptcha" data-sitekey="public-key"></div>',
    );
    let solved = false;
    function action() {
      const button = f.window.document.createElement("div");
      button.id = "capsolver-solver-tip-button";
      button.setAttribute("data-state", "solving");
      f.window.document.body.appendChild(button);
      setTimeout(() => {
        button.setAttribute("data-state", "solved");
        solved = true;
      }, 10);
    }
    Object.assign(f.page, {
      goto: async () => action(),
      keyboard: { press: async () => action() },
      locator: () => ({
        click: async () => action(),
        fill: async () => action(),
        ariaSnapshot: async () => '- button "Submit"',
      }),
    });
    const mgr = {
      getPage: async () => f.page,
      resolveTab: () => 1,
      setTabLastUrl: () => {},
      dialogNotice: () => "",
      consumeRecoveryNotice: () => "",
    } as unknown as BrowserManager;
    const env = { GLOBAL_WAIT_SECONDS: 0, SETTLE_TIMEOUT_MS: 0 } as Env;
    const specs: ToolSpec[] = [];
    const register = (tool: ToolSpec) => specs.push(tool);
    registerInteraction(register, mgr, env);
    registerNavigation(register, mgr, env);
    registerCaptcha(register, mgr);
    return {
      ...f,
      mgr,
      env,
      action,
      solved: () => solved,
      find: (name: string) => specs.find((tool) => tool.name === name)!,
    };
  }
  for (const [name, args] of [
    ["go_to_url", { url: "https://example.test/form" }],
    ["click", { selector: "#button" }],
    ["fill", { fields: [{ selector: "#field", value: "hello" }] }],
    ["press_key", { key: "Enter" }],
  ] as const) {
    it(`${name} blocks for extension completion and reports solved`, async () => {
      const t = tools();
      const result = await t.find(name).handler(structuredClone(args));
      expect(t.solved()).toBe(true);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("CAPTCHA reCAPTCHA v2 solved in");
    });
  }
  it("act waits after its action before returning", async () => {
    const t = tools();
    t.window.document.querySelector(".g-recaptcha")!.remove();
    const deps: RunActDeps = {
      llmJson: (async () => ({ action: "click", ref: "e1", reason: "submit" })) as NonNullable<
        RunActDeps["llmJson"]
      >,
      captureSnapshot: async () => ({ text: '- button "Submit" @e1', generation: 1 }),
      actionFeedback: async () => "",
      execClick: async () => {
        const widget = t.window.document.createElement("div");
        widget.className = "g-recaptcha";
        widget.setAttribute("data-sitekey", "public-key");
        t.window.document.body.appendChild(widget);
        t.action();
      },
    };
    const text = await runAct({ instruction: "Submit", maxSteps: 1 }, t.mgr, t.env, deps);
    expect(t.solved()).toBe(true);
    expect(text).toContain("CAPTCHA reCAPTCHA v2 solved in");
  });
  it("solve_captcha is core, accepts frame/timeout and reports unsupported without a secret", async () => {
    const t = tools();
    t.window.document.body.innerHTML = '<div class="h-captcha" data-sitekey="public-key"></div>';
    const tool = t.find("solve_captcha");
    expect(tool.toolset).toBe("core");
    expect(tool.inputSchema.frame).toBeDefined();
    expect(tool.inputSchema.timeoutMs).toBeDefined();
    const result = await tool.handler({ tabId: 1, owner: "fixture" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unsupported");
    expect(result.content[0].text).toContain("site key: public-key");
    expect(result.content[0].text).toContain("injected: no");
  });
});
