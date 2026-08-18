/**
 * review-autolink.test.ts - TASK-645 auto-linkify of bare / backticked review
 * paths at render time.
 *
 * Covers autoLinkifyReviewPaths + resolveReviewablePath (the pure functions)
 * AND linkifyBlockBodies over REAL windowed block data read through the seam
 * (FileInboxRepository.readBlocksWindow), proving the loader-side wiring.
 *
 * Design choices under test (documented in review.server.ts):
 *   - Extension scope is REVIEW_MD_EXTS ONLY (.md/.txt/.markdown). A bare .ts
 *     or .png path is left plain (doc-scoped feature).
 *   - A backticked path that is exactly one reviewable path has its backticks
 *     REPLACED by the link.
 *   - A path outside every review root is left completely unchanged (never
 *     widen REVIEW_ROOTS, never guess).
 *   - Misconfigured / unset REVIEW_ROOTS degrades to unchanged text, no throw.
 *
 * Isolated mkdtemp dirs; MC_SANDBOX_ONLY is set globally by test/setup.ts.
 * ASCII only - no em-dashes (FND-05).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  autoLinkifyReviewPaths,
  resolveReviewablePath,
  linkifyBlockBodies,
} from "~/lib/review.server";
import { FileInboxRepository } from "~/lib/inbox.server";
import { isReviewablePath } from "~/lib/review-exts";
import type { MessageBlock } from "~/lib/blocks/model";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

// ---------------------------------------------------------------------------
// Env harness
// ---------------------------------------------------------------------------

type EnvSnapshot = { REVIEW_ROOTS?: string; INBOX_ROOT?: string };

function saveEnv(): EnvSnapshot {
  return {
    REVIEW_ROOTS: process.env["REVIEW_ROOTS"],
    INBOX_ROOT: process.env["INBOX_ROOT"],
  };
}

function restoreEnv(saved: EnvSnapshot): void {
  for (const key of ["REVIEW_ROOTS", "INBOX_ROOT"] as const) {
    const v = saved[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
}

// ---------------------------------------------------------------------------
// Suite: pure functions
// ---------------------------------------------------------------------------

describe("autoLinkifyReviewPaths (TASK-645)", () => {
  let root: string; // review root (also holds nothing but the doc under test)
  let inboxRoot: string; // implicit review root appended by resolveReviewRoots
  let outsideRoot: string; // a dir that is NOT a review root
  let saved: EnvSnapshot;

  beforeEach(() => {
    saved = saveEnv();
    root = mkdtempSync();
    inboxRoot = mkdtempSync();
    outsideRoot = mkdtempSync();
    process.env["REVIEW_ROOTS"] = root;
    process.env["INBOX_ROOT"] = inboxRoot;
  });

  afterEach(() => {
    restoreEnv(saved);
    rmSync(root);
    rmSync(inboxRoot);
    rmSync(outsideRoot);
  });

  /** Write a file under a dir and return its absolute path. */
  function writeFile(dir: string, name: string, content = "hi"): string {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
    return p;
  }

  it("bare absolute doc path under a review root becomes [basename](/abs)", () => {
    const abs = writeFile(root, "report-2026-07-07.md");
    const out = autoLinkifyReviewPaths(`See ${abs} for details.`);
    expect(out).toBe(`See [report-2026-07-07.md](${abs}) for details.`);
  });

  it("bare path at start of line and end of string is linkified", () => {
    const abs = writeFile(root, "notes.txt");
    expect(autoLinkifyReviewPaths(abs)).toBe(`[notes.txt](${abs})`);
    expect(autoLinkifyReviewPaths(`${abs}\nmore`)).toBe(`[notes.txt](${abs})\nmore`);
  });

  it("bare path followed by a sentence period keeps the period outside the link", () => {
    const abs = writeFile(root, "plan.md");
    const out = autoLinkifyReviewPaths(`Read ${abs}.`);
    expect(out).toBe(`Read [plan.md](${abs}).`);
  });

  it("bare path with a non-doc dot-suffix (e.g. .md.bak) is not truncated to a shorter real file", () => {
    // Regression for a peer-review catch: the greedy path-body star could
    // backtrack past a real extension boundary and complete a match on an
    // EARLIER ".md", silently dropping the ".bak" suffix and linking to a
    // different (shorter) file than the one actually named in the text.
    const shorter = writeFile(root, "report.md");
    const longerPath = `${shorter}.bak`;
    const body = `See ${longerPath} for the backup.`;
    const out = autoLinkifyReviewPaths(body);
    // Neither truncated-and-linked nor mis-linked to the shorter file: since
    // "report.md.bak" itself has no recognised doc extension, the whole
    // candidate is left as plain text.
    expect(out).toBe(body);
    expect(out).not.toContain(`[report.md](${shorter})`);
  });

  it("backticked path under a review root becomes a link (backticks removed)", () => {
    const abs = writeFile(root, "dana.md");
    const out = autoLinkifyReviewPaths(`Here: \`${abs}\` ok`);
    expect(out).toBe(`Here: [dana.md](${abs}) ok`);
  });

  it("backticked span with surrounding text is left verbatim", () => {
    const abs = writeFile(root, "buried.md");
    const body = `\`see ${abs} here\``;
    expect(autoLinkifyReviewPaths(body)).toBe(body);
  });

  it("bare path NOT under any review root is left unchanged", () => {
    const abs = writeFile(outsideRoot, "secret-plan.md");
    const body = `Check ${abs} please.`;
    expect(autoLinkifyReviewPaths(body)).toBe(body);
  });

  it("a path already inside markdown link syntax is not double-processed", () => {
    const abs = writeFile(root, "linked.md");
    const body = `Already a [my doc](${abs}) link.`;
    expect(autoLinkifyReviewPaths(body)).toBe(body);
  });

  it("bare image extension (.png, not in REVIEW_DOC_EXTS) under a root is left unchanged", () => {
    const png = writeFile(root, "diagram.png");
    const body = `Image ${png} here.`;
    expect(autoLinkifyReviewPaths(body)).toBe(body);
  });

  it("bare code extension (.ts, in REVIEW_DOC_EXTS) under a root IS linkified", () => {
    // Widened 2026-07-20 per Alex: the panel already fully supports opening
    // code files via real links, so code paths are now in scope too, only
    // images stay excluded (no standalone open path exists for them).
    const ts = writeFile(root, "module.ts");
    const body = `See code ${ts} here.`;
    expect(autoLinkifyReviewPaths(body)).toBe(`See code [module.ts](${ts}) here.`);
  });

  it("a secret-basename doc under a root is left unchanged", () => {
    // .env.production has a non-doc ext anyway, but a *.md that hits the secret
    // denylist would be refused too. Use a config secret proven by isSecretBasename.
    const abs = writeFile(root, "credentials.md");
    // credentials.md is NOT a config ext (.md), so it is allowed - assert the
    // POSITIVE control here, and the negative below via .env.
    const out = autoLinkifyReviewPaths(`x ${abs} y`);
    expect(out).toBe(`x [credentials.md](${abs}) y`);
  });

  it("a non-existent path under a root is left unchanged (never linkify a dead path)", () => {
    const abs = path.join(root, "does-not-exist.md");
    const body = `Ghost ${abs} here.`;
    expect(autoLinkifyReviewPaths(body)).toBe(body);
  });

  it("multiple candidates, mixed valid/invalid, each handled independently", () => {
    const good = writeFile(root, "good.md");
    const outside = writeFile(outsideRoot, "outside.md");
    const png = writeFile(root, "pic.png");
    const body = `A ${good} B ${outside} C ${png} D`;
    const out = autoLinkifyReviewPaths(body);
    expect(out).toBe(`A [good.md](${good}) B ${outside} C ${png} D`);
  });

  it("a tilde (~/) path under a review root resolves via expandTilde", () => {
    const homeDir = fs.mkdtempSync(path.join(os.homedir(), ".mc-autolink-"));
    try {
      const rel = path.basename(homeDir);
      process.env["REVIEW_ROOTS"] = homeDir;
      const abs = path.join(homeDir, "home-doc.md");
      fs.writeFileSync(abs, "hi", "utf8");
      const out = autoLinkifyReviewPaths(`See ~/${rel}/home-doc.md now`);
      // Emitted destination is the resolved absolute path.
      const resolvedAbs = fs.realpathSync(abs);
      expect(out).toBe(`See [home-doc.md](${resolvedAbs}) now`);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not linkify inside a fenced code block", () => {
    const abs = writeFile(root, "fenced.md");
    const body = "```\n" + abs + "\n```";
    expect(autoLinkifyReviewPaths(body)).toBe(body);
  });

  it("a relative path (no leading slash) is never matched", () => {
    // Even if a same-named file exists under the root, "home/x.md" is relative
    // and ambiguous - left plain.
    writeFile(root, "x.md");
    const body = "edit home/x.md now";
    expect(autoLinkifyReviewPaths(body)).toBe(body);
  });

  it("misconfigured REVIEW_ROOTS (non-absolute entry) degrades to unchanged, no throw", () => {
    process.env["REVIEW_ROOTS"] = "relative/not/absolute";
    const body = "path /whatever/foo.md here";
    expect(() => autoLinkifyReviewPaths(body)).not.toThrow();
    expect(autoLinkifyReviewPaths(body)).toBe(body);
  });

  it("unset REVIEW_ROOTS + unset INBOX_ROOT degrades to unchanged, no throw", () => {
    delete process.env["REVIEW_ROOTS"];
    delete process.env["INBOX_ROOT"];
    const body = "path /whatever/foo.md here";
    expect(() => autoLinkifyReviewPaths(body)).not.toThrow();
    expect(autoLinkifyReviewPaths(body)).toBe(body);
  });

  it("the emitted href satisfies the client isReviewablePath predicate (cross-module contract)", () => {
    // Load-bearing: Markdown.tsx renders a panel-opening button ONLY when
    // isReviewablePath(href) is true. If the emitted destination ever diverged
    // from that predicate, the link would render as a dead new-tab anchor while
    // every string assertion above still passed. Guard the contract directly.
    const abs = writeFile(root, "contract.md");
    const resolved = resolveReviewablePath(abs)!;
    expect(resolved).not.toBeNull();
    expect(isReviewablePath(resolved)).toBe(true);
    // And prove it end-to-end: extract the href from the emitted link.
    const out = autoLinkifyReviewPaths(`x ${abs} y`);
    const href = out.match(/\]\(([^)]+)\)/)![1]!;
    expect(isReviewablePath(href)).toBe(true);
  });

  it("resolveReviewablePath returns the resolved abs path for a contained doc or code file, null otherwise", () => {
    const abs = writeFile(root, "r.md");
    expect(resolveReviewablePath(abs)).toBe(fs.realpathSync(abs));
    expect(resolveReviewablePath(path.join(outsideRoot, "r.md"))).toBeNull();
    expect(resolveReviewablePath("relative/r.md")).toBeNull();
    const ts = writeFile(root, "c.ts");
    expect(resolveReviewablePath(ts)).toBe(fs.realpathSync(ts)); // code ext, in scope
    expect(resolveReviewablePath(writeFile(root, "d.png"))).toBeNull(); // image, out of scope
  });
});

// ---------------------------------------------------------------------------
// Suite: integration through the seam (real windowed block data)
// ---------------------------------------------------------------------------

describe("linkifyBlockBodies over real readBlocksWindow data (TASK-645)", () => {
  let sandbox: string; // INBOX_ROOT
  let reviewRoot: string; // REVIEW_ROOTS
  let repo: FileInboxRepository;
  let saved: EnvSnapshot;

  function seed(agent: string, participant: string, content: string) {
    const dir = path.join(sandbox, agent, "inbox");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${participant}.md`), content, "utf8");
  }

  beforeEach(() => {
    saved = saveEnv();
    sandbox = mkdtempSync();
    reviewRoot = mkdtempSync();
    process.env["INBOX_ROOT"] = sandbox;
    process.env["REVIEW_ROOTS"] = reviewRoot;
    repo = new FileInboxRepository(sandbox);
  });

  afterEach(() => {
    restoreEnv(saved);
    rmSync(sandbox);
    rmSync(reviewRoot);
  });

  it("rewrites a bare review-root path in a real windowed block body", async () => {
    const docAbs = path.join(reviewRoot, "shared-report.md");
    fs.writeFileSync(docAbs, "# report", "utf8");

    const body = `Please read ${docAbs} before the call.`;
    const thread =
      `## 2026-07-07T10:00:00Z - from: echo - status: read - subject: report\n\n${body}\n\n---\n`;
    seed("quill", "alex", thread);

    const { blocks } = await repo.readBlocksWindow("quill", "alex", {});
    expect(blocks.length).toBe(1);
    // Raw block body (through the seam) still has the bare path.
    expect(blocks[0]!.body).toContain(docAbs);
    expect(blocks[0]!.body).not.toContain("](");

    const linked = linkifyBlockBodies(blocks);
    expect(linked[0]!.body).toBe(
      `Please read [shared-report.md](${docAbs}) before the call.`
    );
    // rawMeta / rawBlock are preserved verbatim (card parsing + round-trip).
    expect(linked[0]!.rawMeta).toBe(blocks[0]!.rawMeta);
    expect(linked[0]!.rawBlock).toBe(blocks[0]!.rawBlock);
  });

  it("leaves an out-of-root path in a real block body unchanged", async () => {
    // A path under the inbox sandbox but not the review root, and not existing.
    const body = "ref /home/you/private/notes.md here";
    const thread =
      `## 2026-07-07T10:00:00Z - from: quill - status: read - subject: x\n\n${body}\n\n---\n`;
    seed("quill", "alex", thread);

    const { blocks } = await repo.readBlocksWindow("quill", "alex", {});
    const linked = linkifyBlockBodies(blocks);
    expect(linked[0]!.body).toBe(body);
  });

  it("linkifyBlockBodies never throws and returns input when misconfigured", () => {
    const blocks: MessageBlock[] = [
      {
        header: { timestamp: "t", from: "quill", status: "read", subject: "s" },
        body: "path /x/y.md here",
        rawMeta: "",
      },
    ];
    process.env["REVIEW_ROOTS"] = "relative/bad";
    expect(() => linkifyBlockBodies(blocks)).not.toThrow();
    expect(linkifyBlockBodies(blocks)[0]!.body).toBe("path /x/y.md here");
  });

  it("leaves bodies untouched when the review roots name a live silo (fails closed)", () => {
    // The autolink pass swallows every error by design, so the MC_SANDBOX_ONLY
    // live-silo refusal surfaces here as "no links", not as a throw. That is the
    // right direction: a configuration the review surface has refused must not
    // hand back clickable links into the silo it refused, and a render path is
    // no place to start throwing.
    const silo = mkdtempSync();
    const savedSilo = process.env["MC_LIVE_SILO_ROOT"];
    try {
      const doc = path.join(silo, "private.md");
      fs.writeFileSync(doc, "# private", "utf8");
      const body = `see ${doc} now`;
      const blocks: MessageBlock[] = [
        {
          header: { timestamp: "t", from: "quill", status: "read", subject: "s" },
          body,
          rawMeta: "",
        },
      ];

      process.env["MC_LIVE_SILO_ROOT"] = silo;
      process.env["REVIEW_ROOTS"] = silo;

      expect(() => linkifyBlockBodies(blocks)).not.toThrow();
      expect(linkifyBlockBodies(blocks)[0]!.body).toBe(body);
    } finally {
      if (savedSilo === undefined) {
        delete process.env["MC_LIVE_SILO_ROOT"];
      } else {
        process.env["MC_LIVE_SILO_ROOT"] = savedSilo;
      }
      rmSync(silo);
    }
  });

  it("shares root resolution + the candidate cache across blocks in one call (CR perf catch)", () => {
    // Regression for a peer-review-style catch: root resolution and the
    // resolveReviewablePath cache used to be allocated fresh PER BLOCK
    // (autoLinkifyReviewPaths called with no shared state), so the same doc
    // mentioned across N blocks paid N x the fs.realpathSync containment cost
    // instead of once per request. linkifyBlockBodies now hoists both.
    const docAbs = path.join(reviewRoot, "shared.md");
    fs.writeFileSync(docAbs, "# shared", "utf8");

    const block = (i: number): MessageBlock => ({
      header: { timestamp: `t${i}`, from: "quill", status: "read", subject: "s" },
      body: `See ${docAbs} for context (${i}).`,
      rawMeta: "",
    });

    function measure(blocks: MessageBlock[]): { calls: number; linked: MessageBlock[] } {
      const realpathSpy = vi.spyOn(fs, "realpathSync");
      try {
        const linked = linkifyBlockBodies(blocks);
        return { calls: realpathSpy.mock.calls.length, linked };
      } finally {
        realpathSpy.mockRestore();
      }
    }

    const three = measure([1, 2, 3].map(block));
    const six = measure([1, 2, 3, 4, 5, 6].map(block));

    // Every block correctly linked...
    for (const b of [...three.linked, ...six.linked]) {
      expect(b.body).toContain(`[shared.md](${docAbs})`);
    }

    // ...and DOUBLING the blocks costs exactly nothing. That equality is the
    // property this test exists for, stated directly rather than as a constant:
    // everything linkifyBlockBodies pays for is per CALL, and nothing is per
    // block. Before the sharing, assertContained's realpath work (root +
    // parentDir + final component) ran once per block, so six blocks cost twice
    // what three did.
    //
    // Measuring the difference rather than an absolute count is also what keeps
    // this honest across the fix to the live-silo vetting. That vetting is
    // deliberately NOT memoised across calls while MC_SANDBOX_ONLY is set (see
    // review.server.ts: a pass depends on filesystem state, so a cached one is
    // a bypass), and test/setup.ts sets the flag, so its cost is now inside the
    // measured window. It is a per-CALL cost, which is the granularity the
    // reviewer signed off on, and this comparison proves that is what it is.
    expect(six.calls).toBe(three.calls);

    // A bound too, so a per-call cost cannot balloon unnoticed. 8 = the vetting
    // (2 roots, each realpath'd and then compared against a realpath'd silo)
    // plus assertContained's 4 (2 roots + parentDir + final component), paid
    // once for the one distinct candidate. Without the sharing, the second half
    // alone would be 4 per block.
    expect(three.calls).toBeLessThanOrEqual(8);
  });
});
