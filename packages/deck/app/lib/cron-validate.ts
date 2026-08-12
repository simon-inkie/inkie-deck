/**
 * cron-validate.ts - Zod schema + cron expression validation for the cron admin.
 *
 * Runs both client and server side (no .server suffix). The validation logic
 * is pure; no subprocess or fs calls here.
 *
 * Frequency cap: minimum interval is every MIN_INTERVAL_MIN minutes.
 * Expression format: 5-field standard cron (minute hour dom month dow).
 * ASCII only - no em-dashes (FND-05).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum cron interval in minutes. Exposed as a constant so a future
 * one-line change can lower/raise the floor without hunting across the file.
 * Floor is 1 minute (standard cron minimum). Alex gates any change.
 */
export const MIN_INTERVAL_MIN = 1;

// ---------------------------------------------------------------------------
// Message validation
// ---------------------------------------------------------------------------

/**
 * Characters that would break out of the bash double-quoted string inside
 * buildNudgeScript when the message is shell-interpolated. Kept exported so
 * tests that import it by name continue to compile; it is NO LONGER applied
 * to agent messages (delivery is now tmux bracketed-paste, not interpolation).
 *
 * Rejected (legacy): double-quote ("), backtick (`), dollar ($), backslash (\),
 * semicolon (;), pipe (|), ampersand (&), angle brackets (< >),
 * and any control characters (including newline, CR, tab).
 */
export const SHELL_UNSAFE_RE = /["`$\\;|&<>\x00-\x1F]/;

/**
 * Control characters that break tmux buffers.
 * Allows tab (\x09) and newline/LF (\x0A) since markdown content legitimately
 * contains both. Rejects NUL and the remaining C0 control chars (incl. CR).
 */
const TMUX_UNSAFE_CTRL_RE = /[\x00-\x08\x0B-\x1F]/;

/** Maximum agent message length. */
const AGENT_MSG_MAX = 4000;

/**
 * Validate an agent prompt message (ask-1: delivered via bracketed-paste,
 * never shell-interpolated). Only rejects chars that break tmux buffers or
 * excessively long messages.
 */
export function validateCronMessage(
  message: string
): { ok: true } | { ok: false; error: string } {
  if (message.length > AGENT_MSG_MAX) {
    return {
      ok: false,
      error: `Message must be ${AGENT_MSG_MAX} characters or fewer (got ${message.length}).`,
    };
  }
  if (TMUX_UNSAFE_CTRL_RE.test(message)) {
    return {
      ok: false,
      error:
        "Message must not contain NUL bytes or non-printable control characters (tab and newline are fine).",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

export const cronFormSchema = z.object({
  schedule: z.string().min(1, "Schedule is required."),
  target: z.string().min(1, "Target agent is required."),
  message: z
    .string()
    .min(1, "Message is required.")
    .max(AGENT_MSG_MAX, `Message must be ${AGENT_MSG_MAX} characters or fewer.`)
    .refine(
      (v) => !TMUX_UNSAFE_CTRL_RE.test(v),
      "Message must not contain NUL bytes or non-printable control characters (tab and newline are fine)."
    ),
  enabled: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((v) => v === true || v === "true")
    .default(true),
  targetType: z.enum(["agent", "script"]).default("agent"),
});

export type CronFormValues = z.infer<typeof cronFormSchema>;

// ---------------------------------------------------------------------------
// Schedule presets
// ---------------------------------------------------------------------------

export const SCHEDULE_PRESETS: Array<{
  label: string;
  value: string;
  cron: string;
}> = [
  { label: "Daily at 07:30", value: "daily-0730", cron: "30 7 * * *" },
  { label: "Daily at 09:00", value: "daily-0900", cron: "0 9 * * *" },
  { label: "Weekdays at 09:00", value: "weekdays-0900", cron: "0 9 * * 1-5" },
  { label: "Every minute", value: "every-1min", cron: "* * * * *" },
  { label: "Every 5 minutes", value: "every-5min", cron: "*/5 * * * *" },
  { label: "Every 10 minutes", value: "every-10min", cron: "*/10 * * * *" },
  { label: "Every 30 minutes", value: "every-30min", cron: "*/30 * * * *" },
  { label: "Hourly", value: "hourly", cron: "0 * * * *" },
  { label: "Custom", value: "custom", cron: "" },
];

// ---------------------------------------------------------------------------
// Cron expression validation
// ---------------------------------------------------------------------------

type CronValidResult =
  | { ok: true; expression: string }
  | { ok: false; error: string };

/**
 * Field value ranges for a standard 5-field cron expression:
 * minute (0-59), hour (0-23), dom (1-31), month (1-12), dow (0-7)
 */
const FIELD_META = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

/** Validate one cron field token against its allowed range. */
function validateField(token: string, meta: (typeof FIELD_META)[number]): boolean {
  const { min, max } = meta;

  // Wildcard
  if (token === "*") return true;

  // Step: */n or <value>/n
  if (token.includes("/")) {
    const [base, step] = token.split("/");
    if (!step || !/^\d+$/.test(step)) return false;
    const stepN = parseInt(step, 10);
    if (stepN < 1 || stepN > max - min) return false;
    if (base === "*") return true;
    if (!/^\d+$/.test(base!)) return false;
    const baseN = parseInt(base!, 10);
    return baseN >= min && baseN <= max;
  }

  // Range: a-b
  if (token.includes("-")) {
    const [lo, hi] = token.split("-");
    if (!/^\d+$/.test(lo!) || !/^\d+$/.test(hi!)) return false;
    const loN = parseInt(lo!, 10);
    const hiN = parseInt(hi!, 10);
    return loN >= min && hiN <= max && loN <= hiN;
  }

  // List: a,b,c
  if (token.includes(",")) {
    return token
      .split(",")
      .every((part) => validateField(part.trim(), meta));
  }

  // Single value
  if (!/^\d+$/.test(token)) return false;
  const n = parseInt(token, 10);
  return n >= min && n <= max;
}

/**
 * Compute the minimum interval in minutes for the minute field token.
 * Used to enforce the MIN_INTERVAL_MIN frequency cap.
 * Returns the minimum gap in minutes between any two fires of that expression.
 */
function minuteFieldMinInterval(minuteToken: string): number {
  // Wildcard = every minute = interval 1
  if (minuteToken === "*") return 1;

  // Step: */n
  if (minuteToken.startsWith("*/")) {
    const n = parseInt(minuteToken.slice(2), 10);
    if (isNaN(n) || n < 1) return 1;
    return n; // interval is n minutes
  }

  // Single value (e.g. "30") fires once per hour = interval 60
  if (/^\d+$/.test(minuteToken)) return 60;

  // Range (e.g. "0-10") fires 11 times per hour = interval ~5.5 ... allow
  // For ranges, the minimum interval between fires is 1 minute.
  if (minuteToken.includes("-")) return 1;

  // List (e.g. "0,30") - minimum gap between items, including the wrap-around gap.
  // e.g. "0,59" fires at :00 and :59 each hour; the gap from :59 to :00 of the
  // NEXT hour is 1 minute, not 59. Without the wrap check that would pass the floor.
  if (minuteToken.includes(",")) {
    const vals = minuteToken
      .split(",")
      .map((v) => parseInt(v.trim(), 10))
      .filter((v) => !isNaN(v))
      .sort((a, b) => a - b);
    if (vals.length < 2) return 60;
    let minGap = 60;
    for (let i = 1; i < vals.length; i++) {
      const gap = vals[i]! - vals[i - 1]!;
      if (gap < minGap) minGap = gap;
    }
    // Wrap-around gap: from the last value to the first value of the next hour.
    const wrapGap = 60 - vals[vals.length - 1]! + vals[0]!;
    if (wrapGap < minGap) minGap = wrapGap;
    return minGap;
  }

  // With step on a value: "0/5"
  if (minuteToken.includes("/")) {
    const step = parseInt(minuteToken.split("/")[1]!, 10);
    if (!isNaN(step) && step >= 1) return step;
  }

  return 1; // conservative default
}

/**
 * Validate a 5-field cron expression.
 * - Rejects malformed expressions (not 5 fields, invalid field values).
 * - Rejects expressions that fire more frequently than every MIN_INTERVAL_MIN minutes.
 * - Returns the normalised expression on success.
 */
export function validateCronExpression(expr: string): CronValidResult {
  const trimmed = expr.trim();
  if (!trimmed) {
    return { ok: false, error: "Cron expression is required." };
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return {
      ok: false,
      error: `Cron expression must have exactly 5 fields (minute hour dom month dow); got ${fields.length}.`,
    };
  }

  for (let i = 0; i < 5; i++) {
    const field = fields[i]!;
    const meta = FIELD_META[i]!;
    if (!validateField(field, meta)) {
      return {
        ok: false,
        error: `Invalid ${meta.name} field: "${field}".`,
      };
    }
  }

  // Frequency cap: minute field must be >= MIN_INTERVAL_MIN minute interval.
  const minuteToken = fields[0]!;
  const minInterval = minuteFieldMinInterval(minuteToken);
  if (minInterval < MIN_INTERVAL_MIN) {
    return {
      ok: false,
      error: `Cron expression fires too frequently (minimum interval is every ${MIN_INTERVAL_MIN} minutes). Got: "${trimmed}".`,
    };
  }

  return { ok: true, expression: fields.join(" ") };
}

// ---------------------------------------------------------------------------
// Human-readable schedule
// ---------------------------------------------------------------------------

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Convert a 5-field cron expression to a plain-English string.
 *
 * Covered patterns (in match order):
 *   * / N  *  *  *  *  -> "Every N minutes" (N=1 -> "Every minute")
 *   0  *  *  *  *      -> "Hourly"
 *   0  * / N  *  *  *  -> "Every N hours"
 *   M  H  *  *  *      -> "Daily at HH:MM"
 *   M  H  *  *  D      -> "Weekly on <Day> at HH:MM" (D numeric 0-6)
 *
 * Fallback: returns the raw expression unchanged. Never throws.
 */
export function humanizeSchedule(expr: string): string {
  const trimmed = expr.trim();
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return trimmed;

  const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];

  // Every minute: * * * * *
  if (min === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return "Every minute";
  }

  // Every-N-minutes: */N * * * *
  if (min.startsWith("*/") && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    const n = parseInt(min.slice(2), 10);
    if (!isNaN(n)) {
      return n === 1 ? "Every minute" : `Every ${n} minutes`;
    }
  }

  // Hourly: 0 * * * *
  if (min === "0" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return "Hourly";
  }

  // Every-N-hours: 0 */N * * *
  if (min === "0" && hour.startsWith("*/") && dom === "*" && month === "*" && dow === "*") {
    const n = parseInt(hour.slice(2), 10);
    if (!isNaN(n)) {
      return `Every ${n} hours`;
    }
  }

  // Weekly: M H * * D  (D is single numeric 0-6)
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && month === "*" && /^\d+$/.test(dow)) {
    const dowN = parseInt(dow, 10);
    if (dowN >= 0 && dowN <= 6) {
      const dayName = DOW_NAMES[dowN % 7];
      const hh = hour.padStart(2, "0");
      const mm = min.padStart(2, "0");
      return `Weekly on ${dayName} at ${hh}:${mm}`;
    }
  }

  // Daily: M H * * *  (both numeric)
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && month === "*" && dow === "*") {
    const hh = hour.padStart(2, "0");
    const mm = min.padStart(2, "0");
    return `Daily at ${hh}:${mm}`;
  }

  // Fallback: return raw expression unchanged
  return trimmed;
}

// ---------------------------------------------------------------------------
// Target validation
// ---------------------------------------------------------------------------

type TargetValidResult = { ok: true } | { ok: false; error: string };

/**
 * Confirm the target is a known agent name.
 */
export function validateCronTarget(
  target: string,
  knownAgents: string[]
): TargetValidResult {
  const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
  if (!AGENT_NAME_RE.test(target)) {
    return { ok: false, error: `Invalid target name: "${target}".` };
  }
  if (!knownAgents.includes(target)) {
    return {
      ok: false,
      error: `Unknown agent: "${target}". Known agents: ${knownAgents.join(", ")}.`,
    };
  }
  return { ok: true };
}
