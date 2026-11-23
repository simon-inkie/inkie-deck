import { AsyncLocalStorage } from "node:async_hooks";
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

const activeServersKey = Symbol.for("inkie-deck.vite.active-servers");
const activeShutdownsKey = Symbol.for("inkie-deck.vite.active-shutdowns");
const closingAlsKey = Symbol.for("inkie-deck.dev.server-closing-als");
const registryKey = Symbol.for("inkie-deck.acp.registry");
const viteGlobals = globalThis as typeof globalThis & {
  [activeServersKey]?: Set<symbol>;
  [activeShutdownsKey]?: Set<Promise<void>>;
  [closingAlsKey]?: AsyncLocalStorage<() => boolean>;
  [registryKey]?: {
    closing: boolean;
    shutdownPromise?: Promise<void>;
  };
};
const activeServers = viteGlobals[activeServersKey] ??= new Set<symbol>();
const activeShutdowns = viteGlobals[activeShutdownsKey] ??= new Set<Promise<void>>();
const serverClosingAls = viteGlobals[closingAlsKey] ??= new AsyncLocalStorage<() => boolean>();

function deckDevSocket(): Plugin {
  return {
    name: "deck-dev-socket",
    async configureServer(server) {
      // Major 3 (Round 10): Install the per-server close wrapper, SIGTERM/SIGINT await chain,
      // and closing-server Start rejection gate SYNCHRONOUSLY BEFORE any await (such as ssrLoadModule),
      // so a replacement server caught in ssrLoadModule still awaits in-flight ACP cleanup and an
      // old closing server with an open transport immediately rejects /api/acp POSTs with 409.
      const serverToken = Symbol("vite-dev-server");
      activeServers.add(serverToken);
      let serverClosing = false;
      let acpRegistry: typeof import("./app/lib/runner/acp-registry.server").acpRunnerRegistry | undefined;
      let shutdownPromise: Promise<void> | undefined;

      const runShutdown = (forcePermanent = false) => {
        serverClosing = true;
        activeServers.delete(serverToken);
        const permanent = forcePermanent || activeServers.size === 0;
        const sharedState = viteGlobals[registryKey];
        if (permanent && sharedState) {
          sharedState.closing = true;
        }
        const drain = async () => {
          // Always await any already-in-flight shutdown from another server instance even if
          // this server has not finished loading acpRegistry via ssrLoadModule yet.
          const prior = Array.from(activeShutdowns);
          if (prior.length > 0) {
            await Promise.all(prior.map((p) => p.catch(() => {})));
          }
          if (viteGlobals[registryKey]?.shutdownPromise) {
            await viteGlobals[registryKey].shutdownPromise.catch(() => {});
          }
          if (acpRegistry) {
            await acpRegistry.shutdown({ permanent }).catch(() => {});
          }
        };
        const track = (p: Promise<void>) => {
          activeShutdowns.add(p);
          return p.finally(() => { activeShutdowns.delete(p); });
        };
        if (forcePermanent) {
          const escalated = track(drain());
          shutdownPromise = shutdownPromise ? shutdownPromise.then(() => escalated) : escalated;
          return shutdownPromise;
        }
        shutdownPromise ??= track(drain());
        return shutdownPromise;
      };

      const originalClose = server.close.bind(server);
      let sigintHandled = false;
      const onSigint = () => {
        if (sigintHandled) return;
        sigintHandled = true;
        activeServers.clear();
        void runShutdown(true)
          .then(() => originalClose().catch(() => {}))
          .finally(() => process.exit(0));
      };
      process.once("SIGINT", onSigint);
      server.close = async () => {
        process.off("SIGINT", onSigint);
        await runShutdown(false);
        return originalClose();
      };
      server.httpServer?.once("close", () => {
        process.off("SIGINT", onSigint);
        void runShutdown(false);
      });

      server.middlewares.use((request, response, next) => {
        if (serverClosing && request.method === "POST" && request.url?.startsWith("/api/acp")) {
          response.statusCode = 409;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ ok: false, error: "Deck is shutting down." }));
          return;
        }
        serverClosingAls.run(() => serverClosing, next);
      });

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

      try {
        const mod = await server.ssrLoadModule("/app/lib/runner/acp-registry.server.ts") as
          typeof import("./app/lib/runner/acp-registry.server");
        acpRegistry = mod.acpRunnerRegistry;
        if (serverClosing) {
          await runShutdown(false);
        } else {
          acpRegistry.reopen();
          await acpRegistry.recover();
        }
      } catch {
        // Non-fatal fallback if SSR module is unavailable during tooling runs.
      }
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
