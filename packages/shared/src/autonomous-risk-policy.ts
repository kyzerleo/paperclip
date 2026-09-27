import { z } from "zod";

const autonomousRiskIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const autonomousTimestampSchema = z.string().datetime({ offset: true });
const SENSITIVE_VALUE_PATTERN = /api[_-]?key\s*[:=]|secret\s*[:=]|token\s*[:=]|password\s*[:=]|credential\s*[:=]|chain[_ -]?of[_ -]?thought|reasoning\s*[:=]|raw[_ -]?output/i;
const SENSITIVE_FIELD_PATTERN = /api[_-]?key|secret|token|password|credential|authorization|private\s*key|chain[_ -]?of[_ -]?thought|reasoning|raw[_ -]?output|prompt/i;

export const AUTONOMOUS_RISK_CLASSES = ["LOW", "MEDIUM", "HIGH"] as const;
export type AutonomousRiskClass = (typeof AUTONOMOUS_RISK_CLASSES)[number];
export const autonomousRiskClassSchema = z.enum(AUTONOMOUS_RISK_CLASSES);

export const AUTONOMOUS_APPROVAL_STATES = ["NOT_REQUIRED", "PENDING", "GRANTED", "DENIED"] as const;
export type AutonomousApprovalState = (typeof AUTONOMOUS_APPROVAL_STATES)[number];
export const autonomousApprovalStateSchema = z.enum(AUTONOMOUS_APPROVAL_STATES);

export const AUTONOMOUS_RISK_OUTCOMES = ["ALLOW", "DENY", "REQUIRE_APPROVAL"] as const;
export type AutonomousRiskOutcome = (typeof AUTONOMOUS_RISK_OUTCOMES)[number];
export const autonomousRiskOutcomeSchema = z.enum(AUTONOMOUS_RISK_OUTCOMES);

export const AUTONOMOUS_RISK_REASON_CODES = [
  "low_disposable",
  "missing_checkpoint",
  "missing_backup",
  "checkpoint_and_backup_present",
  "approval_required",
  "approval_denied",
  "missing_rollback",
  "approval_and_rollback_present",
] as const;
export type AutonomousRiskReasonCode = (typeof AUTONOMOUS_RISK_REASON_CODES)[number];
export const autonomousRiskReasonCodeSchema = z.enum(AUTONOMOUS_RISK_REASON_CODES);

const artifactRefSchema = z.string().min(1).max(512).regex(/^artifact:\/\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

export const autonomousCheckpointManifestSchema = z
  .object({
    manifestId: autonomousRiskIdSchema,
    actionId: autonomousRiskIdSchema,
    executionId: autonomousRiskIdSchema,
    taskId: autonomousRiskIdSchema,
    createdAt: autonomousTimestampSchema,
    scope: autonomousRiskIdSchema,
    artifactRefs: z.array(artifactRefSchema).min(1).max(100),
  })
  .strict();
export type AutonomousCheckpointManifest = z.infer<typeof autonomousCheckpointManifestSchema>;

export const autonomousBackupManifestSchema = z
  .object({
    manifestId: autonomousRiskIdSchema,
    actionId: autonomousRiskIdSchema,
    executionId: autonomousRiskIdSchema,
    taskId: autonomousRiskIdSchema,
    createdAt: autonomousTimestampSchema,
    sourceRef: artifactRefSchema,
    artifactRefs: z.array(artifactRefSchema).min(1).max(100),
  })
  .strict();
export type AutonomousBackupManifest = z.infer<typeof autonomousBackupManifestSchema>;

export const autonomousRollbackCommandMetadataSchema = z
  .object({
    rollbackId: autonomousRiskIdSchema,
    manifestId: autonomousRiskIdSchema,
    command: z.string().trim().min(1).max(512),
    args: z.array(z.string().max(512)).max(100),
    reason: z.string().trim().min(1).max(240),
  })
  .strict()
  .superRefine((value, ctx) => {
    const values = [value.command, value.reason, ...value.args];
    if (values.some((entry) => SENSITIVE_VALUE_PATTERN.test(entry) || SENSITIVE_FIELD_PATTERN.test(entry))) {
      ctx.addIssue({ code: "custom", message: "Rollback metadata must be redacted" });
    }
  });
export type AutonomousRollbackCommandMetadata = z.infer<typeof autonomousRollbackCommandMetadataSchema>;

export const autonomousRollbackManifestSchema = z
  .object({
    manifestId: autonomousRiskIdSchema,
    actionId: autonomousRiskIdSchema,
    executionId: autonomousRiskIdSchema,
    taskId: autonomousRiskIdSchema,
    createdAt: autonomousTimestampSchema,
    backupManifestId: autonomousRiskIdSchema,
    command: autonomousRollbackCommandMetadataSchema,
  })
  .strict();
export type AutonomousRollbackManifest = z.infer<typeof autonomousRollbackManifestSchema>;

const autonomousRollbackEvidenceSchema = z.union([
  autonomousRollbackCommandMetadataSchema,
  autonomousRollbackManifestSchema,
]);

export const autonomousRiskInputSchema = z
  .object({
    actionId: autonomousRiskIdSchema,
    executionId: autonomousRiskIdSchema,
    taskId: autonomousRiskIdSchema,
    risk: autonomousRiskClassSchema,
    approval: autonomousApprovalStateSchema,
    checkpoint: autonomousCheckpointManifestSchema.nullable(),
    backup: autonomousBackupManifestSchema.nullable(),
    rollback: autonomousRollbackEvidenceSchema.nullable(),
  })
  .strict();
export type AutonomousRiskInput = z.infer<typeof autonomousRiskInputSchema>;

export const autonomousRiskDecisionSchema = z
  .object({
    decisionId: z.string().min(1).max(1024),
    actionId: autonomousRiskIdSchema,
    executionId: autonomousRiskIdSchema,
    taskId: autonomousRiskIdSchema,
    risk: autonomousRiskClassSchema,
    outcome: autonomousRiskOutcomeSchema,
    reasonCode: autonomousRiskReasonCodeSchema,
    disposable: z.boolean(),
    requiresCheckpoint: z.boolean(),
    requiresBackup: z.boolean(),
    requiresApproval: z.boolean(),
    requiresRollback: z.boolean(),
    checkpointManifestId: autonomousRiskIdSchema.nullable(),
    backupManifestId: autonomousRiskIdSchema.nullable(),
    rollback: autonomousRollbackEvidenceSchema.nullable(),
  })
  .strict();
export type AutonomousRiskDecision = z.infer<typeof autonomousRiskDecisionSchema>;

function manifestMatches(
  manifest: { actionId: string; executionId: string; taskId: string } | null,
  input: AutonomousRiskInput,
): boolean {
  return manifest !== null && manifest.actionId === input.actionId && manifest.executionId === input.executionId && manifest.taskId === input.taskId;
}

function decision(
  input: AutonomousRiskInput,
  outcome: AutonomousRiskOutcome,
  reasonCode: AutonomousRiskReasonCode,
  requirements: {
    disposable: boolean;
    checkpoint: boolean;
    backup: boolean;
    approval: boolean;
    rollback: boolean;
  },
): AutonomousRiskDecision {
  return autonomousRiskDecisionSchema.parse({
    decisionId: `autonomous-risk/${input.actionId}/${input.risk}/${outcome}/${reasonCode}`,
    actionId: input.actionId,
    executionId: input.executionId,
    taskId: input.taskId,
    risk: input.risk,
    outcome,
    reasonCode,
    disposable: requirements.disposable,
    requiresCheckpoint: requirements.checkpoint,
    requiresBackup: requirements.backup,
    requiresApproval: requirements.approval,
    requiresRollback: requirements.rollback,
    checkpointManifestId: input.checkpoint?.manifestId ?? null,
    backupManifestId: input.backup?.manifestId ?? null,
    rollback: input.rollback,
  });
}

/** Pure D9 risk policy; it returns a manifest/approval proposal and never applies it. */
export function decideAutonomousRisk(input: AutonomousRiskInput): AutonomousRiskDecision {
  const parsed = autonomousRiskInputSchema.parse(input);
  if (parsed.risk === "LOW") {
    return decision(parsed, "ALLOW", "low_disposable", {
      disposable: true,
      checkpoint: false,
      backup: false,
      approval: false,
      rollback: false,
    });
  }
  if (parsed.risk === "MEDIUM") {
    if (!manifestMatches(parsed.checkpoint, parsed)) {
      return decision(parsed, "DENY", "missing_checkpoint", {
        disposable: false,
        checkpoint: true,
        backup: true,
        approval: false,
        rollback: false,
      });
    }
    if (!manifestMatches(parsed.backup, parsed)) {
      return decision(parsed, "DENY", "missing_backup", {
        disposable: false,
        checkpoint: true,
        backup: true,
        approval: false,
        rollback: false,
      });
    }
    return decision(parsed, "ALLOW", "checkpoint_and_backup_present", {
      disposable: false,
      checkpoint: true,
      backup: true,
      approval: false,
      rollback: false,
    });
  }
  if (parsed.approval === "PENDING" || parsed.approval === "NOT_REQUIRED") {
    return decision(parsed, "REQUIRE_APPROVAL", "approval_required", {
      disposable: false,
      checkpoint: false,
      backup: false,
      approval: true,
      rollback: true,
    });
  }
  if (parsed.approval === "DENIED") {
    return decision(parsed, "DENY", "approval_denied", {
      disposable: false,
      checkpoint: false,
      backup: false,
      approval: true,
      rollback: true,
    });
  }
  if (!parsed.rollback) {
    return decision(parsed, "DENY", "missing_rollback", {
      disposable: false,
      checkpoint: false,
      backup: false,
      approval: true,
      rollback: true,
    });
  }
  return decision(parsed, "ALLOW", "approval_and_rollback_present", {
    disposable: false,
    checkpoint: false,
    backup: false,
    approval: true,
    rollback: true,
  });
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Unknown rollback metadata field: ${unknown}`);
}

function redactText(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return SENSITIVE_VALUE_PATTERN.test(trimmed) || SENSITIVE_FIELD_PATTERN.test(trimmed) ? "[REDACTED]" : trimmed;
}

/** Projects command text into bounded, redacted metadata; unknown fields fail closed. */
export function createAutonomousRollbackCommandMetadata(input: unknown): AutonomousRollbackCommandMetadata {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Rollback metadata must be an object");
  }
  const record = input as Record<string, unknown>;
  assertAllowedKeys(record, ["rollbackId", "manifestId", "command", "args", "reason"]);
  return autonomousRollbackCommandMetadataSchema.parse({
    rollbackId: record.rollbackId,
    manifestId: record.manifestId,
    command: redactText(record.command),
    args: Array.isArray(record.args) ? record.args.map(redactText) : record.args,
    reason: redactText(record.reason),
  });
}

export function createAutonomousCheckpointManifest(input: AutonomousCheckpointManifest): AutonomousCheckpointManifest {
  return autonomousCheckpointManifestSchema.parse(input);
}

export function createAutonomousBackupManifest(input: AutonomousBackupManifest): AutonomousBackupManifest {
  return autonomousBackupManifestSchema.parse(input);
}

export function createAutonomousRollbackManifest(input: AutonomousRollbackManifest): AutonomousRollbackManifest {
  return autonomousRollbackManifestSchema.parse(input);
}
