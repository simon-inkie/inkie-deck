import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

const deckDirectory = fileURLToPath(new URL("../", import.meta.url));
const instructions = readFileSync(path.join(deckDirectory, "../../INSTALL.md"), "utf8");
const template = readFileSync(path.join(deckDirectory, "scripts/deck.service"), "utf8");
const renderer = instructions.match(/<<'PY'\n([\s\S]*?)\nPY/);
// Probe the transient-unit capability used below, including in sandboxed runs.
const managerAvailable = spawnSync("systemd-run", ["--user", "--wait", "--pipe", "--collect",
  "/usr/bin/true"], { timeout: 15_000 }).status === 0;
const parserBinary = "/lib/systemd/systemd";
const parserAvailable = process.getuid?.() !== 0 &&
  spawnSync(parserBinary, ["--version"]).status === 0;
const verifierAvailable = spawnSync("systemd-analyze", ["--version"]).status === 0;
const escapeEnvironmentFile = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/\*/g, "\\*").replace(/\?/g, "\\?").replace(/\[/g, "\\[");

describe("documented Deck user service", () => {
  let sandbox: string;
  let unitPath: string;
  let rendered: string;
  let directory: string;
  let nodeBinary: string;

  beforeAll(() => {
    sandbox = mkdtempSync();
    directory = path.join(sandbox, 'checkout with spaces % and "quotes" and \\backslash [x] *?');
    mkdirSync(directory);
    nodeBinary = path.join(sandbox, 'node with \u2003 space %');
    symlinkSync(process.execPath, nodeBinary);
    writeFileSync(path.join(directory, ".env.production"), "DECK_SERVICE_PROBE=loaded\n");
    // Matches the EnvironmentFile glob if `*` and `?` are left unescaped, and
    // sorts after the real directory, so its value would clobber the probe's.
    const decoy = path.join(sandbox, 'checkout with spaces % and "quotes" and \\backslash [x] AB');
    mkdirSync(decoy);
    writeFileSync(path.join(decoy, ".env.production"), "DECK_SERVICE_PROBE=decoy\n");
    mkdirSync(path.join(directory, "scripts"));
    // CommonJS isolates systemd path handling from Node's ESM URL restrictions.
    writeFileSync(path.join(directory, "scripts/start-production.cjs"),
      'console.log(JSON.stringify({ cwd: process.cwd(), env: process.env.DECK_SERVICE_PROBE }));\n');
    unitPath = path.join(sandbox, "deck.service");
    expect(renderer, 'INSTALL.md heading "Keep it running after closing the terminal" must supply the unit renderer').not.toBeNull();
    execFileSync("python3", ["-", unitPath], {
      cwd: path.resolve(deckDirectory, "../.."),
      input: renderer![1],
      env: { ...process.env, DECK_DIRECTORY: directory, NODE_BINARY: nodeBinary },
    });
    rendered = readFileSync(unitPath, "utf8");
  });

  afterAll(() => {
    if (sandbox) rmSync(sandbox);
  });

  it("supervises the production launcher and its children without enabling reboot startup", () => {
    expect(template).toContain("Type=simple\n");
    expect(template).toContain("ExecStart=@NODE_BINARY@ scripts/start-production.mjs\n");
    expect(template).toContain("EnvironmentFile=@ENVIRONMENT_FILE@\n");
    expect(template).toContain("Restart=always\n");
    expect(template).toContain("RestartSec=5s\n");
    expect(template).toContain("StartLimitIntervalSec=60\n");
    expect(template).toContain("StartLimitBurst=5\n");
    expect(template).toContain("NoNewPrivileges=yes\n");
    expect(template).toContain("KillMode=control-group\n");
    expect(template).not.toContain("[Install]");
    expect(readFileSync(path.join(deckDirectory, "scripts/start-production.mjs"), "utf8"))
      .toContain("const root = process.cwd()");
  });

  it("renders machine-local paths and escapes systemd specifiers, globs and quoted paths", () => {
    expect(rendered).not.toMatch(/@[A-Z_]+@/);
    expect(rendered).toContain(`WorkingDirectory=${directory.replace(/%/g, "%%")}\n`);
    expect(rendered).toContain(`EnvironmentFile=${escapeEnvironmentFile(directory).replace(/%/g, "%%")}/.env.production\n`);
    expect(rendered).toContain('\\xe2\\x80\\x83');
    expect(rendered).not.toContain('\\x2003');
  });

  it("escapes EnvironmentFile as a glob while WorkingDirectory stays literal", () => {
    const fixed = '/checkouts/deck [x] *? \\dir %';
    const fixedUnit = path.join(sandbox, "fixed.service");
    execFileSync("python3", ["-", fixedUnit], {
      cwd: path.resolve(deckDirectory, "../.."),
      input: renderer![1],
      env: { ...process.env, DECK_DIRECTORY: fixed, NODE_BINARY: "/usr/bin/node" },
    });
    const unit = readFileSync(fixedUnit, "utf8");
    expect(unit).toContain("WorkingDirectory=/checkouts/deck [x] *? \\dir %%\n");
    expect(unit).toContain("EnvironmentFile=/checkouts/deck \\[x] \\*\\? \\\\dir %%/.env.production\n");
  });

  it.skipIf(!verifierAvailable)("passes systemd's unit verifier after following the documented renderer", () => {
    const result = spawnSync("systemd-analyze", ["--user", "verify", unitPath], {
      encoding: "utf8",
      env: { ...process.env, XDG_RUNTIME_DIR: sandbox, XDG_CONFIG_HOME: sandbox },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/ignoring:|not absolute|fatal error/);
  });

  it.skipIf(!parserAvailable)("parses escaped directive paths and UTF-8 command bytes with systemd", () => {
    const probePath = path.join(sandbox, "probe.service");
    writeFileSync(probePath, rendered.replace("[Unit]\n", "[Unit]\nDefaultDependencies=no\n"));
    const result = spawnSync(parserBinary, ["--user", "--test", "--unit=probe.service"], {
      encoding: "utf8",
      env: { ...process.env, XDG_RUNTIME_DIR: sandbox, XDG_CONFIG_HOME: sandbox,
        XDG_CONFIG_DIRS: sandbox, SYSTEMD_UNIT_PATH: sandbox },
      maxBuffer: 8 * 1024 * 1024,
    });
    expect(result.status, result.stderr).toBe(0);
    const unit = result.stdout.split("-> Unit probe.service:")[1]?.split("\n\t-> Unit ")[0];
    expect(unit).toBeDefined();
    expect(unit).toContain(`WorkingDirectory: ${directory}\n`);
    expect(unit).toContain(`EnvironmentFile: ${escapeEnvironmentFile(directory)}/.env.production\n`);
    expect(unit).toContain(`Command Line: "${nodeBinary}" scripts/start-production.mjs\n`);
    expect(unit).not.toContain('node with  03');
  });

  it.skipIf(!managerAvailable)("starts a launcher with a literal working directory and a glob-escaped environment file", () => {
    // Transient properties skip specifier expansion but retain glob escaping.
    const environmentFile = rendered.match(/^EnvironmentFile=(.+)$/m)![1].replace(/%%/g, "%");
    const result = spawnSync("systemd-run", ["--user", "--wait", "--pipe", "--collect",
      "--property", `WorkingDirectory=${directory}`,
      "--property", `EnvironmentFile=${environmentFile}`,
      "--property", "NoNewPrivileges=yes", nodeBinary, "scripts/start-production.cjs"],
    { encoding: "utf8", timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ cwd: directory, env: "loaded" });
  });

  it.each(["\n", "\r"])("rejects line breaks in rendered paths (%j)", (lineBreak) => {
    const result = spawnSync("python3", ["-", path.join(sandbox, "invalid.service")], {
      cwd: path.resolve(deckDirectory, "../.."), input: renderer![1], encoding: "utf8",
      env: { ...process.env, DECK_DIRECTORY: directory + lineBreak, NODE_BINARY: nodeBinary },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unit paths cannot contain line breaks");
  });

  it("documents environment-file conversion and replacing an existing tmux session", () => {
    expect(instructions).toContain("Remove any `export` prefixes and trailing inline comments");
    expect(instructions).toContain("with comments on separate lines");
    expect(instructions).toContain("If a `deck` session already exists, inspect it");
    expect(instructions).toContain("`tmux kill-session -t deck` before creating a");
    expect(instructions).toContain("`systemctl --user reset-failed deck`");
  });
});
