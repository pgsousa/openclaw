import type { OpenClawConfig } from "../config/config.js";
import type { AgentDomainPolicyConfig } from "../config/types.agent-defaults.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import { resolveAgentConfig, resolveSessionAgentId } from "./agent-scope.js";

type DomainPolicyProfile = "aiops";
type DomainPolicyApplyTo = "external_user" | "all";

export type ResolvedAgentDomainPolicy = {
  enabled: true;
  profile: DomainPolicyProfile;
  applyTo: DomainPolicyApplyTo;
  refusalMessage: string;
};

const DEFAULT_REFUSAL_MESSAGE =
  "I can only help with AIOps, Kubernetes, Linux, Prometheus, OpenSearch, and Ceph topics.";

const AIOPS_ALLOWED_PATTERNS: RegExp[] = [
  /\baiops\b/,
  /\b(?:sre|devops)\b/,
  /\b(?:kubernetes|k8s|kubectl|helm|ingress|namespace|daemonset|statefulset|deployment|cluster)\b/,
  /\b(?:linux|ubuntu|debian|rhel|centos|systemd|journalctl|bash|shell)\b/,
  /\b(?:prometheus|promql|alertmanager|node_exporter|exporter|recording\s+rule)\b/,
  /\b(?:opensearch|elasticsearch|lucene)\b/,
  /\b(?:ceph|cephfs|rados|rbd|osd|crush)\b/,
  /\b(?:observability|monitoring|monitorizacao|monitoramento|metrics?|metricas|logs?|alertas?|incidents?|incidentes?)\b/,
  /\b(?:jira|ticket|tickets)\b/,
  /\bslack\b/,
];

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function isPromptAllowedForAiops(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return true;
  }
  if (trimmed.startsWith("/")) {
    return true;
  }
  const normalized = normalizeText(trimmed);
  return AIOPS_ALLOWED_PATTERNS.some((pattern) => pattern.test(normalized));
}

function resolveMergedDomainPolicy(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
}): AgentDomainPolicyConfig | undefined {
  const cfg = params.config;
  if (!cfg) {
    return undefined;
  }
  const defaults = cfg.agents?.defaults?.domainPolicy;
  const sessionAgentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: cfg,
  });
  const agentPolicy = resolveAgentConfig(cfg, sessionAgentId)?.domainPolicy;

  if (!defaults && !agentPolicy) {
    return undefined;
  }
  return {
    ...defaults,
    ...agentPolicy,
  };
}

export function resolveAgentDomainPolicy(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
}): ResolvedAgentDomainPolicy | undefined {
  const merged = resolveMergedDomainPolicy(params);
  if (merged?.enabled !== true) {
    return undefined;
  }

  const profile = merged.profile ?? "aiops";
  const applyTo = merged.applyTo ?? "external_user";
  const refusalMessage = merged.refusalMessage?.trim() || DEFAULT_REFUSAL_MESSAGE;
  return {
    enabled: true,
    profile,
    applyTo,
    refusalMessage,
  };
}

export function shouldEnforceDomainPolicy(params: {
  policy: ResolvedAgentDomainPolicy;
  inputProvenance?: InputProvenance;
}): boolean {
  if (params.policy.applyTo === "all") {
    return true;
  }
  const kind = params.inputProvenance?.kind;
  return kind !== "internal_system" && kind !== "inter_session";
}

export function isPromptAllowedByDomainPolicy(params: {
  prompt: string;
  policy: ResolvedAgentDomainPolicy;
}): boolean {
  if (params.policy.profile === "aiops") {
    return isPromptAllowedForAiops(params.prompt);
  }
  return true;
}
