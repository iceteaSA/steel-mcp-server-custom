import { describe, expect, it } from "bun:test";
import { solveTask } from "../capsolver.js";

const task = {
  type: "ReCaptchaV2TaskProxyLess",
  websiteURL: "https://example.test/form",
  websiteKey: "public-site-key",
};
const ready = { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "private-result" } };

function client(responses: Array<unknown | Error>, timeoutMs = 10000) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let now = 0;
  return {
    requests,
    run: () =>
      solveTask(task, {
        apiKey: "private-key",
        timeoutMs,
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          const response = responses.shift() ?? { errorId: 0, status: "processing" };
          if (response instanceof Error) throw response;
          return response instanceof Response ? response : Response.json(response);
        }) as typeof fetch,
        now: () => now,
        sleep: async (ms: number) => {
          now += ms;
        },
      }),
  };
}

describe("CapSolver REST client", () => {
  it("creates a task and polls until ready", async () => {
    const c = client([
      { errorId: 0, taskId: "task-1" },
      { errorId: 0, status: "processing" },
      ready,
    ]);
    expect(await c.run()).toBe("private-result");
    expect(c.requests.map((r) => r.url)).toEqual([
      "https://api.capsolver.com/createTask",
      "https://api.capsolver.com/getTaskResult",
      "https://api.capsolver.com/getTaskResult",
    ]);
    expect(c.requests[0].body).toEqual({ clientKey: "private-key", task });
    expect(c.requests[1].body).toEqual({ clientKey: "private-key", taskId: "task-1" });
  });
  it("accepts a synchronous solution", async () => {
    const c = client([ready]);
    expect(await c.run()).toBe("private-result");
    expect(c.requests).toHaveLength(1);
  });
  it("accepts Turnstile solution.token", async () => {
    expect(
      await client([
        { errorId: 0, status: "ready", solution: { token: "turnstile-result" } },
      ]).run(),
    ).toBe("turnstile-result");
  });
  for (const phase of ["create", "result"]) {
    it(`reports ${phase} errorId without leaking the response`, async () => {
      const responses = [
        {
          errorId: 1,
          errorCode: "ERROR_ZERO_BALANCE",
          errorDescription: "private-key private-result",
        },
      ];
      if (phase === "result") responses.unshift({ errorId: 0, taskId: "task-1" } as never);
      await expect(client(responses).run()).rejects.toThrow("ERROR_ZERO_BALANCE");
    });
  }
  it("bounds polling by timeout", async () => {
    const c = client([{ errorId: 0, taskId: "task-1" }], 1);
    await expect(c.run()).rejects.toThrow("timed out");
    expect(c.requests).toHaveLength(1);
  });
  it("uses stable host for failed result transport without creating again", async () => {
    const c = client([{ errorId: 0, taskId: "task-1" }, new Error("network private-key"), ready]);
    expect(await c.run()).toBe("private-result");
    expect(c.requests[2].url).toBe("https://api-stable.capsolver.com/getTaskResult");
    expect(c.requests.filter((r) => r.url.endsWith("/createTask"))).toHaveLength(1);
  });
  it("does not retry an ambiguous create failure and hides transport details", async () => {
    const c = client([new Error("private-key private-result")]);
    await expect(c.run()).rejects.toThrow("createTask transport failed");
    expect(c.requests).toHaveLength(1);
  });
  it("never makes more than 120 result queries", async () => {
    const c = client([{ errorId: 0, taskId: "task-1" }], 1000000);
    await expect(c.run()).rejects.toThrow("120");
    expect(c.requests).toHaveLength(121);
  });
  it("rejects malformed create and ready responses", async () => {
    await expect(client([{ errorId: 0 }]).run()).rejects.toThrow("taskId");
    await expect(client([{ errorId: 0, status: "ready", solution: {} }]).run()).rejects.toThrow(
      "token",
    );
  });
  for (const phase of ["create", "result"]) {
    it(`preserves HTTP 400 ${phase} API errors without retrying or leaking request values`, async () => {
      const responses: unknown[] = [
        Response.json(
          {
            errorId: 1,
            errorCode: "ERROR_INVALID_TASK_DATA",
            errorDescription:
              "invalid task data: invalid websiteKey (public-site-key); clientKey=private-key; taskId=task-1; token=private-result",
            taskId: "task-1",
            solution: { token: "private-result" },
          },
          { status: 400 },
        ),
      ];
      if (phase === "result") responses.unshift({ errorId: 0, taskId: "task-1" });
      const c = client(responses);
      let message = "";
      try {
        await c.run();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(
        "CapSolver ERROR_INVALID_TASK_DATA: invalid task data: invalid websiteKey",
      );
      for (const value of ["public-site-key", "private-key", "task-1", "private-result"])
        expect(message).not.toContain(value);
      expect(c.requests).toHaveLength(phase === "create" ? 1 : 2);
    });
  }
  it("bounds API descriptions and removes control characters", async () => {
    const c = client([
      Response.json(
        {
          errorId: 1,
          errorCode: "ERROR_INVALID_TASK_DATA",
          errorDescription: `invalid task data\n${"detail ".repeat(100)}\u001b[31m`,
        },
        { status: 400 },
      ),
    ]);
    let message = "";
    try {
      await c.run();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toStartWith("CapSolver ERROR_INVALID_TASK_DATA: invalid task data");
    expect(message.length).toBeLessThanOrEqual("CapSolver ERROR_INVALID_TASK_DATA: ".length + 240);
    expect(message).not.toMatch(/[\x00-\x1f\x7f]/);
  });
  it("treats non-JSON create bodies as transport failures without retry", async () => {
    const c = client([new Response("gateway private-key", { status: 502 })]);
    await expect(c.run()).rejects.toThrow("CapSolver createTask transport failed");
    expect(c.requests).toHaveLength(1);
  });
  it("uses result-host fallback for non-JSON transport responses", async () => {
    const c = client([
      { errorId: 0, taskId: "task-1" },
      new Response("gateway", { status: 502 }),
      ready,
    ]);
    expect(await c.run()).toBe("private-result");
    expect(c.requests[2].url).toBe("https://api-stable.capsolver.com/getTaskResult");
  });
});
