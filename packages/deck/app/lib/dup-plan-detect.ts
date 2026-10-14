/**
 * dup-plan-detect.ts - Pure predicate: detect clients with 2+ overlapping scheduled plans.
 *
 * No IO, no fs, no side effects. All date arithmetic uses explicit UTC.
 * Importable in any Vitest node-env test without mocking.
 *
 * Mirrors the queue-derive.ts pure-core pattern: called from loaders or CLI scripts;
 * never touches the filesystem directly.
 *
 * Satisfies the duplicate-plan detector requirements:
 *   D-01 Self-contained schema (no external Inkie schema imports)
 *   D-02 Normalise to date intervals, not month/year
 *   D-03 Inclusive-boundary overlap, non-scheduled excluded, no self-overlap
 *   D-04 Pure predicate, IO at the edge
 *
 * Pitfall avoided: NEVER use date-fns startOfMonth/endOfMonth for month boundaries.
 * Those helpers use local time and produce wrong UTC boundaries on BST machines
 * (e.g. the end of May lands at 22:59:59.999Z on the 31st instead of
 * 23:59:59.999Z). Use Date.UTC() arithmetic exclusively.
 *
 * ASCII only - no em-dashes (check:dashes gate).
 */
import { areIntervalsOverlapping } from "date-fns";

// ---------------------------------------------------------------------------
// Schema types (D-01: self-contained, no external Inkie schema)
// ---------------------------------------------------------------------------

export type PlanStatus = "scheduled" | "draft" | "archived" | "completed";
export type PlanType = "month" | "date-range";

/** A single scheduled item within a content plan. */
export interface ScheduledItem {
  /** ISO date string for the item's scheduled date. */
  date: string;
}

/** Minimal self-contained content plan model for the dup-plan detector. */
export interface ContentPlan {
  /** Stable identifier for this plan. Used for self-overlap guard. */
  content_plan_id: string;
  /** The client this plan belongs to. */
  client_id: string;
  /** Only "scheduled" plans participate in the overlap check. */
  status: PlanStatus;
  /** Discriminates between month-keyed and date-range plans. */
  type: PlanType;
  /** Present when type === "month". 1-indexed (1=January, 6=June). */
  month?: number;
  /** Present when type === "month". Full year (e.g. 2026). */
  year?: number;
  /** Present when type === "date-range". ISO date string (yyyy-MM-dd). */
  start?: string;
  /** Present when type === "date-range". ISO date string (yyyy-MM-dd). */
  end?: string;
  /** The scheduled items within this plan. */
  items: ScheduledItem[];
}

/** Absolute UTC date interval used for overlap comparison. */
export interface DateInterval {
  start: Date;
  end: Date;
}

/** Result for one overlapping pair of plans for a client. */
export interface OverlapResult {
  client_id: string;
  plan_id_a: string;
  plan_id_b: string;
  /** Short description of the overlapping dates for reporting. */
  overlap_description: string;
}

// ---------------------------------------------------------------------------
// Private: normalise a plan to its absolute UTC date intervals
// ---------------------------------------------------------------------------

/**
 * Normalise a ContentPlan to a list of absolute UTC day intervals.
 *
 * For BOTH month-type and date-range-type plans, returns item-level intervals
 * as the primary source (day start 00:00:00Z to day end 23:59:59.999Z). This
 * is the key to catching overlaps: a May plan whose items spill into June will produce
 * intervals that intersect a June plan's item intervals.
 *
 * Fallback (empty items): uses plan-level bounds.
 *   month-type: Date.UTC bounds only (never startOfMonth/endOfMonth).
 *   date-range: plan.start to plan.end day bounds.
 *
 * Returns an empty array if the plan has no items and no valid plan-level bounds.
 */
function normalisePlanToIntervals(plan: ContentPlan): DateInterval[] {
  // Primary: item-level intervals capture any cross-month spill (D-02).
  // Use start-of-day to start-of-NEXT-day so that adjacent calendar days share
  // a boundary millisecond. This makes inclusive:true correctly flag a May plan
  // item on June-01 as overlapping with a June plan item on June-02, because their intervals share the midnight
  // point between the two days.
  if (plan.items.length > 0) {
    return plan.items.map((item) => {
      const start = new Date(item.date + "T00:00:00Z");
      const end = new Date(Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth(),
        start.getUTCDate() + 1
      ));
      return { start, end };
    });
  }

  // Fallback: plan-level bounds when there are no items.
  if (plan.type === "month" && plan.month !== undefined && plan.year !== undefined) {
    // IMPORTANT: use Date.UTC arithmetic only.
    // date-fns month helpers operate on local calendar time and produce wrong
    // UTC values on BST (UTC+1) machines.
    const start = new Date(Date.UTC(plan.year, plan.month - 1, 1));
    // End: first instant of the following month (exclusive boundary for month-level fallback).
    const end = new Date(Date.UTC(plan.year, plan.month, 1));
    return [{ start, end }];
  }

  if (plan.type === "date-range" && plan.start !== undefined && plan.end !== undefined) {
    const endDate = new Date(plan.end + "T00:00:00Z");
    const endPlusOne = new Date(Date.UTC(
      endDate.getUTCFullYear(),
      endDate.getUTCMonth(),
      endDate.getUTCDate() + 1
    ));
    return [
      {
        start: new Date(plan.start + "T00:00:00Z"),
        end: endPlusOne,
      },
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Exported predicate
// ---------------------------------------------------------------------------

/**
 * Detect clients with 2+ active scheduled plans whose item-date intervals
 * overlap across distinct content_plan_id.
 *
 * Pure function: no IO, no fs, no Date.now(), no side effects.
 * All inputs are passed in; the caller (CLI or loader) owns fixture loading.
 * Mirrors the queue-derive.ts pure-core pattern.
 *
 * Rules applied (per D-03):
 * 1. Filter to status === "scheduled" only.
 * 2. Group by client_id.
 * 3. For each client, check every pair with distinct content_plan_id.
 * 4. Normalise each plan to item-date intervals (falls back to plan-level bounds).
 * 5. Use areIntervalsOverlapping with { inclusive: true } per D-03.
 * 6. Report at most one OverlapResult per pair (break on first found overlap).
 *
 * @returns One OverlapResult per overlapping pair per client.
 */
export function detectDupPlans(plans: ContentPlan[]): OverlapResult[] {
  // Step 1: filter to scheduled plans (D-03).
  const scheduled = plans.filter((p) => p.status === "scheduled");

  // Step 2: group by client_id.
  const byClient = new Map<string, ContentPlan[]>();
  for (const plan of scheduled) {
    const list = byClient.get(plan.client_id) ?? [];
    list.push(plan);
    byClient.set(plan.client_id, list);
  }

  const results: OverlapResult[] = [];

  // Step 3: check all pairs of distinct plans per client.
  for (const [client_id, clientPlans] of byClient) {
    for (let i = 0; i < clientPlans.length; i++) {
      for (let j = i + 1; j < clientPlans.length; j++) {
        const a = clientPlans[i]!;
        const b = clientPlans[j]!;

        // D-03: same content_plan_id is never a self-overlap.
        if (a.content_plan_id === b.content_plan_id) continue;

        const intervalsA = normalisePlanToIntervals(a);
        const intervalsB = normalisePlanToIntervals(b);

        // Step 4+5: check all interval combinations for this pair.
        let foundOverlap = false;
        let overlapDesc = "";
        outer: for (const ia of intervalsA) {
          for (const ib of intervalsB) {
            if (areIntervalsOverlapping(ia, ib, { inclusive: true })) {
              foundOverlap = true;
              overlapDesc = `${ia.start.toISOString().slice(0, 10)} / ${ib.start.toISOString().slice(0, 10)}`;
              break outer;
            }
          }
        }

        // Step 6: report at most one result per pair.
        if (foundOverlap) {
          results.push({
            client_id,
            plan_id_a: a.content_plan_id,
            plan_id_b: b.content_plan_id,
            overlap_description: overlapDesc,
          });
        }
      }
    }
  }

  return results;
}
