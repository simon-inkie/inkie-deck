import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  assertNoLiveSiloRoot,
  atomicWrite,
  confineToRootReal,
} from "./safe-fs.server.js";
import { resolveDataRoot } from "./queue.server.js";
import { initialQuotaState, type QuotaState } from "./codex-quota.js";

const WindowSchema = z.object({
  usedPercent: z.number().optional(),
  windowDurationMins: z.number().nullable().optional(),
  resetsAt: z.number().nullable().optional(),
});

const SnapshotSchema = z.object({
  limitId: z.string().nullable().optional(),
  limitName: z.string().nullable().optional(),
  primary: WindowSchema.nullable().optional(),
  secondary: WindowSchema.nullable().optional(),
  credits: z
    .object({
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
      balance: z.string().nullable(),
    })
    .nullable()
    .optional(),
  individualLimit: z
    .object({
      limit: z.string(),
      used: z.string(),
      remainingPercent: z.number(),
      resetsAt: z.number(),
    })
    .nullable()
    .optional(),
  spendControlReached: z.boolean().nullable().optional(),
  planType: z.string().nullable().optional(),
  rateLimitReachedType: z
    .enum([
      "rate_limit_reached",
      "workspace_owner_credits_depleted",
      "workspace_member_credits_depleted",
      "workspace_owner_usage_limit_reached",
      "workspace_member_usage_limit_reached",
    ])
    .nullable()
    .optional(),
});

const QuotaStateSchema = z.object({
  version: z.literal(1),
  status: z.enum([
    "UNKNOWN",
    "BLOCKED_CONFIRMED",
    "RECOVERY_CANDIDATE",
    "PROBING",
    "AVAILABLE_CONFIRMED",
  ]),
  observedAt: z.number().nullable(),
  source: z.enum(["none", "full_read", "sparse_update", "clock", "probe"]),
  blockedReason: z
    .enum([
      "rate_limit_reached",
      "workspace_owner_credits_depleted",
      "workspace_member_credits_depleted",
      "workspace_owner_usage_limit_reached",
      "workspace_member_usage_limit_reached",
      "spend_control_reached",
    ])
    .nullable(),
  resetCandidateAt: z.number().nullable(),
  snapshot: SnapshotSchema.nullable(),
});

export class FileCodexQuotaStore {
  constructor(
    private readonly statePath = path.join(resolveDataRoot(), "codex-quota.json"),
    private readonly dataRoot = resolveDataRoot()
  ) {}

  loadResult():
    | { kind: "ok"; state: QuotaState }
    | { kind: "missing" }
    | { kind: "malformed" } {
    let raw: string;
    try {
      raw = fs.readFileSync(this.statePath, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return { kind: "missing" };
      }
      return { kind: "malformed" };
    }
    try {
      const parsed = QuotaStateSchema.safeParse(JSON.parse(raw));
      return parsed.success
        ? { kind: "ok", state: parsed.data }
        : { kind: "malformed" };
    } catch {
      return { kind: "malformed" };
    }
  }

  load(): QuotaState {
    const result = this.loadResult();
    return result.kind === "ok" ? result.state : initialQuotaState();
  }

  save(state: QuotaState): void {
    const rootReal = fs.realpathSync(this.dataRoot);
    assertNoLiveSiloRoot(rootReal, "data");
    const safePath = confineToRootReal(this.statePath, rootReal, {
      forWrite: true,
      label: "data",
    });
    const redacted = QuotaStateSchema.parse(state);
    atomicWrite(safePath, JSON.stringify(redacted, null, 2) + "\n");
  }
}
