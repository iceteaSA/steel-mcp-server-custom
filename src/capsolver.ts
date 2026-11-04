export interface CaptchaTask {
  type: string;
  websiteURL: string;
  websiteKey: string;
  pageAction?: string;
  isInvisible?: boolean;
  recaptchaDataSValue?: string;
  metadata?: { action?: string; cdata?: string };
}

interface TaskResponse {
  errorId: number;
  errorCode?: string;
  taskId?: string;
  status?: string;
  solution?: { gRecaptchaResponse?: string; token?: string };
}

export interface SolverOptions {
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function solveTask(task: CaptchaTask, options: SolverOptions): Promise<string> {
  if (!options.apiKey) throw new Error("CAPSOLVER_API_KEY is not configured");
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + options.timeoutMs;
  let host = "https://api.capsolver.com";
  let queries = 0;

  async function post(method: "createTask" | "getTaskResult", body: object): Promise<TaskResponse> {
    if (now() >= deadline) throw new Error("CapSolver timed out");
    if (method === "getTaskResult" && ++queries > 120) {
      throw new Error("CapSolver reached the 120 result-query limit");
    }
    let response: Response;
    try {
      response = await request(`${host}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: options.apiKey, ...body }),
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now()))),
      });
      if (!response.ok) throw new Error("HTTP failure");
    } catch {
      if (now() >= deadline) throw new Error("CapSolver timed out");
      // A lost create response can still mean a paid task. Do not create it twice.
      if (method === "getTaskResult" && host === "https://api.capsolver.com") {
        host = "https://api-stable.capsolver.com";
        return post(method, body);
      }
      throw new Error(`CapSolver ${method} transport failed`);
    }
    let data: TaskResponse;
    try {
      data = (await response.json()) as TaskResponse;
    } catch {
      throw new Error("CapSolver returned invalid JSON");
    }
    if (!data || typeof data.errorId !== "number")
      throw new Error("CapSolver returned an invalid response");
    if (data.errorId !== 0) {
      // Remote error descriptions can contain request values, including the key.
      const code =
        /^ERROR_[A-Z0-9_]{1,80}$/.test(data.errorCode ?? "") &&
        !data.errorCode?.includes(options.apiKey)
          ? data.errorCode
          : "API_ERROR";
      throw new Error(`CapSolver ${code}`);
    }
    return data;
  }

  function token(data: TaskResponse): string {
    const value = data.solution?.gRecaptchaResponse ?? data.solution?.token;
    if (typeof value !== "string" || !value.trim())
      throw new Error("CapSolver ready response has no token");
    return value;
  }

  const created = await post("createTask", { task });
  if (created.status === "ready") return token(created);
  if (typeof created.taskId !== "string" || !created.taskId)
    throw new Error("CapSolver response has no taskId");
  while (queries < 120) {
    await sleep(Math.min(3000, Math.max(0, deadline - now())));
    if (now() >= deadline) throw new Error("CapSolver timed out");
    const result = await post("getTaskResult", { taskId: created.taskId });
    if (result.status === "ready") return token(result);
    if (result.status !== "processing" && result.status !== "idle")
      throw new Error("CapSolver returned an invalid task status");
  }
  throw new Error("CapSolver reached the 120 result-query limit");
}
