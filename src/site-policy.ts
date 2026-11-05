import { readFile } from "node:fs/promises";
import { getDomain } from "tldts";
import type { BrowserContext, CDPSession, Page, Request, Response, Route } from "patchright";
import type { Env } from "./manager.js";
import { normalizeSite } from "./signin.js";

type Entry = { domain: string; source: "shared" | "lane"; reason?: string };
const sharedLists = new Map<string, Promise<Map<string, Entry>>>();
type Failure =
  | { error: "site_blocked"; domain: string; source: "shared" | "lane"; popup?: boolean }
  | {
      error: "budget_exceeded";
      budget: "redirects" | "requests" | "navigation_ms";
      limit: number;
      observed: number;
    };

export class PolicyError extends Error {
  constructor(readonly detail: Failure) {
    super(JSON.stringify(detail));
  }
}

export function policyErrorResult(error: unknown) {
  return error instanceof PolicyError
    ? {
        isError: true,
        structuredContent: error.detail,
        content: [{ type: "text" as const, text: error.message }],
      }
    : undefined;
}

export class SitePolicy {
  private shared = new Map<string, Entry>();
  private lane = new Map<string, Entry>();
  private loaded?: Promise<void>;
  private contexts = new WeakSet<BrowserContext>();
  private routedContexts = new WeakSet<BrowserContext>();
  private routedPages = new WeakSet<Page>();
  private pages = new Map<Page, { session: CDPSession }>();
  private preparing = new WeakMap<Page, Promise<void>>();
  private failures = new WeakMap<Page, PolicyError>();
  private counted = new WeakSet<Request>();
  private requestFailures = new WeakMap<Request, PolicyError>();
  private requests: number[] = [];
  private pending?: PolicyError;
  private activeNavigations = new WeakSet<Page>();
  private navigationRequests = new WeakMap<Page, Request>();
  private earlyNavigations = new Map<string, Request>();
  constructor(
    private readonly env: Env,
    private readonly now = Date.now,
  ) {}

  async enabled() {
    await this.load();
    return (
      this.shared.size > 0 ||
      this.lane.size > 0 ||
      this.env.STEEL_MAX_REDIRECTS !== undefined ||
      this.env.STEEL_MAX_REQUESTS !== undefined ||
      this.env.STEEL_NAVIGATION_TIMEOUT_MS !== undefined
    );
  }
  hasDenyList() {
    return this.shared.size > 0 || this.lane.size > 0;
  }

  private async routePage(page: Page) {
    if (!this.hasDenyList() || this.routedPages.has(page)) return;
    this.routedPages.add(page);
    await page.route("**/*", async (route) => {
      if (!(await this.guard(route))) await route.fallback();
    });
  }

  private load() {
    return (this.loaded ??= (async () => {
      const file = this.env.STEEL_SITE_DENY_FILE;
      let shared = sharedLists.get(file);
      if (!shared) {
        shared = (async () => {
          try {
            const entries = new Map<string, Entry>();
            const text = await readFile(file, "utf8");
            for (const line of text.split(/\r?\n/)) {
              const value = line.split("#")[0].trim();
              if (!value) continue;
              const { host } = normalizeSite(value);
              const domain = getDomain(host, { allowPrivateDomains: true });
              if (!domain || value !== domain) throw new Error("invalid_domain");
              entries.set(domain, { domain, source: "shared" });
            }
            return entries;
          } catch {
            throw new Error(
              "site_policy_invalid: deny list must be readable and contain only registrable domains.",
            );
          }
        })();
        sharedLists.set(file, shared);
      }
      this.shared = await shared;
    })());
  }

  async block(site?: string, reason?: string) {
    await this.load();
    if (site !== undefined) {
      if (!reason?.trim()) throw new Error("invalid_site: reason is required when site is set");
      const { host } = normalizeSite(site);
      const domain = getDomain(host, { allowPrivateDomains: true });
      if (!domain) throw new Error("invalid_site: a registrable domain is required");
      if (!this.lane.has(domain))
        this.lane.set(domain, { domain, source: "lane", reason: reason.trim() });
      await Promise.all(
        [...this.pages].map(async ([page, { session }]) => {
          await this.routePage(page);
          await this.update(session);
        }),
      );
    }
    return {
      sites: [
        ...this.shared.values(),
        ...[...this.lane.values()].filter((e) => !this.shared.has(e.domain)),
      ].sort((a, b) => a.domain.localeCompare(b.domain)),
    };
  }

  private match(url: string): Entry | undefined {
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) return;
      const domain = getDomain(parsed.hostname.replace(/\.$/, ""), { allowPrivateDomains: true });
      return domain ? (this.shared.get(domain) ?? this.lane.get(domain)) : undefined;
    } catch {
      return;
    }
  }

  private blocked(url: string): PolicyError | undefined {
    const entry = this.match(url);
    return entry
      ? new PolicyError({ error: "site_blocked", domain: entry.domain, source: entry.source })
      : undefined;
  }

  private budget(
    budget: "redirects" | "requests" | "navigation_ms",
    limit: number | undefined,
    observed: number,
  ) {
    return limit !== undefined && observed > limit
      ? new PolicyError({ error: "budget_exceeded", budget, limit, observed })
      : undefined;
  }

  private count(): PolicyError | undefined {
    if (this.env.STEEL_MAX_REQUESTS === undefined) return;
    const now = this.now();
    const cutoff = now - this.env.STEEL_REQUEST_WINDOW_MS;
    while (this.requests.length && this.requests[0] <= cutoff) this.requests.shift();
    const error = this.budget("requests", this.env.STEEL_MAX_REQUESTS, this.requests.length + 1);
    if (!error) this.requests.push(now);
    return error;
  }

  private remember(page: Page, error: PolicyError) {
    this.failures.set(page, error);
    if (!this.activeNavigations.has(page)) this.pending = error;
  }

  async http<T>(
    url: string,
    send: (
      url: string,
      remaining?: number,
    ) => Promise<{
      value: T;
      status: number;
      location?: string | null;
      dispose?: () => Promise<void>;
    }>,
  ): Promise<T> {
    await this.load();
    const started = this.now();
    const limit = this.env.STEEL_NAVIGATION_TIMEOUT_MS;
    let current = url;
    for (let depth = 0; ; depth++) {
      const parsed = new URL(current);
      if (!["http:", "https:"].includes(parsed.protocol))
        throw new Error("invalid_site: HTTP URL required");
      const error =
        this.blocked(current) ??
        this.budget("redirects", this.env.STEEL_MAX_REDIRECTS ?? 20, depth) ??
        this.count();
      if (error) throw error;
      const remaining = limit === undefined ? undefined : limit - (this.now() - started);
      if (remaining !== undefined && remaining <= 0)
        throw new PolicyError({
          error: "budget_exceeded",
          budget: "navigation_ms",
          limit: limit!,
          observed: Math.max(limit! + 1, this.now() - started),
        });
      let reply;
      try {
        reply = await send(current, remaining);
      } catch (error) {
        if (limit !== undefined && this.now() - started >= limit)
          throw new PolicyError({
            error: "budget_exceeded",
            budget: "navigation_ms",
            limit,
            observed: Math.max(limit + 1, this.now() - started),
          });
        throw error;
      }
      if ([301, 302, 303, 307, 308].includes(reply.status) && reply.location) {
        current = new URL(reply.location, current).href;
        await reply.dispose?.();
      } else return reply.value;
    }
  }
  takePending() {
    const error = this.pending;
    this.pending = undefined;
    return error;
  }

  async guard(route: Route): Promise<boolean> {
    await this.load();
    const request = route.request();
    if (!/^https?:/.test(request.url())) return false;
    let error = this.blocked(request.url()) ?? this.requestFailures.get(request);
    if (!this.counted.has(request)) {
      this.counted.add(request);
      error ??= this.count();
    }
    if (error) {
      try {
        this.remember(request.frame().page(), error);
      } catch {
        this.pending = error;
      }
      await route.abort("blockedbyclient");
      return true;
    }
    return false;
  }

  private patterns() {
    return [...new Set([...this.shared.keys(), ...this.lane.keys()])].flatMap((domain) => [
      `*://${domain}/*`,
      `*://${domain}:*/*`,
      `*://*.${domain}/*`,
      `*://*.${domain}:*/*`,
      `*://${domain}./*`,
      `*://${domain}.:*/*`,
      `*://*.${domain}./*`,
      `*://*.${domain}.:*/*`,
    ]);
  }

  private async update(session: CDPSession) {
    const urls = this.patterns();
    const urlPatterns = [...new Set([...this.shared.keys(), ...this.lane.keys()])].flatMap(
      (domain) =>
        ["http", "https"].flatMap((scheme) =>
          [domain, `${domain}.`, `*.${domain}`, `*.${domain}.`].map((host) => ({
            urlPattern: `${scheme}://${host}:*/*`,
            block: true,
          })),
        ),
    );
    await session.send("Network.setBlockedURLs", { urlPatterns });
    if (urls.length)
      await session.send("Fetch.enable", {
        patterns: urls.map((urlPattern) => ({
          urlPattern,
          resourceType: "Document" as const,
          requestStage: "Request" as const,
        })),
      });
  }

  async attach(context: BrowserContext) {
    await this.load();
    if (this.hasDenyList() && !this.routedContexts.has(context)) {
      this.routedContexts.add(context);
      await context.route("**/*", async (route) => {
        if (!(await this.guard(route))) await route.fallback();
      });
    }
    if (this.contexts.has(context)) return;
    this.contexts.add(context);
    context.on("request", (request) => {
      if (request.isNavigationRequest()) {
        try {
          this.navigationRequests.set(request.frame().page(), request);
        } catch {
          this.earlyNavigations.set(request.url(), request);
        }
      }
      if (!this.counted.has(request)) {
        this.counted.add(request);
        const error = this.count();
        if (error) {
          this.requestFailures.set(request, error);
          try {
            const page = request.frame().page();
            this.remember(page, error);
            void this.pages
              .get(page)
              ?.session.send("Page.stopLoading")
              .catch(() => {});
          } catch {
            this.pending = error;
          }
        }
      }
    });
    context.on("page", (page) => {
      void this.prepare(page).catch(() => {
        void page.close().catch(() => {});
      });
    });
    context.on("requestfailed", (request) => {
      if (this.earlyNavigations.get(request.url()) === request)
        this.earlyNavigations.delete(request.url());
    });
    await Promise.all(context.pages().map((page) => this.prepare(page)));
  }

  prepare(page: Page): Promise<void> {
    const previous = this.preparing.get(page);
    if (previous) return previous;
    const ready = (async () => {
      const session = await page.context().newCDPSession(page);
      this.pages.set(page, { session });
      page.once("close", () => {
        this.pages.delete(page);
      });
      await this.routePage(page);
      session.on("Fetch.requestPaused", (event) => {
        const error = this.blocked(event.request.url);
        if (error) this.remember(page, error);
        const reply = error
          ? session.send("Fetch.failRequest", {
              requestId: event.requestId,
              errorReason: "BlockedByClient",
            })
          : session.send("Fetch.continueRequest", { requestId: event.requestId });
        void reply.catch(() => {});
      });
      // Playwright routes see only the first redirect hop. CDP checks each document hop.
      const depths = new Map<string, number>();
      const wall = new Map<string, { timer: ReturnType<typeof setTimeout>; started: number }>();
      const finish = (id: string) => {
        depths.delete(id);
        const entry = wall.get(id);
        if (entry) clearTimeout(entry.timer);
        wall.delete(id);
      };
      page.once("close", () => {
        for (const id of wall.keys()) finish(id);
      });
      session.on("Network.requestWillBeSent", (event) => {
        if (event.type !== "Document") return;
        const limit = this.env.STEEL_NAVIGATION_TIMEOUT_MS;
        if (!event.redirectResponse && limit !== undefined) {
          const started = this.now();
          const timer = setTimeout(() => {
            const error = new PolicyError({
              error: "budget_exceeded",
              budget: "navigation_ms",
              limit,
              observed: Math.max(limit + 1, this.now() - started),
            });
            this.remember(page, error);
            void session.send("Page.stopLoading").catch(() => {});
          }, limit);
          timer.unref?.();
          wall.set(event.requestId, { timer, started });
        }
        const depth = event.redirectResponse ? (depths.get(event.requestId) ?? 0) + 1 : 0;
        depths.set(event.requestId, depth);
        const error = this.budget("redirects", this.env.STEEL_MAX_REDIRECTS, depth);
        if (error) {
          this.remember(page, error);
          void session.send("Page.stopLoading").catch(() => {});
        }
      });
      session.on("Network.loadingFinished", (event) => finish(event.requestId));
      session.on("Network.loadingFailed", (event) => finish(event.requestId));
      await session.send("Network.enable");
      if (this.hasDenyList()) await this.update(session);
    })();
    this.preparing.set(page, ready);
    return ready;
  }

  async adopt(page: Page): Promise<boolean> {
    page.on("response", (response) => {
      if (response.request().isNavigationRequest()) {
        try {
          if (response.frame() === page.mainFrame())
            this.navigationRequests.set(page, response.request());
        } catch {}
      }
    });
    await this.prepare(page);
    let error = this.blocked(page.url());
    if (await page.opener()) {
      const request = this.navigationRequests.get(page) ?? this.earlyNavigations.get(page.url());
      for (let hop: Request | null = request ?? null; hop; hop = hop.redirectedFrom()) {
        if (this.earlyNavigations.get(hop.url()) === hop) this.earlyNavigations.delete(hop.url());
      }
      if (request) error ??= this.requestError(request);
      page.on("response", (response) => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
          const denied = this.responseError(response);
          if (denied) {
            this.pending = new PolicyError({
              ...denied.detail,
              ...(denied.detail.error === "site_blocked" ? { popup: true } : {}),
            });
            void page.close().catch(() => {});
          }
        }
      });
      error ??= this.failures.get(page);
      if (error) {
        this.pending = new PolicyError({
          ...error.detail,
          ...(error.detail.error === "site_blocked" ? { popup: true } : {}),
        });
        await page.close().catch(() => {});
        return false;
      }
    }
    return !page.isClosed();
  }

  private responseError(response: Response): PolicyError | undefined {
    return this.requestError(response.request());
  }

  allowsResponse(response: Response): boolean {
    return !this.responseError(response);
  }

  private requestError(initial: Request): PolicyError | undefined {
    for (let request: Request | null = initial; request; request = request.redirectedFrom()) {
      const error = this.blocked(request.url());
      if (error) return error;
    }
    return;
  }

  async navigate<T extends Response | null>(page: Page, operation: () => Promise<T>): Promise<T> {
    await this.prepare(page);
    this.failures.delete(page);
    this.activeNavigations.add(page);
    const start = this.now();
    const limit = this.env.STEEL_NAVIGATION_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await (limit === undefined
        ? operation()
        : Promise.race([
            operation(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                const error = new PolicyError({
                  error: "budget_exceeded",
                  budget: "navigation_ms",
                  limit,
                  observed: Math.max(limit + 1, this.now() - start),
                });
                this.remember(page, error);
                void this.pages
                  .get(page)
                  ?.session.send("Page.stopLoading")
                  .catch(() => {});
                reject(error);
              }, limit);
            }),
          ]));
      const error =
        this.failures.get(page) ??
        (result ? this.responseError(result) : undefined) ??
        this.budget("navigation_ms", limit, this.now() - start);
      if (error) throw error;
      return result;
    } catch (error) {
      const policy = this.failures.get(page);
      if (policy) throw policy;
      if (
        String(error).includes("ERR_TOO_MANY_REDIRECTS") &&
        this.env.STEEL_MAX_REDIRECTS !== undefined
      )
        throw new PolicyError({
          error: "budget_exceeded",
          budget: "redirects",
          limit: this.env.STEEL_MAX_REDIRECTS,
          observed: 21,
        });
      throw error;
    } finally {
      clearTimeout(timer);
      this.failures.delete(page);
      this.activeNavigations.delete(page);
    }
  }
}
