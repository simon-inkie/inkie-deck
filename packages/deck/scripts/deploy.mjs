/**
 * scripts/deploy.mjs - no-404-window redeploy of the MC production daemon.
 *
 * THE BUG THIS FIXES: `pnpm build` used to empty build/client and write fresh
 * hashed asset names. The production daemon (react-router-serve) serves build/client
 * from disk LIVE while holding the prior server bundle in memory - so between
 * the build finishing and the restart completing, the live page's HTML still
 * pointed at the OLD hashes, which the build had just deleted -> 404 -> broken
 * styling + dead hydration on whatever the operator was looking at.
 *
 * THE FIX:
 *   1. vite build runs with emptyOutDir:false (see vite.config.ts), so a build
 *      ADDS new hashed assets while KEEPING the old ones. The running daemon
 *      keeps serving its old HTML + old assets intact during the build.
 *   2. Restart the daemon. The ONLY interruption is the restart itself (~1-2s,
 *      connection-refused which the browser retries) - never a broken render.
 *   3. Verify health: localhost 200, every referenced asset resolves on disk,
 *      and the tailnet front is 200. Loud non-zero exit if
 *      anything is off so the operator can roll back.
 *
 * NOT zero-CONNECTIVITY (the restart blip remains) but zero-BROKEN-RENDER, which
 * is the failure that actually occurred. True drain-and-swap is a v2 (needs a
 * second instance + a movable front; the serving proxy is pinned at :4242).
 *
 * Orphaned old assets are NOT auto-pruned here: a safe keep-set needs the full
 * route-chunk manifest (not just the initial HTML), and getting it wrong would
 * delete a live chunk. Growth is a few KB per deploy. Prune manually when needed
 * (stop the daemon, `pnpm build` with emptyOutDir temporarily true, restart).
 *
 * Usage: node scripts/deploy.mjs   (or: pnpm deploy)
 * Env: MC_TAILNET_HOST and MC_TAILNET_IP are REQUIRED (the hostname of the
 * front that serves the app, and the IP to pin it to for the remote-access check).
 * MC_PORT and MC_SERVICE have defaults and can be overridden.
 *
 * ASCII only - no em-dashes.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env["MC_PORT"] || "4242";
const SERVICE = process.env["MC_SERVICE"] || "inkie-deck.service";
const TAILNET_HOST = process.env["MC_TAILNET_HOST"];
const TAILNET_IP = process.env["MC_TAILNET_IP"];

function log(msg) {
  console.log(`[deploy] ${msg}`);
}
function die(msg) {
  console.error(`[deploy] FAIL: ${msg}`);
  console.error(`[deploy] roll back with: systemctl --user restart ${SERVICE} (after fixing) or git revert + redeploy`);
  process.exit(1);
}

// 0. Deployment identity comes from the environment; there is no meaningful
// default for someone else's front host, so fail fast before touching anything.
if (!TAILNET_HOST) die("MC_TAILNET_HOST is not set (front hostname; required for the lifeline check)");
if (!TAILNET_IP) die("MC_TAILNET_IP is not set (front host IP; required for the lifeline check)");

// 1. Build (emptyOutDir:false keeps old assets alive for the live daemon).
log("building (emptyOutDir:false - old assets preserved until restart)...");
try {
  execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
} catch {
  die("build failed - daemon untouched, still serving the prior build");
}

// 2. Restart the daemon (the only interruption: ~1-2s connection-refused).
log(`restarting ${SERVICE}...`);
try {
  execFileSync("systemctl", ["--user", "restart", SERVICE], { stdio: "inherit" });
} catch {
  die(`could not restart ${SERVICE}`);
}

// Give it a moment to bind.
execSync("sleep 4");

// 3. Verify health.
function httpCode(url, resolveArg) {
  const args = ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10"];
  if (resolveArg) args.push("--resolve", resolveArg);
  args.push(url);
  try {
    return execFileSync("curl", args, { encoding: "utf8" }).trim();
  } catch {
    return "000";
  }
}

const active = (() => {
  try {
    return execFileSync("systemctl", ["--user", "is-active", SERVICE], { encoding: "utf8" }).trim();
  } catch (e) {
    return (e.stdout || "").toString().trim() || "inactive";
  }
})();
if (active !== "active") die(`service is ${active} after restart`);
log("service active");

const localRoot = httpCode(`http://127.0.0.1:${PORT}/`);
if (localRoot !== "200") die(`localhost / -> ${localRoot}`);
log(`localhost / -> 200`);

// Every asset the served HTML references must exist on disk (the 404-window check).
let html = "";
try {
  html = execFileSync("curl", ["-s", "--max-time", "10", `http://127.0.0.1:${PORT}/`], { encoding: "utf8" });
} catch {
  die("could not fetch served HTML for asset check");
}
const refs = [...html.matchAll(/\/assets\/[A-Za-z0-9._-]+\.(?:css|js)/g)].map((m) => m[0]);
const missing = refs.filter((r) => !existsSync(path.join(root, "build", "client", r)));
if (missing.length > 0) die(`served HTML references missing assets (the 404 window!): ${missing.join(", ")}`);
log(`all ${refs.length} referenced assets resolve on disk`);

// Remote access check: the tailnet front must serve over Tailscale, not just localhost.
const tailRoot = httpCode(`https://${TAILNET_HOST}/`, `${TAILNET_HOST}:443:${TAILNET_IP}`);
if (tailRoot !== "200") die(`tailnet / -> ${tailRoot} (lifeline check)`);
log(`tailnet / -> 200 (lifeline intact)`);

log("deploy healthy. New build live, no broken-asset window.");
