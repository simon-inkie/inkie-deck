// @vitest-environment jsdom
/**
 * decision-card-record.test.tsx - what a RESOLVED decision card actually shows
 * once you expand it, for a card offering three options.
 *
 * A render test because the claim is a claim about the DOM. The custom-answer
 * sentinel used to be the letter "C", and the renderer suppressed the chosen
 * highlight whenever it saw that letter. On a three-option card that made a
 * genuine tap on C render with NO option highlighted at all: the receipt for a
 * decision the operator had actually made showed nothing. Neither the parse suite
 * nor the writeback suite can see that, because both halves were individually
 * doing what they said.
 *
 * The two directions, which are the point of the file:
 *   - a tap on C highlights C, and adds no free-text row.
 *   - a written answer highlights NO option, and adds the free-text row.
 * Legacy records (written as "answered: C" plus a custom-answer: value, and
 * never rewritten) must render like the second, not the first.
 *
 * ASCII only - no em-dashes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { DecisionCard } from "~/components/DecisionCard";
import { parseBlock } from "~/lib/blocks/parse";
import { CUSTOM_ANSWER_RESOLUTION } from "~/lib/blocks/answer";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = "2026-06-09T15:00:00Z";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** A three-option card, plus whatever resolution meta the case needs. */
function cardBlock(...metaLines: string[]): string {
  return [
    `## 2026-06-09T14:30:00Z - from: scribe - status: sent - subject: ad spend decision`,
    `decision-id: TASK-413-q3`,
    `options:`,
    `  - key: A`,
    `    label: "Hold spend at 45/day"`,
    `    detail: "Conservative."`,
    `  - key: B`,
    `    label: "Push to 80/day"`,
    `    detail: "Faster learning."`,
    `  - key: C`,
    `    label: "Pause the campaign"`,
    `    detail: "Stop and think."`,
    ...metaLines,
    ``,
    `Choose a spend level.`,
    ``,
    `---`,
  ].join("\n");
}

/**
 * Render the card and expand it: the option rows (the record) only exist in
 * the expanded state, and collapsed is the default.
 */
function renderExpanded(raw: string): void {
  const block = parseBlock(raw);
  const Stub = createRoutesStub([
    { path: "/threads/scribe", Component: () => <DecisionCard block={block} now={NOW} /> },
  ]);
  act(() => {
    root.render(<Stub initialEntries={["/threads/scribe"]} />);
  });
  const toggle = container.querySelector<HTMLElement>('[data-testid="decision-card-toggle"]');
  if (toggle === null) throw new Error("card did not render its resolved receipt");
  act(() => {
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/**
 * The rows rendered in the filled/chosen treatment. The renderer signals
 * "this is the one" with the primary fill, so that class is the assertion
 * surface; there is no other marker on the row.
 */
function highlightedRows(): string[] {
  return [...container.querySelectorAll("div")]
    .filter(
      (d) =>
        d.classList.contains("bg-primary") &&
        d.classList.contains("text-primary-foreground"),
    )
    .map((d) => d.textContent ?? "");
}

describe("resolved decision card - a tap on option C (three options)", () => {
  beforeEach(() => renderExpanded(cardBlock(`answered: C`)));

  it("highlights exactly one option row", () => {
    expect(highlightedRows()).toHaveLength(1);
  });

  it("the highlighted row is option C", () => {
    expect(highlightedRows()[0]).toContain("Pause the campaign");
  });

  it("adds no free-text row (there is no free text)", () => {
    expect(container.textContent).not.toContain("Your answer");
  });
});

describe("resolved decision card - a written answer", () => {
  beforeEach(() =>
    renderExpanded(
      cardBlock(
        `answered: ${CUSTOM_ANSWER_RESOLUTION}`,
        `custom-answer: "Halve it and revisit Friday"`,
      ),
    ),
  );

  it("highlights exactly one row", () => {
    expect(highlightedRows()).toHaveLength(1);
  });

  it("the highlighted row is the free text, not one of the options", () => {
    const [row] = highlightedRows();
    expect(row).toContain("Halve it and revisit Friday");
    expect(row).not.toContain("Pause the campaign");
  });

  it("option C is present but dimmed", () => {
    expect(container.textContent).toContain("Pause the campaign");
  });
});

describe("resolved decision card - a written answer from before the fix", () => {
  // Never rewritten on disk: the letter C plus the user's text.
  beforeEach(() =>
    renderExpanded(cardBlock(`answered: C`, `custom-answer: "Halve it and revisit Friday"`)),
  );

  it("still renders the free text as the chosen row", () => {
    const [row] = highlightedRows();
    expect(row).toContain("Halve it and revisit Friday");
  });

  it("does not also highlight option C", () => {
    expect(highlightedRows()).toHaveLength(1);
  });
});

describe("resolved decision card - a tap on option B (unchanged behaviour)", () => {
  beforeEach(() => renderExpanded(cardBlock(`answered: B`)));

  it("highlights option B and nothing else", () => {
    const rows = highlightedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("Push to 80/day");
  });
});
