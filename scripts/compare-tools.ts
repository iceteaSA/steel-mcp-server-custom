import { readFileSync } from "node:fs";

interface InputSchema {
  properties?: Record<string, InputSchema>;
  required?: string[];
  items?: InputSchema;
  anyOf?: InputSchema[];
  oneOf?: InputSchema[];
  allOf?: InputSchema[];
  additionalProperties?: boolean | InputSchema;
}

interface ToolContract {
  name: string;
  inputSchema: InputSchema;
}

const before: ToolContract[] = JSON.parse(readFileSync(process.argv[2], "utf8"));
const after: ToolContract[] = JSON.parse(readFileSync(process.argv[3], "utf8"));
const changes: string[] = [];
function compareSchema(old: InputSchema, current: InputSchema, scope: string): void {
  if (
    JSON.stringify([...(old.required ?? [])].sort()) !==
    JSON.stringify([...(current.required ?? [])].sort())
  ) {
    throw new Error(`Changed required parameters: ${scope}`);
  }
  for (const [name, schema] of Object.entries(old.properties ?? {})) {
    const next = current.properties?.[name];
    if (!next) throw new Error(`Removed parameter: ${scope}.${name}`);
    compareSchema(schema, next, `${scope}.${name}`);
  }
  for (const name of Object.keys(current.properties ?? {})) {
    if (!(name in (old.properties ?? {}))) changes.push(`+ optional parameter ${scope}.${name}`);
  }
  if (old.items) {
    if (!current.items) throw new Error(`Removed parameter schema: ${scope}[]`);
    compareSchema(old.items, current.items, `${scope}[]`);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    old[key]?.forEach((branch, index) => {
      const next = current[key]?.[index];
      if (!next) throw new Error(`Removed parameter branch: ${scope}.${key}[${index}]`);
      compareSchema(branch, next, `${scope}.${key}[${index}]`);
    });
  }
  if (old.additionalProperties && typeof old.additionalProperties === "object") {
    if (!current.additionalProperties || typeof current.additionalProperties !== "object")
      throw new Error(`Removed parameter schema: ${scope}.*`);
    compareSchema(old.additionalProperties, current.additionalProperties, `${scope}.*`);
  }
}

for (const old of before) {
  const current = after.find((tool) => tool.name === old.name);
  if (!current) throw new Error(`Removed tool: ${old.name}`);
  compareSchema(old.inputSchema, current.inputSchema, old.name);
}
for (const tool of after) {
  if (!before.some((old) => old.name === tool.name)) changes.push(`+ tool ${tool.name}`);
}
console.log(`Compatible: ${before.length} existing tools preserved; ${after.length} tools now.`);
console.log(changes.join("\n") || "No tool or parameter additions/removals.");
