import { relayRequest } from "./core.js";

function text(parent, tag, value) {
  const element = parent.ownerDocument.createElement(tag);
  element.textContent = value;
  parent.append(element);
  return element;
}

export function renderSigninReview(container, request, preview) {
  container.replaceChildren();
  text(container, "h2", request.site);
  text(container, "p", `Profile: ${request.profile}`);
  text(container, "p", `Agent: ${request.caller.agent ?? "Agent"}`);
  text(container, "p", `Task: ${request.caller.title ?? "Not supplied"}`);
  text(container, "p", `Reason: ${request.reason}`);
  text(container, "p", `Included cookie hosts: ${request.domains.join(", ")}`);
  text(container, "p", `Expires: ${new Date(request.expires).toLocaleString()}`);
  text(container, "h3", `${preview.cookieCount} cookies (names only)`);
  const cookies = text(container, "ul", "");
  for (const cookie of preview.cookies) text(cookies, "li", `${cookie.domain}: ${cookie.name}`);
  text(container, "h3", "localStorage origins and counts");
  for (const storage of preview.storage)
    text(container, "p", `${storage.origin}: ${storage.keyCount} keys`);
  if (!preview.storageAvailable)
    text(
      container,
      "p",
      "Storage unavailable. Keep this exact site origin open and grant its host access.",
    );
  text(
    container,
    "p",
    "Counts include granted hosts only. Inspect sign-in names to grant exact hosts before approval. Cookie and storage values are never displayed.",
  );
}

export function renderSigninList(container, requests, actions) {
  container.replaceChildren();
  if (!requests.length) text(container, "li", "No pending sign-in requests.");
  for (const request of requests) {
    const item = text(container, "li", "");
    text(
      item,
      "p",
      `${request.caller?.agent ?? "Agent"} asks for ${request.site} into profile ${request.profile}: ${request.reason}`,
    );
    if (request.caller?.title) text(item, "p", request.caller.title);
    const approve = text(item, "button", "Approve…");
    approve.type = "button";
    approve.addEventListener("click", () => actions.review(request.id));
    const deny = text(item, "button", "Deny");
    deny.type = "button";
    deny.addEventListener("click", () => actions.deny(request.id));
  }
}

export function mountSigninLists(document) {
  const pending = document.getElementById("signinPending");
  const grants = document.getElementById("signinGrants");
  const error = document.getElementById("signinError");
  const report = (failure) => {
    if (error) error.textContent = failure.message;
  };
  async function refresh() {
    try {
      const data = await relayRequest("/signin");
      renderSigninList(pending, data.requests, {
        review: (id) =>
          chrome.tabs.create({
            url: chrome.runtime.getURL(`approval.html?id=${encodeURIComponent(id)}`),
          }),
        deny: async (id) => {
          const note = prompt("Optional note for the agent:", "");
          if (note === null) return;
          try {
            await relayRequest(`/signin/${encodeURIComponent(id)}/deny`, {
              method: "POST",
              body: { note },
            });
            await refresh();
          } catch (failure) {
            report(failure);
          }
        },
      });
      if (grants) {
        const data = await relayRequest("/signin/grants");
        grants.replaceChildren();
        if (!data.grants.length)
          text(grants, "li", "No remembered grants. Grants are off by default.");
        for (const grant of data.grants) {
          const item = text(
            grants,
            "li",
            `${grant.site} → ${grant.profile} · expires ${new Date(grant.expires).toLocaleString()} `,
          );
          const revoke = text(item, "button", "Revoke");
          revoke.type = "button";
          revoke.addEventListener("click", async () => {
            try {
              await relayRequest(`/signin/grants/${encodeURIComponent(grant.id)}`, {
                method: "DELETE",
              });
              await refresh();
            } catch (failure) {
              report(failure);
            }
          });
        }
      }
      if (error) error.textContent = "";
    } catch (failure) {
      report(failure);
    }
  }
  document.getElementById("refreshSignin")?.addEventListener("click", refresh);
  void refresh();
  const timer = setInterval(refresh, 30_000);
  globalThis.addEventListener("pagehide", () => clearInterval(timer), { once: true });
}
