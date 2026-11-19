<!-- Copy of the published body of #153 (2026-11-18). The origin link to an internal tracker is omitted here. -->
## Goal

Move Deck's terminal-backed agent execution from bash/tmux to a cross-platform TypeScript runner using node-pty/ConPTY, preserving safe delivery and lifecycle behaviour.

## Scope and first slice

Define a runner adapter for launch, input, output, resize, cancellation and exit. Prove one supported agent in an isolated fixture while tmux remains available; select the adapter explicitly rather than switching every agent at once. Preserve the refusal to send into an ended agent's shell.

Test delayed output, failed launch, cancellation, process cleanup and input refusal after exit. Plan a drained cutover: stop new admission, settle in-flight work and confirm ownership before replacing the old runner. Inventory delivery, stuck detection, metrics and streaming changes before later slices.

## Origin and qualification

Migrated from an internal tracker, expanded by maintainer direction on 18 November 2026. The existing investigation is background, not an accepted implementation contract. Native Windows, Linux and macOS acceptance requires separate evidence.

