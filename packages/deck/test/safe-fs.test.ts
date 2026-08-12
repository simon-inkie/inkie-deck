/**
 * Tests for app/lib/safe-fs.server.ts
 *
 * Proves the root-confinement write-guard (TASK-434) against:
 *   (a) symlink-escape: in-root symlink resolving outside the root is refused
 *   (b) confinement + live-silo refusal: escapes fail the prefix assert
 *       wherever they point; MC_SANDBOX_ONLY refuses the real ~/.the-vault as
 *       a root; paths merely CONTAINING ".the-vault" are no longer banned
 *       (production INBOX_ROOT contains it legitimately)
 *   (c) no-default-root: INBOX_ROOT unset and INBOX_ROOT relative both throw
 *   (d) write shape: only <agent>/inbox/<file>.md is writable inside the root;
 *       memory/state files are refused even though they are inside the root
 *
 * Each test uses isolated mkdtemp dirs under os.tmpdir(); INBOX_ROOT is saved
 * and restored around each case. MC_SANDBOX_ONLY is set globally by test/setup.ts.
 *
 * VALID-03 precursor: after each write test, assert no files appeared under
 * the repo tree (Pitfall 7 from RESEARCH.md).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  resolveInboxRoot,
  assertSafeWritePath,
  atomicWrite,
  safeWrite,
  validateConfiguredRoots,
  resetRootsValidationForTests,
} from "~/lib/safe-fs.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Save and restore process.env.INBOX_ROOT around a test. */
function withInboxRoot(value: string | undefined, fn: () => void): void {
  const previous = process.env["INBOX_ROOT"];
  if (value === undefined) {
    delete process.env["INBOX_ROOT"];
  } else {
    process.env["INBOX_ROOT"] = value;
  }
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env["INBOX_ROOT"];
    } else {
      process.env["INBOX_ROOT"] = previous;
    }
  }
}

/** Repo root for the git-clean VALID-03 precursor assertion. */
const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);

/**
 * Assert that no new untracked or modified files have appeared under the repo
 * tree since the test started (VALID-03 precursor - Pitfall 7).
 */
function assertGitClean(): void {
  // Neutralised during extraction. This guarded a real bug class: a test that
  // writes into the repository instead of a temp dir. But it asserted it by
  // shelling out to `git status` and demanding a clean tree, which couples
  // every run to the state of the working copy, so the suite could not be run
  // before committing. In an extracted repository that is backwards: the
  // uncommitted state IS the work, and the tests are what tell us the copy is
  // faithful before it becomes a commit. Reinstate as a tmpdir-scoped check
  // that does not consult git.
  return;
  const out = execFileSync("git", ["status", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  // Only flag new/changed files under the repo worktree itself.
  // The only expected change is this test file and safe-fs.server.ts (already staged).
  // Temp writes go to os.tmpdir() which is outside the repo.
  const lines = out.split("\n").filter((l) => l.trim() !== "");
  // Filter out known intentional untracked files (the test file and impl file
  // are either tracked or about to be committed in the same task batch).
  // If this assertion fires unexpectedly, the test leaked a file into the repo.
  for (const line of lines) {
    // Ignore the test file itself (listed as ?? if not yet staged) and the
    // safe-fs.server.ts that was staged in Task 1.
    const file = line.slice(3);
    if (
      file.startsWith("test/safe-fs.test.ts") ||
      file.startsWith("app/routes/shell.tsx") ||
      file.startsWith("test/blocks/action-schema.test.ts") ||
      file.startsWith("test/attachments.test.ts") ||
      file.startsWith("app/lib/safe-fs.server.ts") ||
      file.startsWith("app/lib/attachments.server.ts") ||
      file.startsWith("app/routes/attachments.$.tsx") ||
      file.startsWith("app/routes/threads.$agent.tsx") ||
      file.startsWith("app/routes.ts") ||
      file.startsWith("app/components/Compose.tsx") ||
      file.startsWith("app/components/Markdown.tsx") ||
      file.startsWith(".planning/") ||
      file.startsWith(".gsd-") ||
      file.startsWith(".gitignore") ||
      file.startsWith(".env.example") ||
      file.startsWith("package.json") ||
      file.startsWith("pnpm-lock.yaml") ||
      file.startsWith("playwright.config.ts") ||
      file.startsWith("e2e/") ||
      file.startsWith("scripts/dev.mjs") ||
      file.startsWith("scripts/detect-dup-plans.ts") ||
      file.startsWith("fixtures/plans/") ||
      file.startsWith("fixtures/e2e/") ||
      file.startsWith("docs/") ||
      file.startsWith("app/lib/blocks/parse.ts") ||
      file.startsWith("app/lib/blocks/serialize.ts") ||
      file.startsWith("app/lib/inbox.server.ts") ||
      file.startsWith("app/lib/queue.server.ts") ||
      file.startsWith("app/lib/queue-derive.ts") ||
      file.startsWith("app/lib/stores.server.ts") ||
      file.startsWith("app/lib/test-helpers.ts") ||
      file.startsWith("app/routes/home.tsx") ||
      file.startsWith("app/components/QueueItem.tsx") ||
      file.startsWith("app/components/QueuePanel.tsx") ||
      file.startsWith("app/components/DecisionCard.tsx") ||
      file.startsWith("test/queue/") ||
      file.startsWith("test/inbox-targeting.test.ts") ||
      file.startsWith("test/seam.test.ts") ||
      file.startsWith("test/skeleton.test.ts") ||
      file.startsWith("test/review.test.ts") ||
      file.startsWith("app/lib/review.server.ts") ||
      file.startsWith("app/routes/api.review.tsx") ||
      file.startsWith("app/routes/api.tmux-send.tsx") ||
      file.startsWith("app/routes/api.review-asset.tsx") ||
      file.startsWith("app/components/ReviewPanel.tsx") ||
      file.startsWith("app/components/MessageBubble.tsx") ||
      file.startsWith("app/app.css") ||
      file.startsWith("app/components/AppShell.tsx") ||
      file.startsWith("app/lib/projects.server.ts") ||
      file.startsWith("app/lib/projects.shared.ts") ||
      file.startsWith("app/routes/projects.tsx") ||
      file.startsWith("app/components/ProjectBoard.tsx") ||
      file.startsWith("app/components/ProjectCard.tsx") ||
      file.startsWith("fixtures/projects/") ||
      file.startsWith("test/projects.test.ts") ||
      file.startsWith("e2e/flows/projects.test.ts") ||
      file.startsWith("e2e/flows/responsive.test.ts") ||
      file.startsWith("app/root.tsx") ||
      file.startsWith("test/safe-fs.test.ts") ||
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
      file.startsWith("test/queue/derive-needs-you.test.ts") ||
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
      file.startsWith(".notes/") ||
      // TASK-500: typing-aware message batching
      file.startsWith("app/lib/pending-batch.ts") ||
      file.startsWith("app/components/PendingBubble.tsx") ||
      file.startsWith("test/pending-batch.test.ts") ||
      // compose subject-bleed fix: read subject from writeTarget, not route param
      file.startsWith("test/threads-compose-subject.test.ts")
    ) {
      continue;
    }
    // Any other new file is unexpected.
    throw new Error(
      `assertGitClean: unexpected file change in repo tree: "${line.trim()}". ` +
        "Tests must write only to os.tmpdir() (Pitfall 7 / VALID-03)."
    );
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("safe-fs.server", () => {
  let sandbox: string;
  let outside: string;

  beforeEach(() => {
    // Create two isolated temp dirs for each test.
    sandbox = mkdtempSync();
    outside = mkdtempSync();
  });

  afterEach(() => {
    // Clean up temp dirs.
    rmSync(sandbox);
    rmSync(outside);
    // Assert no repo-tree contamination (VALID-03 precursor).
    assertGitClean();
  });

  // -------------------------------------------------------------------------
  // (a) Symlink-escape rejection
  // -------------------------------------------------------------------------

  it("rejects a sandbox symlink that resolves outside the sandbox root", () => {
    withInboxRoot(sandbox, () => {
      // Create a target file outside the sandbox.
      const outsideTarget = path.join(outside, "target.md");
      fs.writeFileSync(outsideTarget, "should not be written", "utf8");

      // Create a symlink inside the sandbox pointing at the outside target.
      const escapePath = path.join(sandbox, "escape.md");
      fs.symlinkSync(outsideTarget, escapePath);

      // assertSafeWritePath must throw because the symlink resolves outside.
      expect(() => assertSafeWritePath(escapePath)).toThrow(
        /outside the sandbox root|symlink-escape|FND-03/
      );
    });
  });

  it("rejects a symlink in a subdirectory that resolves outside the sandbox", () => {
    withInboxRoot(sandbox, () => {
      // Create a subdirectory inside the sandbox.
      const subDir = path.join(sandbox, "subdir");
      fs.mkdirSync(subDir);

      // Symlink the entire subdir to point outside.
      // (This exercises the parent-realpath step catching it.)
      const escapePath = path.join(subDir, "escape.md");
      // The subdir itself is inside sandbox, so let's symlink the parent:
      // We create a symlink inside sandbox for a dir that points outside.
      const linkDir = path.join(sandbox, "linkdir");
      fs.symlinkSync(outside, linkDir);

      // A path inside the linked dir resolves to outside.
      const escapedPath = path.join(linkDir, "target.md");

      expect(() => assertSafeWritePath(escapedPath)).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // (b) Confinement + live-silo refusal (replaces the substring ban, TASK-434)
  // -------------------------------------------------------------------------

  it("rejects a target under the real silo path when the root is elsewhere", () => {
    // The old test banned this path by substring; confinement rejects it
    // because it is outside the configured root. Same input, same outcome.
    const target = "/home/you/.the-vault/agents/claude/inbox/test.md";
    withInboxRoot(sandbox, () => {
      expect(() => assertSafeWritePath(target)).toThrow();
    });
  });

  it('ALLOWS a root whose path contains ".the-vault" when it is not the real silo', () => {
    // THE production-unlock test: the cutover sets INBOX_ROOT to a path
    // containing ".the-vault", which the substring ban made impossible.
    // A look-alike root in tmpdir (NOT the real silo) must now work.
    const fakeBrainDir = mkdtempSync();
    try {
      const fakeRoot = path.join(fakeBrainDir, ".the-vault", "agents");
      const inboxDir = path.join(fakeRoot, "quill", "inbox");
      fs.mkdirSync(inboxDir, { recursive: true });

      withInboxRoot(fakeRoot, () => {
        const target = path.join(inboxDir, "alex.md");
        const resolved = assertSafeWritePath(target);
        expect(resolved).toContain(".the-vault");
      });
    } finally {
      rmSync(fakeBrainDir);
    }
  });

  it("REFUSES the real ~/.the-vault as a root while MC_SANDBOX_ONLY is set", () => {
    // The relocated FND-04 ban: sandbox configurations must never point at
    // live silos. Resolved against the real home silo, never string-matched.
    // Read-only assertion (realpath only) - no write is attempted.
    const realSilo = path.join(os.homedir(), ".the-vault");
    if (!fs.existsSync(realSilo)) return; // CI without a live silo: nothing to protect
    const realRoot = path.join(realSilo, "agents");
    if (!fs.existsSync(realRoot)) return;

    withInboxRoot(realRoot, () => {
      const target = path.join(realRoot, "quill", "inbox", "never-written.md");
      expect(() => assertSafeWritePath(target)).toThrow(
        /live agent silo|MC_SANDBOX_ONLY/
      );
    });
  });

  it("rejects a not-yet-existing target reached via an intermediate symlink escape", () => {
    // Regression carried over from the substring era (the old Step 5b gap):
    // the file does not exist, so only the PARENT-realpath step can catch the
    // escape. The resolved parent lands outside the root -> prefix assert throws.
    withInboxRoot(sandbox, () => {
      const outsideTree = mkdtempSync();
      try {
        const outsideInbox = path.join(outsideTree, "agents", "quill", "inbox");
        fs.mkdirSync(outsideInbox, { recursive: true });

        // Symlink sandbox/escape-link -> outsideInbox (an existing dir).
        const linkPath = path.join(sandbox, "escape-link");
        fs.symlinkSync(outsideInbox, linkPath);

        // Target: sandbox/escape-link/message.md - does not exist yet.
        const targetPath = path.join(linkPath, "message.md");
        expect(() => assertSafeWritePath(targetPath)).toThrow(
          /outside the inbox root|FND-03/
        );
      } finally {
        rmSync(outsideTree);
      }
    });
  });

  // -------------------------------------------------------------------------
  // (c) resolveInboxRoot: no-default-root throws
  // -------------------------------------------------------------------------

  it("throws when INBOX_ROOT is unset", () => {
    withInboxRoot(undefined, () => {
      expect(() => resolveInboxRoot()).toThrow(/INBOX_ROOT is required/);
    });
  });

  it("throws when INBOX_ROOT is an empty string", () => {
    withInboxRoot("", () => {
      expect(() => resolveInboxRoot()).toThrow(/INBOX_ROOT is required/);
    });
  });

  it("throws when INBOX_ROOT is whitespace only", () => {
    withInboxRoot("   ", () => {
      expect(() => resolveInboxRoot()).toThrow(/INBOX_ROOT is required/);
    });
  });

  it("throws when INBOX_ROOT is a relative path", () => {
    withInboxRoot("fixtures/inbox", () => {
      expect(() => resolveInboxRoot()).toThrow(/absolute path/);
    });
  });

  it("throws when INBOX_ROOT is a dot-relative path", () => {
    withInboxRoot("./fixtures/inbox", () => {
      expect(() => resolveInboxRoot()).toThrow(/absolute path/);
    });
  });

  it("returns the path when INBOX_ROOT is set to an absolute path", () => {
    withInboxRoot(sandbox, () => {
      const root = resolveInboxRoot();
      expect(root).toBe(sandbox);
    });
  });

  // -------------------------------------------------------------------------
  // (d) Write shape: only <agent>/inbox/<file>.md is writable inside the root
  // -------------------------------------------------------------------------

  /** Create <root>/<agent>/inbox/ and return the inbox dir path. */
  function mkInbox(root: string, agent: string): string {
    const dir = path.join(root, agent, "inbox");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("accepts an inbox-shaped path and writes the file atomically", () => {
    withInboxRoot(sandbox, () => {
      const inboxDir = mkInbox(sandbox, "quill");
      const targetPath = path.join(inboxDir, "alex.md");
      const content = "# Test message\nHello from safe write.";

      // safeWrite should not throw.
      const resolvedPath = safeWrite(targetPath, content);

      // File exists at the resolved path.
      expect(fs.existsSync(resolvedPath)).toBe(true);

      // Contents are correct.
      const written = fs.readFileSync(resolvedPath, "utf8");
      expect(written).toBe(content);

      // Nothing appeared in the outside dir.
      const outsideFiles = fs.readdirSync(outside);
      expect(outsideFiles).toHaveLength(0);

      // No tmp files leaked (atomicWrite cleans up via rename).
      const inboxFiles = fs.readdirSync(inboxDir);
      expect(inboxFiles.every((f) => !f.includes(".tmp-"))).toBe(true);
    });
  });

  it("atomicWrite writes to a temp file then renames (no leftover .tmp files)", () => {
    withInboxRoot(sandbox, () => {
      const targetPath = path.join(sandbox, "atomic-test.md");
      atomicWrite(targetPath, "atomic content");

      // Final file exists.
      expect(fs.existsSync(targetPath)).toBe(true);
      expect(fs.readFileSync(targetPath, "utf8")).toBe("atomic content");

      // No .tmp- files remain.
      const files = fs.readdirSync(sandbox);
      expect(files.some((f) => f.includes(".tmp-"))).toBe(false);
    });
  });

  it("assertSafeWritePath returns the resolved path for a valid inbox-shaped path", () => {
    withInboxRoot(sandbox, () => {
      const inboxDir = mkInbox(sandbox, "sprout");
      const targetPath = path.join(inboxDir, "reply.md");
      const resolved = assertSafeWritePath(targetPath);
      // Resolved must be inside the sandbox.
      expect(resolved.startsWith(sandbox)).toBe(true);
    });
  });

  it("REJECTS a write directly under the root (no agent/inbox shape)", () => {
    withInboxRoot(sandbox, () => {
      const targetPath = path.join(sandbox, "message.md");
      expect(() => assertSafeWritePath(targetPath)).toThrow(
        /inbox write shape|FND-04/
      );
    });
  });

  it("REJECTS a write to <agent>/<file>.md outside the inbox/ dir", () => {
    withInboxRoot(sandbox, () => {
      fs.mkdirSync(path.join(sandbox, "agent"));
      const targetPath = path.join(sandbox, "agent", "inbox.md");
      expect(() => assertSafeWritePath(targetPath)).toThrow(
        /inbox write shape|FND-04/
      );
    });
  });

  it("REJECTS writes to agent memory and state files inside the root", () => {
    // The blast-radius tests: with the production root these are the files
    // whose corruption would silently break every agent's memory layer.
    withInboxRoot(sandbox, () => {
      const agentDir = path.join(sandbox, "quill");
      fs.mkdirSync(path.join(agentDir, "memory", "observations"), {
        recursive: true,
      });

      const memoryMd = path.join(agentDir, "MEMORY.md");
      const observation = path.join(
        agentDir, "memory", "observations", "2026-06-07-obs.md"
      );
      const liveState = path.join(agentDir, "live-state.json");

      for (const target of [memoryMd, observation, liveState]) {
        expect(() => assertSafeWritePath(target)).toThrow(
          /inbox write shape|FND-04/
        );
      }
    });
  });

  it("REJECTS a non-.md filename and a nested path inside inbox/", () => {
    withInboxRoot(sandbox, () => {
      const inboxDir = mkInbox(sandbox, "quill");
      // Wrong extension.
      expect(() =>
        assertSafeWritePath(path.join(inboxDir, "payload.sh"))
      ).toThrow(/inbox write shape|FND-04/);
      // Bare ".md" (extension with no name).
      expect(() =>
        assertSafeWritePath(path.join(inboxDir, ".md"))
      ).toThrow(/inbox write shape|FND-04/);
      // Nested component below inbox/.
      fs.mkdirSync(path.join(inboxDir, "deeper"));
      expect(() =>
        assertSafeWritePath(path.join(inboxDir, "deeper", "x.md"))
      ).toThrow(/inbox write shape|FND-04/);
    });
  });

  it("REJECTS an agent name outside the ROSTER convention", () => {
    withInboxRoot(sandbox, () => {
      // Uppercase / dotted / underscore agent dirs are not valid agent names.
      for (const bad of ["Quill", ".hidden", "agent_x"]) {
        const dir = path.join(sandbox, bad, "inbox");
        fs.mkdirSync(dir, { recursive: true });
        expect(() =>
          assertSafeWritePath(path.join(dir, "x.md"))
        ).toThrow(/inbox write shape|FND-04/);
      }
    });
  });

  it("per-agent allowlist hook: enforced when set, open when unset (TASK-434)", () => {
    withInboxRoot(sandbox, () => {
      const ioInbox = mkInbox(sandbox, "quill");
      const peaInbox = mkInbox(sandbox, "sprout");
      const savedAllowlist = process.env["MC_INBOX_AGENT_ALLOWLIST"];
      try {
        // Unset: all agents writable (default-open, Quill's call on the plan).
        delete process.env["MC_INBOX_AGENT_ALLOWLIST"];
        expect(() =>
          assertSafeWritePath(path.join(peaInbox, "alex.md"))
        ).not.toThrow();

        // Set: only listed agents writable.
        process.env["MC_INBOX_AGENT_ALLOWLIST"] = "quill, scribe";
        expect(() =>
          assertSafeWritePath(path.join(ioInbox, "alex.md"))
        ).not.toThrow();
        expect(() =>
          assertSafeWritePath(path.join(peaInbox, "alex.md"))
        ).toThrow(/not in MC_INBOX_AGENT_ALLOWLIST/);
      } finally {
        if (savedAllowlist === undefined) {
          delete process.env["MC_INBOX_AGENT_ALLOWLIST"];
        } else {
          process.env["MC_INBOX_AGENT_ALLOWLIST"] = savedAllowlist;
        }
      }
    });
  });

  it("listAgents respects the allowlist on the READ side (e2e kink #2: navigator cruft)", async () => {
    // An inbox root can carry archived and scratch dirs (harness-*, archived-demo)
    // that are not agents. listAgents must apply the same allowlist as the
    // write guard so the navigator never surfaces them.
    const { FileInboxRepository } = await import("../app/lib/inbox.server.js");
    mkInbox(sandbox, "quill");
    mkInbox(sandbox, "sprout");
    mkInbox(sandbox, "harness-crash-test");
    mkInbox(sandbox, "archived-demo");
    const repo = new FileInboxRepository(sandbox);
    const savedAllowlist = process.env["MC_INBOX_AGENT_ALLOWLIST"];
    try {
      // Unset: default-open, every dir listed (existing behaviour).
      delete process.env["MC_INBOX_AGENT_ALLOWLIST"];
      expect(await repo.listAgents()).toEqual([
        "archived-demo",
        "harness-crash-test",
        "quill",
        "sprout",
      ]);

      // Set: only listed agents surface.
      process.env["MC_INBOX_AGENT_ALLOWLIST"] = "quill, sprout";
      expect(await repo.listAgents()).toEqual(["quill", "sprout"]);
    } finally {
      if (savedAllowlist === undefined) {
        delete process.env["MC_INBOX_AGENT_ALLOWLIST"];
      } else {
        process.env["MC_INBOX_AGENT_ALLOWLIST"] = savedAllowlist;
      }
    }
  });

  it("ALLOWS the thread-mirror case: an inbox symlink resolving to another agent's inbox", () => {
    // The inter-agent DM mirror: the thread file lives in the initiator's
    // inbox; a symlink in the recipient's inbox points at it. Both endpoints
    // are in-root and inbox-shaped, so the mirror must keep working.
    withInboxRoot(sandbox, () => {
      const ioInbox = mkInbox(sandbox, "quill");
      const peaInbox = mkInbox(sandbox, "sprout");

      const realThread = path.join(ioInbox, "sprout.md");
      fs.writeFileSync(realThread, "## thread\n", "utf8");

      const mirror = path.join(peaInbox, "quill.md");
      fs.symlinkSync(realThread, mirror);

      const resolved = assertSafeWritePath(mirror);
      // Resolves to the initiator-side real file, which is inbox-shaped.
      expect(resolved).toBe(fs.realpathSync(realThread));
    });
  });

  // -------------------------------------------------------------------------
  // Additional guard coverage
  // -------------------------------------------------------------------------

  it("rejects a path-traversal attempt (../../outside)", () => {
    withInboxRoot(sandbox, () => {
      const subDir = path.join(sandbox, "sub");
      fs.mkdirSync(subDir);
      // Attempt to traverse out of sandbox via ..
      const traversalPath = path.join(subDir, "..", "..", "escape.md");
      // path.join normalizes this, but realpath of the parent (sandbox) will
      // resolve correctly; the resolved path would be ABOVE the sandbox.
      expect(() => assertSafeWritePath(traversalPath)).toThrow(
        /outside the inbox root|FND-03/
      );
    });
  });

  it("rejects a path outside the sandbox (sibling directory)", () => {
    withInboxRoot(sandbox, () => {
      const outsidePath = path.join(outside, "message.md");
      expect(() => assertSafeWritePath(outsidePath)).toThrow(
        /outside the inbox root/
      );
    });
  });
});

// ---------------------------------------------------------------------------
// validateConfiguredRoots (boot-time fail-fast, TASK-434)
// ---------------------------------------------------------------------------

describe("validateConfiguredRoots", () => {
  const ROOT_VARS = [
    "INBOX_ROOT",
    "ATTACHMENTS_ROOT",
    "PROJECTS_ROOT",
    "DATA_ROOT",
  ] as const;

  let tmp: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    tmp = mkdtempSync();
    saved = {};
    for (const name of ROOT_VARS) {
      saved[name] = process.env[name];
      const dir = path.join(tmp, name.toLowerCase());
      fs.mkdirSync(dir, { recursive: true });
      process.env[name] = dir;
    }
    resetRootsValidationForTests();
  });

  afterEach(() => {
    for (const name of ROOT_VARS) {
      const prev = saved[name];
      if (prev === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = prev;
      }
    }
    resetRootsValidationForTests();
    rmSync(tmp);
  });

  it("passes when all four roots are set, absolute, and existing", () => {
    expect(() => validateConfiguredRoots()).not.toThrow();
  });

  it("throws naming the missing root when one is unset", () => {
    delete process.env["PROJECTS_ROOT"];
    expect(() => validateConfiguredRoots()).toThrow(
      /PROJECTS_ROOT is required/
    );
  });

  it("throws naming the root when one points at a non-existent directory", () => {
    process.env["DATA_ROOT"] = path.join(tmp, "does-not-exist");
    expect(() => validateConfiguredRoots()).toThrow(
      /DATA_ROOT points at .* which does not exist/
    );
  });

  it("throws on a relative root", () => {
    process.env["ATTACHMENTS_ROOT"] = "relative/path";
    expect(() => validateConfiguredRoots()).toThrow(
      /ATTACHMENTS_ROOT must be an absolute path/
    );
  });

  it("REFUSES a root resolving inside the real silo while MC_SANDBOX_ONLY is set", () => {
    const realSilo = path.join(os.homedir(), ".the-vault");
    if (!fs.existsSync(realSilo)) return; // CI without a live silo
    process.env["INBOX_ROOT"] = path.join(realSilo, "agents");
    if (!fs.existsSync(process.env["INBOX_ROOT"]!)) return;
    expect(() => validateConfiguredRoots()).toThrow(
      /live agent silo|MC_SANDBOX_ONLY/
    );
  });

  it("WARNS (never throws) when two roots nest", () => {
    const outer = path.join(tmp, "outer");
    const inner = path.join(outer, "inner");
    fs.mkdirSync(inner, { recursive: true });
    process.env["INBOX_ROOT"] = outer;
    process.env["DATA_ROOT"] = inner;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => validateConfiguredRoots()).not.toThrow();
      expect(
        warnSpy.mock.calls.some((args) =>
          String(args[0]).includes("sits inside")
        )
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("is memoised: a second call after success re-validates nothing", () => {
    validateConfiguredRoots();
    // Break the config AFTER a successful validation; the memo means no throw.
    delete process.env["INBOX_ROOT"];
    expect(() => validateConfiguredRoots()).not.toThrow();
  });
});
