import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAIOpsMcporterTemplate,
  ensureDefaultMcporterConfig,
  resolveMcporterConfigPath,
} from "./mcp.js";

describe("mcp config defaults", () => {
  it("resolves mcporter config path from OPENCLAW_STATE_DIR", () => {
    const env = {
      OPENCLAW_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;
    expect(resolveMcporterConfigPath(env)).toBe(
      path.join(path.resolve("/custom/state"), "mcporter.json"),
    );
  });

  it("resolves mcporter config path from OPENCLAW_MCPORTER_CONFIG_PATH", () => {
    const env = {
      OPENCLAW_MCPORTER_CONFIG_PATH: "/custom/mcp/config.json",
      OPENCLAW_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;
    expect(resolveMcporterConfigPath(env)).toBe(path.resolve("/custom/mcp/config.json"));
  });

  it("writes the default file once and preserves existing content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mcporter-"));
    try {
      const env = {
        OPENCLAW_STATE_DIR: root,
      } as NodeJS.ProcessEnv;

      const first = await ensureDefaultMcporterConfig({ env });
      expect(first.created).toBe(true);
      expect(first.path).toBe(path.join(root, "mcporter.json"));

      const originalRaw = await fs.readFile(first.path, "utf8");
      await fs.writeFile(first.path, '{\n  "mcpServers": {}\n}\n', "utf8");

      const second = await ensureDefaultMcporterConfig({ env });
      expect(second.created).toBe(false);

      const afterRaw = await fs.readFile(first.path, "utf8");
      expect(afterRaw).toBe('{\n  "mcpServers": {}\n}\n');
      expect(afterRaw).not.toBe(originalRaw);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("includes aiops server stubs in template", () => {
    const template = buildAIOpsMcporterTemplate();
    expect(Object.keys(template.mcpServers).toSorted()).toEqual([
      "ceph",
      "kubernetes",
      "opensearch",
      "prometheus",
    ]);
  });
});
