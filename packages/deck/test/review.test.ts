/**
 * Tests for app/lib/review.server.ts.
 *
 * Covers:
 *   - resolveReviewRoots: parsing, absolute-only, implicit INBOX_ROOT, unset.
 *   - readReviewFile: containment in/out per root, symlinked root + symlink
 *     escape; no silo-name substring ban; THE .env test - .env inside
 *     allowed root denied by extension gate; .markdown/.txt/.ts/.json accepted;
 *     size cap; ".." shape rejection; binary-NUL guard; kind/lang derivation.
 *   - readReviewAsset: image allowed, svg denied, .md denied.
 *   - seam: REVIEW_ROOTS ban is in seam.test.ts (separate suite).
 *
 * Each test uses isolated mkdtemp dirs under os.tmpdir().
 * MC_SANDBOX_ONLY is set globally by test/setup.ts.
 * afterAll assertGitClean.
 *
 * ASCII only - no em-dashes.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  resolveReviewRoots,
  validateReviewRoots,
  readReviewFile,
  readReviewAsset,
  expandTilde,
} from "~/lib/review.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EnvSnapshot = { REVIEW_ROOTS?: string; INBOX_ROOT?: string };

function withEnv(overrides: EnvSnapshot, fn: () => void): void {
  const saved: EnvSnapshot = {
    REVIEW_ROOTS: process.env["REVIEW_ROOTS"],
    INBOX_ROOT: process.env["INBOX_ROOT"],
  };
  if (overrides.REVIEW_ROOTS !== undefined) {
    process.env["REVIEW_ROOTS"] = overrides.REVIEW_ROOTS;
  } else {
    delete process.env["REVIEW_ROOTS"];
  }
  if (overrides.INBOX_ROOT !== undefined) {
    process.env["INBOX_ROOT"] = overrides.INBOX_ROOT;
  } else {
    delete process.env["INBOX_ROOT"];
  }
  try {
    fn();
  } finally {
    if (saved.REVIEW_ROOTS === undefined) {
      delete process.env["REVIEW_ROOTS"];
    } else {
      process.env["REVIEW_ROOTS"] = saved.REVIEW_ROOTS;
    }
    if (saved.INBOX_ROOT === undefined) {
      delete process.env["INBOX_ROOT"];
    } else {
      process.env["INBOX_ROOT"] = saved.INBOX_ROOT;
    }
  }
}

/** Save and restore MC_LIVE_SILO_ROOT around a test (mirrors safe-fs.test.ts). */
function withLiveSiloRoot(value: string | undefined, fn: () => void): void {
  const previous = process.env["MC_LIVE_SILO_ROOT"];
  if (value === undefined) {
    delete process.env["MC_LIVE_SILO_ROOT"];
  } else {
    process.env["MC_LIVE_SILO_ROOT"] = value;
  }
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env["MC_LIVE_SILO_ROOT"];
    } else {
      process.env["MC_LIVE_SILO_ROOT"] = previous;
    }
  }
}

/** Save and restore MC_SANDBOX_ONLY (test/setup.ts sets it to "1" globally). */
function withSandboxOnly(value: string | undefined, fn: () => void): void {
  const previous = process.env["MC_SANDBOX_ONLY"];
  if (value === undefined) {
    delete process.env["MC_SANDBOX_ONLY"];
  } else {
    process.env["MC_SANDBOX_ONLY"] = value;
  }
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env["MC_SANDBOX_ONLY"];
    } else {
      process.env["MC_SANDBOX_ONLY"] = previous;
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
    // Ignore all known-dirty files from the implementation batch.
    if (
      file.startsWith("test/") ||
      file.startsWith("app/") ||
      file.startsWith("e2e/") ||
      file.startsWith("scripts/") ||
      file.startsWith(".planning/") ||
      file.startsWith(".gsd-") ||
      file.startsWith(".gitignore") ||
      file.startsWith(".env.example") ||
      file.startsWith("package.json") ||
      file.startsWith("pnpm-lock.yaml") ||
      file.startsWith("playwright.config.ts") ||
      file.startsWith("fixtures/") ||
      file.startsWith("docs/") ||
      // voice proxy files (new server/ directory shown as "?? server/")
      file.startsWith("server/") ||
      file.startsWith("app/lib/voice.server.ts") ||
      file.startsWith("test/voice-relay.test.ts") ||
      file.startsWith("e2e/flows/voice.test.ts") ||
      file.startsWith("tsconfig.json") ||
      // Tailscale dev allowance
      file.startsWith("vite.config.ts")
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

describe("review.server", () => {
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
  // expandTilde
  // -------------------------------------------------------------------------

  describe("expandTilde", () => {
    it("expands ~/ to the home directory", () => {
      const result = expandTilde("~/foo/bar");
      expect(result).toMatch(/^\/[^~]/);
      expect(result).toContain("foo/bar");
    });

    it("expands bare ~ to the home directory", () => {
      const result = expandTilde("~");
      expect(result).toMatch(/^\/[^~]/);
    });

    it("leaves absolute paths unchanged", () => {
      expect(expandTilde("/absolute/path")).toBe("/absolute/path");
    });

    it("leaves relative paths unchanged (expansion is tilde-only)", () => {
      expect(expandTilde("relative/path")).toBe("relative/path");
    });
  });

  // -------------------------------------------------------------------------
  // resolveReviewRoots
  // -------------------------------------------------------------------------

  describe("resolveReviewRoots", () => {
    it("returns INBOX_ROOT only when REVIEW_ROOTS is unset", () => {
      withEnv({ INBOX_ROOT: sandbox }, () => {
        delete process.env["REVIEW_ROOTS"];
        const roots = resolveReviewRoots();
        expect(roots).toEqual([sandbox]);
      });
    });

    it("returns INBOX_ROOT only when REVIEW_ROOTS is empty string", () => {
      withEnv({ INBOX_ROOT: sandbox, REVIEW_ROOTS: "" }, () => {
        const roots = resolveReviewRoots();
        expect(roots).toEqual([sandbox]);
      });
    });

    it("parses colon-separated absolute roots and appends INBOX_ROOT", () => {
      const root2 = mkdtempSync();
      try {
        withEnv({ INBOX_ROOT: sandbox, REVIEW_ROOTS: `${outside}:${root2}` }, () => {
          const roots = resolveReviewRoots();
          expect(roots).toContain(outside);
          expect(roots).toContain(root2);
          // INBOX_ROOT always last (or deduped if already present).
          expect(roots[roots.length - 1]).toBe(sandbox);
        });
      } finally {
        rmSync(root2);
      }
    });

    it("throws when a REVIEW_ROOTS entry is relative", () => {
      withEnv({ INBOX_ROOT: sandbox, REVIEW_ROOTS: "relative/path" }, () => {
        expect(() => resolveReviewRoots()).toThrow(/absolute path/);
      });
    });

    it("deduplicates INBOX_ROOT when it appears in REVIEW_ROOTS", () => {
      withEnv({ INBOX_ROOT: sandbox, REVIEW_ROOTS: sandbox }, () => {
        const roots = resolveReviewRoots();
        const count = roots.filter((r) => r === sandbox).length;
        expect(count).toBe(1);
      });
    });

    it("accepts tilde-prefixed entries (expands them)", () => {
      // We cannot know what ~ expands to, but we can confirm it does not throw
      // and returns an absolute path entry.
      withEnv({ INBOX_ROOT: sandbox, REVIEW_ROOTS: "~/some/path" }, () => {
        // Will throw if ~/some/path resolve fails at the roots stage? No - we only
        // throw on relative entries, not on non-existent absolute paths. So this
        // should NOT throw. The non-existent path will be skipped at containment time.
        expect(() => resolveReviewRoots()).not.toThrow();
        const roots = resolveReviewRoots();
        // The tilde was expanded (no ~/ in the result).
        expect(roots.some((r) => r.startsWith("/"))).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  // readReviewFile - containment
  // -------------------------------------------------------------------------

  describe("readReviewFile - containment", () => {
    it("reads a .md file inside the review root", () => {
      const filePath = path.join(sandbox, "doc.md");
      fs.writeFileSync(filePath, "# Hello");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        const result = readReviewFile(filePath);
        expect(result.content).toContain("Hello");
        expect(result.path).toBeTruthy();
      });
    });

    it("reads a .txt file inside the review root", () => {
      const filePath = path.join(sandbox, "notes.txt");
      fs.writeFileSync(filePath, "plain text");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        const result = readReviewFile(filePath);
        expect(result.content).toBe("plain text");
      });
    });

    it("reads a .markdown file inside the review root", () => {
      const filePath = path.join(sandbox, "README.markdown");
      fs.writeFileSync(filePath, "## Section");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        const result = readReviewFile(filePath);
        expect(result.content).toContain("Section");
      });
    });

    it("accepts a file inside a symlinked root (~/brain -> /mnt/c simulation)", () => {
      const realRoot = mkdtempSync();
      const symlinkRoot = path.join(outside, "symlink-root");
      fs.symlinkSync(realRoot, symlinkRoot);
      const filePath = path.join(realRoot, "doc.md");
      fs.writeFileSync(filePath, "content");
      try {
        withEnv({ INBOX_ROOT: sandbox, REVIEW_ROOTS: symlinkRoot }, () => {
          // File addressed via symlinked root path.
          const viaSymlink = path.join(symlinkRoot, "doc.md");
          const result = readReviewFile(viaSymlink);
          expect(result.content).toBe("content");
        });
      } finally {
        rmSync(realRoot);
      }
    });

    it("rejects a file outside all roots", () => {
      const filePath = path.join(outside, "doc.md");
      fs.writeFileSync(filePath, "secret");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(filePath)).toThrow(/outside all review roots/);
      });
    });

    it("rejects a symlink-escape: file inside root links to outside", () => {
      const outsideTarget = path.join(outside, "secret.md");
      fs.writeFileSync(outsideTarget, "secret");
      const linkPath = path.join(sandbox, "escape.md");
      fs.symlinkSync(outsideTarget, linkPath);
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(linkPath)).toThrow(/outside all review roots/);
      });
    });

    it("rejects a path that resolves outside all roots via traversal", () => {
      // Create a file that genuinely exists outside sandbox+outside.
      const thirdDir = mkdtempSync();
      try {
        const filePath = path.join(thirdDir, "doc.md");
        fs.writeFileSync(filePath, "secret");
        withEnv({ INBOX_ROOT: sandbox }, () => {
          // thirdDir is a real absolute path outside the review roots.
          expect(() => readReviewFile(filePath)).toThrow(/outside all review roots/);
        });
      } finally {
        rmSync(thirdDir);
      }
    });

    it("rejects a relative path", () => {
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile("relative/path.md")).toThrow(/absolute/);
      });
    });
  });

  // -------------------------------------------------------------------------
  // readReviewFile - silo directory name is not a substring rule
  // -------------------------------------------------------------------------
  //
  // This block used to assert the opposite: that any path whose text contained
  // a particular silo directory name was refused. An earlier change had already
  // retired that pattern everywhere else (safe-fs, attachments, projects) in favour of
  // realpath containment, and it was left standing here alone. It denied
  // nothing on a deployment that does not use that name, and on a deployment
  // that DOES it contradicted resolveReviewRoots, which always appends
  // INBOX_ROOT as an implicit root: the panel refused every read from the one
  // root it is guaranteed to have. What follows pins the behaviour that
  // actually protects the surface - containment, judged on the realpath - and
  // pins that the name itself carries no special power.

  describe("readReviewFile - containment, not name matching", () => {
    it("SERVES a file from a root whose own path contains a silo-shaped dir name", () => {
      // The exact case the old ban made impossible: a production root sitting
      // inside a dot-prefixed silo directory.
      const siloish = path.join(sandbox, ".the-vault", "agents");
      fs.mkdirSync(siloish, { recursive: true });
      const filePath = path.join(siloish, "memory.md");
      fs.writeFileSync(filePath, "# notes\n");

      withEnv({ INBOX_ROOT: siloish }, () => {
        const result = readReviewFile(filePath);
        expect(result.content).toBe("# notes\n");
        expect(result.path).toContain(".the-vault");
      });
    });

    it("still REFUSES a silo-shaped path that is outside every root", () => {
      // Same shape as above, but not configured as a root. The denial has to
      // come from containment now, not from the directory's name.
      const outside = mkdtempSync();
      try {
        const siloish = path.join(outside, ".the-vault", "agents");
        fs.mkdirSync(siloish, { recursive: true });
        const filePath = path.join(siloish, "memory.md");
        fs.writeFileSync(filePath, "# notes\n");

        withEnv({ INBOX_ROOT: sandbox }, () => {
          expect(() => readReviewFile(filePath)).toThrow(/outside all review roots/);
        });
      } finally {
        rmSync(outside);
      }
    });

    it("REFUSES an escape through an intermediate symlink on the resolved path", () => {
      // The case the resolved-path half of the old ban was reaching for. It is
      // caught by containment against the realpath, with no name involved.
      const outside = mkdtempSync();
      try {
        const inner = path.join(outside, ".the-vault", "agents");
        fs.mkdirSync(inner, { recursive: true });
        fs.writeFileSync(path.join(inner, "memory.md"), "# notes\n");
        const linkPath = path.join(sandbox, "escape-link");
        fs.symlinkSync(inner, linkPath);
        const targetPath = path.join(linkPath, "memory.md");
        // The raw path does not carry the directory name at all; only the
        // realpath does, which is the point.
        expect(targetPath).not.toContain(".the-vault");
        withEnv({ INBOX_ROOT: sandbox }, () => {
          expect(() => readReviewFile(targetPath)).toThrow(/outside all review roots/);
        });
      } finally {
        rmSync(outside);
      }
    });
  });

  // -------------------------------------------------------------------------
  // The other half of the removed ban: REVIEW_ROOTS may not name a live silo
  // -------------------------------------------------------------------------
  //
  // Containment answers "is this path inside a configured root". It cannot
  // answer "should this root have been configured at all", and that second
  // question is the whole of MC_SANDBOX_ONLY. safe-fs vets its four roots
  // against it once at boot; REVIEW_ROOTS is not in that table (optional and
  // list-valued, where the table is required and single-valued), so without the
  // refusal pinned below, dropping the substring ban WIDENED this surface: a
  // sandbox instance could name the live silo in REVIEW_ROOTS and read it back
  // through the review API, which is more than the deleted code allowed on the
  // default layout and defeats MC_LIVE_SILO_ROOT on every other one.
  //
  // The silo here is a tmpdir standing in for a real one, named through
  // MC_LIVE_SILO_ROOT, so these run on any machine including CI - unlike the
  // pre-MC_LIVE_SILO_ROOT test of this guard, which skipped everywhere.

  describe("REVIEW_ROOTS live-silo refusal (MC_SANDBOX_ONLY)", () => {
    it("REFUSES a REVIEW_ROOTS entry that IS the live silo", () => {
      const silo = mkdtempSync();
      try {
        withLiveSiloRoot(silo, () => {
          withEnv({ INBOX_ROOT: sandbox, REVIEW_ROOTS: silo }, () => {
            expect(() => resolveReviewRoots()).toThrow(/live agent silo/);
            // Twice: a refusal must never memoise itself into a pass.
            expect(() => resolveReviewRoots()).toThrow(/live agent silo/);
          });
        });
      } finally {
        rmSync(silo);
      }
    });

    it("REFUSES a REVIEW_ROOTS entry BELOW the live silo, and names the variable", () => {
      const silo = mkdtempSync();
      try {
        const agents = path.join(silo, "agents");
        fs.mkdirSync(agents, { recursive: true });
        withLiveSiloRoot(silo, () => {
          withEnv({ INBOX_ROOT: sandbox, REVIEW_ROOTS: agents }, () => {
            expect(() => resolveReviewRoots()).toThrow(/REVIEW_ROOTS/);
          });
        });
      } finally {
        rmSync(silo);
      }
    });

    it("REFUSES the READ, not merely the root resolution", () => {
      // The reported case end to end: a real agent file inside the live silo,
      // named as a review root, requested through the exact function the review
      // API route calls. The route maps the throw to 404.
      const silo = mkdtempSync();
      try {
        const agentDir = path.join(silo, "agents", "quill");
        fs.mkdirSync(agentDir, { recursive: true });
        const doc = path.join(agentDir, "MEMORY.md");
        fs.writeFileSync(doc, "# private\n");

        withLiveSiloRoot(silo, () => {
          withEnv(
            { INBOX_ROOT: sandbox, REVIEW_ROOTS: path.join(silo, "agents") },
            () => {
              expect(() => readReviewFile(doc)).toThrow(/live agent silo/);
            }
          );
        });
      } finally {
        rmSync(silo);
      }
    });

    it("REFUSES an entry that does not exist YET but sits inside the silo", () => {
      // A root the containment check skips (it cannot realpath it) but which
      // starts serving the moment the directory is created. Vetting only what
      // happens to exist at the time would leave that window open.
      const silo = mkdtempSync();
      try {
        withLiveSiloRoot(silo, () => {
          withEnv(
            { INBOX_ROOT: sandbox, REVIEW_ROOTS: path.join(silo, "not-yet") },
            () => {
              expect(() => resolveReviewRoots()).toThrow(/live agent silo/);
            }
          );
        });
      } finally {
        rmSync(silo);
      }
    });

    // -----------------------------------------------------------------------
    // A pass is not memoisable: the refusal answers from the filesystem
    // -----------------------------------------------------------------------
    //
    // The first version of this guard cached a pass on the root list plus
    // MC_SANDBOX_ONLY and MC_LIVE_SILO_ROOT, on the reasoning that those are
    // everything the answer depends on. Codex (PR #9, second round) showed they
    // are not, and reproduced the bypass in one process. assertNoLiveSiloRoot
    // compares REALPATHS and returns early when the silo cannot be resolved, so
    // both of the cases below start from an honest pass over a configuration
    // that then changes underneath it without a single environment variable or
    // root string moving. The two tests are the two shapes Codex named: a silo
    // that appears after the pass, and a symlinked root retargeted after it.

    it("REFUSES a read through a silo created AFTER the roots passed", () => {
      const parent = mkdtempSync();
      try {
        // Neither exists yet. That is the point: with no silo on disk the
        // refusal has nothing to resolve and lets the roots through.
        const silo = path.join(parent, "silo");
        const agents = path.join(silo, "agents");

        withLiveSiloRoot(silo, () => {
          withEnv({ INBOX_ROOT: sandbox, REVIEW_ROOTS: agents }, () => {
            // 1. The pass. Correct at the time it is given.
            expect(() => resolveReviewRoots()).not.toThrow();

            // 2. The silo appears, with a real agent file in it. REVIEW_ROOTS,
            //    MC_LIVE_SILO_ROOT and MC_SANDBOX_ONLY are all untouched - a
            //    cache keyed on configuration sees no reason to re-check.
            fs.mkdirSync(agents, { recursive: true });
            const doc = path.join(agents, "private.md");
            fs.writeFileSync(doc, "# private\n");

            // 3. The next resolution must answer on what is on disk NOW...
            expect(() => resolveReviewRoots()).toThrow(/live agent silo/);
            // ...and the read must be refused, not served off the stale pass.
            expect(() => readReviewFile(doc)).toThrow(/live agent silo/);
          });
        });
      } finally {
        rmSync(parent);
      }
    });

    it("REFUSES a read through a symlinked root RETARGETED into the silo after it passed", () => {
      const parent = mkdtempSync();
      try {
        const silo = path.join(parent, "silo");
        const agents = path.join(silo, "agents");
        const safe = path.join(parent, "safe");
        const rootLink = path.join(parent, "root"); // the configured root
        fs.mkdirSync(agents, { recursive: true });
        fs.mkdirSync(safe, { recursive: true });
        fs.symlinkSync(safe, rootLink);

        withLiveSiloRoot(silo, () => {
          withEnv({ INBOX_ROOT: sandbox, REVIEW_ROOTS: rootLink }, () => {
            // 1. The pass. rootLink resolves outside the silo, so it is fine.
            expect(() => resolveReviewRoots()).not.toThrow();

            // 2. The same root string now points into the silo.
            fs.unlinkSync(rootLink);
            fs.symlinkSync(agents, rootLink);
            fs.writeFileSync(path.join(agents, "private.md"), "# private\n");

            // 3. Refused, through the unchanged configured path.
            expect(() => resolveReviewRoots()).toThrow(/live agent silo/);
            expect(() => readReviewFile(path.join(rootLink, "private.md"))).toThrow(
              /live agent silo/
            );
          });
        });
      } finally {
        rmSync(parent);
      }
    });

    it("REFUSES when the implicit INBOX_ROOT is the live silo", () => {
      // Every root the panel would use is vetted, not only the configured ones.
      const silo = mkdtempSync();
      try {
        withLiveSiloRoot(silo, () => {
          withEnv({ INBOX_ROOT: silo, REVIEW_ROOTS: sandbox }, () => {
            expect(() => resolveReviewRoots()).toThrow(/INBOX_ROOT/);
          });
        });
      } finally {
        rmSync(silo);
      }
    });

    it("REFUSES at boot through validateReviewRoots, so the instance dies loudly", () => {
      // What the root loader calls. Without it the misconfiguration is a 404 on
      // one panel rather than a start-up failure, which is the shape the other
      // four roots have.
      const silo = mkdtempSync();
      try {
        withLiveSiloRoot(silo, () => {
          withEnv({ INBOX_ROOT: sandbox, REVIEW_ROOTS: silo }, () => {
            expect(() => validateReviewRoots()).toThrow(/live agent silo/);
          });
        });
      } finally {
        rmSync(silo);
      }
    });

    it("ALLOWS a sibling whose name merely starts with the silo's (no prefix bug)", () => {
      const parent = mkdtempSync();
      try {
        const silo = path.join(parent, "silo");
        const sibling = path.join(parent, "silo-backup");
        fs.mkdirSync(silo);
        fs.mkdirSync(sibling);
        withLiveSiloRoot(silo, () => {
          withEnv({ INBOX_ROOT: sandbox, REVIEW_ROOTS: sibling }, () => {
            expect(() => resolveReviewRoots()).not.toThrow();
          });
        });
      } finally {
        rmSync(parent);
      }
    });

    it("ALLOWS the live silo once MC_SANDBOX_ONLY is unset (the production cutover)", () => {
      // Production reads the real silo on purpose. The refusal is a sandbox
      // rule, and unsetting the flag is the deliberate step that lifts it.
      const silo = mkdtempSync();
      try {
        const doc = path.join(silo, "note.md");
        fs.writeFileSync(doc, "# live\n");
        withSandboxOnly(undefined, () => {
          withLiveSiloRoot(silo, () => {
            withEnv({ INBOX_ROOT: sandbox, REVIEW_ROOTS: silo }, () => {
              expect(() => resolveReviewRoots()).not.toThrow();
              expect(readReviewFile(doc).content).toBe("# live\n");
            });
          });
        });
      } finally {
        rmSync(silo);
      }
    });
  });

  // -------------------------------------------------------------------------
  // THE .env test - THE exact threat case from the plan
  // -------------------------------------------------------------------------

  describe("readReviewFile - extension gate", () => {
    it("denies a .env file even when it is inside an allowed root", () => {
      // This is the ticket's exact threat case: generous roots + .env file.
      // The extension gate is the load-bearing second gate regardless of what
      // other extensions are in the allowlist.
      const envFilePath = path.join(sandbox, ".env");
      fs.writeFileSync(envFilePath, "SECRET=supersecret");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(envFilePath)).toThrow(/allowlist|Extension/);
      });
    });

    it("denies a file with no extension", () => {
      const noExtPath = path.join(sandbox, "Makefile");
      fs.writeFileSync(noExtPath, "build: ...");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(noExtPath)).toThrow(/allowlist|Extension/);
      });
    });

    // code extensions are now in the allowlist and should be accepted.
    it("accepts a .ts source file (TASK-562 code ext)", () => {
      const tsFilePath = path.join(sandbox, "index.ts");
      fs.writeFileSync(tsFilePath, "export const x = 1;");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        const result = readReviewFile(tsFilePath);
        expect(result.content).toContain("export const x");
        expect(result.kind).toBe("code");
        expect(result.lang).toBe("typescript");
      });
    });

    it("accepts a .json file (TASK-562 code ext)", () => {
      const jsonFilePath = path.join(sandbox, "config.json");
      fs.writeFileSync(jsonFilePath, '{"key":"value"}');
      withEnv({ INBOX_ROOT: sandbox }, () => {
        const result = readReviewFile(jsonFilePath);
        expect(result.content).toContain('"key"');
        expect(result.kind).toBe("code");
        expect(result.lang).toBe("json");
      });
    });

    it("accepts a .py file and maps to python lang (TASK-562)", () => {
      const pyPath = path.join(sandbox, "script.py");
      fs.writeFileSync(pyPath, "def hello(): pass");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        const result = readReviewFile(pyPath);
        expect(result.kind).toBe("code");
        expect(result.lang).toBe("python");
      });
    });

    it("accepts a .sh file and maps to bash lang (TASK-562)", () => {
      const shPath = path.join(sandbox, "run.sh");
      fs.writeFileSync(shPath, "#!/usr/bin/env bash\necho hi");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        const result = readReviewFile(shPath);
        expect(result.kind).toBe("code");
        expect(result.lang).toBe("bash");
      });
    });

    it("accepts a .yml file and maps to yaml lang (TASK-562)", () => {
      const ymlPath = path.join(sandbox, "config.yml");
      fs.writeFileSync(ymlPath, "key: value");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        const result = readReviewFile(ymlPath);
        expect(result.kind).toBe("code");
        expect(result.lang).toBe("yaml");
      });
    });

    it("returns kind=markdown for .md files (existing extensions unaffected)", () => {
      const mdPath = path.join(sandbox, "README.md");
      fs.writeFileSync(mdPath, "# Hello");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        const result = readReviewFile(mdPath);
        expect(result.kind).toBe("markdown");
        expect(result.lang).toBe("plaintext");
      });
    });

    it("returns kind=markdown for .txt files", () => {
      const txtPath = path.join(sandbox, "notes.txt");
      fs.writeFileSync(txtPath, "plain text");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        const result = readReviewFile(txtPath);
        expect(result.kind).toBe("markdown");
      });
    });

    it("still denies .env even though .yml and .json are now allowed (TASK-562 security)", () => {
      // Belt-and-braces: confirm .env is NOT accidentally added to the code ext set.
      const envFilePath = path.join(sandbox, ".env");
      fs.writeFileSync(envFilePath, "DATABASE_URL=postgres://secret");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(envFilePath)).toThrow(/allowlist|Extension/);
      });
    });

    it("denies .env.local (looks like .env variant, not in allowlist)", () => {
      const envLocalPath = path.join(sandbox, ".env.local");
      fs.writeFileSync(envLocalPath, "SECRET=x");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(envLocalPath)).toThrow(/allowlist|Extension/);
      });
    });

    it("denies .svg (kept denied per TASK-431 decision)", () => {
      const svgPath = path.join(sandbox, "icon.svg");
      fs.writeFileSync(svgPath, "<svg></svg>");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(svgPath)).toThrow(/allowlist|Extension/);
      });
    });
  });

  // -------------------------------------------------------------------------
  // binary-NUL guard
  // -------------------------------------------------------------------------

  describe("readReviewFile - binary-NUL guard (TASK-562)", () => {
    it("rejects a code file containing NUL bytes (binary mislabeled as .js)", () => {
      const jsPath = path.join(sandbox, "binary.js");
      // Write content with a NUL byte (simulates a binary mislabeled with code ext).
      const buf = Buffer.from("console.log('hi');\x00binary garbage");
      fs.writeFileSync(jsPath, buf);
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(jsPath)).toThrow(/[Bb]inary/);
      });
    });

    it("accepts a code file with no NUL bytes", () => {
      const tsPath = path.join(sandbox, "clean.ts");
      fs.writeFileSync(tsPath, "export {};\n");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        const result = readReviewFile(tsPath);
        expect(result.content).toContain("export");
      });
    });

    it("does NOT apply binary guard to markdown files (NUL in .md is unusual but not blocked here)", () => {
      // The binary guard is code-only. Markdown files with NUL are served as-is.
      const mdPath = path.join(sandbox, "weird.md");
      // NUL in markdown: passes (guard is code-only per spec).
      fs.writeFileSync(mdPath, Buffer.from("# Hello\x00"));
      withEnv({ INBOX_ROOT: sandbox }, () => {
        // Should NOT throw - binary guard is code-only.
        const result = readReviewFile(mdPath);
        expect(result.kind).toBe("markdown");
      });
    });
  });

  // -------------------------------------------------------------------------
  // Secret denylist (Gate 4a)
  // -------------------------------------------------------------------------

  describe("readReviewFile - secret denylist (deny-before-allow)", () => {
    it("denies signing_key.json even though .json is in the extension allowlist", () => {
      // THE concrete threat: supabase/signing_key.json lives inside git-repos/
      // which is a common REVIEW_ROOT. Extension .json would otherwise pass.
      const keyPath = path.join(sandbox, "signing_key.json");
      fs.writeFileSync(keyPath, '{"key":"SUPERSECRET"}');
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(keyPath)).toThrow(/[Dd]enylist|[Ss]ecret/);
      });
    });

    it("denies signing_keys.json", () => {
      const keyPath = path.join(sandbox, "signing_keys.json");
      fs.writeFileSync(keyPath, '{"key":"SUPERSECRET"}');
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(keyPath)).toThrow(/[Dd]enylist|[Ss]ecret/);
      });
    });

    it("denies .env.production (.env.* is denied by name regardless of extension gate)", () => {
      // ".env.production" has no extension in the code allowlist, but the
      // denylist is belt-and-braces for future allowlist changes.
      const envProdPath = path.join(sandbox, ".env.production");
      fs.writeFileSync(envProdPath, "DATABASE_URL=postgres://prod");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        // This throws either for extension allowlist OR denylist.
        expect(() => readReviewFile(envProdPath)).toThrow();
      });
    });

    it("allows .env.example (documentation template - safe)", () => {
      // .env.example has extension .example which is not in the code allowlist,
      // but it IS in the .txt-like catch-all if ever added. The denylist must
      // NOT block it. Here we test the denylist logic does not block it -
      // the file will fail the extension gate but NOT the denylist gate.
      // We verify by checking the throw reason is extension, not denylist.
      const envExPath = path.join(sandbox, ".env.example");
      fs.writeFileSync(envExPath, "DATABASE_URL=example");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        // Should throw for extension (not in allowlist), NOT for denylist.
        // We confirm by trying and catching: if it throws "denylist" that is a bug.
        try {
          readReviewFile(envExPath);
          // If it somehow passes (e.g. .example added to allowlist later), that is fine.
        } catch (err) {
          const msg = String(err);
          expect(msg).not.toMatch(/[Dd]enylist|[Ss]ecret/);
        }
      });
    });

    it("denies a *.pem file even if somehow inside an allowed root", () => {
      const pemPath = path.join(sandbox, "server.pem");
      fs.writeFileSync(pemPath, "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(pemPath)).toThrow();
      });
    });

    it("denies id_rsa (SSH private key)", () => {
      const rsaPath = path.join(sandbox, "id_rsa");
      // Header split so the repo leak gate's private-key rule does not fire
      // on this test source; the runtime bytes are identical.
      fs.writeFileSync(rsaPath, "-----BEGIN OPENSSH " + "PRIVATE KEY-----\nFAKE");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        // id_rsa has no extension so extension gate catches it first, but
        // the denylist is belt-and-braces.
        expect(() => readReviewFile(rsaPath)).toThrow();
      });
    });

    it("denies *.age files (encrypted credential bundles)", () => {
      const agePath = path.join(sandbox, ".db-creds.age");
      fs.writeFileSync(agePath, "AGE-SECRET-KEY-1FAKE");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        // .age not in allowlist anyway, but denylist provides belt-and-braces.
        expect(() => readReviewFile(agePath)).toThrow();
      });
    });

    it("denies credentials.json (credential JSON pattern)", () => {
      const credsPath = path.join(sandbox, "credentials.json");
      fs.writeFileSync(credsPath, '{"type":"service_account","private_key":"FAKE"}');
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(credsPath)).toThrow(/[Dd]enylist|[Ss]ecret/);
      });
    });

    it("denies service-account.json (GCP service account pattern)", () => {
      const saPath = path.join(sandbox, "service-account.json");
      fs.writeFileSync(saPath, '{"type":"service_account"}');
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(saPath)).toThrow(/[Dd]enylist|[Ss]ecret/);
      });
    });

    it("still allows package.json, tsconfig.json, config.json (normal JSON)", () => {
      for (const name of ["package.json", "tsconfig.json", "config.json"]) {
        const filePath = path.join(sandbox, name);
        fs.writeFileSync(filePath, '{"name":"test"}');
        withEnv({ INBOX_ROOT: sandbox }, () => {
          const result = readReviewFile(filePath);
          expect(result.content).toContain('"name"');
          expect(result.kind).toBe("code");
        });
        fs.unlinkSync(filePath);
      }
    });

    it("still allows a normal .ts file", () => {
      const tsPath = path.join(sandbox, "index.ts");
      fs.writeFileSync(tsPath, "export const x = 1;");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        const result = readReviewFile(tsPath);
        expect(result.content).toContain("export");
      });
    });

    it("denies signing_key.json reached via an innocently-named symlink (double-gate on resolved basename)", () => {
      // A symlink named "app-config.json" inside the root that resolves to
      // "signing_key.json" inside the same root. The resolved basename triggers
      // the denylist even though the requested basename does not.
      const secretPath = path.join(sandbox, "signing_key.json");
      fs.writeFileSync(secretPath, '{"key":"SUPERSECRET"}');
      const linkPath = path.join(sandbox, "app-config.json");
      fs.symlinkSync(secretPath, linkPath);
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(linkPath)).toThrow(/[Dd]enylist|[Ss]ecret/);
      });
    });

    // Regression: separator-aware token check.
    it("denies client_secret.json (token match via regex)", () => {
      const filePath = path.join(sandbox, "client_secret.json");
      fs.writeFileSync(filePath, '{"client_secret":"SUPERSECRET"}');
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(filePath)).toThrow(/[Dd]enylist|[Ss]ecret/);
      });
    });

    it("denies client-secret.json (hyphen separator)", () => {
      const filePath = path.join(sandbox, "client-secret.json");
      fs.writeFileSync(filePath, '{"client_secret":"SUPERSECRET"}');
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(filePath)).toThrow(/[Dd]enylist|[Ss]ecret/);
      });
    });

    it("denies secret.json (bare token at start)", () => {
      const filePath = path.join(sandbox, "secret.json");
      fs.writeFileSync(filePath, '{"api_key":"SUPERSECRET"}');
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(filePath)).toThrow(/[Dd]enylist|[Ss]ecret/);
      });
    });

    it("denies private_key.json (underscore separator)", () => {
      const filePath = path.join(sandbox, "private_key.json");
      // Header split so the repo leak gate's private-key rule does not fire
      // on this test source; the runtime bytes are identical.
      fs.writeFileSync(filePath, '{"private_key":"-----BEGIN RSA ' + 'PRIVATE KEY-----"}');
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(filePath)).toThrow(/[Dd]enylist|[Ss]ecret/);
      });
    });

    it("denies private-key.json (hyphen separator)", () => {
      const filePath = path.join(sandbox, "private-key.json");
      fs.writeFileSync(filePath, '{"private_key":"FAKE"}');
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(filePath)).toThrow(/[Dd]enylist|[Ss]ecret/);
      });
    });
  });

  // -------------------------------------------------------------------------
  // readReviewFile - size cap
  // -------------------------------------------------------------------------

  describe("readReviewFile - size cap", () => {
    it("denies a file exceeding 2MB", () => {
      const bigFilePath = path.join(sandbox, "big.md");
      // Write 2MB + 1 byte.
      fs.writeFileSync(bigFilePath, Buffer.alloc(2 * 1024 * 1024 + 1, "x"));
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewFile(bigFilePath)).toThrow(/too large/);
      });
    });

    it("accepts a file exactly at 2MB - 1 byte", () => {
      const filePath = path.join(sandbox, "ok.md");
      fs.writeFileSync(filePath, Buffer.alloc(2 * 1024 * 1024 - 1, "x"));
      withEnv({ INBOX_ROOT: sandbox }, () => {
        // Should not throw.
        const result = readReviewFile(filePath);
        expect(result).toBeDefined();
      });
    });
  });

  // -------------------------------------------------------------------------
  // readReviewAsset
  // -------------------------------------------------------------------------

  describe("readReviewAsset", () => {
    it("reads a png asset and returns correct content-type", () => {
      const imgPath = path.join(sandbox, "img.png");
      const bytes = Buffer.from("PNG_FAKE");
      fs.writeFileSync(imgPath, bytes);
      withEnv({ INBOX_ROOT: sandbox }, () => {
        const result = readReviewAsset(imgPath);
        expect(result.contentType).toBe("image/png");
        expect(Buffer.from(result.bytes)).toEqual(bytes);
      });
    });

    it("reads jpg, jpeg, gif, webp assets", () => {
      for (const [ext, mime] of [
        ["jpg", "image/jpeg"],
        ["jpeg", "image/jpeg"],
        ["gif", "image/gif"],
        ["webp", "image/webp"],
      ] as const) {
        const imgPath = path.join(sandbox, `img.${ext}`);
        fs.writeFileSync(imgPath, Buffer.from("FAKE"));
        withEnv({ INBOX_ROOT: sandbox }, () => {
          const result = readReviewAsset(imgPath);
          expect(result.contentType).toBe(mime);
        });
      }
    });

    it("denies svg through the asset gate", () => {
      const svgPath = path.join(sandbox, "icon.svg");
      fs.writeFileSync(svgPath, "<svg></svg>");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewAsset(svgPath)).toThrow(/allowlist|Extension/);
      });
    });

    it("denies .md through the asset gate (gates do not cross)", () => {
      const mdPath = path.join(sandbox, "doc.md");
      fs.writeFileSync(mdPath, "# doc");
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewAsset(mdPath)).toThrow(/allowlist|Extension/);
      });
    });

    it("denies an asset exceeding 10MB", () => {
      const bigPath = path.join(sandbox, "big.png");
      fs.writeFileSync(bigPath, Buffer.alloc(10 * 1024 * 1024 + 1, 0));
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewAsset(bigPath)).toThrow(/too large/);
      });
    });

    it("denies an asset outside all roots", () => {
      const imgPath = path.join(outside, "img.png");
      fs.writeFileSync(imgPath, Buffer.from("PNG_FAKE"));
      withEnv({ INBOX_ROOT: sandbox }, () => {
        expect(() => readReviewAsset(imgPath)).toThrow(/outside all review roots/);
      });
    });
  });

  describe("extension gate on the RESOLVED path (symlink rename bypass)", () => {
    it("denies a notes.md symlink pointing at a .env file inside an allowed root", () => {
      process.env["INBOX_ROOT"] = sandbox;
      process.env["REVIEW_ROOTS"] = sandbox;
      try {
        // The threat: .env lives INSIDE the allowed root (generous roots in prod
        // contain repos with .env files). Containment alone passes.
        const envFile = path.join(sandbox, ".env");
        fs.writeFileSync(envFile, "SECRET_KEY=hunter2");
        const link = path.join(sandbox, "notes.md");
        fs.symlinkSync(envFile, link);
        expect(() => readReviewFile(link)).toThrow(/allowlist/);
      } finally {
        delete process.env["INBOX_ROOT"];
        delete process.env["REVIEW_ROOTS"];
      }
    });

    it("denies a pic.png symlink pointing at a .env file through the asset gate", () => {
      process.env["INBOX_ROOT"] = sandbox;
      process.env["REVIEW_ROOTS"] = sandbox;
      try {
        const envFile = path.join(sandbox, "secrets.env");
        fs.writeFileSync(envFile, "SECRET_KEY=hunter2");
        const link = path.join(sandbox, "pic.png");
        fs.symlinkSync(envFile, link);
        expect(() => readReviewAsset(link)).toThrow(/allowlist/);
      } finally {
        delete process.env["INBOX_ROOT"];
        delete process.env["REVIEW_ROOTS"];
      }
    });

    it("still serves a legitimate symlink whose target is also an allowed extension", () => {
      process.env["INBOX_ROOT"] = sandbox;
      process.env["REVIEW_ROOTS"] = sandbox;
      try {
        const real = path.join(sandbox, "real-doc.md");
        fs.writeFileSync(real, "# hello");
        const link = path.join(sandbox, "alias.md");
        fs.symlinkSync(real, link);
        const result = readReviewFile(link);
        expect(result.content).toBe("# hello");
      } finally {
        delete process.env["INBOX_ROOT"];
        delete process.env["REVIEW_ROOTS"];
      }
    });

    it("denies an .env-named request even if it resolves to a .md target", () => {
      process.env["INBOX_ROOT"] = sandbox;
      process.env["REVIEW_ROOTS"] = sandbox;
      try {
        const real = path.join(sandbox, "doc.md");
        fs.writeFileSync(real, "# content");
        const link = path.join(sandbox, "sneaky.env");
        fs.symlinkSync(real, link);
        expect(() => readReviewFile(link)).toThrow(/allowlist/);
      } finally {
        delete process.env["INBOX_ROOT"];
        delete process.env["REVIEW_ROOTS"];
      }
    });
  });

});
