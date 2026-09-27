import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTONOMOUS_MERGE_GATE_IDS,
} from "./autonomous-merge-gate.js";
import type { AutonomousGateEvidence } from "./autonomous-state-contract.js";
import {
  createDisposableAutonomousFixture,
  type DisposableAutonomousFixture,
  type DisposableScope,
} from "./testing/autonomous-disposable-fixture.js";

const openFixtures: DisposableAutonomousFixture[] = [];

function disposableId(label: string): string {
  return `d10-${label}-${randomUUID()}`;
}

function scope(overrides: Partial<DisposableScope> = {}): DisposableScope {
  return {
    tenantId: disposableId("tenant"),
    projectId: disposableId("project"),
    boardId: disposableId("board"),
    ...overrides,
  };
}

async function fixture(): Promise<DisposableAutonomousFixture> {
  const value = await createDisposableAutonomousFixture();
  openFixtures.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(openFixtures.splice(0).map((value) => value.dispose()));
});

describe("D10 disposable autonomous orchestration fixture", () => {
  it("gates child readiness on a PASS parent while independent workers claim in parallel", async () => {
    const harness = await fixture();
    const sharedScope = scope();
    const parentTaskId = disposableId("parent");
    const childTaskId = disposableId("child");
    const independentTaskIds = [disposableId("independent-a"), disposableId("independent-b")];

    harness.addTask({ taskId: parentTaskId, scope: sharedScope });
    harness.addTask({ taskId: childTaskId, parentTaskId, scope: sharedScope });
    for (const taskId of independentTaskIds) harness.addTask({ taskId, scope: sharedScope });

    expect(harness.isReady(childTaskId)).toBe(false);
    expect(harness.claim(childTaskId, disposableId("worker-child-before-parent"))).toEqual({
      outcome: "DENY",
      reason: "DEPENDENCY_NOT_PASS",
    });

    expect(harness.claim(parentTaskId, disposableId("worker-parent")).outcome).toBe("CLAIMED");
    harness.complete(parentTaskId);
    expect(harness.isReady(childTaskId)).toBe(true);

    const independentClaims = await Promise.all(
      independentTaskIds.map((taskId) =>
        Promise.resolve(harness.claim(taskId, disposableId(`worker-${taskId}`))),
      ),
    );
    expect(independentClaims.map((claim) => claim.outcome)).toEqual(["CLAIMED", "CLAIMED"]);
    expect(harness.claim(childTaskId, disposableId("worker-child-after-parent")).outcome).toBe("CLAIMED");
  });

  it("denies foreign task, board, tenant, and project mutations deterministically", async () => {
    const harness = await fixture();
    const authorizedScope = scope();
    const taskId = disposableId("scoped-task");
    const workerId = disposableId("scoped-worker");
    harness.addTask({ taskId, scope: authorizedScope });
    harness.registerWorker({ workerId, taskId, scope: authorizedScope });

    const mutations = [
      { field: "task", request: { taskId: disposableId("foreign-task"), ...authorizedScope } },
      { field: "board", request: { taskId, ...authorizedScope, boardId: disposableId("foreign-board") } },
      { field: "tenant", request: { taskId, ...authorizedScope, tenantId: disposableId("foreign-tenant") } },
      { field: "project", request: { taskId, ...authorizedScope, projectId: disposableId("foreign-project") } },
    ] as const;

    for (const mutation of mutations) {
      const first = harness.mutateTask(workerId, mutation.request);
      const second = harness.mutateTask(workerId, mutation.request);
      expect(first).toEqual({ outcome: "DENY", reason: `SCOPE_DENIED_${mutation.field.toUpperCase()}` });
      expect(second).toEqual(first);
    }
  });

  it("evaluates PASS, FAIL, and SKIP gate evidence deterministically through the fixture", async () => {
    const harness = await fixture();
    const taskId = disposableId("gates");
    harness.addTask({ taskId, scope: scope() });
    const base: Omit<AutonomousGateEvidence, "gateId" | "status" | "observed" | "exitCode" | "evidenceRef"> = {
      command: "fixture-test --deterministic",
      expected: "fixture-ok",
      timestamp: "2026-09-27T00:00:00.000Z",
    };
    const evidence = [
      { gateId: "gate-pass", status: "PASS" as const, observed: "fixture-ok", exitCode: 0 },
      { gateId: "gate-fail", status: "FAIL" as const, observed: "fixture-error", exitCode: 1 },
      { gateId: "gate-skip", status: "SKIP" as const, observed: "not-run", exitCode: null },
    ].map((entry) => ({
      ...base,
      ...entry,
      evidenceRef: `artifact://${taskId}/${entry.gateId}`,
    }));

    expect(harness.evaluateGate(taskId, evidence[0]!)).toBe("PASS");
    expect(harness.evaluateGate(taskId, evidence[1]!)).toBe("FAIL");
    expect(harness.evaluateGate(taskId, evidence[2]!)).toBe("SKIP");
    expect(harness.evaluateGate(taskId, evidence[0]!)).toBe(harness.evaluateGate(taskId, evidence[0]!));
    expect(harness.getEnvelope(taskId).gates).toEqual([
      { gateId: "gate-pass", decision: "PASS" },
      { gateId: "gate-fail", decision: "FAIL" },
      { gateId: "gate-skip", decision: "SKIP" },
    ]);
  });

  it("runs transient attempts 1, 2, and 3 before REPLANNING or BLOCKED", async () => {
    const harness = await fixture();
    const replanningTaskId = disposableId("replanning");
    const blockedTaskId = disposableId("blocked");
    harness.addTask({ taskId: replanningTaskId, scope: scope() });
    harness.addTask({ taskId: blockedTaskId, scope: scope() });
    harness.claim(replanningTaskId, disposableId("replanning-worker"));
    harness.claim(blockedTaskId, disposableId("blocked-worker"));

    const replanning = [1, 2, 3].map(() => harness.injectTransientFailure(replanningTaskId, true));
    const blocked = [1, 2, 3].map(() => harness.injectTransientFailure(blockedTaskId, false));

    expect(replanning.map((decision) => [decision.attempt, decision.disposition])).toEqual([
      [1, "RETRYING"],
      [2, "RETRYING"],
      [3, "REPLANNING"],
    ]);
    expect(blocked.map((decision) => [decision.attempt, decision.disposition])).toEqual([
      [1, "RETRYING"],
      [2, "RETRYING"],
      [3, "BLOCKED"],
    ]);
    expect(harness.getEnvelope(replanningTaskId).state).toBe("REPLANNING");
    expect(harness.getEnvelope(blockedTaskId).state).toBe("BLOCKED");
  });

  it("persists one durable effect outcome for a duplicate ACTION_ID", async () => {
    const harness = await fixture();
    const taskId = disposableId("effect");
    harness.addTask({ taskId, scope: scope() });
    const request = harness.actionRequest({
      actionId: disposableId("action"),
      idempotencyKey: disposableId("idem"),
      executionId: disposableId("execution"),
      taskId,
      kind: "EFFECT",
      effectType: "fixture.write",
      effectPayload: { value: "one" },
    });

    const first = harness.applyAction(request);
    const second = harness.applyAction(request);

    expect(first.outcome).toBe("ACCEPT");
    expect(second.outcome).toBe("RETURN_EXISTING");
    expect(harness.effectCount()).toBe(1);
    expect(harness.persistedEffectCount()).toBe(1);
  });

  it("denies controlled merge on a failed gate and allows exactly-once passing gates", async () => {
    const harness = await fixture();
    const taskId = disposableId("merge-task");
    const workerId = disposableId("merge-worker");
    const scopeId = disposableId("merge-scope");
    const failed = harness.mergeRequest({ taskId, workerId, scopeId, failedGate: "test" });
    const allowed = harness.mergeRequest({ taskId, workerId, scopeId });

    expect(harness.decideMerge(failed)).toMatchObject({
      outcome: "DENY",
      reasonCode: "gate_failed",
      failedGates: ["test"],
    });
    const decision = harness.decideMerge(allowed);
    expect(decision).toMatchObject({
      outcome: "ALLOW",
      reasonCode: "all_gates_passed",
      failedGates: [],
    });
    expect(decision.evidence.map((entry) => entry.gateId)).toEqual([...AUTONOMOUS_MERGE_GATE_IDS]);
  });

  it("rehydrates the persisted envelope on restart without duplicate worker or wakeup", async () => {
    const harness = await fixture();
    const taskId = disposableId("restart-task");
    const workerId = disposableId("restart-worker");
    const taskScope = scope();
    harness.addTask({ taskId, scope: taskScope });
    expect(harness.claim(taskId, workerId).outcome).toBe("CLAIMED");
    const wakeup = harness.actionRequest({
      actionId: disposableId("wakeup-action"),
      idempotencyKey: disposableId("wakeup-key"),
      executionId: disposableId("restart-execution"),
      taskId,
      kind: "WAKEUP",
      effectType: "fixture.wakeup",
      effectPayload: { reason: "restart" },
    });
    expect(harness.applyAction(wakeup).outcome).toBe("ACCEPT");

    const restarted = await harness.restartLike();
    openFixtures.push(restarted);
    expect(restarted.getEnvelope(taskId).state).toBe("RUNNING");
    expect(restarted.ensureWorker({ workerId, taskId, scope: taskScope })).toEqual({ outcome: "EXISTING" });
    expect(restarted.applyAction(wakeup).outcome).toBe("RETURN_EXISTING");
    expect(restarted.workerCount()).toBe(1);
    expect(restarted.wakeupCount()).toBe(1);
  });
});
