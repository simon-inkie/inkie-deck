# #226: Default Deck typography to Inter

- Issue: https://github.com/simon-inkie/inkie-deck/issues/226
- Branch: default-look-inter
- Started: 2026-11-19

## TL;DR
Default Deck to locally served Inter at a 14px-equivalent root size. Keep the
existing per-area scale, weights and colours, and use system monospace for
code. No font requests leave Deck and no font settings are needed.

## Scope
In scope:
- Compare stylesheet tokens and root layout against the reference build.
- Bundle the unmodified Inter 4.0 Latin variable faces (upright and italic,
  weights 100 to 900) from the published VitePress 1.6.4 package with the
  Inter copyright and SIL Open Font License 1.1. OFL allows bundling with
  Deck; only the fonts are under OFL, and Deck's Apache-2.0 licence is unchanged.
- Use Inter for body and display text, with system fonts for unsupported
  characters. Keep the existing heading weights and tracking.
- Set the root size to 87.5% of the browser default (14px at 16px). The
  existing rem tokens then give 14.875px chat, 14px decision copy, 13.125px
  composer and sidebar names, and 12.25px review copy. Keep the base and
  decision leading at 1.5 and chat paragraph leading at 1.45. Review headings
  stay at 1.25em and 1em; Markdown code stays at 0.85em.

Out of scope:
- Instance font profile and size controls, remote stylesheets, reference
  wordmarks, League Spartan display type, and background texture.
- Changes to the palette, component type hierarchy or application behaviour.

## Test plan
- No existing tests assert the changed CSS tokens or font links, so none were
  changed. The full required list was run from the repository root on a clean
  tree: `pnpm typecheck`, `pnpm check:boundaries`, `node scripts/leak-gate.mjs`
  (and `--self-test`), `pnpm check:leaks`, `pnpm check:licence`,
  `pnpm check:lib-version`, `pnpm -C packages/deck check:dashes`,
  `git diff --check origin/main...HEAD` and `pnpm test`.
- Result: all exit 0; the full suite passed.
- Browser check on a scratch copy: no request to a font CDN, bundled Inter
  loads, no horizontal overflow at 1440 and 390 wide, brand colours unchanged.
  The README screenshots were retaken in this look.

## Follow-ups
None.

## Log

### 2026-11-19: Adopt the reference type scale without its profiles
- What changed: Compared the styles and layout, then switched the public
  design tokens to self-hosted Inter and the reference 14px-equivalent scale.
- Why: The reference CSS uses the same per-area tokens. Its custom profile
  loads an HTTPS stylesheet and sets the body and optional mono families on
  the root; League Spartan remains the display face. A separate validated
  12 to 20px root override scales the rem values. The source shows Inter as
  a custom-profile example, not the active deployment values. Use the
  requested 14px scale and system mono fallback without copying runtime
  configuration or requiring a CDN. No in-repo font CSP needs changing;
  the same-origin files work with a self-only font policy.
- Supersedes: nothing, additive
- Commits: 490e431 feat(ui): default to self-hosted Inter (#226)
