# #28: Add .gitattributes to force LF line endings

- Issue: #28
- Branch: 28-gitattributes-lf-ayssyi
- Started: 2026-10-07

## TL;DR

Adds a root `.gitattributes` with `* text=auto eol=lf` plus explicit binary
types, so a clone made with Git for Windows (`core.autocrlf=true`) and run from
WSL does not get CRLF in `.sh` files, the Python inbox CLI or `.env` files.

## Scope

In scope:
- Root `.gitattributes`: `* text=auto eol=lf` and `binary` for image, font,
  PDF and archive types.

Out of scope:
- Docs changes. The issue asks to keep the existing advice to clone inside WSL;
  `README.md` and `INSTALL.md` carry no such advice today (see Follow-ups).
- Renormalising existing files: the tree is already LF.

## Acceptance

- `.gitattributes` exists on the default branch.
- `git ls-files --eol` shows no CRLF in the working tree after a fresh clone
  with `core.autocrlf=true`.
- Test suites unaffected.

## Test plan

- Clone the branch with `-c core.autocrlf=true`, run `git ls-files --eol`, and
  confirm no `w/crlf` entries.
- Run the repo gates: `pnpm install`, `pnpm typecheck`, `pnpm test`,
  `pnpm check:boundaries`, `pnpm check:leaks`, `pnpm check:licence`,
  `pnpm check:lib-version`, `pnpm -C packages/deck check:dashes`.

## Decisions log

- `eol=lf` on `text=auto`, as the issue specifies, so the working tree is LF
  even where `core.autocrlf=true`.
- Binary types listed explicitly as well as relying on auto-detection, so a
  binary that happens to look like text is never converted.
- `packages/deck/test/activity.test.ts` contains a literal NUL byte and is
  auto-detected as binary; left alone, since git does not convert it.

## Follow-ups

- Neither `README.md` nor `INSTALL.md` currently advises cloning inside WSL
  rather than on the Windows-mounted filesystem. Consider adding it.
