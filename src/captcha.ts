import type { Frame, Page } from "patchright";
import { isBotWall } from "./helpers.js";
import { CapSolverApiError, solveTask, type CaptchaTask, type SolverOptions } from "./capsolver.js";

export type CaptchaContext = Page | Frame;
export interface CaptchaDetection {
  type: string;
  siteKey: string;
  state: string;
  hasToken: boolean;
  callback?: string;
  action?: string;
  cdata?: string;
  invisible?: boolean;
  dataS?: string;
  enterprise?: boolean;
}

export interface CaptchaResult {
  status: "none" | "solved" | "failed" | "timeout" | "unsupported";
  type: string;
  siteKey: string;
  seconds: number;
  state: string;
  injected: boolean;
  error?: string;
}

declare global {
  interface Window {
    __steelCaptchaSignal?: {
      state: string;
      armed: boolean;
      buttonState?: string;
      document: Document;
      url: string;
      nodes: Element[];
      key: string;
      buttonElement?: Element | null;
      ignoredButton?: Element | null;
      ignoredButtonState?: string;
    };
  }
}

export function captchaTimeoutMs(): number {
  const configured = Number(process.env.CAPTCHA_WAIT_TOTAL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 90_000;
}

// Run in the page world. The extension calls page functions through postMessage.
export function readCaptchaDocument(): CaptchaDetection | null {
  function readScope() {
    const nodes = Array.from(
      document.querySelectorAll(
        '.g-recaptcha[data-sitekey], .cf-turnstile[data-sitekey], .h-captcha[data-sitekey], iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"], iframe[src*="challenges.cloudflare.com"], capsolver-widget, script[src*="recaptcha/"], [name="g-recaptcha-response"], [name="cf-turnstile-response"], [name="h-captcha-response"]',
      ),
    );
    return {
      document,
      url: location.href,
      nodes,
      key: JSON.stringify(
        nodes.map((node) => [
          node.getAttribute("data-sitekey"),
          node.getAttribute("src"),
          node.getAttribute("data-widget-id"),
          node.getAttribute("data-captcha-type"),
        ]),
      ),
    };
  }
  function syncScope(signal: NonNullable<Window["__steelCaptchaSignal"]>, force = false) {
    const scope = readScope();
    if (
      force ||
      signal.document !== scope.document ||
      signal.url !== scope.url ||
      signal.key !== scope.key ||
      signal.nodes.length !== scope.nodes.length ||
      signal.nodes.some((node, index) => node !== scope.nodes[index])
    ) {
      const button = document.querySelector("#capsolver-solver-tip-button");
      signal.ignoredButton = button === signal.buttonElement ? button : null;
      signal.ignoredButtonState = signal.ignoredButton?.getAttribute("data-state") || "";
      Object.assign(signal, scope, { state: "", buttonState: "", armed: false });
    }
  }
  if (!window.__steelCaptchaSignal) {
    const signal: NonNullable<Window["__steelCaptchaSignal"]> = {
      state: "",
      armed: true,
      ...readScope(),
    };
    Object.defineProperty(window, "__steelCaptchaSignal", { value: signal, configurable: true });
    window.addEventListener("message", (event) => {
      if (event.source !== window || !event.data || typeof event.data !== "object") return;
      syncScope(signal);
      if (!signal.nodes.length && !document.querySelector("#capsolver-solver-tip-button")) return;
      if (event.data.type === "capsolverDetectedCallback") {
        signal.armed = true;
        signal.state = "detected";
      }
      // Terminal callbacks have no widget ID. A reset requires a fresh detection signal.
      if (
        signal.armed &&
        ["capsolverCallback", "capsolverFailedCallback"].includes(event.data.type)
      ) {
        signal.buttonElement = document.querySelector("#capsolver-solver-tip-button");
        signal.buttonState = signal.buttonElement?.getAttribute("data-state") || "";
        signal.state = event.data.type === "capsolverCallback" ? "solved" : "error";
      }
    });
    for (const method of ["pushState", "replaceState"] as const) {
      const original = window.history?.[method];
      if (typeof original !== "function") continue;
      window.history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
        const result = original.apply(this, args);
        syncScope(signal, true);
        return result;
      };
    }
    window.addEventListener("popstate", () => syncScope(signal, true));
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) syncScope(signal, true);
    });
  }
  const button = document.querySelector("#capsolver-solver-tip-button");
  const signal = window.__steelCaptchaSignal;
  if (signal) syncScope(signal);
  const rawButtonState = button?.getAttribute("data-state") || "";
  if (signal && (signal.ignoredButton !== button || signal.ignoredButtonState !== rawButtonState)) {
    signal.ignoredButton = null;
    signal.ignoredButtonState = undefined;
  }
  const buttonState =
    signal?.ignoredButton === button &&
    signal.ignoredButtonState === rawButtonState &&
    ["solved", "error"].includes(rawButtonState)
      ? ""
      : rawButtonState;
  if (signal && signal.buttonState !== buttonState && ["solving", "ready"].includes(buttonState))
    signal.state = "";
  if (signal) {
    signal.buttonState = buttonState;
    signal.buttonElement = button;
  }
  // Failure callbacks do not always update the extension button.
  const state =
    signal?.state === "error" || signal?.state === "solved"
      ? signal.state
      : buttonState || signal?.state || "detected";
  const widgets = Array.from(
    document.querySelectorAll(
      ".g-recaptcha[data-sitekey], .cf-turnstile[data-sitekey], .h-captcha[data-sitekey]",
    ),
  );
  const anchor = document.querySelector<HTMLIFrameElement>(
    'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]',
  );
  const turnstile = document.querySelector<HTMLIFrameElement>(
    'iframe[src*="challenges.cloudflare.com"]',
  );
  const script = Array.from(
    document.querySelectorAll<HTMLScriptElement>('script[src*="recaptcha/"]'),
  ).find((el) => {
    const key = new URL(el.src, location.href).searchParams.get("render");
    return key && key !== "explicit";
  });
  const extensionWidget = document.querySelector("capsolver-widget");
  const responseField = document.querySelector(
    '[name="g-recaptcha-response"], textarea[id^="g-recaptcha-response"], [name="cf-turnstile-response"], [name="h-captcha-response"]',
  );
  if (
    !widgets.length &&
    !anchor &&
    !turnstile &&
    !script &&
    !button &&
    !extensionWidget &&
    !responseField
  ) {
    if (signal) signal.state = "";
    return null;
  }
  const params = new URL(anchor?.src || script?.src || location.href, location.href).searchParams;
  const extensionType = extensionWidget?.getAttribute("data-captcha-type");
  function describe(widget: Element | null): CaptchaDetection {
    const type =
      widget?.classList.contains("h-captcha") ||
      (!widget &&
        (extensionType === "hCaptcha" ||
          responseField?.getAttribute("name") === "h-captcha-response"))
        ? "hCaptcha"
        : widget?.classList.contains("cf-turnstile") ||
            (!widget &&
              (turnstile ||
                extensionType === "cloudflare" ||
                responseField?.getAttribute("name") === "cf-turnstile-response"))
          ? "Turnstile"
          : (script && !widget) || (!widget && extensionType === "reCaptcha3")
            ? "reCAPTCHA v3"
            : widget?.classList.contains("g-recaptcha") ||
                anchor ||
                extensionType === "reCaptcha" ||
                responseField
              ? "reCAPTCHA v2"
              : "unknown";
    const tokenSelector =
      type === "Turnstile"
        ? '[name="cf-turnstile-response"]'
        : type === "hCaptcha"
          ? '[name="h-captcha-response"]'
          : '[name="g-recaptcha-response"], textarea[id^="g-recaptcha-response"]';
    let scope: ParentNode = widget?.closest("form") || widget?.parentElement || document;
    const widgetSelector =
      type === "Turnstile"
        ? ".cf-turnstile[data-sitekey]"
        : type === "hCaptcha"
          ? ".h-captcha[data-sitekey]"
          : ".g-recaptcha[data-sitekey]";
    if (
      widget &&
      (widget.querySelector(tokenSelector) || scope.querySelectorAll(widgetSelector).length > 1)
    )
      scope = widget;
    const hasToken = Array.from(
      scope.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(tokenSelector),
    ).some((el) => Boolean(el.value?.trim()));
    return {
      type,
      siteKey:
        widget?.getAttribute("data-sitekey") ||
        params.get("k") ||
        (script ? params.get("render") : "") ||
        extensionWidget?.getAttribute("data-sitekey") ||
        "",
      state: widgets.length > 1 && state === "solved" && !hasToken ? "detected" : state,
      hasToken,
      callback: widget?.getAttribute("data-callback") || undefined,
      action:
        widget?.getAttribute("data-action") ||
        params.get("sa") ||
        extensionWidget?.getAttribute("data-action") ||
        undefined,
      cdata: widget?.getAttribute("data-cdata") || undefined,
      invisible:
        widget?.getAttribute("data-size") === "invisible" || params.get("size") === "invisible",
      dataS: widget?.getAttribute("data-s") || params.get("s") || undefined,
      enterprise: Boolean(
        anchor?.src.includes("/enterprise/") || script?.src.includes("/enterprise.js"),
      ),
    };
  }
  const detections = widgets.length ? widgets.map(describe) : [describe(null)];
  return detections.find((d) => !d.hasToken && d.state !== "solved") ?? detections[0];
}

export async function detectCaptcha(context: CaptchaContext): Promise<CaptchaDetection | null> {
  const detected = await context.evaluate(readCaptchaDocument, undefined, undefined, false);
  return detected && typeof detected.type === "string" ? detected : null;
}

function contexts(context: CaptchaContext): CaptchaContext[] {
  return "frames" in context ? [context, ...context.frames().slice(1)] : [context];
}

async function probe(
  context: CaptchaContext,
): Promise<{ detection: CaptchaDetection; context: CaptchaContext } | null> {
  const found: Array<{ detection: CaptchaDetection; context: CaptchaContext }> = [];
  for (const target of contexts(context)) {
    if ("isDetached" in target && target.isDetached()) throw new CaptchaFrameDetachedError();
    try {
      const detection = await detectCaptcha(target);
      if (detection) found.push({ detection, context: target });
    } catch (error) {
      if (
        ("isDetached" in target && target.isDetached()) ||
        (error instanceof Error && /frame (?:was |has been )?detached/i.test(error.message))
      )
        throw new CaptchaFrameDetachedError();
      throw error;
    }
  }
  if (!found.length && "title" in context && isBotWall(await context.title(), context.url())) {
    return {
      detection: { type: "bot wall", siteKey: "", state: "detected", hasToken: false },
      context,
    };
  }
  return found.find(({ detection: d }) => !d.hasToken && d.state !== "solved") ?? found[0] ?? null;
}

class CaptchaDeadlineError extends Error {}
class CaptchaFrameDetachedError extends Error {}

// CDP evaluations have no per-call timeout.
async function withinDeadline<T>(work: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new CaptchaDeadlineError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CaptchaDeadlineError()), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function awaitCaptcha(
  context: CaptchaContext,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<CaptchaResult> {
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? captchaTimeoutMs());
  let detected: CaptchaDetection | undefined;
  const result = (status: CaptchaResult["status"], error?: string): CaptchaResult => ({
    status,
    type: detected?.type ?? "unknown",
    siteKey: detected?.siteKey ?? "",
    state: detected?.state ?? "none",
    seconds: Math.round((Date.now() - started) / 1000),
    injected: false,
    ...(error ? { error } : {}),
  });
  for (;;) {
    try {
      const current = await withinDeadline(() => probe(context), deadline);
      if (!current) return result(detected ? "solved" : "none");
      detected = current.detection;
      if (detected.hasToken || detected.state === "solved") return result("solved");
      if (detected.state === "error" || detected.state === "failed")
        return result("failed", "extension reported an error");
    } catch (error) {
      if (error instanceof CaptchaFrameDetachedError) return result("failed", "frame detached");
      if (error instanceof CaptchaDeadlineError) return result("timeout");
      if ("isClosed" in context && context.isClosed()) return result("failed", "page closed");
      // Navigation can destroy the execution context while the extension submits.
      if (!detected) return result("failed", "could not inspect CAPTCHA state");
    }
    if (Date.now() >= deadline) return result("timeout");
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(options.pollIntervalMs ?? 500, Math.max(1, (deadline - Date.now()) / 2)),
      ),
    );
  }
}

export function formatCaptchaResult(result: CaptchaResult): string {
  if (result.status === "none") return "";
  if (result.status === "solved") return `CAPTCHA ${result.type} solved in ${result.seconds} s`;
  return `CAPTCHA ${result.type} not solved after ${result.seconds} s (state: ${result.state}${result.error ? `; ${result.error}` : ""}); call solve_captcha or hand off with start_browser`;
}

export async function injectCaptchaToken(
  context: CaptchaContext,
  token: string,
  detection: CaptchaDetection,
): Promise<boolean> {
  return context.evaluate(
    ({ token, detection }) => {
      const selector =
        detection.type === "Turnstile"
          ? '[name="cf-turnstile-response"]'
          : detection.type === "hCaptcha"
            ? '[name="h-captcha-response"], [name="g-recaptcha-response"]'
            : 'textarea[name="g-recaptcha-response"], textarea[id^="g-recaptcha-response"]';
      const widget = Array.from(document.querySelectorAll("[data-sitekey]")).find(
        (el) => el.getAttribute("data-sitekey") === detection.siteKey,
      );
      let scope: ParentNode = widget?.closest("form") || document;
      const widgetSelector =
        detection.type === "Turnstile"
          ? ".cf-turnstile[data-sitekey]"
          : detection.type === "hCaptcha"
            ? ".h-captcha[data-sitekey]"
            : ".g-recaptcha[data-sitekey]";
      if (
        widget &&
        (widget.querySelector(selector) || scope.querySelectorAll(widgetSelector).length > 1)
      )
        scope = widget;
      let fields = Array.from(
        scope.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(selector),
      );
      if (!fields.length) {
        if (widget) {
          const field = document.createElement("textarea");
          field.name =
            detection.type === "Turnstile"
              ? "cf-turnstile-response"
              : detection.type === "hCaptcha"
                ? "h-captcha-response"
                : "g-recaptcha-response";
          field.hidden = true;
          widget.appendChild(field);
          fields = [field];
        }
      }
      for (const field of fields) {
        field.value = token;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
      }
      let called = false;
      if (detection.callback) {
        let parent: unknown = window;
        const parts = detection.callback.split(".");
        for (const part of parts.slice(0, -1)) {
          parent =
            parent && (typeof parent === "object" || typeof parent === "function")
              ? Reflect.get(parent, part)
              : undefined;
        }
        const fn =
          parent && (typeof parent === "object" || typeof parent === "function")
            ? Reflect.get(parent, parts.at(-1)!)
            : undefined;
        if (typeof fn === "function") {
          Reflect.apply(fn, parent, [token]);
          called = true;
        }
      }
      return fields.length > 0 || called;
    },
    { token, detection },
    undefined,
    false,
  );
}

const activeSolves = new WeakMap<CaptchaContext, Promise<CaptchaResult>>();

export async function solveCaptcha(
  context: CaptchaContext,
  options: Partial<SolverOptions> = {},
): Promise<CaptchaResult> {
  const existing = activeSolves.get(context);
  if (existing) return existing;
  const pending = solveCaptchaOnce(context, options);
  activeSolves.set(context, pending);
  try {
    return await pending;
  } finally {
    activeSolves.delete(context);
  }
}

async function solveCaptchaOnce(
  context: CaptchaContext,
  options: Partial<SolverOptions>,
): Promise<CaptchaResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? captchaTimeoutMs();
  const deadline = started + timeoutMs;
  let detection: CaptchaDetection | undefined;
  let injected = false;
  const result = (status: CaptchaResult["status"], error?: string): CaptchaResult => ({
    status,
    type: detection?.type ?? "unknown",
    siteKey: detection?.siteKey ?? "",
    state: status,
    seconds: Math.round((Date.now() - started) / 1000),
    injected,
    ...(error ? { error } : {}),
  });
  try {
    let current = await withinDeadline(() => probe(context), deadline);
    if (!current) return result("none");
    detection = current.detection;
    if (detection.hasToken || detection.state === "solved") return result("solved");
    if (detection.state === "solving") {
      const waited = await awaitCaptcha(context, { timeoutMs: Math.max(0, deadline - Date.now()) });
      if (waited.status === "solved" || waited.status === "timeout") return waited;
      current = await withinDeadline(() => probe(context), deadline);
      if (!current) return result("solved");
      detection = current.detection;
    }
    if (
      !["reCAPTCHA v2", "reCAPTCHA v3", "Turnstile"].includes(detection.type) ||
      detection.enterprise
    )
      return result("unsupported", "unsupported CAPTCHA type; use the extension or start_browser");
    if (!detection.siteKey)
      return result("unsupported", "site key unavailable; use the extension or start_browser");
    if (Date.now() >= deadline) return result("timeout");
    const task: CaptchaTask = {
      type:
        detection.type === "Turnstile"
          ? "AntiTurnstileTaskProxyLess"
          : detection.type === "reCAPTCHA v3"
            ? "ReCaptchaV3TaskProxyLess"
            : "ReCaptchaV2TaskProxyLess",
      websiteURL: context.url(),
      websiteKey: detection.siteKey,
      ...(detection.type === "Turnstile"
        ? { metadata: { action: detection.action, cdata: detection.cdata } }
        : {
            pageAction: detection.action,
            isInvisible: detection.invisible,
            recaptchaDataSValue: detection.dataS,
          }),
    };
    const token = await solveTask(task, {
      ...options,
      apiKey: options.apiKey ?? process.env.CAPSOLVER_API_KEY ?? "",
      timeoutMs: deadline - Date.now(),
    });
    const after = await withinDeadline(() => probe(context), deadline);
    if (
      !after ||
      after.context !== current.context ||
      after.detection.siteKey !== detection.siteKey ||
      context.url() !== task.websiteURL
    )
      return result("failed", "page or widget changed before token injection");
    const injectionContext = current.context;
    const injectionDetection = detection;
    injected = await withinDeadline(
      () => injectCaptchaToken(injectionContext, token, injectionDetection),
      deadline,
    );
    if (injected) {
      const remaining = await withinDeadline(() => probe(context), deadline);
      if (remaining && !remaining.detection.hasToken && remaining.detection.state !== "solved") {
        return result(
          "failed",
          "token injected, but another CAPTCHA remains; call solve_captcha for the next widget",
        );
      }
    }
    return injected
      ? result("solved")
      : result("failed", "no response field or callback accepted the token");
  } catch (error) {
    if (error instanceof CaptchaFrameDetachedError) return result("failed", "frame detached");
    if (error instanceof CaptchaDeadlineError) return result("timeout");
    if (error instanceof CapSolverApiError) return result("failed", error.message);
    const text = error instanceof Error ? error.message : "";
    return result(
      "failed",
      /^(CapSolver (?:ERROR_[A-Z0-9_]+|API_ERROR|timed out|reached the 120 result-query limit|(?:createTask|getTaskResult) transport failed|returned (?:invalid JSON|an invalid response|an invalid task status)|response has no taskId|ready response has no token)|CAPSOLVER_API_KEY is not configured)$/.test(
        text,
      )
        ? text
        : "CAPTCHA solve failed",
    );
  }
}
