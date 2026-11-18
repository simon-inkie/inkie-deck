/**
 * Stage nine: INSTALL.md's Quick setup, executed on a machine with no model CLI.
 *
 * The claim measured is the honest boundary of the one-command install: from a
 * bare Ubuntu, `scripts/setup.sh --yes --no-key`, run as an ordinary user,
 * makes the four roots, the `.env` and both starter agents, starts Deck on
 * loopback, does NOT start the agents, and exits 4 (no model CLI) rather than
 * a success. What it cannot measure is a signed-in CLI, and it does not claim
 * to: that is by hand, and INSTALL.md says so.
 *
 * Its negative control runs FIRST, in the same container and before the
 * document's block, because "nothing was written" can only be shown on a
 * machine that has not been written to yet. It plants an existing `.env` that
 * lacks `INBOX_ROOT` in a copy of the tree and expects exit 1 naming that
 * variable, the file byte-identical, and no `node_modules`, no roots and no
 * agent homes anywhere.
 */
import { control, probe } from "../lib/harness.mjs";
import { stripAnsi, tail } from "../lib/exec.mjs";
import { selectInDocumentOrder } from "../lib/fenced.mjs";
import { execIn, removeContainer, runBlocks, startContainer } from "../lib/docrun.mjs";
import { EXPECTED_EXITS, RUNS } from "../install-plan.mjs";

const USER = "rig";
const SETUP_BLOCK = "quick-setup/sh#2";

export default {
  id: "install-setup",
  title: "INSTALL.md Quick setup: one command to roots, .env, two agents and a running Deck, with no model CLI",
  async run(ctx) {
    const blocks = selectInDocumentOrder(ctx.installDoc.blocks, RUNS["quick-setup"]);
    const prerequisites = blocks.filter((block) => block.id !== SETUP_BLOCK);
    const setupBlocks = blocks.filter((block) => block.id === SETUP_BLOCK);
    const container = await startContainer({
      image: ctx.installBaseImage,
      name: "inkie-deck-rig-setup",
      containerPort: 4242,
    });

    const asUser = (script) =>
      execIn(
        container.name,
        `runuser -u ${USER} -- env HOME=/home/${USER} USER=${USER} LOGNAME=${USER} LANG=C.UTF-8 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -c ${shellQuote(script)}`,
      );

    let prereqRun;
    let setupRun;
    let controlOut;
    let onDisk;
    try {
      prereqRun = runBlocks({ name: container.name, blocks: prerequisites });

      // NEGATIVE CONTROL, before anything real is written.
      execIn(container.name, `id ${USER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${USER}`);
      controlOut = asUser(
        [
          "set -u",
          "cp -a /src $HOME/ctl",
          "cd $HOME/ctl",
          "printf 'ATTACHMENTS_ROOT=%s/deck/attachments\\nPROJECTS_ROOT=%s/deck/projects\\nDATA_ROOT=%s/deck/data\\nMC_USER=rig\\n' \"$HOME\" \"$HOME\" \"$HOME\" > packages/deck/.env",
          "sha256sum packages/deck/.env > /tmp/env.before",
          "scripts/setup.sh --yes --no-key 2>&1",
          'echo "###CONTROL-EXIT $?"',
          "sha256sum -c /tmp/env.before >/dev/null 2>&1 && echo '###ENV-IDENTICAL' || echo '###ENV-CHANGED'",
          "[ -e $HOME/ctl/node_modules ] && echo '###NODE-MODULES' || echo '###NO-NODE-MODULES'",
          "[ -e \"$HOME/deck\" ] && echo '###ROOTS' || echo '###NO-ROOTS'",
          "[ -e \"$HOME/agents\" ] && echo '###AGENTS' || echo '###NO-AGENTS'",
        ].join("\n"),
      );
      // The control ran on a copy, so the real run starts from the tree it was given.
      execIn(container.name, `rm -rf /home/${USER}/ctl /tmp/env.before`);

      setupRun = runBlocks({
        name: container.name,
        blocks: setupBlocks,
        asUser: { user: USER, ids: [SETUP_BLOCK] },
      });

      onDisk = asUser(
        [
          "echo '###ROOTS'",
          "ls -1 $HOME/deck",
          "echo '###ENV'",
          "cat /src/packages/deck/.env",
          "echo '###KINDS'",
          "for a in inkie doctor; do printf '%s=%s ' $a \"$(cat $HOME/agents/$a/.kind 2>&1)\"; done; echo",
          "echo '###STATUS'",
          "for a in inkie doctor; do AGENTS_HOME=$HOME/agents INBOX_ROOT=$HOME/deck/inbox /src/packages/base/bin/create-agent.sh --status $a; done",
          "echo '###DECK'",
          "curl -sS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:4242/",
          "echo '###BANNER'",
          "tmux capture-pane -p -t deck | grep -E 'app on|is loopback' | head -3",
          "echo '###SESSIONS'",
          "tmux list-sessions -F '#{session_name}' 2>&1",
          "echo '###AGENTS-SESSION'",
          "tmux has-session -t agents >/dev/null 2>&1 && echo present || echo absent",
        ].join("\n"),
      );
    } finally {
      removeContainer(container.name);
    }

    const section = (name) => sliceBetween(stripAnsi(onDisk.output), `###${name}`);
    const setupExit = setupRun.exits[SETUP_BLOCK];
    const setupOutput = setupRun.blockOutput[SETUP_BLOCK] ?? "";
    const control_ = stripAnsi(controlOut.output);
    const controlExit = /###CONTROL-EXIT (\d+)/.exec(control_)?.[1] ?? null;
    const sessions = section("SESSIONS").split("\n").map((line) => line.trim());

    const probes = [
      probe({
        id: "driver-completed",
        title: "the prerequisites and the Quick setup block were executed to the end",
        ok: prereqRun.completed && setupRun.completed,
        detail: `${blocks.length} blocks`,
      }),
      ...prerequisites.map((block) =>
        probe({
          id: `block-${block.id}`,
          title: `\`${block.text.split("\n")[0].slice(0, 60)}\` exits 0`,
          ok: prereqRun.exits[block.id] === 0,
          detail: `exit ${prereqRun.exits[block.id]}`,
        }),
      ),
      probe({
        id: "setup-exits-4-with-no-model-cli",
        title: "scripts/setup.sh --yes --no-key exits 4, the code the document documents, and says the agents were not started",
        ok: setupExit === (EXPECTED_EXITS[SETUP_BLOCK]?.code ?? 0) && /were not started/.test(setupOutput),
        detail: `exit ${setupExit} (expected ${EXPECTED_EXITS[SETUP_BLOCK]?.code}); ${oneLine(setupOutput.split("\n").slice(-4).join(" "))}`,
      }),
      probe({
        id: "roots-and-env-written",
        title: "the four roots exist and .env carries MC_USER and AGENTS_ROOT",
        ok:
          ["attachments", "data", "inbox", "projects"].every((dir) => section("ROOTS").split("\n").includes(dir)) &&
          /^MC_USER=rig$/m.test(section("ENV")) &&
          /^AGENTS_ROOT=\/home\/rig\/agents$/m.test(section("ENV")),
        detail: `${oneLine(section("ROOTS"))} | ${oneLine(section("ENV"))}`,
      }),
      probe({
        id: "both-starters-complete",
        title: "both starter agents have their kind markers and read complete under --status",
        ok:
          /inkie=assistant/.test(section("KINDS")) &&
          /doctor=platform/.test(section("KINDS")) &&
          section("STATUS").split("\n").map((line) => line.trim()).join(",") === "complete,complete",
        detail: `${oneLine(section("KINDS"))} | ${oneLine(section("STATUS"))}`,
      }),
      probe({
        id: "deck-answers-on-loopback",
        title: "Deck answers 200 on 127.0.0.1:4242 inside the container, and the launcher banner says loopback",
        ok:
          section("DECK").trim() === "200" &&
          /app on http:\/\/127\.0\.0\.1:4242/.test(section("BANNER")) &&
          /is loopback/.test(section("BANNER")),
        detail: `${oneLine(section("DECK"))} | ${oneLine(section("BANNER"))}`,
      }),
      probe({
        id: "agents-not-started",
        title: "a tmux session named deck exists and there is no agents session",
        ok: sessions.includes("deck") && !sessions.includes("agents") && section("AGENTS-SESSION").trim() === "absent",
        detail: `${oneLine(section("SESSIONS"))} | agents: ${oneLine(section("AGENTS-SESSION"))}`,
      }),
    ];

    const controls = [
      control({
        id: "env-missing-a-root-stops-setup-before-any-write",
        title: "setup against an existing .env that lacks INBOX_ROOT",
        expectation:
          "exit 1 naming INBOX_ROOT, the .env byte-identical, and no node_modules, no roots and no agent homes",
        satisfied:
          controlExit === "1" &&
          /INBOX_ROOT is not set/.test(control_) &&
          control_.includes("###ENV-IDENTICAL") &&
          control_.includes("###NO-NODE-MODULES") &&
          control_.includes("###NO-ROOTS") &&
          control_.includes("###NO-AGENTS"),
        observed: `exit ${controlExit ?? "(no marker)"}; ${oneLine(control_.split("###CONTROL-EXIT")[0].split("\n").slice(-3).join(" "))}; ${(control_.match(/^###(?!CONTROL-EXIT)[A-Z-]+$/gm) ?? []).join(" ")}`,
      }),
    ];

    return {
      probes,
      controls,
      evidence: {
        exits: { ...prereqRun.exits, ...setupRun.exits },
        setup: tail(setupOutput, 30),
        control: tail(controlOut.output, 20),
        deck: section("BANNER"),
      },
    };
  },
};

/** Single-quote a script for `bash -c`. */
function shellQuote(text) {
  return `'${String(text).replaceAll("'", `'\\''`)}'`;
}

/** The text between one `###MARKER` and the next, from a single exec's output. */
function sliceBetween(output, marker) {
  const start = output.indexOf(marker);
  if (start < 0) return "";
  const from = start + marker.length;
  const next = output.slice(from).search(/^###[A-Z-]+$/m);
  return (next < 0 ? output.slice(from) : output.slice(from, from + next)).trim();
}

function oneLine(text) {
  return stripAnsi(String(text ?? "")).replace(/\s+/g, " ").trim().slice(0, 240);
}
