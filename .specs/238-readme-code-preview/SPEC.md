# #238: README code preview screenshot

- Issue: https://github.com/simon-inkie/inkie-deck/issues/238
- Branch: `readme-code-preview`
- Started: 2026-11-19

## TL;DR
Restore the highlighted JSON screenshot removed in #237, retaken now that
attachment files open in the code view (#235).

## Scope
In: docs/images/code-preview.png and its README image and caption.
Out: anything else.

## Test plan
Docs only. Image links resolve; leak, dash and whitespace gates pass.

## Log
### 2026-11-19: Restore the image
- What changed: new 1440x900 screenshot of the launch config in the code view
  (indented, line numbers, highlighting); README image and caption back after
  the review panel image.
- Why: #235 landed, so the screenshot now shows what the product does.
- Commits: pending
