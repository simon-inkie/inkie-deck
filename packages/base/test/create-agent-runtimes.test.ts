/**
 * create-agent.sh --runtime codex|agy, the Codex hooks and first-run.sh's
 * runtime pass-through.
 *
 * Core behaviour only: each runtime gets the persona file it actually reads,
 * the Codex hooks file is valid and points at hooks that run, the local checks
 * catch a persona that would arrive without its boot phrase, and the live probe
 * is never run unless asked for. That last one is checked with a stub runtime
 * that records being called, because a probe that ran by default would spend
 * the user's credit on every creation.
 *
 * Same isolation as create-agent.test.ts: HOME, the agents home and the inbox
 * root are temporary, and PATH is built from scratch, so no real runtime on the
 * machine can answer.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const BIN = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "bin");
const CREATE = path.join(BIN, "create-agent.sh");
const FIRST_RUN = path.join(BIN, "first-run.sh");
const EXIT = { VERIFIED: 0, SCAFFOLD_ERROR: 1, FAILED: 3, CANNOT_VERIFY: 4 } as const;

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

interface Box {
  home: string;
  agentsHome: string;
  inboxRoot: string;
  stubBin: string;
  probeLog: string;
}

function box(): Box {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "create-agent-runtimes-"));
  tempRoots.push(root);
  const b = {
    home: path.join(root, "home"),
    agentsHome: path.join(root, "agents"),
    inboxRoot: path.join(root, "inbox"),
    stubBin: path.join(root, "bin"),
    probeLog: path.join(root, "probe.log"),
  };
  for (const d of [b.home, b.agentsHome, b.inboxRoot, b.stubBin]) fs.mkdirSync(d, { recursive: true });
  return b;
}

/**
 * A stand-in runtime that logs its arguments and environment, then either
 * quotes the boot phrase from the runtime's persona fixture or answers without it.
 */
function stubRuntime(b: Box, name: string, answers: boolean): void {
  const persona = name === "agy" ? "GEMINI.md" : "IDENTITY.md";
  const reply = answers
    ? `echo "name: x"; grep -oE "boot-[0-9a-f]{16}" ${persona} | head -n1 | sed "s/^/boot phrase: /"`
    : 'echo "name: x"; echo "boot phrase: NONE"';
  fs.writeFileSync(
    path.join(b.stubBin, name),
    `#!/usr/bin/env bash\nprintf '%s|AGENT_NAME=%s|INBOX_ROOT=%s\\n' "$*" "$AGENT_NAME" "$INBOX_ROOT" >> ${JSON.stringify(b.probeLog)}\n${reply}\n`,
    { mode: 0o755 },
  );
}

function run(b: Box, script: string, args: string[], env: Record<string, string> = {}) {
  const nodeBin = path.join(path.dirname(b.stubBin), "node-only");
  fs.mkdirSync(nodeBin, { recursive: true });
  const link = path.join(nodeBin, "node");
  if (!fs.existsSync(link)) fs.symlinkSync(process.execPath, link);
  const result = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      HOME: b.home,
      AGENTS_HOME: b.agentsHome,
      INBOX_ROOT: b.inboxRoot,
      PATH: [b.stubBin, nodeBin, "/usr/bin", "/bin"].join(path.delimiter),
      ...env,
    },
  });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  return { status: result.status ?? -1, output };
}

const create = (b: Box, args: string[], env?: Record<string, string>) =>
  run(b, CREATE, [...args, "--no-install-path"], env);
const home = (b: Box, name: string) => path.join(b.agentsHome, name);
const read = (b: Box, name: string, file: string) => fs.readFileSync(path.join(home(b, name), file), "utf8");
const bootPhrase = (b: Box, name: string) => /boot-[0-9a-f]{16}/.exec(read(b, name, "IDENTITY.md"))![0];
const probeCalls = (b: Box) => (fs.existsSync(b.probeLog) ? fs.readFileSync(b.probeLog, "utf8") : "");

/** First word of a hook command as create-agent.sh writes it: single-quoted. */
const hookBinary = (command: string) => /^'([^']+)'/.exec(command)![1];

function runHook(command: string, cwd: string, input: string, env: Record<string, string>) {
  return spawnSync("bash", ["-c", command], {
    cwd,
    input,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", ...env },
  });
}

describe("files per runtime", () => {
  it("claude gets no Codex or Antigravity files", () => {
    const b = box();
    expect(create(b, ["wren", "--no-verify"]).status).toBe(EXIT.CANNOT_VERIFY);
    for (const f of ["AGENTS.md", "GEMINI.md", ".codex", ".inbox-root"]) {
      expect(fs.existsSync(path.join(home(b, "wren"), f)), f).toBe(false);
    }
    expect(read(b, "wren", ".runtime")).toBe("claude");
  });

  it("codex gets AGENTS.md, a valid hooks file whose commands exist, and the inbox root", () => {
    const b = box();
    create(b, ["cobalt", "--runtime", "codex", "--role", "reviews pull requests", "--no-verify"]);
    expect(read(b, "cobalt", ".runtime")).toBe("codex");
    expect(read(b, "cobalt", ".inbox-root")).toBe(b.inboxRoot);
    expect(read(b, "cobalt", "AGENTS.md")).toMatch(/^# cobalt, reviews pull requests\n/);
    // The shared persona files are still there, so the persona has a source.
    for (const f of ["IDENTITY.md", "SOUL.md", "TOOLS.md", "USER.md"]) {
      expect(fs.existsSync(path.join(home(b, "cobalt"), f)), f).toBe(true);
    }
    // TOOLS.md must not tell a Codex agent its env comes from Claude settings.
    expect(read(b, "cobalt", "TOOLS.md")).toContain("set for you by the launcher");

    const hooks = JSON.parse(read(b, "cobalt", ".codex/hooks.json"));
    const start = hooks.hooks.SessionStart[0];
    expect(start.matcher).toBe("startup|resume|compact");
    const prompt = hooks.hooks.UserPromptSubmit[0].hooks[0];
    for (const hook of [start.hooks[0], prompt]) {
      expect(hook.type).toBe("command");
      expect(() => fs.accessSync(hookBinary(hook.command), fs.constants.X_OK)).not.toThrow();
    }
    expect(start.hooks[0].command).toContain(`--agent-home '${home(b, "cobalt")}'`);
    expect(JSON.stringify(hooks)).not.toMatch(/<[a-z-]+-command>/);
  });

  it.each(["existing file", "hook symlink", "directory symlink"])("codex refuses to scaffold over an existing hook path (%s)", (kind) => {
    const b = box();
    const codexDir = path.join(home(b, "cobalt"), ".codex");
    const hooksFile = path.join(codexDir, "hooks.json");
    const elsewhere = path.join(b.home, "hooks.json");
    fs.mkdirSync(home(b, "cobalt"));
    if (kind === "directory symlink") {
      fs.symlinkSync(b.home, codexDir);
    } else {
      fs.mkdirSync(codexDir);
      if (kind === "hook symlink") fs.symlinkSync(elsewhere, hooksFile);
    }
    fs.writeFileSync(kind === "existing file" ? hooksFile : elsewhere, "keep this file\n");
    const result = create(b, ["cobalt", "--runtime", "codex", "--no-verify"]);
    expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(result.output).toContain(kind === "directory symlink" ? "is a symlink" : "already exists; leaving it untouched");
    expect(fs.readFileSync(hooksFile, "utf8")).toBe("keep this file\n");
    expect(fs.readdirSync(home(b, "cobalt"))).toEqual([".codex"]);
  });

  it("agy gets GEMINI.md with the persona inlined, boot phrase included", () => {
    const b = box();
    create(b, ["gale", "--runtime", "agy", "--no-verify"]);
    const gemini = read(b, "gale", "GEMINI.md");
    expect(read(b, "gale", ".runtime")).toBe("agy");
    expect(read(b, "gale", ".inbox-root")).toBe(b.inboxRoot);
    expect(gemini).toMatch(/^# gale\n/);
    expect(gemini).toContain(bootPhrase(b, "gale"));
    expect(gemini).toContain(path.join(BIN, "sync-gemini-includes.sh"));
    expect(gemini).not.toMatch(/<sync-gemini-cli>|<gemini-path>/);
  });

  it("stamps the role brief into the runtime's own file too", () => {
    const b = box();
    create(b, ["cobalt", "--runtime", "codex", "--kind", "platform", "--peer", "inkie", "--no-verify"]);
    expect(read(b, "cobalt", "AGENTS.md")).toContain("## Your role: the platform agent");
    expect(read(b, "cobalt", "AGENTS.md")).toContain("**inkie**");
  });

  it("refuses an unknown runtime and creates nothing", () => {
    const b = box();
    const result = create(b, ["moss", "--runtime", "gemini", "--no-verify"]);
    expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(result.output).toContain("use claude, codex or agy");
    expect(fs.existsSync(home(b, "moss"))).toBe(false);
  });

  it("leaves memory off for Codex and agy even when a memory checkout is configured", () => {
    const b = box();
    const result = create(b, ["cobalt", "--runtime", "codex", "--no-verify"], {
      MEMORY_LAYER_ROOT: path.join(b.home, "memory"),
    });
    expect(result.output).toContain("memory off (memory hooks are Claude Code only");
  });
});

describe("verification for codex and agy", () => {
  it("codex: local checks pass, exit 4, and the live probe is NOT run by default", () => {
    const b = box();
    stubRuntime(b, "codex", true);
    const result = create(b, ["cobalt", "--runtime", "codex"]);
    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    expect(result.output).toContain("matches the scaffolded commands (not run)");
    expect(result.output).toContain("--live-probe");
    expect(probeCalls(b)).toBe("");
  });

  it("agy: local checks pass, exit 4, and the live probe is NOT run by default", () => {
    const b = box();
    stubRuntime(b, "agy", true);
    const result = create(b, ["gale", "--runtime", "agy"]);
    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    expect(result.output).toContain("GEMINI.md carries the boot phrase");
    expect(probeCalls(b)).toBe("");
  });

  it("codex: a changed hook is refused without being run, even with --no-verify", () => {
    const b = box();
    create(b, ["cobalt", "--runtime", "codex", "--no-verify"]);
    const fake = path.join(b.home, "fake-hook");
    const marker = path.join(b.home, "hook-ran");
    fs.writeFileSync(
      fake,
      `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\n`,
      { mode: 0o755 },
    );
    const file = path.join(home(b, "cobalt"), ".codex", "hooks.json");
    const hooks = JSON.parse(fs.readFileSync(file, "utf8"));
    hooks.hooks.SessionStart[0].hooks[0].command = `'${fake}'`;
    fs.writeFileSync(file, JSON.stringify(hooks));
    for (const flags of [[], ["--no-verify"]]) {
      const result = create(b, ["--verify-only", "cobalt", ...flags]);
      expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
      expect(result.output).toContain("SessionStart must contain exactly the scaffolded command");
      expect(fs.existsSync(marker)).toBe(false);
    }
  });

  it("codex: a malformed hooks file is a scaffold error", () => {
    const b = box();
    create(b, ["cobalt", "--runtime", "codex", "--no-verify"]);
    fs.writeFileSync(path.join(home(b, "cobalt"), ".codex", "hooks.json"), "{ not json");
    const result = create(b, ["--verify-only", "cobalt"]);
    expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(result.output).toContain("not valid JSON");
  });

  it("codex: UserPromptSubmit is required too", () => {
    const b = box();
    create(b, ["cobalt", "--runtime", "codex", "--no-verify"]);
    const file = path.join(home(b, "cobalt"), ".codex", "hooks.json");
    const hooks = JSON.parse(fs.readFileSync(file, "utf8"));
    delete hooks.hooks.UserPromptSubmit;
    fs.writeFileSync(file, JSON.stringify(hooks));
    const result = create(b, ["--verify-only", "cobalt"]);
    expect(result.status).toBe(EXIT.SCAFFOLD_ERROR);
    expect(result.output).toContain("UserPromptSubmit");
  });

  it("agy: stale identity text without sync fences fails before the live probe", () => {
    const b = box();
    create(b, ["gale", "--runtime", "agy", "--no-verify"]);
    stubRuntime(b, "agy", true);
    const file = path.join(home(b, "gale"), "GEMINI.md");
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(
      file,
      text.replace(/<!-- BEGIN SYNCED:IDENTITY\.md[\s\S]*?<!-- END SYNCED:IDENTITY\.md -->\n/, "Stale identity: boot-0000000000000000\n"),
    );
    const result = create(b, ["--verify-only", "gale", "--live-probe"]);
    expect(result.status).toBe(EXIT.FAILED);
    expect(probeCalls(b)).toBe("");
  });

  it("agy: the live probe reads the real GEMINI.md after stale text is refreshed", () => {
    const b = box();
    create(b, ["gale", "--runtime", "agy", "--no-verify"]);
    stubRuntime(b, "agy", true);
    const phrase = bootPhrase(b, "gale");
    const gemini = read(b, "gale", "GEMINI.md");
    expect(gemini).toContain(phrase);
    fs.writeFileSync(path.join(home(b, "gale"), "GEMINI.md"), gemini.replace(phrase, "stale"));
    const result = create(b, ["--verify-only", "gale", "--live-probe"]);
    expect(result.status).toBe(EXIT.VERIFIED);
    expect(read(b, "gale", "GEMINI.md")).toBe(gemini);
  });

  it("codex --live-probe: VERIFIED when the reply carries the boot phrase, run as codex exec with the agent's env", () => {
    const b = box();
    create(b, ["cobalt", "--runtime", "codex", "--no-verify"]);
    stubRuntime(b, "codex", true);
    const result = create(b, ["--verify-only", "cobalt", "--live-probe"]);
    expect(result.status).toBe(EXIT.VERIFIED);
    const call = probeCalls(b);
    expect(call).toMatch(/^exec --skip-git-repo-check /);
    expect(call).toContain("AGENT_NAME=cobalt");
    expect(call).toContain(`INBOX_ROOT=${b.inboxRoot}`);
  });

  it("codex --live-probe: FAILED when the reply does not carry it", () => {
    const b = box();
    create(b, ["cobalt", "--runtime", "codex", "--no-verify"]);
    stubRuntime(b, "codex", false);
    const result = create(b, ["--verify-only", "cobalt", "--live-probe"]);
    expect(result.status).toBe(EXIT.FAILED);
    expect(result.output).toContain("trust this folder and its hooks");
  });

  it("agy --live-probe (via CREATE_AGENT_LIVE_PROBE=1): VERIFIED, run as agy -p", () => {
    const b = box();
    stubRuntime(b, "agy", true);
    const result = create(b, ["gale", "--runtime", "agy", "--model", "gemini-test"], {
      CREATE_AGENT_LIVE_PROBE: "1",
    });
    expect(result.status).toBe(EXIT.VERIFIED);
    expect(probeCalls(b)).toMatch(/^--model gemini-test -p /);
  });

  it("--verify-only takes the runtime from the agent's .runtime, and refuses a contradicting --runtime", () => {
    const b = box();
    create(b, ["gale", "--runtime", "agy", "--no-verify"]);
    expect(create(b, ["--verify-only", "gale"]).output).toContain("local checks for agy");
    const clash = create(b, ["--verify-only", "gale", "--runtime", "codex"]);
    expect(clash.status).toBe(EXIT.SCAFFOLD_ERROR);
  });
});

describe("codex hooks", () => {
  it("the SessionStart hook prints SessionStart JSON with the persona, IDENTITY.md first", () => {
    const b = box();
    create(b, ["cobalt", "--runtime", "codex", "--no-verify"]);
    const hooks = JSON.parse(read(b, "cobalt", ".codex/hooks.json"));
    const out = runHook(hooks.hooks.SessionStart[0].hooks[0].command, home(b, "cobalt"), '{"source":"resume"}', {
      AGENT_NAME: "cobalt",
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const ctx: string = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("(resume)");
    expect(ctx).toContain(bootPhrase(b, "cobalt"));
    expect(ctx.indexOf("## IDENTITY.md")).toBeLessThan(ctx.indexOf("## SOUL.md"));
  });

  it.each(["SOUL.md", "IDENTITY.md"])("the SessionStart hook cuts oversized %s but keeps the identity head and boot phrase", (filename) => {
    const b = box();
    create(b, ["cobalt", "--runtime", "codex", "--no-verify"]);
    const original = read(b, "cobalt", filename);
    const head = read(b, "cobalt", "IDENTITY.md").split("\n", 1)[0];
    const phrase = bootPhrase(b, "cobalt");
    const longer = filename === "IDENTITY.md"
      ? original.replace("\n", `\n${"x".repeat(20000)}\n`)
      : original + "x".repeat(20000);
    fs.writeFileSync(path.join(home(b, "cobalt"), filename), longer);
    const hooks = JSON.parse(read(b, "cobalt", ".codex/hooks.json"));
    const out = runHook(hooks.hooks.SessionStart[0].hooks[0].command, home(b, "cobalt"), "{}", {});
    const ctx: string = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
    expect(Buffer.byteLength(ctx, "utf8")).toBeLessThanOrEqual(9000);
    expect(ctx).toContain(`## IDENTITY.md\n\n${head}\n`);
    expect(ctx).toContain(phrase);
    expect(ctx).toContain("cut here to stay under");
    expect(ctx).toContain("[not included:");
  });

  it("both hooks fail open with valid JSON when there is nothing to work with", () => {
    const b = box();
    const inject = runHook(`'${path.join(BIN, "codex-persona-inject")}'`, b.home, "not json", {});
    expect(inject.status).toBe(0);
    expect(JSON.parse(inject.stdout).hookSpecificOutput).toEqual({
      hookEventName: "SessionStart",
      additionalContext: "",
    });
    const prompt = runHook(`'${path.join(BIN, "codex-user-prompt-submit")}'`, b.home, "{}", {});
    expect(prompt.status).toBe(0);
    expect(JSON.parse(prompt.stdout).hookSpecificOutput).toEqual({
      hookEventName: "UserPromptSubmit",
      additionalContext: "",
    });
  });

  it("the per-prompt hook stays silent when nothing is unread", () => {
    const b = box();
    fs.mkdirSync(path.join(b.inboxRoot, "cobalt", "inbox"), { recursive: true });
    const out = runHook(`'${path.join(BIN, "codex-user-prompt-submit")}'`, b.home, "{}", {
      AGENT_NAME: "cobalt",
      INBOX_ROOT: b.inboxRoot,
    });
    expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext).toBe("");
  });
});

describe("first-run.sh --runtime", () => {
  it("creates both agents for the given runtime", () => {
    const b = box();
    const result = run(b, FIRST_RUN, ["--assistant", "inkie", "--platform", "doctor", "--runtime", "codex", "--no-verify"]);
    expect(result.status).toBe(EXIT.CANNOT_VERIFY);
    for (const name of ["inkie", "doctor"]) {
      expect(read(b, name, ".runtime")).toBe("codex");
      expect(fs.existsSync(path.join(home(b, name), "AGENTS.md"))).toBe(true);
    }
  });

  it("refuses an unknown runtime before creating anything", () => {
    const b = box();
    const result = run(b, FIRST_RUN, ["--assistant", "inkie", "--platform", "doctor", "--runtime", "nope"]);
    expect(result.status).toBe(1);
    expect(fs.readdirSync(b.agentsHome)).toEqual([]);
  });
});
