# #252: Cover Codex quota block renewal

## TL;DR

Add a reducer regression for a spend-control block, a clean full read that
clears it, and a renewed block without a new reset.

## Test plan

- Run the Codex quota reducer test file.

## Log

- 2026-11-26: Recorded the reducer regression from ACP Slice 3.
- 2026-11-26: Verified that the clean full read reports availability in
  the previously exhausted spend window and the next sparse block has
  no reset. All 14 reducer tests passed.
