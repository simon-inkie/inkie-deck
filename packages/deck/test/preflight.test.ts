import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkIdentity, checkRoot, checkStatePath, checkBriefs, checkPush,
  checkPort, checkVoiceOrigin, isInside, parseListeningPorts, pushFacts,
} from "../scripts/preflight.mjs";

const access = { directory: true, readable: true, writable: true, searchable: true };

describe("production preflight decisions", () => {
  it("warns about the default identity and passes when MC_USER is set", () => {
    expect(checkIdentity({}).status).toBe("WARN");
    expect(checkIdentity({ MC_USER: " alex " }).status).toBe("PASS");
  });

  it("requires absolute, existing roots with read/write/traversal access", () => {
    expect(checkRoot("DATA_ROOT", "", access).status).toBe("FAIL");
    expect(checkRoot("DATA_ROOT", "data", access).status).toBe("FAIL");
    expect(checkRoot("DATA_ROOT", "/srv/deck/data", { ...access, writable: false }).status).toBe("FAIL");
    expect(checkRoot("DATA_ROOT", "/srv/deck/data", { ...access, searchable: false }).status).toBe("FAIL");
    expect(checkRoot("DATA_ROOT", "/srv/deck/data", access).status).toBe("PASS");
  });

  it("warns when state paths are unset and fails only when a set path is inaccessible", () => {
    expect(checkStatePath("FILE_PINS_PATH", "", {}).status).toBe("WARN");
    expect(checkStatePath("FILE_PINS_PATH", undefined, {}).status).toBe("WARN");
    expect(checkStatePath("FILE_PINS_PATH", "/elsewhere/pins.json", { accessible: true }).status).toBe("PASS");
    expect(checkStatePath("FILE_PINS_PATH", "/elsewhere/pins.json", { accessible: false }).status).toBe("FAIL");
    expect(isInside("/srv/deck/data", "/srv/deck/data")).toBe(false);
  });

  it("reports an absent briefs setting and rejects unsafe identifiers", () => {
    expect(checkBriefs({}).status).toBe("WARN");
    expect(checkBriefs({ MC_BRIEFS_AGENT: "quill" }).status).toBe("PASS");
    expect(checkBriefs({ MC_BRIEFS_AGENT: "../quill" }).status).toBe("FAIL");
  });

  describe("push files", () => {
    const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "deck-preflight-"));
    const sub = { endpoint: "https://push.example.test/abc", keys: { p256dh: "p", auth: "a" }, addedAt: "2026-01-01T00:00:00Z" };
    const write = (dir: string, keys: unknown, store: unknown) => {
      if (keys !== undefined) fs.writeFileSync(path.join(dir, "vapid-keys.json"), typeof keys === "string" ? keys : JSON.stringify(keys));
      if (store !== undefined) fs.writeFileSync(path.join(dir, "push-subscriptions.json"), typeof store === "string" ? store : JSON.stringify(store));
    };
    const run = (dir: string) => checkPush(pushFacts(dir, dir));
    const goodKeys = { publicKey: "pub", privateKey: "priv" };

    it("warns when files are absent and writes nothing", () => {
      const dir = tmp();
      expect(run(dir).status).toBe("WARN");
      expect(fs.readdirSync(dir)).toEqual([]);
      write(dir, goodKeys, undefined);
      expect(run(dir).status).toBe("WARN");
    });

    it("warns honestly, with a count, when real files parse; never passes", () => {
      const dir = tmp();
      write(dir, goodKeys, { version: 1, subscriptions: [sub, { ...sub, endpoint: "https://push.example.test/def" }] });
      const check = run(dir);
      expect(check.status).toBe("WARN");
      expect(check.message).toContain("2 stored subscription(s)");
      expect(check.message).toContain("cannot be verified offline");
    });

    it("fails on unparsable or wrongly shaped files", () => {
      let dir = tmp();
      write(dir, "not json", { version: 1, subscriptions: [] });
      expect(run(dir).status).toBe("FAIL");
      dir = tmp();
      write(dir, goodKeys, { version: 2, subscriptions: [] });
      expect(run(dir).status).toBe("FAIL");
      dir = tmp();
      write(dir, goodKeys, { version: 1, subscriptions: [{ ...sub, endpoint: "nope" }] });
      expect(run(dir).status).toBe("FAIL");
    });

    it("fails when a file escapes DATA_ROOT through a symlink", () => {
      const dir = tmp();
      const outside = tmp();
      write(outside, goodKeys, { version: 1, subscriptions: [] });
      fs.symlinkSync(path.join(outside, "vapid-keys.json"), path.join(dir, "vapid-keys.json"));
      fs.symlinkSync(path.join(outside, "push-subscriptions.json"), path.join(dir, "push-subscriptions.json"));
      expect(run(dir).status).toBe("FAIL");
    });
  });

  it("checks listener snapshots and validates port numbers", () => {
    const tables = ["sl local_address rem_address st\n0: 0100007F:1092 00000000:0000 0A\n1: 0100007F:1438 00000000:0000 01\n"];
    expect(parseListeningPorts(tables)).toEqual([4242]);
    expect(checkPort("PORT", "4242", [4242]).status).toBe("FAIL");
    expect(checkPort("PORT", "5176", [4242]).status).toBe("PASS");
    expect(checkPort("PORT", "4242", null).status).toBe("WARN");
    for (const value of ["0", "65536", "4242junk", "-1", ""]) expect(checkPort("PORT", value, []).status).toBe("FAIL");
  });

  it("compares the configured browser origin with the runtime voice allowlist", () => {
    expect(checkVoiceOrigin({}, undefined).status).toBe("WARN");
    expect(checkVoiceOrigin({}, "http://localhost:4242").status).toBe("PASS");
    expect(checkVoiceOrigin({ PORT: "4343" }, "http://localhost:4343").status).toBe("PASS");
    expect(checkVoiceOrigin({}, "https://deck.example.test").status).toBe("FAIL");
    expect(checkVoiceOrigin({ VOICE_ALLOWED_ORIGINS: "https://deck.example.test/" }, "https://deck.example.test").status).toBe("PASS");
    expect(checkVoiceOrigin({}, "http://localhost:4242/path").status).toBe("FAIL");
    expect(checkVoiceOrigin({}, "invalid").status).toBe("FAIL");
  });

  it("never includes configured values in diagnostic output", () => {
    const secret = "private-value-never-print";
    const diagnostics = [
      checkIdentity({ MC_USER: secret }),
      checkRoot("DATA_ROOT", secret, access),
      checkBriefs({ MC_BRIEFS_AGENT: secret }),
      checkPort("PORT", secret, []),
      checkVoiceOrigin({}, secret),
    ];
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
  });
});
