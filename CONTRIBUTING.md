# Contributing to Inkie Deck

Thanks for helping. Deck is released under the Apache License 2.0 (see
`LICENSE`), and contributions are accepted under the same licence.

## Set up

You need Node `^22.13.0 || >=24.0.0`, pnpm (pinned by the `packageManager`
field in `package.json`, so use corepack), ripgrep, and a git clone (a ZIP or
tarball is not enough, because some tests and the leak gate call git). The
README's Development section and `INSTALL.md` have the detail.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` forwards to `packages/deck`. It is a sandbox: it reseeds a
throwaway inbox under `.runtime/` from the demo fixtures, so manual play never
touches committed files. `pnpm build` and `pnpm start` forward there too.

Deck has no authentication. Keep the dev server on loopback.

## Checks a pull request must pass

CI runs these, and so should you before opening a PR:

```sh
pnpm typecheck
pnpm test
pnpm check:boundaries
pnpm check:leaks
pnpm check:licence
pnpm check:lib-version
pnpm -C packages/deck check:dashes
```

- `pnpm typecheck` runs the TypeScript native preview (`tsgo`). Use
  `pnpm typecheck:tsc` to compare diagnostics with `tsc`, not as a substitute
  for the required CI check.
- `check:leaks` scans the tree for material that must not be published.
  `check:leaks:history` and `check:leaks:messages` extend that to git history
  and commit messages.
- `check:dashes` fails on em-dashes and en-dashes anywhere in the tree. Use a
  comma, colon or full stop instead.
- `check:licence` and `check:lib-version` are the licence and library-version
  gates. `check:boundaries` enforces package import rules.
- CI also runs gitleaks for credentials.
- Two suites report the state of the tree, not of your change, so commit or
  stash before running `pnpm test`.

## Branches and pull requests

- Branch off `main` for every change and never push to `main` directly.
- Branch names are short, kebab-case and descriptive, usually led by the issue
  number, for example `39-contributor-workflow`.
- Start from an issue. Non-trivial work keeps a SPEC at
  `.specs/<issue>-<slug>/SPEC.md`, updated in the same commits as the code.
  Specs live in the repo: every ticket gets a `.specs/<issue>-<slug>/` folder
  that travels in the same pull request, and a spec is never kept only in a
  chat, a ticket comment or a wiki. See
  [DEVELOPMENT.md](DEVELOPMENT.md) section 2.
- Keep each PR to one change. Unrelated changes go in separate PRs.
- Commit titles follow `type(scope): summary (#issue)`, for example
  `fix(base): anchor stuck-pane literals to the start of a rendered line (#20)`.
- `main` must stay releasable.
- UK English, and ASCII only: no em-dashes or en-dashes.

## Developer Certificate of Origin

There is no CLA. Instead, every commit must carry a `Signed-off-by:` line,
added with `git commit -s`:

```text
Signed-off-by: Your Name <you@example.com>
```

This certifies the Developer Certificate of Origin 1.1, below (also at
<https://developercertificate.org/>). Your contribution is licensed under
Apache-2.0.

```text
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the license(s) involved.
```

To sign off commits you have already made, run `git rebase --signoff main`
on your branch.

## Reporting security issues

Do not open a public issue. Use GitHub's private vulnerability reporting: on
the repository's Security tab, choose "Report a vulnerability" to open a
private advisory.
