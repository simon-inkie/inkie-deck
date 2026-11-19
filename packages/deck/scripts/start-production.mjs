/**
 * scripts/start-production.mjs - daemon launcher.
 *
 * The systemd unit's ExecStart. Differences from dev.mjs, deliberately:
 *   - NO fixture seeding, NO .runtime sandbox, NO MC_NOW pin (real clock).
 *   - All four roots come from the EnvironmentFile (.env.production) under
 *     systemd, or from a local .env for a hand-run start, and are
 *     validated HERE, fail-fast, before anything listens - a misconfigured
 *     daemon must crash with the bad root named in the journal, not sit
 *     "active (running)" while 500ing.
 *   - Serves the production build via server/production.mjs. Run `pnpm build`
 *     before (re)starting the unit.
 *   - Spawns the voice proxy as a sibling, in the same SHAPE dev.mjs uses but
 *     with less configuration. The proxy's origin allowlist now defaults to
 *     this app's own http://localhost:$PORT (see defaultAllowedOrigins in
 *     server/voice-relay.mjs), so a local start needs only DEEPGRAM_API_KEY.
 *     Two things still come from the environment: VOICE_PROXY_URL, because the
 *     client URL falls back to ws://localhost:5176/voice, which the BROWSER
 *     resolves (so it means the reader's machine, not this one), and
 *     VOICE_PROXY_HOST, because the proxy binds loopback. Both, and
 *     VOICE_ALLOWED_ORIGINS for any non-localhost origin, are in .env.example
 *     and walked through in INSTALL.md "Voice dictation".
 *
 * ASCII only - no em-dashes.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { isLoopbackHost } from "../server/bind-host.mjs";
import { withVoiceDisabledReason } from "./voice-env.mjs";

const root = process.cwd();

// --- Local .env, if there is one (must precede root validation) ------------
// Under systemd the roots arrive through the unit's EnvironmentFile, so this
// launcher never needed to load a file of its own. A hand-run production
// start has no EnvironmentFile, and the documented "copy .env.example to
// .env" step silently did nothing here (Vite honours .env in dev, so the
// same file worked in dev and was ignored in production, and the launcher
// reported a variable the user had just set as "not set").
//
// process.loadEnvFile is native to Node (the 22.18 floor), so this adds no
// dependency. It does NOT overwrite a variable already present in the
// environment, so under systemd every value still comes from the unit and
// this is a no-op for that deployment.
//
// .env.production is deliberately NOT read here: that file is systemd's
// input, and reading it too would give one file two owners.
const envFile = path.join(root, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
  console.log(`[prod] .env loaded from ${envFile} (process environment wins)`);
} else {
  console.log(`[prod] .env absent at ${envFile} - using the process environment only`);
}

// --- Fail-fast root validation (journal names the offender) ---------------
const REQUIRED_ROOTS = [
  "INBOX_ROOT",
  "ATTACHMENTS_ROOT",
  "PROJECTS_ROOT",
  "DATA_ROOT",
];
for (const name of REQUIRED_ROOTS) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    console.error(`[prod] FATAL: ${name} is required but not set.`);
    process.exit(1);
  }
  if (!path.isAbsolute(value)) {
    console.error(`[prod] FATAL: ${name}="${value}" must be an absolute path.`);
    process.exit(1);
  }
  if (!existsSync(value)) {
    console.error(`[prod] FATAL: ${name}="${value}" does not exist.`);
    process.exit(1);
  }
}

const buildEntry = path.join(root, "build", "server", "index.js");
if (!existsSync(buildEntry)) {
  console.error(
    `[prod] FATAL: ${buildEntry} missing - run \`pnpm build\` before starting the unit.`
  );
  process.exit(1);
}

const appPort = process.env["PORT"] || "4242";
const appHost = process.env["HOST"] || "127.0.0.1";
const voiceProxyPort = process.env["VOICE_PROXY_PORT"] || "5176";

console.log(`[prod] INBOX_ROOT=${process.env["INBOX_ROOT"]}`);
console.log(`[prod] ATTACHMENTS_ROOT=${process.env["ATTACHMENTS_ROOT"]}`);
console.log(`[prod] PROJECTS_ROOT=${process.env["PROJECTS_ROOT"]}`);
console.log(`[prod] DATA_ROOT=${process.env["DATA_ROOT"]}`);
console.log(`[prod] MC_NOW=${process.env["MC_NOW"] || "(unset - real clock)"}`);
console.log(`[prod] app on http://${appHost}:${appPort}`);
// A loopback bind is the right default behind a proxy, and it is silent: a
// published container port or a request from another machine simply gets
// nothing, while this banner still reads like a healthy start. Say so.
if (isLoopbackHost(appHost)) {
  console.log(
    `[prod] HOST=${appHost} is loopback, so ONLY this machine can reach the app.` +
      ` That is the default on purpose (this deployment sits behind a proxy).` +
      ` To reach it from a container port map or another machine set HOST=0.0.0.0,` +
      ` in .env or in the environment, and put access control in front of it.`
  );
}
console.log(
  `[prod] DEEPGRAM_API_KEY ${process.env["DEEPGRAM_API_KEY"] ? "present" : "ABSENT - voice disabled"}`
);

// --- Voice proxy (same child-process shape as dev.mjs) ---------------------
const proxyEnv = { ...process.env, VOICE_PROXY_PORT: voiceProxyPort };
if (!process.env["DEEPGRAM_API_KEY"]) {
  delete proxyEnv["DEEPGRAM_API_KEY"];
}
const voiceProxy = spawn(
  "node",
  [path.join(root, "server", "voice-proxy.mjs")],
  { stdio: "inherit", env: proxyEnv }
);
voiceProxy.on("error", (err) => {
  console.error("[prod] voice-proxy spawn error:", err.message);
});

// --- Push watcher (same sibling shape) -----------------------------
// Crash-isolated by design: if the watcher dies, pushes stop but the daemon
// lives on (degrade, never drag down the serving proxy). Exit is logged so the
// journal shows the gap; no respawn loop v1.
const pushWatcher = spawn(
  process.execPath,
  [path.join(root, "server", "push-watcher.mjs")],
  { stdio: "inherit", env: { ...process.env } }
);
pushWatcher.on("error", (err) => {
  console.error("[prod] push-watcher spawn error:", err.message);
});
pushWatcher.on("exit", (code) => {
  console.error(`[prod] push-watcher exited (${code}) - pushes OFF until daemon restart.`);
});

// --- The app server ---------------------------------------------------------
// --max-http-header-size=65536: raise Node's incoming-header cap from the 16KB
// default to 64KB. Behind the Tailscale serve proxy a client can accumulate a
// large Cookie header (stale/duplicated cookies survive a hard-refresh), which
// the 16KB default rejects with HTTP 431 "Request Header Fields Too Large"
// before the app ever sees the request. MC sets no cookies of its own, so this
// is tolerance, not a leak; the client-side fix is clearing site-data.
// The app never reads the speech key; see scripts/voice-env.mjs.
const appEnv = withVoiceDisabledReason({
  ...process.env,
  PORT: appPort,
  HOST: appHost,
});
const child = spawn(
  process.execPath,
  ["--max-http-header-size=65536", "--enable-source-maps", path.join(root, "server", "production.mjs"), buildEntry],
  {
    stdio: "inherit",
    env: appEnv,
  }
);

function cleanup() {
  if (!voiceProxy.killed) {
    voiceProxy.kill();
  }
  if (!pushWatcher.killed) {
    pushWatcher.kill();
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });

child.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 0);
});
