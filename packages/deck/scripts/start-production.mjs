/**
 * scripts/start-production.mjs - daemon launcher (TASK-435 layer 2).
 *
 * The systemd unit's ExecStart. Differences from dev.mjs, deliberately:
 *   - NO fixture seeding, NO .runtime sandbox, NO MC_NOW pin (real clock).
 *   - All four roots come from the EnvironmentFile (.env.production) and are
 *     validated HERE, fail-fast, before anything listens - a misconfigured
 *     daemon must crash with the bad root named in the journal, not sit
 *     "active (running)" while 500ing (TASK-434 boot validation, daemon shape).
 *   - Serves the production build via react-router-serve. Run `pnpm build`
 *     before (re)starting the unit.
 *   - Spawns the voice proxy exactly like dev.mjs does; origins/URL come from
 *     env (the tailnet origin in production - see .env.example).
 *
 * ASCII only - no em-dashes (FND-05 / check:dashes gate).
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();

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
    console.error(`[prod] FATAL: ${name} is required but not set (FND-03).`);
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

// --- Push watcher (TASK-470, same sibling shape) -----------------------------
// Crash-isolated by design: if the watcher dies, pushes stop but the daemon
// lives on (degrade, never drag down the lifeline). Exit is logged so the
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
// Run react-router-serve's REAL JS entry with the SAME node binary as this
// process (process.execPath) - never the `.bin/react-router-serve` shell shim
// (node would try to parse the shim as JS) and never a PATH-resolved `node`
// (systemd's login shell resolved system node v18, not nvm v22; RR7 needs 20+).
const serveCli = path.join(
  root,
  "node_modules",
  "@react-router",
  "serve",
  "dist",
  "cli.js"
);
if (!existsSync(serveCli)) {
  console.error(`[prod] FATAL: ${serveCli} missing - reinstall dependencies.`);
  process.exit(1);
}
// --max-http-header-size=65536: raise Node's incoming-header cap from the 16KB
// default to 64KB. Behind the Tailscale serve proxy a client can accumulate a
// large Cookie header (stale/duplicated cookies survive a hard-refresh), which
// the 16KB default rejects with HTTP 431 "Request Header Fields Too Large"
// before the app ever sees the request. MC sets no cookies of its own, so this
// is tolerance, not a leak; the client-side fix is clearing site-data. (Quill,
// 2026-06-15 incident.)
const child = spawn(
  process.execPath,
  ["--max-http-header-size=65536", serveCli, buildEntry],
  {
    stdio: "inherit",
    env: { ...process.env, PORT: appPort, HOST: appHost },
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
