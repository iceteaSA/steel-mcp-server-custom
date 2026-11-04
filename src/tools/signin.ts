import type { SigninCaller, SigninInput, SigninRequest, SigninStore } from "../signin.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolRegistrar } from "./shared.js";

function result(request: SigninRequest) {
  const { id, status, site, profile, created, expires, counts, note } = request;
  const error =
    status === "denied" || status === "expired" || status === "cancelled"
      ? `signin_${status}`
      : undefined;
  return {
    id,
    status,
    site,
    profile,
    created,
    expires,
    ...counts,
    ...(note !== undefined ? { note } : {}),
    ...(error ? { error } : {}),
  };
}

export async function request_signin(
  store: SigninStore,
  caller: SigninCaller,
  input: SigninInput & { wait?: number },
) {
  const wait = input.wait ?? 0;
  if (!Number.isFinite(wait) || wait < 0 || wait > 120) throw new Error("invalid_wait");
  const request = await store.create(caller, input);
  return result(wait ? await store.wait(caller, request.id, wait) : request);
}

export async function signin_status(
  store: SigninStore,
  caller: SigninCaller,
  { id }: { id: string },
) {
  return result(await store.status(caller, id));
}

export async function cancel_signin(
  store: SigninStore,
  caller: SigninCaller,
  { id }: { id: string },
) {
  return result(await store.cancel(caller, id));
}

export function registerSignin(
  register: ToolRegistrar,
  getStore: () => Promise<SigninStore>,
  getCaller: () => string,
): void {
  // `signin_unknown` has only `error`, with no request metadata.
  const outputSchema = {
    id: z.string().optional(),
    status: z.enum(["pending", "approved", "denied", "expired", "cancelled"]).optional(),
    site: z.string().optional(),
    profile: z.string().optional(),
    created: z.number().optional(),
    expires: z.number().optional(),
    cookieCount: z.number().optional(),
    storageKeyCount: z.number().optional(),
    note: z.string().optional(),
    error: z.string().optional(),
  };
  const execute = async (
    operation: (store: SigninStore, caller: SigninCaller) => Promise<ReturnType<typeof result>>,
  ): Promise<CallToolResult> => {
    try {
      const value = await operation(await getStore(), { sessionID: getCaller() });
      return {
        ...(value.error ? { isError: true } : {}),
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
      };
    } catch (error) {
      const code =
        error instanceof Error &&
        /^(?:signin_[a-z_]+|no_caller|rate_limited|invalid_wait|invalid_caller|invalid_request|invalid_site)$/.test(
          error.message,
        )
          ? error.message
          : "signin_unavailable";
      return {
        isError: true,
        content: [{ type: "text", text: code }],
        structuredContent: { error: code },
      };
    }
  };
  register({
    name: "request_signin",
    title: "Request Sign-in",
    description:
      "Request operator approval for one site and `profile`. Get request status and counts, not state values. `wait` is seconds, at most 120. Approval does not prove that the site accepts the state.",
    toolset: "auth",
    inputSchema: {
      site: z.string().min(1),
      profile: z.string().min(1),
      reason: z.string().min(1).max(1000),
      wait: z.number().min(0).max(120).optional(),
    },
    outputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: (input: SigninInput & { wait?: number }) =>
      execute((store, caller) => request_signin(store, caller, input)),
  });
  register({
    name: "signin_status",
    title: "Sign-in Status",
    description:
      "Read your sign-in request status and counts, not state values. IDs from a different caller give `signin_unknown`.",
    toolset: "auth",
    inputSchema: { id: z.string().min(1) },
    outputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: (input: { id: string }) =>
      execute((store, caller) => signin_status(store, caller, input)),
  });
  register({
    name: "cancel_signin",
    title: "Cancel Sign-in",
    description:
      "Cancel your pending sign-in request. This does not delete saved state. IDs from a different caller give `signin_unknown`.",
    toolset: "auth",
    inputSchema: { id: z.string().min(1) },
    outputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: (input: { id: string }) =>
      execute((store, caller) => cancel_signin(store, caller, input)),
  });
}
