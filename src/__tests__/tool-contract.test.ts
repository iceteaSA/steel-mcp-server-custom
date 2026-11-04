import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("tool comparison detects nested required parameters and removed nested fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "steel-tool-contract-"));
  const base = [
    {
      name: "fixture",
      inputSchema: {
        properties: {
          fields: {
            type: "array",
            items: {
              type: "object",
              required: ["value"],
              properties: { value: { type: "string" }, extra: { type: "string" } },
            },
          },
        },
        required: ["fields"],
      },
    },
  ];
  try {
    const before = join(dir, "before.json");
    const after = join(dir, "after.json");
    await writeFile(before, JSON.stringify(base));
    const changed = structuredClone(base);
    changed[0].inputSchema.properties.fields.items.required.push("extra");
    await writeFile(after, JSON.stringify(changed));
    const script = resolve(import.meta.dir, "../../scripts/compare-tools.ts");
    const required = spawnSync("bun", [script, before, after], { encoding: "utf8" });
    expect(required.status).not.toBe(0);
    expect(required.stderr).toContain("Changed required parameters");
    const removed = structuredClone(base);
    Reflect.deleteProperty(removed[0].inputSchema.properties.fields.items.properties, "extra");
    await writeFile(after, JSON.stringify(removed));
    const missing = spawnSync("bun", [script, before, after], { encoding: "utf8" });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("Removed parameter");
    await writeFile(after, JSON.stringify([...base, { name: "addition", inputSchema: {} }]));
    const additive = spawnSync("bun", [script, before, after], { encoding: "utf8" });
    expect(additive.status).toBe(0);
    expect(additive.stdout).toContain("+ tool addition");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
