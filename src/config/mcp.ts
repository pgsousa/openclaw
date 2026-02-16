import fs from "node:fs/promises";
import path from "node:path";
import { resolveUserPath } from "../utils.js";
import { resolveStateDir } from "./paths.js";

export const MCPORTER_CONFIG_PATH_ENV = "OPENCLAW_MCPORTER_CONFIG_PATH";
export const DEFAULT_MCPORTER_CONFIG_FILENAME = "mcporter.json";

type McporterServerTemplate = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type McporterConfigTemplate = {
  mcpServers: Record<string, McporterServerTemplate>;
};

export function resolveMcporterConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicitPath = env[MCPORTER_CONFIG_PATH_ENV]?.trim();
  if (explicitPath) {
    return resolveUserPath(explicitPath);
  }
  return path.join(resolveStateDir(env), DEFAULT_MCPORTER_CONFIG_FILENAME);
}

export function buildAIOpsMcporterTemplate(): McporterConfigTemplate {
  return {
    mcpServers: {
      prometheus: {
        command: "/usr/local/bin/mcp-prometheus",
        args: ["--endpoint", "https://prometheus.example.com"],
        env: {
          PROMETHEUS_TOKEN: "replace-me",
        },
      },
      kubernetes: {
        command: "/usr/local/bin/mcp-kubernetes",
        args: [
          "--kubeconfig",
          "/etc/openclaw/kubeconfig",
          "--context",
          "prod-cluster",
          "--namespace",
          "default",
        ],
      },
      opensearch: {
        command: "/usr/local/bin/mcp-opensearch",
        args: ["--endpoint", "https://opensearch.example.com"],
        env: {
          OPENSEARCH_USERNAME: "replace-me",
          OPENSEARCH_PASSWORD: "replace-me",
        },
      },
      ceph: {
        command: "/usr/local/bin/mcp-ceph",
        args: [
          "--cluster",
          "ceph-prod",
          "--conf",
          "/etc/ceph/ceph.conf",
          "--keyring",
          "/etc/ceph/ceph.client.openclaw.keyring",
        ],
      },
    },
  };
}

export async function ensureDefaultMcporterConfig(params?: {
  env?: NodeJS.ProcessEnv;
  force?: boolean;
  configPath?: string;
}): Promise<{ path: string; created: boolean }> {
  const env = params?.env ?? process.env;
  const resolvedPath =
    params?.configPath && params.configPath.trim()
      ? resolveUserPath(params.configPath)
      : resolveMcporterConfigPath(env);

  if (!params?.force) {
    try {
      await fs.access(resolvedPath);
      return { path: resolvedPath, created: false };
    } catch {
      // Continue and create the default template.
    }
  }

  await fs.mkdir(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const content = `${JSON.stringify(buildAIOpsMcporterTemplate(), null, 2)}\n`;
  await fs.writeFile(resolvedPath, content, { mode: 0o600 });
  return { path: resolvedPath, created: true };
}
