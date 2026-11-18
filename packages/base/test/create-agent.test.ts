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
import { spawn, spawnSync } from "node:child_process";
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
 * in CI. Node is exposed through a directory holding only a node symlink, never
 * its install directory, because that directory can also hold a global `claude`
 * (npm -g puts runtimes beside node).
 */
function testPath(box: Sandbox, withStub: boolean): string {
  const nodeBin = path.join(path.dirname(box.stubBin), "node-only");
  fs.mkdirSync(nodeBin, { recursive: true });
  const link = path.join(nodeBin, "node");
  if (!fs.existsSync(link)) fs.symlinkSync(process.execPath, link);
  // /usr/bin and /bin stay: the script needs coreutils. A system-wide `claude`
  // there would still answer the probe, so this case assumes none is installed.
  const entries = [nodeBin, "/usr/bin", "/bin"];
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

  it("writes .model only when --model is given, and rejects anything unsafe for a shell", () => {
    const box = sandbox();
    expect(run(box, ["wren", "--no-verify"]).status).toBe(EXIT.CANNOT_VERIFY);
    expect(fs.existsSync(path.join(box.agentsHome, "wren", ".model"))).toBe(false);

    const withModel = run(box, ["fern", "--model", "claude-sonnet-5-5", "--no-verify"]);
    expect(withModel.status).toBe(EXIT.CANNOT_VERIFY);
    expect(fs.readFileSync(path.join(box.agentsHome, "fern", ".model"), "utf8")).toBe("claude-sonnet-5-5");

    const bad = run(box, ["moss", "--model", "x; rm -rf ~", "--no-verify"]);
    expect(bad.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(fs.existsSync(path.join(box.agentsHome, "moss"))).toBe(false);
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

  // ---------------------------------------------------------------------------
  // Where the inbox root comes from
  // ---------------------------------------------------------------------------
  //
  // The built-in fallback names a silo directory this project ships. An audit
  // read that literal as a hardcoded path and called the script broken. It is
  // not: the literal is the LAST of three sources, and both of the ones ahead
  // of it win. These pin that ordering, because the thing that would actually
  // be broken is a fallback that fired when something had been configured.

  it("uses INBOX_ROOT from the environment in preference to the built-in default", () => {
    const box = sandbox();
    const result = run(box, ["wren", "--no-verify"], {
      env: { INBOX_ROOT: box.inboxRoot },
    });
    expect(fs.existsSync(path.join(box.inboxRoot, "wren", "inbox"))).toBe(true);
    // The fallback did not fire, so it said nothing.
    expect(result.output).not.toContain("INBOX_ROOT is not set");
    expect(fs.existsSync(path.join(box.home, ".the-vault"))).toBe(false);
  });

  it("--inbox-root beats INBOX_ROOT, which beats the built-in default", () => {
    const box = sandbox();
    const chosen = path.join(box.home, "chosen-inbox");
    const result = run(box, ["wren", "--no-verify", "--inbox-root", chosen], {
      env: { INBOX_ROOT: box.inboxRoot },
    });
    expect(fs.existsSync(path.join(chosen, "wren", "inbox"))).toBe(true);
    expect(fs.existsSync(path.join(box.inboxRoot, "wren"))).toBe(false);
    expect(result.output).toContain(chosen);
  });

  it("calls the fallback a guess, and does not attribute it to a file that does not say it", () => {
    // The warning used to claim the value came from the application's
    // .env.example. That file ships INBOX_ROOT empty (there is no default),
    // so the citation dressed a guess up as a lookup.
    const box = sandbox();
    const result = run(box, ["wren", "--no-verify"], {
      env: { INBOX_ROOT: "" },
    });
    expect(result.output).toContain("INBOX_ROOT is not set");
    expect(result.output).toContain("guess");
    expect(result.output).not.toContain(".env.example");
    // It still says exactly where the agent went.
    expect(result.output).toContain(path.join(box.home, ".the-vault", "agents"));
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

/**
 * The memory loop is opt-in safe: wired when a built memory-layer checkout is
 * present, reported OFF (and never an error) when it is not.
 *
 * The fixture is a stand-in checkout that honours the documented install
 * interface (`scripts/install.sh --skip-build --settings FILE --agent NAME`,
 * exit 0 on success, hooks merged without clobbering, silo seeded under HOME).
 * It is a fixture, not the real thing: the real command is exercised by hand,
 * see the SPEC.
 */
describe("memory loop", () => {
  // Neutral name: where the fixture seeds a silo is the fixture's business.
  const SILO_DIR = ".memory-fixture";

  const FIXTURE_INSTALLER = `#!/usr/bin/env bash
set -euo pipefail
settings=""; agent=""
while [ $# -gt 0 ]; do
  case "$1" in
    --settings) settings="$2"; shift 2 ;;
    --agent) agent="$2"; shift 2 ;;
    --skip-build) shift ;;
    *) exit 1 ;;
  esac
done
root="$(cd -P "$(dirname "$0")/.." && pwd)"
[ -n "\${FIXTURE_FAIL:-}" ] && exit "$FIXTURE_FAIL"
# Like the real installer: the built hook scripts are required up front (exit 2)...
for s in user-prompt-submit on-stop on-pre-compact; do
  [ -f "$root/dist/claude-code/bin/$s.sh" ] || exit 2
done
echo "--settings $settings --agent $agent --skip-build" >> "$root/scripts/calls.log"
# ...the hooks are merged BEFORE tsx is looked for...
SETTINGS="$settings" node --input-type=module -e '
import * as fs from "node:fs";
const f = process.env.SETTINGS;
const d = JSON.parse(fs.readFileSync(f, "utf8"));
d.hooks = d.hooks ?? {};
const add = (event, matcher, script) => {
  const entry = { hooks: [{ type: "command", command: "/fixture/" + script + ".sh" }] };
  if (matcher) entry.matcher = matcher;
  d.hooks[event] = [...(d.hooks[event] ?? []), entry];
};
add("UserPromptSubmit", null, "user-prompt-submit");
add("Stop", null, "on-stop");
add("PreCompact", "auto", "on-pre-compact");
add("PreCompact", "manual", "on-pre-compact");
fs.writeFileSync(f, JSON.stringify(d, null, 2));
'
# Like the real installer, leave a backup beside the settings, and a temporary
# file when it dies mid-write.
echo '{}' > "$settings.fixture.bak"
[ -n "\${FIXTURE_FAIL_AFTER_MERGE:-}" ] && echo '{}' > "$settings.fixture.tmp"
# A detached grandchild with its output sent away, as a daemonising installer
# would leave behind. It must not inherit the caller's pipe.
[ -n "\${FIXTURE_DETACH:-}" ] && (sleep 3 </dev/null >/dev/null 2>&1 &)
# A hard link that appears while the install runs (caught only afterwards).
[ -n "\${FIXTURE_PLANT_HARDLINK:-}" ] && ln "$FIXTURE_PLANT_HARDLINK" "$settings.fixture.hard"
# A failure AFTER the hooks merged, and a hold so a test can signal mid-install.
[ -n "\${FIXTURE_FAIL_AFTER_MERGE:-}" ] && exit "$FIXTURE_FAIL_AFTER_MERGE"
if [ -n "\${FIXTURE_HOLD:-}" ]; then touch "$FIXTURE_HOLD"; sleep 2; fi
# ...and only then is a missing tsx fatal, which is why Deck checks it first.
[ -x "$root/node_modules/.bin/tsx" ] || exit 2
mkdir -p "$HOME/@SILO@/agents/$agent/memory/observations"
`;

  function memoryLayer(box: Sandbox, options: { built?: boolean; tsx?: boolean } = {}): string {
    const root = path.join(path.dirname(box.home), "memory-layer-with-any-name");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "install.sh"), FIXTURE_INSTALLER.replace("@SILO@", SILO_DIR), {
      mode: 0o755,
    });
    if (options.built ?? true) {
      const bin = path.join(root, "dist", "claude-code", "bin");
      fs.mkdirSync(bin, { recursive: true });
      for (const s of ["user-prompt-submit", "on-stop", "on-pre-compact"]) {
        fs.writeFileSync(path.join(bin, `${s}.sh`), "#!/bin/sh\n", { mode: 0o755 });
      }
    }
    if (options.tsx ?? true) {
      const nb = path.join(root, "node_modules", ".bin");
      fs.mkdirSync(nb, { recursive: true });
      fs.writeFileSync(path.join(nb, "tsx"), "#!/bin/sh\n", { mode: 0o755 });
    }
    return root;
  }

  const settingsOf = (box: Sandbox, name: string) =>
    JSON.parse(fs.readFileSync(path.join(box.agentsHome, name, ".claude", "settings.json"), "utf8"));

  it("wires the hooks into the agent's own settings and seeds its silo when the checkout is present", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const result = run(box, ["wren", "--no-verify"], {
      env: { MEMORY_LAYER_ROOT: root, USER_NAME: "pat" },
    });

    expect(result.status).toBe(EXIT.CANNOT_VERIFY); // unchanged: memory never moves the exit code
    expect(result.output).toMatch(/memory\s+on /);
    const settings = settingsOf(box, "wren");
    expect(Object.keys(settings.hooks).sort()).toEqual(["PreCompact", "Stop", "UserPromptSubmit"]);
    expect(settings.env.AGENT_NAME).toBe("wren");
    expect(settings.env.USER_NAME).toBe("pat");
    expect(fs.existsSync(path.join(box.home, SILO_DIR, "agents", "wren", "memory", "observations"))).toBe(true);

    // Per agent, not global: nothing was written to a home-level settings file.
    expect(fs.existsSync(path.join(box.home, ".claude", "settings.json"))).toBe(false);
    const calls = fs.readFileSync(path.join(root, "scripts", "calls.log"), "utf8");
    expect(calls).toContain(`--settings ${path.join(box.agentsHome, "wren", ".claude", "settings.json")}`);
    expect(calls).toContain("--agent wren");
    expect(calls).toContain("--skip-build");
  });

  it("honours --memory-root, and accepts a checkout under any name", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const result = run(box, ["wren", "--no-verify", "--memory-root", root]);
    expect(result.output).toMatch(/memory\s+on /);
  });

  it("reports memory OFF and still creates the agent when no checkout is configured", () => {
    const box = sandbox();
    const result = run(box, ["wren", "--no-verify"]);

    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    expect(result.output).toMatch(/memory\s+off \(MEMORY_LAYER_ROOT not set\)/);
    expect(fs.existsSync(path.join(box.inboxRoot, "wren", "inbox"))).toBe(true);
    const settings = settingsOf(box, "wren");
    expect(settings.hooks).toBeUndefined();
    expect(settings.env.USER_NAME).toBeUndefined();
    expect(fs.existsSync(path.join(box.home, SILO_DIR))).toBe(false);
  });

  it("reports OFF when the configured path is not a checkout", () => {
    const box = sandbox();
    const missing = path.join(path.dirname(box.home), "nothing-here");
    const result = run(box, ["wren", "--no-verify"], { env: { MEMORY_LAYER_ROOT: missing } });

    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    expect(result.output).toMatch(/memory\s+off \(no install command/);
    expect(settingsOf(box, "wren").hooks).toBeUndefined();
  });

  it("reports OFF when the checkout is present but unbuilt", () => {
    const box = sandbox();
    const root = memoryLayer(box, { built: false });
    const result = run(box, ["wren", "--no-verify"], { env: { MEMORY_LAYER_ROOT: root } });

    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    expect(result.output).toMatch(/memory off \(not built: missing/);
    expect(settingsOf(box, "wren").hooks).toBeUndefined();
  });

  it("reports OFF and writes NO hooks when the build is present but tsx is missing", () => {
    const box = sandbox();
    const root = memoryLayer(box, { tsx: false });
    const result = run(box, ["wren", "--no-verify"], { env: { MEMORY_LAYER_ROOT: root } });

    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    expect(result.output).toMatch(/memory off \(not built: missing node_modules\/\.bin\/tsx\)/);
    expect(settingsOf(box, "wren").hooks).toBeUndefined();
    expect(fs.existsSync(path.join(root, "scripts", "calls.log"))).toBe(false);
  });

  it("does not wire memory, or claim to, when the run is terminated during the probe", async () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const marker = path.join(box.home, "probe-started");
    stubRuntime(box, `touch "${marker}"\nsleep 2\necho "boot phrase: none"`);

    const child = spawn("bash", [SCRIPT, "wren"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: box.home,
        AGENTS_HOME: box.agentsHome,
        INBOX_ROOT: box.inboxRoot,
        PATH: testPath(box, true),
        MEMORY_LAYER_ROOT: root,
      },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));

    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(marker)).toBe(true);
    child.kill("SIGTERM");

    expect(await exited).toBe(143);
    expect(output).not.toMatch(/memory on /);
    expect(settingsOf(box, "wren").hooks).toBeUndefined();
    expect(fs.existsSync(path.join(root, "scripts", "calls.log"))).toBe(false);
  });

  it("restores the settings when the install fails AFTER the hooks were merged", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const result = run(box, ["wren", "--no-verify"], {
      env: { MEMORY_LAYER_ROOT: root, FIXTURE_FAIL_AFTER_MERGE: "3" },
    });

    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    // The fixture really did merge hooks before failing (the call was logged),
    // and Deck put the previous settings back.
    expect(fs.existsSync(path.join(root, "scripts", "calls.log"))).toBe(true);
    expect(settingsOf(box, "wren").hooks).toBeUndefined();
    expect(settingsOf(box, "wren").env.AGENT_NAME).toBe("wren");
    expect(result.output).toMatch(/memory off \(memory install exited 3; settings restored, nothing wired\)/);
    // What the installer left beside the settings is cleaned up too.
    const left = fs.readdirSync(path.join(box.agentsHome, "wren", ".claude"));
    expect(left).toEqual(["settings.json"]);
  });

  /** A planted symlink in .claude, whatever its name, must stop memory with no writes. */
  function plantedLinkCase(linkName: string): void {
    const box = sandbox();
    const root = memoryLayer(box);
    const victim = path.join(path.dirname(box.home), "global-settings.json");
    fs.writeFileSync(victim, '{"keep":"me"}');
    const dir = path.join(box.agentsHome, "wren", ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(victim, path.join(dir, linkName));

    const result = run(box, ["wren", "--no-verify"], {
      env: { MEMORY_LAYER_ROOT: root, USER_NAME: "pat" },
    });

    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    expect(result.output).toMatch(/memory off \(the agent's \.claude is not contained, or holds a symlink or hard link; nothing written\)/);
    expect(fs.readFileSync(victim, "utf8")).toBe('{"keep":"me"}');
    expect(settingsOf(box, "wren").hooks).toBeUndefined();
    expect(settingsOf(box, "wren").env.USER_NAME).toBeUndefined();
    expect(fs.existsSync(path.join(root, "scripts", "calls.log"))).toBe(false);
  }

  it("refuses memory when a temporary-file name in .claude is a planted symlink", () => {
    plantedLinkCase("settings.json.planted.tmp");
  });

  it("refuses memory when a backup name in .claude is a planted symlink", () => {
    plantedLinkCase("settings.json.planted.bak");
  });

  it("rejects a symlinked .claude directory before writing anything", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const elsewhere = path.join(path.dirname(box.home), "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.join(box.agentsHome, "wren"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(box.agentsHome, "wren", ".claude"));

    const result = run(box, ["wren", "--no-verify"], { env: { MEMORY_LAYER_ROOT: root } });

    expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(fs.existsSync(path.join(root, "scripts", "calls.log"))).toBe(false);
  });

  // Names in the style of an installer's temporary file and backup. The guard
  // refuses a link under ANY settings.json.<x> name, so these stand for the real
  // ones without needing to spell them.
  const TMP_STYLE = "settings.json.installer.tmp";
  const BAK_STYLE = "settings.json.installer.bak";

  it("refuses memory when a temporary-file-style name is a planted symlink", () => {
    plantedLinkCase(TMP_STYLE);
  });

  it("refuses memory when a backup-style name is a dangling planted symlink", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const victim = path.join(path.dirname(box.home), "not-created-yet.json");
    const dir = path.join(box.agentsHome, "wren", ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(victim, path.join(dir, BAK_STYLE));

    const result = run(box, ["wren", "--no-verify"], { env: { MEMORY_LAYER_ROOT: root } });

    expect(result.output).toMatch(/memory off \(the agent's \.claude is not contained/);
    expect(fs.existsSync(victim)).toBe(false);
  });

  it("refuses memory when a temporary-file-style name is a HARD link to another file", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const victim = path.join(path.dirname(box.home), "global-settings.json");
    fs.writeFileSync(victim, '{"keep":"me"}');
    const dir = path.join(box.agentsHome, "wren", ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.linkSync(victim, path.join(dir, TMP_STYLE));

    const result = run(box, ["wren", "--no-verify"], {
      env: { MEMORY_LAYER_ROOT: root, USER_NAME: "pat" },
    });

    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    expect(result.output).toMatch(/memory off \(the agent's \.claude is not contained, or holds a symlink or hard link/);
    expect(fs.readFileSync(victim, "utf8")).toBe('{"keep":"me"}');
    expect(fs.statSync(victim).nlink).toBe(2);
    expect(settingsOf(box, "wren").hooks).toBeUndefined();
    expect(fs.existsSync(path.join(root, "scripts", "calls.log"))).toBe(false);
  });

  it("refuses memory on any pre-existing settings.json.* entry it did not create", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const dir = path.join(box.agentsHome, "wren", ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json.stray"), "x");

    const result = run(box, ["wren", "--no-verify"], { env: { MEMORY_LAYER_ROOT: root } });

    expect(result.output).toMatch(/memory off \(unexpected settings\.json\.\* entries/);
    expect(fs.existsSync(path.join(root, "scripts", "calls.log"))).toBe(false);
  });

  it("rejects an agent home that is a symlink to another directory, before writing anything", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const fakeHome = path.join(path.dirname(box.home), "somewhere-else");
    fs.mkdirSync(fakeHome);
    fs.symlinkSync(fakeHome, path.join(box.agentsHome, "wren"));

    const result = run(box, ["wren", "--no-verify"], { env: { MEMORY_LAYER_ROOT: root } });

    expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(fs.readdirSync(fakeHome)).toEqual([]);
    expect(fs.existsSync(path.join(root, "scripts", "calls.log"))).toBe(false);
  });

  it("creates an agent when the agents home does not exist yet and a parent of it is a symlink", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const real = path.join(path.dirname(box.home), "real-var-home");
    fs.mkdirSync(real);
    const linked = path.join(path.dirname(box.home), "var-home");
    fs.symlinkSync(real, linked);
    const agents = path.join(linked, "agents"); // not created yet

    const result = run(box, ["wren", "--no-verify"], {
      env: { AGENTS_HOME: agents, MEMORY_LAYER_ROOT: root },
    });

    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    expect(result.output).toContain("CREATED wren");
    expect(result.output).toMatch(/memory on /);
    expect(fs.existsSync(path.join(real, "agents", "wren", "SOUL.md"))).toBe(true);
  });

  it("creates an agent when the not-yet-existing agents home is given with a trailing slash", () => {
    const box = sandbox();
    const agents = path.join(path.dirname(box.home), "fresh-agents") + "/";

    const result = run(box, ["wren", "--no-verify"], { env: { AGENTS_HOME: agents } });

    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    expect(result.output).toContain("CREATED wren");
    expect(fs.existsSync(path.join(agents, "wren", "SOUL.md"))).toBe(true);
  });

  it("refuses a settings.json that is already a hard link to another file, before writing", () => {
    const box = sandbox();
    const victim = path.join(path.dirname(box.home), "global-settings.json");
    fs.writeFileSync(victim, '{"keep":"me"}');
    const dir = path.join(box.agentsHome, "wren", ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.linkSync(victim, path.join(dir, "settings.json"));

    const result = run(box, ["wren", "--no-verify"]);

    expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(fs.readFileSync(victim, "utf8")).toBe('{"keep":"me"}');
    expect(fs.existsSync(path.join(box.agentsHome, "wren", "SOUL.md"))).toBe(false);
  });

  it("refuses when the user's own settings directory is a link pointing at the agent's", () => {
    const box = sandbox();
    const dir = path.join(box.agentsHome, "wren", ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(dir, path.join(box.home, ".claude")); // HOME/.claude -> agent's .claude

    const result = run(box, ["wren", "--no-verify"]);

    expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(fs.existsSync(path.join(box.agentsHome, "wren", "SOUL.md"))).toBe(false);
  });

  it("refuses a CLAUDE_CONFIG_DIR that is the agent's own settings directory", () => {
    const box = sandbox();
    const result = run(box, ["wren", "--no-verify"], {
      env: { CLAUDE_CONFIG_DIR: path.join(box.agentsHome, "wren", ".claude") },
    });

    expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
  });

  it("does not let a detached child of the install hold the caller's pipe open", async () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const started = Date.now();
    const child = spawn("bash", [SCRIPT, "wren", "--no-verify"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: box.home,
        AGENTS_HOME: box.agentsHome,
        INBOX_ROOT: box.inboxRoot,
        PATH: testPath(box, false),
        MEMORY_LAYER_ROOT: root,
        FIXTURE_DETACH: "1",
      },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    // "close" waits for every holder of the pipe; "exit" is the script itself.
    const status = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    const elapsed = Date.now() - started;

    // First prove the run did what the timing is about: scaffolding succeeded,
    // the install command really ran, and the agent ended up wired. Only then
    // is a quick finish evidence about the pipe and not about an early failure.
    expect(status).toBe(EXIT.CANNOT_VERIFY); // created, verification skipped by --no-verify
    expect(output).toContain("CREATED wren");
    expect(fs.existsSync(path.join(root, "scripts", "calls.log"))).toBe(true);
    expect(output).toMatch(/memory on /);
    expect(Object.keys(settingsOf(box, "wren").hooks).sort()).toEqual(["PreCompact", "Stop", "UserPromptSubmit"]);

    // The detached sleep lasts 3s. Had it inherited the pipe, close would wait for it.
    expect(elapsed).toBeLessThan(2500);
  });

  it("refuses an agents home with a .. component that a symlink would resolve differently", () => {
    const box = sandbox();
    const top = path.dirname(box.home);
    const real = path.join(top, "real");
    fs.mkdirSync(path.join(real, "sub"), { recursive: true });
    fs.symlinkSync(path.join(real, "sub"), path.join(top, "l"));
    // By text, <top>/l/.. is <top>; through the symlink the kernel sees <top>/real.
    const result = run(box, ["wren", "--no-verify"], { env: { AGENTS_HOME: `${top}/l/..` } });

    expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(fs.existsSync(path.join(real, "wren"))).toBe(false);
    expect(fs.existsSync(path.join(top, "wren"))).toBe(false);
  });

  it("reports PARTIAL, never on, when a hard link appears while the install runs", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const victim = path.join(path.dirname(box.home), "global-settings.json");
    fs.writeFileSync(victim, '{"keep":"me"}');

    const result = run(box, ["wren", "--no-verify"], {
      env: { MEMORY_LAYER_ROOT: root, USER_NAME: "pat", FIXTURE_PLANT_HARDLINK: victim },
    });

    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    expect(result.output).toMatch(/memory off \(PARTIAL: the agent's \.claude failed its containment check after the install/);
    expect(result.output).not.toMatch(/memory on /);
    // USER_NAME was not stamped after the check failed.
    expect(settingsOf(box, "wren").env.USER_NAME).toBeUndefined();
  });

  it("prints a memory line when a signal arrives inside the exit handler but outside the installer", async () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const watch = path.join(box.agentsHome, "wren", ".claude", "settings.json.fixture.bak");
    const mark = path.join(box.home, "node-held");
    // A node that stalls once the fixture installer has run: the first node
    // call after the installer is the post-install containment check, which is
    // inside the exit handler and after the installer.
    fs.writeFileSync(
      path.join(box.stubBin, "node"),
      `#!/bin/sh\nif [ -e "${watch}" ]; then touch "${mark}"; sleep 2; fi\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 },
    );

    const child = spawn("bash", [SCRIPT, "wren", "--no-verify"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: box.home,
        AGENTS_HOME: box.agentsHome,
        INBOX_ROOT: box.inboxRoot,
        PATH: testPath(box, true),
        MEMORY_LAYER_ROOT: root,
      },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));

    for (let i = 0; i < 100 && !fs.existsSync(mark); i++) await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(mark)).toBe(true);
    child.kill("SIGTERM");

    expect(await exited).toBe(143);
    expect(output).toMatch(/create-agent: memory off \(PARTIAL: interrupted after the memory install ran/);
  });

  it("reports PARTIAL, not a restore, when a failed install leaves settings.json replaced by a directory", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    // Make the restore fail portably: the failing installer replaces
    // settings.json with a directory, which cannot be written back over.
    const installer = path.join(root, "scripts", "install.sh");
    fs.writeFileSync(
      installer,
      fs
        .readFileSync(installer, "utf8")
        .replace('[ -n "${FIXTURE_FAIL_AFTER_MERGE:-}" ] && exit "$FIXTURE_FAIL_AFTER_MERGE"',
          '[ -n "${FIXTURE_FAIL_AFTER_MERGE:-}" ] && { rm -f "$settings"; mkdir "$settings"; exit "$FIXTURE_FAIL_AFTER_MERGE"; }'),
      { mode: 0o755 },
    );
    const result = run(box, ["wren", "--no-verify"], {
      env: { MEMORY_LAYER_ROOT: root, FIXTURE_FAIL_AFTER_MERGE: "3" },
    });

    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    expect(result.output).toMatch(/memory off \(PARTIAL: the agent's \.claude failed its containment check after the install/);
  });

  it("refuses memory when the settings already route to a different agent", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const settingsFile = path.join(box.agentsHome, "wren", ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ env: { AGENT_NAME: "fern" } }));

    const result = run(box, ["wren", "--no-verify"], { env: { MEMORY_LAYER_ROOT: root } });

    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    expect(result.output).toMatch(/memory off \(settings env\.AGENT_NAME is "fern", not "wren"\)/);
    expect(settingsOf(box, "wren").hooks).toBeUndefined();
    expect(fs.existsSync(path.join(root, "scripts", "calls.log"))).toBe(false);
    expect(fs.existsSync(path.join(box.home, SILO_DIR))).toBe(false);
  });

  it("rejects a symlinked per-agent settings file before writing anything", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const elsewhere = path.join(path.dirname(box.home), "global-settings.json");
    fs.writeFileSync(elsewhere, '{"keep":"me"}');
    const dir = path.join(box.agentsHome, "wren", ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(dir, "settings.json"));

    const result = run(box, ["wren", "--no-verify"], { env: { MEMORY_LAYER_ROOT: root } });

    expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(result.output).toContain("symlink");
    expect(fs.readFileSync(elsewhere, "utf8")).toBe('{"keep":"me"}');
    expect(fs.existsSync(path.join(box.agentsHome, "wren", "SOUL.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, "scripts", "calls.log"))).toBe(false);
  });

  it("leaves memory unwired, with a visible reason, when the verification probe fails", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    stubRuntime(box, 'echo "boot phrase: wrong"');
    const result = run(box, ["wren"], { stub: true, env: { MEMORY_LAYER_ROOT: root } });

    expect(result.status).toBe(EXIT.FAILED);
    expect(result.output).toMatch(/memory off \(verification did not pass/);
    expect(settingsOf(box, "wren").hooks).toBeUndefined();
    expect(fs.existsSync(path.join(root, "scripts", "calls.log"))).toBe(false);
  });

  it("leaves memory unwired when the probe runtime errors out", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    stubRuntime(box, "exit 9");
    const result = run(box, ["wren"], { stub: true, env: { MEMORY_LAYER_ROOT: root } });

    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    expect(result.output).toMatch(/memory off \(verification did not pass/);
    expect(settingsOf(box, "wren").hooks).toBeUndefined();
  });

  it("leaves a visible report, and the settings restored, when interrupted during the memory install", async () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const hold = path.join(box.home, "install-started");
    const tmp = path.join(path.dirname(box.home), "tmp-for-snapshot");
    fs.mkdirSync(tmp);

    const child = spawn("bash", [SCRIPT, "wren", "--no-verify"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: box.home,
        AGENTS_HOME: box.agentsHome,
        INBOX_ROOT: box.inboxRoot,
        PATH: testPath(box, false),
        MEMORY_LAYER_ROOT: root,
        FIXTURE_HOLD: hold,
        TMPDIR: tmp,
      },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));

    for (let i = 0; i < 100 && !fs.existsSync(hold); i++) await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(hold)).toBe(true);
    // While the install is held, the snapshot exists and is private to the owner.
    const during = fs.readdirSync(tmp);
    expect(during).toHaveLength(1);
    expect(fs.statSync(path.join(tmp, during[0])).mode & 0o777).toBe(0o600);
    child.kill("SIGTERM");

    expect(await exited).toBe(143);
    expect(output).toMatch(/memory off \(interrupted during memory install; settings restored, nothing wired\)/);
    expect(settingsOf(box, "wren").hooks).toBeUndefined();
    // The settings snapshot does not outlive the run.
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("states memory is off in the summary when there is nothing to wire", () => {
    const box = sandbox();
    const result = run(box, ["wren", "--no-verify"]);
    expect(result.output).toMatch(/memory\s+off \(MEMORY_LAYER_ROOT not set\)/);
    expect(result.output).not.toContain("to be wired");
  });

  it("wires the PreCompact auto and manual matchers", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    run(box, ["wren", "--no-verify"], { env: { MEMORY_LAYER_ROOT: root } });
    const matchers = settingsOf(box, "wren").hooks.PreCompact.map((e: { matcher: string }) => e.matcher);
    expect(matchers).toEqual(["auto", "manual"]);
  });

  it("wires memory only AFTER the verification probe, so the probe is not a first memory", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    // The runtime records whether hooks were already in the agent's settings
    // at the moment it was asked, then answers with the boot phrase.
    stubRuntime(
      box,
      `grep -q '"hooks"' .claude/settings.json && echo hooks-present > "${path.join(box.home, "probe-saw")}" || echo hooks-absent > "${path.join(box.home, "probe-saw")}"
echo "boot phrase: $(grep -oE 'boot-[0-9a-f]{16}' IDENTITY.md | head -n1)"`,
    );
    const result = run(box, ["wren"], { stub: true, env: { MEMORY_LAYER_ROOT: root } });

    expect(result.status).toBe(EXIT.VERIFIED);
    expect(fs.readFileSync(path.join(box.home, "probe-saw"), "utf8").trim()).toBe("hooks-absent");
    expect(result.output).toMatch(/memory on /);
    expect(settingsOf(box, "wren").hooks).toBeDefined();
  });

  it("reports OFF, with the exit code, when the install command fails, and still creates the agent", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const result = run(box, ["wren", "--no-verify"], {
      env: { MEMORY_LAYER_ROOT: root, FIXTURE_FAIL: "2" },
    });

    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    expect(result.output).toMatch(/memory\s+off \(memory install exited 2; settings restored/);
    expect(fs.existsSync(path.join(box.agentsHome, "wren", "SOUL.md"))).toBe(true);
    expect(fs.existsSync(path.join(box.inboxRoot, "wren", "inbox"))).toBe(true);
  });

  it("--no-memory leaves memory off even when a checkout is present", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const result = run(box, ["wren", "--no-verify", "--no-memory"], { env: { MEMORY_LAYER_ROOT: root } });

    expect(result.output).toMatch(/memory\s+off \(--no-memory\)/);
    expect(fs.existsSync(path.join(root, "scripts", "calls.log"))).toBe(false);
  });

  it("warns, but stays on, when USER_NAME is unset", () => {
    const box = sandbox();
    const root = memoryLayer(box);
    const result = run(box, ["wren", "--no-verify"], { env: { MEMORY_LAYER_ROOT: root } });

    expect(result.output).toMatch(/memory\s+on /);
    expect(result.stderr).toContain("USER_NAME is not set");
    expect(settingsOf(box, "wren").env.USER_NAME).toBeUndefined();
  });
});

describe("--kind, --peer and --check-name", () => {
  it("refuses an unknown --kind and creates nothing", () => {
    const box = sandbox();
    const result = run(box, ["wren", "--kind", "wizard", "--no-verify"]);
    expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(fs.readdirSync(box.agentsHome)).toEqual([]);
    expect(fs.readdirSync(box.inboxRoot)).toEqual([]);
  });

  it("stamps the role brief and the peer into CLAUDE.md and writes .kind and .peer", () => {
    const box = sandbox();
    run(box, ["ada", "--kind", "platform", "--peer", "forge", "--no-verify"]);
    const home = path.join(box.agentsHome, "ada");
    expect(fs.readFileSync(path.join(home, ".kind"), "utf8")).toBe("platform");
    expect(fs.readFileSync(path.join(home, ".peer"), "utf8")).toBe("forge");
    const claude = fs.readFileSync(path.join(home, "CLAUDE.md"), "utf8");
    expect(claude).toContain("You are the platform agent, the brain surgeon");
    expect(claude).toContain("**forge**");
    expect(claude).toContain(path.join(PACKAGE_ROOT, "bin", "create-agent.sh"));
    expect(claude).toContain("Ask before changing anything outside the agents folder and Deck's own");
    expect(claude).not.toContain("<peer>");
    // The persona chain is still intact.
    expect(claude).toContain("@IDENTITY.md");
  });

  it("--check-name writes nothing, and refuses a bad or taken name", () => {
    const box = sandbox();
    expect(run(box, ["--check-name", "wren"]).status).toBe(0);
    expect(fs.readdirSync(box.agentsHome)).toEqual([]);
    expect(fs.readdirSync(box.inboxRoot)).toEqual([]);
    expect(fs.readdirSync(box.home)).toEqual([]);

    expect(run(box, ["--check-name", "Bad Name"]).status).toBe(EXIT.SCAFFOLD_ERROR);
    run(box, ["wren", "--no-verify"]);
    expect(run(box, ["--check-name", "wren"]).status).toBe(EXIT.SCAFFOLD_ERROR);
  });

  it("rejects a flag-shaped --check-name value instead of parsing it as an option", () => {
    const box1 = sandbox();
    const r = run(box1, ["--check-name", "--help"]);
    expect(r.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(r.output).not.toContain("Usage:");
  });

  it("refuses to write .peer through a symlink", () => {
    const box1 = sandbox();
    const outside = path.join(box1.home, "outside");
    fs.writeFileSync(outside, "untouched");
    fs.mkdirSync(path.join(box1.agentsHome, "wren"));
    fs.symlinkSync(outside, path.join(box1.agentsHome, "wren", ".peer"));
    const r = run(box1, ["wren", "--kind", "assistant", "--peer", "forge", "--no-verify"]);
    expect(r.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
    // .peer is written first, so a refused .peer leaves no completeness marker.
    expect(fs.existsSync(path.join(box1.agentsHome, "wren", ".kind"))).toBe(false);
  });

  it("a directory at .kind is refused up front: no .peer, no persona files", () => {
    const box1 = sandbox();
    fs.mkdirSync(path.join(box1.agentsHome, "wren", ".kind"), { recursive: true });
    const r = run(box1, ["wren", "--kind", "assistant", "--peer", "forge", "--no-verify"]);
    expect(r.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(fs.existsSync(path.join(box1.agentsHome, "wren", ".peer"))).toBe(false);
    expect(fs.existsSync(path.join(box1.agentsHome, "wren", "SOUL.md"))).toBe(false);
  });

  it("rejects an empty --check-name value instead of prompting", () => {
    const box1 = sandbox();
    const r = run(box1, ["--check-name", ""]);
    expect(r.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(r.output).toContain("cannot be an agent name");
  });

  it("checks marker destinations before creating anything, so a retry works", () => {
    const box1 = sandbox();
    const marker = path.join(box1.agentsHome, "wren", ".peer");
    fs.mkdirSync(marker, { recursive: true });
    const args = ["wren", "--kind", "assistant", "--peer", "forge", "--no-verify"];
    expect(run(box1, args).status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(fs.existsSync(path.join(box1.agentsHome, "wren", "SOUL.md"))).toBe(false);
    expect(fs.readdirSync(box1.inboxRoot)).toEqual([]);

    fs.rmdirSync(marker);
    expect(run(box1, args).status).toBe(EXIT.CANNOT_VERIFY);
    expect(fs.readFileSync(path.join(box1.agentsHome, "wren", ".kind"), "utf8")).toBe("assistant");
  });

  it("rejects --check-name after a positional name instead of overwriting it", () => {
    const box1 = sandbox();
    expect(run(box1, ["wren", "--check-name", "fern"]).status).toBe(EXIT.SCAFFOLD_ERROR);
  });
});

describe("secrets, person, member kind and --status", () => {
  it("never prints the credential a failing CLI echoes, on stderr or stdout", () => {
    const b = sandbox();
    run(b, ["wren", "--no-verify"]);
    const secret = "plainsecretvalue987654";
    fs.writeFileSync(path.join(b.agentsHome, "wren", ".env.secrets"), `export SOME_TOKEN=${secret}\nexport ANTHROPIC_API_KEY=sk-ant-echoed-0123456789\n`);
    stubRuntime(b, `echo "auth failed for $SOME_TOKEN $ANTHROPIC_API_KEY" >&2; exit 1`);
    const failed = run(b, ["--verify-only", "wren"], { stub: true });
    expect(failed.status).toBe(EXIT.CANNOT_VERIFY);
    expect(failed.output).toContain("[redacted]");
    expect(failed.output).not.toContain(secret);
    expect(failed.output).not.toContain("sk-ant-echoed");
    stubRuntime(b, `echo "my token is $SOME_TOKEN and $ANTHROPIC_API_KEY"`);
    const fluent = run(b, ["--verify-only", "wren"], { stub: true });
    expect(fluent.status).toBe(EXIT.FAILED);
    expect(fluent.output).not.toContain(secret);
    expect(fluent.output).not.toContain("sk-ant-echoed");
  });

  it("the probe sees an exported variable set only in the agent's .env.secrets", () => {
    const box1 = sandbox();
    run(box1, ["wren", "--no-verify"]);
    fs.writeFileSync(path.join(box1.agentsHome, "wren", ".env.secrets"), "export PROBE_SECRET=from-secrets\n");
    stubRuntime(box1, `[ "$PROBE_SECRET" = from-secrets ] && echo "boot phrase: $(grep -oE 'boot-[0-9a-f]{16}' IDENTITY.md | head -n1)"`);
    // Answers only if the variable reached it, so VERIFIED proves the probe saw it.
    expect(run(box1, ["--verify-only", "wren"], { stub: true }).status).toBe(EXIT.VERIFIED);
    fs.rmSync(path.join(box1.agentsHome, "wren", ".env.secrets"));
    expect(run(box1, ["--verify-only", "wren"], { stub: true }).status).not.toBe(EXIT.VERIFIED);
  });

  it("--person is stamped into the assistant's brief, and the section is left out without it", () => {
    const box1 = sandbox();
    run(box1, ["ada", "--kind", "assistant", "--peer", "forge", "--person", "sam", "--no-verify"]);
    const claude = fs.readFileSync(path.join(box1.agentsHome, "ada", "CLAUDE.md"), "utf8");
    expect(claude).toContain("## First conversation");
    expect(claude).toContain("**sam**");
    expect(claude).not.toContain("person-only");

    const r = run(box1, ["bea", "--kind", "assistant", "--peer", "forge", "--no-verify"]);
    expect(r.output).toContain("no --person given");
    expect(fs.readFileSync(path.join(box1.agentsHome, "bea", "CLAUDE.md"), "utf8")).not.toContain("First conversation");
  });

  it("--kind member stamps the member brief naming the assistant", () => {
    const box1 = sandbox();
    run(box1, ["scribe", "--kind", "member", "--peer", "ada", "--no-verify"]);
    expect(fs.readFileSync(path.join(box1.agentsHome, "scribe", ".kind"), "utf8")).toBe("member");
    const claude = fs.readFileSync(path.join(box1.agentsHome, "scribe", "CLAUDE.md"), "utf8");
    expect(claude).toContain("## Your role: a member");
    expect(claude).toContain("**ada**");
  });

  describe("--status", () => {
    const status = (b: Sandbox, args: string[] = []) => run(b, ["--status", "scribe", ...args]);
    const created = () => {
      const b = sandbox();
      run(b, ["scribe", "--kind", "member", "--peer", "ada", "--no-verify"]);
      return b;
    };
    const home = (b: Sandbox) => path.join(b.agentsHome, "scribe");
    const snapshot = (b: Sandbox) =>
      fs.readdirSync(home(b), { recursive: true }).map(String).sort().join("\n");

    it("reads absent, incomplete and complete, and writes nothing", () => {
      const b = sandbox();
      expect(status(b).stdout.trim()).toBe("absent");
      expect(status(b).status).toBe(0);
      expect(fs.readdirSync(b.agentsHome)).toEqual([]);

      const c = created();
      const kind = fs.readFileSync(path.join(home(c), ".kind"));
      fs.rmSync(path.join(home(c), ".kind"));
      const before = snapshot(c);
      expect(status(c).stdout.trim()).toBe("incomplete");
      expect(snapshot(c)).toBe(before);
      fs.writeFileSync(path.join(home(c), ".kind"), kind);
      expect(status(c, ["--kind", "member", "--peer", "ada"]).stdout.trim()).toBe("complete");
    });

    it("a lone .kind marker is never complete", () => {
      const b = sandbox();
      fs.mkdirSync(home(b), { recursive: true });
      fs.writeFileSync(path.join(home(b), ".kind"), "member");
      expect(status(b).stdout.trim()).toBe("incomplete");
    });

    it.each([
      ["a different kind than intended", (b: Sandbox) => fs.writeFileSync(path.join(home(b), ".kind"), "platform")],
      ["an unknown kind", (b: Sandbox) => fs.writeFileSync(path.join(home(b), ".kind"), "intruder")],
      ["a different peer than intended", (b: Sandbox) => fs.writeFileSync(path.join(home(b), ".peer"), "other")],
      ["a malformed peer", (b: Sandbox) => fs.writeFileSync(path.join(home(b), ".peer"), "Not A Name")],
      ["a missing persona file", (b: Sandbox) => fs.rmSync(path.join(home(b), "SOUL.md"))],
      ["a missing settings file", (b: Sandbox) => fs.rmSync(path.join(home(b), ".claude", "settings.json"))],
      ["a missing inbox directory", (b: Sandbox) => fs.rmSync(path.join(b.inboxRoot, "scribe"), { recursive: true })],
      ["no boot phrase", (b: Sandbox) => fs.writeFileSync(path.join(home(b), "IDENTITY.md"), "hand made\n")],
      ["a foreign brief", (b: Sandbox) => fs.writeFileSync(path.join(home(b), "CLAUDE.md"), "# mine\n")],
      ["settings that are not JSON", (b: Sandbox) => fs.writeFileSync(path.join(home(b), ".claude", "settings.json"), "{")],
      ["an empty .runtime", (b: Sandbox) => fs.writeFileSync(path.join(home(b), ".runtime"), "")],
      ["a role brief for a different kind", (b: Sandbox) => {
        fs.writeFileSync(path.join(home(b), ".kind"), "assistant");
        fs.writeFileSync(path.join(home(b), "CLAUDE.md"), "# x\n\nYou are the platform agent\n**ada**\n");
      }],
      ["a symlinked .kind", (b: Sandbox) => {
        fs.rmSync(path.join(home(b), ".kind"));
        fs.writeFileSync(path.join(b.home, "elsewhere"), "member");
        fs.symlinkSync(path.join(b.home, "elsewhere"), path.join(home(b), ".kind"));
      }],
    ])("reads incomplete, never complete, for %s", (_label, damage) => {
      const b = created();
      expect(status(b, ["--kind", "member", "--peer", "ada"]).stdout.trim()).toBe("complete");
      damage(b);
      const before = snapshot(b);
      const r = status(b, ["--kind", "member", "--peer", "ada"]);
      expect(r.stdout.trim()).toBe("incomplete");
      expect(snapshot(b)).toBe(before);
    });

    it("a dangling agent-home symlink reads incomplete, not absent", () => {
      const b = sandbox();
      fs.symlinkSync(path.join(b.home, "nowhere"), home(b));
      expect(status(b).stdout.trim()).toBe("incomplete");
    });

    it("an unreadable file reads incomplete", () => {
      if (process.getuid?.() === 0) return;
      const b = created();
      fs.chmodSync(path.join(home(b), "SOUL.md"), 0o000);
      expect(status(b).stdout.trim()).toBe("incomplete");
      fs.chmodSync(path.join(home(b), "SOUL.md"), 0o644);
    });
  });
});
