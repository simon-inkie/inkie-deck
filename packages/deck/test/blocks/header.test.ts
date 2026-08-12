/**
 * Tests for parseHeader delimiter tolerance (2026-06-11 MC lifeline incident).
 *
 * The block-header grammar is ASCII (FND-05): fields separated by " - ".
 * Agents nonetheless slip em-dashes into hand-written headers. A header that
 * fails to parse leaves an empty timestamp on a block that still carries a
 * card, and the queue loader then threw "Invalid time value" on every page.
 *
 * parseHeader now accepts hyphen / em-dash (U+2014) / en-dash (U+2013) as the
 * field delimiter so such cards parse fully. serializeHeader still emits ASCII
 * hyphens, so any writeback self-heals the file.
 *
 * All banned glyphs are built via String.fromCharCode so this test file stays
 * clean for the check:dashes gate. ASCII only - no literal em-dashes.
 */
import { describe, it, expect } from "vitest";
import { parseHeader, serializeHeader } from "~/lib/blocks/header.js";

const HYPHEN = "-";
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

function headerLine(delim: string): string {
  return `## 2026-06-11T12:08:00Z ${delim} from: atlas ${delim} status: sent ${delim} subject: A decision`;
}

describe("parseHeader delimiter tolerance", () => {
  it("parses the canonical ASCII-hyphen header", () => {
    const r = parseHeader(headerLine(HYPHEN));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.header.timestamp).toBe("2026-06-11T12:08:00Z");
    expect(r.header.from).toBe("atlas");
    expect(r.header.status).toBe("sent");
    expect(r.header.subject).toBe("A decision");
  });

  it("parses an em-dash-delimited header with the timestamp intact", () => {
    const r = parseHeader(headerLine(EM_DASH));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The crash-causing field: timestamp must be the real value, not "".
    expect(r.header.timestamp).toBe("2026-06-11T12:08:00Z");
    expect(r.header.from).toBe("atlas");
    expect(r.header.status).toBe("sent");
    expect(r.header.subject).toBe("A decision");
  });

  it("parses an en-dash-delimited header", () => {
    const r = parseHeader(headerLine(EN_DASH));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.header.timestamp).toBe("2026-06-11T12:08:00Z");
    expect(r.header.from).toBe("atlas");
  });

  it("re-serializes an em-dash-parsed header back to ASCII hyphens (self-heal)", () => {
    const r = parseHeader(headerLine(EM_DASH));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = serializeHeader(r.header);
    expect(out.includes(EM_DASH)).toBe(false);
    expect(out.includes(EN_DASH)).toBe(false);
    expect(out).toBe(headerLine(HYPHEN));
  });

  it("still rejects a header with a non-date timestamp (returns ok:false)", () => {
    const r = parseHeader(
      `## not-a-date ${HYPHEN} from: atlas ${HYPHEN} status: sent ${HYPHEN} subject: x`
    );
    expect(r.ok).toBe(false);
  });
});

describe("parseHeader optional status segment", () => {
  it("parses a header that drops the status: segment, with a non-empty timestamp", () => {
    const r = parseHeader(
      `## 2026-06-17T21:00:00Z ${HYPHEN} from: summit ${HYPHEN} subject: a status-less header`
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The crash-causing field: timestamp must be the real value, not "".
    expect(r.header.timestamp).toBe("2026-06-17T21:00:00Z");
    expect(r.header.timestamp).not.toBe("");
    expect(r.header.from).toBe("summit");
    expect(r.header.subject).toBe("a status-less header");
    // Absent status defaults to "read".
    expect(r.header.status).toBe("read");
  });

  it("parses a status-less header with an em-dash delimiter (both tolerances at once)", () => {
    const r = parseHeader(
      `## 2026-06-17T21:00:00Z ${EM_DASH} from: summit ${EM_DASH} subject: a status-less header`
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.header.timestamp).toBe("2026-06-17T21:00:00Z");
    expect(r.header.status).toBe("read");
  });

  it("re-serializes a status-less header to the canonical full grammar (self-heal)", () => {
    const r = parseHeader(
      `## 2026-06-17T21:00:00Z ${HYPHEN} from: summit ${HYPHEN} subject: a status-less header`
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = serializeHeader(r.header);
    expect(out).toBe(
      `## 2026-06-17T21:00:00Z ${HYPHEN} from: summit ${HYPHEN} status: read ${HYPHEN} subject: a status-less header`
    );
  });
});
