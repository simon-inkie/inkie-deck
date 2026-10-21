import { describe, it, expect } from "vitest";
import { applicationServerKeyString, pushSyncState } from "~/lib/push-sync";

describe("push toggle sync decision", () => {
  it("shows off without a browser subscription", () => {
    expect(pushSyncState(false, false)).toBe("off");
    expect(pushSyncState(false, true)).toBe("off");
  });

  it("only shows on after the server confirms the subscription and key", () => {
    expect(pushSyncState(true, true)).toBe("subscribed");
  });

  it("offers re-enable when missing, mismatched or unavailable on the server", () => {
    expect(pushSyncState(true, false)).toBe("out-of-sync");
  });

  it("stays neutral when the status route could not be reached", () => {
    expect(pushSyncState(true, null)).toBe("off");
  });

  it("encodes the browser key as unpadded base64url", () => {
    expect(applicationServerKeyString(new Uint8Array([251, 255]).buffer)).toBe("-_8");
    expect(applicationServerKeyString(null)).toBeNull();
  });
});
