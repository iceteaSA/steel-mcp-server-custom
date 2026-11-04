const path = require("node:path");
const { startRelayServer } = require(process.argv[2]);
const directory = process.argv[3];
const server = startRelayServer({
  port: 0,
  bindAddr: "127.0.0.1",
  secret: "fake-r1-secret",
  profilesDir: path.join(directory, "node-profiles"),
  credentialsFile: path.join(directory, "fake-node-credentials.json"),
});
server.once("listening", () =>
  process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n"),
);
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
}
process.stdin.on("data", close);
process.stdin.once("end", close);
process.once("SIGTERM", close);
