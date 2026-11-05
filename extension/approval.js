import { relayRequest, signinPatterns, previewSignin, approveSignin } from "./core.js";
import { renderSigninReview } from "./signin-ui.js";

const $ = (id) => document.getElementById(id);
let request;
let busy = false;
let finished = false;
function status(message) {
  $("status").textContent = message;
}
function controls() {
  const expired = !request || request.expires <= Date.now();
  for (const id of ["inspect", "approve", "deny", "remember"])
    $(id).disabled = busy || expired || finished;
  $("countdown").textContent = finished
    ? "Request completed."
    : expired
      ? "Request expired. Ask the agent for a new request."
      : `Expires in ${Math.max(0, Math.ceil((request.expires - Date.now()) / 1000))} seconds`;
}
async function preview() {
  renderSigninReview($("review"), request, await previewSignin(request));
}
$("inspect").addEventListener("click", async () => {
  if (!request || busy || finished) return;
  let origins;
  try {
    origins = signinPatterns(request);
  } catch (error) {
    status(error.message);
    return;
  }
  const permission = chrome.permissions.request({ origins });
  busy = true;
  controls();
  try {
    if (!(await permission)) throw new Error("Site access was not granted.");
    await preview();
  } catch (error) {
    status(error.message);
  } finally {
    busy = false;
    controls();
  }
});
$("approve").addEventListener("click", async () => {
  if (!request || busy || finished) return;
  const transfer = approveSignin(request, $("remember").checked, $("note").value);
  busy = true;
  controls();
  try {
    const result = await transfer;
    finished = true;
    status(
      `Approved: ${result.cookieCount} cookies and ${result.storageKeyCount} storage keys transferred.${result.liveApplied === false ? " Saved state updated, but live apply failed. Reopen the profile in Steel." : ""}`,
    );
  } catch (error) {
    status(error.message);
  } finally {
    busy = false;
    controls();
  }
});
$("deny").addEventListener("click", async () => {
  if (!request || busy || finished) return;
  busy = true;
  controls();
  try {
    await relayRequest(`/signin/${encodeURIComponent(request.id)}/deny`, {
      method: "POST",
      body: { note: $("note").value },
    });
    finished = true;
    status("Request denied. No sign-in data was sent.");
  } catch (error) {
    status(error.message);
  } finally {
    busy = false;
    controls();
  }
});
async function init() {
  const id = new URL(location.href).searchParams.get("id");
  const { requests } = await relayRequest("/signin");
  request = requests.find((item) => item.id === id);
  if (!request)
    throw new Error(
      "Request no longer pending. It may have expired, completed, or been cancelled.",
    );
  await preview();
  controls();
}
void init().catch((error) => {
  status(error.message);
  controls();
});
const timer = setInterval(controls, 1000);
addEventListener("pagehide", () => clearInterval(timer), { once: true });
