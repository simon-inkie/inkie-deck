# Tune typography by text area

Status: planned, reviewed final source reapplication and fresh committed verification pending.
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
