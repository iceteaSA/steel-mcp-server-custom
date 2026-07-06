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
} from "./tools/index.js";

// -----------------------------------------------------------------------------
// Parse environment + create core instances
// -----------------------------------------------------------------------------
const env = EnvSchema.parse(process.env);

const server = new McpServer(
  { name: "Steel Browser MCP Server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

const mgr = new BrowserManager(env);

// -----------------------------------------------------------------------------
// Register tools (order doesn't matter — each file calls server.tool())
// -----------------------------------------------------------------------------
registerTabs(server, mgr, env);
registerScreenshots(server, mgr, env);
registerExtraction(server, mgr, env);
registerInteraction(server, mgr, env);
registerNavigation(server, mgr, env);
registerSession(server, mgr, env);
registerNetwork(server, mgr, env);
registerCredentials(server, mgr, env);
registerProfiles(server, mgr, env);

// -----------------------------------------------------------------------------
// Server lifecycle
// -----------------------------------------------------------------------------
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Steel MCP Server running on stdio");

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
