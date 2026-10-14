/**
 * push-watch-core.test.ts - the watcher's pure logic.
 *
 * Proves:
 *   1. parseBlocks counts blocks and reads from/subject across hyphen AND
 *      em-dash header variants.
 *   2. Malformed headers keep their slot (index stability) as "(unknown)".
 *   3. newBlockPayloads: pushes only NEW blocks from non-user senders;
 *      user's own replies and unknown blocks never push.
 *   4. Shrunk file (rewrite) yields no payloads - never push on ambiguity.
 */
import { describe, it, expect } from "vitest";
import { parseBlocks, newBlockPayloads } from "../../server/push-watch-core.mjs";

const HYPHEN_BLOCK = `## 2026-06-12T08:00:00Z - from: quill - status: sent - subject: morning brief

Body text.

---
`;
const EMDASH_BLOCK = `## 2026-06-12T08:05:00Z \u2014 from: atlas \u2014 status: sent \u2014 subject: review request

Body.

---
`;
const USER_BLOCK = `## 2026-06-12T08:10:00Z - from: alex - status: read - subject: Re: morning brief

Reply.

---
`;
const MALFORMED_BLOCK = `## this header parses as nothing useful

Body.

---
`;

describe("parseBlocks", () => {
  it("parses hyphen and em-dash headers alike", () => {
    const blocks = parseBlocks(HYPHEN_BLOCK + EMDASH_BLOCK);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ from: "quill", subject: "morning brief" });
    expect(blocks[1]).toMatchObject({ from: "atlas", subject: "review request" });
  });

  it("keeps malformed headers in the count as (unknown)", () => {
    const blocks = parseBlocks(HYPHEN_BLOCK + MALFORMED_BLOCK + EMDASH_BLOCK);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]?.from).toBe("(unknown)");
    expect(blocks[2]?.from).toBe("atlas");
  });
});

describe("newBlockPayloads", () => {
  const blocks = parseBlocks(
    HYPHEN_BLOCK + USER_BLOCK + EMDASH_BLOCK + MALFORMED_BLOCK
  );

  it("pushes only new non-user blocks", () => {
    // prevCount=1: new blocks are user reply, atlas, malformed.
    const payloads = newBlockPayloads(blocks, 1, "alex", "quill");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      title: "atlas",
      body: "review request",
      deepLink: "/threads/quill",
    });
  });

  it("returns nothing when nothing is new", () => {
    expect(newBlockPayloads(blocks, blocks.length, "alex", "quill")).toEqual([]);
  });

  it("returns nothing when the file shrank", () => {
    expect(newBlockPayloads(blocks, blocks.length + 5, "alex", "quill")).toEqual([]);
  });

  it("falls back to 'New message' when the subject is empty", () => {
    const noSubject = parseBlocks(
      `## 2026-06-12T09:00:00Z - from: quill - status: sent\n\nBody.\n\n---\n`
    );
    const payloads = newBlockPayloads(noSubject, 0, "alex", "quill");
    expect(payloads[0]?.body).toBe("New message");
  });
});
