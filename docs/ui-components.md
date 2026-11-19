# UI components

## Find and reuse

- Feature components live in `packages/deck/app/components/` and use
  PascalCase filenames and component names, such as `DecisionCard.tsx` and
  `EmptyState.tsx`. Page wiring lives in `packages/deck/app/routes/`. Keep
  one-page UI local until there is a reason to reuse it.
- Shared primitives live in `packages/deck/app/components/ui/`: lower-case
  or kebab-case files, PascalCase exports. Start with `Button`, `Input`,
  `Label`, `Select`/`SelectItem`, `Switch`, `Card` and its parts, `Badge` or
  `Avatar`. `Select` is native and `Switch` uses a checkbox.
  `dropdown-menu.tsx` wraps Radix and `resizable.tsx` wraps
  `react-resizable-panels`. Use these wrappers rather than rebuilding the
  controls. `packages/deck/app/routes/scheduler.tsx` shows how to compose the
  form and card primitives.
- `packages/deck/components.json` records the shadcn configuration, including
  the `~/components/ui` import alias and Lucide icons. Follow the local
  wrappers rather than assuming every upstream component or prop is present.

## Style and accessibility

- `packages/deck/app/app.css` is the source of truth for the light theme.
  Use Tailwind utilities with semantic tokens: `bg-card text-card-foreground`
  for a card, `text-muted-foreground` for secondary copy, `border-border`
  for outlines and `ring-ring` for focus. Reuse the radius and font tokens
  (`rounded-md`, `font-display`, `font-mono`) and area typography variables
  such as `--mc-chat-font-size`. Do not copy hex values into components.
- Keep layout utilities with the component. Use `cn` from
  `packages/deck/app/lib/utils.ts` to merge conditional classes and caller
  overrides. Follow `packages/deck/app/components/ui/button.tsx` or
  `packages/deck/app/components/ui/badge.tsx` for `cva` variants. Keep shared
  CSS in `app.css`; reserve `shadow-retro` for decision cards.
- Use buttons for actions and links for navigation. Connect `Label`'s
  `htmlFor` to the control's `id`, give icon-only controls an accessible name,
  and hide decorative icons from assistive technology. Preserve visible
  keyboard focus and check tab order, activation and contrast. Use text or an
  accessible name for status; do not rely on colour alone.

## Add and preview

1. Compose existing primitives first. If a new piece is reusable, add it in
   `components/` (feature) or `components/ui/` (generic), following the
   surrounding exports and naming. Render it in the route that owns its state.
2. With dependencies installed, run `pnpm dev` from the root and open
   `http://localhost:4242`. There is no configured Storybook or component
   gallery. `packages/deck/scripts/dev.mjs` seeds the fixture inbox into
   `packages/deck/.runtime/`; use the default sandbox without live root
   overrides. It leaves tmux and Nudges off by default. Do not enable Nudges
   against a real crontab just to preview it; use
   [the route tests](testing-and-evals.md#nudges-cron-admin-and-scheduler).
3. Check the real route at narrow and wide widths with keyboard and pointer.
   Use a focused DOM test for behaviour or a Playwright check for layout that
   needs a browser, as in `packages/deck/e2e/layout/escalation-header.test.ts`.

Current documentation screenshots are descriptive PNGs in `docs/images/`
(for example `docs/images/needs-you.png`), linked from `README.md` with alt
text. For review, prefer before/after captures from the fixture dev server
at the same viewport and state. Keep real inboxes, paths, identities and
secrets out of captures; only add images to the repo when they serve the docs.

## Open questions

- Is there a preferred viewport or capture process for README screenshots?
