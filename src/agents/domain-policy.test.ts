import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  isPromptAllowedByDomainPolicy,
  resolveAgentDomainPolicy,
  shouldEnforceDomainPolicy,
} from "./domain-policy.js";

describe("resolveAgentDomainPolicy", () => {
  it("returns undefined when policy is not enabled", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          domainPolicy: {
            enabled: false,
            profile: "aiops",
          },
        },
      },
    };
    expect(resolveAgentDomainPolicy({ config: cfg, sessionKey: "agent:main:slack:dm:u1" })).toBe(
      undefined,
    );
  });

  it("supports disabling policy for a specific agent", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          domainPolicy: {
            enabled: true,
            profile: "aiops",
          },
        },
        list: [
          {
            id: "ops",
            domainPolicy: {
              enabled: false,
            },
          },
        ],
      },
    };

    expect(resolveAgentDomainPolicy({ config: cfg, sessionKey: "agent:ops:slack:dm:u1" })).toBe(
      undefined,
    );
    expect(
      resolveAgentDomainPolicy({ config: cfg, sessionKey: "agent:main:slack:dm:u1" }),
    ).toBeDefined();
  });
});

describe("domain policy evaluation", () => {
  const policy = {
    enabled: true,
    profile: "aiops",
    applyTo: "external_user",
    refusalMessage: "AIOPS_ONLY",
  } as const;

  it("allows in-domain prompts and blocks off-topic prompts", () => {
    expect(
      isPromptAllowedByDomainPolicy({
        prompt: "Analisa este alerta do Prometheus no Kubernetes",
        policy,
      }),
    ).toBe(true);
    expect(
      isPromptAllowedByDomainPolicy({
        prompt: "Qual e a capital de Portugal?",
        policy,
      }),
    ).toBe(false);
  });

  it("allows deterministic fix/approve control commands used in aiops remediation", () => {
    expect(
      isPromptAllowedByDomainPolicy({
        prompt: "fix OpenClawSyntheticOOM-1771268941",
        policy,
      }),
    ).toBe(true);
    expect(
      isPromptAllowedByDomainPolicy({
        prompt: "approve 72206b81-d1bd-4f58-8fb8-56f12f71dd94",
        policy,
      }),
    ).toBe(true);
    expect(
      isPromptAllowedByDomainPolicy({
        prompt: "/approve 72206b81-d1bd-4f58-8fb8-56f12f71dd94 allow-once",
        policy,
      }),
    ).toBe(true);
    expect(
      isPromptAllowedByDomainPolicy({
        prompt: "approve emergency oom patch",
        policy,
      }),
    ).toBe(false);
  });

  it("skips enforcement for inter_session/internal_system with external_user scope", () => {
    expect(
      shouldEnforceDomainPolicy({
        policy,
        inputProvenance: { kind: "inter_session" },
      }),
    ).toBe(false);
    expect(
      shouldEnforceDomainPolicy({
        policy,
        inputProvenance: { kind: "internal_system" },
      }),
    ).toBe(false);
    expect(
      shouldEnforceDomainPolicy({
        policy,
      }),
    ).toBe(true);
  });
});
