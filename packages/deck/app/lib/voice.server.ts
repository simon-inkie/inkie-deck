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
