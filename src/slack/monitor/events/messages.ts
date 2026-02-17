import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import type { SlackAppMentionEvent, SlackMessageEvent } from "../../types.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMessageHandler } from "../message-handler.js";
import type {
  SlackMessageChangedEvent,
  SlackMessageDeletedEvent,
  SlackMessageRepliedEvent,
  SlackThreadBroadcastEvent,
} from "../types.js";
import { danger } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { resolveSlackChannelLabel } from "../channel-config.js";

const SLACK_EVENT_DEBUG = process.env.OPENCLAW_SLACK_EVENT_DEBUG === "1";

export function registerSlackMessageEvents(params: {
  ctx: SlackMonitorContext;
  handleSlackMessage: SlackMessageHandler;
}) {
  const { ctx, handleSlackMessage } = params;
  const debugLog = (line: string) => {
    if (!SLACK_EVENT_DEBUG) {
      return;
    }
    ctx.runtime.log?.(`[slack-debug] ${line}`);
  };

  const resolveInboundMessageEvent = (event: SlackMessageEvent | SlackMessageRepliedEvent) => {
    // Slack "message_replied" events wrap the real message inside `event.message`.
    // Type shapes vary across Bolt/Slack payloads; keep this logic permissive and validate at runtime.
    const raw = event as unknown as {
      subtype?: unknown;
      channel?: unknown;
      channel_type?: unknown;
      event_ts?: unknown;
      message?: unknown;
    };

    if (raw.subtype !== "message_replied") {
      return event as SlackMessageEvent;
    }

    const nested = (raw.message ?? null) as null | {
      channel?: unknown;
      channel_type?: unknown;
      event_ts?: unknown;
    };
    if (!nested) {
      return null;
    }

    const channel =
      (typeof nested.channel === "string" && nested.channel) ||
      (typeof raw.channel === "string" && raw.channel)
        ? (nested.channel ?? raw.channel)
        : undefined;

    if (typeof channel !== "string" || !channel) {
      return null;
    }

    return {
      type: "message",
      ...(nested as object),
      channel,
      channel_type:
        typeof nested.channel_type === "string"
          ? nested.channel_type
          : (raw.channel_type as SlackMessageEvent["channel_type"]),
      event_ts:
        typeof nested.event_ts === "string"
          ? nested.event_ts
          : (raw.event_ts as SlackMessageEvent["event_ts"]),
    } as SlackMessageEvent;
  };

  const resolveSlackChannelSystemEventTarget = async (channelId: string | undefined) => {
    const channelInfo = channelId ? await ctx.resolveChannelName(channelId) : {};
    const channelType = channelInfo?.type;
    if (
      !ctx.isChannelAllowed({
        channelId,
        channelName: channelInfo?.name,
        channelType,
      })
    ) {
      return null;
    }

    const label = resolveSlackChannelLabel({
      channelId,
      channelName: channelInfo?.name,
    });
    const sessionKey = ctx.resolveSlackSystemEventSessionKey({
      channelId,
      channelType,
    });

    return { channelInfo, channelType, label, sessionKey };
  };

  ctx.app.event("message", async ({ event, body }: SlackEventMiddlewareArgs<"message">) => {
    try {
      const raw = event as SlackMessageEvent | SlackMessageRepliedEvent;
      const rawAny = raw as unknown as {
        channel?: unknown;
        ts?: unknown;
        thread_ts?: unknown;
        user?: unknown;
        message?: { ts?: unknown; user?: unknown };
      };
      const eventId =
        typeof (body as { event_id?: unknown })?.event_id === "string"
          ? String((body as { event_id?: unknown }).event_id)
          : "unknown";
      const nested = raw.subtype === "message_replied" ? rawAny.message : undefined;
      debugLog(
        `event=message id=${eventId} subtype=${raw.subtype ?? "none"} channel=${(typeof rawAny.channel === "string" && rawAny.channel) || "unknown"} ts=${(typeof rawAny.ts === "string" && rawAny.ts) || "unknown"} thread=${(typeof rawAny.thread_ts === "string" && rawAny.thread_ts) || "none"} user=${(typeof rawAny.user === "string" && rawAny.user) || "unknown"} nestedTs=${(typeof nested?.ts === "string" && nested.ts) || "none"} nestedUser=${(typeof nested?.user === "string" && nested.user) || "none"}`,
      );

      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        debugLog(`drop=api_app_id_mismatch id=${eventId}`);
        return;
      }

      const message = event as SlackMessageEvent;
      if (message.subtype === "message_changed") {
        const changed = event as SlackMessageChangedEvent;
        const channelId = changed.channel;
        const target = await resolveSlackChannelSystemEventTarget(channelId);
        if (!target) {
          return;
        }
        const messageId = changed.message?.ts ?? changed.previous_message?.ts;
        enqueueSystemEvent(`Slack message edited in ${target.label}.`, {
          sessionKey: target.sessionKey,
          contextKey: `slack:message:changed:${channelId ?? "unknown"}:${messageId ?? changed.event_ts ?? "unknown"}`,
        });
        return;
      }
      if (message.subtype === "message_deleted") {
        const deleted = event as SlackMessageDeletedEvent;
        const channelId = deleted.channel;
        const target = await resolveSlackChannelSystemEventTarget(channelId);
        if (!target) {
          return;
        }
        enqueueSystemEvent(`Slack message deleted in ${target.label}.`, {
          sessionKey: target.sessionKey,
          contextKey: `slack:message:deleted:${channelId ?? "unknown"}:${deleted.deleted_ts ?? deleted.event_ts ?? "unknown"}`,
        });
        return;
      }
      if (message.subtype === "thread_broadcast") {
        const thread = event as SlackThreadBroadcastEvent;
        const channelId = thread.channel;
        const target = await resolveSlackChannelSystemEventTarget(channelId);
        if (!target) {
          return;
        }
        const messageId = thread.message?.ts ?? thread.event_ts;
        enqueueSystemEvent(`Slack thread reply broadcast in ${target.label}.`, {
          sessionKey: target.sessionKey,
          contextKey: `slack:thread:broadcast:${channelId ?? "unknown"}:${messageId ?? "unknown"}`,
        });
        return;
      }

      const inboundMessage = resolveInboundMessageEvent(
        message as SlackMessageEvent | SlackMessageRepliedEvent,
      );
      if (!inboundMessage) {
        debugLog(`drop=resolve_inbound_empty id=${eventId} subtype=${message.subtype ?? "none"}`);
        return;
      }

      debugLog(
        `dispatch=handleSlackMessage id=${eventId} subtype=${inboundMessage.subtype ?? "none"} channel=${inboundMessage.channel} ts=${inboundMessage.ts ?? "unknown"} thread=${inboundMessage.thread_ts ?? "none"} user=${inboundMessage.user ?? "unknown"} text=${(inboundMessage.text ?? "").slice(0, 80).replace(/\s+/g, " ")}`,
      );
      await handleSlackMessage(inboundMessage, { source: "message" });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack handler failed: ${String(err)}`));
    }
  });

  ctx.app.event("app_mention", async ({ event, body }: SlackEventMiddlewareArgs<"app_mention">) => {
    try {
      const eventId =
        typeof (body as { event_id?: unknown })?.event_id === "string"
          ? String((body as { event_id?: unknown }).event_id)
          : "unknown";
      const mention = event as SlackAppMentionEvent;
      debugLog(
        `event=app_mention id=${eventId} channel=${mention.channel} ts=${mention.ts ?? "unknown"} thread=${mention.thread_ts ?? "none"} user=${mention.user ?? "unknown"} text=${(mention.text ?? "").slice(0, 80).replace(/\s+/g, " ")}`,
      );

      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        debugLog(`drop=api_app_id_mismatch id=${eventId}`);
        return;
      }

      await handleSlackMessage(mention as unknown as SlackMessageEvent, {
        source: "app_mention",
        wasMentioned: true,
      });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack mention handler failed: ${String(err)}`));
    }
  });
}
