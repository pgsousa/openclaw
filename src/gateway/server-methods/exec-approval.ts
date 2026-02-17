import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import type { GatewayRequestHandlers } from "./types.js";
import {
  DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  type ExecApprovalDecision,
} from "../../infra/exec-approvals.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateExecApprovalRequestParams,
  validateExecApprovalResolveParams,
} from "../protocol/index.js";

const APPROVAL_ID_SLUG_PATTERN = /^[0-9a-f]{8}$/i;

export function createExecApprovalHandlers(
  manager: ExecApprovalManager,
  opts?: { forwarder?: ExecApprovalForwarder },
): GatewayRequestHandlers {
  return {
    "exec.approval.request": async ({ params, respond, context, client }) => {
      if (!validateExecApprovalRequestParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid exec.approval.request params: ${formatValidationErrors(
              validateExecApprovalRequestParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as {
        id?: string;
        command: string;
        cwd?: string;
        host?: string;
        security?: string;
        ask?: string;
        agentId?: string;
        resolvedPath?: string;
        sessionKey?: string;
        timeoutMs?: number;
        twoPhase?: boolean;
      };
      const twoPhase = p.twoPhase === true;
      const timeoutMs =
        typeof p.timeoutMs === "number" ? p.timeoutMs : DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
      const explicitId = typeof p.id === "string" && p.id.trim().length > 0 ? p.id.trim() : null;
      if (explicitId && manager.getSnapshot(explicitId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval id already pending"),
        );
        return;
      }
      const request = {
        command: p.command,
        cwd: p.cwd ?? null,
        host: p.host ?? null,
        security: p.security ?? null,
        ask: p.ask ?? null,
        agentId: p.agentId ?? null,
        resolvedPath: p.resolvedPath ?? null,
        sessionKey: p.sessionKey ?? null,
      };

      const requester = {
        clientId: client?.connect?.client?.id ?? null,
        deviceId: client?.connect?.device?.id ?? null,
      };
      const fingerprint = manager.fingerprintRequest(request, requester);

      // If the caller didn't specify an id, try to reuse an already-pending approval for the
      // same request. This prevents spamming the operator with new ids for the same action
      // when the LLM retries or the user repeats a "fix" message.
      if (!explicitId) {
        const pending = manager.getPendingByFingerprint(fingerprint);
        if (pending) {
          // Preserve single-response semantics for existing callers, while allowing
          // twoPhase callers to get the id immediately.
          if (twoPhase) {
            respond(
              true,
              {
                status: "accepted",
                id: pending.id,
                createdAtMs: pending.createdAtMs,
                expiresAtMs: pending.expiresAtMs,
              },
              undefined,
            );
          }
          const decisionPromise = manager.awaitDecision(pending.id);
          if (!decisionPromise) {
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.INVALID_REQUEST, "approval expired or not found"),
            );
            return;
          }
          const decision = await decisionPromise;
          respond(
            true,
            {
              id: pending.id,
              decision,
              createdAtMs: pending.createdAtMs,
              expiresAtMs: pending.expiresAtMs,
            },
            undefined,
          );
          return;
        }
      }
      const record = manager.create(request, timeoutMs, explicitId);
      record.requestedByConnId = client?.connId ?? null;
      record.requestedByDeviceId = client?.connect?.device?.id ?? null;
      record.requestedByClientId = client?.connect?.client?.id ?? null;
      // Use register() to synchronously add to pending map before sending any response.
      // This ensures the approval ID is valid immediately after the "accepted" response.
      let decisionPromise: Promise<
        import("../../infra/exec-approvals.js").ExecApprovalDecision | null
      >;
      try {
        decisionPromise = manager.register(record, timeoutMs, fingerprint);
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `registration failed: ${String(err)}`),
        );
        return;
      }
      context.broadcast(
        "exec.approval.requested",
        {
          id: record.id,
          request: record.request,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        { dropIfSlow: true },
      );
      void opts?.forwarder
        ?.handleRequested({
          id: record.id,
          request: record.request,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        })
        .catch((err) => {
          context.logGateway?.error?.(`exec approvals: forward request failed: ${String(err)}`);
        });

      // Only send immediate "accepted" response when twoPhase is requested.
      // This preserves single-response semantics for existing callers.
      if (twoPhase) {
        respond(
          true,
          {
            status: "accepted",
            id: record.id,
            createdAtMs: record.createdAtMs,
            expiresAtMs: record.expiresAtMs,
          },
          undefined,
        );
      }

      const decision = await decisionPromise;
      // Send final response with decision for callers using expectFinal:true.
      respond(
        true,
        {
          id: record.id,
          decision,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        undefined,
      );
    },
    "exec.approval.waitDecision": async ({ params, respond }) => {
      const p = params as { id?: string };
      const rawId = typeof p.id === "string" ? p.id.trim() : "";
      if (!rawId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
        return;
      }
      const resolvedId = (() => {
        const direct = manager.awaitDecision(rawId);
        if (direct) {
          return rawId;
        }
        if (!APPROVAL_ID_SLUG_PATTERN.test(rawId)) {
          return rawId;
        }
        const matches = manager.findIdsByPrefix(rawId);
        if (matches.length === 1) {
          return matches[0];
        }
        return rawId;
      })();
      const decisionPromise = manager.awaitDecision(resolvedId);
      if (!decisionPromise) {
        if (APPROVAL_ID_SLUG_PATTERN.test(rawId)) {
          const matches = manager.findIdsByPrefix(rawId);
          if (matches.length > 1) {
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.INVALID_REQUEST, `ambiguous approval id prefix '${rawId}'`, {
                details: { matches },
              }),
            );
            return;
          }
        }
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval expired or not found"),
        );
        return;
      }
      // Capture snapshot before await (entry may be deleted after grace period)
      const snapshot = manager.getSnapshot(resolvedId);
      const decision = await decisionPromise;
      // Return decision (can be null on timeout) - let clients handle via askFallback
      respond(
        true,
        {
          id: resolvedId,
          decision,
          createdAtMs: snapshot?.createdAtMs,
          expiresAtMs: snapshot?.expiresAtMs,
        },
        undefined,
      );
    },
    "exec.approval.resolve": async ({ params, respond, client, context }) => {
      if (!validateExecApprovalResolveParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid exec.approval.resolve params: ${formatValidationErrors(
              validateExecApprovalResolveParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as { id: string; decision: string };
      const decision = p.decision as ExecApprovalDecision;
      if (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid decision"));
        return;
      }
      const resolvedBy = client?.connect?.client?.displayName ?? client?.connect?.client?.id;
      const rawId = p.id.trim();
      let resolvedId = rawId;
      let ok = manager.resolve(resolvedId, decision, resolvedBy ?? null);
      if (!ok && APPROVAL_ID_SLUG_PATTERN.test(rawId)) {
        const matches = manager.findOpenPendingIdsByPrefix(rawId);
        if (matches.length === 1) {
          resolvedId = matches[0]!;
          ok = manager.resolve(resolvedId, decision, resolvedBy ?? null);
        } else if (matches.length > 1) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `ambiguous approval id prefix '${rawId}'`, {
              details: { matches },
            }),
          );
          return;
        }
      }
      if (!ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown approval id"));
        return;
      }
      context.broadcast(
        "exec.approval.resolved",
        { id: resolvedId, decision, resolvedBy, ts: Date.now() },
        { dropIfSlow: true },
      );
      void opts?.forwarder
        ?.handleResolved({ id: resolvedId, decision, resolvedBy, ts: Date.now() })
        .catch((err) => {
          context.logGateway?.error?.(`exec approvals: forward resolve failed: ${String(err)}`);
        });
      respond(true, { ok: true }, undefined);
    },
  };
}
