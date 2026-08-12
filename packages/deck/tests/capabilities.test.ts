/**
 * The capability-absence suite.
 *
 * This is the mechanical form of the promise in src/capabilities.ts: with no
 * hosted service configured, the client works in a reduced way rather than
 * breaking. CI runs this on every push, so "the open client needs our hosted
 * service" can never land silently.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_NAMES,
  countUnread,
  resolveCapabilities,
  resolveCapability,
  withCapability,
} from "../src/index.ts";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Absence is a supported state
// ---------------------------------------------------------------------------
describe("capability absence", () => {
  it("resolves every capability to absent in an empty environment", () => {
    // An explicit empty env, not a stripped copy of process.env: the
    // zero-config state must be constructible with nothing at all.
    const resolved = resolveCapabilities({});
    for (const name of CAPABILITY_NAMES) {
      const capability = resolved[name];
      expect(capability.status, `${name} must be absent with no config`).toBe("absent");
    }
  });

  it("never throws, whatever the environment holds", () => {
    for (const env of [{}, { UNRELATED: "x" }, { DECK_BACKUP_SYNC_URL: "   " }]) {
      expect(() => resolveCapabilities(env)).not.toThrow();
    }
  });

  it("treats a whitespace-only endpoint as absent, not as configured", () => {
    const capability = resolveCapability("pushRelay", { DECK_PUSH_RELAY_URL: "  " });
    expect(capability.status).toBe("absent");
  });

  it("gives an absent capability a human reason naming the env var", () => {
    const capability = resolveCapability("speechToText", {});
    expect(capability.status).toBe("absent");
    if (capability.status === "absent") {
      expect(capability.reason).toContain("DECK_SPEECH_TO_TEXT_URL");
      expect(capability.reason).toContain("supported state");
    }
  });

  it("degrades a client flow through withCapability instead of failing it", () => {
    // A stand-in for the real client path: with the capability absent the
    // flow completes and yields its reduced result, it does not throw and
    // it does not return an error-shaped value the caller must inspect.
    const capability = resolveCapability("backupSync", {});
    const outcome = withCapability(
      capability,
      () => "backed up remotely",
      "kept locally only",
    );
    expect(outcome).toBe("kept locally only");
  });
});

// ---------------------------------------------------------------------------
// Configuration is always the user's
// ---------------------------------------------------------------------------
describe("capability configuration", () => {
  it("configures from the user's own endpoint and credential", () => {
    const capability = resolveCapability("backupSync", {
      DECK_BACKUP_SYNC_URL: "https://backup.example.test/api",
      DECK_BACKUP_SYNC_TOKEN: "user-supplied-token",
    });
    expect(capability.status).toBe("configured");
    if (capability.status === "configured") {
      expect(capability.endpoint).toBe("https://backup.example.test/api");
      expect(capability.credential).toBe("user-supplied-token");
    }
  });

  it("allows an endpoint with no credential, for private self-hosted services", () => {
    const capability = resolveCapability("pushRelay", {
      DECK_PUSH_RELAY_URL: "http://relay.internal.example.test:9000",
    });
    expect(capability.status).toBe("configured");
    if (capability.status === "configured") {
      expect(capability.credential).toBeNull();
    }
  });

  it("hands a configured capability to the configured branch", () => {
    const capability = resolveCapability("speechToText", {
      DECK_SPEECH_TO_TEXT_URL: "https://stt.example.test",
    });
    const outcome = withCapability(capability, (c) => `calling ${c.endpoint}`, "disabled");
    expect(outcome).toBe("calling https://stt.example.test");
  });

  it("ships no default endpoint in the source", () => {
    // Same idiom as base's "no hardcoded sibling-project path" test: read
    // the source and assert the absence. Any URL literal in src/ would be a
    // welded-in endpoint of ours, which the seam exists to forbid. Test
    // fixtures above use .example.test hosts and live outside src/.
    const srcDir = path.join(PACKAGE_ROOT, "src");
    for (const entry of fs.readdirSync(srcDir, { recursive: true, encoding: "utf8" })) {
      const filePath = path.join(srcDir, entry);
      if (!fs.statSync(filePath).isFile()) {
        continue;
      }
      const text = fs.readFileSync(filePath, "utf8");
      expect(text, `found a hardcoded URL in ${entry}`).not.toMatch(/https?:\/\//);
    }
  });
});

// ---------------------------------------------------------------------------
// The workspace edge to inkie-agents-base
// ---------------------------------------------------------------------------
describe("protocol package edge", () => {
  it("consumes the protocol package through its entry point", () => {
    const thread =
      "\n## 2026-08-12T09:00:00Z - from: courier - status: sent - subject: one\n\nbody one\n" +
      "\n## 2026-08-12T09:05:00Z - from: courier - status: read - subject: two\n\nbody two\n";
    expect(countUnread(thread)).toBe(1);
  });
});
