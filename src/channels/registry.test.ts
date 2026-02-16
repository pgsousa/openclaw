import { describe, expect, it } from "vitest";
import {
  formatChannelSelectionLine,
  listChatChannels,
  normalizeChatChannelId,
} from "./registry.js";

describe("channel registry", () => {
  it("only normalizes supported channels", () => {
    expect(normalizeChatChannelId("slack")).toBe("slack");
    expect(normalizeChatChannelId("imsg")).toBeNull();
    expect(normalizeChatChannelId("gchat")).toBeNull();
    expect(normalizeChatChannelId("google-chat")).toBeNull();
    expect(normalizeChatChannelId("internet-relay-chat")).toBeNull();
    expect(normalizeChatChannelId("web")).toBeNull();
  });

  it("keeps Slack as the only default channel", () => {
    const channels = listChatChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0]?.id).toBe("slack");
  });

  it("does not include MS Teams by default", () => {
    const channels = listChatChannels();
    expect(channels.some((channel) => channel.id === "msteams")).toBe(false);
  });

  it("formats selection lines with docs labels", () => {
    const channels = listChatChannels();
    const first = channels[0];
    if (!first) {
      throw new Error("Missing channel metadata.");
    }
    const line = formatChannelSelectionLine(first, (path, label) =>
      [label, path].filter(Boolean).join(":"),
    );
    expect(line).toContain("Docs:");
    expect(line).toContain("/channels/slack");
  });
});
