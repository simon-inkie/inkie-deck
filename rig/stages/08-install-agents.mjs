/**
 * Stage eight: tier 3 of INSTALL.md, executed as far as a machine with no
 * model subscription can go.
 *
 * The document says this tier is manual and cannot be otherwise from here. It
 * is worth being precise about what that means, because "we cannot test it" is
 * usually where a guide starts making claims nobody checks. What genuinely
 * cannot be done in a container is INSTALL, AUTHENTICATE and BILL a model CLI.
 * Everything on this side of that line is machinery, and machinery is testable:
 * an agent's two directories, a tmux session with a window per agent, the
 * application reading that pane live, and the message protocol round-tripping
 * from the application to a file to the CLI and back.
 *
 * So this stage runs all of it, and asserts the boundary itself: the creation
 * script must exit 4 CANNOT VERIFY, and the live-delivery push must REFUSE the
 * pane, because there is no model there. Both of those are the tooling
 * declining to claim something it has not established, and a run in which they
 * quietly succeeded would be the finding.
 *
 * The assertions here are chosen against a specific trap recorded in the
 * baseline: the application's tmux flag is on by default and never probes for
 * the binary, so "tmuxOn is true" and "the tmux route returns 200" are both
 * satisfied on a machine with no tmux installed at all. The probe that cannot
 * be satisfied that way is the contents of a real pane appearing in the page.
 */
import { control, probe } from "../lib/harness.mjs";
import { stripAnsi, tail } from "../lib/exec.mjs";
import { selectInDocumentOrder } from "../lib/fenced.mjs";
import { execIn, fetchOutside, removeContainer, runBlocks, startContainer, waitForHttp } from "../lib/docrun.mjs";
import { EXPECTED_EXITS, LONG_RUNNING, RUNS } from "../install-plan.mjs";

const AGENT = "wren";
/** The reply the document's own block sends, which must survive the round trip. */
const REPLY_MARKER = "the whole protocol";
/** The block that stands in for the agent, and the one this tier's fresh-terminal control re-runs. */
const CLI_BLOCK = "send-a-message-and-answer-it-as-the-agent/sh#2";

export default {
  id: "install-agents",
  title: "INSTALL.md tier 3: agent creation, tmux, and the message protocol, with no model CLI",
  async run(ctx) {
    const blocks = selectInDocumentOrder(ctx.installDoc.blocks, RUNS["run-it-and-agents"]);
    const container = await startContainer({
      image: ctx.installBaseImage,
      name: "inkie-deck-rig-agents",
      containerPort: 4242,
    });

    let run;
    let onDisk;
    let paneView;
    let threadView;
    let agentListed;
    let bootControl;
    let cliControl;
    let freshTerminal;
    try {
      run = runBlocks({ name: container.name, blocks, longRunning: LONG_RUNNING });

      onDisk = execIn(
        container.name,
        [
          "echo '###HOMES'",
          `ls -1 $HOME/agents/${AGENT} 2>&1`,
          "echo '###INBOX'",
          `ls -1 $HOME/deck/inbox/${AGENT}/inbox 2>&1`,
          "echo '###THREAD'",
          `cat $HOME/deck/inbox/${AGENT}/inbox/$(id -un).md 2>&1`,
          "echo '###WINDOWS'",
          "tmux list-windows -t agents -F '#{window_name}' 2>&1",
          "echo '###PANE'",
          `tmux capture-pane -t agents:${AGENT} -p 2>&1 | grep -v '^$' | tail -5`,
        ].join("\n"),
      );

      await waitForHttp(`http://127.0.0.1:${container.hostPort}/`, { attempts: 10 });
      agentListed = await fetchOutside(`http://127.0.0.1:${container.hostPort}/`);
      threadView = await fetchOutside(`http://127.0.0.1:${container.hostPort}/threads/${AGENT}`);
      paneView = await fetchOutside(`http://127.0.0.1:${container.hostPort}/threads/${AGENT}?view=tmux`);

      // NEGATIVE CONTROL 1. The launcher against a home with no agents in it.
      // Every new reader is in exactly that state, and this used to abort with
      // `AGENTS[0]: unbound variable`. It also proves the tmux probes above are
      // not passing on something that would pass regardless.
      bootControl = execIn(
        container.name,
        "cd /src && AGENTS_HOME=$HOME/no-agents-here packages/base/bin/boot-agents.sh 2>&1; echo \"###CONTROL-EXIT $?\"",
      );

      // NEGATIVE CONTROL 2. The CLI with its identity unset. It has no default
      // and must refuse, because a guessed identity writes a message into
      // somebody else's thread and looks like it worked.
      cliControl = execIn(
        container.name,
        "cd /src && env -u AGENT_NAME packages/base/bin/inbox unread 2>&1; echo \"###CONTROL-EXIT $?\"",
      );

      // NEGATIVE CONTROL 3, and the only one here aimed at the RUNNER rather
      // than at the product. This whole file executes the document in one
      // shell, which is more forgiving than a reader: tier 3 has them opening
      // tmux panes, so anything an earlier block only exported is gone by the
      // time they arrive, while in here it is still set. That gap hid a real
      // defect for a day. The two halves below are run in shells that share
      // nothing with the driver's, which is what a new pane actually is:
      //
      //   OLD: the shape this block used to have, `inbox reply "$ME"` with the
      //        variable never set. It must be seen to exit 0 and write a file
      //        called `.md` belonging to nobody, because a control that has
      //        only ever watched the fixed version prove nothing about the trap.
      //   NEW: the block's own bytes, from the file the runner staged, so this
      //        re-runs the DOCUMENT and not a retyped copy of it.
      freshTerminal = execIn(
        container.name,
        [
          "cd /src",
          "echo '###OLD-SHAPE'",
          `env -u ME AGENT_NAME=${AGENT} INBOX_ROOT=$HOME/deck/inbox bash -c 'packages/base/bin/inbox reply "$ME" --subject "re: welcome" --body "typed in a terminal with no ME in it"' 2>&1`,
          'echo "###OLD-EXIT $?"',
          "echo '###OLD-FILES'",
          `ls -1a $HOME/deck/inbox/${AGENT}/inbox`,
          "echo '###NEW-SHAPE'",
          `env -u ME bash ${run.files[CLI_BLOCK]} 2>&1`,
          'echo "###NEW-EXIT $?"',
          "echo '###WHOAMI'",
          "id -un",
        ].join("\n"),
      );
    } finally {
      removeContainer(container.name);
    }

    const section = (name) => sliceBetween(stripAnsi(onDisk.output), `###${name}`);
    const createExit = run.exits["create-an-agent/sh#1"];
    const createOutput = run.blockOutput["create-an-agent/sh#1"] ?? "";
    const cliOutput = run.blockOutput[CLI_BLOCK] ?? "";
    const postOutput = run.blockOutput["send-a-message-and-answer-it-as-the-agent/sh#1"] ?? "";
    const paneCapture = section("PANE");
    const bootControlExit = /###CONTROL-EXIT (\d+)/.exec(stripAnsi(bootControl.output))?.[1] ?? null;
    const cliControlExit = /###CONTROL-EXIT (\d+)/.exec(stripAnsi(cliControl.output))?.[1] ?? null;

    const fresh = stripAnsi(freshTerminal.output);
    const freshWhoami = freshSection(fresh, "###WHOAMI", null);
    const oldShape = freshSection(fresh, "###OLD-SHAPE", "###OLD-EXIT");
    const oldExit = /###OLD-EXIT (\d+)/.exec(fresh)?.[1] ?? null;
    const oldFiles = freshSection(fresh, "###OLD-FILES", "###NEW-SHAPE").split("\n").map((line) => line.trim());
    const newShape = freshSection(fresh, "###NEW-SHAPE", "###NEW-EXIT");
    const newExit = /###NEW-EXIT (\d+)/.exec(fresh)?.[1] ?? null;
    // The trap: exit 0, `replied to` with nothing after it, and a dotfile that
    // `ls` does not even show. Every one of those three is required, because
    // any one of them alone is also what a control that stopped running looks
    // like.
    const oldSilentlySucceeded = oldExit === "0" && /^replied to\s*$/m.test(oldShape) && oldFiles.includes(".md");
    const newNamesTheUser =
      newExit === "0" && Boolean(freshWhoami) && newShape.includes(`replied to ${freshWhoami}`);

    const probes = [
      probe({
        id: "driver-completed",
        title: "the whole document, tier 3 included, was executed to the end",
        ok: run.completed,
        detail: run.completed ? `${blocks.length} blocks` : "the driver stopped early",
      }),
      ...blocks
        .filter((block) => !LONG_RUNNING[block.id])
        .map((block) => {
          const expected = EXPECTED_EXITS[block.id]?.code ?? 0;
          return probe({
            id: `block-${block.id}`,
            title:
              expected === 0
                ? `\`${firstLine(block)}\` exits 0`
                : `\`${firstLine(block)}\` exits ${expected}, the code the document documents here`,
            ok: run.exits[block.id] === expected,
            detail:
              run.exits[block.id] === null
                ? "no exit marker: the block never completed"
                : `exit ${run.exits[block.id]} (expected ${expected})`,
          });
        }),
      probe({
        id: "creation-refuses-to-claim-verification",
        title: "create-agent.sh reports CANNOT VERIFY rather than success, with no model CLI present",
        // The point of the tier-3 boundary, asserted as words and not only as
        // an exit code: a script that had quietly reported success here would
        // be the finding, not a convenience.
        ok:
          createExit === 4 &&
          /CANNOT VERIFY/.test(createOutput) &&
          /No `claude` on PATH/.test(createOutput),
        detail: oneLine(createOutput),
      }),
      probe({
        id: "agent-has-both-homes",
        title: "the agent exists in both places that have to agree: persona files and an inbox",
        ok: /SOUL\.md/.test(section("HOMES")) && /CLAUDE\.md/.test(section("HOMES")) && !/No such file/.test(section("INBOX")),
        detail: `${oneLine(section("HOMES"))} | inbox: ${oneLine(section("INBOX")) || "(empty, which is correct before any message)"}`,
      }),
      probe({
        id: "application-lists-the-new-agent",
        title: "the running application lists the agent with no restart",
        ok: agentListed.reached && agentListed.body.includes(AGENT) && !agentListed.body.includes("No agents yet"),
        detail: `status ${agentListed.status}; names it: ${agentListed.body.includes(AGENT)}; still empty-state: ${agentListed.body.includes("No agents yet")}`,
      }),
      probe({
        id: "tmux-window-exists",
        title: "boot-agents.sh started a session with a window named after the agent",
        ok: section("WINDOWS").split("\n").map((line) => line.trim()).includes(AGENT),
        detail: oneLine(section("WINDOWS")),
      }),
      probe({
        id: "pane-shows-the-missing-model-cli",
        title: "the pane holds the shell and the missing model CLI, which is what this machine should show",
        ok: /claude: command not found/.test(paneCapture),
        detail: oneLine(paneCapture),
      }),
      probe({
        id: "application-renders-the-live-pane",
        title: "the application's terminal view carries the actual contents of that pane",
        // The one assertion in this area that cannot pass with tmux absent.
        // A 200, or the tmux flag, or the window name appearing in the nav are
        // all satisfied on a machine with no tmux at all.
        ok: paneView.reached && paneView.body.includes("claude: command not found"),
        detail: `status ${paneView.status}; pane text present: ${paneView.body.includes("claude: command not found")}`,
      }),
      probe({
        id: "message-sent-through-the-application",
        title: "the document's POST writes a block into the agent's thread file",
        ok: postOutput.trim().endsWith("200") && /from: /.test(section("THREAD")),
        detail: `POST said ${oneLine(postOutput)}; thread file: ${oneLine(section("THREAD"))}`,
      }),
      probe({
        id: "cli-reads-and-replies",
        title: "the inbox CLI sees that message unread, reads it, and appends a reply",
        // The correspondent is the human's MC_USER name, which the document
        // takes from `id -un`, so the reply line is matched by shape rather
        // than against a name this rig would have to know.
        ok: /: 1 unread/.test(cliOutput) && /^replied to \S+$/m.test(cliOutput),
        detail: oneLine(cliOutput),
      }),
      probe({
        id: "reply-is-on-disk-in-protocol-shape",
        title: "the reply is in the same thread file, and the original block is now marked read",
        // Not asserted: the status on the AGENT's own block. The last thing
        // the document does is fetch the thread, and the application marks an
        // agent's message read when the human reads it, so that field is a
        // race with the document's own final step rather than a property of
        // the CLI. What the CLI is responsible for is the flip on the human's
        // block, and its own block existing with the right text in it.
        ok:
          section("THREAD").includes(REPLY_MARKER) &&
          /from: \S+ - status: read/.test(section("THREAD")) &&
          /from: wren - status: \S+ - subject: re: welcome/.test(section("THREAD")),
        detail: oneLine(section("THREAD")),
      }),
      probe({
        id: "application-shows-the-reply",
        title: "and the application serves that reply back",
        ok: threadView.reached && threadView.body.includes(REPLY_MARKER),
        detail: `status ${threadView.status}; carries the reply: ${threadView.body.includes(REPLY_MARKER)}`,
      }),
      probe({
        id: "live-push-refuses-a-pane-with-no-model-in-it",
        title: "the live-delivery half declines to type into a pane that is not a model CLI",
        // Recorded as a finding rather than a failure: the refusal is correct,
        // and the report should carry the exact wording, because a reader who
        // sees it needs to know their message was still persisted.
        ok: /push: skip/.test(cliOutput),
        severity: "finding",
        detail: oneLine(cliOutput.split("\n").filter((line) => line.includes("push:")).join(" ")) || "no push line printed",
      }),
    ];

    const controls = [
      control({
        id: "launcher-refuses-an-empty-agents-home",
        title: "boot-agents.sh pointed at a home with no agents in it",
        expectation: "non-zero exit naming AGENTS_HOME, not a tmux session started anyway",
        satisfied:
          bootControlExit !== null &&
          bootControlExit !== "0" &&
          /no agents found in/.test(stripAnsi(bootControl.output)),
        observed: `exit ${bootControlExit ?? "(no marker)"}; ${oneLine(bootControl.output)}`,
      }),
      control({
        id: "tier-3-block-survives-a-fresh-terminal",
        title: "the tier-3 CLI block, and the shape it replaced, each run in a shell that inherits nothing",
        // Both halves in one control on purpose. "The block still works in a
        // new terminal" is satisfied by a block that never needed one, so the
        // old shape has to be shown failing in exactly the way that made this
        // worth fixing: not an error, a success that wrote to nobody.
        expectation:
          "`inbox reply \"$ME\"` with ME unset exits 0 and writes `.md`, while the document's own block derives the name and replies to the real user",
        satisfied: oldSilentlySucceeded && newNamesTheUser,
        observed:
          `old shape: exit ${oldExit ?? "(no marker)"}, said "${oneLine(oldShape)}", wrote .md: ${oldFiles.includes(".md")}; ` +
          `document's block: exit ${newExit ?? "(no marker)"}, ${oneLine(newShape)} (user ${freshWhoami || "(unknown)"})`,
      }),
      control({
        id: "cli-refuses-without-an-identity",
        title: "the inbox CLI with AGENT_NAME unset",
        expectation: "non-zero exit naming AGENT_NAME, never a guessed identity",
        satisfied:
          cliControlExit !== null &&
          cliControlExit !== "0" &&
          /AGENT_NAME/.test(stripAnsi(cliControl.output)),
        observed: `exit ${cliControlExit ?? "(no marker)"}; ${oneLine(cliControl.output)}`,
      }),
    ];

    return {
      probes,
      controls,
      evidence: {
        exits: run.exits,
        create: createOutput,
        cli: cliOutput,
        pane: paneCapture,
        thread: section("THREAD"),
        windows: section("WINDOWS"),
        freshTerminal: tail(freshTerminal.output, 24),
        log: tail(run.raw, 30),
      },
    };
  },
};

/**
 * The text between two NAMED markers.
 *
 * Not `sliceBetween`: that one finds the next marker by shape, and half of
 * these markers carry a value on the same line (`###OLD-EXIT 0`), which that
 * pattern does not match. Naming both ends is unambiguous and cannot silently
 * swallow the section after the one asked for.
 *
 * @param {string} output @param {string} from @param {string|null} to
 */
function freshSection(output, from, to) {
  const start = output.indexOf(from);
  if (start < 0) return "";
  const begin = start + from.length;
  const end = to ? output.indexOf(to, begin) : -1;
  return (end < 0 ? output.slice(begin) : output.slice(begin, end)).trim();
}

/** The text between one `###MARKER` and the next, from a single exec's output. */
function sliceBetween(output, marker) {
  const start = output.indexOf(marker);
  if (start < 0) return "";
  const from = start + marker.length;
  const next = output.slice(from).search(/^###[A-Z-]+$/m);
  return (next < 0 ? output.slice(from) : output.slice(from, from + next)).trim();
}

function firstLine(block) {
  return block ? block.text.split("\n")[0].slice(0, 60) : "(missing)";
}

function oneLine(text) {
  return stripAnsi(String(text ?? "")).replace(/\s+/g, " ").trim().slice(0, 240);
}
