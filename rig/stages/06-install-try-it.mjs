/**
 * Stage six: tier 1 of INSTALL.md, executed from the document.
 *
 * The base here is NOT the toolchain image the earlier stages use. It carries
 * the source as a clone and nothing else: no node, no pnpm, no git binary, no
 * ripgrep, no python3, no tmux. Installing those is the document's own first
 * section, and running it against an image that already had them would be
 * measuring a guide with its hardest step already done.
 *
 * The assertion is deliberately not "the server answered". The document's own
 * verification block greps the response for fixture agents that only exist if
 * the dev command seeded its sandbox, because a raw dev server also starts,
 * also answers, and answers an error page. That distinction is the whole
 * finding this tier is built on, so the probe has to be able to see it, and
 * the negative control below proves it can.
 */
import * as path from "node:path";
import { control, probe } from "../lib/harness.mjs";
import { build, runIn } from "../lib/docker.mjs";
import { stripAnsi, tail } from "../lib/exec.mjs";
import { selectInDocumentOrder } from "../lib/fenced.mjs";
import { execIn, fetchOutside, removeContainer, runBlocks, startContainer } from "../lib/docrun.mjs";
import { installBaseDockerfile } from "../lib/images.mjs";
import { LONG_RUNNING, RUNS } from "../install-plan.mjs";

/** Fixture agents the dev sandbox seeds. Absent from an unseeded dev server. */
const FIXTURE_AGENTS = ["scribe", "atlas"];

/** Binaries the install base must NOT have: each is something the doc installs. */
const MUST_INSTALL_ITSELF = ["node", "pnpm", "corepack", "git", "rg", "curl", "tmux", "python3"];

export default {
  id: "install-try-it",
  title: "INSTALL.md tier 1, executed block by block on a machine with no toolchain",
  async run(ctx) {
    const image = `inkie-deck-rig/install-base:${ctx.source.sha.slice(0, 10)}`;
    build({
      tag: image,
      dockerfile: installBaseDockerfile(),
      contextDir: path.dirname(ctx.source.tarPath),
    });
    ctx.installBaseImage = image;

    // The bareness of THIS image, asserted rather than assumed. Stage zero
    // attested the ubuntu base; this one is built from it and could have
    // acquired anything through a careless Dockerfile edit, and if it carries
    // a tool the document claims to install then the document's first section
    // is untested and nothing says so.
    const bareness = attestBareness(image, MUST_INSTALL_ITSELF);

    const blocks = selectInDocumentOrder(ctx.installDoc.blocks, RUNS["try-it"]);
    const container = await startContainer({
      image,
      name: "inkie-deck-rig-try-it",
      containerPort: 4242,
    });

    let run;
    let docMatches;
    let insideVerification;
    let outside;
    let rawDevControl;
    let publishedControl;
    try {
      run = runBlocks({ name: container.name, blocks, longRunning: LONG_RUNNING });

      // The document that ran and the document in the container's source tree
      // are the same bytes. A run of an uncommitted document is still evidence
      // about that document, but it is not evidence about the repository, and
      // the report should never let the two be confused.
      docMatches = execIn(
        container.name,
        `sha256sum /src/INSTALL.md 2>&1 | cut -d' ' -f1; echo "expected ${ctx.installDoc.sha256 ?? ""}"`,
      );

      // The document's own verification, re-run by the rig from inside. Not a
      // substitute for the block's own exit code above; this is the value the
      // report quotes.
      insideVerification = execIn(
        container.name,
        "curl -sS http://localhost:4242/ | grep -Eo 'scribe|atlas' | sort -u",
      );

      outside = await fetchOutside(`http://127.0.0.1:${container.hostPort}/`, { timeoutMs: 8000 });

      // NEGATIVE CONTROL. `dev:raw` is the same React Router dev server without
      // the sandbox launcher: no seeded fixtures, no roots. It starts, it
      // listens, and it answers. If the document's verification passes against
      // that too, then it is checking that something is listening and this
      // stage has been proving nothing all along.
      rawDevControl = execIn(
        container.name,
        [
          "cd /src/packages/deck",
          "( pnpm dev:raw --port 4343 > /doc/devraw.log 2>&1 & )",
          "sleep 25",
          "echo '###RAW-STATUS'",
          "curl -sS -o /dev/null -w '%{http_code}\\n' http://localhost:4343/",
          "echo '###RAW-VERIFY'",
          "curl -sS http://localhost:4343/ | grep -Eo 'scribe|atlas' | sort -u",
          "echo \"###RAW-VERIFY-EXIT $?\"",
          // The positive half of the published-port control. python3 is here
          // because the document's own prerequisites block installed it.
          "echo '###PUBLISHED-CONTROL'",
          "mkdir -p /tmp/published && echo rig-published-marker > /tmp/published/index.html",
          "( cd /tmp/published && python3 -m http.server 4242 --bind 0.0.0.0 > /doc/published.log 2>&1 & )",
          "sleep 4",
        ].join("\n"),
      );
      // Same function, same port map, same moment: a server that DOES bind
      // every interface. Without this, "refused" above is indistinguishable
      // from a probe that cannot reach anything at all.
      publishedControl = await fetchOutside(`http://127.0.0.1:${container.hostPort}/`, { timeoutMs: 8000 });
    } finally {
      removeContainer(container.name);
    }

    const verificationBlockId = "3-try-it/sh#2";
    const verificationOutput = run.blockOutput[verificationBlockId] ?? "";
    const rawDevStatus = /###RAW-STATUS\s+(\d+)/.exec(stripAnsi(rawDevControl.output))?.[1] ?? null;
    const rawVerifyNames = FIXTURE_AGENTS.filter((agent) =>
      stripAnsi(rawDevControl.output).split("###RAW-VERIFY")[1]?.split("###PUBLISHED-CONTROL")[0]?.includes(agent),
    );

    const probes = [
      probe({
        id: "install-base-is-bare",
        title: "the base for this run has none of the tools the document installs",
        // Both halves asserted: an empty "present" list is also what a probe
        // that never ran produces, so the absent list has to account for every
        // tool as well.
        ok: bareness.present.length === 0 && bareness.absent.length === MUST_INSTALL_ITSELF.length,
        detail: bareness.present.length === 0
          ? `all absent: ${bareness.absent.join(", ")}`
          : `PRESENT: ${bareness.present.join(", ")}`,
      }),
      probe({
        id: "driver-completed",
        title: "every declared block of this run was reached",
        ok: run.completed,
        detail: run.completed ? `${blocks.length} blocks` : "the driver stopped early",
      }),
      probe({
        id: "document-is-the-committed-one",
        title: "the executed document is byte-identical to INSTALL.md in the source tree",
        ok: sameSha(docMatches.output, ctx.installDoc.sha256),
        // A finding rather than a failure only because the rig supports
        // --allow-dirty for its own development; on a clean run the two are
        // the same file and this is a real assertion.
        severity: ctx.allowDirty ? "finding" : "fail",
        detail: oneLine(docMatches.output),
      }),
      ...blocks
        .filter((block) => !LONG_RUNNING[block.id])
        .map((block) =>
          probe({
            id: `block-${block.id}`,
            title: `\`${firstLine(block)}\` exits 0`,
            ok: run.exits[block.id] === 0,
            detail:
              run.exits[block.id] === null
                ? "no exit marker: the block never completed"
                : `exit ${run.exits[block.id]}`,
          }),
        ),
      ...Object.keys(LONG_RUNNING)
        .filter((id) => blocks.some((block) => block.id === id))
        .map((id) =>
          probe({
            id: `background-${id}`,
            title: `\`${firstLine(blocks.find((block) => block.id === id))}\` is still running, as the document says it will be`,
            ok: run.backgrounded[id] !== null,
            detail: run.backgrounded[id] ? `pid ${run.backgrounded[id]}` : "never started",
          }),
        ),
      probe({
        id: "documents-own-verification",
        title: "the document's verification block prints the fixture agents it says it will",
        ok: FIXTURE_AGENTS.every((agent) => verificationOutput.includes(agent)),
        detail: `printed: ${oneLine(verificationOutput) || "(nothing)"}`,
      }),
      probe({
        id: "sandbox-content-served",
        title: "the sandbox is seeded: the page carries fixture data, not just a 200",
        ok: FIXTURE_AGENTS.every((agent) => insideVerification.output.includes(agent)),
        detail: oneLine(insideVerification.output),
      }),
      probe({
        id: "dev-is-loopback-only",
        title: "the dev server is not reachable through a published port, as the document says",
        ok: outside.reached === false,
        detail: outside.reached ? `REACHED with status ${outside.status}` : `refused: ${outside.error}`,
      }),
    ];

    const controls = [
      control({
        id: "verification-goes-blank-against-an-unseeded-dev-server",
        title: "the document's own verification command, run against `dev:raw` on another port",
        // NOT an exit-code expectation. The document's line ends in `sort`, so
        // the pipeline exits 0 whatever happened upstream: its exit code is
        // not the assertion and never was. What moves is the OUTPUT, which is
        // what the probe above reads, so that is what this control has to show
        // going empty. The 500 is asserted too, because "no agents printed"
        // with nothing listening would satisfy this for the wrong reason.
        expectation: "the raw server answers 500, and the same command then prints no fixture agent at all",
        satisfied: rawDevStatus === "500" && rawVerifyNames.length === 0,
        observed: `raw dev server status ${rawDevStatus ?? "(no marker)"}; agents printed: ${rawVerifyNames.join(", ") || "none"}; ${tail(rawDevControl.output, 6)}`,
      }),
      control({
        id: "the-outside-probe-can-reach-a-published-server",
        title: "the same outside-the-namespace fetch, against a server on the same port map that binds every interface",
        expectation: "200 carrying its marker, which makes the refusal above a statement about the bind rather than about the probe",
        satisfied:
          publishedControl.reached === true &&
          publishedControl.status === 200 &&
          publishedControl.body.includes("rig-published-marker"),
        observed: `reached=${publishedControl.reached} status=${publishedControl.status} body=${oneLine(publishedControl.body)} ${publishedControl.error ?? ""}`,
      }),
    ];

    return {
      probes,
      controls,
      evidence: {
        image,
        blocks: blocks.map((block) => ({ id: block.id, exit: run.exits[block.id], text: block.text })),
        verification: verificationOutput,
        driver: run.driver,
        log: tail(run.raw, 40),
      },
    };
  },
};

/**
 * Absence check against an IMAGE, before any container built from it is
 * trusted. Positive and negative are both printed, so a probe that stopped
 * running at all reads as no lines rather than as "nothing present".
 */
function attestBareness(image, tools) {
  const script = tools
    .map((tool) => `command -v ${tool} >/dev/null 2>&1 && echo "present ${tool}" || echo "absent ${tool}"`)
    .join("\n");
  const result = runIn(image, script);
  const present = [...stripAnsi(result.output).matchAll(/^present (\S+)$/gm)].map((match) => match[1]);
  const absent = [...stripAnsi(result.output).matchAll(/^absent (\S+)$/gm)].map((match) => match[1]);
  return { present, absent, output: result.output };
}

function firstLine(block) {
  return block ? block.text.split("\n")[0].slice(0, 60) : "(missing)";
}

function oneLine(text) {
  return stripAnsi(String(text ?? "")).replace(/\s+/g, " ").trim().slice(0, 200);
}

function sameSha(output, expected) {
  const first = stripAnsi(output).trim().split("\n")[0]?.trim();
  return Boolean(expected) && first === expected;
}
