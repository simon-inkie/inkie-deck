import { describe, expect, it } from "vitest";
import {
  checkIdentity, checkRoot, checkStatePath, checkBriefs, checkPush,
  checkPort, checkVoiceOrigin, checkStart, isInside, parseListeningPorts,
} from "../scripts/preflight.mjs";

const access = { directory: true, readable: true, writable: true, searchable: true };

describe("production preflight decisions", () => {
  it("warns about the default identity and rejects users missing from the operator list", () => {
    expect(checkIdentity({}).status).toBe("WARN");
    expect(checkIdentity({ MC_USER: "alex", MC_OPERATOR_USERS: "quill" }).status).toBe("FAIL");
    expect(checkIdentity({ MC_USER: " alex ", MC_OPERATOR_USERS: "quill, alex" }).status).toBe("PASS");
  });

  it("requires absolute, existing roots with read/write/traversal access", () => {
    expect(checkRoot("DATA_ROOT", "", access).status).toBe("FAIL");
    expect(checkRoot("DATA_ROOT", "data", access).status).toBe("FAIL");
    expect(checkRoot("DATA_ROOT", "/srv/deck/data", { ...access, writable: false }).status).toBe("FAIL");
    expect(checkRoot("DATA_ROOT", "/srv/deck/data", { ...access, searchable: false }).status).toBe("FAIL");
    expect(checkRoot("DATA_ROOT", "/srv/deck/data", access).status).toBe("PASS");
  });

  it("requires explicit confined state paths and respects the realpath observation", () => {
    const facts = { inside: true, accessible: true };
    const check = (value: string, observed = facts) => checkStatePath("FILE_PINS_PATH", value, "/srv/deck/data", observed, "/srv/deck");
    expect(check("").status).toBe("FAIL");
    expect(check("data/file-pins.json").status).toBe("PASS");
    expect(check("data/../file-pins.json").status).toBe("FAIL");
    expect(check("data-other/file-pins.json").status).toBe("FAIL");
    expect(check("data/file-pins.json", { ...facts, inside: false }).status).toBe("FAIL");
    expect(check("data/file-pins.json", { ...facts, accessible: false }).status).toBe("FAIL");
    expect(isInside("/srv/deck/data", "/srv/deck/data")).toBe(false);
  });

  it("reports an absent briefs setting and rejects unsafe identifiers", () => {
    expect(checkBriefs({}).status).toBe("WARN");
    expect(checkBriefs({ MC_BRIEFS_AGENT: "quill" }).status).toBe("PASS");
    expect(checkBriefs({ MC_BRIEFS_AGENT: "../quill" }).status).toBe("FAIL");
  });

  it("requires both push files, matching keys, confinement and a valid store", () => {
    const facts = { keysPresent: true, storePresent: true, confined: true, validKeys: true, validStore: true, linked: true, mismatched: false };
    expect(checkPush(facts).status).toBe("PASS");
    expect(checkPush({ ...facts, keysPresent: false }).status).toBe("WARN");
    expect(checkPush({ ...facts, storePresent: false }).status).toBe("WARN");
    expect(checkPush({ ...facts, confined: false }).status).toBe("FAIL");
    expect(checkPush({ ...facts, validKeys: false }).status).toBe("FAIL");
    expect(checkPush({ ...facts, validStore: false }).status).toBe("FAIL");
    expect(checkPush({ ...facts, linked: false }).status).toBe("WARN");
    expect(checkPush({ ...facts, mismatched: true }).status).toBe("FAIL");
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

  it("rejects bare serving and recognises the production launcher", () => {
    expect(checkStart("react-router-serve ./build/server/index.js").status).toBe("FAIL");
    expect(checkStart("node scripts/start-production.mjs").status).toBe("PASS");
    expect(checkStart(undefined).status).toBe("FAIL");
  });

  it("never includes configured values in diagnostic output", () => {
    const secret = "private-value-never-print";
    const diagnostics = [
      checkIdentity({ MC_USER: secret, MC_OPERATOR_USERS: "alex" }),
      checkRoot("DATA_ROOT", secret, access),
      checkBriefs({ MC_BRIEFS_AGENT: secret }),
      checkPort("PORT", secret, []),
      checkVoiceOrigin({}, secret),
      checkStart(secret),
    ];
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
  });
});
