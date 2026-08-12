# inkie-deck

A web control plane for a fleet of AI agents. Early skeleton: this slice
contains the package boundary, the hosted-capability seam and the CI guards,
deliberately built before the features they will guard. There is no UI yet.

## Layout

An npm workspace with two packages:

- **`packages/base`**: the agent protocol package (`inkie-agents-base`). The
  file-based message protocol, its normative spec (`docs/protocol.md`), the
  reference `inbox` CLI, persona-file templates and their test suite. Bundled
  here so Deck works on first run, but independently versioned and kept
  separable so it can move to its own repository later. It runs on Node's
  native type stripping with no build step.
- **`packages/deck`**: the application package (`inkie-deck`). Feature-empty
  for now; it holds the hosted-capability seam (`src/capabilities.ts`) and
  the tests that keep absence a supported state.

## The rules the machines enforce

- `packages/base` never imports from `packages/deck`, and `packages/deck`
  reaches `base` only through its published entry points. Enforced by
  dependency-cruiser (`npm run check:boundaries`).
- Optional hosted capabilities (backup/sync, push relay, speech to text) may
  be absent, self-hosted with the user's own credentials, or hosted. The
  client must degrade when they are absent, never break, and no hosted
  endpoint of ours may be hardcoded. Enforced by the capability-absence
  suite in `packages/deck/tests`.
- No internal material (names, hosts, paths, tickets, addresses) may enter
  the repository. Enforced by `scripts/leak-gate.mjs` plus gitleaks in CI.
- The `LICENSE` copyright holder is currently a placeholder, and
  `scripts/licence-gate.mjs` fails CI until it is replaced with the exact
  registered company name. That red pipeline is intentional.

## Development

Node 22.18 or later.

```sh
npm ci
npm run typecheck
npm test
npm run check:boundaries
npm run check:leaks
npm run check:licence   # fails on purpose until the LICENSE holder is set
npm run e2e             # Playwright harness smoke, no real UI tests yet
```

## Licence

Apache-2.0. See `LICENSE`; the copyright holder line is pending confirmation
of the company's registered name, and CI blocks until it lands.
