import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMessageEvent } from "../types.js";
import type { SlackMonitorContext } from "./context.js";
import { hasControlCommand } from "../../auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
import { stripSlackMentionsForCommandDetection } from "./commands.js";
import { dispatchPreparedSlackMessage } from "./message-handler/dispatch.js";
import { prepareSlackMessage } from "./message-handler/prepare.js";
import { createSlackThreadTsResolver } from "./thread-resolution.js";

const SLACK_EVENT_DEBUG = process.env.OPENCLAW_SLACK_EVENT_DEBUG === "1";

export type SlackMessageHandler = (
  message: SlackMessageEvent,
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean },
) => Promise<void>;

export function createSlackMessageHandler(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
}): SlackMessageHandler {
  const { ctx, account } = params;
  const debugLog = (line: string) => {
    if (!SLACK_EVENT_DEBUG) {
      return;
    }
    ctx.runtime.log?.(`[slack-debug] ${line}`);
  };
  const debounceMs = resolveInboundDebounceMs({ cfg: ctx.cfg, channel: "slack" });
  const threadTsResolver = createSlackThreadTsResolver({ client: ctx.app.client });

  const debouncer = createInboundDebouncer<{
    message: SlackMessageEvent;
    opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
  }>({
    debounceMs,
    buildKey: (entry) => {
      const senderId = entry.message.user ?? entry.message.bot_id;
      if (!senderId) {
        return null;
      }
      const messageTs = entry.message.ts ?? entry.message.event_ts;
      // If Slack flags a thread reply but omits thread_ts, isolate it from root debouncing.
      const threadKey = entry.message.thread_ts
        ? `${entry.message.channel}:${entry.message.thread_ts}`
        : entry.message.parent_user_id && messageTs
          ? `${entry.message.channel}:maybe-thread:${messageTs}`
          : entry.message.channel;
      return `slack:${ctx.accountId}:${threadKey}:${senderId}`;
    },
    shouldDebounce: (entry) => {
      const text = entry.message.text ?? "";
      if (!text.trim()) {
        return false;
      }
      if (entry.message.files && entry.message.files.length > 0) {
        return false;
      }
      const textForCommandDetection = stripSlackMentionsForCommandDetection(text);
      return !hasControlCommand(textForCommandDetection, ctx.cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      debugLog(
        `flush=start count=${entries.length} source=${last.opts.source} channel=${last.message.channel} ts=${last.message.ts ?? "unknown"} thread=${last.message.thread_ts ?? "none"}`,
      );
      const combinedText =
        entries.length === 1
          ? (last.message.text ?? "")
          : entries
              .map((entry) => entry.message.text ?? "")
              .filter(Boolean)
              .join("\n");
      const combinedMentioned = entries.some((entry) => Boolean(entry.opts.wasMentioned));
      const syntheticMessage: SlackMessageEvent = {
        ...last.message,
        text: combinedText,
      };
      const prepared = await prepareSlackMessage({
        ctx,
        account,
        message: syntheticMessage,
        opts: {
          ...last.opts,
          wasMentioned: combinedMentioned || last.opts.wasMentioned,
        },
      });
      if (!prepared) {
        debugLog(
          `flush=drop reason=prepare_null source=${last.opts.source} channel=${last.message.channel} ts=${last.message.ts ?? "unknown"}`,
        );
        return;
      }
      debugLog(
        `flush=prepared source=${last.opts.source} channel=${prepared.message.channel} ts=${prepared.message.ts ?? "unknown"} replyTarget=${prepared.replyTarget}`,
      );
      if (entries.length > 1) {
        const ids = entries.map((entry) => entry.message.ts).filter(Boolean) as string[];
        if (ids.length > 0) {
          prepared.ctxPayload.MessageSids = ids;
          prepared.ctxPayload.MessageSidFirst = ids[0];
          prepared.ctxPayload.MessageSidLast = ids[ids.length - 1];
        }
      }
      await dispatchPreparedSlackMessage(prepared);
      debugLog(
        `flush=dispatched source=${last.opts.source} channel=${prepared.message.channel} ts=${prepared.message.ts ?? "unknown"}`,
      );
    },
    onError: (err) => {
      ctx.runtime.error?.(`slack inbound debounce flush failed: ${String(err)}`);
    },
  });

  return async (message, opts) => {
    debugLog(
      `handler=enter source=${opts.source} subtype=${message.subtype ?? "none"} channel=${message.channel} ts=${message.ts ?? "unknown"} thread=${message.thread_ts ?? "none"} user=${message.user ?? "unknown"} text=${(message.text ?? "").slice(0, 80).replace(/\s+/g, " ")}`,
    );
    if (opts.source === "message" && message.type !== "message") {
      debugLog("handler=drop reason=not_message_type");
      return;
    }
    if (
      opts.source === "message" &&
      message.subtype &&
      message.subtype !== "file_share" &&
      message.subtype !== "bot_message"
    ) {
      debugLog(`handler=drop reason=unsupported_subtype subtype=${message.subtype}`);
      return;
    }
    if (ctx.markMessageSeen(message.channel, message.ts)) {
      debugLog(
        `handler=drop reason=dedupe channel=${message.channel} ts=${message.ts ?? "unknown"}`,
      );
      return;
    }
    const resolvedMessage = await threadTsResolver.resolve({ message, source: opts.source });
    debugLog(
      `handler=enqueue source=${opts.source} subtype=${resolvedMessage.subtype ?? "none"} channel=${resolvedMessage.channel} ts=${resolvedMessage.ts ?? "unknown"} thread=${resolvedMessage.thread_ts ?? "none"} user=${resolvedMessage.user ?? "unknown"}`,
    );
    await debouncer.enqueue({ message: resolvedMessage, opts });
  };
}
