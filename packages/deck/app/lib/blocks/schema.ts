/**
 * Zod schemas for decision-card validation.
 * These are the read-time validation gates only - NOT the serialization source.
 * Unknown fields (lean, blocking, etc.) are preserved via rawMeta, not via zod passthrough.
 */
import { z } from "zod";

/** Validates a single decision option. */
export const OptionSchema = z.object({
  key: z.string(),
  label: z.string(),
  detail: z.string(),
});

/**
 * Validates the known fields of a decision card.
 * Uses z.object (strict default in zod 4 strips unknown keys, but that's fine
 * because unknown fields are preserved verbatim in rawMeta, not via zod).
 *
 * CARD-05: Use safeParse - never parse() - so malformed cards fall back to plain bubbles.
 */
export const CardSchema = z.object({
  "decision-id": z.string().min(1),
  options: z.array(OptionSchema).min(1),
});

export type CardSchemaInput = z.input<typeof CardSchema>;
export type CardSchemaOutput = z.output<typeof CardSchema>;

/**
 * Validates the known fields of an action card.
 * 'action-id' is required; 'priority' and 'ticket' are optional.
 *
 * CARD-05: Use safeParse - never parse() - so malformed blocks fall back to plain bubbles.
 */
export const ActionSchema = z.object({
  "action-id": z.string().min(1),
  priority: z.string().optional(),
  ticket: z.string().optional(),
});

export type ActionSchemaInput = z.input<typeof ActionSchema>;
export type ActionSchemaOutput = z.output<typeof ActionSchema>;

/**
 * Pinned priority vocabulary (peer review, Atlas TASK-438): left open, agents
 * file 'urgent', 'P1', '1', 'high' and the ranking comparator turns to
 * garbage-in. The schema stays a tolerant string (CARD-05); normalisation
 * happens here at parse time, in the defaults-over-skip spirit: an unknown
 * value WARNS and normalises to "normal" - it never skips the card, because
 * a mistyped priority that vanishes an action from the morning list would be
 * the feature failing at its own job.
 */
export const ACTION_PRIORITIES = ["urgent", "high", "normal"] as const;
export type ActionPriority = (typeof ACTION_PRIORITIES)[number];

export function normalisePriority(
  raw: string | undefined,
  context?: string
): ActionPriority {
  if (raw === undefined || raw.trim() === "") return "normal";
  const lowered = raw.trim().toLowerCase();
  if ((ACTION_PRIORITIES as readonly string[]).includes(lowered)) {
    return lowered as ActionPriority;
  }
  console.warn(
    `[blocks] unknown action priority "${raw}"${context ? ` in ${context}` : ""} - treating as "normal"`
  );
  return "normal";
}
