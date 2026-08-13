/**
 * Stage seven: tier 2 of INSTALL.md, executed twice.
 *
 * TWO CONTAINERS, ONE DOCUMENT. The first runs the production section as the
 * document's defaults leave it, which binds loopback. The second adds the
 * document's own optional "reaching it from another machine" block and nothing
 * else. The probe against them is the same function, from the same process,
 * outside both network namespaces, and it must be refused by the first and
 * answered by the second.
 *
 * That pairing is the point. A published-port check that has only ever been
 * seen to pass cannot distinguish a correct bind from a probe that returns
 * true, and a loopback bind is exactly the failure that leaves a container
 * image unreachable while its launcher prints a healthy banner.
 */
import { control, probe } from "../lib/harness.mjs";
import { stripAnsi, tail } from "../lib/exec.mjs";
import { selectInDocumentOrder } from "../lib/fenced.mjs";
import { execIn, fetchOutside, removeContainer, runBlocks, startContainer, waitForHttp } from "../lib/docrun.mjs";
import { LONG_RUNNING, RUNS } from "../install-plan.mjs";

/** Copy from the empty-state screen. Present only if the app rendered its own UI. */
const EMPTY_STATE = ["Nothing needs you", "No agents yet"];

export default {
  id: "install-run-it",
  title: "INSTALL.md tier 2, executed twice: as documented, and with the document's publish step",
  async run(ctx) {
    const loopbackBlocks = selectInDocumentOrder(ctx.installDoc.blocks, RUNS["run-it-loopback"]);
    const reachableBlocks = selectInDocumentOrder(ctx.installDoc.blocks, RUNS["run-it-reachable"]);

    const loopback = await startContainer({
      image: ctx.installBaseImage,
      name: "inkie-deck-rig-loopback",
      containerPort: 4242,
    });
    const reachable = await startContainer({
      image: ctx.installBaseImage,
      name: "inkie-deck-rig-reachable",
      containerPort: 4242,
    });

    let loopbackRun;
    let reachableRun;
    let loopbackOutside;
    let reachableOutside;
    let loopbackInside;
    let identity;
    let missingRootControl;
    try {
      loopbackRun = runBlocks({ name: loopback.name, blocks: loopbackBlocks, longRunning: LONG_RUNNING });
      reachableRun = runBlocks({ name: reachable.name, blocks: reachableBlocks, longRunning: LONG_RUNNING });

      // Same function, same process, both namespaces, moments apart.
      loopbackOutside = await fetchOutside(`http://127.0.0.1:${loopback.hostPort}/`, { timeoutMs: 8000 });
      reachableOutside = await waitForHttp(`http://127.0.0.1:${reachable.hostPort}/`, { attempts: 15 });

      // The loopback instance is not broken, only unpublished: from inside its
      // own namespace it serves. Without this, "refused from outside" and "the
      // application never started" would be the same observation.
      loopbackInside = execIn(
        loopback.name,
        "curl -sS -o /dev/null -w '%{http_code}\\n' http://localhost:4242/",
      );

      // MC_USER, end to end: the document sets it from `id -un`, so the page
      // must name the container's user and must NOT name the built-in default.
      // The launcher's own log comes with it, because a block the runner
      // backgrounded writes to a file rather than to the driver's output.
      identity = execIn(
        reachable.name,
        [
          "echo \"###WHOAMI $(id -un)\"",
          "grep -c \"MC_USER=$(id -un)\" /src/packages/deck/.env",
          "echo '###LAUNCHER-LOG'",
          "cat /doc/*.sh.log",
        ].join("\n"),
      );

      // NEGATIVE CONTROL. One required root emptied in the process environment,
      // which beats the .env the document just wrote, and nothing else changed.
      missingRootControl = execIn(
        reachable.name,
        "cd /src/packages/deck && INBOX_ROOT= node scripts/start-production.mjs 2>&1 | head -5; echo \"###CONTROL-EXIT ${PIPESTATUS[0]}\"",
      );
    } finally {
      removeContainer(loopback.name);
      removeContainer(reachable.name);
    }

    const verifyBlockId = "build-and-start/sh#3";
    const loopbackVerify = loopbackRun.blockOutput[verifyBlockId] ?? "";
    const reachableVerify = reachableRun.blockOutput[verifyBlockId] ?? "";
    const whoami = /###WHOAMI (\S+)/.exec(stripAnsi(identity.output))?.[1] ?? "";
    const controlExit = /###CONTROL-EXIT (\d+)/.exec(stripAnsi(missingRootControl.output))?.[1] ?? null;
    const controlNamesIt = /FATAL: INBOX_ROOT is required but not set/.test(stripAnsi(missingRootControl.output));

    const probes = [
      ...["loopback", "reachable"].flatMap((which) => {
        const run = which === "loopback" ? loopbackRun : reachableRun;
        const blocks = which === "loopback" ? loopbackBlocks : reachableBlocks;
        return [
          probe({
            id: `driver-completed-${which}`,
            title: `the ${which} run reached the end of its declared blocks`,
            ok: run.completed,
            detail: run.completed ? `${blocks.length} blocks` : "the driver stopped early",
          }),
          ...blocks
            .filter((block) => !LONG_RUNNING[block.id])
            .map((block) =>
              probe({
                id: `block-${which}-${block.id}`,
                title: `[${which}] \`${firstLine(block)}\` exits 0`,
                ok: run.exits[block.id] === 0,
                detail:
                  run.exits[block.id] === null
                    ? "no exit marker: the block never completed"
                    : `exit ${run.exits[block.id]}`,
              }),
            ),
        ];
      }),
      probe({
        id: "documents-own-verification-loopback",
        title: "the document's verification block prints the empty-state copy it says it will",
        ok: EMPTY_STATE.every((line) => loopbackVerify.includes(line)),
        detail: `printed: ${oneLine(loopbackVerify) || "(nothing)"}`,
      }),
      probe({
        id: "documents-own-verification-reachable",
        title: "the same verification passes on the published-bind run",
        ok: EMPTY_STATE.every((line) => reachableVerify.includes(line)),
        detail: `printed: ${oneLine(reachableVerify) || "(nothing)"}`,
      }),
      probe({
        id: "published-bind-is-reachable",
        title: "with the document's publish block, the application answers from outside the container",
        ok: reachableOutside.reached && reachableOutside.status === 200,
        detail: `status ${reachableOutside.status ?? "none"} after ${reachableOutside.attempts} attempt(s); ${reachableOutside.error ?? ""}`,
      }),
      probe({
        id: "published-bind-serves-real-content",
        title: "and what it answers with is the application, not merely a 200",
        // The status code on its own is satisfied by an error page, which is
        // exactly what an unconfigured instance returns from this same route.
        ok: EMPTY_STATE.every((line) => reachableOutside.body.includes(line)),
        detail: EMPTY_STATE.filter((line) => !reachableOutside.body.includes(line)).join(", ") || "empty-state copy present",
      }),
      probe({
        id: "mc-user-is-wired-through",
        title: "MC_USER from the document's block reaches the served page",
        ok: Boolean(whoami) && reachableOutside.body.includes(whoami) && !reachableOutside.body.includes('"alex"'),
        detail: `id -un = ${whoami || "(unknown)"}; page names it: ${reachableOutside.body.includes(whoami)}; page names the default "alex": ${reachableOutside.body.includes('"alex"')}`,
      }),
      probe({
        id: "push-watcher-follows-mc-user",
        title: "the push watcher watches the file named after that user, not the default",
        ok: new RegExp(`watching \\S*${whoami}\\.md`).test(stripAnsi(identity.output)),
        detail: oneLine(identity.output),
      }),
    ];

    const controls = [
      control({
        id: "loopback-bind-is-refused-from-outside",
        title: "the same outside-the-namespace probe, against the run without the publish block",
        expectation: "refused, while the SAME application answers 200 from inside its own namespace",
        satisfied:
          loopbackOutside.reached === false &&
          stripAnsi(loopbackInside.output).trim().endsWith("200"),
        observed: `outside: ${loopbackOutside.error}; inside: ${oneLine(loopbackInside.output)}`,
      }),
      control({
        id: "missing-root-refuses-to-start",
        title: "the documented launcher with one required root emptied in the environment",
        expectation: "non-zero exit, naming INBOX_ROOT, before anything listens",
        satisfied: controlExit !== null && controlExit !== "0" && controlNamesIt,
        observed: `exit ${controlExit ?? "(no marker)"}; names the variable: ${controlNamesIt}; ${oneLine(missingRootControl.output)}`,
      }),
    ];

    return {
      probes,
      controls,
      evidence: {
        loopback: {
          exits: loopbackRun.exits,
          outside: { reached: loopbackOutside.reached, error: loopbackOutside.error },
          inside: oneLine(loopbackInside.output),
          verification: loopbackVerify,
        },
        reachable: {
          exits: reachableRun.exits,
          outside: { reached: reachableOutside.reached, status: reachableOutside.status },
          verification: reachableVerify,
          identity: tail(identity.output, 6),
        },
        launcherBanner: bannerFrom(identity.output),
      },
    };
  },
};

/** The launcher's own boot lines, quoted in the report as the document quotes them. */
function bannerFrom(log) {
  return stripAnsi(log)
    .split("\n")
    .filter((line) => line.startsWith("[prod]") || line.startsWith("[push-watcher]"))
    .slice(0, 12)
    .join("\n");
}

function firstLine(block) {
  return block ? block.text.split("\n")[0].slice(0, 60) : "(missing)";
}

function oneLine(text) {
  return stripAnsi(String(text ?? "")).replace(/\s+/g, " ").trim().slice(0, 220);
}
