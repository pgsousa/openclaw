import type { OutboundIdentity } from "../../../infra/outbound/identity.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { sendMessageSlack, type SlackSendIdentity } from "../../../slack/send.js";

function resolveSlackSendIdentity(identity?: OutboundIdentity): SlackSendIdentity | undefined {
  if (!identity) {
    return undefined;
  }
  const username = identity.name?.trim() || undefined;
  const iconUrl = identity.avatarUrl?.trim() || undefined;
  const rawEmoji = identity.emoji?.trim();
  const iconEmoji = !iconUrl && rawEmoji && /^:[^:\s]+:$/.test(rawEmoji) ? rawEmoji : undefined;
  if (!username && !iconUrl && !iconEmoji) {
    return undefined;
  }
  return { username, iconUrl, iconEmoji };
}

async function applySlackMessageSendingHooks(params: {
  to: string;
  text: string;
  threadTs?: string;
  accountId?: string;
  mediaUrl?: string;
}): Promise<{ cancelled: boolean; text: string }> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("message_sending")) {
    return { cancelled: false, text: params.text };
  }
  const hookResult = await hookRunner.runMessageSending(
    {
      to: params.to,
      content: params.text,
      metadata: {
        threadTs: params.threadTs,
        channelId: params.to,
        ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
      },
    },
    { channelId: "slack", accountId: params.accountId ?? undefined },
  );
  if (hookResult?.cancel) {
    return { cancelled: true, text: params.text };
  }
  return { cancelled: false, text: hookResult?.content ?? params.text };
}

export const slackOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 4000,
  sendText: async ({ to, text, accountId, deps, replyToId, threadId, identity }) => {
    const send = deps?.sendSlack ?? sendMessageSlack;
    // Prefer explicit threadId over replyToId to keep alert replies pinned to
    // the intended root thread when both values are present.
    const threadTs = threadId != null ? String(threadId) : (replyToId ?? undefined);
    console.log(
      `[slack-outbound-debug] sendText to=${to} account=${accountId ?? ""} ` +
        `threadId=${String(threadId ?? "")} replyToId=${String(replyToId ?? "")} ` +
        `threadTs=${String(threadTs ?? "")}`,
    );
    const hookResult = await applySlackMessageSendingHooks({
      to,
      text,
      threadTs,
      accountId: accountId ?? undefined,
    });
    if (hookResult.cancelled) {
      return {
        channel: "slack",
        messageId: "cancelled-by-hook",
        channelId: to,
        meta: { cancelled: true },
      };
    }

    const slackIdentity = resolveSlackSendIdentity(identity);
    const result = await send(to, hookResult.text, {
      threadTs,
      accountId: accountId ?? undefined,
      ...(slackIdentity ? { identity: slackIdentity } : {}),
    });
    console.log(
      `[slack-outbound-debug] sendText result to=${to} messageId=${result.messageId} ` +
        `channelId=${result.channelId}`,
    );
    return { channel: "slack", ...result };
  },
  sendMedia: async ({
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    threadId,
    identity,
  }) => {
    const send = deps?.sendSlack ?? sendMessageSlack;
    // Prefer explicit threadId over replyToId to keep alert replies pinned to
    // the intended root thread when both values are present.
    const threadTs = threadId != null ? String(threadId) : (replyToId ?? undefined);
    console.log(
      `[slack-outbound-debug] sendMedia to=${to} account=${accountId ?? ""} ` +
        `threadId=${String(threadId ?? "")} replyToId=${String(replyToId ?? "")} ` +
        `threadTs=${String(threadTs ?? "")} mediaUrl=${mediaUrl}`,
    );
    const hookResult = await applySlackMessageSendingHooks({
      to,
      text,
      threadTs,
      mediaUrl,
      accountId: accountId ?? undefined,
    });
    if (hookResult.cancelled) {
      return {
        channel: "slack",
        messageId: "cancelled-by-hook",
        channelId: to,
        meta: { cancelled: true },
      };
    }

    const slackIdentity = resolveSlackSendIdentity(identity);
    const result = await send(to, hookResult.text, {
      mediaUrl,
      mediaLocalRoots,
      threadTs,
      accountId: accountId ?? undefined,
      ...(slackIdentity ? { identity: slackIdentity } : {}),
    });
    console.log(
      `[slack-outbound-debug] sendMedia result to=${to} messageId=${result.messageId} ` +
        `channelId=${result.channelId}`,
    );
    return { channel: "slack", ...result };
  },
};
