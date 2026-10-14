/**
 * scripts/voice-env.mjs - the app-server environment for voice.
 *
 * Shared by dev.mjs and start-production.mjs so the text and the rule cannot
 * drift between them. The app never reads the speech key itself (its name is
 * banned from app/ by test/seam.test.ts); these launchers, which hand the proxy
 * its key, say why the mic is off instead. See getVoiceDisabledReason in
 * app/lib/voice.server.ts.
 *
 * ASCII only - no em-dashes.
 */

export const VOICE_DISABLED_NO_KEY = "voice disabled: no DEEPGRAM_API_KEY";

/**
 * Copy of `env` for the app server: VOICE_DISABLED_REASON is set when there is
 * no key and removed otherwise, so a stale value cannot disable a working mic.
 * The caller passes the same object the voice proxy's environment comes from.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function withVoiceDisabledReason(env) {
  const out = { ...env };
  delete out["VOICE_DISABLED_REASON"];
  if (!out["DEEPGRAM_API_KEY"]) {
    out["VOICE_DISABLED_REASON"] = VOICE_DISABLED_NO_KEY;
  }
  return out;
}
