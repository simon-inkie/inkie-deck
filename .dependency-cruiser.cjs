/**
 * Dependency boundary rules for the inkie-deck workspace.
 *
 * The decision this file enforces: inkie-agents-base is bundled INTO this
 * repository so Deck works on first run, but it must stay separable so it
 * can be spun out into its own repository later. Separable means, concretely:
 *
 *   - base may NEVER import anything from deck, in any file, for any reason
 *   - deck MAY depend on base, but only through base's published entry
 *     points, never by reaching into its internals
 *
 * These rules run in CI on every push (`pnpm check:boundaries`) so a
 * violation fails the pipeline rather than surviving as a note in a README.
 */
module.exports = {
  forbidden: [
    {
      name: "deck-runner-does-not-import-test-code",
      severity: "error",
      from: { path: "^packages/deck/app/lib/runner/" },
      to: { path: "^packages/deck/(?:test|e2e)/" },
    },
    {
      name: "base-never-imports-deck",
      severity: "error",
      comment:
        "packages/base must remain extractable to its own repository at any " +
        "moment. A single import from packages/deck welds it to this " +
        "workspace and silently ends that property.",
      from: { path: "^packages/base" },
      to: { path: "^packages/deck" },
    },
    {
      name: "deck-only-uses-base-entry-points",
      severity: "error",
      comment:
        "packages/deck may depend on packages/base only via the entry " +
        "points base's package.json exports. A deep import into base " +
        "internals couples deck to file layout that base is free to change, " +
        "and breaks the moment base is spun out and consumed as a real " +
        "published package.",
      from: { path: "^packages/deck" },
      to: {
        path: "^packages/base",
        // This allowlist IS base's `exports` map, spelled out a second time.
        // When the rule was written package.json was the only entry point, so
        // "an export" and "package.json" were indistinguishable;
        // conformance/corpus.json is now the second. The application reads
        // that corpus to prove itself against the shared protocol, which is
        // the one thing the two packages must agree on, and reaching it by
        // package name rather than relative path is what keeps it working if
        // base is spun out. Adding an entry here WITHOUT adding it to base's
        // `exports` would be a deep import wearing a permission slip.
        pathNot: "^packages/base/(?:package\\.json|conformance/corpus\\.json)$",
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    exclude: { path: "node_modules" },
    enhancedResolveOptions: {
      // enhanced-resolve follows the workspace symlink for
      // "inkie-agents-base" to its real path under packages/base by
      // default, so the rules above see the true target.
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".ts", ".mts", ".js", ".mjs", ".cjs", ".json"],
    },
  },
};
