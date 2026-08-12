/**
 * test/cron-validate.test.ts - Unit tests for app/lib/cron-validate.ts (TASK-460).
 *
 * Covers:
 *   - Malformed expression rejection (wrong field count, non-numeric fields).
 *   - Frequency cap (< MIN_INTERVAL_MIN rejected; >= MIN_INTERVAL_MIN accepted).
 *   - Unknown target rejection.
 *   - Message validation: markdown chars now ACCEPTED; only NUL/disruptive
 *     control chars rejected (ask-1 bracketed-paste delivery).
 *   - Every-N-min presets (ask-2).
 *   - targetType field in cronFormSchema (ask-3).
 *
 * ASCII only - no em-dashes (FND-05).
 */

import { describe, it, expect } from "vitest";
import {
  validateCronExpression,
  validateCronTarget,
  validateCronMessage,
  SCHEDULE_PRESETS,
  MIN_INTERVAL_MIN,
  cronFormSchema,
  humanizeSchedule,
} from "~/lib/cron-validate";

// ---------------------------------------------------------------------------
// humanizeSchedule
// ---------------------------------------------------------------------------

describe("humanizeSchedule", () => {
  it("* * * * * -> Every minute", () => {
    expect(humanizeSchedule("* * * * *")).toBe("Every minute");
  });

  it("*/5 * * * * -> Every 5 minutes", () => {
    expect(humanizeSchedule("*/5 * * * *")).toBe("Every 5 minutes");
  });

  it("*/30 * * * * -> Every 30 minutes", () => {
    expect(humanizeSchedule("*/30 * * * *")).toBe("Every 30 minutes");
  });

  it("*/1 * * * * -> Every minute", () => {
    expect(humanizeSchedule("*/1 * * * *")).toBe("Every minute");
  });

  it("0 * * * * -> Hourly", () => {
    expect(humanizeSchedule("0 * * * *")).toBe("Hourly");
  });

  it("0 */2 * * * -> Every 2 hours", () => {
    expect(humanizeSchedule("0 */2 * * *")).toBe("Every 2 hours");
  });

  it("30 7 * * * -> Daily at 07:30", () => {
    expect(humanizeSchedule("30 7 * * *")).toBe("Daily at 07:30");
  });

  it("0 9 * * 1 -> Weekly on Mon at 09:00", () => {
    expect(humanizeSchedule("0 9 * * 1")).toBe("Weekly on Mon at 09:00");
  });

  it("0 0 * * 0 -> Weekly on Sun at 00:00", () => {
    expect(humanizeSchedule("0 0 * * 0")).toBe("Weekly on Sun at 00:00");
  });

  it("exotic cron returns raw expression unchanged", () => {
    const expr = "0 9 * * 1-5";
    expect(humanizeSchedule(expr)).toBe(expr);
  });
});

// ---------------------------------------------------------------------------
// validateCronExpression
// ---------------------------------------------------------------------------

describe("validateCronExpression - malformed rejections", () => {
  it("rejects an empty string", () => {
    const result = validateCronExpression("");
    expect(result.ok).toBe(false);
  });

  it("rejects a plain word", () => {
    const result = validateCronExpression("bad");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("5 fields");
    }
  });

  it("rejects 4-field expressions", () => {
    const result = validateCronExpression("* * * *");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("5 fields");
    }
  });

  it("rejects 6-field expressions", () => {
    const result = validateCronExpression("0 0 * * * *");
    expect(result.ok).toBe(false);
  });

  it("rejects non-numeric minute field", () => {
    const result = validateCronExpression("abc * * * *");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain("minute");
    }
  });

  it("rejects out-of-range minute (60)", () => {
    const result = validateCronExpression("60 * * * *");
    expect(result.ok).toBe(false);
  });

  it("rejects out-of-range hour (24)", () => {
    const result = validateCronExpression("0 24 * * *");
    expect(result.ok).toBe(false);
  });

  it("rejects invalid step (*/0)", () => {
    const result = validateCronExpression("*/0 * * * *");
    expect(result.ok).toBe(false);
  });
});

describe("validateCronExpression - frequency cap (min MIN_INTERVAL_MIN min interval)", () => {
  // With floor=1 (the cron minimum), every expression that is structurally valid
  // is at or above the floor. Wildcard and */1 both fire every minute = 1 min
  // interval = exactly at the floor, so they pass.

  it("accepts every-minute: * * * * * (at the 1-min floor)", () => {
    const result = validateCronExpression("* * * * *");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expression).toBe("* * * * *");
    }
  });

  it("accepts */1 * * * * (at the 1-min floor)", () => {
    const result = validateCronExpression("*/1 * * * *");
    expect(result.ok).toBe(true);
  });

  it("accepts */2 * * * * (above floor)", () => {
    const result = validateCronExpression("*/2 * * * *");
    expect(result.ok).toBe(true);
  });

  it("accepts */3 * * * * (above floor)", () => {
    const result = validateCronExpression("*/3 * * * *");
    expect(result.ok).toBe(true);
  });

  it("accepts */4 * * * * (above floor)", () => {
    const result = validateCronExpression("*/4 * * * *");
    expect(result.ok).toBe(true);
  });

  it("accepts */5 * * * * (every 5 min)", () => {
    const result = validateCronExpression("*/5 * * * *");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expression).toBe("*/5 * * * *");
    }
  });

  it("accepts */30 * * * *", () => {
    const result = validateCronExpression("*/30 * * * *");
    expect(result.ok).toBe(true);
  });

  it("accepts 0 * * * * (hourly)", () => {
    const result = validateCronExpression("0 * * * *");
    expect(result.ok).toBe(true);
  });

  it("accepts 30 7 * * * (daily at 07:30)", () => {
    const result = validateCronExpression("30 7 * * *");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expression).toBe("30 7 * * *");
    }
  });

  it("accepts 0 9 * * 1-5 (weekdays at 09:00)", () => {
    const result = validateCronExpression("0 9 * * 1-5");
    expect(result.ok).toBe(true);
  });

  // With floor=1, wrap-around gap of 1 minute is exactly at the floor, so these now pass.
  it("accepts 0,59 * * * * (wrap-around gap is 1 min - at the floor)", () => {
    const result = validateCronExpression("0,59 * * * *");
    expect(result.ok).toBe(true);
  });

  it("accepts 0,3,59 * * * * (wrap-around gap 59->0 is 1 min - at the floor)", () => {
    const result = validateCronExpression("0,3,59 * * * *");
    expect(result.ok).toBe(true);
  });

  it("accepts 0,30 * * * * (gap 30 min in-hour, wrap gap 30 min)", () => {
    const result = validateCronExpression("0,30 * * * *");
    expect(result.ok).toBe(true);
  });

  it("accepts 0,10,20,30,40,50 * * * * (all gaps 10 min incl. wrap)", () => {
    const result = validateCronExpression("0,10,20,30,40,50 * * * *");
    expect(result.ok).toBe(true);
  });
});

describe("validateCronExpression - valid expressions accepted", () => {
  it("accepts all built-in presets", () => {
    for (const preset of SCHEDULE_PRESETS) {
      if (!preset.cron) continue; // "custom" preset has no cron string
      const result = validateCronExpression(preset.cron);
      expect(result.ok, `Preset "${preset.label}" (${preset.cron}) should be valid`).toBe(true);
    }
  });

  it("normalises whitespace in the returned expression", () => {
    const result = validateCronExpression("  30   7   *   *   *  ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expression).toBe("30 7 * * *");
    }
  });
});

// ---------------------------------------------------------------------------
// Every-N-min presets (ask-2)
// ---------------------------------------------------------------------------

describe("every-N-min presets", () => {
  it("MIN_INTERVAL_MIN constant is 1", () => {
    expect(MIN_INTERVAL_MIN).toBe(1);
  });

  it("every-1min preset exists in SCHEDULE_PRESETS", () => {
    const preset = SCHEDULE_PRESETS.find((p) => p.value === "every-1min");
    expect(preset).toBeDefined();
    expect(preset!.cron).toBe("* * * * *");
  });

  it("every-5min preset exists in SCHEDULE_PRESETS", () => {
    const preset = SCHEDULE_PRESETS.find((p) => p.value === "every-5min");
    expect(preset).toBeDefined();
    expect(preset!.cron).toBe("*/5 * * * *");
  });

  it("every-10min preset exists in SCHEDULE_PRESETS", () => {
    const preset = SCHEDULE_PRESETS.find((p) => p.value === "every-10min");
    expect(preset).toBeDefined();
    expect(preset!.cron).toBe("*/10 * * * *");
  });

  it("every-1min preset validates successfully", () => {
    const result = validateCronExpression("* * * * *");
    expect(result.ok).toBe(true);
  });

  it("every-5min preset validates successfully", () => {
    const result = validateCronExpression("*/5 * * * *");
    expect(result.ok).toBe(true);
  });

  it("every-10min preset validates successfully", () => {
    const result = validateCronExpression("*/10 * * * *");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateCronTarget
// ---------------------------------------------------------------------------

describe("validateCronTarget", () => {
  const knownAgents = ["quill", "sprout", "fern", "atlas", "briar"];

  it("accepts a known agent name", () => {
    expect(validateCronTarget("sprout", knownAgents).ok).toBe(true);
    expect(validateCronTarget("quill", knownAgents).ok).toBe(true);
  });

  it("rejects an unknown agent name", () => {
    const result = validateCronTarget("unknown-bot", knownAgents);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unknown agent");
    }
  });

  it("rejects names that fail the ROSTER regex", () => {
    // Upper case, spaces, special chars
    for (const bad of ["IO", "quill bot", "quill;ls", "../etc", "-quill", ""]) {
      const result = validateCronTarget(bad, knownAgents);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("accepts hyphenated roster names", () => {
    expect(validateCronTarget("fern", ["fern"]).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateCronMessage - ask-1: bracketed-paste delivery, markdown ACCEPTED
// ---------------------------------------------------------------------------

describe("validateCronMessage - markdown chars now ACCEPTED (bracketed-paste)", () => {
  it("accepts a message containing a double-quote", () => {
    const result = validateCronMessage('say "hello"');
    expect(result.ok).toBe(true);
  });

  it("accepts a message containing a backtick", () => {
    const result = validateCronMessage("run `date`");
    expect(result.ok).toBe(true);
  });

  it("accepts a message containing a dollar sign", () => {
    const result = validateCronMessage("value is $HOME");
    expect(result.ok).toBe(true);
  });

  it("accepts a message containing a backslash", () => {
    const result = validateCronMessage("C:\\Users\\alex");
    expect(result.ok).toBe(true);
  });

  it("accepts a message containing a newline (markdown content)", () => {
    const result = validateCronMessage("line1\nline2");
    expect(result.ok).toBe(true);
  });

  it("accepts a message containing a tab character (markdown table)", () => {
    const result = validateCronMessage("col1\tcol2");
    expect(result.ok).toBe(true);
  });

  it("accepts semicolon (no longer a shell injection risk)", () => {
    expect(validateCronMessage("foo; rm -rf /").ok).toBe(true);
  });

  it("accepts pipe", () => {
    expect(validateCronMessage("foo | cat /etc/passwd").ok).toBe(true);
  });

  it("accepts ampersand", () => {
    expect(validateCronMessage("foo & background").ok).toBe(true);
  });

  it("accepts less-than", () => {
    expect(validateCronMessage("foo < /dev/urandom").ok).toBe(true);
  });

  it("accepts greater-than", () => {
    expect(validateCronMessage("foo > /tmp/out").ok).toBe(true);
  });

  it("accepts a markdown message with backticks, dollars, newlines (combo)", () => {
    const msg = "## Morning check-in\n\nRun `pnpm build` and check `$HOME/agents`.\n\n- item 1\n- item 2";
    const result = validateCronMessage(msg);
    expect(result.ok).toBe(true);
  });

  it("accepts a plain alphanumeric message", () => {
    const result = validateCronMessage("morning check-in: ready?");
    expect(result.ok).toBe(true);
  });

  it("accepts punctuation that is safe (!, ?, :, -, ,, .)", () => {
    const result = validateCronMessage("wake up, quill! time to work: 07:30. are you ready?");
    expect(result.ok).toBe(true);
  });

  it("accepts single quotes", () => {
    const result = validateCronMessage("it's time for your morning check-in");
    expect(result.ok).toBe(true);
  });

  it("accepts a typical cron nudge message with comma and colon", () => {
    const result = validateCronMessage("07:33 check-in, generate dashboard");
    expect(result.ok).toBe(true);
  });
});

describe("validateCronMessage - control chars that break tmux buffers REJECTED", () => {
  it("rejects a message containing a carriage return (\\r)", () => {
    const result = validateCronMessage("line1\rline2");
    expect(result.ok).toBe(false);
  });

  it("rejects a message containing a NUL byte (\\x00)", () => {
    const result = validateCronMessage("has\x00null");
    expect(result.ok).toBe(false);
  });

  it("rejects a message containing BEL control char (\\x07)", () => {
    const result = validateCronMessage("bell\x07here");
    expect(result.ok).toBe(false);
  });

  it("rejects a message containing VT (\\x0B)", () => {
    const result = validateCronMessage("vert\x0Btab");
    expect(result.ok).toBe(false);
  });

  it("rejects a message containing FF (\\x0C)", () => {
    const result = validateCronMessage("form\x0Cfeed");
    expect(result.ok).toBe(false);
  });
});

describe("validateCronMessage - length cap", () => {
  it("accepts a message at exactly 4000 chars", () => {
    const msg = "a".repeat(4000);
    const result = validateCronMessage(msg);
    expect(result.ok).toBe(true);
  });

  it("rejects a message exceeding 4000 chars", () => {
    const msg = "a".repeat(4001);
    const result = validateCronMessage(msg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("4000");
    }
  });
});

// ---------------------------------------------------------------------------
// cronFormSchema - targetType field (ask-3)
// ---------------------------------------------------------------------------

describe("cronFormSchema - targetType field", () => {
  const base = {
    schedule: "30 7 * * *",
    target: "sprout",
    message: "hello",
    enabled: true,
  };

  it("accepts targetType=agent", () => {
    const result = cronFormSchema.safeParse({ ...base, targetType: "agent" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.targetType).toBe("agent");
  });

  it("accepts targetType=script", () => {
    const result = cronFormSchema.safeParse({ ...base, targetType: "script" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.targetType).toBe("script");
  });

  it("defaults targetType to agent when omitted", () => {
    const result = cronFormSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.targetType).toBe("agent");
  });

  it("rejects an invalid targetType value", () => {
    const result = cronFormSchema.safeParse({ ...base, targetType: "tmux" });
    expect(result.success).toBe(false);
  });

  it("accepts markdown message with backticks, dollars, newlines in schema", () => {
    const result = cronFormSchema.safeParse({
      ...base,
      message: "## Header\n\nRun `pnpm build` and check `$HOME`.",
    });
    expect(result.success).toBe(true);
  });
});
