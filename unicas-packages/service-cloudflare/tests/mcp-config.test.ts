import { describe, expect, test } from "vitest";
import { mcpConfigFromEnv } from "../src/mcp/config.js";

describe("control-plane MCP config", () => {
  test("derives the canonical MCP resource from the public origin", () => {
    expect(mcpConfigFromEnv({ PUBLIC_ORIGIN: "https://cas.example" })).toEqual({
      publicOrigin: "https://cas.example",
      resource: "https://cas.example/mcp",
      allowedOriginHostnames: [],
    });
  });

  test("rejects non-origin paths and non-HTTPS public deployments", () => {
    expect(() => mcpConfigFromEnv({ PUBLIC_ORIGIN: "https://cas.example/admin" })).toThrow("only scheme");
    expect(() => mcpConfigFromEnv({ PUBLIC_ORIGIN: "http://cas.example" })).toThrow("must use https");
  });
});