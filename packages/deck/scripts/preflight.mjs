/** Read-only production checks. No listeners, child processes or file writes. */
import fs from "node:fs";
import path from "node:path";
import { createECDH } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolveAllowedOrigins } from "../server/voice-relay.mjs";

const result = (name, status, message) => ({ name, status, message });
const present = (value) => Boolean(value?.trim());
const ROOTS = ["INBOX_ROOT", "PROJECTS_ROOT", "ATTACHMENTS_ROOT", "DATA_ROOT"];

/** Pure decisions consume observations rather than touching the filesystem. */
export function checkIdentity(env) {
  if (!present(env.MC_USER)) return result("identity", "WARN", "MC_USER absent: the default identity is used. Set MC_USER and MC_OPERATOR_USERS explicitly.");
  const operators = (env.MC_OPERATOR_USERS ?? "").split(",").map((v) => v.trim());
  if (!operators.includes(env.MC_USER.trim())) return result("identity", "FAIL", "MC_USER is not listed in MC_OPERATOR_USERS.");
  return result("identity", "PASS", "MC_USER is present and listed in MC_OPERATOR_USERS.");
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

export function checkStatePath(name, value, dataRoot, facts, cwd) {
  if (!present(value)) return result(name, "FAIL", `${name} must be explicit; its default follows the working directory.`);
  if (!present(dataRoot) || !isInside(path.resolve(cwd, dataRoot), path.resolve(cwd, value)) || !facts?.inside) return result(name, "FAIL", `${name} must resolve inside DATA_ROOT, including symlinks.`);
  if (!facts.accessible) return result(name, "FAIL", `${name} or its parent is not readable/writable as needed.`);
  return result(name, "PASS", `${name} is explicit, confined to DATA_ROOT and accessible.`);
}

export function checkBriefs(env) {
  if (!present(env.MC_BRIEFS_AGENT)) return result("briefs", "WARN", "MC_BRIEFS_AGENT absent: the default briefs agent is used.");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(env.MC_BRIEFS_AGENT.trim())) return result("briefs", "FAIL", "MC_BRIEFS_AGENT is not a valid lowercase agent identifier.");
  return result("briefs", "PASS", "MC_BRIEFS_AGENT is present.");
}

export function checkPush(facts) {
  if (!facts.keysPresent || !facts.storePresent) return result("push", "WARN", "VAPID keypair and subscription store must both be present under DATA_ROOT; push is not ready. No files were created.");
  if (!facts.confined || !facts.validKeys || !facts.validStore || facts.mismatched) return result("push", "FAIL", "Push files must be confined to DATA_ROOT and contain a valid matching VAPID keypair and subscription store.");
  if (!facts.linked) return result("push", "WARN", "Push files are present and valid; stored subscriptions have no VAPID binding. Confirm browser/store/key synchronisation with the notification toggle.");
  return result("push", "PASS", "Push files are present, valid and bound to the current VAPID public key.");
}

export function checkPort(name, rawPort, occupied) {
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) return result(name, "FAIL", `${name} must be an integer between 1 and 65535.`);
  if (occupied === null) return result(name, "WARN", `${name} availability could not be inspected without opening a socket.`);
  if (occupied.includes(Number(rawPort))) return result(name, "FAIL", `${name} is already listening.`);
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

export function checkStart(command) {
  return /^(?:node\s+)?(?:\.\/)?scripts\/start-production\.mjs\s*$/.test(command ?? "")
    ? result("start script", "PASS", "The package start script uses the production launcher.")
    : result("start script", "FAIL", "The package start script must run node scripts/start-production.mjs; bare react-router-serve omits production sidecars and validation.");
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

function stateFacts(value, dataRoot, cwd) {
  if (!present(value) || !present(dataRoot)) return {};
  try {
    const target = path.resolve(cwd, value);
    const inside = isInside(fs.realpathSync(path.resolve(cwd, dataRoot)), resolvedTarget(target));
    const parent = path.dirname(target);
    const accessible = fs.existsSync(target)
      ? fs.statSync(target).isFile() && canAccess(target, fs.constants.R_OK | fs.constants.W_OK) && canAccess(parent, fs.constants.W_OK | fs.constants.X_OK)
      : canAccess(parent, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    return { inside, accessible };
  } catch { return {}; }
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

function pushFacts(dataRoot, cwd) {
  if (!present(dataRoot)) return {};
  const keyFile = path.resolve(cwd, dataRoot, "vapid-keys.json");
  const storeFile = path.resolve(cwd, dataRoot, "push-subscriptions.json");
  const facts = { keysPresent: fs.existsSync(keyFile), storePresent: fs.existsSync(storeFile) };
  try {
    facts.confined = [keyFile, storeFile].every((file) => stateFacts(file, dataRoot, cwd).inside);
    if (!facts.confined) return facts;
    const keys = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(keys.privateKey, "base64url"));
    facts.validKeys = ecdh.getPublicKey().equals(Buffer.from(keys.publicKey, "base64url"));
    const store = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    facts.validStore = store.version === 1 && Array.isArray(store.subscriptions) && store.subscriptions.every((sub) => {
      try { new URL(sub.endpoint); } catch { return false; }
      return typeof sub.keys?.p256dh === "string" && sub.keys.p256dh.length > 0 && typeof sub.keys?.auth === "string" && sub.keys.auth.length > 0 && typeof sub.addedAt === "string";
    });
    facts.mismatched = facts.validStore && store.subscriptions.some((sub) => sub.vapidPublicKey !== undefined && sub.vapidPublicKey !== keys.publicKey);
    facts.linked = facts.validStore && store.subscriptions.length > 0 && store.subscriptions.every((sub) => sub.vapidPublicKey === keys.publicKey);
  } catch { /* Presence and validity only; never disclose JSON or keys. */ }
  return facts;
}

/** CLI IO boundary: exactly the launcher's .env precedence, no .env.production. */
export function runPreflight({ cwd = process.cwd(), origin } = {}) {
  const envFile = path.join(cwd, ".env");
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;
  const checks = [checkIdentity(env), result("operator roles", "WARN", "MC_OPERATOR_USERS is a preflight declaration; runtime model/cron role checks currently use built-in identities.")];
  for (const name of ROOTS) checks.push(checkRoot(name, env[name], rootFacts(env[name] || "")));
  for (const name of ["QUEUE_STATE_PATH", "FILE_PINS_PATH"]) checks.push(checkStatePath(name, env[name], env.DATA_ROOT, stateFacts(env[name], env.DATA_ROOT, cwd), cwd));
  checks.push(checkBriefs(env), checkPush(pushFacts(env.DATA_ROOT, cwd)));
  let occupied = null;
  try { occupied = parseListeningPorts([fs.readFileSync("/proc/net/tcp", "utf8"), fs.readFileSync("/proc/net/tcp6", "utf8")]); } catch { /* Non-Linux or restricted procfs. */ }
  const port = env.PORT || "4242";
  const voicePort = env.VOICE_PROXY_PORT || "5176";
  checks.push(checkPort("PORT", port, occupied), checkPort("VOICE_PROXY_PORT", voicePort, occupied));
  if (Number(port) === Number(voicePort)) checks.push(result("port collision", "FAIL", "App and voice ports must differ."));
  checks.push(checkVoiceOrigin(env, origin ?? env.MC_BROWSER_ORIGIN));
  let command;
  try { command = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).scripts?.start; } catch { /* Report absence without exposing contents. */ }
  checks.push(checkStart(command));
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
