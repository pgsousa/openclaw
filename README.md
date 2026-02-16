# OpenClaw AIOps (Slack + Linux)

This fork of OpenClaw is specialized for AIOps operations in Linux environments.

## Scope

The assistant is restricted to:

- AIOps
- Kubernetes
- Linux
- Prometheus
- OpenSearch
- Ceph

Out-of-scope requests are refused with this default message:

`I can only help with AIOps, Kubernetes, Linux, Prometheus, OpenSearch, and Ceph topics.`

## Runtime Profile in This Fork

- Platform: Linux only.
- Channel: Slack only.
- Browser tool: removed.
- Bundled skills: `github`, `healthcheck`, `mcporter`.
- MCP access: built in via `mcporter` (packaged dependency).

This fork is intended to connect to operational systems such as Prometheus, Kubernetes, OpenSearch, Ceph, infrastructure documentation, Jira, Slack, and public websites through MCP tooling.

## Default Domain Policy

This repository ships with strict AIOps domain policy defaults for external users.

You can verify or override with:

```bash
openclaw config set agents.defaults.domainPolicy.enabled true
openclaw config set agents.defaults.domainPolicy.profile aiops
openclaw config set agents.defaults.domainPolicy.applyTo external_user
openclaw config set agents.defaults.domainPolicy.refusalMessage "I can only help with AIOps, Kubernetes, Linux, Prometheus, OpenSearch, and Ceph topics."
```

## Installation

Runtime baseline: Node 22+

```bash
git clone https://github.com/pgsousa/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm openclaw onboard --install-daemon
```

## Slack Setup (Only Channel)

Configure Slack credentials in your OpenClaw config (or environment), then run:

```bash
openclaw channels add --channel slack
openclaw gateway run --bind loopback --port 18789
```

## MCP and Infra Access

`mcporter` is included in this fork so MCP integrations can be enabled without a separate global install.

Use MCP to connect the agent to:

- Prometheus
- Kubernetes
- OpenSearch
- Ceph
- Internal infrastructure documentation
- Jira
- Slack workspace data
- Public websites

## Upstream Project

Original upstream project: https://github.com/openclaw/openclaw
