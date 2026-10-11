/**
 * Fenced-block extraction: the mechanism that makes a document testable.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE. Installation instructions are proven
 * by executing the document, never by a script that does the same thing in its
 * own words. The moment a verification script runs `pnpm install` because the
 * document says `pnpm install`, the two are separate artefacts that agree
 * today, and the document is unverified from the next edit onwards. So the
 * bytes inside the fences are what runs: extracted here, written to a file
 * unchanged, and sourced.
 *
 * Two consequences worth stating, because they are what stop the mechanism
 * from rotting into decoration:
 *
 * - EVERY executable block must be claimed by a declared run, and the runs are
 *   data (`rig/install-plan.mjs`). An example nobody executes is an example
 *   that has stopped being true without anything going red, which is the exact
 *   failure the extraction was built to prevent.
 * - AMBIGUITY THROWS. An unterminated fence, or a fence style this parser does
 *   not implement, raises rather than being skipped. A skipped block is an
 *   unexecuted instruction that reports nothing, and this whole directory
 *   exists because silence reads identically to success.
 */
import { RigError } from "./exec.mjs";

/** ``` at column zero, capturing the info string. */
const FENCE_RE = /^```(.*)$/;
/** The other fence style CommonMark allows, which this parser does NOT read. */
const TILDE_FENCE_RE = /^~~~/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/**
 * @typedef {object} FencedBlock
 * @property {string} id        stable identifier: `<heading-slug>/<lang>#<n>`
 * @property {string} lang      first word of the info string, lowercased
 * @property {string} info      the whole info string, verbatim
 * @property {string} heading   the nearest preceding heading text
 * @property {number} startLine 1-based line of the opening fence
 * @property {number} endLine   1-based line of the closing fence
 * @property {string} text      the block's contents, verbatim, newline-terminated
 */

/**
 * @param {string} markdown
 * @returns {FencedBlock[]} in document order
 */
export function extractFencedBlocks(markdown) {
  const lines = String(markdown).split("\n");
  /** @type {FencedBlock[]} */
  const blocks = [];
  /** @type {Map<string, number>} per heading and language, so adding an output
   * block above an executable one does not renumber the executable one. */
  const counters = new Map();
  let heading = "";
  let open = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = FENCE_RE.exec(line);

    if (open === null) {
      if (TILDE_FENCE_RE.test(line)) {
        throw new RigError(
          `INSTALL doc line ${index + 1}: a ~~~ fence. This extractor only reads \`\`\` fences, ` +
            "and a fence it cannot read is an instruction that would silently never run.",
        );
      }
      if (fence) {
        open = { info: fence[1].trim(), startLine: index + 1, body: [], heading };
        continue;
      }
      const headingMatch = HEADING_RE.exec(line);
      // Headings are only read OUTSIDE a fence: a shell comment starting with
      // `#` is not a section title, and treating it as one would rename the
      // ids of every block after it.
      if (headingMatch) heading = headingMatch[2];
      continue;
    }

    if (fence && fence[1].trim() === "") {
      const lang = open.info.split(/\s+/)[0].toLowerCase();
      const slug = slugify(open.heading);
      const key = `${slug}/${lang}`;
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      blocks.push({
        id: `${key}#${n}`,
        lang,
        info: open.info,
        heading: open.heading,
        startLine: open.startLine,
        endLine: index + 1,
        text: open.body.length === 0 ? "" : `${open.body.join("\n")}\n`,
      });
      open = null;
      continue;
    }
    open.body.push(line);
  }

  if (open !== null) {
    throw new RigError(
      `INSTALL doc line ${open.startLine}: this fence is never closed. Refusing to guess ` +
        "where the block ends, because guessing wrong executes prose.",
    );
  }
  return blocks;
}

/** @param {string} text */
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "document";
}

/**
 * Coverage accounting over the extracted blocks, in the same shape and for the
 * same reason as the harness's stage accounting: the denominator comes from
 * the document and the claims come from the declaration, so neither can be
 * derived from the other.
 *
 * @param {FencedBlock[]} blocks
 * @param {{ executableLangs: string[], knownLangs: string[], runs: Record<string, string[]>, skipped?: Record<string, unknown> }} plan
 */
export function coverage(blocks, plan) {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const executable = blocks.filter((block) => plan.executableLangs.includes(block.lang));
  // A declared skip is an accounted-for block, not an unclaimed one: it names
  // the block and carries a reason in the plan. It still has to exist in the
  // document, so a stale skip is reported through unknownIds like a stale run.
  const claimed = new Set([...Object.values(plan.runs).flat(), ...Object.keys(plan.skipped ?? {})]);
  return {
    total: blocks.length,
    executable: executable.map((block) => block.id),
    // A run naming a block that no longer exists: the document was edited and
    // the declaration was not. Reported separately from an unclaimed block
    // because the two are different mistakes with the same colour.
    unknownIds: [...claimed].filter((id) => !byId.has(id)),
    unclaimed: executable.filter((block) => !claimed.has(block.id)).map((block) => block.id),
    // A language the plan has never heard of. Left unhandled it would be
    // neither executed nor accounted for, which is the quietest way for an
    // instruction to stop being tested.
    unknownLangs: blocks
      .filter((block) => !plan.knownLangs.includes(block.lang))
      .map((block) => `${block.id} (${block.lang || "no language tag"})`),
    ok: false,
  };
}

/**
 * @param {FencedBlock[]} blocks
 * @param {string[]} ids
 * @returns {FencedBlock[]} in the order the DOCUMENT gives them, never the
 * order the declaration happens to list, so a run cannot reorder the steps a
 * reader would follow.
 */
export function selectInDocumentOrder(blocks, ids) {
  const wanted = new Set(ids);
  const found = blocks.filter((block) => wanted.has(block.id));
  const missing = ids.filter((id) => !blocks.some((block) => block.id === id));
  if (missing.length > 0) {
    throw new RigError(`the run declares blocks that are not in the document: ${missing.join(", ")}`);
  }
  return found;
}

/**
 * The prose immediately following a block, up to the next fence or heading.
 *
 * Used to hold the RUNNER's knowledge against the DOCUMENT's words. The runner
 * has to know that `pnpm dev` never returns, and that knowledge lives outside
 * the document, which is exactly the drift this file exists to stop. So the
 * declaration also states which sentence in the document says so, and a probe
 * requires it to still be there.
 *
 * @param {string} markdown @param {FencedBlock} block
 */
export function proseAfter(markdown, block) {
  const lines = String(markdown).split("\n");
  const collected = [];
  for (let index = block.endLine; index < lines.length; index += 1) {
    const line = lines[index];
    if (FENCE_RE.test(line) || HEADING_RE.test(line)) break;
    collected.push(line);
  }
  return collected.join("\n").trim();
}
