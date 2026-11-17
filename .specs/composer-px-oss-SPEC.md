# Keep composer controls and text clearance fixed in pixels

Status: pixel geometry implemented; focused/browser checks, build and compiler pass. Full workspace and all-ref privacy gates remain failed; clean candidate verification is pending.
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

## Work log

### 2026-11-17: Implementation pickup
Current main has rem-sized controls and text reserve. Port only the two final pixel geometry behaviours and the sizing regression. Voice, draft, paste, upload and caller semantics remain untouched; typography belongs to a separate review unit. Fixed geometry is generic OSS UI behaviour and requires no installation-specific setting. No root font-size environment hook exists on current main.

### 2026-11-17: Implementation and verification
The first constituent behaviour fixes attach/mic button and glyph sizes plus group offsets/gap after Tailwind merging. The second adds fixed text clearance. Both are generic, reusable OSS UI behaviour. Intermediate merge comments and conflicting rem reserve utilities were removed only in the selected textarea seam. Current main typography, voice, upload, paste, draft and caller logic remain unchanged.

The sizing test checks idle, disabled voice, connecting spinner and upload pulse through actual component rendering. Three negative controls remove button size, glyph size or text reserve; each fails all four cases at the intended assertion. Exact source restoration passes all 43 focused tests. These jsdom checks prove DOM overrides, not rendered geometry.

An isolated Chromium harness rendered the actual component with candidate build CSS and local route/media doubles. All 12 state/root cases passed at 12px, 16px and 24px roots: 36px boxes, 20px glyphs, 6px offsets, 2px gap, 84px/44px reserve, and measured text-content clearance of 5px horizontally and 3px vertically. Native installation and full application E2E acceptance are not claimed.

Build and one serial authoritative workspace compiler passed. Boundaries, working-tree privacy, leak self-test, licence, library version and dash checks passed. Workspace tests passed 85 base tests and 2267 Deck tests, skipped 11 and failed 74 Deck tests. The failures are clean-tree assertions on the required unstaged delta and read-only home fixture creation. All-ref history and message scans failed with 345 and 69 findings; these are retained failures and need fresh clean candidate verification plus scoped history review. Touched source is ASCII; unrelated non-ASCII bytes are unchanged. Source remains unstaged with no commit, external review or publication acceptance.

## Current-main reconciliation, 17 November

Incorporate merged typography PR145 at main83eeaa107f97cc52be55b5d57cfa2c492419ec17 through a normal merge, preserving its complete seven-file delta. Resolve only the Compose textarea class seam: retain mc-composer-textarea and the typography removal of min-h-10, py-2 and text-sm; retain the pixel-style padding and omit pr-[5rem] and pb-10. Fixed 36px buttons, 20px glyphs, 6px offsets, 2px gap and all behavioural logic remain intact.

Freeze exact combined files, commit through Root, then fresh committed-tree workspace tests and required tree gates. Combined production changes require final compiler/build authority and rendered root/state geometry checks. No threshold, test expectation or unrelated source changes. Keep inherited audit failures and old receipts; no private branch/deployment changes or history rewrite. Send exact merged object and receipts for bounded independent recheck before PR146 merge.
