import type { CommandHandler } from "./commands-types.js";
import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  isInternalMessageChannel,
} from "../../utils/message-channel.js";

const COMMAND = "/approve";
const COMMAND_ALIAS = "/accept";
const TEXT_COMMAND = "approve";
const TEXT_COMMAND_ALIAS = "accept";
const USAGE =
  "Usage: approve <id> [allow-once|allow-always|deny] (aliases: accept, /approve, /accept)";
const SLACK_USER_ID_PATTERN = /^[UW][A-Z0-9]+$/;
const APPROVAL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DECISION_ALIASES: Record<string, "allow-once" | "allow-always" | "deny"> = {
  allow: "allow-once",
  once: "allow-once",
  "allow-once": "allow-once",
  allowonce: "allow-once",
  always: "allow-always",
  "allow-always": "allow-always",
  allowalways: "allow-always",
  deny: "deny",
  reject: "deny",
  block: "deny",
};

type ParsedApproveCommand =
  | { ok: true; id: string; decision: "allow-once" | "allow-always" | "deny" }
  | { ok: false; error: string };

function parseApprovalId(raw: string): string | null {
  const id = raw.trim();
  if (!id) {
    return null;
  }
  return APPROVAL_ID_PATTERN.test(id) ? id : null;
}

function parseApproveCommand(raw: string): ParsedApproveCommand | null {
  const trimmed = raw.trim();
  const lowered = trimmed.toLowerCase();

  let rest = "";
  if (lowered.startsWith(COMMAND)) {
    rest = trimmed.slice(COMMAND.length).trim();
  } else if (lowered.startsWith(COMMAND_ALIAS)) {
    rest = trimmed.slice(COMMAND_ALIAS.length).trim();
  } else if (lowered === TEXT_COMMAND || lowered.startsWith(`${TEXT_COMMAND} `)) {
    rest = trimmed.slice(TEXT_COMMAND.length).trim();
  } else if (
    lowered === TEXT_COMMAND_ALIAS ||
    lowered.startsWith(`${TEXT_COMMAND_ALIAS} `)
  ) {
    rest = trimmed.slice(TEXT_COMMAND_ALIAS.length).trim();
  } else {
    return null;
  }

  if (!rest) {
    return { ok: false, error: USAGE };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    const id = parseApprovalId(tokens[0]);
    if (id) {
      return { ok: true, id, decision: "allow-once" };
    }
    return { ok: false, error: USAGE };
  }
  if (tokens.length !== 2) {
    return { ok: false, error: USAGE };
  }

  const first = tokens[0].toLowerCase();
  const second = tokens[1].toLowerCase();

  if (DECISION_ALIASES[first]) {
    const id = parseApprovalId(tokens[1]);
    if (!id) {
      return { ok: false, error: USAGE };
    }
    return {
      ok: true,
      decision: DECISION_ALIASES[first],
      id,
    };
  }
  if (DECISION_ALIASES[second]) {
    const id = parseApprovalId(tokens[0]);
    if (!id) {
      return { ok: false, error: USAGE };
    }
    return {
      ok: true,
      decision: DECISION_ALIASES[second],
      id,
    };
  }
  return { ok: false, error: USAGE };
}

function buildResolvedByLabel(params: Parameters<CommandHandler>[0]): string {
  const channel = params.command.channel;
  const senderId = params.command.senderId?.trim() || "unknown";
  const senderName = params.ctx.SenderName?.trim() || params.ctx.SenderUsername?.trim();
  const slackSenderId = senderId.toUpperCase();

  if (
    channel === "slack" &&
    senderId !== "unknown" &&
    SLACK_USER_ID_PATTERN.test(slackSenderId)
  ) {
    if (senderName) {
      return `${channel}:${senderName} (<@${slackSenderId}>)`;
    }
    return `${channel}:<@${slackSenderId}>`;
  }
  if (senderName && senderName !== senderId) {
    return `${channel}:${senderName} (${senderId})`;
  }
  return `${channel}:${senderId}`;
}

function buildApproverLabel(params: Parameters<CommandHandler>[0]): string {
  const senderId = params.command.senderId?.trim() || "unknown";
  const senderName = params.ctx.SenderName?.trim() || params.ctx.SenderUsername?.trim();
  if (params.command.channel === "slack" && SLACK_USER_ID_PATTERN.test(senderId.toUpperCase())) {
    if (senderName) {
      return `${senderName} (<@${senderId.toUpperCase()}>)`;
    }
    return `<@${senderId.toUpperCase()}>`;
  }
  if (senderName && senderName !== senderId) {
    return `${senderName} (${senderId})`;
  }
  return senderId;
}

export const handleApproveCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  const parsed = parseApproveCommand(normalized);
  if (!parsed) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /approve from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }

  if (isInternalMessageChannel(params.command.channel)) {
    const scopes = params.ctx.GatewayClientScopes ?? [];
    const hasApprovals = scopes.includes("operator.approvals") || scopes.includes("operator.admin");
    if (!hasApprovals) {
      logVerbose("Ignoring /approve from gateway client missing operator.approvals.");
      return {
        shouldContinue: false,
        reply: {
          text: "❌ approve requires operator.approvals for gateway clients.",
        },
      };
    }
  }

  const resolvedBy = buildResolvedByLabel(params);
  const approver = buildApproverLabel(params);
  try {
    await callGateway({
      method: "exec.approval.resolve",
      params: { id: parsed.id, decision: parsed.decision },
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: `Chat approval (${resolvedBy})`,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });
  } catch (err) {
    return {
      shouldContinue: false,
      reply: {
        text: `❌ Failed to submit approval: ${String(err)}`,
      },
    };
  }

  return {
    shouldContinue: false,
    reply: {
      text: `✅ Exec approval ${parsed.decision} submitted for ${parsed.id} (approved by ${approver}).`,
    },
  };
};
