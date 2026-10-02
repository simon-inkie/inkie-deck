import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

const deckDirectory = fileURLToPath(new URL("../", import.meta.url));
const instructions = readFileSync(path.join(deckDirectory, "../../INSTALL.md"), "utf8");
const template = readFileSync(path.join(deckDirectory, "scripts/deck.service"), "utf8");
const verifierAvailable = spawnSync("systemd-analyze", ["--version"]).status === 0;

describe("documented Deck user service", () => {
  let sandbox: string;
  let unitPath: string;
  let rendered: string;

  beforeAll(() => {
    sandbox = mkdtempSync();
    const directory = path.join(sandbox, 'checkout with spaces % and "quotes"');
    mkdirSync(directory);
    unitPath = path.join(sandbox, "deck.service");
    const renderer = instructions.match(/<<'PY'\n([\s\S]*?)\nPY/);
    expect(renderer, "INSTALL.md must supply the unit renderer").not.toBeNull();
    execFileSync("python3", ["-", unitPath], {
      cwd: path.resolve(deckDirectory, "../.."),
      input: renderer![1],
      env: { ...process.env, DECK_DIRECTORY: directory, NODE_BINARY: process.execPath },
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
    expect(template).toContain("KillMode=control-group\n");
    expect(template).not.toContain("[Install]");
    expect(readFileSync(path.join(deckDirectory, "scripts/start-production.mjs"), "utf8"))
      .toContain("const root = process.cwd()");
  });

  it("renders machine-local paths and escapes systemd specifiers and quoted paths", () => {
    expect(rendered).not.toMatch(/@[A-Z_]+@/);
    expect(rendered).toContain(`WorkingDirectory=${sandbox}`);
    expect(rendered).toContain('checkout\\x20with\\x20spaces\\x20%%\\x20and\\x20\\x22quotes\\x22');
    expect(rendered).toContain('quotes\\x22/.env.production\n');
    expect(rendered).toContain(`ExecStart="${process.execPath.replace(/%/g, "%%")}" scripts/start-production.mjs`);
  });

  it.skipIf(!verifierAvailable)("passes systemd's unit verifier after following the documented renderer", () => {
    const result = spawnSync("systemd-analyze", ["--user", "verify", unitPath], {
      encoding: "utf8",
      env: { ...process.env, XDG_RUNTIME_DIR: sandbox, XDG_CONFIG_HOME: sandbox },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/ignoring:|not absolute|fatal error/);
  });
});
