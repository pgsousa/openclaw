import type { CommandHandler } from "./commands-types.js";
import { logVerbose } from "../../globals.js";

const COMMAND = "/fix";
const TEXT_COMMAND = "fix";
const USAGE = "Use: fix <alert-id> (example: fix OpenClawSyntheticOOM-1771260415)";
const ALERT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{2,180}$/;

type ParsedFixCommand = { ok: true; alertId: string } | { ok: false; error: string } | null;

function parseFixCommand(raw: string): ParsedFixCommand {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const lowered = trimmed.toLowerCase();

  let strictSlashMode = false;
  let rest = "";
  if (lowered.startsWith(COMMAND)) {
    strictSlashMode = true;
    rest = trimmed.slice(COMMAND.length).trim();
  } else if (lowered === TEXT_COMMAND || lowered.startsWith(`${TEXT_COMMAND} `)) {
    rest = trimmed.slice(TEXT_COMMAND.length).trim();
  } else {
    return null;
  }

  if (!rest) {
    return { ok: false, error: USAGE };
  }

  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) {
    return { ok: false, error: USAGE };
  }

  const alertId = tokens[0].trim();
  if (!ALERT_ID_PATTERN.test(alertId) || alertId.toLowerCase() === "it") {
    return { ok: false, error: USAGE };
  }

  // Keep slash and plain-text modes aligned: both require explicit alert id.
  if (!strictSlashMode && lowered === TEXT_COMMAND) {
    return { ok: false, error: USAGE };
  }

  return { ok: true, alertId };
}

export const handleFixCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseFixCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(`Ignoring fix command from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
    return { shouldContinue: false };
  }

  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }

  // Valid "fix <alert-id>" should continue to the model with user text unchanged.
  return null;
};

