/**
 * bin/create-agent.sh.
 *
 * Two halves, and the second one is the point.
 *
 * The creation half checks that both definitions of "this agent exists" come
 * out true at once: the launcher's (a directory under the agents home holding
 * SOUL.md) and the application's (a directory under the inbox root).
 *
 * The verification half checks that the script can tell a working agent from a
 * broken one. Every failure in this area leaves identical files on disk, so the
 * case that matters most here is not (a) "it reports VERIFIED when the persona
 * arrived" but (b) "it reports FAILED when a fluent model replies without the
 * boot phrase". A verifier that can only ever say VERIFIED is exactly the kind
 * of check this script exists to replace, and only case (b) rules that out.
 *
 * Everything runs against temporary directories. HOME, the agents home and the
 * inbox root are all redirected, and PATH is rebuilt from scratch rather than
 * inherited, so a real runtime installed on the machine running the tests can
 * neither be reached by accident nor change the result.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(PACKAGE_ROOT, "bin", "create-agent.sh");

/** Exit codes are part of the contract: automation reads these, not the prose. */
const EXIT = {
  VERIFIED: 0,
  SCAFFOLD_ERROR: 1,
  FAILED: 3,
  CANNOT_VERIFY: 4,
} as const;

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

interface Sandbox {
  readonly home: string;
  readonly agentsHome: string;
  readonly inboxRoot: string;
  readonly stubBin: string;
}

function sandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "create-agent-test-"));
  tempRoots.push(root);
  const dirs = {
    home: path.join(root, "home"),
    agentsHome: path.join(root, "agents"),
    inboxRoot: path.join(root, "inbox"),
    stubBin: path.join(root, "bin"),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

/**
 * Write an executable stand-in for the `claude` runtime.
 *
 * The stub is what makes the verification cases deterministic AND is what
 * makes them meaningful: it lets a test stage the exact situation the real
 * failure looks like, which is a runtime that answers confidently out of a
 * context the persona never reached.
 */
function stubRuntime(box: Sandbox, body: string): void {
  const file = path.join(box.stubBin, "claude");
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

/**
 * PATH is built explicitly, never inherited. An inherited PATH would let a real
 * `claude` on the developer's machine answer the probe, which would make the
 * "no runtime available" case pass for the wrong reason on their box and fail
 * in CI. The node directory is included because the script shells out to node.
 */
function testPath(box: Sandbox, withStub: boolean): string {
  const entries = [path.dirname(process.execPath), "/usr/bin", "/bin"];
  return (withStub ? [box.stubBin, ...entries] : entries).join(path.delimiter);
}

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
}

function run(
  box: Sandbox,
  args: readonly string[],
  options: { readonly stub?: boolean; readonly env?: Record<string, string> } = {},
): RunResult {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    // stdin closed: the script must never fall into its interactive prompt
    // under test, and if it ever does, the read fails fast instead of hanging.
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      HOME: box.home,
      AGENTS_HOME: box.agentsHome,
      INBOX_ROOT: box.inboxRoot,
      PATH: testPath(box, options.stub ?? false),
      ...options.env,
    },
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status ?? -1, stdout, stderr, output: stdout + stderr };
}

const bootPhraseOf = (box: Sandbox, name: string): string => {
  const identity = fs.readFileSync(path.join(box.agentsHome, name, "IDENTITY.md"), "utf8");
  const match = /boot-[0-9a-f]{16}/.exec(identity);
  if (!match) throw new Error("no boot phrase written into IDENTITY.md");
  return match[0];
};

describe("creation", () => {
  it("creates both directories, so both definitions of the agent agree", () => {
    const box = sandbox();
    const result = run(box, ["wren", "--no-verify"]);

    // The launcher's predicate, copied from boot-agents.sh / workspace.sh: a
    // directory under the agents home is an agent iff it holds SOUL.md.
    const bootable = fs
      .readdirSync(box.agentsHome, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => fs.existsSync(path.join(box.agentsHome, entry.name, "SOUL.md")))
      .map((entry) => entry.name);

    // The application's predicate, copied from InboxStore.listAgents: every
    // directory under the inbox root.
    const visible = fs
      .readdirSync(box.inboxRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(bootable).toEqual(["wren"]);
    expect(visible).toEqual(["wren"]);
    expect(fs.existsSync(path.join(box.inboxRoot, "wren", "inbox"))).toBe(true);
    expect(result.output).toContain("CREATED wren");
  });

  it("copies all five persona files and leaves the self-author placeholders alone", () => {
    const box = sandbox();
    run(box, ["wren", "--role", "keeps the notes", "--no-verify"]);
    const home = path.join(box.agentsHome, "wren");

    for (const file of ["IDENTITY.md", "SOUL.md", "TOOLS.md", "USER.md", "CLAUDE.md"]) {
      expect(fs.existsSync(path.join(home, file))).toBe(true);
    }

    // The two marked placeholders are substituted...
    expect(fs.readFileSync(path.join(home, "CLAUDE.md"), "utf8")).toContain(
      "# wren, keeps the notes",
    );
    expect(fs.readFileSync(path.join(home, "IDENTITY.md"), "utf8")).toContain("- **Name:** wren");

    // ...and everything the agent is meant to write for itself is untouched.
    // A hand-authored personality reads as costume; these prompts surviving
    // scaffolding is the mechanism that stops the script writing one.
    const soul = fs.readFileSync(path.join(home, "SOUL.md"), "utf8");
    expect(soul).toContain("<Self-author on day one.");
    expect(fs.readFileSync(path.join(home, "IDENTITY.md"), "utf8")).toContain(
      "<self-author on day one>",
    );
  });

  it("writes .runtime explicitly, defaulting to claude and honouring --runtime", () => {
    const box = sandbox();
    run(box, ["wren", "--no-verify"]);
    expect(fs.readFileSync(path.join(box.agentsHome, "wren", ".runtime"), "utf8")).toBe("claude");

    run(box, ["basalt", "--runtime", "codex", "--no-verify"]);
    expect(fs.readFileSync(path.join(box.agentsHome, "basalt", ".runtime"), "utf8")).toBe("codex");
  });

  it("writes a boot phrase into the persona chain and keeps it as a creation stamp", () => {
    const box = sandbox();
    const result = run(box, ["wren", "--no-verify"]);
    const phrase = bootPhraseOf(box, "wren");

    expect(phrase).toMatch(/^boot-[0-9a-f]{16}$/);
    expect(result.output).toContain(phrase);
    // It must be behind an import the runtime actually follows, not merely
    // present in the directory.
    expect(fs.readFileSync(path.join(box.agentsHome, "wren", "CLAUDE.md"), "utf8")).toContain(
      "@IDENTITY.md",
    );
  });

  it("gives every agent a different boot phrase", () => {
    const box = sandbox();
    run(box, ["wren", "--no-verify"]);
    run(box, ["basalt", "--no-verify"]);
    expect(bootPhraseOf(box, "wren")).not.toBe(bootPhraseOf(box, "basalt"));
  });

  it("writes nothing outside the two agent directories, bar the one PATH symlink", () => {
    const box = sandbox();
    run(box, ["wren", "--no-install-path", "--no-verify"]);
    // Nothing under HOME. The recipe this generalises touches a user-level
    // settings file; this script must not, because that file belongs to
    // whatever else the user is running.
    expect(fs.readdirSync(box.home)).toEqual([]);

    // The single carve-out, opted out of above and exercised here: a symlink at
    // ~/.local/bin/inbox, because the bare command name `inbox` has to resolve
    // for the reply hint the application pushes into a pane to be true. It is
    // one link and nothing else, and it is never a write over an existing file.
    const other = sandbox();
    run(other, ["wren", "--no-verify"]);
    expect(fs.readdirSync(other.home)).toEqual([".local"]);
    expect(fs.readdirSync(path.join(other.home, ".local", "bin"))).toEqual(["inbox"]);
  });

  it("refuses to overwrite, and names BOTH paths when either is occupied", () => {
    const box = sandbox();
    run(box, ["wren", "--no-verify"]);
    const before = fs.readFileSync(path.join(box.agentsHome, "wren", "IDENTITY.md"), "utf8");

    const result = run(box, ["wren", "--no-verify"]);

    expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
    // Whoever hits this knows about one of the two directories, almost never
    // both, so both are named whichever one collided.
    expect(result.output).toContain(path.join(box.agentsHome, "wren"));
    expect(result.output).toContain(path.join(box.inboxRoot, "wren"));
    expect(fs.readFileSync(path.join(box.agentsHome, "wren", "IDENTITY.md"), "utf8")).toBe(before);
  });

  it("refuses when only the inbox half exists, and says which half", () => {
    const box = sandbox();
    fs.mkdirSync(path.join(box.inboxRoot, "wren", "inbox"), { recursive: true });

    const result = run(box, ["wren", "--no-verify"]);

    expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(result.output).toMatch(/free\s+.*agents.wren/);
    expect(result.output).toMatch(/EXISTS\s+.*inbox.wren/);
    expect(fs.existsSync(path.join(box.agentsHome, "wren"))).toBe(false);
  });

  it("rejects a bad name with a corrective suggestion, not just a complaint", () => {
    const box = sandbox();
    const result = run(box, ["Red Kite", "--no-verify"]);

    expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(result.output).toContain('Try "red-kite"');
    expect(fs.readdirSync(box.agentsHome)).toEqual([]);
  });

  it("rejects names that would escape the roots", () => {
    const box = sandbox();
    for (const name of ["../escape", "a/b", "-leading-hyphen", ".hidden"]) {
      const result = run(box, [name, "--no-verify"]);
      expect(result.status, `name ${name} was accepted`).toBe(EXIT.SCAFFOLD_ERROR);
    }
    expect(fs.readdirSync(box.agentsHome)).toEqual([]);
  });

  it("warns when MC_INBOX_AGENT_ALLOWLIST is set, because the agent is not on it", () => {
    const box = sandbox();
    const result = run(box, ["wren", "--no-verify"], {
      env: { MC_INBOX_AGENT_ALLOWLIST: "quill,atlas" },
    });
    expect(result.output).toContain("MC_INBOX_AGENT_ALLOWLIST");
    expect(result.output).toContain("restart");
  });

  it("says where the inbox went when INBOX_ROOT is unset, rather than guessing silently", () => {
    const box = sandbox();
    const result = run(box, ["wren", "--no-verify", "--inbox-root", box.inboxRoot], {
      env: { INBOX_ROOT: "" },
    });
    expect(result.output).toContain(box.inboxRoot);
    expect(result.output).toContain("--inbox-root");
  });

  it("warns when AGENTS_HOME and AGENTS_ROOT disagree instead of silently picking one", () => {
    const box = sandbox();
    const result = run(box, ["wren", "--no-verify"], {
      env: { AGENTS_ROOT: path.join(box.agentsHome, "..", "elsewhere") },
    });
    expect(result.output).toContain("AGENTS_ROOT");
    expect(result.output).toContain("differ");
    expect(fs.existsSync(path.join(box.agentsHome, "wren", "SOUL.md"))).toBe(true);
  });

  it("stops with a scaffold error when a declared import would not resolve", () => {
    const box = sandbox();
    run(box, ["wren", "--no-verify"]);
    // An import target that exists but is empty. This is the static half of the
    // check, and it is necessary rather than sufficient: it is reported as
    // such everywhere it appears, never as verification.
    fs.writeFileSync(path.join(box.agentsHome, "wren", "TOOLS.md"), "");

    const result = run(box, ["--verify-only", "wren"]);

    expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(result.output).toContain("TOOLS.md");
  });
});

describe("settings merge", () => {
  const FOREIGN = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "/opt/other-system/inject.sh" }] }],
    },
    env: { SOME_OTHER_SYSTEM: "1" },
    permissions: { deny: ["Bash(rm -rf /)"] },
  };

  /**
   * Stage the situation this guards against: another system got to the
   * settings file first. A hook installer that runs before the agent is
   * scaffolded leaves exactly this on disk, a `.claude/settings.json` in a
   * directory with no persona files in it yet.
   */
  function seedForeignSettings(box: Sandbox, name: string): string {
    const settingsPath = path.join(box.agentsHome, name, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(FOREIGN, null, 2));
    return settingsPath;
  }

  // The load-bearing test in this file after the FAILED case. A fresh write
  // over this file deletes another system's hooks silently, with nothing
  // anywhere to say it happened, and that has real precedent. So the assertion
  // is on the foreign material surviving, not on our own key being present.
  it("keeps another system's hooks, deny rules and env vars", () => {
    const box = sandbox();
    const settingsPath = seedForeignSettings(box, "wren");

    const result = run(box, ["wren", "--no-verify"]);
    expect(result.status, result.output).toBe(EXIT.CANNOT_VERIFY); // created, not verified

    const merged = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(merged.hooks).toEqual(FOREIGN.hooks);
    expect(merged.permissions).toEqual(FOREIGN.permissions);
    expect(merged.env.SOME_OTHER_SYSTEM).toBe("1");
    // And ours was added alongside, not instead.
    expect(merged.env.AGENT_NAME).toBe("wren");
  });

  it("does not overwrite a value that is already there", () => {
    const box = sandbox();
    const settingsPath = path.join(box.agentsHome, "wren", ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { AGENT_NAME: "already-set" } }));

    run(box, ["wren", "--no-verify"]);

    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).env.AGENT_NAME).toBe("already-set");
  });

  it("writes AGENT_NAME, INBOX_ROOT and AGENT_ROLE when there is no settings file yet", () => {
    const box = sandbox();
    run(box, ["wren", "--role", "keeps the notes", "--no-verify"]);
    const settings = JSON.parse(
      fs.readFileSync(path.join(box.agentsHome, "wren", ".claude", "settings.json"), "utf8"),
    );
    expect(settings).toEqual({
      env: { AGENT_NAME: "wren", INBOX_ROOT: box.inboxRoot, AGENT_ROLE: "keeps the notes" },
      promptSuggestionEnabled: false,
    });
  });

  /**
   * The env block is the only channel that reaches the environment of the
   * commands the agent runs, and the inbox CLI hard-errors without INBOX_ROOT.
   * An agent created without this line can address no one at all.
   */
  it("stamps the resolved inbox root, so the CLI and the application agree", () => {
    const box = sandbox();
    const elsewhere = path.join(box.home, "elsewhere-inbox");
    run(box, ["wren", "--inbox-root", elsewhere, "--no-verify"]);

    const settings = JSON.parse(
      fs.readFileSync(path.join(box.agentsHome, "wren", ".claude", "settings.json"), "utf8"),
    );
    // The value the run actually used, not the ambient one it was overridden with.
    expect(settings.env.INBOX_ROOT).toBe(elsewhere);
    expect(path.isAbsolute(settings.env.INBOX_ROOT)).toBe(true);
    expect(fs.existsSync(path.join(elsewhere, "wren", "inbox"))).toBe(true);
  });

  it("does not overwrite an inbox root that is already there", () => {
    const box = sandbox();
    const settingsPath = path.join(box.agentsHome, "wren", ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { INBOX_ROOT: "/already/set" } }));

    run(box, ["wren", "--no-verify"]);

    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).env.INBOX_ROOT).toBe("/already/set");
  });

  it("refuses rather than clobbering a settings file it cannot parse", () => {
    const box = sandbox();
    const settingsPath = path.join(box.agentsHome, "wren", ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, "{ this is not json");

    const result = run(box, ["wren", "--no-verify"]);

    expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
    // A file we cannot parse is a file whose contents we cannot promise to
    // preserve, so it is left exactly as found.
    expect(fs.readFileSync(settingsPath, "utf8")).toBe("{ this is not json");
  });
});

/**
 * Whether a created agent can actually USE the inbox CLI, which is three
 * separate facts: the root reaches its environment (above), the commands reach
 * its context (TOOLS.md), and the bare name resolves (the symlink).
 *
 * Every case here runs against the redirected HOME the sandbox provides, so
 * nothing in this file ever reads or writes the real ~/.local/bin.
 */
describe("inbox CLI reach", () => {
  const CLI = path.join(PACKAGE_ROOT, "bin", "inbox");
  const localBin = (box: Sandbox) => path.join(box.home, ".local", "bin", "inbox");

  it("stamps the CLI path and the agent's own name into TOOLS.md", () => {
    const box = sandbox();
    run(box, ["wren", "--no-verify"]);
    const tools = fs.readFileSync(path.join(box.agentsHome, "wren", "TOOLS.md"), "utf8");

    // The absolute path is the fallback that survives every way the symlink
    // install can be skipped, so it has to be in the file, not implied by it.
    expect(tools).toContain(CLI);
    expect(tools).toContain("wren");
    expect(tools).toContain("inbox reply");
    // And the placeholder is gone: a leftover marker means no substitution ran.
    expect(tools).not.toContain("stamped at creation");
  });

  it("installs the symlink by default, resolving to this package's CLI", () => {
    const box = sandbox();
    const result = run(box, ["wren", "--no-verify"]);

    expect(fs.lstatSync(localBin(box)).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(localBin(box))).toBe(fs.realpathSync(CLI));
    expect(result.output).toContain("linked");
  });

  it("installs nothing at all under --no-install-path", () => {
    const box = sandbox();
    const result = run(box, ["wren", "--no-install-path", "--no-verify"]);

    expect(fs.existsSync(localBin(box))).toBe(false);
    expect(fs.existsSync(path.join(box.home, ".local", "bin"))).toBe(false);
    expect(result.output).toContain("--no-install-path");
    // The agent is still fully created; the flag skips one convenience.
    expect(fs.existsSync(path.join(box.agentsHome, "wren", "SOUL.md"))).toBe(true);
  });

  // Somebody else's file is not ours to replace. The run carries on, because a
  // missing symlink costs the agent a shorthand and not the tool.
  it("leaves a foreign inbox at that path untouched and still creates the agent", () => {
    const box = sandbox();
    const target = localBin(box);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "#!/bin/sh\necho not ours\n", { mode: 0o755 });

    const result = run(box, ["wren", "--no-verify"]);

    expect(result.status, result.output).toBe(EXIT.CANNOT_VERIFY); // created, not verified
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("#!/bin/sh\necho not ours\n");
    expect(result.output).toContain("left exactly as found");
    expect(fs.existsSync(path.join(box.inboxRoot, "wren", "inbox"))).toBe(true);
  });
});

describe("verification", () => {
  it("reports VERIFIED when the reply carries the boot phrase", () => {
    const box = sandbox();
    // A runtime whose persona chain worked: it can quote a phrase that exists
    // nowhere but the file the chain was supposed to deliver.
    stubRuntime(
      box,
      `phrase=$(grep -oE 'boot-[0-9a-f]{16}' IDENTITY.md | head -n1)
echo "name: $(basename "$PWD")"
echo "boot phrase: $phrase"`,
    );

    const result = run(box, ["wren"], { stub: true });

    expect(result.status).toBe(EXIT.VERIFIED);
    expect(result.output).toContain("VERIFIED wren");
    expect(result.output).toContain(bootPhraseOf(box, "wren"));
    // "Created" and "verified" stay separate words, always.
    expect(result.output).toContain("CREATED wren");
  });

  it("reports FAILED when a fluent reply does not carry the boot phrase", () => {
    const box = sandbox();
    // THE case this verifier exists for. The stub answers the name correctly,
    // because the name leaks into context through the working directory, and a
    // check that asserted on the name would pass right here while the persona
    // never arrived. It cannot produce the phrase, because the phrase only
    // exists in the file the chain failed to deliver.
    stubRuntime(
      box,
      `echo "name: $(basename "$PWD")"
echo "I do not appear to have a boot phrase in my context."`,
    );

    const result = run(box, ["wren"], { stub: true });

    expect(result.status).toBe(EXIT.FAILED);
    expect(result.output).toContain("FAILED wren");
    // The reply is the diagnostic, so it is printed rather than summarised.
    expect(result.output).toContain("I do not appear to have a boot phrase in my context.");
    expect(result.output).not.toContain("VERIFIED wren");
  });

  it("reports FAILED, never a pass, when the runtime exits 0 with no output", () => {
    const box = sandbox();
    stubRuntime(box, "exit 0");

    const result = run(box, ["wren"], { stub: true });

    expect(result.status).toBe(EXIT.FAILED);
    expect(result.output).toContain("FAILED wren");
    expect(result.output).toContain("empty reply is a failure");
  });

  it("reports CANNOT VERIFY, and NOT exit 0, when there is no runtime on PATH", () => {
    const box = sandbox();

    const result = run(box, ["wren"], { stub: false });

    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    expect(result.status).not.toBe(EXIT.VERIFIED);
    expect(result.output).toContain("CANNOT VERIFY wren");
    expect(result.output).toContain("CREATED wren");
    // The degraded tier must say what it did not establish, in those words.
    expect(result.output).toContain("has NOT verified that the persona reaches the");
  });

  it("reports CANNOT VERIFY when the runtime exists but fails, and shows what it said", () => {
    const box = sandbox();
    // Present but unauthenticated: detected by exit status and stderr, never by
    // reading empty output as a signal about anything.
    stubRuntime(box, 'echo "Invalid API key. Please run /login" >&2\nexit 1');

    const result = run(box, ["wren"], { stub: true });

    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    expect(result.output).toContain("CANNOT VERIFY wren");
    expect(result.output).toContain("Invalid API key");
  });

  it("reports CANNOT VERIFY on --no-verify, because unverified must never read as verified", () => {
    const box = sandbox();
    stubRuntime(box, "echo unreachable");

    const result = run(box, ["wren", "--no-verify"], { stub: true });

    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    expect(result.output).toContain("CREATED wren");
    expect(result.output).not.toContain("VERIFIED wren\n");
  });

  it("--verify-only re-checks an existing agent without touching it", () => {
    const box = sandbox();
    run(box, ["wren", "--no-verify"]);
    const before = fs.readFileSync(path.join(box.agentsHome, "wren", "IDENTITY.md"), "utf8");
    stubRuntime(
      box,
      `echo "boot phrase: $(grep -oE 'boot-[0-9a-f]{16}' IDENTITY.md | head -n1)"`,
    );

    const result = run(box, ["--verify-only", "wren"], { stub: true });

    expect(result.status).toBe(EXIT.VERIFIED);
    expect(result.output).not.toContain("CREATED");
    expect(fs.readFileSync(path.join(box.agentsHome, "wren", "IDENTITY.md"), "utf8")).toBe(before);
  });

  it("--verify-only fails as a scaffold error when there is no such agent", () => {
    const box = sandbox();
    const result = run(box, ["--verify-only", "nobody"], { stub: true });
    expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
  });

  it("runs the probe from the agent home, because cwd is what assembles the context", () => {
    const box = sandbox();
    // A runtime that reports where it was launched. Launched anywhere else, the
    // probe would assemble a different project's context and prove nothing
    // about this agent.
    stubRuntime(box, 'echo "cwd: $PWD"');

    const result = run(box, ["wren"], { stub: true });

    expect(result.output).toContain(`cwd: ${path.join(box.agentsHome, "wren")}`);
  });
});
