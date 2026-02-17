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

  const isSlackMessageRepliedEvent = (
    event: SlackMessageEvent | SlackMessageRepliedEvent,
  ): event is SlackMessageRepliedEvent => event.subtype === "message_replied" && "message" in event;

  const resolveInboundMessageEvent = (
    event: SlackMessageEvent | SlackMessageRepliedEvent,
  ): SlackMessageEvent | null => {
    if (!isSlackMessageRepliedEvent(event)) {
      return event;
    }
    const nested = event.message;
    if (!nested) {
      return null;
    }
    const channel = nested.channel ?? event.channel;
    if (!channel) {
      return null;
    }
    return {
      type: "message",
      ...nested,
      channel,
      channel_type: nested.channel_type ?? event.channel_type,
      event_ts: nested.event_ts ?? event.event_ts,
    };
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
      const raw = event as
        | SlackMessageEvent
        | SlackMessageRepliedEvent
        | SlackMessageChangedEvent
        | SlackMessageDeletedEvent
        | SlackThreadBroadcastEvent;
      const eventId =
        typeof (body as { event_id?: unknown })?.event_id === "string"
          ? String((body as { event_id?: unknown }).event_id)
          : "unknown";
      const nested = isSlackMessageRepliedEvent(raw as SlackMessageEvent | SlackMessageRepliedEvent)
        ? (raw as SlackMessageRepliedEvent).message
        : undefined;
      const rawEvent = raw as SlackMessageEvent;
      debugLog(
        `event=message id=${eventId} subtype=${rawEvent.subtype ?? "none"} channel=${rawEvent.channel ?? "unknown"} ts=${("ts" in rawEvent ? rawEvent.ts : undefined) ?? "unknown"} thread=${("thread_ts" in rawEvent ? rawEvent.thread_ts : undefined) ?? "none"} user=${("user" in rawEvent ? rawEvent.user : undefined) ?? "unknown"} nestedTs=${nested?.ts ?? "none"} nestedUser=${nested?.user ?? "none"}`,
      );

      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        debugLog(`drop=api_app_id_mismatch id=${eventId}`);
        return;
      }

      const message = rawEvent;
      if (message.subtype === "message_changed") {
        const changed = raw as SlackMessageChangedEvent;
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
        const deleted = raw as SlackMessageDeletedEvent;
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
        const thread = raw as SlackThreadBroadcastEvent;
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
