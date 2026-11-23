import { execSync } from "node:child_process";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig, loadEnv } from "vite";
import type { Plugin } from "vite";
import { isLoopbackHost, warnNetworkBind } from "./server/bind-host.mjs";

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

function deckDevSocket(): Plugin {
  return {
    name: "deck-dev-socket",
    async configureServer(server) {
      const host = server.config.server.host;
      const bindHost = host === true ? "0.0.0.0" : host || "localhost";
      const { HOST } = loadEnv(server.config.mode, server.config.envDir, "HOST");
      warnNetworkBind("dev", isLoopbackHost(bindHost) ? HOST || bindHost : bindHost);
      server.middlewares.use(async (request, _response, next) => {
        const address = request.socket.remoteAddress;
        try {
          const { devSocketAddress } = await server.ssrLoadModule("/app/lib/request-origin.server.ts") as
            typeof import("./app/lib/request-origin.server");
          devSocketAddress.run(address, next);
        } catch (error) {
          next(error);
        }
      });
      // Major 4: Load and retain the ACP registry while SSR is live, await initial recovery before
      // Vite listens, handle SIGINT explicitly (pinned Vite only registers SIGTERM), and keep per-server
      // close non-permanent so an in-process Vite restart does not latch global `closing = true`.
      let acpRegistry: typeof import("./app/lib/runner/acp-registry.server").acpRunnerRegistry | undefined;
      try {
        const mod = await server.ssrLoadModule("/app/lib/runner/acp-registry.server.ts") as
          typeof import("./app/lib/runner/acp-registry.server");
        acpRegistry = mod.acpRunnerRegistry;
        await acpRegistry.recover();
      } catch {
        // Non-fatal fallback if SSR module is unavailable during tooling runs.
      }
      let closed = false;
      let shutdownPromise: Promise<void> | undefined;
      const runShutdown = (permanent: boolean) => {
        if (!acpRegistry) return Promise.resolve();
        shutdownPromise ??= acpRegistry.shutdown({ permanent }).catch(() => {});
        return shutdownPromise;
      };
      const originalClose = server.close.bind(server);
      const onSigint = () => {
        if (closed) return;
        closed = true;
        void runShutdown(true)
          .then(() => originalClose().catch(() => {}))
          .finally(() => process.exit(0));
      };
      process.once("SIGINT", onSigint);
      server.close = async () => {
        process.off("SIGINT", onSigint);
        if (!closed) {
          closed = true;
          await runShutdown(false);
        }
        return originalClose();
      };
      server.httpServer?.once("close", () => {
        process.off("SIGINT", onSigint);
        if (!closed) {
          closed = true;
          void runShutdown(false);
        }
      });
    },
  };
}

export default defineConfig({
  define: {
    __MC_BUILD_SHA__: JSON.stringify(buildSha),
  },
  plugins: [deckDevSocket(), tailwindcss(), reactRouter(), tsconfigPaths()],
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
