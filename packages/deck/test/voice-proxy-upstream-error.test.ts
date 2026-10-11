/**
 * voice-proxy-upstream-error.test.ts - the client RECEIVES the diagnostic.
 *
 * Every other voice test in this repo is a pure-function test. This one spawns
 * the real server/voice-proxy.mjs as a child process, points it at a local
 * server that rejects the WebSocket upgrade, and asserts on what arrives at a
 * real client socket.
 *
 * WHY IT HAS TO WORK THIS WAY. The bug being pinned was an ORDERING bug: the
 * error handler closed the client before sending, and ws drops a send on a
 * CLOSING socket internally without throwing. No shape test on statusFrame can
 * see that, because statusFrame was always correct. The only thing that
 * distinguishes fixed from broken is whether a frame reaches the client, so
 * that is what is asserted, rather than the mechanism by which it used to fail.
 *
 * SCOPE, deliberately narrow. This covers the REJECTED-UPGRADE path only, which
 * is the branch of ws abortHandshake that has actually been walked
 * (websocket.js:1102 -> emitErrorAndClose at :1053, emits "error" then
 * "close"). The second branch at :1122, via stream.destroy(err), is NOT covered
 * here and nobody has walked it. Naming that is the point: this test does not
 * claim to cover upstream failure in general.
 *
 * ASCII only - no em-dashes.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROXY = path.join(REPO_ROOT, "server", "voice-proxy.mjs");

// A key-shaped string that must never appear downstream.
const FAKE_KEY = "dg_sk_AAABBBCCC999FakeKeyForTestingOnly";
const ALLOWED_ORIGIN = "http://localhost:5174";

/**
 * Reserve two DISTINCT free ports.
 *
 * Reserved together, not one at a time: a helper that binds :0, closes, and
 * returns can hand back the SAME port twice in a row, because the first is free
 * again by the time the second call asks. Both listeners are held open until
 * both ports are chosen, so the OS cannot reissue one. The equality check at
 * the end is belt and braces, and fails loudly rather than producing a
 * confusing bind clash later.
 */
async function freePortPair(): Promise<[number, number]> {
  const servers: net.Server[] = [];
  const ports: number[] = [];
  for (let i = 0; i < 2; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        servers.push(srv);
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    ports.push(port);
  }
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  const [a, b] = ports;
  if (a === undefined || b === undefined || a === b) {
    throw new Error(`could not reserve two distinct ports (got ${ports.join(", ")})`);
  }
  return [a, b];
}

/** Poll until something is actually accepting TCP on the port. */
async function waitForPort(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`nothing listening on ${port}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** An upstream that always rejects the WebSocket upgrade with a 400. */
function rejectingUpstream(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer((_req, res) => {
      res.writeHead(400);
      res.end();
    });
    srv.on("upgrade", (_req, socket) => {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

async function startProxy(
  env: NodeJS.ProcessEnv,
  port: number
): Promise<ChildProcess> {
  const child = spawn(process.execPath, [PROXY], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // A spawn failure (missing binary, EACCES) must reject THIS promise, not
  // throw from inside an event callback: a throw there escapes startProxy's
  // async flow entirely and would crash the Vitest worker with an uncaught
  // exception instead of failing the one test with a clear assertion.
  const spawnFailure = new Promise<never>((_, reject) => {
    child.once("error", reject);
  });

  // Readiness is "the port accepts a connection", NOT "the process logged that
  // it is listening".
  //
  // That distinction had teeth: voice-proxy.mjs used to print its listening
  // line unconditionally right after constructing the WebSocketServer, so the
  // line appeared even when the bind then failed and nothing was being served.
  // Waiting on it produced a green readiness check followed by ECONNREFUSED.
  //
  // The proxy now emits that line from a "listening" event, so the log is
  // trustworthy again. Still polling the port rather than reverting to the log,
  // for two reasons: it asserts the fact instead of a report of the fact, and
  // it does not couple this test to the wording of a console.log.
  await Promise.race([waitForPort(port), spawnFailure]);
  spawnFailure.catch(() => {}); // avoid an unhandled rejection once the race is settled
  return child;
}

let proxy: ChildProcess | null = null;
let upstream: Server | null = null;

afterEach(async () => {
  proxy?.kill("SIGKILL");
  proxy = null;
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = null;
});

/**
 * Reserve ports, start the rejecting upstream and the real proxy, open a
 * client against it, and collect every frame the client receives until
 * "close"/"error" or an 8s timeout. Shared by both tests below - they differ
 * only in which frames they assert on, not in how the client is wired up.
 */
async function setupRejectedUpgrade(): Promise<{
  frames: Array<Record<string, unknown>>;
}> {
  const [upstreamPort, proxyPort] = await freePortPair();
  upstream = await rejectingUpstream(upstreamPort);

  proxy = await startProxy(
    {
      VOICE_PROXY_PORT: String(proxyPort),
      VOICE_PROXY_HOST: "127.0.0.1",
      VOICE_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      DEEPGRAM_API_KEY: FAKE_KEY,
      DEEPGRAM_URL_BASE: `ws://127.0.0.1:${upstreamPort}/listen`,
    },
    proxyPort
  );

  const frames: Array<Record<string, unknown>> = [];
  const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/voice`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });

  await new Promise<void>((resolve) => {
    const done = setTimeout(resolve, 8000);
    client.on("message", (raw: Buffer) => {
      try {
        frames.push(JSON.parse(raw.toString()));
      } catch {
        // non-JSON is a failure of a different kind; the assertions below catch it
      }
    });
    client.on("close", () => {
      clearTimeout(done);
      resolve();
    });
    client.on("error", () => {
      clearTimeout(done);
      resolve();
    });
  });

  // Neither caller needs the socket itself, only the frames it received. If
  // the promise above settled via the 8s timeout branch (not close/error),
  // the socket would otherwise be left open with no explicit teardown -
  // afterEach only kills the proxy process, not this client.
  client.terminate();
  return { frames };
}

describe("voice-proxy: rejected upstream upgrade reaches the client", () => {
  it("sends upstream_error carrying the cause, and never the key", async () => {
    const { frames } = await setupRejectedUpgrade();
    const states = frames.map((f) => f["state"]);

    // THE ASSERTION THAT MATTERS: the diagnostic actually arrived.
    expect(states).toContain("upstream_error");

    const errFrame = frames.find((f) => f["state"] === "upstream_error");
    expect(errFrame?.["type"]).toBe("status");
    // err.message on a rejected upgrade reads "Unexpected server response: 400".
    expect(String(errFrame?.["detail"] ?? "")).toContain("400");

    // KEY-NEVER-DOWNSTREAM, asserted rather than reasoned about. The key travels
    // in the Authorization header, so making the base injectable cannot move it
    // into a query string, but that is a claim worth a test.
    expect(JSON.stringify(frames)).not.toContain(FAKE_KEY);
  }, 30000);

  it("still reports upstream_connecting first, so the fix did not reorder the happy path", async () => {
    const { frames } = await setupRejectedUpgrade();
    const states = frames.map((f) => f["state"]);

    expect(states[0]).toBe("upstream_connecting");
    expect(states).toContain("upstream_error");
  }, 30000);
});

// ---------------------------------------------------------------------------
// Suite: a proxy that cannot bind must not claim to be listening
//
// The old code printed its listening line unconditionally right after the
// WebSocketServer constructor, so it announced success and then died on an
// unhandled EADDRINUSE. Anything downstream reading that line (a test, a
// supervisor, a person) was reading a claim rather than a fact.
// ---------------------------------------------------------------------------

describe("voice-proxy: bind failure", () => {
  it("exits non-zero and never claims to be listening when the port is taken", async () => {
    const [takenPort] = await freePortPair();

    // Occupy the port first, so the proxy's bind is guaranteed to fail.
    const squatter = net.createServer();
    await new Promise<void>((r) => squatter.listen(takenPort, "127.0.0.1", () => r()));

    try {
      const child = spawn(process.execPath, [PROXY], {
        env: {
          ...process.env,
          VOICE_PROXY_PORT: String(takenPort),
          VOICE_PROXY_HOST: "127.0.0.1",
          DEEPGRAM_API_KEY: FAKE_KEY,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()));
      child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));

      const code = await new Promise<number | null>((resolve) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(null);
        }, 10000);
        child.once("exit", (c) => {
          clearTimeout(t);
          resolve(c);
        });
      });

      // Serving nothing must be visible as a dead process, not a live one.
      expect(code).not.toBe(0);
      expect(code).not.toBeNull();

      // THE ASSERTION THAT MATTERS: it did not announce a success that did not
      // happen. Exit code alone cannot distinguish the fix from the old
      // behaviour, because an unhandled EventEmitter "error" also exits
      // non-zero. The difference is that the old one said "listening" first.
      expect(stdout).not.toContain("listening on");

      // And it says what went wrong, with the address it could not have.
      expect(stderr).toContain("failed to bind");
      expect(stderr).toContain(String(takenPort));
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  }, 30000);
});
