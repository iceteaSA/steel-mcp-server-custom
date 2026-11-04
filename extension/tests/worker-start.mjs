const record = JSON.parse(process.argv[2]);
let now = Number(process.argv[3]);
Date.now = () => now;
const origins = new Set(["https://example.com/*", "http://*/*", "https://*/*"]);
let alarm;
let alarmListener;
const event = { addListener() {} };
globalThis.chrome = {
  runtime: { onMessage: event, onInstalled: event, onStartup: event },
  permissions: {
    onAdded: event,
    contains: async (input) => input.origins.every((origin) => origins.has(origin)),
    remove: async (input) => {
      for (const origin of input.origins) origins.delete(origin);
      return true;
    },
  },
  storage: {
    session: { get: async () => ({ discoveryRun: record }), remove: async () => {} },
    onChanged: event,
  },
  alarms: {
    onAlarm: {
      addListener(listener) {
        alarmListener = listener;
      },
    },
    create: async (_name, value) => {
      alarm = value;
    },
    clear: async () => {
      alarm = undefined;
    },
  },
  contextMenus: { onClicked: event },
  commands: { onCommand: event },
};
const worker = await import("../background.js");
await worker.discoveryReady;
if (process.argv[4] === "expire") {
  now = alarm.when;
  await alarmListener({ name: "steel-discovery-deadline" });
}
console.log(JSON.stringify({ origins: [...origins], alarm }));
