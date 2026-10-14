import { execSync } from "node:child_process";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vite";

// Build stamp: the commit short-SHA is baked into the CLIENT bundle so a phone can prove which build it is actually running. Twice now
// ("are we on an old build?") a stale-bundle question was undiagnosable -
// the no-404 deploy keeps old assets serving, so a long-lived standalone tab
// can run yesterday's JS against today's server indefinitely.
let buildSha = "dev";
try {
  buildSha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
} catch {
  // Not a git checkout (CI tarball etc.) - stamp stays "dev".
}

export default defineConfig({
  define: {
    __MC_BUILD_SHA__: JSON.stringify(buildSha),
  },
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
  build: {
    // Zero-downtime deploy: do NOT wipe the output dir on build. The running
    // production daemon serves build/client/assets from disk live; emptying it
    // mid-build 404s the old hashed assets the in-memory HTML still references.
    // Keeping old assets means the live page stays whole until the restart cuts to the new build.
    // Orphaned assets are pruned by scripts/deploy.mjs after a healthy restart.
    emptyOutDir: false,
  },
  server: {
    // If a proxy fronts the dev server for laptop/phone access,
    // list its public hostname here (placeholder below - set your own).
    // The daemonised production build will not need this; dev-only allowance.
    allowedHosts: ["deck.example.com"],
  },
});
