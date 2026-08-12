/**
 * test/ticket-thread.test.ts - Unit tests for app/lib/ticket-thread.ts
 * and parse extensions for the ticket: meta field (TASK-445).
 *
 * Covers:
 *   - parseBlock: ticket: line on plain blocks -> normalised field.
 *   - parseBlock: ticket: line on action card blocks -> normalised field.
 *   - parseBlock: bad ticket value -> warns + field absent (CARD-05 tolerant).
 *   - parseBlock: ticket: field round-trips byte-identical (rawMeta verbatim).
 *   - Fixture regression: quill fixture block parses with ticket field.
 *   - aggregateTicketThread: cross-agent merge, chronological, attribution, empty.
 *
 * ASCII only - no em-dashes (FND-05).
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseBlock } from "~/lib/blocks/parse";
import { serializeBlock } from "~/lib/blocks/serialize";
import { splitBlocks } from "~/lib/blocks/split";
import { aggregateTicketThread } from "~/lib/ticket-thread";
import type { AgentBlockEntry } from "~/lib/ticket-thread";
import type { MessageBlock } from "~/lib/blocks/model";

const TIMESTAMP = "2026-06-09T14:30:00Z";
const TIMESTAMP2 = "2026-06-09T15:30:00Z";
const TIMESTAMP3 = "2026-06-09T16:00:00Z";

/** Build a minimal valid plain block string. */
function makePlainBlock(meta: string, body: string, ts = TIMESTAMP): string {
  const header = `## ${ts} - from: test-agent - status: sent - subject: test`;
  if (meta) {
    return `${header}\n${meta}\n\n${body}\n\n---`;
  }
  return `${header}\n\n${body}\n\n---`;
}

/** Build a minimal valid action card block string. */
function makeActionBlock(meta: string, body: string, ts = TIMESTAMP): string {
  const header = `## ${ts} - from: quill - status: sent - subject: action`;
  return `${header}\n${meta}\n\n${body}\n\n---`;
}

// ---------------------------------------------------------------------------
// Parse: ticket: on plain blocks
// ---------------------------------------------------------------------------

describe("parseBlock - ticket: meta field on plain blocks", () => {
  it("extracts a bare id ticket: line", () => {
    const raw = makePlainBlock("ticket: TASK-445", "Body text.");
    const result = parseBlock(raw);
    expect(result.ticket).toBe("TASK-445");
    expect(result.card).toBeUndefined();
  });

  it("normalises a lowercase ticket id", () => {
    const raw = makePlainBlock("ticket: task-445", "Body text.");
    const result = parseBlock(raw);
    expect(result.ticket).toBe("TASK-445");
  });

  it("extracts a ticket id from a Linear URL", () => {
    const raw = makePlainBlock(
      "ticket: https://linear.app/example-org/issue/TASK-432/projects-kanban",
      "Body text."
    );
    const result = parseBlock(raw);
    expect(result.ticket).toBe("TASK-432");
  });

  it("absent when ticket: line is missing", () => {
    const raw = makePlainBlock("", "Body text.");
    const result = parseBlock(raw);
    expect(result.ticket).toBeUndefined();
  });

  it("rawMeta is preserved verbatim when ticket: is present", () => {
    const raw = makePlainBlock("ticket: TASK-445", "Body text.");
    const result = parseBlock(raw);
    expect(result.rawMeta).toBe("ticket: TASK-445");
  });

  it("round-trips byte-identical when ticket: is present", () => {
    const raw = makePlainBlock("ticket: TASK-445", "Body text.");
    const result = parseBlock(raw);
    const serialised = serializeBlock(result);
    expect(serialised).toBe(raw);
  });

  it("other meta keys preserved alongside ticket:", () => {
    const raw = makePlainBlock("tag: foo\nticket: TASK-445", "Body text.");
    const result = parseBlock(raw);
    expect(result.ticket).toBe("TASK-445");
    expect(result.rawMeta).toContain("tag: foo");
    expect(result.rawMeta).toContain("ticket: TASK-445");
  });
});

describe("parseBlock - ticket: on action card blocks", () => {
  it("extracts ticket from an action card meta region", () => {
    const meta = "action-id: TASK-438-spec-review\npriority: high\nticket: TASK-432";
    const raw = makeActionBlock(meta, "Please review.");
    const result = parseBlock(raw);
    expect(result.actionCard).toBeDefined();
    expect(result.ticket).toBe("TASK-432");
  });

  it("rawMeta is preserved verbatim on action card with ticket:", () => {
    const meta = "action-id: TASK-438-spec-review\npriority: high\nticket: TASK-432";
    const raw = makeActionBlock(meta, "Please review.");
    const result = parseBlock(raw);
    expect(result.rawMeta).toContain("ticket: TASK-432");
  });
});

describe("parseBlock - bad ticket value warns + field absent (CARD-05 tolerant)", () => {
  it("absent and no throw when ticket value is garbage", () => {
    const raw = makePlainBlock("ticket: NOT!VALID", "Body text.");
    expect(() => parseBlock(raw)).not.toThrow();
    const result = parseBlock(raw);
    expect(result.ticket).toBeUndefined();
    // rawMeta still preserved verbatim
    expect(result.rawMeta).toContain("ticket: NOT!VALID");
  });
});

// ---------------------------------------------------------------------------
// Fixture regression: quill fixture block has ticket: TASK-432
// ---------------------------------------------------------------------------

describe("fixture regression: quill fixture block parses with ticket field", () => {
  const FIXTURE_PATH = path.join(
    import.meta.dirname,
    "../fixtures/inbox/quill/inbox/alex.md"
  );

  let blocks: string[];

  beforeAll(() => {
    const raw = fs.readFileSync(FIXTURE_PATH, "utf8");
    blocks = splitBlocks(raw);
  });

  it("quill fixture has at least 1 block", () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("quill action card block parses with ticket: TASK-432", () => {
    const result = parseBlock(blocks[0]!);
    expect(result.actionCard).toBeDefined();
    expect(result.ticket).toBe("TASK-432");
  });

  it("quill block round-trips byte-identical after ticket: addition", () => {
    const original = blocks[0]!;
    const result = parseBlock(original);
    const serialised = serializeBlock(result);
    expect(serialised).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// aggregateTicketThread
// ---------------------------------------------------------------------------

describe("aggregateTicketThread", () => {
  function makeEntry(agentName: string, ticket: string | undefined, ts: string): AgentBlockEntry {
    const raw = ticket
      ? makePlainBlock(`ticket: ${ticket}`, `Message from ${agentName}.`, ts)
      : makePlainBlock("", `Message from ${agentName}.`, ts);
    return { agentName, block: parseBlock(raw) };
  }

  it("returns empty array when no entries match", () => {
    const entries: AgentBlockEntry[] = [
      makeEntry("quill", "TASK-440", TIMESTAMP),
      makeEntry("atlas", undefined, TIMESTAMP2),
    ];
    const result = aggregateTicketThread(entries, "TASK-445");
    expect(result).toHaveLength(0);
  });

  it("returns matched entries with correct agent attribution", () => {
    const entries: AgentBlockEntry[] = [
      makeEntry("quill", "TASK-445", TIMESTAMP),
      makeEntry("atlas", "TASK-440", TIMESTAMP2),
      makeEntry("scribe", "TASK-445", TIMESTAMP3),
    ];
    const result = aggregateTicketThread(entries, "TASK-445");
    expect(result).toHaveLength(2);
    expect(result[0]?.agentName).toBe("quill");
    expect(result[1]?.agentName).toBe("scribe");
  });

  it("sorts chronologically ascending by timestamp", () => {
    const entries: AgentBlockEntry[] = [
      makeEntry("scribe", "TASK-445", TIMESTAMP3),
      makeEntry("quill", "TASK-445", TIMESTAMP),
      makeEntry("atlas", "TASK-445", TIMESTAMP2),
    ];
    const result = aggregateTicketThread(entries, "TASK-445");
    expect(result).toHaveLength(3);
    expect(result[0]?.block.header.timestamp).toBe(TIMESTAMP);
    expect(result[1]?.block.header.timestamp).toBe(TIMESTAMP2);
    expect(result[2]?.block.header.timestamp).toBe(TIMESTAMP3);
  });

  it("is case-insensitive on the ticketId match", () => {
    const entries: AgentBlockEntry[] = [
      makeEntry("quill", "task-445", TIMESTAMP),
    ];
    const result = aggregateTicketThread(entries, "TASK-445");
    expect(result).toHaveLength(1);
  });

  it("returns empty array for empty entries", () => {
    const result = aggregateTicketThread([], "TASK-445");
    expect(result).toHaveLength(0);
  });

  it("each result carries the originating agent name", () => {
    const entries: AgentBlockEntry[] = [
      makeEntry("summit", "TASK-445", TIMESTAMP),
    ];
    const result = aggregateTicketThread(entries, "TASK-445");
    expect(result[0]?.agentName).toBe("summit");
  });

  it("cross-agent merge: entries from both agents in one result", () => {
    const entries: AgentBlockEntry[] = [
      makeEntry("atlas", "TASK-432", TIMESTAMP),
      makeEntry("quill", "TASK-432", TIMESTAMP2),
      makeEntry("briar", "TASK-432", TIMESTAMP3),
    ];
    const result = aggregateTicketThread(entries, "TASK-432");
    expect(result).toHaveLength(3);
    const agents = result.map((r) => r.agentName);
    expect(agents).toContain("atlas");
    expect(agents).toContain("quill");
    expect(agents).toContain("briar");
  });
});
