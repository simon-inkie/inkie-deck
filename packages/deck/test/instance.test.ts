/**
 * Tests for instance.server.ts and the user-parameterised lib seams it
 * drives.
 *
 * The contract under test: an instance with NO env behaves exactly as the
 * default single-user instance (defaults), and an MC_USER=sam instance keys
 * every own-message check + reply identity on "sam".
 *
 * ASCII only - no em-dashes.
 */
import { describe, it, expect } from "vitest";
import { mcUser, tmuxEnabled, cronAdminEnabled, instanceLabel, projectsAgents, filterCardsForInstance } from "~/lib/instance.server";
import { deriveNeedsYou, deriveQueueItems } from "~/lib/queue-derive";
import type { InboxEntry } from "~/lib/queue-derive";
import { isSuperseded } from "~/lib/blocks/working";
import { applyAnswer } from "~/lib/blocks/answer";
import type { MessageBlock } from "~/lib/blocks/model";

const FIXED_NOW = new Date("2026-06-11T12:00:00Z");

function block(from: string, ts = "2026-06-11T10:00:00Z"): MessageBlock {
  return {
    header: { timestamp: ts, from, status: "sent", subject: "s" },
    body: "b",
    card: undefined,
    rawMeta: "",
  };
}

function cardBlock(from: string, decisionId: string): MessageBlock {
  return {
    header: { timestamp: "2026-06-11T10:00:00Z", from, status: "sent", subject: "s" },
    body: "b",
    card: {
      decisionId,
      options: [
        { key: "A", label: "A", detail: "" },
        { key: "B", label: "B", detail: "" },
      ],
      answered: undefined,
      customAnswer: undefined,
    },
    rawMeta: `decision-id: ${decisionId}`,
  };
}

describe("mcUser", () => {
  it("defaults to alex when unset/empty", () => {
    expect(mcUser({})).toBe("alex");
    expect(mcUser({ MC_USER: "" })).toBe("alex");
    expect(mcUser({ MC_USER: "   " })).toBe("alex");
  });
  it("returns the configured user", () => {
    expect(mcUser({ MC_USER: "sam" })).toBe("sam");
  });
});

describe("tmuxEnabled", () => {
  it("defaults to enabled", () => {
    expect(tmuxEnabled({})).toBe(true);
    expect(tmuxEnabled({ MC_TMUX_ENABLED: "1" })).toBe(true);
  });
  it("disables on 0 / false (any case)", () => {
    expect(tmuxEnabled({ MC_TMUX_ENABLED: "0" })).toBe(false);
    expect(tmuxEnabled({ MC_TMUX_ENABLED: "false" })).toBe(false);
    expect(tmuxEnabled({ MC_TMUX_ENABLED: "FALSE" })).toBe(false);
  });
});

describe("cronAdminEnabled", () => {
  // The gate on /scheduler, which writes the system crontab. Two ways in
  // (trusted principal by default, explicit kill switch on top), and the
  // interesting property is that the switch beats the default in the closing
  // direction only: it can shut a principal out, it cannot let anyone in.
  it("is open for the default user (MC_USER unset means alex)", () => {
    expect(cronAdminEnabled({})).toBe(true);
    expect(cronAdminEnabled({ MC_USER: "" })).toBe(true);
  });

  it("is open for both trusted principals", () => {
    expect(cronAdminEnabled({ MC_USER: "alex" })).toBe(true);
    expect(cronAdminEnabled({ MC_USER: "robin" })).toBe(true);
  });

  it("is closed for anyone else", () => {
    expect(cronAdminEnabled({ MC_USER: "quill" })).toBe(false);
    expect(cronAdminEnabled({ MC_USER: "sprout" })).toBe(false);
  });

  it("is closed on an explicit 0 / false (any case), even for a principal", () => {
    expect(cronAdminEnabled({ MC_CRON_ADMIN_ENABLED: "0" })).toBe(false);
    expect(cronAdminEnabled({ MC_CRON_ADMIN_ENABLED: "false" })).toBe(false);
    expect(cronAdminEnabled({ MC_CRON_ADMIN_ENABLED: "FALSE" })).toBe(false);
    expect(cronAdminEnabled({ MC_USER: "robin", MC_CRON_ADMIN_ENABLED: "0" })).toBe(false);
  });

  it("tolerates whitespace around the kill switch", () => {
    expect(cronAdminEnabled({ MC_CRON_ADMIN_ENABLED: "  false  " })).toBe(false);
  });

  it("does not OPEN the gate for a non-principal who sets the switch on", () => {
    // The switch is an off-only control. "1" is not a grant, so a user who is
    // not a principal stays out however they spell it.
    expect(cronAdminEnabled({ MC_USER: "quill", MC_CRON_ADMIN_ENABLED: "1" })).toBe(false);
    expect(cronAdminEnabled({ MC_USER: "quill", MC_CRON_ADMIN_ENABLED: "true" })).toBe(false);
  });

  it("falls through to the user check on an empty or unrecognised switch", () => {
    expect(cronAdminEnabled({ MC_CRON_ADMIN_ENABLED: "" })).toBe(true);
    expect(cronAdminEnabled({ MC_CRON_ADMIN_ENABLED: "yes" })).toBe(true);
    expect(cronAdminEnabled({ MC_USER: "quill", MC_CRON_ADMIN_ENABLED: "" })).toBe(false);
  });
});

describe("user-parameterised seams (MC_USER=sam semantics)", () => {
  it("deriveNeedsYou excludes the instance user's own cards, not alex's", () => {
    const entries: InboxEntry[] = [
      { agentName: "sprout", block: cardBlock("sam", "her-own") },
      { agentName: "sprout", block: cardBlock("sprout", "from-agent") },
      { agentName: "sprout", block: cardBlock("alex", "from-alex") },
    ];
    const { items } = deriveNeedsYou(entries, [], new Set(), new Map(), FIXED_NOW, "sam");
    const ids = items.map((i) => i.decisionId);
    expect(ids).not.toContain("her-own"); // sam's own message excluded
    expect(ids).toContain("from-agent");
    // a block from alex in HER file is inbound content to her, so it queues
    expect(ids).toContain("from-alex");
  });

  it("deriveQueueItems default still excludes alex (legacy unchanged)", () => {
    const entries: InboxEntry[] = [
      { agentName: "quill", block: block("alex") },
      { agentName: "quill", block: block("quill") },
    ];
    const { items } = deriveQueueItems(entries, new Set(), new Map(), FIXED_NOW);
    expect(items).toHaveLength(1);
    expect(items[0]!.agentName).toBe("quill");
  });

  it("isSuperseded keys on the instance user", () => {
    const blocks = [block("sam"), block("sprout")];
    // robin's block at 0 is superseded by the agent reply when user=robin
    expect(isSuperseded(blocks, 0, "sam")).toBe(true);
    // legacy default: from-alex check means a robin block does not supersede
    const blocks2 = [block("alex"), block("sam")];
    expect(isSuperseded(blocks2, 0, "sam")).toBe(false);
  });

  it("applyAnswer writes the reply from the given user", () => {
    const result = applyAnswer(cardBlock("sprout", "d1"), "A", "sam");
    expect("replyBlock" in result).toBe(true);
    if ("replyBlock" in result) {
      expect(result.replyBlock.header.from).toBe("sam");
    }
    // default stays alex (legacy callers unchanged)
    const legacy = applyAnswer(cardBlock("sprout", "d2"), "A");
    if ("replyBlock" in legacy) {
      expect(legacy.replyBlock.header.from).toBe("alex");
    }
  });
});

describe("instanceLabel", () => {
  it("absent on alex's instance (default + explicit)", () => {
    expect(instanceLabel({})).toBeUndefined();
    expect(instanceLabel({ MC_USER: "alex" })).toBeUndefined();
  });
  it("derives from MC_USER for non-alex users", () => {
    expect(instanceLabel({ MC_USER: "sam" })).toBe("Sam's workspace");
  });
  it("MC_INSTANCE_LABEL overrides", () => {
    expect(instanceLabel({ MC_USER: "sam", MC_INSTANCE_LABEL: "Sam HQ" })).toBe("Sam HQ");
  });
});

describe("projects scope (MC_PROJECTS_AGENTS)", () => {
  const cards = [
    { agent: "sprout", id: "a" },
    { agent: "quill", id: "b" },
    { agent: "Sprout", id: "c" },
  ];
  it("unset = no filter (default instance unchanged)", () => {
    expect(projectsAgents({})).toBeUndefined();
    expect(filterCardsForInstance(cards, {})).toHaveLength(3);
  });
  it("filters to the allowlist, case-insensitive", () => {
    expect(projectsAgents({ MC_PROJECTS_AGENTS: "sprout, echo" })).toEqual(["sprout", "echo"]);
    const out = filterCardsForInstance(cards, { MC_PROJECTS_AGENTS: "sprout" });
    expect(out.map((c) => c.id)).toEqual(["a", "c"]);
  });
  it("empty/garbage value = no filter", () => {
    expect(projectsAgents({ MC_PROJECTS_AGENTS: "  " })).toBeUndefined();
    expect(projectsAgents({ MC_PROJECTS_AGENTS: ", ," })).toBeUndefined();
  });
});

describe("projects scope OR-clause (assignee reaches the instance user)", () => {
  const cards = [
    { agent: "sprout", id: "a" },
    { agent: "quill", id: "b", assignee: "sam" },
    { agent: "quill", id: "c", assignee: "alex" },
  ];
  it("a card assigned to the instance user passes even off-allowlist", () => {
    const out = filterCardsForInstance(cards, { MC_PROJECTS_AGENTS: "sprout", MC_USER: "sam" });
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
  });
  it("no filter set = everything (default instance unchanged)", () => {
    expect(filterCardsForInstance(cards, {})).toHaveLength(3);
  });
});
