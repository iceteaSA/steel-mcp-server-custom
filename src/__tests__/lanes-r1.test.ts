import { expect, test, spyOn } from "bun:test";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { EnvSchema } from "../env.js";
import { BrowserManager } from "../manager.js";
import { LaneRuntime } from "../lanes.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function bounded<T>(promise: Promise<T>, ms = 300): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("lifecycle deadline exceeded")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fixture(overrides: Record<string, string> = {}) {
  const env = EnvSchema.parse({
    BROWSER_MODE: "local",
    STEEL_LANES: "on",
    LANE_IDLE_MS: "100",
    LANE_DRAIN_MS: "20",
    ...overrides,
  });
  const root = new BrowserManager(env);
  let now = 1000;
  let starts = 0;
  const managers: BrowserManager[] = [];
  Object.assign(root, {
    createLane: async () => {
      starts++;
      const child = new BrowserManager(env);
      child.stop = async () => {};
      managers.push(child);
      return child;
    },
  });
  const runtime = new LaneRuntime({ manager: root, env, now: () => now });
  const state = runtime as unknown as {
    closed: Map<string, { reason: string; at: number }>;
    lanes: Map<string, { manager: BrowserManager; closing: boolean }>;
  };
  const call = (caller: string, name = "new_tab", handler = async () => ({ content: [] })) =>
    runtime.run(
      name,
      {},
      { "ai.opencode/sessionID": caller },
      name === "close_lane" || name === "list_lanes" ? () => runtime.control(name) : handler,
    );
  return {
    runtime,
    state,
    root,
    env,
    call,
    managers,
    starts: () => starts,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("R1 P2: close_lane bounds a held handler drain, closes its context, and permits reopen", async () => {
  const f = fixture();
  const entered = barrier();
  const held = barrier();
  const running = f.call("a", "new_tab", async () => {
    entered.release();
    await held.promise;
    return { content: [] };
  });
  await entered.promise;
  const stop = spyOn(f.managers[0], "stop");
  const closing = f.call("a", "close_lane");
  try {
    expect((await bounded(closing)).isError).not.toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect((await bounded(f.call("a"))).isError).not.toBe(true);
    expect(f.starts()).toBe(2);
  } finally {
    held.release();
    await running;
    await closing;
    await f.runtime.close();
  }
});

test("R1 P2 idle: an expired lane with a hung handler is drained and closed", async () => {
  const f = fixture();
  const entered = barrier();
  const held = barrier();
  const running = f.call("a", "new_tab", async () => {
    entered.release();
    await held.promise;
    return { content: [] };
  });
  await entered.promise;
  const stop = spyOn(f.managers[0], "stop");
  try {
    f.advance(101);
    await bounded(f.runtime.sweep());
    expect(stop).toHaveBeenCalledTimes(1);
    expect(f.state.lanes.size).toBe(0);
  } finally {
    held.release();
    await running;
    await f.runtime.close();
  }
});

test("R1 a young in-flight call survives the old idle deadline, then drains only after its own idle interval", async () => {
  const f = fixture();
  const entered = barrier();
  const held = barrier();
  await f.call("a");
  f.advance(99);
  const running = f.call("a", "new_tab", async () => {
    entered.release();
    await held.promise;
    return { content: [] };
  });
  await entered.promise;
  const stop = spyOn(f.managers[0], "stop");
  try {
    f.advance(2);
    await f.runtime.sweep();
    expect(stop).not.toHaveBeenCalled();
    expect(f.state.lanes.size).toBe(1);
    f.advance(99);
    await bounded(f.runtime.sweep());
    expect(stop).toHaveBeenCalledTimes(1);
    expect(f.state.lanes.size).toBe(0);
  } finally {
    held.release();
    await running;
    await f.runtime.close();
  }
});

test("R1 P3b: no-ID admission waits for the sweep's held disposal then reopens once", async () => {
  const f = fixture();
  const entered = barrier();
  const held = barrier();
  await f.call("a");
  f.managers[0].stop = async () => {
    entered.release();
    await held.promise;
  };
  f.advance(101);
  const sweeping = f.runtime.sweep();
  await entered.promise;
  const racing = f.call("a");
  try {
    held.release();
    const result = await racing;
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("Previous lane closed (idle)");
    expect(f.starts()).toBe(2);
  } finally {
    held.release();
    await sweeping;
    await f.runtime.close();
  }
});

test("R1 lane capacity includes in-flight opens but never rejects an existing lane", async () => {
  const f = fixture({ LANE_MAX: "2" });
  const entered = barrier();
  const held = barrier();
  const create = f.root.createLane.bind(f.root);
  let entering = 0;
  f.root.createLane = async (...args) => {
    if (++entering === 2) entered.release();
    await held.promise;
    return create(...args);
  };
  const a = f.call("a");
  const b = f.call("b");
  await entered.promise;
  try {
    const denied = await bounded(f.call("c"));
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("lanes_full");
    expect(JSON.stringify(denied)).toContain("close_lane");
    expect(JSON.stringify(denied)).toContain("list_lanes");
    held.release();
    await Promise.all([a, b]);
    expect((await f.call("a")).isError).not.toBe(true);
    expect(f.starts()).toBe(2);
  } finally {
    held.release();
    await Promise.all([a, b]);
    await f.runtime.close();
  }
});

test("R1 closed records evict oldest callers at 1000 and expire after 24 hours", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 1005; i++) {
      await f.call(String(i));
      await f.call(String(i), "close_lane");
    }
    expect(f.state.closed.size).toBe(1000);
    expect(f.state.closed.has("0")).toBe(false);
    expect(f.state.closed.has("1004")).toBe(true);
    f.advance(24 * 60 * 60 * 1000 + 1);
    await f.runtime.sweep();
    expect(f.state.closed.size).toBe(0);
    const reopened = await f.call("1004");
    expect(JSON.stringify(reopened)).toContain("NOTE:");
    expect(JSON.stringify(reopened)).not.toContain("Previous lane closed");
  } finally {
    await f.runtime.close();
  }
});

test("R1 bogus IDs neither create closure history nor report a fictional restart", async () => {
  const f = fixture();
  try {
    const result = await f.runtime.run(
      "evaluate",
      { tabId: 123 },
      { "ai.opencode/sessionID": "new" },
      async () => ({ content: [] }),
    );
    expect(JSON.stringify(result)).toContain("lane_closed");
    expect(f.state.closed.size).toBe(0);
    expect(JSON.stringify(await f.call("new"))).not.toContain("Previous lane closed");
  } finally {
    await f.runtime.close();
  }
});

test("R1 numeric tab IDs use process randomness rather than process-relative hrtime", () => {
  const script = `
    process.hrtime.bigint = () => 1234n;
    const { LaneRuntime } = await import('./src/lanes.ts');
    const { BrowserManager } = await import('./src/manager.ts');
    const { EnvSchema } = await import('./src/env.ts');
    const env = EnvSchema.parse({ BROWSER_MODE: 'local', STEEL_LANES: 'on' });
    const root = new BrowserManager(env);
    let id;
    root.createLane = async (allocate) => { id = allocate(); const child = new BrowserManager(env); child.stop = async () => {}; return child; };
    const runtime = new LaneRuntime({ manager: root, env });
    await runtime.run('new_tab', {}, { 'ai.opencode/sessionID': 'a' }, async () => ({ content: [] }));
    await runtime.close();
    console.log(id);
  `;
  const run = () => {
    const child = spawnSync("bun", ["--eval", script], {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
    const id = Number(child.stdout.trim());
    expect(Number.isSafeInteger(id)).toBe(true);
    return id;
  };
  expect(run()).not.toBe(run());
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`R1 actual index ${signal} callback exits within drain grace plus two seconds`, async () => {
    const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
    const start = source.indexOf('process.on("SIGINT"');
    expect(start).toBeGreaterThan(0);
    const script = `const env = { STEEL_LANES: 'on', LANE_DRAIN_MS: 20 }; let stopping = false; const signinStore = Promise.resolve({ shutdown: async () => console.log('store-flushed') }); const relayServer = { close: callback => { console.log('relay-closed'); callback(); } }; const closeLanes = () => new Promise(() => {}); const rootManager = { stop: async () => {} }; ${source.slice(start)}; console.log('ready'); setInterval(() => {}, 1000);`;
    const child = Bun.spawn(["node", "--eval", script], {
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    });
    const output = child.stdout.getReader();
    try {
      const ready = await bounded(output.read(), 1000);
      expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
      const at = performance.now();
      child.kill(signal);
      expect(await bounded(child.exited, 2020)).toBe(0);
      const elapsed = performance.now() - at;
      expect(elapsed).toBeLessThan(2020);
      let cleanup = "";
      while (true) {
        const chunk = await bounded(output.read(), 1000);
        if (chunk.done) break;
        cleanup += new TextDecoder().decode(chunk.value);
      }
      expect(cleanup).toContain("store-flushed");
      expect(cleanup).toContain("relay-closed");
      console.error(`Measured ${signal} exit: ${elapsed.toFixed(2)} ms (bound 2020 ms)`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await bounded(child.exited, 1000);
      output.releaseLock();
    }
  }, 20000);
}

test("R1 validates bounded lifecycle defaults", () => {
  const env = EnvSchema.parse({ BROWSER_MODE: "local" });
  expect(env).toHaveProperty("LANE_DRAIN_MS", 5000);
  expect(env).toHaveProperty("LANE_MAX", 8);
  expect(EnvSchema.safeParse({ BROWSER_MODE: "local", LANE_MAX: 0 }).success).toBe(false);
  expect(EnvSchema.safeParse({ BROWSER_MODE: "local", LANE_DRAIN_MS: -1 }).success).toBe(false);
});
