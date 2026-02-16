import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpTool } from "./mcp-tool.js";

describe("mcp tool", () => {
  it("exposes a top-level object schema", () => {
    const tool = createMcpTool();
    const schema = tool.parameters as { type?: unknown; anyOf?: unknown; oneOf?: unknown };
    expect(schema.type).toBe("object");
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
  });

  it("validates required server/tool fields per action", async () => {
    const tool = createMcpTool();
    await expect(tool.execute("mcp-1", { action: "tools" })).rejects.toThrow(/server required/i);
    await expect(tool.execute("mcp-2", { action: "call" })).rejects.toThrow(/tool required/i);
  });

  it("returns an actionable error when mcporter is missing", async () => {
    const tool = createMcpTool();
    const prevPath = process.env.PATH;
    const prevDisableBundled = process.env.OPENCLAW_MCP_DISABLE_BUNDLED;
    const emptyPathDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-empty-path-"));
    try {
      process.env.PATH = emptyPathDir;
      process.env.OPENCLAW_MCP_DISABLE_BUNDLED = "1";
      await expect(tool.execute("mcp-3", { action: "servers" })).rejects.toThrow(
        /mcporter CLI not found/i,
      );
    } finally {
      process.env.PATH = prevPath;
      if (prevDisableBundled === undefined) {
        delete process.env.OPENCLAW_MCP_DISABLE_BUNDLED;
      } else {
        process.env.OPENCLAW_MCP_DISABLE_BUNDLED = prevDisableBundled;
      }
      await fs.rm(emptyPathDir, { recursive: true, force: true });
    }
  });
});
