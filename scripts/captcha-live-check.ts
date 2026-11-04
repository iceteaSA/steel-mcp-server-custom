import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const turnstileURL = process.argv[2];
if (!turnstileURL || new URL(turnstileURL).protocol !== "https:") {
  throw new Error("Usage: bun scripts/captcha-live-check.ts <https Turnstile page> [--api]");
}
if (!process.env.STEEL_BASE_URL)
  throw new Error("Set STEEL_BASE_URL to the approved test instance");
const client = new Client({ name: "steel-captcha-acceptance", version: "1.0.0" });
const owner = `captcha-acceptance-${Date.now()}`;
const transport = new StdioClientTransport({
  command: "node",
  args: [fileURLToPath(new URL("../dist/index.cjs", import.meta.url))],
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    BROWSER_MODE: "steel",
    RELAY_PORT: "0",
    TOOLSETS: "core,tabs,extract,debug",
  },
  stderr: "pipe",
});
async function call(name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 330000 });
}
function text(result: Awaited<ReturnType<typeof call>>): string {
  return Array.isArray(result.content)
    ? result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n")
    : "";
}
try {
  await client.connect(transport);
  const inventory = await client.listTools();
  if (!inventory.tools.some((tool) => tool.name === "solve_captcha"))
    throw new Error("Built module does not register solve_captcha");
  console.log(text(await call("captcha_status")));
  const tab = await call("new_tab", { owner });
  if (tab.isError) throw new Error("Could not open acceptance tab");
  for (const url of ["https://www.google.com/recaptcha/api2/demo", turnstileURL]) {
    let result = await call("go_to_url", { owner, url });
    console.log(text(result));
    if (result.isError && process.argv.includes("--api")) {
      result = await call("solve_captcha", { owner, timeoutMs: 90000 });
      console.log(text(result));
    }
    if (result.isError || !/CAPTCHA .* solved in \d+ s/.test(text(result))) process.exitCode = 1;
    console.log(
      text(
        await call("evaluate", {
          owner,
          expression: `({state: document.querySelector('#capsolver-solver-tip-button')?.getAttribute('data-state') ?? null, hasToken: [...document.querySelectorAll('[name="g-recaptcha-response"], [name="cf-turnstile-response"]')].some(el => Boolean(el.value?.trim()))})`,
        }),
      ),
    );
  }
} finally {
  try {
    await call("close_tabs", { owner });
  } catch {
    /* The transport can close before cleanup. */
  }
  try {
    await call("stop_browser");
  } catch {
    /* SIGTERM also stops this client's session. */
  }
  await client.close();
}
