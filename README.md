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
- External web tools (`web_search`, `web_fetch`): disabled by default.
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

During `openclaw setup` / `openclaw onboard`, this fork now bootstraps a default MCP config at:

- `~/.openclaw/mcporter.json` (or `$OPENCLAW_STATE_DIR/mcporter.json`)

You can override the runtime path with:

- `OPENCLAW_MCPORTER_CONFIG_PATH=/path/to/mcporter.json`

The repository template is provided at:

- `config/mcporter.json`

Use MCP to connect the agent to:

- Prometheus
- Kubernetes
- OpenSearch
- Ceph
- Internal infrastructure documentation
- Jira
- Slack workspace data
- Public websites

## Prompt Injection Hardening

This fork applies the security recommendation from:
https://docs.openclaw.ai/gateway/security#prompt-injection-does-not-require-public-dms

By default:

- `tools.web.search.enabled = false`
- `tools.web.fetch.enabled = false`

This reduces prompt-injection risk from untrusted external content (search snippets and fetched pages) even when DM access is restricted.

If you intentionally need these tools, re-enable explicitly:

```bash
openclaw config set tools.web.search.enabled true
openclaw config set tools.web.fetch.enabled true
```

## Upstream Project

Original upstream project: https://github.com/openclaw/openclaw
