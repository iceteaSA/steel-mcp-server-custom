// -----------------------------------------------------------------------------
// settle.ts — post-action settle detection via injected browser-side counters.
//
// The per-page domcontentloaded listener uses page.evaluate in the main world.
// Do not use context.addInitScript because Patchright can break WebSocket upgrades.
// Interaction tools poll window.__steelSettle until the page is quiet.
// -----------------------------------------------------------------------------

import type { Page } from "patchright";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Minimum fields required from the env object — avoids a manager.ts import. */
export type SettleEnv = { SETTLE_TIMEOUT_MS: number };

// -----------------------------------------------------------------------------
// SETTLE_INIT_SCRIPT — page-world counters
// -----------------------------------------------------------------------------

/**
 * The page listener uses page.evaluate in the main world at domcontentloaded.
 * Some navigation waits end before that event. waitForSettled can run the
 * script if the counter is missing.
 *
 * Creates `window.__steelSettle` (non-enumerable, configurable) with:
 *   - inflight: count of in-flight fetch + XHR requests
 *   - lastMutation: timestamp of last DOM mutation (Date.now)
 *
 * Patches window.fetch and XMLHttpRequest.prototype.send to track inflight.
 * Installs a MutationObserver on document.documentElement (or waits for
 * DOMContentLoaded if the element doesn't exist yet at injection time).
 */
export const SETTLE_INIT_SCRIPT = `(() => {
  if (typeof window.__steelSettle !== 'undefined') return;
  var state = { inflight: 0, lastMutation: Date.now() };
  Object.defineProperty(window, '__steelSettle', { get: function gs() { return state; }, configurable: true });

  // -- patch fetch --
  var _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function sf() {
      state.inflight++;
      var p;
      // Native fetch can throw synchronously (e.g. invalid URL scheme);
      // catch + decrement so a poisoned inflight doesn't stall settle.
      try { p = _fetch.apply(this, arguments); } catch (e) { state.inflight = Math.max(0, state.inflight - 1); throw e; }
      if (p && typeof p.finally === 'function') return p.finally(function fc() { state.inflight = Math.max(0, state.inflight - 1); });
      state.inflight = Math.max(0, state.inflight - 1);
      return p;
    };
  }

  // -- patch XMLHttpRequest --
  var _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function ss() {
    state.inflight++;
    // Named handler so the sync-throw catch path can removeEventListener
    // to prevent a later loadend from double-decrementing.
    var onEnd = function se() { state.inflight = Math.max(0, state.inflight - 1); };
    this.addEventListener('loadend', onEnd, { once: true });
    // Native send throws synchronously for invalid state (e.g. send before
    // open, or double-send).  Remove the listener before decrementing so a
    // later loadend event doesn't push the counter below zero.
    try { return _send.apply(this, arguments); }
    catch (e) {
      this.removeEventListener('loadend', onEnd);
      state.inflight = Math.max(0, state.inflight - 1);
      throw e;
    }
  };

  // -- MutationObserver --
  function _startObs() {
    var _el = document.documentElement;
    if (!_el) { document.addEventListener('DOMContentLoaded', _startObs, { once: true }); return; }
    new MutationObserver(function mc() { state.lastMutation = Date.now(); }).observe(_el, {
      childList: true, subtree: true, attributes: true, characterData: true,
    });
  }
  _startObs();
})();`;

// -----------------------------------------------------------------------------
// waitForSettled
// -----------------------------------------------------------------------------

/**
 * Wait for the page to settle after an action: no in-flight fetch / XHR AND
 * at least 300 ms since the last DOM mutation.
 *
 * When `env.SETTLE_TIMEOUT_MS` is 0 this is a no-op.
 *
 * If `window.__steelSettle` is missing, run the script before the counter check.
 * If navigation stops the script, do not wait.
 *
 * The entire body is wrapped in try/catch — navigation destroying the
 * execution context mid-wait must NOT throw (returns normally).
 *
 * @param page  Playwright Page
 * @param env   Env subset containing at least SETTLE_TIMEOUT_MS
 */
export async function waitForSettled(page: Page, env: SettleEnv): Promise<void> {
  if (env.SETTLE_TIMEOUT_MS <= 0) return;

  try {
    // Probe: did the init script run on this page?
    let hasCounter = await page.evaluate(
      () => typeof (window as any).__steelSettle,
      undefined,
      undefined,
      false,
    );
    if (hasCounter === "undefined") {
      // Counter absent — the per-page domcontentloaded injection (see
      // attachPageListeners) hasn't landed yet. This happens on the
      // "commit"-level waits used by history back/forward, which return
      // before DOMContentLoaded fires. Inject defensively here so settle
      // still works; SETTLE_INIT_SCRIPT is idempotent so this never
      // double-installs when the listener also fires. NOTE: we do NOT use
      // addInitScript here — under patchright that breaks WebSockets
      // (see attachPageListeners for the full rationale).
      await page.evaluate(SETTLE_INIT_SCRIPT, undefined, undefined, false);
      hasCounter = await page.evaluate(
        () => typeof (window as any).__steelSettle,
        undefined,
        undefined,
        false,
      );
      // Still absent (e.g. the page navigated out from under us) → no-op.
      if (hasCounter === "undefined") return;
    }

    await page.waitForFunction(
      () => {
        const s = (window as any).__steelSettle;
        return s.inflight === 0 && Date.now() - s.lastMutation >= 300;
      },
      undefined,
      { polling: 100, timeout: env.SETTLE_TIMEOUT_MS },
    );
  } catch {
    // Navigation destroyed the context, timeout, or any other failure —
    // settle is best-effort; never throw.
  }
}
