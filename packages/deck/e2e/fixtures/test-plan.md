# TASK-439 Test Plan

This fixture is used by the card-detail e2e tests to verify that clicking a
links: chip in the detail overlay opens the review panel.

## Acceptance criteria

- Clicking a card on the board opens the detail overlay
- The detail shows the card body rendered as markdown
- The links: chip row appears and each chip opens the review panel
- Opening a doc clears the card param and sets the doc param
