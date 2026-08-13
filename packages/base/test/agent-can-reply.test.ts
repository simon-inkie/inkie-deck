/**
 * THE ACCEPTANCE TEST.
 *
 * One question: can a newly created agent reply to a message it was sent,
 * without a human hand-writing anything into its files?
 *
 * That is not a restatement of the other suites. It is the exact gap a live
 * end-to-end run found: an agent created by bin/create-agent.sh could RECEIVE
 * messages and had no way to answer one, while every message the application
 * pushes into its terminal ends with the hint
 * `[reply via inbox: inbox reply <name>]`, naming a command that did not exist
 * in this repository. Each half worked. The join did not, and nothing tested
 * the join.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE OTHER SUITES, and it is the only thing
 * that makes it worth having: the environment the CLI runs in is DERIVED FROM
 * THE ARTEFACTS THE SCRIPT PRODUCED, never assembled by the test. The test
 * reads the env block out of the settings.json that create-agent.sh wrote and
 * builds PATH the way bin/boot-agents.sh builds it. If the script stops
 * stamping INBOX_ROOT, or stops installing the CLI, this goes red. A test that
 * set those variables itself would pass over both failures, and would be
 * exactly the "files exist, so it must work" check that this area's whole
 * history says is worthless.
 *
 * The command is invoked by its BARE NAME, `inbox`, because that is what the
 * pane hint tells the agent to type. Calling it by absolute path would test a
 * different claim than the one the product makes to the agent.
 *
 * WHAT THIS DOES NOT COVER, stated so nobody reads it as more than it is:
 *   - that a live model, handed this TOOLS.md, CHOOSES to run the command.
 *     bin/create-agent.sh --verify covers the adjacent claim (that the persona
 *     file reaches the model at all) and needs a real runtime.
 *   - live tmux delivery. Push is suppressed here with INBOX_NO_PUSH=1;
 *     test/inbox-push.test.sh covers the delivery half through its own seams.
 *     Persist is the guarantee and push is best-effort over it, so a reply is
 *     complete without it.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(PACKAGE_ROOT, "bin", "create-agent.sh");

const AGENT = "wren";

/**
 * create-agent.sh exits 4 (CANNOT_VERIFY) under --no-verify: the agent was
 * created, and the boot-phrase verification that needs a live model was
 * skipped. That is a success for this test's purposes and a deliberate part of
 * the script's contract, so it is asserted by name rather than tolerated with a
 * loose "not an error" check.
 */
const EXIT_CANNOT_VERIFY = 4;
const HUMAN = "courier";

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

interface Sandbox {
  home: string;
  agentsHome: string;
  inboxRoot: string;
}

function sandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-can-reply-"));
  tempRoots.push(root);
  const box = {
    home: path.join(root, "home"),
    agentsHome: path.join(root, "agents"),
    inboxRoot: path.join(root, "inbox"),
  };
  for (const dir of Object.values(box)) fs.mkdirSync(dir, { recursive: true });
  return box;
}

/**
 * Rebuild the environment a shell command run BY THE AGENT would see.
 *
 * Two sources, both of them artefacts rather than test constants:
 *   - the `env` block of the settings file create-agent.sh wrote, which is how
 *     AGENT_NAME already reaches an agent's shell and therefore how INBOX_ROOT
 *     does too;
 *   - PATH built as bin/boot-agents.sh builds it, prepending ~/.local/bin,
 *     which is the directory create-agent.sh links the CLI into.
 */
function agentShellEnv(box: Sandbox): Record<string, string> {
  const settingsPath = path.join(box.agentsHome, AGENT, ".claude", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
    env?: Record<string, string>;
  };
  const stamped = settings.env ?? {};

  return {
    ...stamped,
    HOME: box.home,
    // Exactly boot-agents.sh's prepend, and then a minimal base PATH. Not
    // inherited: a real `inbox` on the developer's machine must not be able to
    // answer for the one the script was supposed to install.
    PATH: [
      path.join(box.home, ".local", "bin"),
      path.dirname(process.execPath),
      "/usr/bin",
      "/bin",
    ].join(path.delimiter),
    // No live tmux in this test. Push is best-effort over a guaranteed persist;
    // suppressing it does not weaken the claim being made here.
    INBOX_NO_PUSH: "1",
  };
}

/** Run a bare command name in the agent's own derived environment. */
function asAgent(box: Sandbox, args: readonly string[]) {
  const result = spawnSync("inbox", args, {
    encoding: "utf8",
    env: agentShellEnv(box),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

/**
 * Seed an inbound message the way the application writes one: appended to the
 * recipient's thread file, from the sender, status sent.
 */
function seedInbound(box: Sandbox, subject: string, body: string): string {
  const thread = path.join(box.inboxRoot, AGENT, "inbox", `${HUMAN}.md`);
  fs.mkdirSync(path.dirname(thread), { recursive: true });
  fs.appendFileSync(
    thread,
    `\n## 2026-08-13T09:00:00Z - from: ${HUMAN} - status: sent - subject: ${subject}\n\n${body}\n`,
    "utf8"
  );
  return thread;
}

describe("a newly created agent can reply, with nothing hand-written into its files", () => {
  it("creates, receives, reads and replies end to end", () => {
    const box = sandbox();

    // 1. Create the agent exactly as an operator would. --no-verify because
    //    the verification half needs a live model; it is a different claim.
    const created = spawnSync("bash", [SCRIPT, AGENT, "--no-verify"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: box.home,
        AGENTS_HOME: box.agentsHome,
        INBOX_ROOT: box.inboxRoot,
        PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      },
    });
    expect(
      created.status,
      `create-agent.sh failed:\n${created.stdout}\n${created.stderr}`
    ).toBe(EXIT_CANNOT_VERIFY);

    // 2. A message arrives, as the application would deliver it.
    const thread = seedInbound(box, "first contact", "Please confirm you can hear me.");

    // 3. The agent sees it. Bare command name, derived environment: this single
    //    assertion covers AGENT_NAME reaching the shell, INBOX_ROOT reaching
    //    the shell, and the CLI resolving on PATH. If any one of the three is
    //    missing this fails, which is the whole point of not setting them here.
    const unread = asAgent(box, ["unread"]);
    expect(
      unread.error,
      `the bare command 'inbox' did not resolve on the agent's PATH: ${unread.error?.message}`
    ).toBeUndefined();
    expect(unread.status, `inbox unread failed: ${unread.stderr}`).toBe(0);
    expect(unread.stdout).toContain(`${HUMAN}: 1 unread`);

    const read = asAgent(box, ["read", HUMAN]);
    expect(read.status, `inbox read failed: ${read.stderr}`).toBe(0);
    expect(read.stdout).toContain("Please confirm you can hear me.");

    // 4. THE ACCEPTANCE CRITERION. The exact command the pane hint names.
    const reply = asAgent(box, [
      "reply",
      HUMAN,
      "--subject",
      "re: first contact",
      "--body",
      "Heard you. Replying from my own terminal.",
    ]);
    expect(reply.status, `inbox reply failed: ${reply.stderr}`).toBe(0);
    expect(reply.stdout).toContain(`replied to ${HUMAN}`);

    // 5. The reply is on disk, in the protocol's own terms, in the same thread.
    const after = fs.readFileSync(thread, "utf8");
    expect(after).toContain(`from: ${AGENT} - status: sent - subject: re: first contact`);
    expect(after).toContain("Heard you. Replying from my own terminal.");

    // And the inbound message was marked read by the act of reading it, so the
    // sender gets a receipt without anyone doing anything further.
    expect(after).toContain(`from: ${HUMAN} - status: read`);
  });

  it("the agent is TOLD how to reply, without a human writing the instructions", () => {
    // The step above proves the mechanism works. This proves the agent can
    // discover it: the reply path is worthless if nothing in the agent's own
    // context names the command. TOOLS.md is loaded as part of its persona.
    const box = sandbox();
    const created = spawnSync("bash", [SCRIPT, AGENT, "--no-verify"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: box.home,
        AGENTS_HOME: box.agentsHome,
        INBOX_ROOT: box.inboxRoot,
        PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      },
    });
    expect(created.status, created.stdout + created.stderr).toBe(EXIT_CANNOT_VERIFY);

    const tools = fs.readFileSync(path.join(box.agentsHome, AGENT, "TOOLS.md"), "utf8");

    // Its own name, so the examples are usable rather than generic.
    expect(tools).toContain(AGENT);
    // The command the pane hint names.
    expect(tools).toContain("inbox reply");
    // The absolute path, which is the fallback when the PATH install was
    // skipped (an occupied ~/.local/bin, or --no-install-path).
    expect(tools).toContain(path.join(PACKAGE_ROOT, "bin", "inbox"));
    // No placeholder left unstamped.
    expect(tools).not.toContain("stamped at creation");
  });
});
