/**
 * bin/first-run.sh.
 *
 * Core behaviour only: the normal run, names that must create nothing, and
 * re-runs. The persona proof itself is create-agent.sh's and is tested there;
 * the stub runtime here answers with the boot phrase read from the agent's own
 * IDENTITY.md, so a VERIFIED result still means the file reached the "model".
 * Note what that proof does not cover: it shows the persona loaded, not that the
 * role brief or peer name are right, so those are asserted on CLAUDE.md below.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const BIN = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "bin");
const SCRIPT = path.join(BIN, "first-run.sh");

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

interface Box {
  home: string;
  agentsHome: string;
  inboxRoot: string;
  stubBin: string;
}

function box(): Box {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "first-run-test-"));
  tempRoots.push(root);
  const b = {
    home: path.join(root, "home"),
    agentsHome: path.join(root, "agents"),
    inboxRoot: path.join(root, "inbox"),
    stubBin: path.join(root, "bin"),
  };
  for (const d of Object.values(b)) fs.mkdirSync(d, { recursive: true });
  return b;
}

/** A runtime that quotes the boot phrase from the IDENTITY.md in its cwd. */
function stubAnswering(b: Box): void {
  fs.writeFileSync(
    path.join(b.stubBin, "claude"),
    '#!/usr/bin/env bash\ngrep -oE "boot-[0-9a-f]{16}" IDENTITY.md | head -n1\n',
    { mode: 0o755 },
  );
}

function run(b: Box, args: string[], stub: boolean) {
  const nodeBin = path.join(path.dirname(b.stubBin), "node-only");
  fs.mkdirSync(nodeBin, { recursive: true });
  const link = path.join(nodeBin, "node");
  if (!fs.existsSync(link)) fs.symlinkSync(process.execPath, link);
  const dirs = [nodeBin, "/usr/bin", "/bin"];
  const r = spawnSync(
    "bash",
    [SCRIPT, "--agents-home", b.agentsHome, "--inbox-root", b.inboxRoot, ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { HOME: b.home, PATH: (stub ? [b.stubBin, ...dirs] : dirs).join(path.delimiter) },
    },
  );
  return { status: r.status ?? -1, output: (r.stdout ?? "") + (r.stderr ?? "") };
}

const claudeOf = (b: Box, n: string) => fs.readFileSync(path.join(b.agentsHome, n, "CLAUDE.md"), "utf8");
const agents = (b: Box) => fs.readdirSync(b.agentsHome).sort();

describe("first-run", () => {
  it("creates both agents with .kind, role briefs and peer names, exit 0", () => {
    const b = box();
    stubAnswering(b);
    const r = run(b, ["--assistant", "ada", "--platform", "forge"], true);
    expect(r.status).toBe(0);
    expect(r.output).toContain("assistant ada: VERIFIED");
    expect(r.output).toContain("platform agent forge: VERIFIED");
    expect(fs.readFileSync(path.join(b.agentsHome, "ada", ".kind"), "utf8")).toBe("assistant");
    expect(fs.readFileSync(path.join(b.agentsHome, "forge", ".kind"), "utf8")).toBe("platform");
    // Role and peer stamps have their own checks; the boot phrase does not cover them.
    expect(claudeOf(b, "ada")).toContain("You are the assistant, the main orchestrator");
    expect(claudeOf(b, "ada")).toContain("**forge**");
    expect(claudeOf(b, "forge")).toContain("You are the platform agent");
    expect(claudeOf(b, "forge")).toContain("**ada**");
  });

  it.each([
    ["an invalid name", ["--assistant", "Bad Name", "--platform", "forge"]],
    ["identical names", ["--assistant", "ada", "--platform", "ada"]],
  ])("creates nothing for %s", (_label, args) => {
    const b = box();
    const r = run(b, args, false);
    expect(r.status).toBe(1);
    expect(agents(b)).toEqual([]);
    expect(fs.readdirSync(b.inboxRoot)).toEqual([]);
    if (_label === "an invalid name") expect(r.output).toContain('"Bad Name" cannot be an agent name');
  });

  it("creates nothing when a name is already taken", () => {
    const b = box();
    fs.mkdirSync(path.join(b.agentsHome, "forge"));
    fs.writeFileSync(path.join(b.agentsHome, "forge", "SOUL.md"), "x");
    const r = run(b, ["--assistant", "ada", "--platform", "forge", "--no-verify"], false);
    expect(r.status).toBe(1);
    expect(agents(b)).toEqual(["forge"]);
    expect(fs.readdirSync(b.inboxRoot)).toEqual([]);
  });

  it("a same-name rerun is a clean no-op", () => {
    const b = box();
    stubAnswering(b);
    run(b, ["--assistant", "ada", "--platform", "forge"], true);
    const before = claudeOf(b, "ada");
    const r = run(b, ["--assistant", "ada", "--platform", "forge"], true);
    expect(r.status).toBe(0);
    expect(r.output).toContain("already exist");
    expect(claudeOf(b, "ada")).toBe(before);
    expect(agents(b)).toEqual(["ada", "forge"]);
  });

  it("after one agent exists, creates only the other and stamps the survivor's actual name", () => {
    const b = box();
    stubAnswering(b);
    run(b, ["--assistant", "ada", "--platform", "forge"], true);
    // A dirty partial: the platform agent's persona and inbox are gone, but its
    // home is not empty (a stray .claude directory is left behind).
    fs.rmSync(path.join(b.agentsHome, "forge"), { recursive: true });
    fs.mkdirSync(path.join(b.agentsHome, "forge", ".claude"), { recursive: true });
    fs.rmSync(path.join(b.inboxRoot, "forge"), { recursive: true });
    const adaBefore = claudeOf(b, "ada");

    // Different names are typed this time: the saved and surviving ones win.
    const r = run(b, ["--assistant", "ghost", "--platform", "other"], true);
    expect(r.status).toBe(0);
    expect(r.output).toContain("using that");
    expect(agents(b)).toEqual(["ada", "forge"]);
    expect(claudeOf(b, "ada")).toBe(adaBefore);
    expect(claudeOf(b, "forge")).toContain("**ada**");
    expect(claudeOf(b, "forge")).not.toContain("ghost");
  });

  it("recovers when the survivor has no .peer", () => {
    const b = box();
    stubAnswering(b);
    run(b, ["--assistant", "ada", "--platform", "forge"], true);
    fs.rmSync(path.join(b.agentsHome, "ada", ".peer"));
    fs.rmSync(path.join(b.agentsHome, "forge"), { recursive: true });
    fs.rmSync(path.join(b.inboxRoot, "forge"), { recursive: true });
    const r = run(b, ["--assistant", "ada", "--platform", "forge"], true);
    expect(r.status).toBe(0);
    expect(claudeOf(b, "forge")).toContain("**ada**");
  });

  it("does not call a failed scaffold complete on the next run", () => {
    const b = box();
    // The platform agent's inbox directory cannot be made: its parent is a file.
    fs.writeFileSync(path.join(b.inboxRoot, "forge"), "in the way");
    const first = run(b, ["--assistant", "ada", "--platform", "forge", "--no-verify"], false);
    expect(first.status).toBe(1);
    expect(fs.existsSync(path.join(b.agentsHome, "forge", ".kind"))).toBe(false);

    const second = run(b, ["--assistant", "ada", "--platform", "forge", "--no-verify"], false);
    expect(second.status).toBe(1);
    expect(second.output).not.toContain("Nothing to do");
  });

  it("rejects a flag-shaped name and creates nothing", () => {
    const b = box();
    const r = run(b, ["--assistant", "ada", "--platform", "--help"], false);
    expect(r.status).toBe(1);
    expect(agents(b)).toEqual([]);
  });

  it("with no runtime, creates both and exits 4", () => {
    const b = box();
    const r = run(b, ["--assistant", "ada", "--platform", "forge"], false);
    expect(r.status).toBe(4);
    expect(agents(b)).toEqual(["ada", "forge"]);
    expect(r.output).toContain("CANNOT VERIFY");
  });
});
