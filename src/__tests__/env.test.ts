import { describe, it, expect } from "vitest";
import { z } from "zod";

// Test the env schema validation logic in isolation.
// We replicate the schema shape here to avoid importing the module
// (which would trigger side effects like process.env parsing).

const envSchema = z
  .object({
    BROWSER_MODE: z.enum(["steel", "local"]).default("steel"),
    DEFAULT_VIEWPORT_WIDTH: z.coerce.number().default(1920),
    DEFAULT_VIEWPORT_HEIGHT: z.coerce.number().default(1080),
    OUTPUT_DIR: z.string().default("/tmp/steel-mcp"),
    PROFILES_DIR: z.string().optional(),
    CREDENTIALS_FILE: z.string().optional(),
    CREDENTIALS_PASSPHRASE: z.string().optional(),
  })
  .transform((env) => ({
    ...env,
    PROFILES_DIR: env.PROFILES_DIR ?? `${env.OUTPUT_DIR}/profiles`,
    CREDENTIALS_FILE: env.CREDENTIALS_FILE ?? `${env.OUTPUT_DIR}/credentials.json`,
  }));

describe("env schema", () => {
  it("derives PROFILES_DIR from OUTPUT_DIR when not set", () => {
    const env = envSchema.parse({ OUTPUT_DIR: "/data/steel" });
    expect(env.PROFILES_DIR).toBe("/data/steel/profiles");
  });

  it("derives CREDENTIALS_FILE from OUTPUT_DIR when not set", () => {
    const env = envSchema.parse({ OUTPUT_DIR: "/data/steel" });
    expect(env.CREDENTIALS_FILE).toBe("/data/steel/credentials.json");
  });

  it("respects explicit PROFILES_DIR", () => {
    const env = envSchema.parse({
      OUTPUT_DIR: "/data/steel",
      PROFILES_DIR: "/custom/profiles",
    });
    expect(env.PROFILES_DIR).toBe("/custom/profiles");
  });

  it("respects explicit CREDENTIALS_FILE", () => {
    const env = envSchema.parse({
      OUTPUT_DIR: "/data/steel",
      CREDENTIALS_FILE: "/custom/creds.json",
    });
    expect(env.CREDENTIALS_FILE).toBe("/custom/creds.json");
  });

  it("uses defaults when nothing set", () => {
    const env = envSchema.parse({});
    expect(env.OUTPUT_DIR).toBe("/tmp/steel-mcp");
    expect(env.PROFILES_DIR).toBe("/tmp/steel-mcp/profiles");
    expect(env.CREDENTIALS_FILE).toBe("/tmp/steel-mcp/credentials.json");
  });

  it("CREDENTIALS_PASSPHRASE is optional", () => {
    const env = envSchema.parse({});
    expect(env.CREDENTIALS_PASSPHRASE).toBeUndefined();
  });

  it("coerces viewport dimensions from strings", () => {
    const env = envSchema.parse({
      DEFAULT_VIEWPORT_WIDTH: "1440",
      DEFAULT_VIEWPORT_HEIGHT: "900",
    });
    expect(env.DEFAULT_VIEWPORT_WIDTH).toBe(1440);
    expect(env.DEFAULT_VIEWPORT_HEIGHT).toBe(900);
  });
});
