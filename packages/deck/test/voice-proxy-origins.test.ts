/**
 * voice-proxy-origins.test.ts - the default origin allowlist (issue #27).
 *
 * Two layers. The pure suite pins the computation in voice-relay.mjs, imported
 * as the .mjs because that is the copy the running proxy uses. The process
 * suite spawns the real server/voice-proxy.mjs with only PORT set (no
 * VOICE_ALLOWED_ORIGINS, no key) and asserts on which upgrades a real client
 * gets, since the wiring from the computation into verifyClient is what broke.
 *
 * ASCII only - no em-dashes (FND-05).
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  defaultAllowedOrigins,
  resolveAllowedOrigins,
  isOriginAllowed,
} from "../server/voice-relay.mjs";

const PROXY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "server",
  "voice-proxy.mjs"
);

describe("defaultAllowedOrigins", () => {
  it("is Deck's production port then the dev port when PORT is unset", () => {
    expect(defaultAllowedOrigins({})).toEqual([
      "http://localhost:4242",
      "http://localhost:5174",
    ]);
  });

  it("follows PORT", () => {
    expect(defaultAllowedOrigins({ PORT: "8080" })).toEqual([
      "http://localhost:8080",
      "http://localhost:5174",
    ]);
  });

  it("treats a blank or whitespace PORT as unset", () => {
    expect(defaultAllowedOrigins({ PORT: "" })[0]).toBe("http://localhost:4242");
    expect(defaultAllowedOrigins({ PORT: "  " })[0]).toBe("http://localhost:4242");
  });

  it("falls back to 4242 for a PORT that is not a number", () => {
    expect(defaultAllowedOrigins({ PORT: "abc" })[0]).toBe("http://localhost:4242");
  });

  it("does not list the dev port twice when PORT is 5174", () => {
    expect(defaultAllowedOrigins({ PORT: "5174" })).toEqual([
      "http://localhost:5174",
    ]);
  });

  it("accepts the production origin and rejects others", () => {
    const allowed = defaultAllowedOrigins({});
    expect(isOriginAllowed("http://localhost:4242", allowed)).toBe(true);
    expect(isOriginAllowed("http://localhost:5174", allowed)).toBe(true);
    expect(isOriginAllowed("http://localhost:4243", allowed)).toBe(false);
    expect(isOriginAllowed("https://evil.example", allowed)).toBe(false);
    expect(isOriginAllowed(undefined, allowed)).toBe(false);
  });
});

describe("resolveAllowedOrigins", () => {
  it("uses the defaults when VOICE_ALLOWED_ORIGINS is unset", () => {
    expect(resolveAllowedOrigins({ PORT: "4242" })).toEqual(
      defaultAllowedOrigins({ PORT: "4242" })
    );
  });

  it("falls back to the defaults when it is blank, not to an empty list", () => {
    expect(resolveAllowedOrigins({ VOICE_ALLOWED_ORIGINS: " , " })).toEqual(
      defaultAllowedOrigins({})
    );
  });

  it("strips trailing slashes from explicit origins", () => {
    expect(
      resolveAllowedOrigins({ VOICE_ALLOWED_ORIGINS: "http://host:4242/, https://x.example//" })
    ).toEqual(["http://host:4242", "https://x.example"]);
  });

  it("lets an explicit value replace the defaults, trimmed", () => {
    expect(
      resolveAllowedOrigins({
        PORT: "4242",
        VOICE_ALLOWED_ORIGINS: " https://deck.example.org , http://localhost:4242 ",
      })
    ).toEqual(["https://deck.example.org", "http://localhost:4242"]);
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

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

/** Resolves with the first frame, or the upgrade failure as a string. */
function attempt(port: number, origin: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/voice`, { origin });
    // A hung upgrade must fail this test quickly, not at the suite timeout.
    const timer = setTimeout(() => {
      ws.terminate();
      resolve("timeout");
    }, 5000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(data.toString("utf8"));
      ws.close();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      resolve(`error: ${err.message}`);
    });
  });
}

describe("voice-proxy process: default origins with only PORT set", () => {
  let child: ChildProcess | undefined;

  afterEach(async () => {
    const proc = child;
    child = undefined;
    if (proc && proc.exitCode === null) {
      const exited = new Promise<void>((r) => proc.once("exit", () => r()));
      proc.kill();
      await exited;
    }
  });

  it("accepts Deck's own origin and rejects an unlisted one", async () => {
    const port = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: "4242",
      VOICE_PROXY_PORT: String(port),
    };
    delete env["VOICE_ALLOWED_ORIGINS"];
    delete env["DEEPGRAM_API_KEY"];
    delete env["VOICE_PROXY_HOST"];
    // stderr is inherited so a proxy that fails to start says why in the log.
    child = spawn(process.execPath, [PROXY], {
      env,
      stdio: ["ignore", "ignore", "inherit"],
    });
    await waitForPort(port);

    expect(JSON.parse(await attempt(port, "http://localhost:4242"))).toEqual({
      type: "status",
      state: "no_key",
    });
    expect(await attempt(port, "http://localhost:4243")).toMatch(/^error: /);
  });
});
