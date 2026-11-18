# Use native TypeScript for CI typechecking

## TL;DR

Use the TypeScript native preview for Deck's required typecheck. Keep the
existing `tsc` check available for comparing diagnostics. The lockfile needs
a registry-backed update before CI can install the preview.

## Scope

- Keep the existing CI jobs and Node matrix.
- Generate React Router types before either compiler runs.
- Leave Base unchanged: it has no typecheck script or `tsconfig.json`.

## Test plan

- Run the original `pnpm typecheck` as a `tsc` baseline.
- Run `pnpm install --lockfile-only --no-frozen-lockfile` with registry access,
  then `pnpm install --frozen-lockfile`.
- Compare `pnpm typecheck` and `pnpm typecheck:tsc`, then run `pnpm test`.

## Log

### 2026-11-18: Switch to the cached preview version
- What changed: pinned the preview version recorded in local registry metadata
  and kept the original compiler as a fallback.
- Why: the preview package and native binary are not available for offline
  installation. Do not hand-edit the lockfile.
- Supersedes: nothing, additive.

### 2026-11-18: Verify the fallback and offline blocker
- What changed: verified that the original `pnpm typecheck` and the new
  `pnpm typecheck:tsc` both pass with TypeScript 5.9.3. Native diagnostics
  remain unverified: pnpm could not resolve the preview offline.
- Why: confirm the fallback works and leave the lockfile update to a run
  with registry access.
- Supersedes: nothing, additive.
