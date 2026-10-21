/**
 * Read-only production checks. No listeners, child processes or file writes.
 * Inputs: the launcher's .env (read from this package, as start-production does),
 * the process environment, and optionally MC_BROWSER_ORIGIN or --origin for the
 * voice origin check.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveAllowedOrigins } from "../server/voice-relay.mjs";

const result = (name, status, message) => ({ name, status, message });
const present = (value) => Boolean(value?.trim());
const ROOTS = ["INBOX_ROOT", "PROJECTS_ROOT", "ATTACHMENTS_ROOT", "DATA_ROOT"];

/** Pure decisions consume observations rather than touching the filesystem. */
export function checkIdentity(env) {
  if (!present(env.MC_USER)) return result("identity", "WARN", "MC_USER is unset: the default identity is used. Set MC_USER if this instance belongs to someone else.");
  return result("identity", "PASS", "MC_USER is set.");
}

export function checkRoot(name, value, facts) {
  if (!present(value)) return result(name, "FAIL", `${name} is absent.`);
  if (!path.isAbsolute(value)) return result(name, "FAIL", `${name} must be absolute.`);
  if (!facts?.directory || !facts.readable || !facts.writable || !facts.searchable) return result(name, "FAIL", `${name} must exist as a readable, writable, searchable directory.`);
  return result(name, "PASS", `${name} is present and accessible.`);
}

export function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** The runtime falls back to cwd/data/*.json and does not need these inside DATA_ROOT. */
export function checkStatePath(name, value, facts) {
  if (!present(value)) return result(name, "WARN", `${name} is unset: the runtime default under the working directory is used.`);
  if (!facts?.accessible) return result(name, "FAIL", `${name} or its parent is not readable/writable as needed.`);
  return result(name, "PASS", `${name} is set and accessible.`);
}

export function checkBriefs(env) {
  if (!present(env.MC_BRIEFS_AGENT)) return result("briefs", "WARN", "MC_BRIEFS_AGENT absent: the default briefs agent is used.");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(env.MC_BRIEFS_AGENT.trim())) return result("briefs", "FAIL", "MC_BRIEFS_AGENT is not a valid lowercase agent identifier.");
  return result("briefs", "PASS", "MC_BRIEFS_AGENT is present.");
}

/** Offline view only: the browser alone can confirm its subscription matches the current key. */
export function checkPush(facts) {
  if (!facts.keysPresent || !facts.storePresent) return result("push", "WARN", "VAPID key file and subscription store are not both present under DATA_ROOT; push is not ready. No files were created.");
  if (!facts.confined || !facts.validKeys || !facts.validStore) return result("push", "FAIL", "Push files must be confined to DATA_ROOT and parse as a VAPID keypair and a subscription store.");
  return result("push", "WARN", `Push files parse; ${facts.count} stored subscription(s). Whether a stored subscription matches the current VAPID key cannot be verified offline; the browser checks it against the status route (notification toggle).`);
}

export function checkPort(name, rawPort, occupied) {
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) return result(name, "FAIL", `${name} must be an integer between 1 and 65535.`);
  if (occupied === null) return result(name, "WARN", `${name} availability could not be inspected without opening a socket.`);
  if (occupied.includes(Number(rawPort))) return result(name, "FAIL", `${name} is already listening (this can simply mean Deck is already running).`);
  return result(name, "PASS", `${name} is free in the read-only listener snapshot (not a bind guarantee).`);
}

export function checkVoiceOrigin(env, origin) {
  if (!present(origin)) return result("voice origins", "WARN", "Browser origin is unspecified; pass --origin https://deck.example or set MC_BROWSER_ORIGIN.");
  try {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || origin.replace(/\/$/, "") !== url.origin) throw new Error();
    if (!resolveAllowedOrigins(env).includes(url.origin)) return result("voice origins", "FAIL", "VOICE_ALLOWED_ORIGINS does not include the configured browser origin.");
    return result("voice origins", "PASS", "Voice origins include the configured browser origin.");
  } catch {
    return result("voice origins", "FAIL", "Configured browser origin must be an HTTP(S) origin without a path.");
  }
}

function canAccess(file, mode) {
  try { fs.accessSync(file, mode); return true; } catch { return false; }
}

function rootFacts(file) {
  try {
    return { directory: fs.statSync(file).isDirectory(), readable: canAccess(file, fs.constants.R_OK), writable: canAccess(file, fs.constants.W_OK), searchable: canAccess(file, fs.constants.X_OK) };
  } catch { return {}; }
}

// Resolve existing ancestors too, so a missing file below a symlink cannot pass.
function resolvedTarget(file) {
  try { return fs.realpathSync(file); } catch (error) {
    if (error.code !== "ENOENT" || path.dirname(file) === file) throw error;
    // A dangling symlink is an error, not an absent ordinary file.
    try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error("dangling symlink"); } catch (statError) { if (statError.code !== "ENOENT") throw statError; }
    return path.join(resolvedTarget(path.dirname(file)), path.basename(file));
  }
}

function stateFacts(value, cwd) {
  if (!present(value)) return {};
  try {
    const target = path.resolve(cwd, value);
    const parent = path.dirname(target);
    const accessible = fs.existsSync(target)
      ? fs.statSync(target).isFile() && canAccess(target, fs.constants.R_OK | fs.constants.W_OK) && canAccess(parent, fs.constants.W_OK | fs.constants.X_OK)
      : canAccess(parent, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    return { accessible };
  } catch { return {}; }
}

function insideRoot(dataRoot, file, cwd) {
  try { return isInside(fs.realpathSync(path.resolve(cwd, dataRoot)), resolvedTarget(file)); } catch { return false; }
}

export function parseListeningPorts(tables) {
  const ports = new Set();
  for (const table of tables) {
    for (const line of table.trim().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === "0A") {
        const port = Number.parseInt(fields[1]?.split(":").at(-1) ?? "", 16);
        if (Number.isFinite(port)) ports.add(port);
      }
    }
  }
  return [...ports];
}

/** Mirrors VapidKeysSchema and SubscriptionStateSchema in app/lib/push.server.ts. */
export function pushFacts(dataRoot, cwd) {
  if (!present(dataRoot)) return {};
  const keyFile = path.resolve(cwd, dataRoot, "vapid-keys.json");
  const storeFile = path.resolve(cwd, dataRoot, "push-subscriptions.json");
  const facts = { keysPresent: fs.existsSync(keyFile), storePresent: fs.existsSync(storeFile) };
  facts.confined = [keyFile, storeFile].every((file) => insideRoot(dataRoot, file, cwd));
  if (!facts.confined || !facts.keysPresent || !facts.storePresent) return facts;
  try {
    const keys = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    facts.validKeys = typeof keys.publicKey === "string" && keys.publicKey.length > 0 && typeof keys.privateKey === "string" && keys.privateKey.length > 0;
  } catch { facts.validKeys = false; /* Never disclose JSON or keys. */ }
  try {
    const store = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    facts.validStore = store.version === 1 && Array.isArray(store.subscriptions) && store.subscriptions.every((sub) => {
      try { new URL(sub.endpoint); } catch { return false; }
      return typeof sub.keys?.p256dh === "string" && sub.keys.p256dh.length > 0 && typeof sub.keys?.auth === "string" && sub.keys.auth.length > 0 && typeof sub.addedAt === "string";
    });
    facts.count = facts.validStore ? store.subscriptions.length : 0;
  } catch { facts.validStore = false; }
  return facts;
}

/** CLI IO boundary: exactly the launcher's .env precedence, no .env.production. */
export function runPreflight({ cwd = process.cwd(), origin } = {}) {
  // The .env is read from the current working directory, as the launcher does, so run preflight from the same directory the service uses.
  const envFile = path.join(cwd, ".env");
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;
  const checks = [checkIdentity(env)];
  for (const name of ROOTS) checks.push(checkRoot(name, env[name], rootFacts(env[name] || "")));
  for (const name of ["QUEUE_STATE_PATH", "FILE_PINS_PATH"]) checks.push(checkStatePath(name, env[name], stateFacts(env[name], cwd)));
  checks.push(checkBriefs(env), checkPush(pushFacts(env.DATA_ROOT, cwd)));
  let occupied = null;
  try { occupied = parseListeningPorts([fs.readFileSync("/proc/net/tcp", "utf8"), fs.readFileSync("/proc/net/tcp6", "utf8")]); } catch { /* Non-Linux or restricted procfs. */ }
  const port = env.PORT || "4242";
  const voicePort = env.VOICE_PROXY_PORT || "5176";
  checks.push(checkPort("PORT", port, occupied), checkPort("VOICE_PROXY_PORT", voicePort, occupied));
  if (Number(port) === Number(voicePort)) checks.push(result("port collision", "FAIL", "App and voice ports must differ."));
  checks.push(checkVoiceOrigin(env, origin ?? env.MC_BROWSER_ORIGIN));
  return checks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && !(args.length === 2 && args[0] === "--origin")) throw new Error("arguments");
    const checks = runPreflight({ origin: args[1] });
    for (const check of checks) console.log(`${check.status} ${check.name}: ${check.message}`);
    process.exitCode = checks.some((check) => check.status === "FAIL") ? 1 : 0;
  } catch {
    console.error("FAIL preflight: unable to read configuration, or invalid arguments. Usage: node scripts/preflight.mjs [--origin https://deck.example]");
    process.exitCode = 1;
  }
}
