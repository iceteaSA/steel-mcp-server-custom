import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import type { Page } from "patchright";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { stripUnsafeControls } from "./untrusted.js";
import { clearAllSnapshots } from "./snapshot.js";

export type HandoffState = "AGENT" | "HUMAN_REQUESTED" | "DRAINING" | "HUMAN" | "RESYNC" | "PAUSED";
const MAX_PENDING_REQUESTS = 8;
type Outcome = "human_done" | "human_declined" | "paused" | "timeout";
type Request = {
  id: string;
  caller: string;
  agent: string;
  reason: string;
  tabId?: number;
  created: number;
  notified: boolean;
  generation: number;
  status?: Outcome;
};
type Operation = {
  cancelled: boolean;
  pages: Map<Page, { id: number; primary: boolean; terminate?: () => Promise<unknown> }>;
  cancel: () => void;
  done: Promise<void>;
};
const operationScope = new AsyncLocalStorage<Operation>();

export function assertAgentOperation(): void {
  if (operationScope.getStore()?.cancelled)
    throw new Error("human_control: cancelled agent operation");
}

export function hasAgentOperation(): boolean {
  return operationScope.getStore() !== undefined;
}

export function trackAgentPage(
  page: Page,
  id: number,
  primary = false,
  terminate?: () => Promise<unknown>,
): Page {
  const operation = operationScope.getStore();
  if (operation?.cancelled) {
    if (!primary) void page.close().catch(() => {});
    throw new Error("human_control: cancelled agent operation");
  }
  operation?.pages.set(page, {
    id,
    primary: primary || operation.pages.get(page)?.primary === true,
    terminate: terminate ?? operation.pages.get(page)?.terminate,
  });
  return page;
}

export interface HandoffOptions {
  drainMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  automaticTimers?: boolean;
  ntfyTopicFile?: string;
  releaseHumanInput?: () => Promise<void>;
  humanInputReleaseMs?: number;
  resync: () => Promise<void>;
}

export class HandoffController extends EventEmitter {
  private state: HandoffState = "AGENT";
  private reason = "";
  private tabId?: number;
  private token?: string;
  private readonly displacedTokens: string[] = [];
  private heartbeat = 0;
  private readonly requests: Request[] = [];
  private readonly charges = new Map<string, number[]>();
  private readonly running = new Set<Operation>();
  private readonly waiters = new Set<() => void>();
  private readonly now: () => number;
  private readonly timer?: ReturnType<typeof setInterval>;
  private closedTabIds: number[] = [];
  private fencedNotClosed: number[] = [];
  private terminal: Outcome = "human_done";
  private epoch = 0;
  private generation = 0;
  private readonly snapshots = new Map<string, number>();
  private stopping = false;
  private stopDrain?: () => void;

  constructor(private readonly options: HandoffOptions) {
    super();
    this.now = options.now ?? Date.now;
    if (options.automaticTimers !== false) {
      this.timer = setInterval(() => {
        void this.tick().catch(() => {});
      }, 1000);
      this.timer.unref();
    }
  }

  snapshot() {
    return {
      state: this.state,
      reason: this.reason,
      ...(this.tabId !== undefined ? { tabId: this.tabId } : {}),
      requests: this.requests
        .filter((r) => !r.status)
        .slice(0, MAX_PENDING_REQUESTS)
        .map(({ id, agent, reason, tabId, created }) => ({ id, agent, reason, tabId, created })),
      closedTabIds: [...this.closedTabIds],
      fenced_not_closed: [...this.fencedNotClosed],
      requestedTabClosed: this.tabId !== undefined && this.closedTabIds.includes(this.tabId),
    };
  }

  private change(state: HandoffState): void {
    this.state = state;
    this.emit("change");
    for (const wake of this.waiters) wake();
  }

  request(caller: string, input: { reason: string; tabId?: number }, agent = "Agent") {
    if (!caller) throw new Error("no_caller");
    if (this.stopping) throw new Error("handoff_closed");
    if (!input.reason.trim() || input.reason.length > 1000) throw new Error("invalid_request");
    const reason = stripUnsafeControls(input.reason).trim();
    const duplicate = this.requests.find(
      (r) => !r.status && r.caller === caller && r.reason === reason && r.tabId === input.tabId,
    );
    if (duplicate) return { id: duplicate.id, state: this.state };
    const pending = this.requests.filter((r) => !r.status).length;
    if (pending >= MAX_PENDING_REQUESTS)
      throw new Error(`handoff_busy: ${pending} pending requests (limit ${MAX_PENDING_REQUESTS})`);
    const times = (this.charges.get(caller) ?? []).filter((t) => t > this.now() - 3600000);
    if (
      times.length >= 10 ||
      this.requests.filter((r) => !r.status && r.caller === caller).length >= 3
    )
      throw new Error("rate_limited");
    this.charges.set(caller, [...times, this.now()]);
    if (this.state === "AGENT") this.generation++;
    const request: Request = {
      id: randomUUID(),
      caller,
      agent: stripUnsafeControls(agent).slice(0, 200),
      reason,
      tabId: input.tabId,
      created: this.now(),
      notified: false,
      generation: this.generation,
    };
    this.requests.push(request);
    while (this.requests.length > 1000) {
      const index = this.requests.findIndex((r) => r.status);
      if (index < 0) break;
      this.requests.splice(index, 1);
    }
    if (this.state === "AGENT") {
      this.reason = reason;
      this.tabId = input.tabId;
      this.change("HUMAN_REQUESTED");
    } else this.emit("change");
    return { id: request.id, state: this.state };
  }

  private error(): CallToolResult {
    const value = { error: "human_control", ...this.snapshot() };
    return {
      isError: true,
      structuredContent: value,
      content: [{ type: "text", text: `human_control: ${this.reason}\n${JSON.stringify(value)}` }],
    };
  }

  async run(name: string, handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
    if (name === "wait_for_human" || name === "signin_status" || name === "list_lanes")
      return handler();
    if (this.stopping || !["AGENT", "HUMAN_REQUESTED"].includes(this.state)) return this.error();
    if (name === "request_signin" || name === "cancel_signin") return handler();
    let cancel!: () => void;
    let complete!: () => void;
    const cancelled = new Promise<CallToolResult>((resolve) => {
      cancel = () => resolve(this.error());
    });
    const operation: Operation = {
      cancelled: false,
      pages: new Map(),
      cancel,
      done: new Promise<void>((resolve) => {
        complete = resolve;
      }),
    };
    this.running.add(operation);
    const result = operationScope.run(operation, async () => {
      try {
        const value = await handler();
        if (operation.cancelled) return this.error();
        return value;
      } finally {
        this.running.delete(operation);
        complete();
      }
    });
    return Promise.race([result, cancelled]);
  }

  async withRefs(
    name: string,
    caller: string,
    args: Record<string, unknown>,
    tabId: number,
    handler: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const key = `${caller}:${tabId}`;
    const hasRef = (value: unknown): boolean =>
      !!value &&
      typeof value === "object" &&
      Object.entries(value).some(
        ([name, item]) => (name === "ref" && item !== undefined) || hasRef(item),
      );
    if (hasRef(args) && this.epoch > 0 && this.snapshots.get(key) !== this.epoch) {
      const error = "stale_ref: handoff invalidated refs; take a fresh snapshot.";
      return {
        isError: true,
        structuredContent: { error: "stale_ref" },
        content: [{ type: "text", text: error }],
      };
    }
    const result = await handler();
    if (name === "snapshot" && !result.isError) this.snapshots.set(key, this.epoch);
    return result;
  }

  take(input: { reason?: string; tabId?: number }) {
    if (this.stopping || ["DRAINING", "HUMAN", "RESYNC"].includes(this.state))
      throw new Error("handoff_busy");
    if (this.state !== "HUMAN_REQUESTED") this.generation++;
    this.reason =
      input.reason ?? this.requests.find((r) => !r.status)?.reason ?? "Operator took control";
    this.tabId = input.tabId ?? this.requests.find((r) => !r.status)?.tabId;
    this.closedTabIds = [];
    this.fencedNotClosed = [];
    const token = randomUUID();
    if (this.token) {
      this.displacedTokens.push(this.token);
      if (this.displacedTokens.length > 8) this.displacedTokens.shift();
    }
    this.token = token;
    this.heartbeat = this.now();
    this.change("DRAINING");
    const result = { ...this.snapshot(), token, inFlight: this.running.size };
    void this.drain(token).catch(() => {
      if (this.token === token) this.pause();
    });
    return result;
  }

  private async drain(token: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The download tool can wait 125 s. Keep 5 s more for the drain.
      await Promise.race([
        Promise.all([...this.running].map((o) => o.done)),
        new Promise<void>((resolve) => {
          this.stopDrain = resolve;
          timer = setTimeout(resolve, this.options.drainMs ?? 130000);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (this.token === token) this.stopDrain = undefined;
    }
    if (this.state !== "DRAINING" || this.stopping || this.token !== token)
      throw new Error("handoff_closed");
    const pages = new Map<
      Page,
      { id: number; primary: boolean; terminate?: () => Promise<unknown> }
    >();
    for (const operation of this.running) {
      operation.cancelled = true;
      for (const [page, target] of operation.pages) pages.set(page, target);
    }
    try {
      await Promise.all(
        [...pages].map(async ([page, { id, primary, terminate }]) => {
          if (!page.isClosed()) {
            if (primary) {
              if (this.token === token) this.fencedNotClosed.push(id);
              if (!terminate) throw new Error("handoff_no_cancellation_session");
              await terminate();
              return;
            }
            await page.close();
            if (this.token === token) this.closedTabIds.push(id);
          }
        }),
      );
    } catch {
      if (this.token === token) this.pause();
      throw new Error("handoff_cancel_failed");
    }
    if (this.state !== "DRAINING" || this.stopping || this.token !== token)
      throw new Error("handoff_closed");
    this.heartbeat = this.now();
    this.change("HUMAN");
    for (const operation of this.running) {
      operation.cancel();
      this.running.delete(operation);
    }
  }

  private authorize(token: string): void {
    const actual = Buffer.from(token);
    const expected = Buffer.from(this.token ?? "");
    if (!this.token || actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error(this.displacedTokens.includes(token) ? "handoff_displaced" : "handoff_owner");
  }

  beat(token: string) {
    this.authorize(token);
    if (this.state !== "HUMAN" && this.state !== "DRAINING") throw new Error("handoff_paused");
    this.heartbeat = this.now();
    return this.snapshot();
  }

  async back(token: string) {
    this.authorize(token);
    if (!["HUMAN", "PAUSED"].includes(this.state) || this.stopping) throw new Error("handoff_busy");
    this.token = undefined;
    this.change("RESYNC");
    try {
      // TODO(viewer lane): release X server input through this hook before the viewer ships.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.options.releaseHumanInput?.() ?? Promise.resolve(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("human_input_release_timeout")),
              this.options.humanInputReleaseMs ?? 5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      await this.options.resync();
      this.emit("resync");
      clearAllSnapshots();
      this.epoch++;
      this.snapshots.clear();
    } catch {
      this.pause();
      throw new Error("handoff_resync_failed");
    }
    if (this.state !== "RESYNC" || this.stopping) throw new Error("handoff_closed");
    this.finish("human_done");
    this.change("AGENT");
    return this.snapshot();
  }

  decline(id?: string) {
    if (this.state !== "HUMAN_REQUESTED") throw new Error("handoff_busy");
    const request = this.requests.find((r) => !r.status && (!id || r.id === id));
    if (!request) throw new Error("handoff_unknown");
    request.status = "human_declined";
    this.terminal = "human_declined";
    const next = this.requests.find((r) => !r.status);
    this.reason = next?.reason ?? this.reason;
    this.tabId = next?.tabId ?? this.tabId;
    this.change(next ? "HUMAN_REQUESTED" : "AGENT");
    return this.snapshot();
  }

  private finish(status: Outcome): void {
    this.terminal = status;
    for (const request of this.requests) if (!request.status) request.status = status;
  }

  private pause(): void {
    this.stopDrain?.();
    this.finish("paused");
    this.change("PAUSED");
    for (const operation of this.running) {
      operation.cancelled = true;
      operation.cancel();
      for (const [page, target] of operation.pages)
        if (!target.primary) void page.close().catch(() => {});
      this.running.delete(operation);
    }
  }

  async wait(caller: string, timeout: number) {
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 120) throw new Error("invalid_wait");
    const request = [...this.requests]
      .reverse()
      .find((r) => r.caller === caller && r.generation === this.generation);
    const outcome = () =>
      request?.status ??
      (this.state === "PAUSED" || this.stopping
        ? "paused"
        : this.state === "AGENT"
          ? this.terminal
          : undefined);
    const initial = outcome();
    if (initial) return { status: initial, ...this.snapshot() };
    if (timeout === 0) return { status: "timeout" as const, ...this.snapshot() };
    return new Promise<{ status: Outcome } & ReturnType<HandoffController["snapshot"]>>(
      (resolve) => {
        const finish = (status: Outcome) => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve({ status, ...this.snapshot() });
        };
        const wake = () => {
          const status = outcome();
          if (status) finish(status);
        };
        const timer = setTimeout(() => finish("timeout"), timeout * 1000);
        this.waiters.add(wake);
        wake();
      },
    );
  }

  async tick(): Promise<void> {
    if (
      (this.state === "HUMAN" || this.state === "DRAINING") &&
      this.now() - this.heartbeat >= (this.options.heartbeatMs ?? 15000)
    )
      this.pause();
    for (const [caller, times] of this.charges)
      if (!times.some((t) => t > this.now() - 3600000)) this.charges.delete(caller);
    const file = this.options.ntfyTopicFile;
    if (!file || this.stopping) return;
    const due = this.requests.filter(
      (request) => !request.status && !request.notified && this.now() - request.created >= 60000,
    );
    if (!due.length) return;
    for (const request of due) request.notified = true;
    const request = due[0];
    const pending = this.requests.filter((request) => !request.status).length;
    try {
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let topic: string;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("unsafe_ntfy_file");
        topic = (await handle.readFile("utf8")).trim();
      } finally {
        await handle.close();
      }
      const url = new URL(topic.includes("://") ? topic : `https://ntfy.sh/${topic}`);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("invalid_ntfy_topic");
      const clean = (value: string) =>
        stripUnsafeControls(value)
          .replace(/https?:\/\/[^\s]+/g, "[URL]")
          .replace(/\p{Cc}/gu, " ");
      await fetch(url, {
        method: "POST",
        headers: {
          Priority: "high",
          "Content-Type": "text/plain; charset=utf-8",
          Title: `${pending} pending human request${pending === 1 ? "" : "s"}`,
        },
        body: `${pending > 1 ? `${pending} pending requests; ` : ""}${clean(request.agent)} asks for browser control: ${clean(request.reason)}; tab ${request.tabId ?? "current"}`,
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
    } catch {
      console.error("[steel-mcp] Handoff notification failed.");
    }
  }

  browserLost(): void {
    if (this.state !== "AGENT") this.pause();
  }

  shutdown(): void {
    this.stopping = true;
    clearInterval(this.timer);
    this.pause();
    this.removeAllListeners();
  }
}
