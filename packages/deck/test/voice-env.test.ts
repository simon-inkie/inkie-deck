/**
 * voice-env.test.ts - the launchers' VOICE_DISABLED_REASON rule.
 *
 * ASCII only - no em-dashes.
 */

import { describe, it, expect } from "vitest";
import {
  withVoiceDisabledReason,
  VOICE_DISABLED_NO_KEY,
} from "../scripts/voice-env.mjs";

describe("withVoiceDisabledReason", () => {
  it("sets the reason when there is no key", () => {
    expect(withVoiceDisabledReason({ PORT: "4242" })).toEqual({
      PORT: "4242",
      VOICE_DISABLED_REASON: VOICE_DISABLED_NO_KEY,
    });
    expect(VOICE_DISABLED_NO_KEY).toBe("voice disabled: no DEEPGRAM_API_KEY");
  });

  it("treats an empty key as no key", () => {
    expect(withVoiceDisabledReason({ DEEPGRAM_API_KEY: "" })["VOICE_DISABLED_REASON"]).toBe(
      VOICE_DISABLED_NO_KEY
    );
  });

  it("removes a stale reason when a key is present, and keeps the key", () => {
    const out = withVoiceDisabledReason({
      DEEPGRAM_API_KEY: "dg_test",
      VOICE_DISABLED_REASON: "stale",
    });
    expect(out["VOICE_DISABLED_REASON"]).toBeUndefined();
    expect(out["DEEPGRAM_API_KEY"]).toBe("dg_test");
  });

  it("does not mutate its input", () => {
    const input = { VOICE_DISABLED_REASON: "x" };
    withVoiceDisabledReason(input);
    expect(input).toEqual({ VOICE_DISABLED_REASON: "x" });
  });
});
