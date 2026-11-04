import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { isIP } from "node:net";
import { getDomain } from "tldts";
import { isValidProfileName } from "./helpers.js";

export interface SigninCaller {
  sessionID: string;
  agent?: string;
  title?: string;
}
export interface SigninInput {
  site: string;
  profile: string;
  reason: string;
}
export interface SigninCounts {
  cookieCount: number;
  storageKeyCount: number;
}
export interface SigninRequest extends SigninInput {
  id: string;
  caller: SigninCaller;
  domains: string[];
  created: number;
  expires: number;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  note?: string;
  counts?: SigninCounts;
  notified?: boolean;
  remembered?: boolean;
  consumed?: boolean;
}
export interface SigninGrant {
  id: string;
  site: string;
  profile: string;
  created: number;
  expires: number;
}
interface SavedState {
  requests: SigninRequest[];
  grants: SigninGrant[];
  history: { sessionID: string; time: number }[];
}
export interface SigninOptions {
  profilesDir: string;
  now?: () => number;
  automaticTimers?: boolean;
  ntfyTopicFile?: string;
}

export function normalizeSite(value: string): { site: string; host: string; domains: string[] } {
  try {
    if (typeof value !== "string" || value.length > 2048) throw new Error();
    const origin = value.includes("://");
    const url = new URL(origin ? value : `https://${value}`);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error();
    const host = url.hostname.toLowerCase();
    if (host.endsWith(".") || host.includes("..")) throw new Error();
    const domain = getDomain(host, { allowPrivateDomains: true });
    if (
      !domain &&
      origin &&
      (host === "localhost" || isIP(host.startsWith("[") ? host.slice(1, -1) : host))
    ) {
      return { site: url.origin, host, domains: [host] };
    }
    if (!domain || (!origin && (host !== domain || value !== host))) throw new Error();
    const labels = host.split(".");
    const count = labels.length - domain.split(".").length;
    return {
      site: origin ? url.origin : domain,
      host,
      domains: Array.from({ length: count + 1 }, (_, index) => labels.slice(index).join(".")),
    };
  } catch {
    throw new Error("invalid_site");
  }
}

export class SigninStore extends EventEmitter {
  private state: SavedState = { requests: [], grants: [], history: [] };
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private constructor(private readonly options: SigninOptions) {
    super();
    this.now = options.now ?? Date.now;
  }

  static async open(options: SigninOptions): Promise<SigninStore> {
    const store = new SigninStore(options);
    await fs.mkdir(options.profilesDir, { recursive: true });
    try {
      const handle = await fs.open(store.stateFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("unsafe_signin_file");
        const state = JSON.parse(await handle.readFile("utf8")) as SavedState;
        if (
          !Array.isArray(state.requests) ||
          !Array.isArray(state.grants) ||
          !Array.isArray(state.history)
        )
          throw new Error("invalid_signin_file");
        store.state = state;
        for (const request of store.state.requests) {
          if (request.status === "pending" && request.consumed) {
            request.status = "denied";
            request.note = "Transfer interrupted. Create a new request.";
          }
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await store.tick();
    if (options.automaticTimers !== false) {
      store.timer = setInterval(() => {
        void store.tick().catch(() => {});
      }, 1000);
      store.timer.unref();
    }
    return store;
  }

  private get stateFile() {
    return path.join(this.options.profilesDir, ".signin-state.json");
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  private async save(): Promise<void> {
    const temporary = `${this.stateFile}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(this.state), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.stateFile);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    this.emit("change");
  }
  private copy<T>(value: T): T {
    return structuredClone(value);
  }
  private find(id: string): SigninRequest {
    const request = this.state.requests.find((item) => item.id === id);
    if (!request) throw new Error("signin_unknown");
    return request;
  }
  private own(caller: SigninCaller, id: string): SigninRequest {
    const request = this.find(id);
    if (request.caller.sessionID !== caller.sessionID) throw new Error("signin_unknown");
    return request;
  }
  private async expire(): Promise<void> {
    let changed = false;
    for (const request of this.state.requests) {
      if (request.status === "pending" && request.expires <= this.now()) {
        request.status = "expired";
        await this.audit(request, "expired");
        changed = true;
      }
    }
    const grants = this.state.grants.filter((grant) => grant.expires > this.now());
    const history = this.state.history.filter((item) => item.time > this.now() - 3_600_000);
    changed ||=
      grants.length !== this.state.grants.length || history.length !== this.state.history.length;
    this.state.grants = grants;
    this.state.history = history;
    for (const request of this.state.requests) {
      if (request.status !== "pending") continue;
      const remembered = grants.some(
        (grant) => grant.site === request.site && grant.profile === request.profile,
      );
      if (request.remembered !== remembered) {
        request.remembered = remembered;
        changed = true;
      }
    }
    if (changed) await this.save();
  }
  async create(caller: SigninCaller, input: SigninInput): Promise<SigninRequest> {
    return this.serial(async () => {
      if (!caller?.sessionID || typeof caller.sessionID !== "string") throw new Error("no_caller");
      if (
        caller.sessionID.length > 256 ||
        (caller.agent !== undefined &&
          (typeof caller.agent !== "string" || caller.agent.length > 256)) ||
        (caller.title !== undefined &&
          (typeof caller.title !== "string" || caller.title.length > 1000))
      )
        throw new Error("invalid_caller");
      if (
        !isValidProfileName(input.profile) ||
        typeof input.reason !== "string" ||
        !input.reason.trim() ||
        input.reason.length > 1000
      )
        throw new Error("invalid_request");
      const normalized = normalizeSite(input.site);
      await this.expire();
      const pending = this.state.requests.filter(
        (item) => item.status === "pending" && item.caller.sessionID === caller.sessionID,
      );
      const duplicate = pending.find(
        (item) => item.site === normalized.site && item.profile === input.profile,
      );
      if (duplicate) return this.copy(duplicate);
      if (
        pending.length >= 3 ||
        this.state.history.filter((item) => item.sessionID === caller.sessionID).length >= 10
      )
        throw new Error("rate_limited");
      const created = this.now();
      const request: SigninRequest = {
        id: crypto.randomUUID(),
        caller: {
          sessionID: caller.sessionID,
          ...(caller.agent !== undefined ? { agent: caller.agent } : {}),
          ...(caller.title !== undefined ? { title: caller.title } : {}),
        },
        site: normalized.site,
        domains: normalized.domains,
        profile: input.profile,
        reason: input.reason,
        created,
        expires: created + 300_000,
        status: "pending",
        remembered: this.state.grants.some(
          (grant) => grant.site === normalized.site && grant.profile === input.profile,
        ),
      };
      this.state.requests.push(request);
      this.state.history.push({ sessionID: caller.sessionID, time: created });
      await this.audit(request, request.remembered ? "remembered_request" : "requested");
      await this.save();
      return this.copy(request);
    });
  }
  async pending(): Promise<SigninRequest[]> {
    return this.serial(async () => {
      await this.expire();
      return this.copy(this.state.requests.filter((item) => item.status === "pending"));
    });
  }
  async status(caller: SigninCaller, id: string): Promise<SigninRequest> {
    return this.serial(async () => {
      await this.expire();
      return this.copy(this.own(caller, id));
    });
  }
  async request(id: string): Promise<SigninRequest> {
    return this.serial(async () => {
      await this.expire();
      return this.copy(this.find(id));
    });
  }
  async requirePending(id: string): Promise<SigninRequest> {
    const request = await this.request(id);
    if (request.status !== "pending")
      throw new Error(`signin_${request.status === "approved" ? "used" : request.status}`);
    return request;
  }
  private async finish(
    id: string,
    status: SigninRequest["status"],
    counts?: SigninCounts,
    note?: string,
    caller?: SigninCaller,
  ): Promise<SigninRequest> {
    return this.serial(async () => {
      await this.expire();
      const request = caller ? this.own(caller, id) : this.find(id);
      if (request.status !== "pending")
        throw new Error(`signin_${request.status === "approved" ? "used" : request.status}`);
      request.status = status;
      if (counts) request.counts = counts;
      if (note !== undefined) request.note = note.slice(0, 1000);
      await this.audit(request, status, counts);
      await this.save();
      return this.copy(request);
    });
  }
  approve(id: string, counts: SigninCounts): Promise<SigninRequest> {
    return this.finish(id, "approved", counts);
  }
  async consume(
    id: string,
    operation: {
      validate: (request: SigninRequest) => void;
      write: () => Promise<SigninCounts>;
      remember?: boolean;
      note?: string;
    },
  ): Promise<SigninRequest> {
    return this.serial(async () => {
      await this.expire();
      const request = this.find(id);
      if (request.status !== "pending" || request.consumed)
        throw new Error(
          `signin_${request.status === "approved" || request.consumed ? "used" : request.status}`,
        );
      operation.validate(this.copy(request));
      // Save the one-use fence before the state write. A restart cannot replay the write.
      request.consumed = true;
      await this.save();
      try {
        request.counts = await operation.write();
        request.status = "approved";
        if (operation.note !== undefined) request.note = operation.note.slice(0, 1000);
        if (operation.remember) {
          const created = this.now();
          this.state.grants = this.state.grants.filter(
            (grant) => grant.site !== request.site || grant.profile !== request.profile,
          );
          this.state.grants.push({
            id: crypto.randomUUID(),
            site: request.site,
            profile: request.profile,
            created,
            expires: created + 7 * 86_400_000,
          });
        }
        await this.audit(request, "approved", request.counts);
        await this.save();
        return this.copy(request);
      } catch (error) {
        request.status = "denied";
        request.note = "Transfer failed. Create a new request.";
        await this.save();
        throw error;
      }
    });
  }
  deny(id: string, note = ""): Promise<SigninRequest> {
    return this.finish(id, "denied", undefined, note);
  }
  cancel(caller: SigninCaller, id: string): Promise<SigninRequest> {
    return this.finish(id, "cancelled", undefined, undefined, caller);
  }
  async grants(): Promise<SigninGrant[]> {
    return this.serial(async () => {
      await this.expire();
      return this.copy(this.state.grants);
    });
  }
  async hasGrant(site: string, profile: string): Promise<boolean> {
    return (await this.grants()).some(
      (grant) => grant.site === normalizeSite(site).site && grant.profile === profile,
    );
  }
  async remember(site: string, profile: string): Promise<void> {
    await this.serial(async () => {
      const normalized = normalizeSite(site).site;
      if (!isValidProfileName(profile)) throw new Error("invalid_request");
      this.state.grants = this.state.grants.filter(
        (grant) => grant.site !== normalized || grant.profile !== profile,
      );
      const created = this.now();
      this.state.grants.push({
        id: crypto.randomUUID(),
        site: normalized,
        profile,
        created,
        expires: created + 7 * 86_400_000,
      });
      await this.save();
    });
  }
  async revoke(id: string): Promise<void> {
    await this.serial(async () => {
      this.state.grants = this.state.grants.filter((grant) => grant.id !== id);
      await this.save();
    });
  }
  async audit(
    request: SigninRequest | undefined,
    decision: string,
    counts: SigninCounts = { cookieCount: 0, storageKeyCount: 0 },
  ): Promise<void> {
    const file = path.join(this.options.profilesDir, ".signin-audit.jsonl");
    const handle = await fs.open(
      file,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      if (!(await handle.stat()).isFile()) throw new Error("unsafe_audit_file");
      await handle.chmod(0o600);
      await handle.writeFile(
        JSON.stringify({
          time: new Date(this.now()).toISOString(),
          caller: request?.caller ?? { sessionID: "unknown" },
          site: request?.site ?? "",
          profile: request?.profile ?? "",
          decision,
          ...counts,
        }) + "\n",
      );
    } finally {
      await handle.close();
    }
  }
  async wait(caller: SigninCaller, id: string, seconds: number): Promise<SigninRequest> {
    const end = Date.now() + seconds * 1000;
    while (true) {
      let wake!: () => void;
      const changed = new Promise<void>((resolve) => {
        wake = resolve;
      });
      this.once("change", wake);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const request = await this.status(caller, id);
        const remaining = Math.min(end - Date.now(), request.expires - this.now());
        if (request.status !== "pending" || remaining <= 0) return request;
        await Promise.race([
          changed,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remaining);
          }),
        ]);
      } finally {
        this.removeListener("change", wake);
        if (timer) clearTimeout(timer);
      }
    }
  }
  async tick(): Promise<void> {
    const file = this.options.ntfyTopicFile ?? process.env.STEEL_NTFY_TOPIC_FILE;
    const due = await this.serial(async () => {
      await this.expire();
      const requests: SigninRequest[] = [];
      for (const request of this.state.requests) {
        if (
          request.status !== "pending" ||
          request.notified ||
          this.now() - request.created < 60_000 ||
          !file
        )
          continue;
        request.notified = true;
        requests.push(this.copy(request));
      }
      if (requests.length) await this.save();
      return requests;
    });
    if (!file) return;
    for (const request of due) {
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
        const clean = (text: string) =>
          text
            .replace(/https?:\/\/[^\s]+/g, (value) => {
              try {
                return new URL(value).origin;
              } catch {
                return "[URL]";
              }
            })
            .replace(/\p{Cc}/gu, " ");
        const response = await fetch(url, {
          method: "POST",
          headers: { Priority: "high", "Content-Type": "text/plain; charset=utf-8" },
          body: `${clean(request.caller.agent ?? "Agent")} asks for ${request.site} sign-in into profile ${request.profile}: ${clean(request.reason).slice(0, 100)}`,
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        });
        if (!response.ok) throw new Error("ntfy_failed");
      } catch {
        await this.audit(request, "ntfy_failed");
      }
    }
  }
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.removeAllListeners();
  }
}
