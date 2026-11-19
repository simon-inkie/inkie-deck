# #234: README fixes

- Issue: https://github.com/simon-inkie/inkie-deck/issues/234
- Branch: `readme-shots-fix`
- Started: 2026-11-19

## TL;DR
Clarify when the agent team and Deck started, introduce the optional Brain
setup, and show an unanswered decision card. Remove the JSON preview screenshot
until #235 lands.

## Scope
- Update README copy and screenshot references, and delete the JSON screenshot.
- No changes to Deck or its setup script.

## Test plan
- Visually check the decision-card PNG against its alt text.
- Run `pnpm check:leaks`, `node scripts/leak-gate.mjs`,
  `node packages/deck/scripts/check-dashes.mjs` and `git diff --check`.

## Follow-ups
- Restore the JSON preview screenshot after #235 lands.

## Log

### 2026-11-19: Refresh the README
- What changed: Updated the origin and Brain copy, added the unanswered card
  screenshot to the README, and removed the JSON preview screenshot.
- Why: Show the decision before it is answered and explain how to opt in to
  memory. The JSON screenshot returns after #235 lands.
- Supersedes: Earlier README origin wording and JSON preview illustration.
- Commits: pending
