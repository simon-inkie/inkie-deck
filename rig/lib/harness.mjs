/**
 * The harness: completeness accounting, the two-kinds-of-failure rule, and
 * the report.
 *
 * TWO STRUCTURAL GUARDS, both of them reactions to specific ways a check
 * suite lies.
 *
 * 1. COMPLETENESS. The stage list is data, declared before the run. A harness
 *    that discovers its own work list reports success over the empty set the
 *    day its discovery breaks, and the sentence it prints on that day is
 *    identical to the one it prints when everything ran. So N comes from the
 *    declaration and never from counting what happened, a declared stage that
 *    did not execute fails the run, and a result for an undeclared stage fails
 *    it too (that one means the declaration and the runner have drifted apart,
 *    which makes the accounting meaningless in both directions).
 *
 * 2. PRODUCT FAILURE IS NOT RIG FAILURE. A red probe means the product is
 *    broken in the measured environment. A negative control that did not go
 *    red means the PROBE is broken, and every green result it produced this
 *    run is worthless. Those two readings are unrelated, so they never share
 *    an exit code or a line in the summary.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { RigError } from "./exec.mjs";

export const STATUS = {
  PASS: "PASS",
  PRODUCT_FAIL: "PRODUCT_FAIL",
  RIG_FAIL: "RIG_FAIL",
  DID_NOT_RUN: "DID_NOT_RUN",
};

/**
 * A positive assertion about the environment under test.
 *
 * `severity: "finding"` is for things that are true of the product and worth
 * recording but are not the rig's to fail on - the shape of a Node 20
 * rejection, for instance, where the plan's instruction is to record HOW it
 * fails rather than to require any particular how.
 *
 * @param {{ id: string, title: string, ok: boolean, detail?: string, severity?: "fail"|"finding", evidence?: unknown }} spec
 */
export function probe(spec) {
  return { severity: "fail", detail: "", ...spec, kind: "probe" };
}

/**
 * A negative control: an assertion that a deliberately broken environment
 * goes red FOR THE STATED REASON.
 *
 * `satisfied` must be computed by matching the observed failure against
 * `expectation`, not merely by observing that something failed. A control
 * that goes red for an unrelated reason is a false green wearing a disguise:
 * the probe it is supposed to validate has not been exercised at all.
 *
 * @param {{ id: string, title: string, expectation: string, satisfied: boolean, observed: string, detail?: string }} spec
 */
export function control(spec) {
  return { detail: "", ...spec, kind: "control" };
}

/**
 * @typedef {object} Stage
 * @property {string} id
 * @property {string} title
 * @property {(ctx: any) => Promise<{ probes?: any[], controls?: any[], evidence?: any }>} run
 */

/**
 * @param {Stage[]} declared
 * @param {any} ctx
 */
export async function runDeclaredStages(declared, ctx) {
  assertDeclarationWellFormed(declared);
  /** @type {Map<string, any>} */
  const results = new Map();

  for (const stage of declared) {
    const startedAt = Date.now();
    let result;
    try {
      const outcome = (await stage.run(ctx)) ?? {};
      result = {
        id: stage.id,
        title: stage.title,
        probes: outcome.probes ?? [],
        controls: outcome.controls ?? [],
        evidence: outcome.evidence ?? {},
        error: null,
      };
    } catch (error) {
      // A stage that threw did not measure anything, so its own verdict is
      // unknown; that is a rig failure regardless of what the product does.
      result = {
        id: stage.id,
        title: stage.title,
        probes: [],
        controls: [],
        evidence: {},
        error: `${error instanceof RigError ? "rig" : "unexpected"}: ${error?.stack ?? String(error)}`,
      };
    }
    result.durationMs = Date.now() - startedAt;
    result.status = classifyStage(result);
    results.set(stage.id, result);
    ctx.onStageComplete?.(result);
    if (result.status === STATUS.RIG_FAIL && ctx.stopOnRigFailure !== false) {
      // Downstream stages build on this one's evidence. Continuing would
      // produce results whose meaning is unknown, which is worse than a short
      // report, so stop and let the accounting record the rest as not run.
      break;
    }
  }

  const accounting = accountFor(declared, results);
  const stages = declared.map(
    (stage) =>
      results.get(stage.id) ?? {
        id: stage.id,
        title: stage.title,
        status: STATUS.DID_NOT_RUN,
        probes: [],
        controls: [],
        evidence: {},
        durationMs: 0,
        error: "declared but never executed",
      },
  );
  return { stages, accounting, outcome: overallOutcome(stages, accounting) };
}

/** @param {Stage[]} declared */
export function assertDeclarationWellFormed(declared) {
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new RigError("stage declaration is empty; a run over no stages cannot mean anything");
  }
  const seen = new Set();
  for (const stage of declared) {
    if (!stage?.id || typeof stage.run !== "function") {
      throw new RigError(`malformed stage declaration: ${JSON.stringify(stage?.id ?? stage)}`);
    }
    if (seen.has(stage.id)) {
      throw new RigError(`duplicate stage id in declaration: ${stage.id}`);
    }
    seen.add(stage.id);
  }
}

/**
 * N of N, where the first N is the declaration's length and the second is
 * asserted against it rather than derived from it.
 *
 * @param {Stage[]} declared @param {Map<string, any>} results
 */
export function accountFor(declared, results) {
  const declaredIds = declared.map((stage) => stage.id);
  const executedIds = [...results.keys()];
  const missing = declaredIds.filter((id) => !results.has(id));
  const undeclared = executedIds.filter((id) => !declaredIds.includes(id));
  return {
    declared: declaredIds.length,
    executed: executedIds.length,
    declaredIds,
    executedIds,
    missing,
    undeclared,
    ok: missing.length === 0 && undeclared.length === 0,
  };
}

/** @param {{ probes: any[], controls: any[], error: string|null }} result */
export function classifyStage(result) {
  if (result.error) return STATUS.RIG_FAIL;
  // Controls first: if the instruments are not proven, the probe verdicts
  // this stage produced carry no information, so their colour is irrelevant.
  if (result.controls.some((c) => !c.satisfied)) return STATUS.RIG_FAIL;
  if (result.controls.length === 0) return STATUS.RIG_FAIL;
  if (result.probes.some((p) => p.severity === "fail" && !p.ok)) return STATUS.PRODUCT_FAIL;
  return STATUS.PASS;
}

/** @param {any[]} stages @param {ReturnType<typeof accountFor>} accounting */
export function overallOutcome(stages, accounting) {
  if (!accounting.ok) return STATUS.RIG_FAIL;
  if (stages.some((s) => s.status === STATUS.RIG_FAIL || s.status === STATUS.DID_NOT_RUN)) {
    return STATUS.RIG_FAIL;
  }
  if (stages.some((s) => s.status === STATUS.PRODUCT_FAIL)) return STATUS.PRODUCT_FAIL;
  return STATUS.PASS;
}

/** Exit code by outcome. The two failure kinds get different codes on purpose. */
export function exitCodeFor(outcome) {
  if (outcome === STATUS.PASS) return 0;
  if (outcome === STATUS.PRODUCT_FAIL) return 1;
  return 2;
}

/**
 * @param {{ outDir: string, report: any }} spec
 */
export function writeReport({ outDir, report }) {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "report.json");
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const summaryPath = path.join(outDir, "summary.md");
  fs.writeFileSync(summaryPath, renderSummary(report), "utf8");
  return { jsonPath, summaryPath };
}

/** @param {any} report */
export function renderSummary(report) {
  const lines = [];
  lines.push(`# Rig run ${report.startedAt}`);
  lines.push("");
  lines.push(`- outcome: **${report.outcome}**`);
  lines.push(
    `- stages: ${report.accounting.executed} of ${report.accounting.declared} ran` +
      (report.accounting.ok ? "" : `  (ACCOUNTING BROKEN: missing ${report.accounting.missing.join(", ") || "none"}; undeclared ${report.accounting.undeclared.join(", ") || "none"})`),
  );
  lines.push(`- source commit: ${report.source?.sha ?? "unknown"}${report.source?.dirty ? "  (DIRTY TREE, --allow-dirty was given: the archived tree is NOT what the working copy shows)" : ""}`);
  lines.push(`- base image: ${report.base?.ref ?? "unknown"} ${report.base?.digest ?? ""}`);
  lines.push("");
  lines.push("| stage | status | probes | controls | duration |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const stage of report.stages) {
    const failed = stage.probes.filter((p) => p.severity === "fail" && !p.ok).length;
    const findings = stage.probes.filter((p) => p.severity === "finding" && !p.ok).length;
    lines.push(
      `| ${stage.id} | ${stage.status} | ${stage.probes.length - failed}/${stage.probes.length} green${findings ? `, ${findings} finding(s)` : ""} | ${stage.controls.filter((c) => c.satisfied).length}/${stage.controls.length} proven | ${(stage.durationMs / 1000).toFixed(1)}s |`,
    );
  }
  lines.push("");
  for (const stage of report.stages) {
    lines.push(`## ${stage.id} - ${stage.title} (${stage.status})`);
    if (stage.error) {
      lines.push("");
      lines.push("```");
      lines.push(stage.error);
      lines.push("```");
    }
    for (const p of stage.probes) {
      const mark = p.ok ? "PASS" : p.severity === "finding" ? "FINDING" : "FAIL";
      lines.push(`- [${mark}] ${p.title}${p.detail ? `: ${p.detail}` : ""}`);
    }
    for (const c of stage.controls) {
      lines.push(
        `- [${c.satisfied ? "CONTROL PROVEN" : "CONTROL BROKEN"}] ${c.title}\n  - expected: ${c.expectation}\n  - observed: ${oneLine(c.observed)}`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
}
