/**
 * voice-server.test.ts - voice.server.ts config helpers (issue #27).
 *
 * ASCII only - no em-dashes (FND-05).
 */

import { describe, it, expect } from "vitest";
import { getVoiceProxyUrl, getVoiceDisabledReason } from "~/lib/voice.server";

describe("getVoiceDisabledReason", () => {
  it("is null when voice is on: unset or blank", () => {
    expect(getVoiceDisabledReason({})).toBeNull();
    expect(getVoiceDisabledReason({ VOICE_DISABLED_REASON: "  " })).toBeNull();
  });

  it("passes the launcher's text through, trimmed", () => {
    expect(
      getVoiceDisabledReason({ VOICE_DISABLED_REASON: " voice disabled: no key " })
    ).toBe("voice disabled: no key");
  });
});

describe("getVoiceProxyUrl", () => {
  it("falls back to the local proxy and honours VOICE_PROXY_URL", () => {
    expect(getVoiceProxyUrl({})).toBe("ws://localhost:5176/voice");
    expect(getVoiceProxyUrl({ VOICE_PROXY_URL: "wss://deck.example/voice" })).toBe(
      "wss://deck.example/voice"
    );
  });
});
