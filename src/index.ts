#!/usr/bin/env node

// -----------------------------------------------------------------------------
// Steel Browser MCP Server — entry point.
//
// Thin orchestrator: parses env, creates server + manager, registers tools,
// starts the relay server. All tool handlers live in src/tools/*.ts.
// BrowserManager and utilities live in src/manager.ts.
// Pure helpers live in src/helpers.ts.
// -----------------------------------------------------------------------------

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EnvSchema } from "./env.js";
import { BrowserManager } from "./manager.js";
import { startRelayServer } from "./relay.js";
import { makeRegistrar, resolveToolsets } from "./tools/shared.js";
import {
  registerTabs,
  registerScreenshots,
  registerExtraction,
  registerInteraction,
  registerNavigation,
  registerSession,
  registerNetwork,
  registerCredentials,
  registerProfiles,
  registerAct,
} from "./tools/index.js";
import { llmConfigured } from "./llm.js";

// -----------------------------------------------------------------------------
// Parse environment + CLI flags
// -----------------------------------------------------------------------------
const env = EnvSchema.parse(process.env);

// --toolsets CLI flag takes priority over TOOLSETS env var.
const toolsetsCli = process.argv.find((a, i) => a === "--toolsets" && i < process.argv.length - 1)
  ? process.argv[process.argv.indexOf("--toolsets") + 1]
  : undefined;
const activeToolsets = resolveToolsets(toolsetsCli, env.TOOLSETS);

// -----------------------------------------------------------------------------
// Create core instances
// -----------------------------------------------------------------------------
const server = new McpServer(
  { name: "Steel Browser MCP Server", version: "0.8.0" },
  { capabilities: { tools: {} } },
);

const mgr = new BrowserManager(env);

// -----------------------------------------------------------------------------
// Register tools via the gated wrapper
// -----------------------------------------------------------------------------
const { register, toolCount } = makeRegistrar(server, activeToolsets);

registerTabs(register, mgr, env);
registerScreenshots(register, mgr, env);
registerExtraction(register, mgr, env);
registerInteraction(register, mgr, env);
registerNavigation(register, mgr, env);
registerSession(register, mgr, env);
registerNetwork(register, mgr, env);
registerCredentials(register, mgr, env);
registerProfiles(register, mgr, env);
if (llmConfigured(env)) {
  registerAct(register, mgr, env);
}

// -----------------------------------------------------------------------------
// Server lifecycle
// -----------------------------------------------------------------------------
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const activeNames = [...activeToolsets].sort().join(",");
  console.error(
    `Steel MCP Server running on stdio | toolsets active: ${activeNames} (${toolCount()} tools)`,
  );

  // Start relay HTTP server for browser extension cookie/credential push
  if (env.RELAY_PORT > 0) {
    if (!env.RELAY_SECRET) {
      console.error(
        "[steel-mcp] WARNING: RELAY_PORT is set but RELAY_SECRET is not. Relay server disabled for security.",
      );
    } else {
      startRelayServer({
        port: env.RELAY_PORT,
        bindAddr: env.RELAY_BIND_ADDR,
        secret: env.RELAY_SECRET,
        profilesDir: env.PROFILES_DIR,
        credentialsFile: env.CREDENTIALS_FILE,
        credentialsPassphrase: env.CREDENTIALS_PASSPHRASE,
      });
    }
  }
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  console.error("Received SIGINT, cleaning up...");
  await mgr.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.error("Received SIGTERM, cleaning up...");
  await mgr.stop();
  process.exit(0);
});
