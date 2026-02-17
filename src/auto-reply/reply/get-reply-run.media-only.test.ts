import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPreparedReply } from "./get-reply-run.js";

vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthProfileOverride: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: vi.fn().mockReturnValue("session:session-key"),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveGroupSessionKey: vi.fn().mockReturnValue(undefined),
  resolveSessionFilePath: vi.fn().mockReturnValue("/tmp/session.jsonl"),
  resolveSessionFilePathOptions: vi.fn().mockReturnValue({}),
  updateSessionStore: vi.fn(),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../process/command-queue.js", () => ({
  clearCommandLane: vi.fn().mockReturnValue(0),
  getQueueSize: vi.fn().mockReturnValue(0),
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeMainKey: vi.fn().mockReturnValue("main"),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: vi.fn().mockReturnValue(false),
}));

vi.mock("../command-detection.js", () => ({
  hasControlCommand: vi.fn().mockReturnValue(false),
  isDeterministicFixOrApprovalCommand: vi.fn().mockReturnValue(false),
}));

vi.mock("./agent-runner.js", () => ({
  runReplyAgent: vi.fn().mockResolvedValue({ text: "ok" }),
}));

vi.mock("./body.js", () => ({
  applySessionHints: vi.fn().mockImplementation(async ({ baseBody }) => baseBody),
}));

vi.mock("./groups.js", () => ({
  buildGroupIntro: vi.fn().mockReturnValue(""),
  buildGroupChatContext: vi.fn().mockReturnValue(""),
}));

vi.mock("./inbound-meta.js", () => ({
  buildInboundMetaSystemPrompt: vi.fn().mockReturnValue(""),
  buildInboundUserContextPrefix: vi.fn().mockReturnValue(""),
}));

vi.mock("./queue.js", () => ({
  resolveQueueSettings: vi.fn().mockReturnValue({ mode: "followup" }),
}));

vi.mock("./route-reply.js", () => ({
  routeReply: vi.fn(),
}));

vi.mock("./session-updates.js", () => ({
  ensureSkillSnapshot: vi.fn().mockImplementation(async ({ sessionEntry, systemSent }) => ({
    sessionEntry,
    systemSent,
    skillsSnapshot: undefined,
  })),
  prependSystemEvents: vi.fn().mockImplementation(async ({ prefixedBodyBase }) => prefixedBodyBase),
}));

vi.mock("./typing-mode.js", () => ({
  resolveTypingMode: vi.fn().mockReturnValue("off"),
}));

import { runReplyAgent } from "./agent-runner.js";

function baseParams(
  overrides: Partial<Parameters<typeof runPreparedReply>[0]> = {},
): Parameters<typeof runPreparedReply>[0] {
  return {
    ctx: {
      Body: "",
      RawBody: "",
      CommandBody: "",
      ThreadHistoryBody: "Earlier message in this thread",
      OriginatingChannel: "slack",
      OriginatingTo: "C123",
      ChatType: "group",
    },
    sessionCtx: {
      Body: "",
      BodyStripped: "",
      ThreadHistoryBody: "Earlier message in this thread",
      MediaPath: "/tmp/input.png",
      Provider: "slack",
      ChatType: "group",
      OriginatingChannel: "slack",
      OriginatingTo: "C123",
    },
    cfg: { session: {}, channels: {}, agents: { defaults: {} } },
    agentId: "default",
    agentDir: "/tmp/agent",
    agentCfg: {},
    sessionCfg: {},
    commandAuthorized: true,
    command: {
      isAuthorizedSender: true,
      abortKey: "session-key",
      ownerList: [],
      senderIsOwner: false,
      commandBodyNormalized: "/status",
    } as never,
    commandSource: "",
    allowTextCommands: true,
    directives: {
      hasThinkDirective: false,
      thinkLevel: undefined,
    } as never,
    defaultActivation: "always",
    resolvedThinkLevel: "high",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    elevatedEnabled: false,
    elevatedAllowed: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    modelState: {
      resolveDefaultThinkingLevel: async () => "medium",
    } as never,
    provider: "anthropic",
    model: "claude-opus-4-1",
    typing: {
      onReplyStart: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn(),
    } as never,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-1",
    timeoutMs: 30_000,
    isNewSession: true,
    resetTriggered: false,
    systemSent: true,
    sessionKey: "session-key",
    workspaceDir: "/tmp/workspace",
    abortedLastRun: false,
    ...overrides,
  };
}

describe("runPreparedReply media-only handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows media-only prompts and preserves thread context in queued followups", async () => {
    const result = await runPreparedReply(baseParams());
    expect(result).toEqual({ text: "ok" });

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(call?.followupRun.prompt).toContain("[Thread history - for context]");
    expect(call?.followupRun.prompt).toContain("Earlier message in this thread");
    expect(call?.followupRun.prompt).toContain("[User sent media without caption]");
  });

  it("returns the empty-body reply when there is no text and no media", async () => {
    const result = await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          Provider: "slack",
        },
      }),
    );

    expect(result).toEqual({
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    });
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
  });

  it("preserves thread starter context for deterministic fix commands on existing sessions", async () => {
    const result = await runPreparedReply(
      baseParams({
        isNewSession: false,
        ctx: {
          Body: "fix OpenClawPodOOMKilled",
          RawBody: "fix OpenClawPodOOMKilled",
          CommandBody: "fix OpenClawPodOOMKilled",
          ThreadStarterBody:
            "ALERT FIRING: OpenClawPodOOMKilled | severity=critical | namespace=oom-test | pod=oom-demo-d79ffcdf4-gcz5h | container=stress | reason=OOMKilled",
          OriginatingChannel: "slack",
          OriginatingTo: "C123",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "fix OpenClawPodOOMKilled",
          BodyStripped: "fix OpenClawPodOOMKilled",
          ThreadStarterBody:
            "ALERT FIRING: OpenClawPodOOMKilled | severity=critical | namespace=oom-test | pod=oom-demo-d79ffcdf4-gcz5h | container=stress | reason=OOMKilled",
          Provider: "slack",
          ChatType: "group",
          OriginatingChannel: "slack",
          OriginatingTo: "C123",
        },
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "fix OpenClawPodOOMKilled",
        } as never,
      }),
    );

    expect(result).toEqual({ text: "ok" });
    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.commandBody).toContain("[Thread starter - for context]");
    expect(call?.commandBody).toContain("namespace=oom-test");
    expect(call?.commandBody).toContain(
      "[Operator remediation directive for OpenClawPodOOMKilled]",
    );
    expect(call?.commandBody).toContain("Do not invent approval ids or action ids.");
    expect(call?.commandBody).toContain("call the exec tool to create a runtime exec approval");
  });

  it("injects operator override directive for 'faz antes assim' phrasing", async () => {
    const overrideCommand = "kubectl -n oom-test scale deployment/oom-demo --replicas=0";
    const result = await runPreparedReply(
      baseParams({
        isNewSession: false,
        ctx: {
          Body: `faz antes assim: ${overrideCommand}`,
          RawBody: `faz antes assim: ${overrideCommand}`,
          CommandBody: `faz antes assim: ${overrideCommand}`,
          OriginatingChannel: "slack",
          OriginatingTo: "C123",
          ChatType: "group",
        },
        sessionCtx: {
          Body: `faz antes assim: ${overrideCommand}`,
          BodyStripped: `faz antes assim: ${overrideCommand}`,
          Provider: "slack",
          ChatType: "group",
          OriginatingChannel: "slack",
          OriginatingTo: "C123",
        },
      }),
    );

    expect(result).toEqual({ text: "ok" });
    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.commandBody).toContain("[Operator override instruction]");
    expect(call?.commandBody).toContain(overrideCommand);
    expect(call?.followupRun.prompt).toContain("[Operator override instruction]");
    expect(call?.followupRun.prompt).toContain(overrideCommand);
  });
});
