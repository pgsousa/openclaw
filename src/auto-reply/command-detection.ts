import type { OpenClawConfig } from "../config/types.js";
import {
  type CommandNormalizeOptions,
  listChatCommands,
  listChatCommandsForConfig,
  normalizeCommandBody,
} from "./commands-registry.js";
import { isAbortTrigger } from "./reply/abort.js";

const PLAIN_APPROVAL_ID_PATTERN = /^[a-f0-9-]{8,}$/i;
const PLAIN_ALERT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{2,180}$/;
const APPROVAL_DECISIONS = new Set([
  "allow",
  "once",
  "allow-once",
  "allowonce",
  "always",
  "allow-always",
  "allowalways",
  "deny",
  "reject",
  "block",
]);

function parseApprovalCommand(
  text: string,
  options?: { allowLeadingSlash?: boolean },
): { valid: boolean; explicit: boolean } {
  const commandPrefix = options?.allowLeadingSlash ? "/?" : "";
  const match = text.match(new RegExp(`^${commandPrefix}(approve|accept)\\s+(.+)$`, "i"));
  if (!match) {
    return { valid: false, explicit: false };
  }
  const tokens = match[2].trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    return {
      valid: PLAIN_APPROVAL_ID_PATTERN.test(tokens[0]),
      explicit: true,
    };
  }
  if (tokens.length !== 2) {
    return { valid: false, explicit: false };
  }
  const [first, second] = tokens;
  const firstLower = first.toLowerCase();
  const secondLower = second.toLowerCase();
  if (APPROVAL_DECISIONS.has(firstLower)) {
    return {
      valid: PLAIN_APPROVAL_ID_PATTERN.test(second),
      explicit: true,
    };
  }
  if (APPROVAL_DECISIONS.has(secondLower)) {
    return {
      valid: PLAIN_APPROVAL_ID_PATTERN.test(first),
      explicit: true,
    };
  }
  return { valid: false, explicit: false };
}

function parseFixCommand(
  text: string,
  options?: { allowLeadingSlash?: boolean },
): { valid: boolean; explicit: boolean } {
  const commandPrefix = options?.allowLeadingSlash ? "/?" : "";
  const match = text.match(new RegExp(`^${commandPrefix}fix\\s+(.+)$`, "i"));
  if (!match) {
    return { valid: false, explicit: false };
  }
  const tokens = match[1].trim().split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) {
    return { valid: false, explicit: false };
  }
  const alertId = tokens[0];
  if (alertId.toLowerCase() === "it") {
    return { valid: false, explicit: false };
  }
  return {
    valid: PLAIN_ALERT_ID_PATTERN.test(alertId),
    explicit: true,
  };
}

function isPlainApprovalCommand(text: string): boolean {
  return parseApprovalCommand(text).valid;
}

function isPlainFixCommand(text: string): boolean {
  return parseFixCommand(text).valid;
}

export function isDeterministicFixOrApprovalCommand(text?: string): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const fix = parseFixCommand(trimmed, { allowLeadingSlash: true });
  if (fix.valid && fix.explicit) {
    return true;
  }
  const approval = parseApprovalCommand(trimmed, { allowLeadingSlash: true });
  return approval.valid && approval.explicit;
}

export function hasControlCommand(
  text?: string,
  cfg?: OpenClawConfig,
  options?: CommandNormalizeOptions,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (isPlainApprovalCommand(trimmed) || isPlainFixCommand(trimmed)) {
    return true;
  }
  const normalizedBody = normalizeCommandBody(trimmed, options);
  if (!normalizedBody) {
    return false;
  }
  const lowered = normalizedBody.toLowerCase();
  const commands = cfg ? listChatCommandsForConfig(cfg) : listChatCommands();
  for (const command of commands) {
    for (const alias of command.textAliases) {
      const normalized = alias.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      if (lowered === normalized) {
        return true;
      }
      if (command.acceptsArgs && lowered.startsWith(normalized)) {
        const nextChar = normalizedBody.charAt(normalized.length);
        if (nextChar && /\s/.test(nextChar)) {
          return true;
        }
      }
    }
  }
  return false;
}

export function isControlCommandMessage(
  text?: string,
  cfg?: OpenClawConfig,
  options?: CommandNormalizeOptions,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (hasControlCommand(trimmed, cfg, options)) {
    return true;
  }
  const normalized = normalizeCommandBody(trimmed, options).trim().toLowerCase();
  return isAbortTrigger(normalized);
}

/**
 * Coarse detection for inline directives/shortcuts (e.g. "hey /status") so channel monitors
 * can decide whether to compute CommandAuthorized for a message.
 *
 * This intentionally errs on the side of false positives; CommandAuthorized only gates
 * command/directive execution, not normal chat replies.
 */
export function hasInlineCommandTokens(text?: string): boolean {
  const body = text ?? "";
  if (!body.trim()) {
    return false;
  }
  return /(?:^|\s)[/!][a-z]/i.test(body);
}

export function shouldComputeCommandAuthorized(
  text?: string,
  cfg?: OpenClawConfig,
  options?: CommandNormalizeOptions,
): boolean {
  return isControlCommandMessage(text, cfg, options) || hasInlineCommandTokens(text);
}
