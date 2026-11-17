# Tune typography by text area

Status: typography implemented; focused checks, browser checks, build and compiler pass. Full workspace and all-ref privacy gates remain failed; clean candidate verification is pending.
Base: current OSS main.

## Problem and result

Make chat, navigation, decision cards, composer and document review text sizes adjustable by area, with distinct review heading levels. The final reusable text tuning is absent from OSS main. Composer control geometry is a separate change.

## Scope and donor selection

Compare individual committed patches and current source, never import the private branch history or whole component files. The bounded donor set for this review unit contains five typography changes. Exact comparison evidence remains in the private review packet. Consolidate their final behaviour without carrying intermediate overrides or history-only comments.

Expected surfaces are app.css, Compose, DecisionCard, Sidebar, MessageBubble and ReviewPanel, with focused component verification. Preserve current OSS behaviour outside typography, including existing paste, microphone, upload, draft and decision behaviour. Add no dependencies, settings, process runner, provider, authentication or migration changes. Do not rebuild or repoint any running service or owned checkout.

Use final donor values only where missing: chat 1.0625rem/1.45 line height, review 0.875rem with h2 1.25em/h3 1em, navigation 0.9375rem, decision cards 1rem/1.5, composer 0.9375rem with 3.25rem minimum height. Review Tailwind merging and cascade, including small root sizes.

## Acceptance and gates

1. Record both donor ancestry/patch equivalence in the development branch and current OSS source. Skip already implemented changes. Keep unrelated source bytes and functionality intact.
2. Focused real component verification retains upload/voice/draft behaviour and checks typography hooks and cascade.
3. Verify computed text sizes, leading, composer height and review heading sizes at small, default and large root font sizes if a real browser is available. Otherwise report browser proof NOT RUN; class assertions alone are not rendered acceptance.
4. Run required repository checks appropriate to source changes: focused and workspace tests, build, one final authoritative typecheck, boundaries, leak self-test/full scan, licence, package versions and ASCII. Never overlap authoritative compilers. Preserve actual failures and synthetic/native limitations.
5. Freeze exact source and receipts. Main reviews and signs the selected commit, then normal branch push and PR with exact validation. Peer review and actual code-review verdict are required; maintainer merge and deployment remain separate gates.

## Work log

2026-11-17: SPEC written before source implementation on a fresh branch from OSS main. Typography and pixel sizing are the priority. Source audit, builder allocation and final gates pending.

### Review unit qualification

The five typography changes form this branch's first logical PR. Only typography tokens and their six component/style surfaces belong here. The two composer pixel sizing/clearance changes have a separate main-based PR and SPEC; its source and test do not belong in this branch. Independent review notes must explain each constituent change and state whether it is generic and suitable for OSS. Both changesets already exist in the development source branch; this work only ports the missing reusable parts to OSS.

### 2026-11-17: Implementation pickup
Current main lacks the selected typography tokens and hooks. Port only the final text tuning across six surfaces; composer control geometry stays in its separate review unit. Existing public prose and motion styles use the mc convention, which the new hooks retain. No root font-size environment setting exists in current main. Generic CSS tokens are suitable for OSS; no installation-specific setting is included. Source and verification remain pending.

The existing Sidebar has no narrator row. Only its agent-name hook is ported; adding unrelated navigation UI is excluded. The final composer text hook removes conflicting min-height, top-padding and font-size utilities, while leaving its existing rem control reserve unchanged.

### 2026-11-17: Verification result
The five constituent behaviours are typography controls for leading/height/navigation/cards, independent text sizes for chat and review, a larger composer, final chat size/leading, and distinct review heading sizes. These are reusable OSS CSS behaviours; no installation-specific material is required. Browser checks rendered the actual components with candidate build CSS and local data/media doubles at root sizes 12px, 16px and 24px. Text sizes, paragraph leading, review h2/h3 sizes and composer minimum height/top padding matched the selected values. This is computed-browser proof, not native installation or full application E2E proof.

Focused checks passed (39 tests plus 56 surface tests), build and authoritative workspace compiler passed. The workspace run passed 85 base tests and 2263 Deck tests, skipped 11 and failed 74 Deck tests. Failures include clean-tree assertions on the required unstaged changes and read-only home fixture creation. Boundaries, working-tree privacy, leak self-test, licence, library version and dash checks passed. All-ref history and message scans failed with 345 and 69 findings. Those failures are retained; a fresh clean candidate and scoped history review remain required before release. Touched files are ASCII; existing unrelated non-ASCII text is unchanged. No commit, external review or publication is part of this implementation receipt.
