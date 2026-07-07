// -----------------------------------------------------------------------------
// settle.ts — post-action settle detection via injected browser-side counters.
//
// Injects a script once per context (via context.addInitScript) that installs
// window.__steelSettle = { inflight, lastMutation }.  After every action tool
// waitForSettled polls those counters until the page is quiet.
// -----------------------------------------------------------------------------

import type { Page } from "playwright";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Minimum fields required from the env object — avoids a manager.ts import. */
export type SettleEnv = { SETTLE_TIMEOUT_MS: number };

// -----------------------------------------------------------------------------
// SETTLE_INIT_SCRIPT — injected once per BrowserContext
// -----------------------------------------------------------------------------

/**
 * Self-contained JS that runs at document_start via context.addInitScript.
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
 * Guards against pages where the init script never ran (about:blank, tabs
 * created before this server started): if `window.__steelSettle` is undefined
 * the wait resolves immediately.
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
    const hasCounter = await page.evaluate(() => typeof (window as any).__steelSettle);
    if (hasCounter === "undefined") return;

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
