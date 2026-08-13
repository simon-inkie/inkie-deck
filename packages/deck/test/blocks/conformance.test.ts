/**
 * The application's half of the shared conformance corpus.
 *
 * Its counterpart is packages/base/conformance/run_cli.py, which drives the
 * Python CLI through the SAME corpus. The two implementations of
 * docs/protocol.md in this repository are a Python CLI and this TypeScript
 * application; they have no code they can share, so a body of shared DATA is
 * the only thing that can hold them together. Each side has a thin adapter in
 * its own language and nothing else in common.
 *
 * Read packages/base/docs/conformance.md before adding or waiving a case.
 *
 * The corpus is imported through base's published export rather than by
 * relative path, so `pnpm check:boundaries` sees a legal deck -> base edge and
 * the import keeps working if base is ever spun out into its own package.
 */
import { describe, expect, it } from "vitest";
// No `with { type: "json" }` attribute: this package compiles with
// "module": "ES2022", which predates import attributes, and tsc rejects the
// syntax outright. resolveJsonModule is on, so the plain form type-checks and
// Vite resolves it the same way.
import corpus from "inkie-agents-base/conformance/corpus.json";
import { splitBlocks } from "~/lib/blocks/split";
import { parseHeader } from "~/lib/blocks/header";

const IMPL = "deck";

interface CanonicalBlock {
  ts: string;
  sender: string;
  status: string;
  subject: string;
  bodyRaw: string;
}

interface Case {
  id: string;
  protocol: string;
  why: string;
  input: string;
  expect: CanonicalBlock[];
  deviations?: Record<string, { reason: string; expect: CanonicalBlock[] }>;
}

/**
 * Project the application's parse onto the corpus's canonical block shape.
 *
 * Deliberately thin, and deliberately NOT using parseBlock(): that function
 * also lifts a YAML metadata region out of the body and applies the
 * application's own display cleaning, which is a presentation concern the
 * corpus does not compare (see the corpus header for why bodyRaw is the unit).
 * Everything here comes straight off splitBlocks + parseHeader.
 *
 * A block whose header line does not parse is dropped, matching protocol
 * section 4 and the CLI adapter: a line that is header-SHAPED but ungrammatical
 * does not begin a block.
 */
function project(raw: string): CanonicalBlock[] {
  const out: CanonicalBlock[] = [];
  for (const block of splitBlocks(raw)) {
    const newline = block.indexOf("\n");
    const headerLine = newline === -1 ? block : block.slice(0, newline);
    const parsed = parseHeader(headerLine);
    if (!parsed.ok) continue;
    out.push({
      ts: parsed.header.timestamp,
      sender: parsed.header.from,
      status: parsed.header.status,
      subject: parsed.header.subject,
      bodyRaw: (newline === -1 ? "" : block.slice(newline + 1)).trim(),
    });
  }
  return out;
}

const cases = (corpus as unknown as { cases: Case[] }).cases;

describe("protocol conformance corpus", () => {
  it("the corpus is non-empty and reached through base's published export", () => {
    // A corpus that fails to load would make every case below vacuously pass:
    // every predicate is true of the empty set. Assert the denominator.
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const testCase of cases) {
    const deviation = testCase.deviations?.[IMPL];

    if (!deviation) {
      it(`${testCase.id} (protocol section ${testCase.protocol})`, () => {
        expect(project(testCase.input), testCase.why).toEqual(testCase.expect);
      });
      continue;
    }

    // A deviation is recorded for this implementation. TWO assertions, and the
    // second is the one that stops this suite certifying drift: a waiver that
    // outlives the defect it documents is how a conformance suite starts lying.
    it(`${testCase.id} (protocol section ${testCase.protocol}) [known deviation]`, () => {
      const actual = project(testCase.input);
      expect(
        actual,
        `${testCase.id}: the recorded deviation no longer describes what this ` +
          `implementation does. Reason on file: ${deviation.reason}`
      ).toEqual(deviation.expect);
      expect(
        actual,
        `${testCase.id}: STALE DEVIATION RECORD. This implementation now ` +
          `matches the protocol, so the deviation recorded against "${IMPL}" ` +
          `in packages/base/conformance/corpus.json is obsolete. Delete it.`
      ).not.toEqual(testCase.expect);
    });
  }
});
