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
 * These rules run in CI on every push (`npm run check:boundaries`) so a
 * violation fails the pipeline rather than surviving as a note in a README.
 */
module.exports = {
  forbidden: [
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
        pathNot: "^packages/base/(bin/inbox\\.mts|package\\.json)$",
      },
    },
    {
      name: "domain-imports-only-domain-and-protocol",
      severity: "error",
      comment:
        "packages/deck/src/domain is the neutral domain model: pure types " +
        "and transitions. It may import other domain modules and (at most) " +
        "the protocol package's entry points, nothing else. An import of an " +
        "adapter, a store, UI code or a third-party library is the first " +
        "step of the domain quietly becoming one deployment's domain.",
      from: { path: "^packages/deck/src/domain" },
      to: {
        pathNot:
          "^packages/deck/src/domain|^packages/base/(bin/inbox\\.mts|package\\.json)$",
      },
    },
    {
      name: "domain-uses-no-node-builtins",
      severity: "error",
      comment:
        "The domain has no filesystem, no I/O and no system clock. Any " +
        "node: builtin import in packages/deck/src/domain smuggles a " +
        "runtime dependency into the layer whose whole value is not having " +
        "one; that code belongs in an adapter (e.g. src/store).",
      from: { path: "^packages/deck/src/domain" },
      to: { dependencyTypes: ["core"] },
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
