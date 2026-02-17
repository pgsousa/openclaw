import { describe, expect, it } from "vitest";
import { hasControlCommand, isDeterministicFixOrApprovalCommand } from "./command-detection.js";

describe("hasControlCommand plain text aliases", () => {
  it("detects plain fix command when alert id is explicit", () => {
    expect(hasControlCommand("fix OpenClawSyntheticOOM-1771261103")).toBe(true);
  });

  it("treats ambiguous fix text as a control command attempt", () => {
    expect(hasControlCommand("fix it")).toBe(true);
  });

  it("detects plain approve command with approval id", () => {
    expect(hasControlCommand("approve cdc9d57c-f5fc-4cd1-8e3e-5edbe1bb5548")).toBe(true);
  });

  it("detects plain accept alias with explicit decision", () => {
    expect(
      hasControlCommand("accept cdc9d57c-f5fc-4cd1-8e3e-5edbe1bb5548 allow-once"),
    ).toBe(true);
  });

  it("treats malformed approve text as a control command attempt", () => {
    expect(hasControlCommand("approve emergency oom patch")).toBe(true);
  });

  it("treats non-uuid approve ids as control command attempts", () => {
    expect(hasControlCommand("approve OpenClawSyntheticOOM-1771263476 allow-once")).toBe(true);
  });
});

describe("isDeterministicFixOrApprovalCommand", () => {
  it("matches explicit fix command in plain form", () => {
    expect(isDeterministicFixOrApprovalCommand("fix OpenClawSyntheticOOM-1771261103")).toBe(true);
  });

  it("matches explicit fix command in slash form", () => {
    expect(isDeterministicFixOrApprovalCommand("/fix OpenClawSyntheticOOM-1771261103")).toBe(true);
  });

  it("matches explicit approve command in slash form", () => {
    expect(
      isDeterministicFixOrApprovalCommand(
        "/approve cdc9d57c-f5fc-4cd1-8e3e-5edbe1bb5548 allow-once",
      ),
    ).toBe(true);
  });

  it("rejects ambiguous fix phrasing", () => {
    expect(isDeterministicFixOrApprovalCommand("fix it")).toBe(false);
  });

  it("rejects free-form approve text", () => {
    expect(isDeterministicFixOrApprovalCommand("approve emergency oom patch")).toBe(false);
  });

  it("rejects approve commands without uuid exec id", () => {
    expect(
      isDeterministicFixOrApprovalCommand("approve OpenClawSyntheticOOM-1771263476 allow-once"),
    ).toBe(false);
  });
});
