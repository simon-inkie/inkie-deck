/**
 * scripts/dev.mjs - dev server launcher with a throwaway inbox.
 *
 * Why: the inbox is file-backed, so a dev server pointed at a committed
 * fixtures dir writes every answer/compose straight into git-tracked files
 * (and breaks the parser round-trip + skeleton tests). This launcher copies
 * the rich demo inbox into a gitignored .runtime/inbox and points INBOX_ROOT
 * there, so manual play never touches committed fixtures.
 *
 * MC_NOW is pinned to a fixed instant matching the demo fixture dates so the
 * SLA labels ("Overdue", "in 5h") render a deliberate mix. Override by
 * exporting MC_NOW before running. Pass extra flags through to react-router
 * (e.g. `pnpm dev --port 5174`).
 *
 * Also spawns server/voice-proxy.mjs as a child process. Forwards
 * DEEPGRAM_API_KEY when present. Sets VOICE_PROXY_URL for the RR server.
 * Kills the proxy on exit.
 *
 * ASCII only - no em-dashes.
 */
import { cpSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { withVoiceDisabledReason } from "./voice-env.mjs";

const root = process.cwd();
const demoInbox = path.join(root, "fixtures", "demo-inbox");
const runtimeDir = path.join(root, ".runtime");
const runtimeInbox = path.join(runtimeDir, "inbox");
const runtimeAttachments = path.join(runtimeDir, "attachments");
const runtimeProjects = path.join(runtimeDir, "projects");
const runtimeData = path.join(runtimeDir, "data");

// Fall back to the minimal fixture set if the demo inbox is absent.
const source = existsSync(demoInbox)
  ? demoInbox
  : path.join(root, "fixtures", "inbox");

rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(runtimeDir, { recursive: true });
cpSync(source, runtimeInbox, { recursive: true });
mkdirSync(runtimeAttachments, { recursive: true });

// Seed the projects runtime dir from fixtures/projects.
const fixturesProjects = path.join(root, "fixtures", "projects");
cpSync(fixturesProjects, runtimeProjects, { recursive: true });

// DATA_ROOT for MC state files (queue state) - must exist at boot.
mkdirSync(runtimeData, { recursive: true });

// REVIEW_ROOTS for dev: the repo root itself + .runtime so docs/plans/*.md
// can be opened directly in the review panel (intentional).
// INBOX_ROOT is always appended implicitly by review.server.ts.
const reviewRoots = process.env["REVIEW_ROOTS"] || `${root}:${runtimeDir}`;

// Voice proxy settings.
const voiceProxyPort = process.env["VOICE_PROXY_PORT"] || "5176";
const voiceProxyUrl = `ws://localhost:${voiceProxyPort}/voice`;

// Respect pre-set roots. The
// internal .runtime sandbox is the FALLBACK, not a clobber - before this fix
// every export was silently overridden and the server always ran on demo
// fixtures regardless of the launcher's intent.
const externalInbox = Boolean(process.env.INBOX_ROOT);
const env = {
  ...process.env,
  INBOX_ROOT: process.env.INBOX_ROOT || runtimeInbox,
  ATTACHMENTS_ROOT: process.env.ATTACHMENTS_ROOT || runtimeAttachments,
  REVIEW_ROOTS: reviewRoots,
  PROJECTS_ROOT: process.env.PROJECTS_ROOT || runtimeProjects,
  DATA_ROOT: process.env.DATA_ROOT || runtimeData,
  // Keep the queue-state file INSIDE the dev DATA_ROOT. Without this the
  // makeStores default (cwd/data/queue-state.json) sits outside .runtime/data
  // and every deadline-anchor write 500s the home loader on the confinement
  // guard.
  QUEUE_STATE_PATH:
    process.env.QUEUE_STATE_PATH ||
    path.join(runtimeData, "queue-state.json"),
  // Pin fake-now ONLY on the internal sandbox (demo fixture dates need it).
  // With an external inbox this is a real session: leave MC_NOW absent so the
  // app falls back to the real clock. NB an explicit MC_NOW export still wins
  // via the process.env spread above.
  ...(externalInbox ? {} : { MC_NOW: process.env.MC_NOW || "2026-06-09T16:00:00Z" }),
  // Tmux OFF on the internal sandbox, same reasoning as MC_NOW above. Without
  // this, MC_TMUX_ENABLED defaults on and MC_TMUX_SESSION defaults to
  // "agents" - the real fleet's actual session name, on any machine that has
  // one. A fixture agent whose name happens to collide with a real window
  // (the demo roster includes "quill") then shows that
  // window's real live pane content in what INSTALL.md documents as a
  // sandbox that "has no tmux, no agents". An explicit MC_TMUX_ENABLED export
  // still wins via the process.env spread above.
  ...(externalInbox ? {} : { MC_TMUX_ENABLED: process.env.MC_TMUX_ENABLED || "false" }),
  VOICE_PROXY_URL: voiceProxyUrl,
  VOICE_PROXY_PORT: voiceProxyPort,
};

console.log(`[dev] inbox seeded from ${path.relative(root, source)} -> .runtime/inbox`);
console.log(`[dev] INBOX_ROOT=${env.INBOX_ROOT}${externalInbox ? " (external)" : ""}`);
console.log(`[dev] ATTACHMENTS_ROOT=${env.ATTACHMENTS_ROOT}`);
console.log(`[dev] REVIEW_ROOTS=${reviewRoots}`);
console.log(`[dev] PROJECTS_ROOT=${env.PROJECTS_ROOT}`);
console.log(`[dev] DATA_ROOT=${env.DATA_ROOT}`);
console.log(`[dev] MC_NOW=${env.MC_NOW || "(unset - real clock)"}`);
console.log(`[dev] VOICE_PROXY_URL=${voiceProxyUrl}`);

// Resolve the app port BEFORE spawning the voice proxy - the proxy's origin
// allowlist must match the origin the app actually serves from, or every WS
// upgrade 401s silently when the port changes (bit us on the 5174 -> 4242 move).
const passthrough = process.argv.slice(2);
const portFlagIdx = passthrough.findIndex(
  (a) => a === "--port" || a.startsWith("--port=")
);
const appPort =
  portFlagIdx === -1
    ? "4242"
    : passthrough[portFlagIdx].includes("=")
      ? passthrough[portFlagIdx].split("=")[1]
      : passthrough[portFlagIdx + 1] || "4242";

// Spawn the voice proxy as a child process.
// Forward DEEPGRAM_API_KEY when present; proxy starts regardless and sends
// {type:"status",state:"no_key"} to clients when the key is absent.
const proxyEnv = {
  ...env,
  VOICE_ALLOWED_ORIGINS:
    process.env["VOICE_ALLOWED_ORIGINS"] || `http://localhost:${appPort}`,
};
if (!process.env["DEEPGRAM_API_KEY"]) {
  // Ensure the child process also does not inherit a stale key.
  delete proxyEnv["DEEPGRAM_API_KEY"];
}
console.log(`[dev] VOICE_ALLOWED_ORIGINS=${proxyEnv.VOICE_ALLOWED_ORIGINS}`);
const voiceProxy = spawn(
  "node",
  [path.join(root, "server", "voice-proxy.mjs")],
  {
    stdio: "inherit",
    env: proxyEnv,
  }
);
voiceProxy.on("error", (err) => {
  console.error("[dev] voice-proxy spawn error:", err.message);
});

const args = [
  "dev",
  ...(portFlagIdx === -1 ? ["--port", appPort] : []),
  ...passthrough,
];
// The app never reads the speech key; see scripts/voice-env.mjs.
const appEnv = withVoiceDisabledReason(env);
const child = spawn("react-router", args, {
  stdio: "inherit",
  env: appEnv,
  shell: true,
});

// Kill the voice proxy when the dev server exits.
function cleanup() {
  if (!voiceProxy.killed) {
    voiceProxy.kill();
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });

child.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 0);
});
