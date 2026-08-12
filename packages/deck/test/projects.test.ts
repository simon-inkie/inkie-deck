/**
 * test/projects.test.ts - Unit tests for app/lib/projects.server.ts (TASK-432).
 *
 * Covers per the plan section 6:
 *   - Frontmatter parse matrix:
 *       full card, missing optional ticket, missing required field (skip+warn),
 *       garbage YAML (skip+warn), unknown column (todo+warn), extra keys (round-trip).
 *   - listCards: sort updated desc; flat-dir only; non-md ignored.
 *   - moveCard: column line edited + updated bumped;
 *     BODY AND UNKNOWN KEYS BYTE-IDENTICAL after move;
 *     column-line-absent insertion;
 *     invalid cardId shapes rejected (separators, dotfile, non-md, traversal);
 *     invalid column rejected;
 *     containment (symlinked root ok, escape denied, .the-vault ban).
 *   - seam: resolveProjectsRoot throws on unset/relative.
 *   - applyTargetedEdits: targeted line edit correctness.
 *
 * Writes only to os.tmpdir() (VALID-03). assertGitClean is called in afterEach.
 *
 * ASCII only - no em-dashes (FND-05).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  resolveProjectsRoot,
  listCards,
  moveCard,
  sanitiseCardId,
  applyTargetedEdits,
  VALID_COLUMNS,
  createCard,
} from "~/lib/projects.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);

function assertGitClean(): void {
  const out = execFileSync("git", ["status", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const lines = out.split("\n").filter((l) => l.trim() !== "");
  for (const line of lines) {
    const file = line.slice(3);
    // Files expected to be present as part of this implementation.
    if (
      file.startsWith("app/lib/projects.server.ts") ||
      file.startsWith("app/lib/projects.shared.ts") ||
      file.startsWith("app/routes/projects.tsx") ||
      file.startsWith("app/components/ProjectBoard.tsx") ||
      file.startsWith("app/components/ProjectCard.tsx") ||
      file.startsWith("app/components/AppShell.tsx") ||
      file.startsWith("app/routes.ts") ||
      file.startsWith("fixtures/projects/") ||
      file.startsWith("test/projects.test.ts") ||
      file.startsWith("test/seam.test.ts") ||
      file.startsWith("test/safe-fs.test.ts") ||
      file.startsWith("app/routes/shell.tsx") ||
      file.startsWith("test/blocks/action-schema.test.ts") ||
      file.startsWith("e2e/flows/projects.test.ts") ||
      file.startsWith("e2e/setup.mjs") ||
      file.startsWith("scripts/dev.mjs") ||
      file.startsWith(".planning/") ||
      file.startsWith(".gsd-") ||
      file.startsWith(".gitignore") ||
      file.startsWith(".env.example") ||
      file.startsWith("package.json") ||
      file.startsWith("pnpm-lock.yaml") ||
      file.startsWith("playwright.config.ts") ||
      file.startsWith("e2e/") ||
      file.startsWith("docs/") ||
      file.startsWith("app/lib/safe-fs.server.ts") ||
      file.startsWith("app/lib/attachments.server.ts") ||
      file.startsWith("app/routes/attachments.$.tsx") ||
      file.startsWith("app/routes/threads.$agent.tsx") ||
      file.startsWith("app/lib/blocks/parse.ts") ||
      file.startsWith("app/lib/blocks/serialize.ts") ||
      file.startsWith("app/lib/inbox.server.ts") ||
      file.startsWith("app/lib/queue.server.ts") ||
      file.startsWith("app/lib/queue-derive.ts") ||
      file.startsWith("app/lib/stores.server.ts") ||
      file.startsWith("app/lib/test-helpers.ts") ||
      file.startsWith("app/lib/review.server.ts") ||
      file.startsWith("app/routes/home.tsx") ||
      file.startsWith("app/routes/api.review.tsx") ||
      file.startsWith("app/routes/api.review-asset.tsx") ||
      file.startsWith("app/routes/api.tmux-send.tsx") ||
      file.startsWith("app/components/QueueItem.tsx") ||
      file.startsWith("app/components/QueuePanel.tsx") ||
      file.startsWith("app/components/DecisionCard.tsx") ||
      file.startsWith("app/components/ReviewPanel.tsx") ||
      file.startsWith("app/components/MessageBubble.tsx") ||
      file.startsWith("app/components/Compose.tsx") ||
      file.startsWith("app/components/Markdown.tsx") ||
      file.startsWith("app/app.css") ||
      file.startsWith("test/seam.test.ts") ||
      file.startsWith("test/safe-fs.test.ts") ||
      file.startsWith("test/review.test.ts") ||
      file.startsWith("test/attachments.test.ts") ||
      file.startsWith("test/inbox-targeting.test.ts") ||
      file.startsWith("test/skeleton.test.ts") ||
      file.startsWith("test/queue/") ||
      file.startsWith("fixtures/plans/") ||
      file.startsWith("fixtures/e2e/") ||
      file.startsWith("scripts/detect-dup-plans.ts") ||
      file.startsWith("e2e/flows/responsive.test.ts") ||
      file.startsWith("app/root.tsx") ||
      // TASK-433: voice proxy files (new server/ directory shown as "?? server/")
      file.startsWith("server/") ||
      file.startsWith("app/lib/voice.server.ts") ||
      file.startsWith("test/voice-relay.test.ts") ||
      file.startsWith("test/voice-compose.test.ts") ||
      // TASK-446: additive voice inserts + silence auto-stop
      file.startsWith("app/lib/voice-insert.ts") ||
      file.startsWith("test/voice-insert.test.ts") ||
      // TASK-435 (platform work in flight): daemon + Tailscale dev allowance
      file.startsWith("vite.config.ts") ||
      file.startsWith(".gitignore") ||
      file.startsWith("scripts/start-production.mjs") ||
      // TASK-435.1: time.ts crash guard + regression
      file.startsWith("app/lib/time.ts") ||
      file.startsWith("test/time.test.ts") ||
      file.startsWith("e2e/flows/malformed-block.test.ts") ||
      // TASK-437: tmux Team tab + per-thread toggle amendment
      file.startsWith("app/lib/tmux.server.ts") ||
      file.startsWith("app/components/TmuxPane.tsx") ||
      file.startsWith("app/routes/tmux.tsx") ||
      file.startsWith("test/tmux.test.ts") ||
      file.startsWith("e2e/flows/tmux-tab.test.ts") ||
      file.startsWith("e2e/setup.mjs") ||
      file.startsWith("docs/plans/TASK-437-tmux-tab-PLAN.md") ||
      // TASK-456: resizable panels
      file.startsWith("app/components/ui/resizable.tsx") ||
      file.startsWith("e2e/flows/resizable.test.ts") ||
      file.startsWith("docs/plans/TASK-456-resizable-panels-PLAN.md") ||
      file.startsWith("package.json") ||
      file.startsWith("pnpm-lock.yaml") ||
      // TASK-457: avatar render side
      file.startsWith("app/lib/avatars.server.ts") ||
      file.startsWith("app/routes/avatars.$agent.tsx") ||
      file.startsWith("app/routes.ts") ||
      file.startsWith("app/components/ui/avatar.tsx") ||
      file.startsWith("app/components/Sidebar.tsx") ||
      file.startsWith("test/avatars.test.ts") ||
      file.startsWith("e2e/flows/avatars.test.ts") ||
      file.startsWith("docs/plans/TASK-457-avatar-render-PLAN.md") ||
      // TASK-454: vertical real-estate + scroll-to-latest
      file.startsWith("app/lib/scroll-follow.ts") ||
      file.startsWith("test/scroll-follow.test.ts") ||
      file.startsWith("e2e/flows/scroll-follow.test.ts") ||
      file.startsWith("docs/plans/TASK-454-vertical-real-estate-PLAN.md") ||
      // TASK-455: live updates v1
      file.startsWith("app/lib/use-live-revalidate.ts") ||
      file.startsWith("test/use-live-revalidate.test.ts") ||
      file.startsWith("e2e/flows/live-updates.test.ts") ||
      file.startsWith("app/components/AppShell.tsx") ||
      file.startsWith("docs/plans/TASK-455-live-updates-v1-PLAN.md") ||
      // TASK-453: done-card polish
      file.startsWith("app/components/ActionCard.tsx") ||
      file.startsWith("app/components/DecisionCard.tsx") ||
      file.startsWith("e2e/flows/tap-to-answer.test.ts") ||
      file.startsWith("e2e/flows/action-card.test.ts") ||
      file.startsWith("docs/plans/TASK-453-done-card-polish-PLAN.md") ||
      // TASK-443: read ticks
      file.startsWith("test/skeleton.test.ts") ||
      file.startsWith("test/blocks/roundtrip.test.ts") ||
      file.startsWith("app/components/MessageBubble.tsx") ||
      file.startsWith("e2e/flows/read-ticks.test.ts") ||
      file.startsWith("fixtures/inbox/scribe/inbox/alex.md") ||
      file.startsWith("docs/plans/TASK-443-read-ticks-PLAN.md") ||
      file.startsWith("docs/plans/TASK-446-voice-v1.1-PLAN.md") ||
      file.startsWith("app/components/VoiceDebugPanel.tsx") ||
      file.startsWith("e2e/flows/voice.test.ts") ||
      file.startsWith("docs/plans/TASK-433-voice-bug-debug-panel-PLAN.md") ||
      file.startsWith("tsconfig.json") ||
      // TASK-438: action cards + needs-you queue
      file.startsWith("app/lib/blocks/answer.ts") ||
      file.startsWith("app/lib/blocks/index.ts") ||
      file.startsWith("app/lib/blocks/model.ts") ||
      file.startsWith("app/lib/blocks/parse.ts") ||
      file.startsWith("app/lib/blocks/schema.ts") ||
      file.startsWith("app/components/ActionCard.tsx") ||
      file.startsWith("fixtures/inbox/quill/") ||
      file.startsWith("test/blocks/") ||
      file.startsWith("test/queue/derive-needs-you.test.ts") ||
      file.startsWith("e2e/flows/action-card.test.ts") ||
      file.startsWith("e2e/flows/needs-you.test.ts") ||
      file.startsWith("docs/plans/TASK-438-needs-you-PLAN.md") ||
      // TASK-439: card detail + work strip
      file.startsWith("app/components/CardDetail.tsx") ||
      file.startsWith("app/components/WorkStrip.tsx") ||
      file.startsWith("fixtures/projects/task-439-card-detail.md") ||
      file.startsWith("e2e/fixtures/test-plan.md") ||
      file.startsWith("e2e/flows/card-detail.test.ts") ||
      file.startsWith("docs/plans/TASK-439-card-detail-work-strip-PLAN.md") ||
      // TASK-440: needs-you v1.1 (dismiss, done-note, blocked-on, sections, timestamps)
      file.startsWith("fixtures/projects/task-398-portal-readonly.md") ||
      file.startsWith("docs/plans/TASK-440-needs-you-v1.1-PLAN.md") ||
      file.startsWith("e2e/flows/needs-you.test.ts") ||
      // TASK-442: morning brief panel
      file.startsWith("app/lib/briefs.server.ts") ||
      file.startsWith("app/components/MorningBrief.tsx") ||
      file.startsWith("test/briefs.test.ts") ||
      file.startsWith("fixtures/inbox/quill/briefs/") ||
      file.startsWith("e2e/flows/morning-brief.test.ts") ||
      file.startsWith("docs/plans/TASK-442-morning-brief-PLAN.md") ||
      // TASK-444: working state indicator
      file.startsWith("app/lib/blocks/working.ts") ||
      file.startsWith("app/lib/blocks/model.ts") ||
      file.startsWith("app/lib/blocks/header.ts") ||
      file.startsWith("app/components/MessageBubble.tsx") ||
      file.startsWith("app/routes/threads.$agent.tsx") ||
      file.startsWith("test/blocks/working.test.ts") ||
      file.startsWith("test/blocks/roundtrip.test.ts") ||
      file.startsWith("test/skeleton.test.ts") ||
      file.startsWith("fixtures/inbox/scribe/inbox/alex.md") ||
      file.startsWith("e2e/flows/read-ticks.test.ts") ||
      file.startsWith("docs/plans/TASK-444-working-state-PLAN.md") ||
      // TASK-445: ticket field + ticket-thread lens
      file.startsWith("app/lib/ticket.ts") ||
      file.startsWith("app/lib/ticket-thread.ts") ||
      file.startsWith("app/lib/blocks/model.ts") ||
      file.startsWith("app/lib/blocks/parse.ts") ||
      file.startsWith("app/lib/projects.shared.ts") ||
      file.startsWith("app/lib/projects.server.ts") ||
      file.startsWith("app/components/MessageBubble.tsx") ||
      file.startsWith("app/routes/threads.$agent.tsx") ||
      file.startsWith("app/routes/tickets.$ticketId.tsx") ||
      file.startsWith("app/routes.ts") ||
      file.startsWith("fixtures/inbox/scribe/inbox/alex.md") ||
      file.startsWith("fixtures/inbox/quill/inbox/alex.md") ||
      file.startsWith("test/ticket.test.ts") ||
      file.startsWith("test/ticket-thread.test.ts") ||
      file.startsWith("e2e/flows/ticket-lens.test.ts") ||
      file.startsWith("docs/plans/TASK-445-ticket-field-lens-PLAN.md") ||
      // TASK-450: attachment chips + clipboard paste
      file.startsWith("app/lib/compose-attach.ts") ||
      file.startsWith("test/compose-attach.test.ts") ||
      file.startsWith("docs/plans/TASK-450-attachment-chips-paste-PLAN.md") ||
      // 2026-06-11 lifeline hardening: error boundaries + crash guards
      file.startsWith("app/components/RouteErrorPanel.tsx") ||
      // TASK-462: per-instance user (multi-user fork prep)
      file.startsWith("app/lib/instance.server.ts") ||
      file.startsWith("test/instance.test.ts") ||
      // TASK-460: cron admin page
      file.startsWith("app/lib/cron.server.ts") ||
      file.startsWith("app/lib/cron-validate.ts") ||
      file.startsWith("app/routes/api.cron.tsx") ||
      file.startsWith("app/routes/crons.tsx") ||
      file.startsWith("app/components/ui/input.tsx") ||
      file.startsWith("app/components/ui/label.tsx") ||
      file.startsWith("app/components/ui/select.tsx") ||
      file.startsWith("app/components/ui/switch.tsx") ||
      file.startsWith("app/routes.ts") ||
      file.startsWith("app/routes/shell.tsx") ||
      file.startsWith("app/components/AppShell.tsx") ||
      file.startsWith("test/cron.server.test.ts") ||
      file.startsWith("test/cron-validate.test.ts") ||
      file.startsWith("test/api-cron.test.ts") ||
      file.startsWith("test/safe-fs.test.ts") ||
      file.startsWith("test/projects.test.ts") ||
      file.startsWith(".notes/") ||
      // TASK-500: typing-aware message batching
      file.startsWith("app/lib/pending-batch.ts") ||
      file.startsWith("app/components/PendingBubble.tsx") ||
      file.startsWith("test/pending-batch.test.ts")
    ) {
      continue;
    }
    throw new Error(
      `assertGitClean: unexpected file change in repo tree: "${line.trim()}". ` +
        "Tests must write only to os.tmpdir() (VALID-03)."
    );
  }
}

function withProjectsRoot(value: string | undefined, fn: () => void): void {
  const prev = process.env["PROJECTS_ROOT"];
  if (value === undefined) {
    delete process.env["PROJECTS_ROOT"];
  } else {
    process.env["PROJECTS_ROOT"] = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env["PROJECTS_ROOT"];
    } else {
      process.env["PROJECTS_ROOT"] = prev;
    }
  }
}

function writeCard(dir: string, filename: string, content: string): void {
  fs.writeFileSync(path.join(dir, filename), content, "utf8");
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("resolveProjectsRoot", () => {
  it("throws when PROJECTS_ROOT is unset", () => {
    withProjectsRoot(undefined, () => {
      expect(() => resolveProjectsRoot()).toThrow(/PROJECTS_ROOT is required/);
    });
  });

  it("throws when PROJECTS_ROOT is empty", () => {
    withProjectsRoot("", () => {
      expect(() => resolveProjectsRoot()).toThrow(/PROJECTS_ROOT is required/);
    });
  });

  it("throws when PROJECTS_ROOT is relative", () => {
    withProjectsRoot("fixtures/projects", () => {
      expect(() => resolveProjectsRoot()).toThrow(/absolute path/);
    });
  });

  it("returns the path when set to an absolute path", () => {
    withProjectsRoot("/tmp/some-projects", () => {
      expect(resolveProjectsRoot()).toBe("/tmp/some-projects");
    });
  });
});

// ---------------------------------------------------------------------------
// Frontmatter parse matrix (via listCards)
// ---------------------------------------------------------------------------

describe("listCards - frontmatter parse matrix", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync();
  });

  afterEach(() => {
    rmSync(sandbox);
    assertGitClean();
  });

  it("parses a full card with all fields", () => {
    withProjectsRoot(sandbox, () => {
      writeCard(sandbox, "full.md", [
        "---",
        "title: Full card",
        "agent: summit",
        "column: in progress",
        "ticket: https://linear.app/example-org/issue/TASK-1/test",
        "updated: 2026-06-06T10:00:00Z",
        "---",
        "Body text here.",
      ].join("\n"));

      const cards = listCards();
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({
        id: "full.md",
        title: "Full card",
        agent: "summit",
        column: "in progress",
        ticket: "https://linear.app/example-org/issue/TASK-1/test",
      });
      // updated may be the raw ISO string from YAML or a normalized .000Z form.
      expect(cards[0]!.updated).toMatch(/^2026-06-06T10:00:00/);
    });
  });

  it("parses a card with missing optional ticket field", () => {
    withProjectsRoot(sandbox, () => {
      writeCard(sandbox, "no-ticket.md", [
        "---",
        "title: No ticket card",
        "agent: atlas",
        "column: todo",
        "updated: 2026-06-05T08:00:00Z",
        "---",
        "No ticket on this one.",
      ].join("\n"));

      const cards = listCards();
      expect(cards).toHaveLength(1);
      expect(cards[0]!.ticket).toBeUndefined();
      expect(cards[0]!.column).toBe("todo");
    });
  });

  it("defaults-over-skip: a card missing title stays visible, titled by filename (Atlas amendment)", () => {
    withProjectsRoot(sandbox, () => {
      writeCard(sandbox, "missing-title.md", [
        "---",
        "agent: quill",
        "column: blocked",
        "updated: 2026-06-01T00:00:00Z",
        "---",
        "No title here.",
      ].join("\n"));

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cards = listCards();
        expect(cards).toHaveLength(1);
        expect(cards[0]!.title).toBe("missing-title");
        expect(cards[0]!.column).toBe("blocked");
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('missing "title"')
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it("defaults-over-skip: missing agent and updated default to unassigned + mtime", () => {
    withProjectsRoot(sandbox, () => {
      writeCard(sandbox, "bare.md", [
        "---",
        "title: Hand-made in vim",
        "---",
        "Body.",
      ].join("\n"));

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cards = listCards();
        expect(cards).toHaveLength(1);
        expect(cards[0]!.agent).toBe("unassigned");
        expect(cards[0]!.column).toBe("todo");
        // updated falls back to file mtime: a plausible ISO timestamp, not empty
        expect(cards[0]!.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it("fence-bounded edits: decoy column:/updated: lines in the BODY survive a move byte-identical (Atlas amendment)", () => {
    withProjectsRoot(sandbox, () => {
      const body = [
        "Documentation of the card format itself:",
        "",
        "```",
        "column: done",
        "updated: 1999-01-01T00:00:00Z",
        "```",
        "",
        "column: done is also written bare in prose here.",
      ].join("\n");
      const raw = [
        "---",
        "title: Self-referential card",
        "agent: summit",
        "column: todo",
        "updated: 2026-06-01T00:00:00Z",
        "---",
        body,
      ].join("\n");
      writeCard(sandbox, "decoy.md", raw);

      moveCard("decoy.md", "in review");

      const after = fs.readFileSync(path.join(sandbox, "decoy.md"), "utf8");
      // Frontmatter column changed
      expect(after).toMatch(/^column: in review$/m);
      // BODY decoys byte-identical
      expect(after).toContain(body);
      // The 1999 decoy updated line untouched
      expect(after).toContain("updated: 1999-01-01T00:00:00Z");
    });
  });

  it("skips a card with garbage YAML with warn", () => {
    withProjectsRoot(sandbox, () => {
      writeCard(sandbox, "garbage.md", [
        "---",
        "title: [not valid yaml: {",
        "---",
        "Body.",
      ].join("\n"));

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cards = listCards();
        expect(cards).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("malformed YAML")
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it("renders unknown column as 'todo' with warn", () => {
    withProjectsRoot(sandbox, () => {
      writeCard(sandbox, "unknown-col.md", [
        "---",
        "title: Unknown column card",
        "agent: briar",
        "column: wip",
        "updated: 2026-06-04T12:00:00Z",
        "---",
        "Body.",
      ].join("\n"));

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cards = listCards();
        expect(cards).toHaveLength(1);
        expect(cards[0]!.column).toBe("todo");
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("unknown column")
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it("parses a card with unknown extra frontmatter keys (keys ignored, card valid)", () => {
    withProjectsRoot(sandbox, () => {
      writeCard(sandbox, "extra-keys.md", [
        "---",
        "title: Extra keys card",
        "agent: quill",
        "column: done",
        "updated: 2026-06-03T09:00:00Z",
        "extra-key: some-value",
        "another-key: 42",
        "---",
        "Body with extra keys in frontmatter.",
      ].join("\n"));

      const cards = listCards();
      expect(cards).toHaveLength(1);
      expect(cards[0]!.title).toBe("Extra keys card");
      expect(cards[0]!.column).toBe("done");
    });
  });
});

// ---------------------------------------------------------------------------
// listCards - sort + non-md ignored
// ---------------------------------------------------------------------------

describe("listCards - sort and file filtering", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync();
  });

  afterEach(() => {
    rmSync(sandbox);
    assertGitClean();
  });

  it("sorts cards by updated desc", () => {
    withProjectsRoot(sandbox, () => {
      writeCard(sandbox, "older.md", [
        "---",
        "title: Older card",
        "agent: quill",
        "column: todo",
        "updated: 2026-06-01T00:00:00Z",
        "---",
        "Older.",
      ].join("\n"));

      writeCard(sandbox, "newer.md", [
        "---",
        "title: Newer card",
        "agent: atlas",
        "column: todo",
        "updated: 2026-06-06T00:00:00Z",
        "---",
        "Newer.",
      ].join("\n"));

      const cards = listCards();
      expect(cards).toHaveLength(2);
      expect(cards[0]!.id).toBe("newer.md");
      expect(cards[1]!.id).toBe("older.md");
    });
  });

  it("ignores non-.md files", () => {
    withProjectsRoot(sandbox, () => {
      writeCard(sandbox, "card.md", [
        "---",
        "title: Valid card",
        "agent: summit",
        "column: todo",
        "updated: 2026-06-06T00:00:00Z",
        "---",
        "Body.",
      ].join("\n"));

      // Write a non-.md file - should be ignored.
      fs.writeFileSync(path.join(sandbox, "notes.txt"), "some notes", "utf8");
      fs.writeFileSync(path.join(sandbox, "config.json"), "{}", "utf8");

      const cards = listCards();
      expect(cards).toHaveLength(1);
      expect(cards[0]!.id).toBe("card.md");
    });
  });

  it("returns empty array when root is empty", () => {
    withProjectsRoot(sandbox, () => {
      const cards = listCards();
      expect(cards).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// moveCard - targeted edits + byte-identity
// ---------------------------------------------------------------------------

describe("moveCard - targeted line edits", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync();
  });

  afterEach(() => {
    rmSync(sandbox);
    assertGitClean();
  });

  it("updates column and updated lines; body is byte-identical", () => {
    const body = "Body text that must survive BYTE-IDENTICAL.\nLine two.\n";
    const original = [
      "---",
      "title: Move test",
      "agent: summit",
      "column: todo",
      "updated: 2026-06-01T00:00:00Z",
      "---",
      body,
    ].join("\n");

    writeCard(sandbox, "move-test.md", original);

    withProjectsRoot(sandbox, () => {
      moveCard("move-test.md", "in progress");
    });

    const result = fs.readFileSync(path.join(sandbox, "move-test.md"), "utf8");

    // Column was updated.
    expect(result).toContain("column: in progress");
    // Old column is gone.
    expect(result).not.toContain("column: todo\n");
    // Updated timestamp was bumped (not the original value).
    expect(result).not.toContain("updated: 2026-06-01T00:00:00Z");
    // Body survives byte-identical.
    expect(result).toContain(body);
  });

  it("preserves unknown frontmatter keys byte-identical", () => {
    const extraLine = "extra-key: round-trip-proof-value";
    const original = [
      "---",
      "title: Extra keys test",
      "agent: quill",
      "column: blocked",
      extraLine,
      "updated: 2026-06-01T00:00:00Z",
      "---",
      "Body.",
    ].join("\n");

    writeCard(sandbox, "extra-keys.md", original);

    withProjectsRoot(sandbox, () => {
      moveCard("extra-keys.md", "done");
    });

    const result = fs.readFileSync(path.join(sandbox, "extra-keys.md"), "utf8");
    expect(result).toContain(extraLine);
    expect(result).toContain("column: done");
  });

  it("inserts column: line after opening --- when it is absent", () => {
    const original = [
      "---",
      "title: No column",
      "agent: briar",
      "updated: 2026-06-01T00:00:00Z",
      "---",
      "Body.",
    ].join("\n");

    writeCard(sandbox, "no-column.md", original);

    withProjectsRoot(sandbox, () => {
      moveCard("no-column.md", "in review");
    });

    const result = fs.readFileSync(path.join(sandbox, "no-column.md"), "utf8");
    expect(result).toContain("column: in review");
    expect(result).toContain("title: No column");
  });

  it("bumps the updated timestamp", () => {
    const original = [
      "---",
      "title: Bump test",
      "agent: atlas",
      "column: todo",
      "updated: 2026-01-01T00:00:00Z",
      "---",
      "Body.",
    ].join("\n");

    writeCard(sandbox, "bump.md", original);

    const before = new Date().getTime();
    withProjectsRoot(sandbox, () => {
      moveCard("bump.md", "done");
    });
    const after = new Date().getTime();

    const result = fs.readFileSync(path.join(sandbox, "bump.md"), "utf8");
    const updatedMatch = result.match(/^updated:\s*(.+)$/m);
    expect(updatedMatch).not.toBeNull();
    const newUpdated = new Date(updatedMatch![1]!.trim()).getTime();
    expect(newUpdated).toBeGreaterThanOrEqual(before - 100);
    expect(newUpdated).toBeLessThanOrEqual(after + 100);
  });
});

// ---------------------------------------------------------------------------
// applyTargetedEdits
// ---------------------------------------------------------------------------

describe("applyTargetedEdits - targeted line edit unit tests", () => {
  it("replaces existing column and updated lines", () => {
    const input = [
      "---",
      "title: Test",
      "agent: quill",
      "column: todo",
      "updated: 2026-01-01T00:00:00.000Z",
      "---",
      "Body.",
    ].join("\n");

    const result = applyTargetedEdits(input, "done", "2026-06-06T12:00:00.000Z");
    expect(result).toContain("column: done");
    expect(result).toContain("updated: 2026-06-06T12:00:00.000Z");
    expect(result).toContain("Body.");
    expect(result).not.toContain("column: todo");
  });

  it("inserts column: after opening --- when absent", () => {
    const input = [
      "---",
      "title: No column",
      "agent: quill",
      "updated: 2026-01-01T00:00:00.000Z",
      "---",
      "Body.",
    ].join("\n");

    const result = applyTargetedEdits(input, "blocked", "2026-06-06T12:00:00.000Z");
    expect(result).toContain("column: blocked");
    expect(result).toContain("title: No column");
  });

  it("preserves CRLF line endings", () => {
    const input = "---\r\ntitle: CRLF\r\nagent: quill\r\ncolumn: todo\r\nupdated: 2026-01-01T00:00:00.000Z\r\n---\r\nBody.\r\n";
    const result = applyTargetedEdits(input, "done", "2026-06-06T12:00:00.000Z");
    expect(result).toContain("\r\n");
    expect(result).toContain("column: done");
  });
});

// ---------------------------------------------------------------------------
// sanitiseCardId
// ---------------------------------------------------------------------------

describe("sanitiseCardId", () => {
  it("accepts a valid cardId", () => {
    expect(sanitiseCardId("task-432.md")).toBe("task-432.md");
  });

  it("rejects a cardId with a forward slash", () => {
    expect(() => sanitiseCardId("sub/card.md")).toThrow(/path separators/);
  });

  it("rejects a cardId with a backslash", () => {
    expect(() => sanitiseCardId("sub\\card.md")).toThrow(/path separators/);
  });

  it("rejects a dotfile cardId", () => {
    expect(() => sanitiseCardId(".hidden.md")).toThrow(/dotfile/);
  });

  it("rejects a cardId that does not end with .md", () => {
    expect(() => sanitiseCardId("card.txt")).toThrow(/must end with/);
  });

  it("rejects a cardId with traversal (contains /)", () => {
    expect(() => sanitiseCardId("../escape.md")).toThrow(/path separators/);
  });
});

// ---------------------------------------------------------------------------
// moveCard - validation
// ---------------------------------------------------------------------------

describe("moveCard - input validation", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync();
  });

  afterEach(() => {
    rmSync(sandbox);
    assertGitClean();
  });

  it("rejects an invalid cardId with separator", () => {
    withProjectsRoot(sandbox, () => {
      expect(() => moveCard("sub/card.md", "todo")).toThrow(/path separators/);
    });
  });

  it("rejects a dotfile cardId", () => {
    withProjectsRoot(sandbox, () => {
      expect(() => moveCard(".hidden.md", "todo")).toThrow(/dotfile/);
    });
  });

  it("rejects a cardId not ending in .md", () => {
    withProjectsRoot(sandbox, () => {
      expect(() => moveCard("card.txt", "todo")).toThrow(/must end with/);
    });
  });

  it("rejects an invalid column", () => {
    withProjectsRoot(sandbox, () => {
      expect(() => moveCard("card.md", "wip" as unknown as string)).toThrow(
        /Invalid column/
      );
    });
  });

  it("throws on a non-existent card (after validation passes)", () => {
    withProjectsRoot(sandbox, () => {
      expect(() => moveCard("nonexistent.md", "todo")).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// moveCard - containment guard
// ---------------------------------------------------------------------------

describe("moveCard - containment guard", () => {
  let sandbox: string;
  let outside: string;

  beforeEach(() => {
    sandbox = mkdtempSync();
    outside = mkdtempSync();
  });

  afterEach(() => {
    rmSync(sandbox);
    rmSync(outside);
    assertGitClean();
  });

  it("accepts a valid card inside PROJECTS_ROOT", () => {
    writeCard(sandbox, "valid.md", [
      "---",
      "title: Valid",
      "agent: quill",
      "column: todo",
      "updated: 2026-06-01T00:00:00Z",
      "---",
      "Body.",
    ].join("\n"));

    withProjectsRoot(sandbox, () => {
      expect(() => moveCard("valid.md", "done")).not.toThrow();
    });

    const result = fs.readFileSync(path.join(sandbox, "valid.md"), "utf8");
    expect(result).toContain("column: done");
  });

  it("rejects a path that escapes via symlink", () => {
    // Create a symlink inside sandbox pointing outside.
    const outsideTarget = path.join(outside, "target.md");
    writeCard(outside, "target.md", [
      "---",
      "title: Outside",
      "agent: quill",
      "column: todo",
      "updated: 2026-06-01T00:00:00Z",
      "---",
      "Body.",
    ].join("\n"));

    const linkPath = path.join(sandbox, "escape.md");
    fs.symlinkSync(outsideTarget, linkPath);

    withProjectsRoot(sandbox, () => {
      // The cardId is "escape.md" (valid shape), but resolves outside root.
      expect(() => moveCard("escape.md", "done")).toThrow(/outside the projects root/);
    });
  });

  it("rejects a card symlink that resolves outside the projects root (TASK-434)", () => {
    // Substring ban replaced by confinement: a valid-looking cardId whose
    // symlink resolves outside the root is refused by the prefix assert,
    // wherever it points (the old test pointed it at a fake .the-vault).
    const fakeBrainDir = mkdtempSync();
    try {
      const fakeBrainSubdir = path.join(fakeBrainDir, ".the-vault");
      fs.mkdirSync(fakeBrainSubdir, { recursive: true });

      // Symlink "brain-link.md" -> fakeBrainSubdir/card.md (outside the root).
      const fakeBrainFile = path.join(fakeBrainSubdir, "card.md");
      writeCard(fakeBrainSubdir, "card.md", [
        "---",
        "title: Brain card",
        "agent: quill",
        "column: todo",
        "updated: 2026-06-01T00:00:00Z",
        "---",
        "Body.",
      ].join("\n"));

      const linkPath = path.join(sandbox, "brain-link.md");
      fs.symlinkSync(fakeBrainFile, linkPath);

      withProjectsRoot(sandbox, () => {
        // "brain-link.md" passes the cardId shape check, but it resolves
        // outside the projects root - confinement refuses it.
        expect(() => moveCard("brain-link.md", "done")).toThrow(
          /outside the projects root|FND-03/
        );
      });
    } finally {
      rmSync(fakeBrainDir);
    }
  });
});

// ---------------------------------------------------------------------------
// VALID_COLUMNS export
// ---------------------------------------------------------------------------

describe("VALID_COLUMNS", () => {
  it("contains the five expected columns", () => {
    expect(VALID_COLUMNS).toEqual([
      "todo",
      "in progress",
      "blocked",
      "in review",
      "done",
    ]);
  });

  it("applyTargetedEdits refuses a file that does not open with the frontmatter fence (Atlas fold)", () => {
    const nonCard = [
      "Just some notes, no frontmatter.",
      "",
      "---",
      "",
      "A horizontal rule above, not a fence.",
    ].join("\n");
    expect(() => applyTargetedEdits(nonCard, "done", "2026-06-06T02:00:00Z")).toThrow(/fence/);
  });

});

// ---------------------------------------------------------------------------
// TASK-439: summary extraction (ADDITIVE)
// ---------------------------------------------------------------------------

describe("TASK-439 listCards - summary extraction", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync();
  });

  afterEach(() => {
    rmSync(sandbox);
    assertGitClean();
  });

  it("extracts first paragraph as summary, truncated to 140 chars", () => {
    withProjectsRoot(sandbox, () => {
      const longPara =
        "This is a very long paragraph that definitely exceeds one hundred and forty characters in total length and so it must be truncated cleanly at the 140-char limit by the summary extractor.";
      writeCard(sandbox, "long-summary.md", [
        "---",
        "title: Long summary",
        "agent: summit",
        "column: todo",
        "updated: 2026-06-06T10:00:00Z",
        "---",
        longPara,
      ].join("\n"));

      const cards = listCards();
      expect(cards).toHaveLength(1);
      expect(cards[0]!.summary.length).toBeLessThanOrEqual(141); // 140 + ellipsis char
      expect(cards[0]!.summary).toContain("…");
    });
  });

  it("uses first paragraph only (not the whole body)", () => {
    withProjectsRoot(sandbox, () => {
      writeCard(sandbox, "multi-para.md", [
        "---",
        "title: Multi paragraph",
        "agent: quill",
        "column: todo",
        "updated: 2026-06-06T10:00:00Z",
        "---",
        "First paragraph here.",
        "",
        "Second paragraph that should not appear in summary.",
      ].join("\n"));

      const cards = listCards();
      expect(cards[0]!.summary).toBe("First paragraph here.");
      expect(cards[0]!.summary).not.toContain("Second");
    });
  });

  it("returns empty summary for a card with no body", () => {
    withProjectsRoot(sandbox, () => {
      writeCard(sandbox, "no-body.md", [
        "---",
        "title: No body",
        "agent: quill",
        "column: todo",
        "updated: 2026-06-06T10:00:00Z",
        "---",
      ].join("\n"));

      const cards = listCards();
      expect(cards[0]!.summary).toBe("");
    });
  });

  it("collapses newlines within first paragraph to spaces in summary", () => {
    withProjectsRoot(sandbox, () => {
      writeCard(sandbox, "wrapped.md", [
        "---",
        "title: Wrapped",
        "agent: atlas",
        "column: todo",
        "updated: 2026-06-06T10:00:00Z",
        "---",
        "Line one of",
        "the first paragraph.",
      ].join("\n"));

      const cards = listCards();
      expect(cards[0]!.summary).toBe("Line one of the first paragraph.");
    });
  });

  it("returns full body text in body field", () => {
    withProjectsRoot(sandbox, () => {
      const bodyText = "Full body text.\n\nSecond paragraph.";
      writeCard(sandbox, "body-card.md", [
        "---",
        "title: Body card",
        "agent: summit",
        "column: in progress",
        "updated: 2026-06-06T10:00:00Z",
        "---",
        bodyText,
      ].join("\n"));

      const cards = listCards();
      expect(cards[0]!.body).toContain("Full body text.");
      expect(cards[0]!.body).toContain("Second paragraph.");
    });
  });

  it("TASK-432 fixture regression: existing cards parse identically with new fields", () => {
    // This test verifies that existing fixtures/projects cards still parse
    // correctly with the two new additive fields (summary, body).
    const fixturesPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../fixtures/projects"
    );

    withProjectsRoot(fixturesPath, () => {
      const cards = listCards();
      // All fixture cards should parse.
      expect(cards.length).toBeGreaterThanOrEqual(5);
      // Each card must have summary and body fields (may be empty strings).
      for (const card of cards) {
        expect(typeof card.summary).toBe("string");
        expect(typeof card.body).toBe("string");
        // links must be undefined or an array.
        expect(card.links === undefined || Array.isArray(card.links)).toBe(true);
      }
      // The task-439 fixture should have a body and a links entry.
      const task439 = cards.find((c) => c.id === "task-439-card-detail.md");
      expect(task439).toBeDefined();
      expect(task439!.body.length).toBeGreaterThan(0);
      expect(task439!.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(task439!.links)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// TASK-439: links: tolerant parse matrix
// ---------------------------------------------------------------------------

describe("TASK-439 listCards - links: tolerant parse matrix", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync();
  });

  afterEach(() => {
    rmSync(sandbox);
    assertGitClean();
  });

  it("parses a valid string list in links:", () => {
    withProjectsRoot(sandbox, () => {
      writeCard(sandbox, "with-links.md", [
        "---",
        "title: With links",
        "agent: summit",
        "column: todo",
        "updated: 2026-06-06T10:00:00Z",
        "links:",
        "  - ~/brain/ideas/idea-one.md",
        "  - ~/brain/decisions/dec-two.md",
        "---",
        "Body.",
      ].join("\n"));

      const cards = listCards();
      expect(cards[0]!.links).toEqual([
        "~/brain/ideas/idea-one.md",
        "~/brain/decisions/dec-two.md",
      ]);
    });
  });

  it("absent links: key returns undefined", () => {
    withProjectsRoot(sandbox, () => {
      writeCard(sandbox, "no-links.md", [
        "---",
        "title: No links",
        "agent: quill",
        "column: todo",
        "updated: 2026-06-06T10:00:00Z",
        "---",
        "Body.",
      ].join("\n"));

      const cards = listCards();
      expect(cards[0]!.links).toBeUndefined();
    });
  });

  it("non-list links: value warns + returns undefined", () => {
    withProjectsRoot(sandbox, () => {
      writeCard(sandbox, "bad-links-scalar.md", [
        "---",
        "title: Bad links scalar",
        "agent: quill",
        "column: todo",
        "updated: 2026-06-06T10:00:00Z",
        "links: not-a-list",
        "---",
        "Body.",
      ].join("\n"));

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cards = listCards();
        expect(cards[0]!.links).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('"links:" is not a list')
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it("non-string entries in links: list warn + are filtered out", () => {
    withProjectsRoot(sandbox, () => {
      writeCard(sandbox, "mixed-links.md", [
        "---",
        "title: Mixed links",
        "agent: quill",
        "column: todo",
        "updated: 2026-06-06T10:00:00Z",
        "links:",
        "  - ~/brain/ideas/good.md",
        "  - 42",
        "  - true",
        "---",
        "Body.",
      ].join("\n"));

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cards = listCards();
        // Only the string entry survives.
        expect(cards[0]!.links).toEqual(["~/brain/ideas/good.md"]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("non-string entry")
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it("all-non-string links: list returns undefined (not empty array)", () => {
    withProjectsRoot(sandbox, () => {
      writeCard(sandbox, "all-bad-links.md", [
        "---",
        "title: All bad links",
        "agent: quill",
        "column: todo",
        "updated: 2026-06-06T10:00:00Z",
        "links:",
        "  - 42",
        "  - false",
        "---",
        "Body.",
      ].join("\n"));

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cards = listCards();
        expect(cards[0]!.links).toBeUndefined();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// TASK-462 Phase 1: assignee parse + createCard
// ---------------------------------------------------------------------------
describe("assignee + createCard (TASK-462 Phase 1)", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync();
  });
  afterEach(() => {
    rmSync(tmpRoot);
    assertGitClean();
  });

  it("parses assignee from frontmatter (lowercased), absent on old cards", () => {
    withProjectsRoot(tmpRoot, () => {
      fs.writeFileSync(
        path.join(tmpRoot, "with-assignee.md"),
        "---\ntitle: T\nagent: sprout\ncolumn: todo\nassignee: Robin\nupdated: 2026-06-11T10:00:00Z\n---\nBody.\n",
        "utf8"
      );
      fs.writeFileSync(
        path.join(tmpRoot, "without.md"),
        "---\ntitle: U\nagent: quill\ncolumn: todo\nupdated: 2026-06-11T09:00:00Z\n---\n",
        "utf8"
      );
      const cards = listCards();
      const withA = cards.find((c) => c.id === "with-assignee.md");
      const withoutA = cards.find((c) => c.id === "without.md");
      expect(withA?.assignee).toBe("robin");
      expect(withoutA?.assignee).toBeUndefined();
    });
  });

  it("createCard writes a todo card that round-trips through listCards", () => {
    withProjectsRoot(tmpRoot, () => {
      const id = createCard({
        title: "Send Robin the tour deck",
        agent: "Sprout",
        assignee: "robin",
        ticket: "TASK-500",
      });
      expect(id).toBe("send-robin-the-tour-deck.md");
      const card = listCards().find((c) => c.id === id);
      expect(card?.title).toBe("Send Robin the tour deck");
      expect(card?.agent).toBe("sprout");
      expect(card?.column).toBe("todo");
      expect(card?.assignee).toBe("robin");
      expect(card?.ticketId).toBe("TASK-500");
    });
  });

  it("collision appends a numeric suffix, never overwrites", () => {
    withProjectsRoot(tmpRoot, () => {
      const first = createCard({ title: "Same title", agent: "sprout" });
      const second = createCard({ title: "Same title", agent: "sprout" });
      expect(first).toBe("same-title.md");
      expect(second).toBe("same-title-2.md");
      expect(fs.readFileSync(path.join(tmpRoot, first), "utf8")).not.toBe("");
    });
  });

  it("rejects garbage agent / oversize title / bad ticket", () => {
    withProjectsRoot(tmpRoot, () => {
      expect(() => createCard({ title: "x", agent: "../evil" })).toThrow();
      expect(() => createCard({ title: "y".repeat(201), agent: "sprout" })).toThrow();
      expect(() => createCard({ title: "z", agent: "sprout", ticket: "javascript:alert(1)" })).toThrow();
    });
  });
});
