const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { once } = require("node:events");
const { WebSocket } = require("ws");
const { startRelayServer } = require("../dist/relay-node.cjs");

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "signin-node-"));
  const agent = new http.Agent({ keepAlive: true });
  const server = startRelayServer({
    port: 0,
    bindAddr: "127.0.0.1",
    secret: "fake-node-secret",
    profilesDir: directory,
    credentialsFile: path.join(directory, "fake-credentials.json"),
  });
  const clients = [];
  let replacement;
  const originalError = console.error;
  let fallbackCount = 0;
  console.error = (...args) => {
    if (args.some((value) => String(value).includes("Relay close callback timed out")))
      fallbackCount++;
    originalError(...args);
  };
  try {
    await once(server, "listening");
    const { port } = server.address();
    const authenticated = new WebSocket(`ws://127.0.0.1:${port}/signin/events`);
    clients.push(authenticated);
    authenticated.on("error", () => {});
    await once(authenticated, "open");
    const snapshot = once(authenticated, "message");
    authenticated.send(JSON.stringify({ secret: "fake-node-secret" }));
    assert.equal(JSON.parse((await snapshot)[0].toString()).type, "pending");
    const unauthenticated = new WebSocket(`ws://127.0.0.1:${port}/signin/events`);
    clients.push(unauthenticated);
    unauthenticated.on("error", () => {});
    await once(unauthenticated, "open");
    await new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/status`, { agent }, (response) => {
          assert.equal(response.statusCode, 200);
          response.resume();
          response.once("end", resolve);
        })
        .once("error", reject);
    });
    const started = performance.now();
    await new Promise((resolve) => server.close(resolve));
    const closeMs = Math.round(performance.now() - started);
    assert.equal(server.listening, false);
    assert.equal(fallbackCount, 0, "Node must invoke the native close callback");
    replacement = http.createServer();
    replacement.listen(port, "127.0.0.1");
    await once(replacement, "listening");
    assert.equal(replacement.listening, true);
    console.log(
      JSON.stringify({
        runtime: process.version,
        authenticated: 1,
        unauthenticated: 1,
        idleHttp: 1,
        closeMs,
        nativeCallback: true,
        reboundSamePort: true,
      }),
    );
  } finally {
    console.error = originalError;
    for (const client of clients) client.terminate();
    agent.destroy();
    await new Promise((resolve) => server.close(resolve));
    if (replacement) await new Promise((resolve) => replacement.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
