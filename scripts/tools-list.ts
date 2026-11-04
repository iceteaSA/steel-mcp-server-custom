import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "steel-contract-check", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.cjs"],
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    BROWSER_MODE: "local",
    RELAY_PORT: "0",
    ACT_LLM_BASE_URL: "http://127.0.0.1:1",
    ACT_LLM_MODEL: "contract-only",
  },
  stderr: "pipe",
});
try {
  await client.connect(transport);
  const result = await client.listTools();
  console.log(
    JSON.stringify(
      result.tools.sort((a, b) => a.name.localeCompare(b.name)),
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
