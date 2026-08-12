# inkie-deck

A web control plane for a fleet of AI agents. Early skeleton: this slice
contains the package boundary and the CI guards, deliberately built before the
code they will guard. There is no application code yet, and none of it will be
written here.

## How this repository gets its code

Deck's application code is **copied in from the working platform and cleaned**,
not reimplemented. That platform is proven and in daily use; rewriting it would
throw away everything its testing has established and buy nothing. What gets
re-authored is only the material that cannot be cleaned economically: fixtures,
test data and persona files, which encode specifics of one deployment rather
than the shape of the product.

No git history crosses. The leaks are in commit messages, so the extraction
copies file contents into fresh commits and the old history stays behind. That
is the one part of this with no exceptions.

## Layout

An npm workspace with two packages:

- **`packages/base`**: the agent protocol package (`inkie-agents-base`). The
  file-based message protocol, its normative spec (`docs/protocol.md`), the
  reference `inbox` CLI, persona-file templates and their test suite. Bundled
  here so Deck works on first run, but independently versioned and kept
  separable so it can move to its own repository later. It runs on Node's
  native type stripping with no build step.
- **`packages/deck`**: the application package (`inkie-deck`). Empty, awaiting
  the extraction described above.

## The rules the machines enforce

- `packages/base` never imports from `packages/deck`, and `packages/deck`
  reaches `base` only through its published entry points. Enforced by
  dependency-cruiser (`npm run check:boundaries`).
- No internal material (names, hosts, paths, tickets, addresses) may enter
  the repository. Enforced by `scripts/leak-gate.mjs` plus gitleaks in CI.
  The gate self-tests: `node scripts/leak-gate.mjs --self-test` proves each
  rule still fires, so a rule that has quietly stopped matching cannot pass
  as a clean scan.
- The `LICENSE` must name a real copyright holder rather than a placeholder.
  Enforced by `scripts/licence-gate.mjs`.

## Development

Node 22.18 or later.

```sh
npm ci
npm run typecheck
npm test
npm run check:boundaries
npm run check:leaks
npm run check:licence
```

## Licence

Apache-2.0. See `LICENSE`.
