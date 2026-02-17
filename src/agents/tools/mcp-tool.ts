import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveMcporterConfigPath } from "../../config/mcp.js";
import { resolveUserPath } from "../../utils.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const MCP_ACTIONS = ["servers", "tools", "call"] as const;
const MCP_OUTPUT_FORMATS = ["json", "text"] as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const DISABLE_BUNDLED_MCPORTER_ENV = "OPENCLAW_MCP_DISABLE_BUNDLED";

type McporterCommand = {
  command: string;
  argsPrefix: string[];
  display: string;
};

const require = createRequire(import.meta.url);

function resolveBundledCliFromImportMeta(): string | null {
  const resolve = (
    import.meta as ImportMeta & {
      resolve?: (specifier: string) => string;
    }
  ).resolve;
  if (typeof resolve !== "function") {
    return null;
  }
  try {
    const resolved = resolve("mcporter/cli");
    return resolved.startsWith("file://") ? fileURLToPath(resolved) : resolved;
  } catch {
    return null;
  }
}

const McpToolSchema = Type.Object({
  action: stringEnum(MCP_ACTIONS),
  /** Required for action=tools. */
  server: Type.Optional(Type.String()),
  /** Required for action=call. Format: server.tool */
  tool: Type.Optional(Type.String()),
  /** JSON payload string passed to `mcporter call --args`. */
  argsJson: Type.Optional(Type.String()),
  /** Optional mcporter config path override. */
  configPath: Type.Optional(Type.String()),
  /** Optional timeout override for mcporter invocation. */
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
  output: optionalStringEnum(MCP_OUTPUT_FORMATS),
});

type McporterRunResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

type McpAllowlistState = {
  configured: boolean;
  values: Set<string>;
};

type McpToolOptions = {
  config?: OpenClawConfig;
  agentId?: string;
};

function normalizeAllowlist(values: string[] | undefined): McpAllowlistState {
  if (!Array.isArray(values)) {
    return { configured: false, values: new Set() };
  }
  const normalized = values
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return { configured: true, values: new Set(normalized) };
}

function mergeAllowlists(params: {
  globalValues: string[] | undefined;
  agentValues: string[] | undefined;
}): McpAllowlistState {
  const global = normalizeAllowlist(params.globalValues);
  const agent = normalizeAllowlist(params.agentValues);
  if (global.configured && agent.configured) {
    const intersection = new Set<string>();
    for (const value of agent.values) {
      if (global.values.has(value)) {
        intersection.add(value);
      }
    }
    return { configured: true, values: intersection };
  }
  if (agent.configured) {
    return agent;
  }
  if (global.configured) {
    return global;
  }
  return { configured: false, values: new Set() };
}

function resolveMcpAllowlists(options: McpToolOptions): {
  allowServers: McpAllowlistState;
  allowTools: McpAllowlistState;
} {
  const globalMcp = options.config?.tools?.mcp;
  const agentMcp =
    options.config && options.agentId
      ? resolveAgentConfig(options.config, options.agentId)?.tools?.mcp
      : undefined;
  return {
    allowServers: mergeAllowlists({
      globalValues: globalMcp?.allowServers,
      agentValues: agentMcp?.allowServers,
    }),
    allowTools: mergeAllowlists({
      globalValues: globalMcp?.allowTools,
      agentValues: agentMcp?.allowTools,
    }),
  };
}

function parseToolReference(tool: string): { full: string; server: string } {
  const trimmed = tool.trim();
  const firstDot = trimmed.indexOf(".");
  if (firstDot <= 0 || firstDot === trimmed.length - 1) {
    throw new Error('MCP tool must be in "server.tool" format.');
  }
  const server = trimmed.slice(0, firstDot).trim();
  const name = trimmed.slice(firstDot + 1).trim();
  if (!server || !name) {
    throw new Error('MCP tool must be in "server.tool" format.');
  }
  return {
    full: `${server}.${name}`,
    server,
  };
}

function ensureServerAllowed(server: string, allowServers: McpAllowlistState) {
  if (!allowServers.configured) {
    return;
  }
  if (!allowServers.values.has(server)) {
    throw new Error(
      `MCP server "${server}" is not allowed by tools.mcp.allowServers (exact allowlist).`,
    );
  }
}

function ensureToolAllowed(tool: string, allowTools: McpAllowlistState) {
  if (!allowTools.configured) {
    return;
  }
  if (!allowTools.values.has(tool)) {
    throw new Error(
      `MCP tool "${tool}" is not allowed by tools.mcp.allowTools (exact allowlist).`,
    );
  }
}

function resolveMcporterCommand(): McporterCommand {
  if (process.env[DISABLE_BUNDLED_MCPORTER_ENV] !== "1") {
    const bundledCliFromImportMeta = resolveBundledCliFromImportMeta();
    if (bundledCliFromImportMeta) {
      return {
        command: process.execPath,
        argsPrefix: [bundledCliFromImportMeta],
        display: `${process.execPath} ${bundledCliFromImportMeta}`,
      };
    }

    try {
      const packageJsonPath = require.resolve("mcporter/package.json");
      const packageJson = require(packageJsonPath) as {
        bin?: string | Record<string, string>;
      };
      const binField = packageJson.bin;
      const binEntry =
        typeof binField === "string"
          ? binField
          : (binField?.mcporter ?? Object.values(binField ?? {})[0]);
      if (binEntry) {
        const bundledCli = path.resolve(path.dirname(packageJsonPath), binEntry);
        return {
          command: process.execPath,
          argsPrefix: [bundledCli],
          display: `${process.execPath} ${bundledCli}`,
        };
      }
    } catch {
      // Ignore and fallback to PATH lookup.
    }
  }

  return {
    command: "mcporter",
    argsPrefix: [],
    display: "mcporter",
  };
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function runMcporter(params: {
  mcporter: McporterCommand;
  args: string[];
  timeoutMs: number;
}): Promise<McporterRunResult> {
  const child = spawn(params.mcporter.command, [...params.mcporter.argsPrefix, ...params.args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, params.timeoutMs);

  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode) => resolve(exitCode));
    });
    if (timedOut) {
      throw new Error(`mcporter command timed out after ${params.timeoutMs}ms.`);
    }
    return { stdout, stderr, code };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") {
      throw new Error(
        "mcporter CLI not found. Ensure the bundled dependency is installed or install globally (npm i -g mcporter).",
        {
          cause: error,
        },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveOutput(value: string | undefined): "json" | "text" {
  return value === "text" ? "text" : "json";
}

function resolveTimeoutMs(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1, Math.floor(value * 1000));
}

function resolveEffectiveConfigPath(value: string | undefined): string | undefined {
  const explicit = value?.trim();
  if (explicit) {
    return resolveUserPath(explicit);
  }
  const defaultPath = resolveMcporterConfigPath();
  return existsSync(defaultPath) ? defaultPath : undefined;
}

export function createMcpTool(options: McpToolOptions = {}): AnyAgentTool {
  return {
    label: "MCP",
    name: "mcp",
    description:
      "Call external MCP servers via the mcporter CLI (list servers/tools, execute MCP tool calls).",
    parameters: McpToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const output = resolveOutput(readStringParam(params, "output"));
      const configPath = resolveEffectiveConfigPath(readStringParam(params, "configPath"));
      const timeoutMs = resolveTimeoutMs(readNumberParam(params, "timeoutSeconds"));
      const allowlists = resolveMcpAllowlists(options);

      const baseArgs = configPath ? ["--config", configPath] : [];
      let commandArgs: string[] = [];

      if (action === "servers") {
        commandArgs = [...baseArgs, "list", "--output", output];
      } else if (action === "tools") {
        const server = readStringParam(params, "server", { required: true });
        ensureServerAllowed(server.trim(), allowlists.allowServers);
        commandArgs = [...baseArgs, "list", server, "--schema", "--output", output];
      } else if (action === "call") {
        const tool = readStringParam(params, "tool", { required: true });
        const parsedTool = parseToolReference(tool);
        ensureServerAllowed(parsedTool.server, allowlists.allowServers);
        ensureToolAllowed(parsedTool.full, allowlists.allowTools);
        const argsJson = readStringParam(params, "argsJson");
        commandArgs = [...baseArgs, "call", parsedTool.full, "--output", output];
        if (argsJson) {
          commandArgs.push("--args", argsJson);
        }
      } else {
        throw new Error(`Unknown action: ${action}`);
      }

      const mcporter = resolveMcporterCommand();
      const result = await runMcporter({
        mcporter,
        args: commandArgs,
        timeoutMs,
      });

      const parsed = output === "json" ? tryParseJson(result.stdout) : null;
      if (result.code !== 0) {
        throw new Error(
          [
            `mcporter ${action} failed (exit=${result.code ?? "unknown"}).`,
            result.stderr.trim() || result.stdout.trim(),
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      return jsonResult({
        ok: true,
        action,
        executor: mcporter.display,
        command: ["mcporter", ...commandArgs].join(" "),
        output,
        data: parsed ?? result.stdout,
      });
    },
  };
}
