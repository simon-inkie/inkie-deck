/**
 * scripts/setup.sh.
 *
 * Core behaviour only: a fresh run and a rerun, the refusals that must write
 * nothing (HOST, root, no terminal, a bad .env, a bad key), the key handling
 * (never printed, never an argument or environment of a child, rollback and the
 * pending marker), the exit-code precedence and what boot is called with.
 *
 * The script is copied into a sandbox repository so its .env lands there. The
 * base package is linked in. Everything else is a stub on PATH: a runtime that
 * quotes the boot phrase, tmux and curl stubs that fake a running Deck, a
 * boot-agents that records its arguments and environment, and, where needed,
 * a failing `mv`. The optional Brain clone and build are also stubbed.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const BASE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SETUP_SRC = path.join(path.dirname(path.dirname(BASE)), "scripts", "setup.sh");
const KEY = "sk-ant-test-0123456789abcdef";
const KEY2 = "sk-ant-other-fedcba9876543210";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface Box {
  root: string;
  repo: string;
  setup: string;
  home: string;
  agents: string;
  deck: string;
  stubBin: string;
  port: number;
}

function write(file: string, body: string, mode = 0o755): void {
  fs.writeFileSync(file, body, { mode });
}

function box(): Box {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-test-"));
  roots.push(root);
  const b: Box = {
    root,
    repo: path.join(root, "repo"),
    setup: path.join(root, "repo", "scripts", "setup.sh"),
    home: path.join(root, "home"),
    agents: path.join(root, "agents"),
    deck: path.join(root, "deck"),
    stubBin: path.join(root, "bin"),
    port: 49443,
  };
  for (const d of [b.home, b.stubBin, path.join(b.repo, "scripts"), path.join(b.repo, "packages", "deck")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.copyFileSync(SETUP_SRC, b.setup);
  fs.chmodSync(b.setup, 0o755);
  fs.symlinkSync(BASE, path.join(b.repo, "packages", "base"));
  spawnSync("git", ["init", "-q", b.repo]);
  const nodeBin = path.join(root, "node-only");
  fs.mkdirSync(nodeBin);
  fs.symlinkSync(process.execPath, path.join(nodeBin, "node"));

  for (const tool of ["rg", "xxd", "python3"]) write(path.join(b.stubBin, tool), "#!/bin/sh\nexit 0\n");
  write(path.join(b.stubBin, "curl"), `#!/bin/sh\ntest -e "${root}/deck-up"\n`);
  write(
    path.join(b.stubBin, "tmux"),
    `#!/usr/bin/env bash
echo "$@" >> "${root}/tmux.log"
case "$1" in
  has-session) [ -e "${root}/deck-up" ] ;;
  new-session) : > "${root}/deck-up" ;;
  capture-pane) echo "[prod] app on http://127.0.0.1:${b.port}" ;;
  *) exit 0 ;;
esac
`,
  );
  write(
    path.join(b.stubBin, "mv"),
    `#!/usr/bin/env bash
dest="\${@: -1}"
if [[ "$dest" == */.env.secrets && -n "\${MV_FAIL_FROM:-}" ]]; then
  n=$(( $(cat "${root}/mv.count" 2>/dev/null || echo 0) + 1 )); echo $n > "${root}/mv.count"
  if (( n >= MV_FAIL_FROM && n <= MV_FAIL_TO )); then exit 1; fi
fi
exec /bin/mv "$@"
`,
  );
  write(
    path.join(root, "boot"),
    `#!/usr/bin/env bash
echo "$@" >> "${root}/boot.args"
env > "${root}/boot.env"
[ -f "${root}/boot.out" ] && cat "${root}/boot.out"
exit "$(cat "${root}/boot.rc" 2>/dev/null || echo 0)"
`,
  );
  write(
    path.join(b.stubBin, "pnpm"),
    `#!/bin/sh\necho "$@" >> "${root}/pnpm.log"\nwhile [ -e "${root}/pnpm.hold" ]; do sleep 0.2; done\n[ -n "$PNPM_NOISE" ] && echo "$PNPM_NOISE"\n[ -n "$PNPM_FAIL" ] && { echo "boom: $PNPM_FAIL"; exit 1; }\nexit 0\n`,
  );
  return b;
}

/** A runtime that quotes the boot phrase from IDENTITY.md, and notes it saw a key. */
function runtime(b: Box, answer = true): void {
  write(
    path.join(b.stubBin, "claude"),
    answer
      ? `#!/usr/bin/env bash\n[ -n "\${ANTHROPIC_API_KEY:-}" ] && echo seen >> "${b.root}/claude.keyseen"\ngrep -oE "boot-[0-9a-f]{16}" IDENTITY.md | head -n1\n`
      : `#!/usr/bin/env bash\necho "I have no idea"\n`,
  );
}

const BRAIN_URL = "https://github.com/simon-inkie/inkie-the-brain.git";
const BRAIN_REF = "27a4a279b36f8e65be41d9044a6af857389ef124";
const brainRoot = (b: Box) => path.join(b.home, "inkie-the-brain");
const settings = (b: Box, name: string) => path.join(b.agents, name, ".claude", "settings.json");

function brain(b: Box): void {
  const root = brainRoot(b);
  write(path.join(b.stubBin, "git"), `#!/usr/bin/env bash
case "$1" in
  clone)
    echo "git $*" >> "${b.root}/brain-commands"
    [[ "$*" == "clone -- ${BRAIN_URL} ${root}" ]] || exit 90
    [[ -z "\${CLONE_FAIL:-}" ]] || exit 1
    mkdir -p "$4/scripts"
    cp "${b.root}/installer" "$4/scripts/install.sh"
    ;;
  -C)
    if [[ "$2" != "${root}" ]]; then exec /usr/bin/git "$@"; fi
    shift 2
    case "$*" in
      'rev-parse --show-toplevel') printf '%s\n' "${root}" ;;
      'remote get-url origin') printf '%s\n' '${BRAIN_URL}' ;;
      'status --porcelain') ;;
      'rev-parse --verify ${BRAIN_REF}^{commit}') [[ -z "\${PIN_NEEDS_FETCH:-}" ]] ;;
      'fetch --no-tags ${BRAIN_URL} ${BRAIN_REF}'|'checkout --detach ${BRAIN_REF}')
        printf 'git %s\n' "$*" >> "${b.root}/brain-commands" ;;
      *) exit 91 ;;
    esac
    ;;
  *) exit 92 ;;
esac
`);
  write(path.join(b.stubBin, "pnpm"), `#!/usr/bin/env bash
[[ "$PWD" == "${root}" ]] || exit 93
printf 'pnpm %s\n' "$*" >> "${b.root}/brain-commands"
case "$*" in
  'install --frozen-lockfile') mkdir -p node_modules/.bin; touch node_modules/.bin/tsx; chmod +x node_modules/.bin/tsx ;;
  build)
    [[ -z "\${BUILD_FAIL:-}" ]] || exit 1
    [[ -z "\${BUILD_INCOMPLETE:-}" ]] || exit 0
    mkdir -p dist/claude-code/bin
    touch dist/claude-code/bin/{user-prompt-submit,on-stop,on-pre-compact}.sh
    ;;
  *) exit 94 ;;
esac
`);
  write(path.join(b.stubBin, "claude"), `#!/usr/bin/env bash
name="\${PWD##*/}"
settings=.claude/settings.json
if [[ "$*" != *'{"disableAllHooks":true}'* ]] && grep -q 'on-pre-compact.sh' "$settings"; then
  echo "hook-fired $name" >> "${b.root}/memory-events"
fi
if grep -q 'on-pre-compact.sh' "$settings"; then state=wired; else state=unwired; fi
echo "probe $name $state" >> "${b.root}/memory-events"
[[ "$name" != "\${PROBE_FAIL_FOR:-}" ]] || { echo 'wrong phrase'; exit 0; }
grep -oE 'boot-[0-9a-f]{16}' IDENTITY.md | head -n1
`);
  write(path.join(b.root, "installer"), `#!/usr/bin/env bash
[[ $# == 5 && "$1" == --skip-build && "$2" == --settings && "$4" == --agent ]] || exit 95
[[ "$3" == "${b.agents}/$5/.claude/settings.json" ]] || exit 96
echo "wire $5" >> "${b.root}/memory-events"
[[ -e "$3.the-brain.bak" ]] || cp -- "$3" "$3.the-brain.bak"
node - "$3" <<'JS'
const fs = require('node:fs');
const file = process.argv[2];
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
data.hooks = {
  UserPromptSubmit: ['${root}/dist/claude-code/bin/user-prompt-submit.sh'],
  Stop: ['${root}/dist/claude-code/bin/on-stop.sh'],
  PreCompact: ['${root}/dist/claude-code/bin/on-pre-compact.sh'],
};
fs.writeFileSync(file, JSON.stringify(data));
JS
`);
}

interface Run {
  status: number;
  output: string;
}

function setup(b: Box, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Run {
  const nodeBin = path.join(b.root, "node-only");
  const r = spawnSync("bash", [b.setup, ...args], {
    encoding: "utf8",
    input: opts.input ?? "",
    env: {
      HOME: b.home,
      PATH: [b.stubBin, nodeBin, "/usr/bin", "/bin"].join(path.delimiter),
      PORT: String(b.port),
      MC_USER: "sam",
      SETUP_BOOT_AGENTS: path.join(b.root, "boot"),
      SETUP_DECK_WAIT: "10",
      ...opts.env,
    },
  });
  return { status: r.status ?? -1, output: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** The same as setup(), without blocking, so a second run can happen while it waits. */
function setupAsync(b: Box, args: string[], input = ""): Promise<Run> {
  const nodeBin = path.join(b.root, "node-only");
  return new Promise((resolve) => {
    const child = spawn("bash", [b.setup, ...args], {
      env: {
        HOME: b.home,
        PATH: [b.stubBin, nodeBin, "/usr/bin", "/bin"].join(path.delimiter),
        PORT: String(b.port),
        MC_USER: "sam",
        SETUP_BOOT_AGENTS: path.join(b.root, "boot"),
        SETUP_DECK_WAIT: "10",
      },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => resolve({ status: code ?? -1, output }));
    child.stdin.end(input);
  });
}

const FRESH = (b: Box) => ["--yes", "--no-key", "--no-install", "--no-build", "--deck-home", b.deck, "--agents-home", b.agents];
const KEYRUN = (b: Box) => ["--yes", "--key-stdin", "--no-install", "--no-build", "--deck-home", b.deck, "--agents-home", b.agents];
const envFile = (b: Box) => path.join(b.repo, "packages", "deck", ".env");
const secrets = (b: Box, name: string) => path.join(b.agents, name, ".env.secrets");
const bootArgs = (b: Box) => (fs.existsSync(path.join(b.root, "boot.args")) ? fs.readFileSync(path.join(b.root, "boot.args"), "utf8") : "");

/** Everything setup could have written: the .env, roots, agents home. */
function nothingWritten(b: Box): void {
  expect(fs.existsSync(envFile(b))).toBe(false);
  expect(fs.existsSync(b.deck)).toBe(false);
  expect(fs.existsSync(b.agents)).toBe(false);
}

function allFiles(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}

describe("optional Brain setup", () => {
  const agents = ["inkie", "doctor"];
  const memoryEvents = (b: Box) => fs.readFileSync(path.join(b.root, "memory-events"), "utf8").trim().split("\n");
  const memoryArgs = (b: Box) => [...FRESH(b), "--no-start", "--memory"];

  it("builds a pinned checkout, wires only after each probe and leaves global settings alone", () => {
    const b = box();
    brain(b);
    const global = path.join(b.home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(global));
    const original = '{ "env": { "KEEP_THIS": "yes" } }\n';
    write(global, original);

    const result = setup(b, memoryArgs(b), { env: { PIN_NEEDS_FETCH: "1" } });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`preparing the Brain at ${brainRoot(b)}`);
    expect(result.output.match(/create-agent: memory on/g)).toHaveLength(2);
    expect(memoryEvents(b)).toEqual(["probe inkie unwired", "wire inkie", "probe doctor unwired", "wire doctor"]);
    const build = [
      `git checkout --detach ${BRAIN_REF}`,
      "pnpm install --frozen-lockfile",
      "pnpm build",
    ];
    const commands = () => fs.readFileSync(path.join(b.root, "brain-commands"), "utf8").trim().split("\n");
    const first = [`git clone -- ${BRAIN_URL} ${brainRoot(b)}`, `git fetch --no-tags ${BRAIN_URL} ${BRAIN_REF}`, ...build];
    expect(commands()).toEqual(first);
    for (const name of agents) {
      const config = JSON.parse(fs.readFileSync(settings(b, name), "utf8"));
      expect(config.env).toMatchObject({ AGENT_NAME: name, USER_NAME: "sam" });
      expect(Object.keys(config.hooks)).toEqual(["UserPromptSubmit", "Stop", "PreCompact"]);
    }

    const before = agents.map((name) => fs.readFileSync(settings(b, name), "utf8"));
    const rerun = setup(b, memoryArgs(b));
    expect(rerun.status, rerun.output).toBe(0);
    expect(rerun.output.match(/create-agent: memory on/g)).toHaveLength(2);
    expect(commands()).toEqual([...first, ...build]);
    expect(memoryEvents(b).slice(4)).toEqual(["probe inkie wired", "wire inkie", "probe doctor wired", "wire doctor"]);
    expect(agents.map((name) => fs.readFileSync(settings(b, name), "utf8"))).toEqual(before);

    const disabled = setup(b, [...memoryArgs(b), "--no-memory"]);
    expect(disabled.status, disabled.output).toBe(0);
    expect(memoryEvents(b).slice(8)).toEqual(["probe inkie wired", "probe doctor wired"]);
    expect(commands()).toEqual([...first, ...build]);
    expect(fs.readFileSync(global, "utf8")).toBe(original);
  });

  it.each([
    ["a failed clone", "CLONE_FAIL", "could not clone"],
    ["a failed build", "BUILD_FAIL", "dependency install or build failed"],
    ["missing build artefacts", "BUILD_INCOMPLETE", "build is incomplete"],
  ])("leaves memory off and keeps Deck's exit code for %s", (_label, flag, reason) => {
    const b = box();
    brain(b);
    const result = setup(b, memoryArgs(b), { env: { [flag]: "1" } });
    expect(result.status, result.output).toBe(0);
    expect(result.output.match(/^setup: memory off .*$/gm)).toEqual([expect.stringContaining(reason)]);
    expect(memoryEvents(b)).toEqual(["probe inkie unwired", "probe doctor unwired"]);
    expect(fs.existsSync(path.join(b.home, ".claude", "settings.json"))).toBe(false);
  });

  it("does not try to clone on Node 21", () => {
    const b = box();
    brain(b);
    write(path.join(b.stubBin, "node"), `#!/usr/bin/env bash
[[ "$*" != --version ]] || { echo v21.7.3; exit 0; }
exec "${process.execPath}" "$@"
`);
    const result = setup(b, memoryArgs(b));
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("setup: memory off (the Brain needs Node 22 or newer)");
    expect(memoryEvents(b)).toEqual(["probe inkie unwired", "probe doctor unwired"]);
    expect(fs.existsSync(path.join(b.root, "brain-commands"))).toBe(false);
  });

  it("leaves an unrelated checkout path untouched and honours explicit opt-out", () => {
    const b = box();
    brain(b);
    const unrelated = path.join(b.home, "unrelated");
    fs.mkdirSync(unrelated);
    write(path.join(unrelated, "keep"), "keep");
    const refused = setup(b, [...memoryArgs(b), "--memory-root", unrelated]);
    expect(refused.status, refused.output).toBe(0);
    expect(refused.output).toContain("not a checkout of the public Brain repository");
    expect(fs.readdirSync(unrelated)).toEqual(["keep"]);

    const disabled = setup(b, [...memoryArgs(b), "--no-memory"], { env: { MEMORY_LAYER_ROOT: unrelated } });
    expect(disabled.status, disabled.output).toBe(0);
    expect(disabled.output).toContain("setup: memory off (not requested)");
    expect(fs.existsSync(path.join(b.root, "brain-commands"))).toBe(false);
  });

  it("never wires the starter whose probe failed", () => {
    const b = box();
    brain(b);
    const result = setup(b, memoryArgs(b), { env: { PROBE_FAIL_FOR: "doctor" } });
    expect(result.status, result.output).toBe(3);
    expect(memoryEvents(b)).toEqual(["probe inkie unwired", "wire inkie", "probe doctor unwired"]);
    expect(fs.readFileSync(settings(b, "doctor"), "utf8")).not.toContain("on-pre-compact.sh");
  });
});

describe("a fresh run and a rerun", () => {
  it("creates the roots, .env and both agents, starts Deck, boots exactly the two names", () => {
    const b = box();
    runtime(b);
    const r = setup(b, FRESH(b));
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain("setup: memory off (not requested)");
    expect(fs.existsSync(brainRoot(b))).toBe(false);
    expect(fs.readFileSync(envFile(b), "utf8")).toBe(
      [
        `INBOX_ROOT=${b.deck}/inbox`,
        `ATTACHMENTS_ROOT=${b.deck}/attachments`,
        `PROJECTS_ROOT=${b.deck}/projects`,
        `DATA_ROOT=${b.deck}/data`,
        `AGENTS_ROOT=${b.agents}`,
        "MC_USER=sam",
        "",
      ].join("\n"),
    );
    for (const [name, kind] of [["inkie", "assistant"], ["doctor", "platform"]]) {
      expect(fs.readFileSync(path.join(b.agents, name, ".kind"), "utf8")).toBe(kind);
    }
    expect(fs.readFileSync(path.join(b.agents, "inkie", "CLAUDE.md"), "utf8")).toContain("**sam**");
    expect(bootArgs(b).trim()).toBe("inkie doctor");
    expect(fs.readFileSync(path.join(b.root, "tmux.log"), "utf8")).toContain("new-session -d -s deck");
    expect(fs.readFileSync(path.join(b.root, "boot.env"), "utf8")).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it("a healthy rerun changes no configuration or agent file", () => {
    const b = box();
    runtime(b);
    expect(setup(b, FRESH(b)).status).toBe(0);
    const snap = () => allFiles(b.agents).concat(envFile(b)).sort().map((f) => `${f}\n${fs.readFileSync(f, "utf8")}`).join("\n");
    const before = snap();
    const r = setup(b, FRESH(b));
    expect(r.status, r.output).toBe(0);
    expect(snap()).toBe(before);
  });
});

describe("refusals that write nothing", () => {
  it("HOST=0.0.0.0 in the environment exits 1 naming the environment", () => {
    const b = box();
    const r = setup(b, FRESH(b), { env: { HOST: "0.0.0.0" } });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/HOST=0\.0\.0\.0 \(from the environment\)/);
    nothingWritten(b);
  });

  it("HOST=0.0.0.0 in an existing .env exits 1 naming the file, which stays byte-identical", () => {
    const b = box();
    const content = `INBOX_ROOT=${b.deck}/i\nATTACHMENTS_ROOT=${b.deck}/a\nPROJECTS_ROOT=${b.deck}/p\nDATA_ROOT=${b.deck}/d\nAGENTS_ROOT=${b.agents}\nMC_USER=sam\nHOST=0.0.0.0\n`;
    fs.writeFileSync(envFile(b), content);
    const r = setup(b, FRESH(b));
    expect(r.status).toBe(1);
    expect(r.output).toContain(`from ${envFile(b)}`);
    expect(fs.readFileSync(envFile(b), "utf8")).toBe(content);
    expect(fs.existsSync(b.deck)).toBe(false);
    expect(fs.existsSync(b.agents)).toBe(false);
  });

  it("an existing .env missing INBOX_ROOT exits 1 naming it", () => {
    const b = box();
    const content = `ATTACHMENTS_ROOT=${b.deck}/a\nPROJECTS_ROOT=${b.deck}/p\nDATA_ROOT=${b.deck}/d\nMC_USER=sam\n`;
    fs.writeFileSync(envFile(b), content);
    const r = setup(b, FRESH(b));
    expect(r.status).toBe(1);
    expect(r.output).toContain("INBOX_ROOT is not set");
    expect(fs.readFileSync(envFile(b), "utf8")).toBe(content);
    expect(fs.existsSync(b.deck)).toBe(false);
    expect(fs.existsSync(b.agents)).toBe(false);
  });

  it("no terminal and no key choice, or no names, exits 2", () => {
    const b = box();
    const noKey = setup(b, ["--yes", "--no-install", "--no-build", "--deck-home", b.deck, "--agents-home", b.agents]);
    expect(noKey.status).toBe(2);
    expect(noKey.output).toContain("--no-key");
    const noNames = setup(b, ["--no-key", "--no-install", "--no-build", "--deck-home", b.deck, "--agents-home", b.agents]);
    expect(noNames.status).toBe(2);
    nothingWritten(b);
  });

  it("--replace-key without a terminal or --key-stdin exits 2", () => {
    const b = box();
    expect(setup(b, [...FRESH(b).filter((a) => a !== "--no-key"), "--replace-key"]).status).toBe(2);
    nothingWritten(b);
  });

  it("refuses to run as root", () => {
    const b = box();
    write(path.join(b.stubBin, "id"), '#!/bin/sh\n[ "$1" = "-u" ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n');
    const r = setup(b, FRESH(b));
    expect(r.status).toBe(1);
    expect(r.output).toContain("as root");
    nothingWritten(b);
  });

  it("an invalid key stops the run before install, with nothing written", () => {
    const b = box();
    const r = setup(b, ["--yes", "--key-stdin", "--deck-home", b.deck, "--agents-home", b.agents, "--no-build"], {
      input: "not a valid key; rm -rf\n",
    });
    expect(r.status).toBe(1);
    expect(r.output).toContain("not valid");
    expect(r.output).not.toContain("rm -rf");
    expect(fs.existsSync(path.join(b.root, "pnpm.log"))).toBe(false);
    nothingWritten(b);
  });
});

describe("the API key", () => {
  it("is stored only in each starter's .env.secrets, 0600, other lines kept, and never leaks", () => {
    const b = box();
    runtime(b);
    expect(setup(b, FRESH(b)).status).toBe(0);
    for (const n of ["inkie", "doctor"]) fs.writeFileSync(secrets(b, n), "OTHER=kept\n", { mode: 0o600 });
    fs.rmSync(path.join(b.root, "boot.args"));

    const r = setup(b, KEYRUN(b), { input: `${KEY}\n` });
    expect(r.status, r.output).toBe(0);
    for (const n of ["inkie", "doctor"]) {
      const text = fs.readFileSync(secrets(b, n), "utf8");
      expect(text).toBe(`OTHER=kept\nexport ANTHROPIC_API_KEY=${KEY}\n`);
      expect(fs.statSync(secrets(b, n)).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(path.join(b.agents, n)).filter((f) => f.startsWith(".setup-key"))).toEqual([]);
    }
    expect(fs.existsSync(path.join(b.agents, ".setup-key-pending"))).toBe(false);
    // The probe, and only the probe, saw it: once per starter.
    expect(fs.readFileSync(path.join(b.root, "claude.keyseen"), "utf8").trim().split("\n")).toHaveLength(2);
    // Not in output, not in boot's arguments or environment, not in any other file.
    expect(r.output).not.toContain(KEY);
    expect(bootArgs(b)).not.toContain(KEY);
    expect(fs.readFileSync(path.join(b.root, "boot.env"), "utf8")).not.toContain(KEY);
    const holders = allFiles(b.root)
      .filter((f) => !f.startsWith(path.join(b.repo, "packages", "base")))
      .filter((f) => fs.readFileSync(f).includes(KEY));
    expect(holders.sort()).toEqual([secrets(b, "doctor"), secrets(b, "inkie")]);
  });

  it("a rerun never replaces an existing key, and changes neither file", () => {
    const b = box();
    runtime(b);
    expect(setup(b, FRESH(b)).status).toBe(0);
    expect(setup(b, KEYRUN(b), { input: `${KEY}\n` }).status).toBe(0);
    const before = ["inkie", "doctor"].map((n) => fs.readFileSync(secrets(b, n), "utf8"));
    expect(setup(b, FRESH(b)).status).toBe(0);
    expect(setup(b, KEYRUN(b), { input: `${KEY2}\n` }).status).toBe(0);
    expect(["inkie", "doctor"].map((n) => fs.readFileSync(secrets(b, n), "utf8"))).toEqual(before);
  });

  it("refuses an existing secrets file that others can write", () => {
    const b = box();
    runtime(b);
    expect(setup(b, FRESH(b)).status).toBe(0);
    fs.writeFileSync(secrets(b, "inkie"), "OTHER=1\n", { mode: 0o600 });
    fs.chmodSync(secrets(b, "inkie"), 0o666);
    const r = setup(b, KEYRUN(b), { input: `${KEY}\n` });
    expect(r.status).toBe(1);
    expect(r.output).toContain("writable by group or others");
    expect(fs.readFileSync(secrets(b, "inkie"), "utf8")).toBe("OTHER=1\n");
  });

  describe("write failures", () => {
    const seeded = () => {
      const b = box();
      runtime(b);
      expect(setup(b, FRESH(b)).status).toBe(0);
      for (const n of ["inkie", "doctor"]) fs.writeFileSync(secrets(b, n), `OTHER=${n}\n`, { mode: 0o600 });
      fs.rmSync(path.join(b.root, "boot.args"));
      return b;
    };
    const marker = (b: Box) => path.join(b.agents, ".setup-key-pending");
    const contents = (b: Box) => ["inkie", "doctor"].map((n) => fs.readFileSync(secrets(b, n), "utf8"));

    it("second rename fails, restore succeeds: both files as they were, no marker, exit 1", () => {
      const b = seeded();
      const r = setup(b, KEYRUN(b), { input: `${KEY}\n`, env: { MV_FAIL_FROM: "2", MV_FAIL_TO: "2" } });
      expect(r.status).toBe(1);
      expect(contents(b)).toEqual(["OTHER=inkie\n", "OTHER=doctor\n"]);
      expect(fs.existsSync(marker(b))).toBe(false);
      expect(bootArgs(b)).toBe("");
    });

    it("second rename fails and restore fails: marker kept, mixed key state, nothing launched; the next run stops, and --replace-key repairs it", () => {
      const b = seeded();
      const r = setup(b, KEYRUN(b), { input: `${KEY}\n`, env: { MV_FAIL_FROM: "2", MV_FAIL_TO: "3" } });
      expect(r.status).toBe(1);
      expect(r.output).toContain("mixed key state");
      expect(fs.readFileSync(marker(b), "utf8")).toBe("inkie\ndoctor\n");
      expect(bootArgs(b)).toBe("");

      const again = setup(b, FRESH(b));
      expect(again.status).toBe(1);
      expect(again.output).toContain("mixed key state");
      expect(bootArgs(b)).toBe("");
      expect(fs.existsSync(path.join(b.root, "claude.keyseen"))).toBe(false);

      // --replace-key needs a key source even with --yes: without one it is a
      // usage error, the marker stays, and nothing is verified.
      const noSource = setup(b, [...FRESH(b).filter((a) => a !== "--no-key"), "--replace-key"]);
      expect(noSource.status).toBe(2);
      expect(fs.existsSync(marker(b))).toBe(true);
      expect(bootArgs(b)).toBe("");

      const fixed = setup(b, [...KEYRUN(b), "--replace-key"], { input: `${KEY2}\n` });
      expect(fixed.status, fixed.output).toBe(0);
      expect(fs.existsSync(marker(b))).toBe(false);
      for (const text of contents(b)) expect(text).toContain(`export ANTHROPIC_API_KEY=${KEY2}`);
    });

    it("a mixed marker for another pair is never repaired or overwritten by a different selection", () => {
      const b = seeded();
      for (const [n, k] of [["ada", KEY], ["beth", KEY2]]) {
        fs.mkdirSync(path.join(b.agents, n), { recursive: true });
        fs.writeFileSync(path.join(b.agents, n, ".env.secrets"), `export ANTHROPIC_API_KEY=${k}\n`, { mode: 0o600 });
      }
      fs.writeFileSync(marker(b), "ada\nbeth\n");
      const before = contents(b);
      const r = setup(b, [...KEYRUN(b), "--replace-key"], { input: `${KEY2}\n` });
      expect(r.status).toBe(1);
      expect(r.output).toContain("ada");
      expect(fs.readFileSync(marker(b), "utf8")).toBe("ada\nbeth\n");
      expect(contents(b)).toEqual(before);
      expect(fs.readFileSync(path.join(b.agents, "ada", ".env.secrets"), "utf8")).toContain(KEY);
      expect(bootArgs(b)).toBe("");
    });

    it("a marker naming one agent twice is refused with the marker intact", () => {
      const b = seeded();
      fs.writeFileSync(marker(b), "inkie\ninkie\n");
      const r = setup(b, [...KEYRUN(b), "--replace-key"], { input: `${KEY2}\n` });
      expect(r.status).toBe(1);
      expect(fs.readFileSync(marker(b), "utf8")).toBe("inkie\ninkie\n");
      expect(bootArgs(b)).toBe("");
    });

    it("setup scaffolds into existing empty agent homes without repair", () => {
      const b = box();
      runtime(b);
      for (const n of ["inkie", "doctor"]) fs.mkdirSync(path.join(b.agents, n), { recursive: true });
      expect(setup(b, FRESH(b)).status).toBe(0);
      expect(fs.existsSync(path.join(b.agents, "inkie", ".kind"))).toBe(true);
      expect(fs.existsSync(path.join(b.agents, "doctor", ".kind"))).toBe(true);
    });

    it("a marker over two matching key states is cleared and the run continues", () => {
      const b = seeded();
      fs.writeFileSync(marker(b), "inkie\ndoctor\n");
      const r = setup(b, FRESH(b));
      expect(r.status, r.output).toBe(0);
      expect(fs.existsSync(marker(b))).toBe(false);
      expect(bootArgs(b).trim()).toBe("inkie doctor");
    });
  });
});

describe("exit codes and boot", () => {
  it("no model CLI: exit 4, Deck running, boot not called", () => {
    const b = box();
    const r = setup(b, FRESH(b));
    expect(r.status, r.output).toBe(4);
    expect(r.output).toContain("were not started");
    expect(fs.existsSync(path.join(b.root, "deck-up"))).toBe(true);
    expect(bootArgs(b)).toBe("");
    // Said once, plainly: what is needed, what is supported, where to get it.
    expect(r.output).toContain("A supported agent CLI must be installed and signed in");
    expect(r.output).toContain("https://github.com/anthropics/claude-code");
    expect(r.output).toContain("not yet");
    expect(r.output).toContain("by asking what you do");
    expect(r.output.split("No agent CLI was found").length - 1).toBe(1);
  });

  it("install and build noise goes to a log; a failure shows the tail and still fails", () => {
    const b = box();
    runtime(b);
    const args = FRESH(b).filter((a) => a !== "--no-install" && a !== "--no-build");
    const quiet = setup(b, args, { env: { PNPM_NOISE: "Future Flag Warning noise" } });
    expect(quiet.status, quiet.output).toBe(0);
    expect(quiet.output).not.toContain("Future Flag Warning noise");
    expect(quiet.output).toContain("setup-install.log");
    expect(fs.readFileSync(path.join(b.deck, "logs", "setup-install.log"), "utf8")).toContain("Future Flag Warning noise");

    const c = box();
    runtime(c);
    const bad = setup(c, FRESH(c).filter((a) => a !== "--no-install"), { env: { PNPM_FAIL: "no network" } });
    expect(bad.status).toBe(1);
    expect(bad.output).toContain("boom: no network");
    expect(bad.output).toContain("setup-install.log");
  });

  it("a failed persona check: exit 3, boot not called", () => {
    const b = box();
    runtime(b, false);
    const r = setup(b, FRESH(b));
    expect(r.status, r.output).toBe(3);
    expect(bootArgs(b)).toBe("");
  });

  it("boot pending is 5 only when every waiting agent is at a prompt; boot failing is 1", () => {
    const b = box();
    runtime(b);
    fs.writeFileSync(path.join(b.root, "boot.rc"), "3");
    fs.writeFileSync(path.join(b.root, "boot.out"), "boot-agents: waiting-detail: prompts=2 other=0\n");
    expect(setup(b, FRESH(b)).status).toBe(5);
    fs.writeFileSync(path.join(b.root, "boot.out"), "boot-agents: waiting-detail: prompts=1 other=1\n");
    expect(setup(b, FRESH(b)).status).toBe(1);
    fs.writeFileSync(path.join(b.root, "boot.out"), "boot-agents: no detail line\n");
    expect(setup(b, FRESH(b)).status).toBe(1);
    fs.rmSync(path.join(b.root, "boot.out"));
    fs.writeFileSync(path.join(b.root, "boot.rc"), "1");
    expect(setup(b, FRESH(b)).status).toBe(1);
  });

  it("--no-start starts nothing", () => {
    const b = box();
    runtime(b);
    const r = setup(b, [...FRESH(b), "--no-start"]);
    expect(r.status, r.output).toBe(0);
    expect(fs.existsSync(path.join(b.root, "deck-up"))).toBe(false);
    expect(bootArgs(b)).toBe("");
    expect(r.output).not.toContain("Deck is running");
    expect(r.output).toContain("were not started (--no-start)");
  });

  it("starts Deck pinned to loopback with every effective root in its own environment", () => {
    const b = box();
    runtime(b);
    expect(setup(b, FRESH(b), { env: { HOST: "localhost" } }).status).toBe(0);
    const log = fs.readFileSync(path.join(b.root, "tmux.log"), "utf8");
    const cmd = log.split("\n").find((l) => l.startsWith("new-session")) ?? "";
    for (const want of [
      "HOST=127.0.0.1",
      `PORT=${b.port}`,
      `INBOX_ROOT=${b.deck}/inbox`,
      `ATTACHMENTS_ROOT=${b.deck}/attachments`,
      `PROJECTS_ROOT=${b.deck}/projects`,
      `DATA_ROOT=${b.deck}/data`,
      `AGENTS_ROOT=${b.agents}`,
      "MC_USER=sam",
    ]) expect(cmd).toContain(want);
  });

  it("a bare .kind over a partial home is not an existing agent", () => {
    const b = box();
    fs.mkdirSync(path.join(b.agents, "inkie"), { recursive: true });
    fs.writeFileSync(path.join(b.agents, "inkie", "SOUL.md"), "x");
    fs.writeFileSync(path.join(b.agents, "inkie", ".kind"), "assistant");
    const r = setup(b, FRESH(b));
    expect(r.status).toBe(1);
    expect(r.output).not.toContain("already exist");
    expect(bootArgs(b)).toBe("");
  });
});

describe("hardening", () => {
  it("HOST written with spaces around = is still refused", () => {
    const b = box();
    const content = `INBOX_ROOT=${b.deck}/i\nATTACHMENTS_ROOT=${b.deck}/a\nPROJECTS_ROOT=${b.deck}/p\nDATA_ROOT=${b.deck}/d\nAGENTS_ROOT=${b.agents}\nMC_USER=sam\nexport HOST = "0.0.0.0" # open\n`;
    fs.writeFileSync(envFile(b), content);
    const r = setup(b, FRESH(b));
    expect(r.status).toBe(1);
    expect(r.output).toContain("HOST=0.0.0.0");
    expect(fs.existsSync(b.agents)).toBe(false);
  });

  it("HOST=127.0.0.1#local is valid loopback, as Deck's loader reads it", () => {
    const b = box();
    runtime(b);
    fs.writeFileSync(
      envFile(b),
      `INBOX_ROOT=${b.deck}/i\nATTACHMENTS_ROOT=${b.deck}/a\nPROJECTS_ROOT=${b.deck}/p\nDATA_ROOT=${b.deck}/d\nAGENTS_ROOT=${b.agents}\nMC_USER=sam\nHOST=127.0.0.1#local\n`,
    );
    expect(setup(b, FRESH(b)).status).toBe(0);
  });

  it("an invalid --model stops before any write", () => {
    const b = box();
    const r = setup(b, [...FRESH(b), "--model", "bad model; x"]);
    expect(r.status).toBe(2);
    nothingWritten(b);
  });

  it("refuses a key when the agents home is a symlink, or inside a git work tree", () => {
    const b = box();
    runtime(b);
    const real = path.join(b.root, "real-agents");
    fs.mkdirSync(real);
    fs.symlinkSync(real, b.agents);
    expect(setup(b, FRESH(b)).status).toBe(0);
    const linked = setup(b, KEYRUN(b), { input: `${KEY}\n` });
    expect(linked.status).toBe(1);
    expect(linked.output).toContain("symlink");
    expect(allFiles(real).filter((f) => fs.readFileSync(f).includes(KEY))).toEqual([]);

    const g = box();
    const repo = path.join(g.root, "checkout");
    fs.mkdirSync(repo);
    spawnSync("git", ["init", "-q", repo]);
    const inside = path.join(repo, "agents");
    const r = setup(g, ["--yes", "--key-stdin", "--no-install", "--no-build", "--deck-home", g.deck, "--agents-home", inside], { input: `${KEY}\n` });
    expect(r.status).toBe(1);
    expect(r.output).toContain("git work tree");
    expect(fs.existsSync(inside)).toBe(false);
    expect(r.output).not.toContain(KEY);
  });

  it("a run that decided to write before another run stored a key does not overwrite it", async () => {
    const b = box();
    runtime(b);
    expect(setup(b, FRESH(b)).status).toBe(0);
    // Run two reads the state (no key yet), then sits in `pnpm install`.
    fs.writeFileSync(path.join(b.root, "pnpm.hold"), "");
    const second = setupAsync(b, KEYRUN(b).filter((a) => a !== "--no-install"), `${KEY2}\n`);
    for (let i = 0; i < 100 && !fs.existsSync(path.join(b.root, "pnpm.log")); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // Run one stores a key meanwhile.
    expect(setup(b, KEYRUN(b), { input: `${KEY}\n` }).status).toBe(0);
    fs.rmSync(path.join(b.root, "pnpm.hold"));
    const r = await second;
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain("stored by another run");
    for (const n of ["inkie", "doctor"]) {
      const text = fs.readFileSync(secrets(b, n), "utf8");
      expect(text).toContain(KEY);
      expect(text).not.toContain(KEY2);
    }
  });

  it("a stale lock is explained, not removed", () => {
    const b = box();
    runtime(b);
    expect(setup(b, FRESH(b)).status).toBe(0);
    fs.mkdirSync(path.join(b.agents, ".setup-key-lock"));
    const r = setup(b, FRESH(b));
    expect(r.status).toBe(1);
    expect(r.output).toContain("rmdir");
    expect(r.output).toContain(".setup-key-lock");
    expect(fs.existsSync(path.join(b.agents, ".setup-key-lock"))).toBe(true);
  });

  it("refuses a key through a symlinked parent, and an agents home Git can see despite a ceiling", () => {
    const b = box();
    runtime(b);
    const real = path.join(b.root, "real");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(b.root, "parent"));
    const viaParent = path.join(b.root, "parent", "agents");
    const args = (home: string) => ["--yes", "--key-stdin", "--no-install", "--no-build", "--deck-home", b.deck, "--agents-home", home];
    expect(setup(b, ["--yes", "--no-key", "--no-install", "--no-build", "--deck-home", b.deck, "--agents-home", viaParent]).status).toBe(0);
    const r = setup(b, args(viaParent), { input: `${KEY}\n` });
    expect(r.status).toBe(1);
    expect(r.output).toContain("symlink");
    expect(allFiles(real).filter((f) => fs.readFileSync(f).includes(KEY))).toEqual([]);

    const g = box();
    const repo = path.join(g.root, "checkout");
    fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    const hidden = setup(
      g,
      ["--yes", "--key-stdin", "--no-install", "--no-build", "--deck-home", g.deck, "--agents-home", path.join(repo, "sub", "agents")],
      { input: `${KEY}\n`, env: { GIT_CEILING_DIRECTORIES: repo } },
    );
    expect(hidden.status).toBe(1);
    expect(hidden.output).toContain("git work tree");
    expect(fs.existsSync(path.join(repo, "sub", "agents"))).toBe(false);
  });

  it("refuses a second run while the key lock is held, writing nothing", () => {
    const b = box();
    runtime(b);
    expect(setup(b, FRESH(b)).status).toBe(0);
    fs.writeFileSync(secrets(b, "inkie"), "OTHER=1\n", { mode: 0o600 });
    fs.mkdirSync(path.join(b.agents, ".setup-key-lock"));
    const r = setup(b, KEYRUN(b), { input: `${KEY}\n` });
    expect(r.status).toBe(1);
    expect(r.output).toContain("another setup run");
    expect(fs.readFileSync(secrets(b, "inkie"), "utf8")).toBe("OTHER=1\n");
    expect(fs.existsSync(path.join(b.agents, ".setup-key-pending"))).toBe(false);
  });

  it("releases the lock after a key write", () => {
    const b = box();
    runtime(b);
    expect(setup(b, FRESH(b)).status).toBe(0);
    expect(setup(b, KEYRUN(b), { input: `${KEY}\n` }).status).toBe(0);
    expect(fs.existsSync(path.join(b.agents, ".setup-key-lock"))).toBe(false);
  });
});
