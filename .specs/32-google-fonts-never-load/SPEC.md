# #32: Google Fonts never load (import dropped after Tailwind)

- Issue: #32
- Branch: 32-google-fonts-never-load
- Started: 2026-10-07

## TL;DR

`app.css` has the Google Fonts `@import` on line 2, after the Tailwind import.
Tailwind inlines at line 1, so the font `@import` is no longer first and
browsers drop it. The app renders in fallback fonts even when online. Load the
fonts with a `<link rel="stylesheet">` from `links` in `app/root.tsx`, beside
the existing preconnects, remove the dead `@import`, and correct the
"Typography needs the internet" limitation in `INSTALL.md`, which blames the
network for what was a code fault.

## Scope

In scope:
- `packages/deck/app/app.css`: remove the font `@import`.
- `packages/deck/app/root.tsx`: add the font stylesheet to `links`, fix the
  comment that points at the `@import`.
- `INSTALL.md`: rewrite the limitation so it says what is true now.

Out of scope: self-hosting the fonts, font choice, any other CSS.

## Acceptance

- No postcss `@import must precede all other statements` warning in dev or
  build.
- `document.fonts` shows League Spartan, Work Sans and Space Grotesk loaded in
  a clean browser profile.
- The limitation text no longer blames network access for the fonts failing
  when online.

## Test plan

- `pnpm -C packages/deck build`: confirm the warning is gone (compare with
  `main`).
- Built CSS no longer contains the `fonts.googleapis.com` `@import`, and the
  rendered HTML contains the stylesheet `<link>`.
- Browser check with Playwright and a fresh profile: `document.fonts` entries,
  if the sandbox allows egress to Google Fonts. Otherwise recorded as not
  measured.
- Repo checks: typecheck, test, boundaries, leaks, licence, lib-version,
  dashes.

## Decisions log

- 2026-10-07: Use `links` in `root.tsx` rather than reordering the CSS. It sits
  beside the existing preconnects, so the connection is warmed before the
  stylesheet is requested, and it does not depend on how Tailwind orders
  inlined imports. This is the first option the issue gives.

## Follow-ups

- None yet.
