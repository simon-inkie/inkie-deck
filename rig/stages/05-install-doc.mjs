/**
 * Stage five: the document's shape, before anything is executed from it.
 *
 * The three stages after this one execute INSTALL.md's fenced blocks in a
 * container. This one asks whether the document is still the document those
 * runs were declared against, and it runs first because every downstream
 * result is a statement about a document whose blocks were correctly
 * identified. If the extraction is wrong, the runs are executing something
 * other than what a reader would type, and their colour means nothing.
 *
 * Nothing here needs docker, or a network, or a second.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { control, probe } from "../lib/harness.mjs";
import { RigError } from "../lib/exec.mjs";
import { coverage, extractFencedBlocks, proseAfter } from "../lib/fenced.mjs";
import {
  EXECUTABLE_LANGS,
  EXPECTED_EXITS,
  INSTALL_DOC,
  KNOWN_LANGS,
  LONG_RUNNING,
  REQUIRED_CLAIMS,
  REQUIRED_HEADINGS,
  RUNS,
  SKIPPED,
} from "../install-plan.mjs";

export default {
  id: "install-doc",
  title: "INSTALL.md parses, and every executable block is claimed by a declared run",
  async run(ctx) {
    const docPath = path.join(ctx.repoRoot, INSTALL_DOC);
    const markdown = fs.readFileSync(docPath, "utf8");
    const blocks = extractFencedBlocks(markdown);
    const cover = coverage(blocks, { executableLangs: EXECUTABLE_LANGS, knownLangs: KNOWN_LANGS, runs: RUNS, skipped: SKIPPED });

    // Handed to the container stages so all three execute the same extraction
    // this stage just validated, rather than each parsing the file again.
    ctx.installDoc = { path: docPath, markdown, blocks, coverage: cover, sha256: sha256(markdown) };

    const probes = [
      probe({
        id: "blocks-found",
        title: `${INSTALL_DOC} yields fenced blocks at all`,
        ok: blocks.length > 0 && cover.executable.length > 0,
        detail: `${blocks.length} fenced, ${cover.executable.length} executable`,
      }),
      probe({
        id: "known-languages",
        title: "every fenced block carries a language this plan handles",
        ok: cover.unknownLangs.length === 0,
        detail: cover.unknownLangs.join(", ") || KNOWN_LANGS.join(", "),
      }),
      probe({
        id: "every-executable-block-claimed",
        title: `${cover.executable.length} of ${cover.executable.length} executable blocks are claimed by a declared run`,
        // The accounting that stops an example from quietly ceasing to be
        // tested. An unclaimed block is an instruction nobody runs, which
        // reads exactly like an instruction that works.
        ok: cover.unclaimed.length === 0,
        detail: cover.unclaimed.length === 0 ? "none unclaimed" : `UNCLAIMED: ${cover.unclaimed.join(", ")}`,
      }),
      probe({
        id: "no-stale-claims",
        title: "no declared run names a block that is not in the document",
        ok: cover.unknownIds.length === 0,
        detail: cover.unknownIds.join(", ") || "none",
      }),
      probe({
        id: "headings-intact",
        title: "the sections the runs are keyed to are still there",
        ok: REQUIRED_HEADINGS.every((heading) => markdown.includes(heading)),
        detail: REQUIRED_HEADINGS.filter((heading) => !markdown.includes(heading)).join(", ") || "all present",
      }),
    ];

    // The runner's private knowledge, held against the document's own words.
    // A block the runner backgrounds because it "never returns" has to be a
    // block the document tells a reader will never return; otherwise the two
    // have drifted and the reader is the one who finds out.
    for (const [id, spec] of Object.entries(LONG_RUNNING)) {
      const block = blocks.find((candidate) => candidate.id === id);
      const prose = block ? proseAfter(markdown, block) : "";
      probes.push(
        probe({
          id: `long-running-declared-${id}`,
          title: `the document says \`${firstLine(block)}\` keeps running`,
          ok: Boolean(block) && spec.prose.test(prose),
          detail: block ? `prose: ${oneLine(prose)}` : "block not found",
        }),
      );
    }

    for (const [id, spec] of Object.entries(EXPECTED_EXITS)) {
      const block = blocks.find((candidate) => candidate.id === id);
      const prose = block ? proseAfter(markdown, block) : "";
      const nearby = block ? markdown.split("\n").slice(block.endLine, block.endLine + 25).join("\n") : "";
      probes.push(
        probe({
          id: `expected-exit-documented-${id}`,
          title: `the document states the exit code ${spec.code} that this block returns here`,
          ok: Boolean(block) && (spec.prose.test(prose) || spec.prose.test(nearby)),
          detail: block ? oneLine(prose) : "block not found",
        }),
      );
    }

    // Matched against whitespace-normalised text: these sentences are prose,
    // prose gets rewrapped, and a claim that goes red because a line break
    // moved is a probe that trains its reader to ignore it.
    const flowed = markdown.replace(/\s+/g, " ");
    for (const claim of REQUIRED_CLAIMS) {
      probes.push(
        probe({
          id: `claim-${claim.id}`,
          title: claim.title,
          ok: claim.pattern.test(flowed),
          detail: claim.pattern.source,
        }),
      );
    }

    // NEGATIVE CONTROL 1. An unterminated fence must raise rather than being
    // skipped. A skipped block is an instruction that silently never runs, and
    // a document that half-parses is the one shape where this whole mechanism
    // fails quietly.
    const unterminated = "# doc\n\n```sh\necho half a block\n";
    let unterminatedThrew = false;
    let unterminatedMessage = "";
    try {
      extractFencedBlocks(unterminated);
    } catch (error) {
      unterminatedThrew = error instanceof RigError;
      unterminatedMessage = String(error?.message ?? error);
    }

    // NEGATIVE CONTROL 2. Plant an extra executable block in a copy of the
    // real document and require the coverage accounting to report it as
    // unclaimed. Without this, "none unclaimed" above is a sentence that has
    // never been observed to be capable of saying anything else.
    const planted = `${markdown}\n## A section nobody declared\n\n\`\`\`sh\necho this block is claimed by no run\n\`\`\`\n`;
    const plantedCoverage = coverage(extractFencedBlocks(planted), {
      executableLangs: EXECUTABLE_LANGS,
      knownLangs: KNOWN_LANGS,
      runs: RUNS,
      skipped: SKIPPED,
    });

    // NEGATIVE CONTROL 3. Strip the sentence that tells a reader `pnpm dev`
    // keeps running, and require the drift check above to notice. That probe
    // is the only thing tying the runner's backgrounding decision to the
    // document, so it has to be shown capable of failing.
    const longRunningId = Object.keys(LONG_RUNNING)[0];
    const longRunningBlock = blocks.find((candidate) => candidate.id === longRunningId);
    const strippedProse = markdown.replace(
      proseAfter(markdown, longRunningBlock),
      "It does a thing.",
    );
    const strippedBlocks = extractFencedBlocks(strippedProse);
    const strippedStillMatches = LONG_RUNNING[longRunningId].prose.test(
      proseAfter(strippedProse, strippedBlocks.find((candidate) => candidate.id === longRunningId)),
    );

    const controls = [
      control({
        id: "unterminated-fence-refused",
        title: "the extractor, shown a document with an unclosed fence",
        expectation: "it raises rather than returning a partial block list",
        satisfied: unterminatedThrew,
        observed: unterminatedMessage || "(no error raised: a half-parsed document would have been executed)",
      }),
      control({
        id: "unclaimed-block-detected",
        title: "the coverage accounting, shown the real document plus one undeclared block",
        expectation: "the planted block is reported as unclaimed",
        satisfied:
          plantedCoverage.unclaimed.length === 1 &&
          plantedCoverage.unclaimed[0].startsWith("a-section-nobody-declared"),
        observed: plantedCoverage.unclaimed.join(", ") || "(nothing reported: the accounting is blind)",
      }),
      control({
        id: "long-running-prose-drift-detected",
        title: "the drift check, with the sentence that documents a long-running block removed",
        expectation: "the check no longer matches, so a reworded document goes red",
        satisfied: strippedStillMatches === false,
        observed: `still matches after removal: ${strippedStillMatches}`,
      }),
    ];

    return {
      probes,
      controls,
      evidence: {
        doc: INSTALL_DOC,
        sha256: sha256(markdown),
        fenced: blocks.map((block) => ({ id: block.id, lang: block.lang, line: block.startLine })),
        runs: Object.fromEntries(Object.entries(RUNS).map(([name, ids]) => [name, ids.length])),
      },
    };
  },
};

function firstLine(block) {
  return block ? block.text.split("\n")[0] : "(missing)";
}

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function sha256(text) {
  // Recorded so a report can be tied to an exact document, the same way the
  // source stage records the commit.
  return createHash("sha256").update(text).digest("hex");
}
