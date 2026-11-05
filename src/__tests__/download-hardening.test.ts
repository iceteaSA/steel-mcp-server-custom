import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "patchright";
import { EnvSchema } from "../env.js";
import type { BrowserManager } from "../manager.js";
import { register as network } from "../tools/network.js";
import type { ToolSpec } from "../tools/shared.js";
import { readPathFixture } from "./helpers.js";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  ({ browser } = await readPathFixture());
  page = await (await browser.newContext()).newPage();
});
afterAll(async () => { await browser?.close(); });

for (const forceFetch of [true, false]) {
  for (const race of [false, true]) {
    test(`download ${forceFetch ? "fetch" : "event"} ${race ? "resists parent replacement" : "accepts default output inside a different root"}`, async () => {
      const root = await fs.mkdtemp(path.join(tmpdir(), "download-output-"));
      const output = path.join(root, "out");
      const profiles = path.join(root, "profiles");
      const env = EnvSchema.parse({ BROWSER_MODE: "local", OUTPUT_DIR: output, OUTPUT_ROOT: race ? "*" : root, PROFILES_DIR: profiles });
      const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("download-data", { headers: { "Content-Disposition": 'attachment; filename="saved.json"' } }) });
      const specs: ToolSpec[] = [];
      let temporary: Page | undefined;
      network((s) => specs.push(s), {
        context: page.context(),
        newTab: async () => ({ tabId: 1, page: temporary = await page.context().newPage() }),
        closeTab: async () => { await temporary?.close(); },
      } as unknown as BrowserManager, env);
      const mkdir = fs.mkdir.bind(fs);
      let swapped = false;
      let spy: ReturnType<typeof spyOn> | undefined;
      try {
        await mkdir(output);
        await mkdir(profiles);
        await fs.writeFile(path.join(profiles, "saved.json"), "SERVER_ONLY_CANARY");
        if (race) spy = spyOn(fs, "mkdir").mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
          const result = await mkdir(...args);
          if (!swapped && args[0] === output) {
            swapped = true;
            await fs.rename(output, path.join(root, "original"));
            await fs.symlink(profiles, output);
          }
          return result;
        });
        const result = await specs.find((s) => s.name === "download_file")!.handler({ url: `${site.url.origin}/saved.json`, forceFetch, timeout: 2000 });
        if (race) {
          expect(swapped).toBe(true);
          expect(await fs.readFile(path.join(profiles, "saved.json"), "utf8")).toBe("SERVER_ONLY_CANARY");
        } else {
          expect(result.isError).not.toBe(true);
          expect(await fs.readFile(path.join(output, "saved.json"), "utf8")).toBe("download-data");
        }
      } finally {
        spy?.mockRestore();
        await temporary?.close();
        await site.stop(true);
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
}
