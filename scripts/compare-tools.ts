import { readFileSync } from "node:fs";

interface ToolContract {
  name: string;
  inputSchema: { properties?: Record<string, unknown>; required?: string[] };
}

const before: ToolContract[] = JSON.parse(readFileSync(process.argv[2], "utf8"));
const after: ToolContract[] = JSON.parse(readFileSync(process.argv[3], "utf8"));
const changes: string[] = [];
for (const old of before) {
  const current = after.find((tool) => tool.name === old.name);
  if (!current) throw new Error(`Removed tool: ${old.name}`);
  if (JSON.stringify([...(old.inputSchema.required ?? [])].sort()) !== JSON.stringify([...(current.inputSchema.required ?? [])].sort())) {
    throw new Error(`Changed required parameters: ${old.name}`);
  }
  for (const name of Object.keys(old.inputSchema.properties ?? {})) {
    if (!(name in (current.inputSchema.properties ?? {}))) throw new Error(`Removed parameter: ${old.name}.${name}`);
  }
  for (const name of Object.keys(current.inputSchema.properties ?? {})) {
    if (!(name in (old.inputSchema.properties ?? {}))) changes.push(`+ optional parameter ${old.name}.${name}`);
  }
}
for (const tool of after) {
  if (!before.some((old) => old.name === tool.name)) changes.push(`+ tool ${tool.name}`);
}
console.log(`Compatible: ${before.length} existing tools preserved; ${after.length} tools now.`);
console.log(changes.join("\n") || "No tool or parameter additions/removals.");
