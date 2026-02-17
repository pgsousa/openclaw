import { randomUUID } from "node:crypto";
import type { CliDeps } from "../../cli/deps.js";
import type { CronJob } from "../../cron/types.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { HookMessageChannel, HooksConfigResolved } from "../hooks.js";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createHooksRequestHandler } from "../server-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { deps, getHooksConfig, bindHost, port, logHooks } = params;

  const dispatchWakeHook = (value: { text: string; mode: "now" | "next-heartbeat" }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(value.text, { sessionKey });
    if (value.mode === "now") {
      requestHeartbeatNow({ reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: {
    message: string;
    name: string;
    agentId?: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    requireThreadId?: boolean;
    channel: HookMessageChannel;
    to?: string;
    threadId?: string | number;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
    allowUnsafeExternalContent?: boolean;
  }) => {
    const sessionKey = value.sessionKey.trim();
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const jobId = randomUUID();
    const now = Date.now();
    const job: CronJob = {
      id: jobId,
      agentId: value.agentId,
      name: value.name,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", at: new Date(now).toISOString() },
      sessionTarget: "isolated",
      wakeMode: value.wakeMode,
      payload: {
        kind: "agentTurn",
        message: value.message,
        model: value.model,
        thinking: value.thinking,
        timeoutSeconds: value.timeoutSeconds,
        deliver: value.deliver,
        requireThreadId: value.requireThreadId,
        channel: value.channel,
        to: value.to,
        threadId: value.threadId,
        allowUnsafeExternalContent: value.allowUnsafeExternalContent,
      },
      delivery: value.deliver
        ? {
            mode: "announce",
            channel: value.channel,
            to: value.to,
            threadId: value.threadId,
          }
        : { mode: "none" },
      state: { nextRunAtMs: now },
    };

    const runId = randomUUID();
    void (async () => {
      try {
        const cfg = loadConfig();
        const result = await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job,
          message: value.message,
          sessionKey,
          lane: "cron",
        });
        // Slack alert hook runs that require thread delivery should not also emit
        // main-session events, otherwise errors can leak into root-channel replies.
        const suppressMainSessionEvent =
          value.deliver && value.requireThreadId === true && value.channel === "slack";
        if (!suppressMainSessionEvent) {
          const summary = result.summary?.trim() || result.error?.trim() || result.status;
          const prefix =
            result.status === "ok" ? `Hook ${value.name}` : `Hook ${value.name} (${result.status})`;
          enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
            sessionKey: mainSessionKey,
          });
          if (value.wakeMode === "now") {
            requestHeartbeatNow({ reason: `hook:${jobId}` });
          }
        }
      } catch (err) {
        logHooks.warn(`hook agent failed: ${String(err)}`);
        const suppressMainSessionEvent =
          value.deliver && value.requireThreadId === true && value.channel === "slack";
        if (!suppressMainSessionEvent) {
          enqueueSystemEvent(`Hook ${value.name} (error): ${String(err)}`, {
            sessionKey: mainSessionKey,
          });
          if (value.wakeMode === "now") {
            requestHeartbeatNow({ reason: `hook:${jobId}:error` });
          }
        }
      }
    })();

    return runId;
  };

  return createHooksRequestHandler({
    getHooksConfig,
    bindHost,
    port,
    logHooks,
    dispatchAgentHook,
    dispatchWakeHook,
  });
}
