import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  createAutonomousEffectRecord,
  type AutonomousActionRequest,
} from "@paperclipai/shared";
import { mapPaperclipExecutionToHermesRequest } from "@paperclipai/hermes-paperclip-adapter/gateway/server";
import {
  admitHeartbeatAutonomousAction,
  type HeartbeatAutonomousAdmissionInput,
} from "./heartbeat-autonomous-admission.js";

const db = {} as Db;

function decision(request: AutonomousActionRequest) {
  return {
    decisionId: `autonomous-dedup/${request.actionId}/ACCEPT`,
    actionId: request.actionId,
    idempotencyKey: request.idempotencyKey,
    effectKey: "autonomous-effect/test/00000000",
    effectFingerprint: "00000000",
    outcome: "ACCEPT" as const,
    reasonCode: "new_effect" as const,
    existingActionId: null,
  };
}

function input(
  context: Record<string, unknown> = {},
  ledger: NonNullable<HeartbeatAutonomousAdmissionInput["ledger"]>,
): HeartbeatAutonomousAdmissionInput {
  return {
    db,
    adapterType: "hermes_gateway",
    companyId: "tenant-1",
    workerId: "worker-1",
    executionId: "run-1",
    runId: "run-1",
    context: {
      taskId: "task-1",
      projectId: "project-1",
      boardId: "board-1",
      autonomous: {},
      ...context,
    },
    ledger,
  };
}

describe("heartbeat autonomous admission boundary", () => {
  it("records the company/worker/task admission and consumes it once", async () => {
    const registered: AutonomousActionRequest[] = [];
    const ledger = {
      register: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => {
        registered.push(request);
        return decision(request);
      },
      consume: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => ({
        outcome: "CONSUMED" as const,
        actionId: request.actionId,
        effectKey: "autonomous-effect/test/00000000",
        effectFingerprint: "00000000",
      }),
    };

    const result = await admitHeartbeatAutonomousAction(input({}, ledger));

    expect(result.outcome).toBe("CONSUMED");
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      executionId: "run-1",
      taskId: "task-1",
      workerId: "worker-1",
      effectType: "hermes_gateway.run",
      effectPayload: {
        companyId: "tenant-1",
        scope: "tenant-1/project-1/board-1/task-1/worker-1",
        risk: "LOW",
        approval: "NOT_REQUIRED",
        gateDecision: "PASS",
        riskOutcome: "ALLOW",
      },
    });

    const mapped = mapPaperclipExecutionToHermesRequest({
      runId: "run-1",
      agent: {
        id: "worker-1",
        companyId: "tenant-1",
        name: "Hermes",
        adapterType: "hermes_gateway",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: "task-1",
      },
      config: { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "[REDACTED]" },
      context: {
        taskId: "task-1",
        projectId: "project-1",
        boardId: "board-1",
        autonomous: {},
      },
      onLog: async () => undefined,
    });
    expect(createAutonomousEffectRecord(registered[0]).effectFingerprint).toBe(
      mapped.body.autonomous.effectFingerprint,
    );
    expect(createAutonomousEffectRecord(registered[0]).effectKey).toBe(
      mapped.body.autonomous.effectKey,
    );
  });

  it("blocks a duplicate action at the server boundary before adapter execution", async () => {
    const request = {
      actionId: "autonomous-action/run-1/task-1/1/WAKEUP",
      idempotencyKey: "autonomous-idempotency/run-1/task-1/1/WAKEUP",
    };
    const ledger = {
      register: async (_db: Db, _companyId: string, action: AutonomousActionRequest) =>
        ({ ...decision(action), outcome: "RETURN_EXISTING" as const, reasonCode: "duplicate_effect" as const, existingActionId: action.actionId }),
      consume: async () => ({
        outcome: "ALREADY_CONSUMED" as const,
        actionId: request.actionId,
        effectKey: "autonomous-effect/test/00000000",
        effectFingerprint: "00000000",
      }),
    };

    await expect(admitHeartbeatAutonomousAction(input({}, ledger))).rejects.toThrow(
      "autonomous_heartbeat_admission_duplicate",
    );
  });

  it("records a failed gate and denies before the adapter boundary", async () => {
    let consumeCalls = 0;
    let registered: AutonomousActionRequest | null = null;
    const ledger = {
      register: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => {
        registered = request;
        return decision(request);
      },
      consume: async () => {
        consumeCalls += 1;
        throw new Error("consume must not run on deny");
      },
    };

    await expect(
      admitHeartbeatAutonomousAction(
        input({ autonomous: { gates: [{ gateId: "scope", decision: "FAIL" }] } }, ledger),
      ),
    ).rejects.toThrow("autonomous_heartbeat_admission_denied:gate_failed_or_missing");
    expect(registered).toMatchObject({
      taskId: "task-1",
      workerId: "worker-1",
      effectPayload: { gateDecision: "FAIL", riskOutcome: "ALLOW" },
    });
    expect(consumeCalls).toBe(0);
  });

  it("fails closed for non-low risk without a granted risk decision", async () => {
    let registered: AutonomousActionRequest | null = null;
    const ledger = {
      register: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => {
        registered = request;
        return decision(request);
      },
      consume: async () => {
        throw new Error("consume must not run on deny");
      },
    };

    await expect(
      admitHeartbeatAutonomousAction(
        input({ autonomous: { risk: "HIGH", gates: [{ gateId: "scope", decision: "PASS" }] } }, ledger),
      ),
    ).rejects.toThrow("autonomous_heartbeat_admission_denied:non_low_risk_requires_granted_approval");
    expect(registered).toMatchObject({
      effectPayload: { risk: "HIGH", approval: "NOT_REQUIRED", gateDecision: "PASS", riskOutcome: "DENY" },
    });
  });

  it("fails closed for an explicitly denied approval", async () => {
    const ledger = {
      register: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => decision(request),
      consume: async () => {
        throw new Error("consume must not run on deny");
      },
    };

    await expect(
      admitHeartbeatAutonomousAction(
        input({ autonomous: { approval: "DENIED" } }, ledger),
      ),
    ).rejects.toThrow("autonomous_heartbeat_admission_denied:approval_not_granted");
  });
});
