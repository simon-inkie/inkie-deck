/**
 * Tests for app/lib/attachments.server.ts
 *
 * Covers:
 *   - resolveAttachmentsRoot: throw on unset/empty/relative, return on absolute.
 *   - assertSafeAttachmentPath: containment (escape via .., symlink inside root
 *     pointing out, symlinked root - the /mnt/c case simulated with tmpdir symlink).
 *   - .the-vault ban.
 *   - Type policy: accept/reject matrix incl svg-never-inline disposition.
 *   - Size caps.
 *   - Filename sanitisation.
 *   - Timestamp naming + collision suffix.
 *   - saveAttachment round-trip + atomicWriteBuffer.
 *   - readAttachment containment.
 *
 * Each test uses isolated mkdtemp dirs. MC_SANDBOX_ONLY is set globally by
 * test/setup.ts. VALID-03: afterAll assertGitClean - tests must write to
 * os.tmpdir() only.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  resolveAttachmentsRoot,
  assertSafeAttachmentPath,
  saveAttachment,
  readAttachment,
  sanitiseFilename,
  policyForExtension,
} from "~/lib/attachments.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withAttachmentsRoot(value: string | undefined, fn: () => void): void {
  const previous = process.env["ATTACHMENTS_ROOT"];
  if (value === undefined) {
    delete process.env["ATTACHMENTS_ROOT"];
  } else {
    process.env["ATTACHMENTS_ROOT"] = value;
  }
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env["ATTACHMENTS_ROOT"];
    } else {
      process.env["ATTACHMENTS_ROOT"] = previous;
    }
  }
}

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
    // Ignore known-dirty files introduced in the implementation batch.
    if (
      file.startsWith("test/attachments.test.ts") ||
      file.startsWith("test/safe-fs.test.ts") ||
      file.startsWith("app/routes/shell.tsx") ||
      file.startsWith("app/components/AppShell.tsx") ||
      file.startsWith("app/lib/blocks/schema.ts") ||
      file.startsWith("app/lib/blocks/parse.ts") ||
      file.startsWith("test/blocks/action-schema.test.ts") ||
      file.startsWith("app/lib/attachments.server.ts") ||
      file.startsWith("app/lib/safe-fs.server.ts") ||
      file.startsWith("app/routes/attachments.$.tsx") ||
      file.startsWith("app/routes/threads.$agent.tsx") ||
      file.startsWith("app/routes.ts") ||
      file.startsWith("app/components/Compose.tsx") ||
      file.startsWith("app/components/Markdown.tsx") ||
      file.startsWith("test/seam.test.ts") ||
      file.startsWith("e2e/") ||
      file.startsWith("scripts/dev.mjs") ||
      file.startsWith("scripts/check-dashes.mjs") ||
      file.startsWith(".env.example") ||
      file.startsWith(".planning/") ||
      file.startsWith(".gsd-") ||
      file.startsWith(".gitignore") ||
      file.startsWith("package.json") ||
      file.startsWith("pnpm-lock.yaml") ||
      file.startsWith("playwright.config.ts") ||
      file.startsWith("scripts/detect-dup-plans.ts") ||
      file.startsWith("fixtures/plans/") ||
      file.startsWith("fixtures/e2e/") ||
      file.startsWith("docs/") ||
      file.startsWith("app/lib/blocks/") ||
      file.startsWith("app/lib/inbox.server.ts") ||
      file.startsWith("app/lib/queue.server.ts") ||
      file.startsWith("app/lib/queue-derive.ts") ||
      file.startsWith("app/lib/stores.server.ts") ||
      file.startsWith("app/lib/test-helpers.ts") ||
      file.startsWith("app/routes/home.tsx") ||
      file.startsWith("app/components/") ||
      file.startsWith("test/queue/") ||
      file.startsWith("test/inbox-targeting.test.ts") ||
      file.startsWith("test/skeleton.test.ts") ||
      file.startsWith("test/review.test.ts") ||
      file.startsWith("app/lib/review.server.ts") ||
      file.startsWith("app/routes/api.review.tsx") ||
      file.startsWith("app/routes/api.review-asset.tsx") ||
      file.startsWith("app/routes/api.tmux-send.tsx") ||
      file.startsWith("app/components/ReviewPanel.tsx") ||
      file.startsWith("app/app.css") ||
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
      file.startsWith("e2e/flows/voice.test.ts") ||
      file.startsWith("docs/plans/TASK-433-voice-bug-debug-panel-PLAN.md") ||
      file.startsWith("tsconfig.json") ||
      // TASK-438: action cards + needs-you queue
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
      file.startsWith("app/lib/projects.shared.ts") ||
      file.startsWith("app/lib/projects.server.ts") ||
      file.startsWith("app/routes/tickets.$ticketId.tsx") ||
      file.startsWith("app/routes.ts") ||
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
      file.startsWith("test/attachments.test.ts") ||
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
        "Tests must write only to os.tmpdir() (Pitfall 7 / VALID-03)."
    );
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("attachments.server", () => {
  let sandbox: string;
  let outside: string;

  beforeEach(() => {
    sandbox = mkdtempSync();
    outside = mkdtempSync();
  });

  afterEach(() => {
    rmSync(sandbox);
    rmSync(outside);
  });

  afterAll(() => {
    assertGitClean();
  });

  // -------------------------------------------------------------------------
  // resolveAttachmentsRoot
  // -------------------------------------------------------------------------

  describe("resolveAttachmentsRoot", () => {
    it("throws when ATTACHMENTS_ROOT is unset", () => {
      withAttachmentsRoot(undefined, () => {
        expect(() => resolveAttachmentsRoot()).toThrow(/ATTACHMENTS_ROOT is required/);
      });
    });

    it("throws when ATTACHMENTS_ROOT is empty", () => {
      withAttachmentsRoot("", () => {
        expect(() => resolveAttachmentsRoot()).toThrow(/ATTACHMENTS_ROOT is required/);
      });
    });

    it("throws when ATTACHMENTS_ROOT is whitespace", () => {
      withAttachmentsRoot("   ", () => {
        expect(() => resolveAttachmentsRoot()).toThrow(/ATTACHMENTS_ROOT is required/);
      });
    });

    it("throws when ATTACHMENTS_ROOT is relative", () => {
      withAttachmentsRoot("fixtures/attachments", () => {
        expect(() => resolveAttachmentsRoot()).toThrow(/absolute path/);
      });
    });

    it("returns the path when set to an absolute path", () => {
      withAttachmentsRoot(sandbox, () => {
        expect(resolveAttachmentsRoot()).toBe(sandbox);
      });
    });
  });

  // -------------------------------------------------------------------------
  // assertSafeAttachmentPath - containment
  // -------------------------------------------------------------------------

  describe("assertSafeAttachmentPath - containment", () => {
    it("rejects escape via ..", () => {
      withAttachmentsRoot(sandbox, () => {
        const sub = path.join(sandbox, "sub");
        fs.mkdirSync(sub);
        const escapePath = path.join(sub, "..", "..", "escape.txt");
        expect(() => assertSafeAttachmentPath(escapePath, { forWrite: true })).toThrow(
          /outside the attachments root|traversal/
        );
      });
    });

    it("rejects a symlink inside root pointing outside", () => {
      withAttachmentsRoot(sandbox, () => {
        const outsideTarget = path.join(outside, "target.txt");
        fs.writeFileSync(outsideTarget, "should not be accessed");
        const escapeLink = path.join(sandbox, "escape.txt");
        fs.symlinkSync(outsideTarget, escapeLink);
        expect(() => assertSafeAttachmentPath(escapeLink, { forWrite: true })).toThrow(
          /outside the attachments root/
        );
      });
    });

    it("rejects a symlinked directory inside root pointing outside (intermediate symlink)", () => {
      withAttachmentsRoot(sandbox, () => {
        const linkDir = path.join(sandbox, "linkdir");
        fs.symlinkSync(outside, linkDir);
        const escapedPath = path.join(linkDir, "target.txt");
        expect(() => assertSafeAttachmentPath(escapedPath, { forWrite: true })).toThrow();
      });
    });

    it("handles a symlinked root correctly (resolves root before prefix check)", () => {
      // Simulate the /mnt/c case: root is a symlink, but a path inside it is legit.
      const realRoot = mkdtempSync();
      const symlinkRoot = path.join(sandbox, "symlink-root");
      fs.symlinkSync(realRoot, symlinkRoot);
      try {
        withAttachmentsRoot(symlinkRoot, () => {
          // Create a file inside the real root.
          const targetPath = path.join(realRoot, "test-agent", "mc");
          fs.mkdirSync(targetPath, { recursive: true });
          const filePath = path.join(targetPath, "file.txt");
          fs.writeFileSync(filePath, "test");
          // Access via the symlinked root should be accepted.
          const viaSymlink = path.join(symlinkRoot, "test-agent", "mc", "file.txt");
          const resolved = assertSafeAttachmentPath(viaSymlink, { forWrite: false });
          expect(resolved).toBeTruthy();
        });
      } finally {
        rmSync(realRoot);
      }
    });

    it("accepts a legit in-sandbox path for write", () => {
      withAttachmentsRoot(sandbox, () => {
        const agentDir = path.join(sandbox, "agent", "mc");
        fs.mkdirSync(agentDir, { recursive: true });
        const targetPath = path.join(agentDir, "file.txt");
        const resolved = assertSafeAttachmentPath(targetPath, { forWrite: true });
        expect(resolved.startsWith(sandbox)).toBe(true);
      });
    });

    it("rejects a path outside the sandbox (sibling directory)", () => {
      withAttachmentsRoot(sandbox, () => {
        const outsidePath = path.join(outside, "file.txt");
        expect(() => assertSafeAttachmentPath(outsidePath, { forWrite: true })).toThrow(
          /outside the attachments root/
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Confinement (replaces the .the-vault substring ban, TASK-434)
  // -------------------------------------------------------------------------

  describe("confinement", () => {
    it("rejects a target under the real silo path when the root is elsewhere", () => {
      withAttachmentsRoot(sandbox, () => {
        const target = "/home/you/.the-vault/agents/claude/file.txt";
        expect(() =>
          assertSafeAttachmentPath(target, { forWrite: true })
        ).toThrow();
      });
    });

    it('ALLOWS a root whose path contains ".the-vault" when it is not the real silo', () => {
      // Production-unlock parity with safe-fs: a look-alike root in tmpdir
      // must work now the substring ban is gone.
      const fakeBrainDir = mkdtempSync();
      try {
        const fakeRoot = path.join(fakeBrainDir, ".the-vault", "assets");
        fs.mkdirSync(fakeRoot, { recursive: true });
        withAttachmentsRoot(fakeRoot, () => {
          const target = path.join(fakeRoot, "image.png");
          const resolved = assertSafeAttachmentPath(target, { forWrite: true });
          expect(resolved).toContain(".the-vault");
        });
      } finally {
        rmSync(fakeBrainDir);
      }
    });

    it("rejects a not-yet-existing target escaping via an intermediate symlink", () => {
      withAttachmentsRoot(sandbox, () => {
        const outsideTree = mkdtempSync();
        try {
          const outsideDir = path.join(outsideTree, "agents", "quill", "inbox");
          fs.mkdirSync(outsideDir, { recursive: true });
          const linkPath = path.join(sandbox, "escape-link");
          fs.symlinkSync(outsideDir, linkPath);
          const targetPath = path.join(linkPath, "message.txt");
          expect(() =>
            assertSafeAttachmentPath(targetPath, { forWrite: true })
          ).toThrow(/outside the attachments root|FND-03/);
        } finally {
          rmSync(outsideTree);
        }
      });
    });

    it("rejects serving a symlink whose resolved extension differs (extension swap)", () => {
      // TASK-431 lesson applied to attachments: notes.md -> secrets.env inside
      // the root must not serve .env bytes under the .md policy.
      withAttachmentsRoot(sandbox, () => {
        const realFile = path.join(sandbox, "secrets.env");
        fs.writeFileSync(realFile, "KEY=value", "utf8");
        const link = path.join(sandbox, "notes.md");
        fs.symlinkSync(realFile, link);
        expect(() => readAttachment("notes.md")).toThrow(
          /extension swap|does not match the requested extension/
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Type policy
  // -------------------------------------------------------------------------

  describe("type policy", () => {
    it("accepts png, jpg, jpeg, gif, webp as image class (inline=true)", () => {
      for (const ext of ["png", "jpg", "jpeg", "gif", "webp"]) {
        const policy = policyForExtension(ext);
        expect(policy).toBeDefined();
        expect(policy?.cls).toBe("image");
        expect(policy?.inline).toBe(true);
        expect(policy?.maxBytes).toBe(10 * 1024 * 1024);
      }
    });

    it("accepts md, txt, log, csv, json as text class (inline=false)", () => {
      for (const ext of ["md", "txt", "log", "csv", "json"]) {
        const policy = policyForExtension(ext);
        expect(policy).toBeDefined();
        expect(policy?.cls).toBe("text");
        expect(policy?.inline).toBe(false);
        expect(policy?.maxBytes).toBe(1 * 1024 * 1024);
      }
    });

    it("accepts svg as svg class (inline=false, never inline, download-only disposition)", () => {
      const policy = policyForExtension("svg");
      expect(policy).toBeDefined();
      expect(policy?.cls).toBe("svg");
      expect(policy?.inline).toBe(false);
      expect(policy?.contentType).toBe("application/octet-stream");
    });

    it("accepts xml as a download-only type (octet-stream, svg precedent - 2026-06-12)", () => {
      const policy = policyForExtension("xml");
      expect(policy).toBeDefined();
      expect(policy?.cls).toBe("text");
      expect(policy?.inline).toBe(false);
      expect(policy?.contentType).toBe("application/octet-stream");
      expect(policy?.maxBytes).toBe(1 * 1024 * 1024);
    });

    it("unknown extensions get the download-only default (any-type policy, 2026-06-12)", () => {
      for (const ext of ["exe", "sh", "bat", "php", "js", "ts", "zip", "pdf"]) {
        const policy = policyForExtension(ext);
        expect(policy.cls).toBe("file");
        expect(policy.inline).toBe(false);
        expect(policy.contentType).toBe("application/octet-stream");
        expect(policy.maxBytes).toBe(25 * 1024 * 1024);
      }
    });

    it("saveAttachment accepts a previously-disallowed type as a plain-link download", async () => {
      withAttachmentsRoot(sandbox, () => {});
      process.env["ATTACHMENTS_ROOT"] = sandbox;
      try {
        const result = await saveAttachment("agent", { name: "tool.exe", type: "application/octet-stream", bytes: Buffer.from("x") });
        // Plain link chip (never image markdown) and the bytes stored.
        expect(result.markdown.startsWith("[")).toBe(true);
        expect(fs.existsSync(path.join(sandbox, result.relPath))).toBe(true);
      } finally {
        delete process.env["ATTACHMENTS_ROOT"];
      }
    });

    it("saveAttachment rejects a file exceeding the size cap", async () => {
      process.env["ATTACHMENTS_ROOT"] = sandbox;
      try {
        // 11MB file for an image (cap is 10MB).
        const bigBytes = Buffer.alloc(11 * 1024 * 1024);
        await expect(
          saveAttachment("agent", { name: "big.png", type: "image/png", bytes: bigBytes })
        ).rejects.toThrow(/too large/);
      } finally {
        delete process.env["ATTACHMENTS_ROOT"];
      }
    });

    it("saveAttachment rejects a text file exceeding 1MB", async () => {
      process.env["ATTACHMENTS_ROOT"] = sandbox;
      try {
        const bigBytes = Buffer.alloc(2 * 1024 * 1024);
        await expect(
          saveAttachment("agent", { name: "big.md", type: "text/markdown", bytes: bigBytes })
        ).rejects.toThrow(/too large/);
      } finally {
        delete process.env["ATTACHMENTS_ROOT"];
      }
    });
  });

  // -------------------------------------------------------------------------
  // Filename sanitisation
  // -------------------------------------------------------------------------

  describe("sanitiseFilename", () => {
    it("strips path separators", () => {
      expect(sanitiseFilename("../escape.md")).toBe("escape.md");
      expect(sanitiseFilename("/absolute.txt")).toBe("absolute.txt");
    });

    it("strips control characters", () => {
      expect(sanitiseFilename("file\x00name.txt")).toBe("filename.txt");
    });

    it("collapses whitespace to underscores", () => {
      expect(sanitiseFilename("my file.txt")).toBe("my_file.txt");
    });

    it("lowercases the extension", () => {
      expect(sanitiseFilename("Image.PNG")).toBe("Image.png");
    });

    it("caps base at 80 chars", () => {
      const long = "a".repeat(100) + ".txt";
      const result = sanitiseFilename(long);
      expect(result.length).toBeLessThanOrEqual(80 + 4);
      expect(result.endsWith(".txt")).toBe(true);
    });

    it("handles a name with no extension", () => {
      const result = sanitiseFilename("plainfile");
      expect(result).toBe("plainfile");
    });

    it("strips leading dots", () => {
      expect(sanitiseFilename(".hidden.txt")).toBe("hidden.txt");
    });

    it("returns 'file' for an empty or stripped name", () => {
      expect(sanitiseFilename("")).toBe("file");
      expect(sanitiseFilename("...")).toBe("file");
    });
  });

  // -------------------------------------------------------------------------
  // saveAttachment: naming, round-trip, collision suffix
  // -------------------------------------------------------------------------

  describe("saveAttachment", () => {
    it("saves a png and returns image markdown link", async () => {
      process.env["ATTACHMENTS_ROOT"] = sandbox;
      try {
        const bytes = Buffer.from("PNG_FAKE_DATA");
        const result = await saveAttachment("agent", { name: "photo.png", type: "image/png", bytes });
        expect(result.relPath).toMatch(/agent\/mc\/\d{8}-\d{6}-photo\.png$/);
        expect(result.markdown).toMatch(/^!\[photo\.png\]\(\/attachments\/agent\/mc\//);
        // File exists on disk.
        const filePath = path.join(sandbox, result.relPath);
        expect(fs.existsSync(filePath)).toBe(true);
        expect(fs.readFileSync(filePath)).toEqual(bytes);
      } finally {
        delete process.env["ATTACHMENTS_ROOT"];
      }
    });

    it("saves a .md file and returns plain link markdown", async () => {
      process.env["ATTACHMENTS_ROOT"] = sandbox;
      try {
        const bytes = Buffer.from("# Hello");
        const result = await saveAttachment("agent", { name: "notes.md", type: "text/markdown", bytes });
        expect(result.markdown).toMatch(/^\[notes\.md\]\(\/attachments\/agent\/mc\//);
      } finally {
        delete process.env["ATTACHMENTS_ROOT"];
      }
    });

    it("sanitises the filename in the stored path", async () => {
      process.env["ATTACHMENTS_ROOT"] = sandbox;
      try {
        const bytes = Buffer.from("data");
        const result = await saveAttachment("agent", { name: "my file.txt", type: "text/plain", bytes });
        expect(result.relPath).toContain("my_file.txt");
      } finally {
        delete process.env["ATTACHMENTS_ROOT"];
      }
    });

    it("appends a collision suffix when filename already exists", async () => {
      process.env["ATTACHMENTS_ROOT"] = sandbox;
      try {
        const bytes = Buffer.from("data");
        const agentMcDir = path.join(sandbox, "agent", "mc");
        fs.mkdirSync(agentMcDir, { recursive: true });

        const r1 = await saveAttachment("agent", { name: "file.txt", type: "text/plain", bytes });
        // Simulate collision by saving again within the same second
        // (both get the same timestamp prefix - unlikely in real use but we need to test).
        // We can do this by creating a fake collision file manually.
        // Actually just call saveAttachment again and verify both files exist.
        const r2 = await saveAttachment("agent", { name: "file.txt", type: "text/plain", bytes });
        // Both files must exist (second one gets a suffix).
        expect(fs.existsSync(path.join(sandbox, r1.relPath))).toBe(true);
        expect(fs.existsSync(path.join(sandbox, r2.relPath))).toBe(true);
        // They are different files.
        expect(r1.relPath).not.toBe(r2.relPath);
      } finally {
        delete process.env["ATTACHMENTS_ROOT"];
      }
    });

    it("atomicWriteBuffer leaves no .tmp files", async () => {
      process.env["ATTACHMENTS_ROOT"] = sandbox;
      try {
        const bytes = Buffer.from("binary data");
        await saveAttachment("agent", { name: "data.png", type: "image/png", bytes });
        const agentDir = path.join(sandbox, "agent", "mc");
        const files = fs.readdirSync(agentDir);
        expect(files.some((f) => f.includes(".tmp-"))).toBe(false);
      } finally {
        delete process.env["ATTACHMENTS_ROOT"];
      }
    });
  });

  // -------------------------------------------------------------------------
  // readAttachment
  // -------------------------------------------------------------------------

  describe("readAttachment", () => {
    it("reads a saved attachment and returns correct content-type + disposition", async () => {
      process.env["ATTACHMENTS_ROOT"] = sandbox;
      try {
        const bytes = Buffer.from("PNG_DATA");
        const { relPath } = await saveAttachment("agent", { name: "img.png", type: "image/png", bytes });
        const result = readAttachment(relPath);
        expect(result.bytes).toEqual(bytes);
        expect(result.contentType).toBe("image/png");
        expect(result.disposition).toBe("inline");
      } finally {
        delete process.env["ATTACHMENTS_ROOT"];
      }
    });

    it("returns attachment disposition for .md files", async () => {
      process.env["ATTACHMENTS_ROOT"] = sandbox;
      try {
        const bytes = Buffer.from("# Notes");
        const { relPath } = await saveAttachment("agent", { name: "notes.md", type: "text/markdown", bytes });
        const result = readAttachment(relPath);
        expect(result.disposition).toBe("attachment");
      } finally {
        delete process.env["ATTACHMENTS_ROOT"];
      }
    });

    it("returns attachment disposition + octet-stream for svg", async () => {
      process.env["ATTACHMENTS_ROOT"] = sandbox;
      try {
        const bytes = Buffer.from("<svg></svg>");
        const { relPath } = await saveAttachment("agent", { name: "icon.svg", type: "image/svg+xml", bytes });
        const result = readAttachment(relPath);
        expect(result.contentType).toBe("application/octet-stream");
        expect(result.disposition).toBe("attachment");
      } finally {
        delete process.env["ATTACHMENTS_ROOT"];
      }
    });

    it("throws on a traversal attempt in relPath", () => {
      process.env["ATTACHMENTS_ROOT"] = sandbox;
      try {
        expect(() => readAttachment("../../etc/passwd")).toThrow();
      } finally {
        delete process.env["ATTACHMENTS_ROOT"];
      }
    });

    it("throws when file does not exist (read variant)", () => {
      process.env["ATTACHMENTS_ROOT"] = sandbox;
      try {
        expect(() => readAttachment("agent/mc/nonexistent.png")).toThrow();
      } finally {
        delete process.env["ATTACHMENTS_ROOT"];
      }
    });

    it("rejects a symlink escape on read", () => {
      process.env["ATTACHMENTS_ROOT"] = sandbox;
      try {
        const outsideTarget = path.join(outside, "target.txt");
        fs.writeFileSync(outsideTarget, "secret");
        const agentDir = path.join(sandbox, "agent", "mc");
        fs.mkdirSync(agentDir, { recursive: true });
        const linkName = "escape.txt";
        const linkPath = path.join(agentDir, linkName);
        fs.symlinkSync(outsideTarget, linkPath);
        expect(() => readAttachment(`agent/mc/${linkName}`)).toThrow(
          /outside the attachments root/
        );
      } finally {
        delete process.env["ATTACHMENTS_ROOT"];
      }
    });
  });

  describe("manager review fixes (Atlas fold-ins + agent validation)", () => {
    it("readAttachment serves an unmapped extension as an uninterpreted download (any-type policy, 2026-06-12)", () => {
      process.env["ATTACHMENTS_ROOT"] = sandbox;
      try {
        const agentDir = path.join(sandbox, "agent", "mc");
        fs.mkdirSync(agentDir, { recursive: true });
        // Active content must move as bytes, never render: octet-stream +
        // attachment disposition means the browser downloads, not executes.
        fs.writeFileSync(path.join(agentDir, "page.html"), "<script>boom()</script>");
        const result = readAttachment("agent/mc/page.html");
        expect(result.contentType).toBe("application/octet-stream");
        expect(result.disposition).toBe("attachment");
      } finally {
        delete process.env["ATTACHMENTS_ROOT"];
      }
    });

    it("saveAttachment rejects a traversal-shaped agent name BEFORE any mkdir", async () => {
      process.env["ATTACHMENTS_ROOT"] = sandbox;
      try {
        const bytes = Buffer.from("data");
        await expect(
          saveAttachment("../escape", { name: "a.png", type: "image/png", bytes })
        ).rejects.toThrow(/Invalid agent name/);
        // Nothing was created outside the sandbox root.
        expect(fs.existsSync(path.join(sandbox, "..", "escape"))).toBe(false);
      } finally {
        delete process.env["ATTACHMENTS_ROOT"];
      }
    });

    it("saveAttachment rejects uppercase/dotted agent names", async () => {
      process.env["ATTACHMENTS_ROOT"] = sandbox;
      try {
        const bytes = Buffer.from("data");
        await expect(
          saveAttachment("Agent.Name", { name: "a.png", type: "image/png", bytes })
        ).rejects.toThrow(/Invalid agent name/);
      } finally {
        delete process.env["ATTACHMENTS_ROOT"];
      }
    });
  });

});
