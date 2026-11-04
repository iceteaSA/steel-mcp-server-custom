import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Page } from "patchright";
import { BrowserManager, type Env } from "./manager.js";

// A random process offset reduces restart collisions. Leave half the safe range for growth.
let nextTabId = Number(randomBytes(8).readBigUInt64BE() >> 12n);

type CloseReason = "idle" | "close_lane" | "restart" | "session-ended";
type Lane = {
  caller: string;
  manager: BrowserManager;
  created: number;
  touched: number;
  closing: boolean;
  running: Set<Promise<unknown>>;
  queues: Map<number, Promise<void>>;
  pageStarting?: Promise<Page>;
  disposal?: Promise<void>;
  newlyOpened: boolean;
};

export interface LaneOptions {
  manager: BrowserManager;
  env: Env;
  now?: () => number;
}

const STATELESS = new Set(["list_profiles", "credentials", "captcha_status"]);
const SIGNIN_TOOLS = new Set(["request_signin", "signin_status", "cancel_signin"]);
const CONTEXT_TOOLS = new Set([
  "new_tab",
  "list_tabs",
  "start_browser",
  "cookies",
  "create_profile",
  "save_profile",
  "delete_profile",
  "get_console",
  "get_network",
  "export_har",
  "fetch_urls",
  "smoke_test",
]);

export class LaneRuntime {
  private readonly current = new AsyncLocalStorage<{
    lane: Lane;
    tabId?: number;
    completion?: Promise<void>;
    closeTabIds?: number[];
  }>();
  private readonly lanes = new Map<string, Lane>();
  private readonly opening = new Map<string, Promise<Lane>>();
  private readonly closed = new Map<string, { reason: CloseReason; at: number }>();
  private readonly now: () => number;
  private readonly profileCaller = new AsyncLocalStorage<string | undefined>();
  private readonly timer: ReturnType<typeof setInterval>;
  private stopping = false;
  private readonly endedCleanup = new Set<Promise<void>>();
  private readonly unsubscribe: () => void;
  readonly manager: BrowserManager;

  constructor(private readonly options: LaneOptions) {
    this.now = options.now ?? Date.now;
    options.manager.enableLanes();
    this.unsubscribe = options.manager.onSessionEnded(() => {
      const at = this.now();
      for (const caller of [...this.lanes.keys(), ...this.opening.keys()]) {
        this.rememberClosed(caller, "session-ended", at);
      }
      for (const lane of this.lanes.values()) {
        lane.closing = true;
        const cleanup = lane.manager.stop();
        this.endedCleanup.add(cleanup);
        void cleanup.then(
          () => this.endedCleanup.delete(cleanup),
          () => this.endedCleanup.delete(cleanup),
        );
      }
      this.lanes.clear();
    });
    // Request scope selects the lane. Concurrent calls do not move shared state.
    this.manager = new Proxy(options.manager, {
      get: (_root, property) => {
        if (property === "listProfiles") return () => this.listProfiles();
        const scope = this.current.getStore();
        if (!scope)
          throw new Error('no_caller: send _meta["ai.opencode/sessionID"] on tools/call.');
        const { lane, tabId } = scope;
        if (property === "closeTabsByOwner" && scope.closeTabIds) {
          return async (owner: string) => {
            const closed: number[] = [];
            for (const id of scope.closeTabIds!) {
              if (lane.manager.getTabOwner(id) !== owner) continue;
              try {
                await lane.manager.closeTab(id);
                closed.push(id);
              } catch {
                /* A page can close itself before its queued cleanup. */
              }
            }
            return closed;
          };
        }
        if (tabId !== undefined) {
          if (property === "activeTabId") return tabId;
          if (property === "getPage") {
            return (arg?: number | { tabId?: number; owner?: string; force?: boolean }) =>
              typeof arg === "number"
                ? lane.manager.getPage(arg)
                : lane.manager.getPage({ ...arg, tabId: arg?.tabId ?? tabId });
          }
          if (property === "resolveTab") {
            return (opts: { tabId?: number; owner?: string; force?: boolean }) =>
              lane.manager.resolveTab({ ...opts, tabId: opts.tabId ?? tabId });
          }
        }
        const value = Reflect.get(lane.manager, property, lane.manager);
        return typeof value === "function" ? value.bind(lane.manager) : value;
      },
    });
    this.timer = setInterval(
      () => {
        void this.sweep().catch((error: unknown) => {
          console.error(
            "[steel-mcp] lane sweep failed:",
            error instanceof Error ? error.message : String(error),
          );
        });
      },
      Math.min(options.env.LANE_IDLE_MS, 60000),
    );
    this.timer.unref?.();
  }

  private async listProfiles() {
    const profiles = new Map(
      (await this.options.manager.listProfiles()).map((p) => [
        p.name,
        { ...p, active: false, tabCount: 0 },
      ]),
    );
    const caller = this.profileCaller.getStore();
    const lane = caller ? this.lanes.get(caller) : undefined;
    if (lane && !lane.closing) {
      for (const profile of await lane.manager.listProfiles()) {
        if (profile.active) profiles.set(profile.name, profile);
      }
    }
    return [...profiles.values()];
  }

  getCaller(): string | undefined {
    return this.profileCaller.getStore() ?? this.current.getStore()?.lane.caller;
  }

  async applyProfileUpdated(profile: string): Promise<boolean> {
    if (this.stopping) return false;
    // The `0` key prevents `profile` changes during a live update.
    const results = await Promise.all(
      [...this.lanes.values()]
        .filter((lane) => !lane.closing && lane.manager.hasProfile(profile))
        .map(async (lane) => {
          const operation = this.queue(lane, [0, ...lane.manager.tabIds], () =>
            lane.closing ? Promise.resolve(false) : lane.manager.applyProfileUpdated(profile),
          );
          lane.running.add(operation);
          try {
            const applied = await operation;
            if (applied) lane.touched = this.now();
            return applied;
          } finally {
            lane.running.delete(operation);
          }
        }),
    );
    return results.some(Boolean);
  }

  private async open(caller: string, mayWait = true): Promise<Lane> {
    const existing = this.lanes.get(caller);
    if (existing && !existing.closing) return existing;
    const pending = this.opening.get(caller);
    if (pending) return pending;
    if (existing?.closing && existing.disposal && mayWait && !this.stopping) {
      await existing.disposal;
      return this.open(caller, false);
    }
    if (existing?.closing || this.stopping)
      throw new Error("lane_closed: lane is closing; retry without a tabId.");
    if (new Set([...this.lanes.keys(), ...this.opening.keys()]).size >= this.options.env.LANE_MAX) {
      throw new Error(
        "lanes_full: lane capacity reached. Use list_lanes to inspect usage and close_lane to release your lane, then retry.",
      );
    }
    const promise = (async () => {
      let lane: Lane;
      const manager = await this.options.manager.createLane(
        () => {
          if (nextTabId >= Number.MAX_SAFE_INTEGER)
            throw new Error("lane_closed: numeric tab IDs exhausted; restart the MCP process.");
          return ++nextTabId;
        },
        (id) => {
          const scope = this.current.getStore();
          if (scope?.lane !== lane || !scope.completion) return;
          // A new tab is available before navigation ends. Hold its queue until the tool returns.
          const completion = scope.completion;
          lane.queues.set(id, completion);
          void completion.then(() => {
            if (lane.queues.get(id) === completion) lane.queues.delete(id);
          });
        },
      );
      lane = {
        caller,
        manager,
        created: this.now(),
        touched: this.now(),
        closing: false,
        running: new Set(),
        queues: new Map(),
        newlyOpened: true,
      };
      this.lanes.set(caller, lane);
      return lane;
    })();
    this.opening.set(caller, promise);
    try {
      return await promise;
    } finally {
      this.opening.delete(caller);
    }
  }

  private checkTab(caller: string, tabId: number): void {
    const own = this.lanes.get(caller);
    if (own && !own.closing && !own.manager.isLaneClosed && own.manager.hasTab(tabId)) return;
    if (this.options.manager.hasTab(tabId)) {
      throw new Error("not_in_lane: the tab belongs to the operator's default context.");
    }
    for (const lane of this.lanes.values()) {
      if (lane.caller !== caller && lane.manager.hasTab(tabId)) {
        throw new Error(
          "not_in_lane: the tab is not in the caller's lane. Use list_tabs for your tabs.",
        );
      }
    }
    throw new Error(
      "lane_closed: tab is closed or predates this MCP process. Omit tabId to open a fresh lane.",
    );
  }

  private queue<T>(lane: Lane, ids: number[], operation: () => Promise<T>): Promise<T> {
    const keys = [...new Set(ids)].sort((a, b) => a - b);
    const previous = keys.map((id) => lane.queues.get(id) ?? Promise.resolve());
    const result = Promise.all(previous).then(operation);
    const tail = result.then(
      () => {},
      () => {},
    );
    for (const id of keys) lane.queues.set(id, tail);
    void tail.then(() => {
      for (const id of keys) if (lane.queues.get(id) === tail) lane.queues.delete(id);
    });
    return result;
  }

  private dispose(lane: Lane, reason: CloseReason): Promise<void> {
    if (lane.disposal) return lane.disposal;
    lane.closing = true;
    lane.disposal = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(lane.running),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.options.env.LANE_DRAIN_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      await lane.manager.stop();
      if (this.lanes.get(lane.caller) === lane) {
        this.rememberClosed(lane.caller, reason);
        this.lanes.delete(lane.caller);
      }
    })();
    return lane.disposal;
  }

  private pruneClosed(): void {
    const cutoff = this.now() - 24 * 60 * 60 * 1000;
    for (const [caller, record] of this.closed) {
      if (record.at <= cutoff) this.closed.delete(caller);
    }
    while (this.closed.size > 1000) this.closed.delete(this.closed.keys().next().value!);
  }

  private rememberClosed(caller: string, reason: CloseReason, at = this.now()): void {
    this.closed.delete(caller);
    this.closed.set(caller, { reason, at });
    this.pruneClosed();
  }

  async sweep(): Promise<void> {
    this.pruneClosed();
    await Promise.all(
      [...this.lanes.values()]
        .filter(
          (lane) =>
            !lane.closing &&
            (lane.manager.isLaneClosed ||
              this.now() - lane.touched >= this.options.env.LANE_IDLE_MS),
        )
        .map((lane) => this.dispose(lane, lane.manager.isLaneClosed ? "restart" : "idle")),
    );
  }

  async run(
    name: string,
    args: Record<string, unknown>,
    meta: Record<string, unknown> | undefined,
    handler: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const caller = meta?.["ai.opencode/sessionID"];
    const hasCaller = typeof caller === "string" && caller.trim().length > 0;
    if (name === "list_profiles")
      return this.profileCaller.run(hasCaller ? caller : undefined, handler);
    const credentialWrite =
      name === "credentials" && typeof args.name === "string" && args.name.length > 0;
    if (STATELESS.has(name) && !credentialWrite) return handler();
    if (!hasCaller) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: 'no_caller: send params._meta["ai.opencode/sessionID"] on every tools/call; no shared fallback lane exists.',
          },
        ],
      };
    }
    if (credentialWrite) {
      const result = await handler();
      if (!result.isError)
        console.error(
          JSON.stringify({
            event: args.remove ? "credentials.delete" : "credentials.write",
            caller,
          }),
        );
      return result;
    }
    if (SIGNIN_TOOLS.has(name)) return this.profileCaller.run(caller, handler);
    const notes: string[] = [];
    if (args.force !== undefined) notes.push("NOTE: force is accepted and ignored in lane mode.");
    const finish = (result: CallToolResult): CallToolResult =>
      notes.length
        ? { ...result, content: [...result.content, { type: "text", text: notes.join("\n") }] }
        : result;
    try {
      await this.sweep();
      if (typeof args.tabId === "number") this.checkTab(caller, args.tabId);
      if (name === "list_lanes") {
        const lanes = [...this.lanes.values()].map((lane) => ({
          caller: lane.caller,
          ageSeconds: Math.max(0, (this.now() - lane.created) / 1000),
          tabCount: lane.manager.tabIds.length,
        }));
        return finish({
          content: [{ type: "text", text: JSON.stringify(lanes) }],
          structuredContent: { lanes },
        });
      }
      if (name === "close_lane" || name === "stop_browser") {
        if (
          name === "stop_browser" &&
          [...this.lanes.keys(), ...this.opening.keys()].some((key) => key !== caller)
        ) {
          throw new Error(
            "stop_browser refused: another lane is active. Use close_lane to close only your lane.",
          );
        }
        const pending = this.opening.get(caller);
        const lane = pending ? await pending : this.lanes.get(caller);
        if (lane) await this.dispose(lane, "close_lane");
        return finish({
          content: [
            {
              type: "text",
              text: "Lane closed; the shared browser and operator context remain open.",
            },
          ],
        });
      }
      const lane = await this.open(caller);
      if (lane.closing || lane.manager.isLaneClosed)
        throw new Error("lane_closed: lane closed before admission; retry without a tabId.");
      this.pruneClosed();
      const previous = this.closed.get(caller);
      if (previous) {
        notes.push(
          `NOTE: Previous lane closed (${previous.reason}) at ${new Date(previous.at).toISOString()}; cookies, tabs and buffers were reset.`,
        );
        this.closed.delete(caller);
      } else if (lane.newlyOpened) {
        notes.push("NOTE: New lane opened; no previous state was restored.");
      }
      lane.newlyOpened = false;
      lane.touched = this.now();
      let complete!: () => void;
      const completion = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const operation = this.current.run({ lane }, async () => {
        let ids: number[] = [];
        if (typeof args.tabId === "number") ids = [args.tabId];
        if (name === "close_tabs" && typeof args.owner === "string") {
          ids.push(
            ...lane.manager.tabIds.filter((id) => lane.manager.getTabOwner(id) === args.owner),
          );
        } else if (typeof args.tabId !== "number" && !CONTEXT_TOOLS.has(name)) {
          if (!lane.manager.hasTab(lane.manager.activeTabId)) {
            lane.pageStarting ??= lane.manager.getPage().finally(() => {
              lane.pageStarting = undefined;
            });
            await lane.pageStarting;
          }
          ids = [lane.manager.activeTabId];
        }
        if (name === "close_tabs" && args.tabId === undefined && args.owner === undefined)
          args.tabId = ids[0];
        const profileMutation =
          name === "create_profile" ||
          name === "delete_profile" ||
          (name === "new_tab" && typeof args.profile === "string");
        return this.queue(lane, profileMutation ? [0, ...ids] : ids, async () => {
          if (lane.manager.isLaneClosed)
            throw new Error("lane_closed: context closed while the call was queued.");
          return this.current.run(
            {
              lane,
              tabId: ids.length === 1 ? ids[0] : undefined,
              completion,
              ...(name === "close_tabs" ? { closeTabIds: ids } : {}),
            },
            handler,
          );
        });
      });
      lane.running.add(operation);
      try {
        const result = await operation;
        if (lane.manager.isLaneClosed)
          throw new Error("lane_closed: session ended during the call; retry without a tabId.");
        return finish(result);
      } finally {
        complete();
        lane.running.delete(operation);
        lane.touched = this.now();
      }
    } catch (error) {
      return finish({
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      });
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    this.unsubscribe();
    clearInterval(this.timer);
    await Promise.allSettled(this.opening.values());
    await Promise.all([...this.lanes.values()].map((lane) => this.dispose(lane, "close_lane")));
    await Promise.allSettled(this.endedCleanup);
  }
}
