<!-- Copy of the published body of #155, "Epic: structured task flows, source tickets and durable runs", taken 2026-11-18. The longer design is in SPEC.md. -->
## Goal

Let agents follow editable, composable flow definitions for coding, research or other tasks, with understandable decisions, actions and progress. The definition format remains to be settled.

## Scope and first slice

Use Linear or GitHub as the ticket source of truth: pull selected work onto Deck's project board, persist its source identity and run state, then sync supported updates back without duplicate writes. People without either tracker can use native board tickets.

Start with a runtime-neutral adapter and one small flow: pick up a task, perform a bounded step, verify it and request a decision when needed. Record meaningful sub-agent events, not a raw stream. Prove restart recovery and idempotent tracker updates with fixtures; iterate on the UI after the mechanism works. A coding example is a test case, not a restriction or authority for external actions.

## Origin and qualification

Maintainer direction, 18 November 2026; no exact Linear original established. Earlier designs are inputs, not the final contract. This goes beyond [#39](https://github.com/simon-inkie/inkie-deck/issues/39)'s contributor conventions. Runtime/event integration and the revised specification remain open.

