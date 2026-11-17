# Keep composer controls and text clearance fixed in pixels

Status: planned, reviewed final source reapplication and fresh committed verification pending.
Base: current OSS main.

## Problem and result

Attach and microphone controls shrink when the root text size is reduced. Fixed-size controls also need fixed text clearance to prevent the draft running under them. Port the two related geometry fixes into OSS without changing voice, attachment, draft or upload behaviour. Their existing development-branch implementation is a donor, not a whole-history transplant.

## Scope

Only Compose.tsx, its focused composer sizing regression and this SPEC. Keep 36px button boxes, 20px glyphs, 6px bottom/right offsets and 2px gap. Reserve at least 84px right and 44px bottom in the textarea. Check Tailwind class merging and cascade. Preserve all newer current-main behaviour; exclude independent typography tuning and any install-specific/private material. Add no dependencies, configuration, service or runner changes.

## Acceptance

1. Compare current OSS source and selective committed donor geometry before applying it; retain exact private evidence without publishing donor identifiers.
2. Component tests check actual merged box/glyph overrides, control offsets and textarea reserve, including relevant voice/upload states. Removing pixel overrides or clearance must fail a meaningful assertion; restore exact source.
3. Check rendered geometry and text clearance at small/default/large root font sizes using an existing real browser where available. Otherwise report browser acceptance NOT RUN; jsdom classes do not prove geometry.
4. Run focused and required workspace tests, build, boundaries, leak self-test/full/history/message checks, licence, package version and ASCII gates. Run one final authoritative typecheck, serially with all other compilers. Preserve failures and limitations.
5. Freeze source/receipts, then main reviews, signs and opens a separate PR with fresh exact review and plain-English suitability/test note. No running-build, visibility or deployment change.
