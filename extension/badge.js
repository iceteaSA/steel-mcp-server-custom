export function createBadgeRenderer(pendingCount = () => 0) {
  let writes = Promise.resolve();
  let previous;
  return function refreshBadge(force = false) {
    writes = writes
      .catch(() => {})
      .then(async () => {
        const [{ signinRelay }, { lastResults }] = await Promise.all([
          chrome.storage.session.get("signinRelay"),
          chrome.storage.local.get("lastResults"),
        ]);
        const results = Array.isArray(lastResults) ? lastResults : [];
        const failed = results.some((result) => !result.ok);
        const warning = results.some((result) => result.warning);
        const down = signinRelay?.status === "disconnected";
        const pending = pendingCount();
        const text = down
          ? "!"
          : pending
            ? String(pending)
            : results.length
              ? failed
                ? "ERR"
                : warning
                  ? "!"
                  : "OK"
              : "";
        const color =
          down || pending ? "#805500" : failed ? "#b42318" : warning ? "#805500" : "#167044";
        const title = down
          ? "Steel: relay down. Requests cannot arrive."
          : pending
            ? `Steel: ${pending} sign-in requests pending.`
            : failed
              ? "Steel: push failed. Open for recovery steps."
              : warning
                ? "Steel: cookies pushed; storage incomplete."
                : results.length
                  ? "Steel: last push completed"
                  : signinRelay?.status === "unconfigured"
                    ? "Steel: set the relay URL and secret in Settings."
                    : "Steel sign-in transfer";
        const next = JSON.stringify({ text, color, title });
        if (!force && next === previous) return;
        await chrome.action.setBadgeText({ text });
        await chrome.action.setBadgeBackgroundColor({ color });
        await chrome.action.setTitle({ title });
        previous = next;
      });
    return writes;
  };
}
