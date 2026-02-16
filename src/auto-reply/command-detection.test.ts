import { describe, expect, it } from "vitest";
import { hasControlCommand, isDeterministicFixOrApprovalCommand } from "./command-detection.js";

describe("hasControlCommand plain text aliases", () => {
  it("detects plain fix command when alert id is explicit", () => {
    expect(hasControlCommand("fix OpenClawSyntheticOOM-1771261103")).toBe(true);
  });

  it("does not treat ambiguous fix text as control command", () => {
    expect(hasControlCommand("fix it")).toBe(false);
  });

  it("detects plain approve command with approval id", () => {
    expect(hasControlCommand("approve cdc9d57c-f5fc-4cd1-8e3e-5edbe1bb5548")).toBe(true);
  });

  it("detects plain accept alias with explicit decision", () => {
    expect(
      hasControlCommand("accept cdc9d57c-f5fc-4cd1-8e3e-5edbe1bb5548 allow-once"),
    ).toBe(true);
  });

  it("does not treat free-form approve text as control command", () => {
    expect(hasControlCommand("approve emergency oom patch")).toBe(false);
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
});
