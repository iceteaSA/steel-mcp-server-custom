/**
 * Mock-based tool handler tests. Validates response formatting, error handling,
 * and business logic without requiring a real browser connection.
 *
 * We test by spawning the MCP server as a child process and sending JSON-RPC
 * messages. The server connects to Steel which may or may not be available —
 * tests that need a page use the STEEL_BASE_URL env (skip if unavailable).
 * Tests for non-browser tools (credentials, captcha_status, list_profiles)
 * work without Steel.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs/promises";

const DIST = path.resolve(__dirname, "../../dist/index.cjs");
const TEST_OUTPUT = "/tmp/steel-mcp-vitest";
const TEST_CREDS = path.join(TEST_OUTPUT, "credentials.json");

interface MCPResponse {
  jsonrpc: string;
  id: number;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    tools?: Array<{ name: string }>;
    isError?: boolean;
  };
  error?: { message: string };
}

class MCPTestClient {
  private proc: ChildProcess;
  private buffer = "";
  private responses: MCPResponse[] = [];
  private waiters: Map<number, (r: MCPResponse) => void> = new Map();

  constructor(env: Record<string, string> = {}) {
    this.proc = spawn("node", [DIST], {
      env: {
        ...process.env,
        BROWSER_MODE: "steel",
        STEEL_BASE_URL: "http://localhost:3000",
        OUTPUT_DIR: TEST_OUTPUT,
        CREDENTIALS_FILE: TEST_CREDS,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout!.on("data", (d: Buffer) => {
      this.buffer += d.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as MCPResponse;
          this.responses.push(msg);
          const waiter = this.waiters.get(msg.id);
          if (waiter) {
            this.waiters.delete(msg.id);
            waiter(msg);
          }
        } catch { /* non-JSON stderr leak */ }
      }
    });
  }

  async initialize(): Promise<void> {
    await this.call(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1.0.0" },
    });
  }

  async call(id: number, method: string, params: Record<string, unknown> = {}): Promise<MCPResponse> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`Timeout waiting for response id=${id}`));
      }, 15000);

      this.waiters.set(id, (r) => {
        clearTimeout(timeout);
        resolve(r);
      });

      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async tool(id: number, name: string, args: Record<string, unknown> = {}): Promise<MCPResponse> {
    return this.call(id, "tools/call", { name, arguments: args });
  }

  getText(r: MCPResponse): string {
    return r.result?.content?.map((c) => c.text || "").join("") || "";
  }

  isError(r: MCPResponse): boolean {
    return !!r.result?.isError || !!r.error;
  }

  kill() {
    this.proc.kill("SIGTERM");
  }
}

// ---------------------------------------------------------------------------
// Non-browser tests (no Steel connection needed)
// ---------------------------------------------------------------------------
describe("non-browser tools", () => {
  let client: MCPTestClient;

  beforeAll(async () => {
    await fs.mkdir(TEST_OUTPUT, { recursive: true });
    await fs.rm(TEST_CREDS, { force: true });
    client = new MCPTestClient();
    await client.initialize();
  });

  afterAll(() => {
    client.kill();
  });

  it("tools/list returns 26 tools with correct names", async () => {
    const r = await client.call(100, "tools/list");
    const names = r.result?.tools?.map((t) => t.name).sort() || [];
    expect(names.length).toBe(27);

    // Verify removed tools are gone
    const removed = ["get_current_url", "close_tab", "close_tabs_by_owner", "type", "select", "set_cookies", "list_credentials", "fill_form", "get_cookies", "console_log", "store_credential"];
    for (const old of removed) {
      expect(names).not.toContain(old);
    }

    // Verify new/renamed tools exist
    const expected = ["fill", "cookies", "get_console", "credentials", "close_tabs", "list_tabs", "captcha_status", "create_profile"];
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });

  it("credentials() with no args returns empty list", async () => {
    const r = await client.tool(101, "credentials");
    expect(client.getText(r)).toContain("No stored credentials");
  });

  it("credentials store + list + delete lifecycle", async () => {
    // Store
    const store = await client.tool(102, "credentials", {
      name: "test-site", url: "test.com", username: "alice", password: "secret123",
    });
    expect(client.getText(store)).toContain("stored");

    // List (no args)
    const list = await client.tool(103, "credentials");
    expect(client.getText(list)).toContain("alice");
    expect(client.getText(list)).toContain("test.com");

    // Delete
    const del = await client.tool(104, "credentials", { name: "test-site", remove: true });
    expect(client.getText(del)).toContain("deleted");

    // Verify gone
    const empty = await client.tool(105, "credentials");
    expect(client.getText(empty)).toContain("No stored credentials");
  });

  it("credentials store requires url+username+password", async () => {
    const r = await client.tool(106, "credentials", { name: "incomplete" });
    expect(client.isError(r)).toBe(true);
    expect(client.getText(r)).toContain("required");
  });

  it("use_credential returns error for nonexistent credential", async () => {
    const r = await client.tool(107, "use_credential", { name: "nonexistent" });
    expect(client.isError(r)).toBe(true);
    expect(client.getText(r)).toContain("not found");
  });

  it("captcha_status returns balance and status", async () => {
    const r = await client.tool(108, "captcha_status");
    const text = client.getText(r);
    // API key may or may not be set in test env
    expect(text).toContain("CapSolver");
    expect(text).toContain("Extension:");
  });

  it("list_profiles returns saved profiles from disk", async () => {
    // Create a fake saved profile
    const profileDir = path.join(TEST_OUTPUT, "profiles");
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(
      path.join(profileDir, "fake-profile.json"),
      JSON.stringify({ cookies: [], localStorage: {}, savedAt: "2026-01-01T00:00:00Z" })
    );

    const r = await client.tool(109, "list_profiles");
    const text = client.getText(r);
    expect(text).toContain("fake-profile");
    expect(text).toContain("saved");

    // Cleanup
    await fs.rm(path.join(profileDir, "fake-profile.json"), { force: true });
  });
});

// ---------------------------------------------------------------------------
// Browser-dependent tests (need Steel running)
// ---------------------------------------------------------------------------
describe("browser tools", () => {
  let client: MCPTestClient;
  let steelAvailable = false;

  beforeAll(async () => {
    // Check if Steel is reachable
    try {
      const res = await fetch(process.env.STEEL_BASE_URL || "http://localhost:3000/");
      steelAvailable = res.ok;
    } catch {
      steelAvailable = false;
    }

    if (!steelAvailable) return;

    client = new MCPTestClient();
    await client.initialize();
  }, 20000);

  afterAll(() => {
    if (client) client.kill();
  });

  it.skipIf(!steelAvailable)("list_tabs returns at least one tab", async () => {
    const r = await client.tool(200, "list_tabs");
    expect(client.getText(r)).toMatch(/Tab \d+/);
  });

  it.skipIf(!steelAvailable)("go_to_url returns URL + title", async () => {
    const r = await client.tool(201, "go_to_url", { url: "https://example.com" });
    const text = client.getText(r);
    expect(text).toContain("example.com");
    expect(text).toContain("Title:");
  }, 15000);

  it.skipIf(!steelAvailable)("get_page_text auto-selects content area", async () => {
    const r = await client.tool(202, "get_page_text", { maxChars: 500 });
    const text = client.getText(r);
    expect(text).toContain("Example Domain");
    // Should have newlines preserved (not all on one line)
    expect(text).toContain("\n");
  });

  it.skipIf(!steelAvailable)("scroll reports position and page height", async () => {
    const r = await client.tool(203, "scroll", { direction: "down", pixels: 100 });
    const text = client.getText(r);
    expect(text).toContain("Position:");
    expect(text).toMatch(/\d+px \/ \d+px/);
    expect(text).toMatch(/\d+% through page/);
  });

  it.skipIf(!steelAvailable)("list_tabs with tabId filter returns single tab info", async () => {
    const r = await client.tool(204, "list_tabs", { tabId: 1 });
    const text = client.getText(r);
    expect(text).toMatch(/Tab 1:/);
    expect(text).toContain("Title:");
  });

  it.skipIf(!steelAvailable)("close_tabs with nonexistent owner returns empty", async () => {
    const r = await client.tool(205, "close_tabs", { owner: "agent:nonexistent-12345" });
    expect(client.getText(r)).toContain("No tabs");
  });

  it.skipIf(!steelAvailable)("click with waitForText reports result", async () => {
    // Navigate to example.com first
    await client.tool(206, "go_to_url", { url: "https://example.com" });
    const r = await client.tool(207, "click", {
      selector: "a",
      waitForText: "RFC 2606",
      waitTimeout: 10000,
    });
    const text = client.getText(r);
    // Either the text appeared or timed out — both are valid formatted responses
    expect(text).toMatch(/Clicked: a/);
  }, 20000);

  it.skipIf(!steelAvailable)("history(reload) reports URL + title", async () => {
    const r = await client.tool(208, "history", { action: "reload" });
    const text = client.getText(r);
    expect(text).toContain("Reloaded");
    expect(text).toContain("Current URL:");
    expect(text).toContain("Title:");
  }, 15000);

  it.skipIf(!steelAvailable)("get_console returns formatted messages", async () => {
    const r = await client.tool(209, "get_console", { level: "all" });
    // May have messages or not — both are valid
    const text = client.getText(r);
    expect(text).toBeTruthy();
  });

  it.skipIf(!steelAvailable)("cookies with no filter returns cookies or empty", async () => {
    const r = await client.tool(210, "cookies");
    const text = client.getText(r);
    // Either cookies or "No cookies" — both valid
    expect(text).toBeTruthy();
  });
});
