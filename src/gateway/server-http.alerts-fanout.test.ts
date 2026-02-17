import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { HookMappingConfig } from "../config/types.hooks.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveHookMappings } from "./hooks-mapping.js";
import type { HooksConfigResolved } from "./hooks.js";

const { readJsonBodyMock } = vi.hoisted(() => ({
  readJsonBodyMock: vi.fn(),
}));

vi.mock("./hooks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hooks.js")>();
  return {
    ...actual,
    readJsonBody: readJsonBodyMock,
  };
});

import { createHooksRequestHandler } from "./server-http.js";

function createHooksConfig(mappings: HookMappingConfig[]): HooksConfigResolved {
  return {
    basePath: "/hooks",
    token: "hook-secret",
    maxBodyBytes: 1024,
    mappings: resolveHookMappings({ mappings }),
    agentPolicy: {
      defaultAgentId: "main",
      knownAgentIds: new Set(["main"]),
      allowedAgentIds: undefined,
    },
    sessionPolicy: {
      allowRequestSessionKey: false,
      defaultSessionKey: undefined,
      allowedSessionKeyPrefixes: undefined,
    },
  };
}

function createRequest(pathname: string): IncomingMessage {
  return {
    method: "POST",
    url: pathname,
    headers: {
      host: "127.0.0.1:18789",
      authorization: "Bearer hook-secret",
    },
    socket: { remoteAddress: "127.0.0.1" },
  } as IncomingMessage;
}

function createResponse(): {
  res: ServerResponse;
  end: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
} {
  const setHeader = vi.fn();
  const end = vi.fn();
  const res = {
    statusCode: 200,
    setHeader,
    end,
  } as unknown as ServerResponse;
  return { res, end, setHeader };
}

describe("createHooksRequestHandler alert fan-out", () => {
  beforeEach(() => {
    readJsonBodyMock.mockReset();
  });

  test("dispatches one isolated run per alert when payload contains alerts[]", async () => {
    readJsonBodyMock.mockResolvedValue({
      ok: true,
      value: {
        status: "firing",
        alerts: [
          { labels: { alertname: "AlertA" } },
          { labels: { alertname: "AlertB" } },
        ],
      },
    });
    const dispatchWakeHook = vi.fn();
    const dispatchAgentHook = vi.fn();
    dispatchAgentHook.mockImplementation(() => `run-${dispatchAgentHook.mock.calls.length}`);
    const handler = createHooksRequestHandler({
      getHooksConfig: () =>
        createHooksConfig([
          {
            id: "alertmanager",
            match: { path: "alertmanager" },
            action: "agent",
            messageTemplate: "Alert {{alerts[0].labels.alertname}}",
            channel: "slack",
            to: "channel:C123",
            threadId: "thread-1",
          },
        ]),
      bindHost: "127.0.0.1",
      port: 18789,
      logHooks: {
        warn: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      } as unknown as ReturnType<typeof createSubsystemLogger>,
      dispatchWakeHook,
      dispatchAgentHook,
    });
    const req = createRequest("/hooks/alertmanager");
    const { res, end } = createResponse();

    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(202);
    expect(dispatchWakeHook).not.toHaveBeenCalled();
    expect(dispatchAgentHook).toHaveBeenCalledTimes(2);
    expect(dispatchAgentHook.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        message: "Alert AlertA",
        threadId: "thread-1",
        requireThreadId: true,
      }),
    );
    expect(dispatchAgentHook.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        message: "Alert AlertB",
        threadId: "thread-1",
        requireThreadId: true,
      }),
    );
    const body = JSON.parse(String(end.mock.calls[0]?.[0] ?? "{}")) as {
      ok?: boolean;
      runCount?: number;
      runIds?: string[];
      wakeCount?: number;
    };
    expect(body.ok).toBe(true);
    expect(body.runCount).toBe(2);
    expect(body.runIds).toEqual(["run-1", "run-2"]);
    expect(body.wakeCount).toBe(0);
  });

  test("drops Slack alert actions without threadId to prevent root posts", async () => {
    readJsonBodyMock.mockResolvedValue({
      ok: true,
      value: {
        status: "firing",
        alerts: [{ labels: { alertname: "AlertNoThread" } }],
      },
    });
    const dispatchWakeHook = vi.fn();
    const dispatchAgentHook = vi.fn();
    const logHooks = {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    } as unknown as ReturnType<typeof createSubsystemLogger>;
    const handler = createHooksRequestHandler({
      getHooksConfig: () =>
        createHooksConfig([
          {
            id: "alertmanager",
            match: { path: "alertmanager" },
            action: "agent",
            messageTemplate: "Alert {{alerts[0].labels.alertname}}",
            channel: "slack",
            to: "channel:C123",
          },
        ]),
      bindHost: "127.0.0.1",
      port: 18789,
      logHooks,
      dispatchWakeHook,
      dispatchAgentHook,
    });
    const req = createRequest("/hooks/alertmanager");
    const { res } = createResponse();

    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(dispatchWakeHook).not.toHaveBeenCalled();
    expect(dispatchAgentHook).not.toHaveBeenCalled();
    expect((logHooks.warn as ReturnType<typeof vi.fn>).mock.calls.some((call) =>
      String(call[0] ?? "").includes("root post blocked"),
    )).toBe(true);
  });
});
