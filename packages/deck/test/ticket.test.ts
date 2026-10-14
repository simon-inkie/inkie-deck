/**
 * test/ticket.test.ts - Unit tests for app/lib/ticket.ts.
 *
 * Covers normaliseTicket:
 *   - Bare ids (case-insensitive), uppercase, lowercase, mixed.
 *   - Linear URLs: bare, with slug, with query, with fragment, with both.
 *   - Empty string, whitespace, null, undefined.
 *   - Garbage values (no match -> null).
 *   - ticketUrl: builds expected canonical URL.
 *
 * ASCII only - no em-dashes.
 */
import { describe, it, expect } from "vitest";
import { normaliseTicket, ticketUrl, TICKET_BASE_URL } from "~/lib/ticket";

describe("normaliseTicket - bare ids", () => {
  it("uppercases a lowercase bare id", () => {
    expect(normaliseTicket("task-445")).toBe("TASK-445");
  });

  it("returns already-uppercase bare id unchanged", () => {
    expect(normaliseTicket("TASK-445")).toBe("TASK-445");
  });

  it("uppercases a mixed-case bare id", () => {
    expect(normaliseTicket("TASK-445")).toBe("TASK-445");
  });

  it("handles multi-letter prefix", () => {
    expect(normaliseTicket("MC-001")).toBe("MC-001");
  });

  it("handles single-digit ticket number", () => {
    expect(normaliseTicket("TASK-1")).toBe("TASK-1");
  });

  it("handles multi-digit ticket number", () => {
    expect(normaliseTicket("TASK-12345")).toBe("TASK-12345");
  });
});

describe("normaliseTicket - Linear URLs", () => {
  it("extracts id from a bare Linear URL (no slug)", () => {
    expect(normaliseTicket("https://linear.app/example-org/issue/TASK-445")).toBe(
      "TASK-445"
    );
  });

  it("extracts id from a Linear URL with a slug", () => {
    expect(
      normaliseTicket(
        "https://linear.app/example-org/issue/TASK-432/projects-kanban"
      )
    ).toBe("TASK-432");
  });

  it("extracts id from a Linear URL with a query string", () => {
    expect(
      normaliseTicket(
        "https://linear.app/example-org/issue/TASK-445?ref=email"
      )
    ).toBe("TASK-445");
  });

  it("extracts id from a Linear URL with a fragment", () => {
    expect(
      normaliseTicket(
        "https://linear.app/example-org/issue/TASK-445#comments"
      )
    ).toBe("TASK-445");
  });

  it("extracts id from a Linear URL with slug, query, and fragment", () => {
    expect(
      normaliseTicket(
        "https://linear.app/example-org/issue/TASK-445/ticket-field-lens?ref=email#comments"
      )
    ).toBe("TASK-445");
  });

  it("works with a different org slug", () => {
    expect(
      normaliseTicket(
        "https://linear.app/other-org/issue/PROJ-99/some-slug"
      )
    ).toBe("PROJ-99");
  });

  it("uppercases a lowercase id in a URL", () => {
    expect(
      normaliseTicket(
        "https://linear.app/example-org/issue/task-445"
      )
    ).toBe("TASK-445");
  });
});

describe("normaliseTicket - empty / null / undefined", () => {
  it("returns null for empty string", () => {
    expect(normaliseTicket("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(normaliseTicket("   ")).toBeNull();
  });

  it("returns null for null", () => {
    expect(normaliseTicket(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(normaliseTicket(undefined)).toBeNull();
  });
});

describe("normaliseTicket - garbage values", () => {
  it("returns null for a plain non-id string", () => {
    expect(normaliseTicket("NOT!VALID")).toBeNull();
  });

  it("returns null for a string with no hyphen", () => {
    expect(normaliseTicket("TASK445")).toBeNull();
  });

  it("returns null for a partial URL", () => {
    expect(normaliseTicket("https://linear.app/example-org/issue/")).toBeNull();
  });

  it("returns null for an unrelated URL", () => {
    expect(normaliseTicket("https://example.com/TASK-445")).toBeNull();
  });

  it("returns null for a number-only string", () => {
    expect(normaliseTicket("445")).toBeNull();
  });

  it("returns null for letters with no digits after hyphen", () => {
    expect(normaliseTicket("INK-")).toBeNull();
  });
});

describe("ticketUrl", () => {
  it("builds the canonical Linear URL from an id", () => {
    expect(ticketUrl("TASK-445")).toBe(
      `${TICKET_BASE_URL}TASK-445`
    );
  });

  it("uses the TICKET_BASE_URL constant", () => {
    expect(ticketUrl("TASK-1")).toBe(`${TICKET_BASE_URL}TASK-1`);
  });
});
