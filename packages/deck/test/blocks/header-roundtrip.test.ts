/**
 * header-roundtrip.test.ts - the reader was DAMAGING WHAT IT READ.
 *
 * When parseHeader failed, parse.ts substituted a blank header; serializeHeader
 * then interpolated those blanks and wrote "##  - from:  - status: read - subject: "
 * back to disk, which no parser can read. So the damage compounded with every
 * read-write cycle, with nobody sending anything wrong. 318 lines across 17 real
 * inbox files were produced this way, including 50 in Alex's thread with Quill.
 *
 * serializeHeader's own docstring promised HEADER_RE-matching output. These tests
 * pin that promise, which is the thing that was actually false.
 */
import { describe, it, expect } from "vitest";
import { parseHeader, serializeHeader, HEADER_RE } from "~/lib/blocks/header.js";
import { parseBlock } from "~/lib/blocks/parse.js";
import { serializeBlock } from "~/lib/blocks/serialize.js";

const BLANKED = "##  - from:  - status: read - subject: ";

describe("serializeHeader round-trip", () => {
  // NOTE ON BLANKED: it is a FIXED POINT of the broken code. Blanking it again
  // produces the same string, so a round-trip test using ONLY this input PASSES
  // WITHOUT THE FIX. The first version of this file did exactly that, and
  // revert-to-red caught it: removing the fix reddened one test out of six.
  // Every case below that is meant to exercise the fix therefore uses input
  // that is NOT a fixed point.
  it.each([
    ["an ordinary markdown heading", "## Two things the symptom understates"],
    ["a heading with header-ish words", "## from: notes - status of the rollout"],
    ["a header with an unparseable timestamp", "## not-a-date - from: quill - status: read - subject: hi"],
    ["a truncated header", "## 2026-08-12T10:00:00Z - from: quill"],
  ])("round-trips %s byte-for-byte", (_label, line) => {
    const block = parseBlock(`${line}\n\nsome body text\n`);
    expect(serializeHeader(block.header)).toBe(line);
  });

  it("emits the already-blanked form unchanged too", () => {
    // Weak on its own (see the note above) but correct, and it pins the exact
    // string found 318 times on disk.
    const block = parseBlock(`${BLANKED}\n\nsome body text\n`);
    expect(serializeHeader(block.header)).toBe(BLANKED);
  });

  it("does not manufacture a NEW unparseable header from a blanked one", () => {
    // The actual defect: the output was itself unparseable, so each pass through
    // the reader produced another permanently broken line.
    const block = parseBlock(`${BLANKED}\n\nbody\n`);
    const out = serializeHeader(block.header);
    // Either it round-trips the original, or it emits something valid. What it
    // must never do is emit a DIFFERENT line that still fails the grammar.
    if (out !== BLANKED) {
      expect(HEADER_RE.test(out)).toBe(true);
    }
  });

  it("is idempotent: a second pass changes nothing", () => {
    // Compounding was the reason this mattered more than a cosmetic bug.
    const start = "## Two things the symptom understates";
    const once = serializeHeader(parseBlock(`${start}\n\nbody\n`).header);
    const twice = serializeHeader(parseBlock(`${once}\n\nbody\n`).header);
    expect(once).toBe(start);
    expect(twice).toBe(once);
  });

  it("STILL re-serialises a VALID header canonically, so a status flip persists", () => {
    // The counter-property, and the one a careless fix breaks: rawHeader must be
    // set ONLY on the failure path. If it were carried on success too, the
    // read-flip (sent -> read) would serialise the OLD line and never persist.
    //
    // THROUGH THE PRODUCTION SEAM, parseBlock -> serializeBlock (peer-review
    // catch, MR !44). The first version called parseHeader directly, which
    // BYPASSES parse.ts - and parse.ts is the exact place rawHeader could
    // accidentally be attached on the success path. A regression adding
    // rawHeader to both arms there would have left the old test green while
    // production silently emitted the stale "sent" line. A counter-property test
    // that cannot reach the code it guards does not guard anything.
    const line = "## 2026-08-12T10:00:00Z - from: quill - status: sent - subject: hello";
    const block = parseBlock(`${line}\n\nhello body\n`);
    expect(block.header.status).toBe("sent");

    const flipped = { ...block, header: { ...block.header, status: "read" as const } };
    const out = serializeBlock(flipped);

    expect(out).toContain("status: read");
    expect(out).not.toContain("status: sent");
    expect(out).toContain("hello body");
  });

  it("round-trips a MALFORMED block through the production seam, body intact", () => {
    // Same review: pin serializeBlock(parseBlock(raw)), not serializeHeader
    // alone, so newline/body/metadata interactions are covered. A non-fixed-point
    // header plus real body content is the block a mutator can actually rewrite.
    const raw = "## Two things the symptom understates\n\nfirst line\n\nsecond line\n";
    const out = serializeBlock(parseBlock(raw));
    expect(out).toContain("## Two things the symptom understates");
    expect(out).not.toContain("- from:  - status:");
    expect(out).toContain("first line");
    expect(out).toContain("second line");
  });

  it("round-trips a valid header unchanged", () => {
    const line = "## 2026-08-12T10:00:00Z - from: quill - status: read - subject: hello";
    const parsed = parseHeader(line);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeHeader(parsed.header)).toBe(line);
  });
});
