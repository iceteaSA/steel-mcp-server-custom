---
name: steel-browser
description: >
  Workflow patterns for driving the Steel MCP browser tools effectively. Use
  this skill whenever you are about to use any steel MCP tool — go_to_url,
  click, type, get_screenshot, get_page_text, evaluate, wait_for, new_tab,
  switch_tab, etc. Also use it when the user asks you to browse a website,
  fill out a form, scrape data, take a screenshot, open multiple tabs, or
  automate anything in a browser.
---

# Steel Browser — Workflow Patterns

The tool descriptions cover the mechanics. This skill covers the non-obvious
patterns that prevent common failures.

## Core rules

**You are the brain.** The MCP server is a dumb Playwright driver. Every
decision — what to click, what to read, what to do next — is made by you.

**Never call stop_browser mid-task.** It destroys the session and all state.
Only call it when the entire task is fully complete. The server is keep-alive;
the browser persists automatically between tool calls.

**The browser auto-initialises.** You don't need start_browser unless you want
the Steel debug URL upfront to watch the session live.

## Orient → Act → Confirm

Always follow this pattern for any interaction:

1. **Orient** — know where you are before acting
   - `get_current_url` is cheap and fast; use it freely
   - After `go_to_url`, check the final URL — if it differs from what you
     requested, you were redirected (e.g. to a login wall)

2. **Act** — click, type, navigate

3. **Confirm** — verify the action had the expected effect before moving on
   - After a click or form submit that triggers a page change, always call
     `wait_for` before reading the page
   - Don't assume the page has updated

## Protecting your context window

Page text and screenshots can be enormous. Always constrain them:

- `get_page_text` — start with `maxChars: 3000`. Use `selector` to scope to
  the relevant section (e.g. `"main"`, `"article"`, `"#results"`). Only
  request the full page if you actually need it.
- `get_screenshot` — use `format: "jpeg", quality: 60` by default; far smaller
  than PNG. Use `outputMode: "file"` when you don't need to read the image
  inline. Use `scale: 0.5` for large pages.
- `evaluate` — extract only the fields you need; don't return entire DOM trees.

## Waiting correctly

Never sleep. Always use `wait_for` after an action that triggers async changes:

```
click(selector: "button[type=submit]")
wait_for(text: "Order confirmed")          # wait for success state
get_page_text(selector: "main", maxChars: 2000)
```

For spinners / loading states use `textGone`:
```
wait_for(textGone: "Loading...", timeout: 15000)
```

## Multi-step form pattern

Type into each field separately. Use `clear: true` (the default) to replace
any existing content. Use `submit: true` only on the last field or a dedicated
submit button:

```
type(selector: "input[name=email]", text: "user@example.com")
type(selector: "input[name=password]", text: "secret")
click(selector: "button[type=submit]")
wait_for(text: "Dashboard")
get_current_url()   ← confirm landing page, not an error
```

## Extracting structured data

Prefer `evaluate` over `get_page_text` when you need structured output:

```
evaluate(expression: "Array.from(document.querySelectorAll('tr')).map(r => r.innerText)")
evaluate(expression: "Array.from(document.querySelectorAll('a.result')).map(a => ({text: a.textContent.trim(), href: a.href}))")
```

## Human-in-the-loop

When you hit a CAPTCHA, 2FA prompt, or login wall you cannot handle
automatically, hand off to the user:

1. Call `start_browser` — it returns a **Session Viewer** and an
   **Interactive URL**
2. Send the user the Interactive URL and ask them to complete the action
3. Wait for them to confirm they are done
4. Continue automation — the browser state (cookies, auth) is preserved

```
start_browser()
→ "Interactive URL: https://steel.example.com/v1/sessions/debug?..."

Tell the user: "Please open this URL and log in, then let me know when done."
[user confirms]
wait_for(text: "Dashboard", timeout: 60000)
get_current_url()   ← confirm we landed on the right page
```

Never try to handle 2FA or sensitive credential entry yourself — always
use the Interactive URL to let the user do it directly in their browser.

## Multi-tab workflows

Use tabs to work across multiple sites simultaneously — each tab maintains
its own URL, cookies, and DOM state within the same Steel session.

```
# Open a second tab for a different site
new_tab(url: "https://site-b.com")
→ "Opened Tab 2"

# Work on tab 2...
get_page_text(selector: "main", maxChars: 2000)

# Switch back to tab 1
switch_tab(tabId: 1)
get_current_url()   ← confirms we're on site-a

# See all open tabs at any time
list_tabs()
→ [Tab 1]    https://site-a.com  —  Site A
→ [Tab 2] *  https://site-b.com  —  Site B

# Close a tab when done with it
close_tab(tabId: 2)
```

Key rules:
- All tools (click, type, get_screenshot, etc.) always operate on the
  **active tab** — use switch_tab first if you need to act on a different one
- new_tab() opens via the real CDP context — tabs are visible in the session
  viewer immediately
- Never use browser.newPage() or browser.newContext() directly — those create
  phantom disconnected contexts. Always go through the MCP tools.

## Debugging failures

If a page behaves unexpectedly, check the browser console first:
```
console_log(level: "error")
```
Network failures, JS errors, and CSP violations all show up here.
