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
 * quotes the boot phrase, a tmux that fakes the `deck` session (and starts a
 * tiny server on the chosen port when it is created), a boot-agents that records
 * its arguments and environment, and, where a case needs it, a failing `mv`.
 */
import { spawnSync } from "node:child_process";
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
    try {
      process.kill(Number(fs.readFileSync(path.join(root, "server.pid"), "utf8")));
    } catch {
      /* no server was started */
    }
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

function freePort(): number {
  const r = spawnSync(
    process.execPath,
    ["-e", "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"],
    { encoding: "utf8" },
  );
  return Number(r.stdout.trim());
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
    port: freePort(),
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
  write(
    path.join(b.stubBin, "tmux"),
    `#!/usr/bin/env bash
echo "$@" >> "${root}/tmux.log"
case "$1" in
  has-session) [ -e "${root}/deck-up" ] ;;
  new-session)
    : > "${root}/deck-up"
    node -e "const s=require('http').createServer((q,r)=>r.end('ok')).listen(${b.port},'127.0.0.1');" >/dev/null 2>&1 </dev/null &
    echo $! > "${root}/server.pid"
    ;;
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
  write(path.join(b.stubBin, "pnpm"), `#!/bin/sh\necho "$@" >> "${root}/pnpm.log"\n`);
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

describe("a fresh run and a rerun", () => {
  it("creates the roots, .env and both agents, starts Deck, boots exactly the two names", () => {
    const b = box();
    runtime(b);
    const r = setup(b, FRESH(b));
    expect(r.status, r.output).toBe(0);
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
