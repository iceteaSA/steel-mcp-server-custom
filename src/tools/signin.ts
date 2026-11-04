import type { SigninCaller, SigninInput, SigninRequest, SigninStore } from "../signin.js";

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
