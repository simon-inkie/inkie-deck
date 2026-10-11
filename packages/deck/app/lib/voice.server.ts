/**
 * voice.server.ts - Seam module for voice proxy configuration.
 *
 * Reads VOICE_PROXY_URL from the server environment and provides it to
 * loaders. Components never read env directly (FND-02); they receive
 * voiceProxyUrl via loader data.
 *
 * The .server suffix keeps this module out of the client bundle.
 * ASCII only - no em-dashes (FND-05).
 */

/**
 * Returns the WebSocket URL for the local voice proxy.
 * Falls back to ws://localhost:5176/voice when VOICE_PROXY_URL is unset.
 */
export function getVoiceProxyUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env["VOICE_PROXY_URL"] ?? "ws://localhost:5176/voice";
}

/**
 * Why the mic is disabled, or null when voice is on (issue #27).
 *
 * This module is under app/, where the speech key's name is banned
 * (test/seam.test.ts), so the app never looks at the key. The launchers, which
 * live outside app/ and hand the proxy its key, set VOICE_DISABLED_REASON for
 * the app server when there is none, and the loader passes it on as display
 * text. Unset or blank means voice is on, so a start that bypasses the
 * launchers behaves as it did before.
 */
export function getVoiceDisabledReason(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const reason = (env["VOICE_DISABLED_REASON"] ?? "").trim();
  return reason === "" ? null : reason;
}
