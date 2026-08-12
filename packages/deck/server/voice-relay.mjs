/**
 * server/voice-relay.mjs - Pure Deepgram message mapping logic.
 *
 * Factored out of voice-proxy.mjs so it can be unit-tested without real sockets.
 *
 * Exports:
 *   mapUpstreamMessage(rawJson) -> {type, text} | null
 *     Maps a Deepgram transcript message to a client-bound message.
 *     Returns null for non-transcript events (metadata, speech_started, etc.)
 *
 *   noKeyHandshake() -> {type: "status", state: "no_key"}
 *     Shape sent to client when DEEPGRAM_API_KEY is absent.
 *
 *   makeFrameBuffer(maxFrames, maxBytes) -> FrameBuffer
 *     Pure helper for buffering binary audio frames while upstream is CONNECTING.
 *     Bounds: 200 frames or 2MB. Never drops oldest (drop-oldest is the bug).
 *     push(frame) -> "ok" | "overflow"
 *     flush() -> frame[]
 *
 *   statusFrame(state) -> {type: "status", state}
 *     Build a status frame for any of the upstream lifecycle states.
 *
 * KEY INVARIANT: this module never receives or handles the API key.
 * The proxy holds the key; this module handles only message shapes.
 *
 * ASCII only - no em-dashes (FND-05).
 */

/**
 * Map a raw Deepgram upstream message string to a client-bound message object.
 *
 * Deepgram sends JSON text frames. The transcript shape is:
 *   { type: "Results", channel: { alternatives: [{transcript: "..."}] },
 *     is_final: boolean, speech_final: boolean }
 *
 * We emit:
 *   {type: "interim", text: "..."} for is_final=false Results with non-empty text
 *   {type: "final",   text: "..."} for is_final=true  Results with non-empty text
 *   null for everything else (metadata, UtteranceEnd, SpeechStarted, etc.)
 *
 * @param {string} rawJson - Raw text frame from Deepgram
 * @returns {{type: "interim"|"final", text: string} | null}
 */
export function mapUpstreamMessage(rawJson) {
  let msg;
  try {
    msg = JSON.parse(rawJson);
  } catch {
    return null;
  }

  if (!msg || msg.type !== "Results") return null;

  const alternatives = msg.channel?.alternatives;
  if (!Array.isArray(alternatives) || alternatives.length === 0) return null;

  // A non-string transcript (CR finding, 2026-07-28) must be rejected, not
  // forwarded: mirrors the typeof guard in voice-relay.ts so both copies agree
  // on a malformed/adversarial upstream, not just on a well-formed one.
  const transcript = alternatives[0]?.transcript;
  const text = typeof transcript === "string" ? transcript : "";
  if (!text) return null;

  const type = msg.is_final ? "final" : "interim";
  return { type, text };
}

/**
 * The message sent to a client when DEEPGRAM_API_KEY is not configured.
 *
 * @returns {{type: "status", state: "no_key"}}
 */
export function noKeyHandshake() {
  return { type: "status", state: "no_key" };
}

/**
 * Origin allowlist check for the WS upgrade (peer-review fold, Atlas TASK-433).
 * Browsers do not apply same-origin policy to WebSocket connects; absent or
 * non-matching Origin must reject the upgrade before any upstream connect.
 *
 * @param {unknown} origin - The Origin header value from the upgrade request.
 * @param {string[]} allowed - Allowed origin strings (exact match).
 * @returns {boolean}
 */
export function isOriginAllowed(origin, allowed) {
  return typeof origin === "string" && Array.isArray(allowed) && allowed.includes(origin);
}

// ---------------------------------------------------------------------------
// makeFrameBuffer - pure buffer helper for CONNECTING-phase audio frames.
// (TASK-433 reopened: the primary bug is that frames sent before upstream open
//  are silently dropped, losing the webm EBML container header in chunk 1.)
//
// Bounds: 200 frames OR 2MB total byte count, whichever is hit first.
// NEVER drop-oldest: dropping frame 1 IS the bug. On overflow, the caller
// must close both sockets after sending a status overflow frame.
//
// All state is local to the returned object; no globals; fully unit-testable.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_FRAMES = 200;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2MB

/**
 * Create a new frame buffer.
 *
 * @param {number} [maxFrames=200]  - Maximum number of frames to hold.
 * @param {number} [maxBytes=2MB]   - Maximum total byte count before overflow.
 * @returns {{ push: (frame: Buffer|Uint8Array) => "ok"|"overflow", flush: () => Array<Buffer|Uint8Array>, byteCount: () => number, frameCount: () => number }}
 */
export function makeFrameBuffer(maxFrames = DEFAULT_MAX_FRAMES, maxBytes = DEFAULT_MAX_BYTES) {
  /** @type {Array<Buffer|Uint8Array>} */
  const queue = [];
  let totalBytes = 0;

  return {
    /**
     * Push a binary frame onto the buffer.
     *
     * @param {Buffer|Uint8Array} frame
     * @returns {"ok"|"overflow"}
     */
    push(frame) {
      if (queue.length >= maxFrames || totalBytes + frame.byteLength > maxBytes) {
        return "overflow";
      }
      queue.push(frame);
      totalBytes += frame.byteLength;
      return "ok";
    },

    /**
     * Return all buffered frames in order and clear the buffer.
     *
     * @returns {Array<Buffer|Uint8Array>}
     */
    flush() {
      const frames = queue.splice(0, queue.length);
      totalBytes = 0;
      return frames;
    },

    /** @returns {number} */
    byteCount() {
      return totalBytes;
    },

    /** @returns {number} */
    frameCount() {
      return queue.length;
    },
  };
}

// ---------------------------------------------------------------------------
// statusFrame - build upstream lifecycle status frames.
// ---------------------------------------------------------------------------

/**
 * Build a status frame for downstream client delivery.
 *
 * Valid states:
 *   "no_key"              - no DEEPGRAM_API_KEY configured
 *   "upstream_connecting" - proxy has opened a WebSocket to Deepgram; waiting
 *   "upstream_open"       - upstream handshake complete; audio flowing
 *   "upstream_closed"     - upstream WebSocket closed (normal or error)
 *   "upstream_error"      - upstream socket errored; `detail` carries the cause
 *   "overflow"            - buffer hit the frame/byte bound; connection closing
 *
 * `detail` is optional free text for the debug panel. It is OMITTED rather than
 * set to undefined when absent, so frames for every pre-existing state
 * serialise byte-identically to before.
 *
 * Do NOT put anything key-derived in `detail`. The KEY-NEVER-DOWNSTREAM test
 * covers this file; the caller is responsible for what it passes.
 *
 * KEEP IN SYNC with voice-relay.ts. These are two hand-maintained copies (see
 * that file's header) and voice-proxy.mjs imports THIS one at runtime while the
 * unit tests import the .ts. test/voice-relay.test.ts now asserts both copies
 * agree on statusFrame, so a one-sided edit here fails the suite.
 *
 * @param {"no_key"|"upstream_connecting"|"upstream_open"|"upstream_closed"|"upstream_error"|"overflow"} state
 * @param {string} [detail]
 * @returns {{type: "status", state: string, detail?: string}}
 */
export function statusFrame(state, detail) {
  return detail === undefined
    ? { type: "status", state }
    : { type: "status", state, detail };
}

// ---------------------------------------------------------------------------
// buildDeepgramUrlQuery - the streaming WS query string, with keyterms.
// ---------------------------------------------------------------------------

/**
 * The demo roster plus the product terms, as the default keyterm list.
 *
 * Keyterm prompting was measured 2026-07-28 against real dictation: a roster
 * name transcribed as a common English near-neighbour mid-sentence on the
 * untouched config, a keyterm entry for it fixed that directly, and
 * smart_format/language variants did not, ruling both out as the cause.
 *
 * Risk criterion (an entry is risky iff it has a plausible English neighbour
 * ordinary speech would produce): Quill, Sprout, Forge and Mux do; Atlas,
 * Scribe, Summit, Deepgram, Inkie, Linkie, Briar, Echo, Nova and Robin do
 * not. The risky half is inference from that negative result (keyterm reranks
 * acoustically plausible candidates only), not separately proven per entry.
 *
 * This is a DEFAULT, not a policy: it exists so the bundled demo dictates
 * sensibly out of the box. Set DEEPGRAM_KEYTERMS to override it with your own
 * roster. Nothing here needs to be the names your agents actually use.
 *
 * @type {readonly string[]}
 */
export const DEFAULT_KEYTERMS = [
  "Quill", "Sprout", "Forge", "Mux",
  "Atlas", "Scribe", "Summit", "Deepgram", "Inkie", "Linkie",
  "Briar", "Echo", "Nova", "Robin",
];

/**
 * Find-and-replace pairs, layered on top of the keyterm prompting above.
 *
 * "Inkie" is already in DEFAULT_KEYTERMS, but the user reported it still
 * coming out wrong live. keyterm is a probabilistic rerank of acoustically
 * plausible candidates, not a guarantee, and "Inkie" has a very close, very
 * common real-word neighbour ("inky") that the rerank does not reliably beat.
 * `replace` is a literal, deterministic substitution on the transcript
 * output, not a rerank, so it is a harder guarantee layered on top of the
 * keyterm boost rather than a substitute for it.
 *
 * ASSUMPTION, NOT MEASURED: unlike the keyterm measurement above, this has not been
 * independently verified against a real sample of Alex's audio - there is
 * no confirmed transcript yet showing "inky" is the actual wrong output.
 * "inky" is simply the most probable candidate (a real, common word one
 * phoneme off from "Inkie"). Revisit if a real sample surfaces a different
 * wrong word.
 *
 * @typedef {{find: string, replace: string}} DeepgramReplacement
 * @type {readonly DeepgramReplacement[]}
 */
export const DEFAULT_REPLACEMENTS = [
  { find: "inky", replace: "Inkie" },
];

/**
 * Build the Deepgram streaming WS query string (model/language/keyterms/replacements).
 * Does NOT include the host, path or API key - those stay proxy-side.
 *
 * Deepgram wants REPEATED `keyterm=` params, not a comma-joined value -
 * confirmed empirically against the streaming endpoint specifically. The cap
 * is deliberately not enforced here: see the DEFAULT_KEYTERMS comment and
 * voice-proxy.mjs for why validating a term COUNT would go stale rather than
 * predictively guarding the input.
 *
 * `replace` pairs use the same repeated-param convention (one `&replace=`
 * per pair, confirmed in Deepgram's docs for this endpoint). Each pair is
 * `find:replacement` with a LITERAL colon separator - the find and
 * replacement sides are percent-encoded separately and then joined with
 * `:`. Encoding the whole "find:replacement" string as one unit would turn
 * the colon into %3A and Deepgram would not parse it as a pair.
 *
 * @param {{model: string, language: string, keyterms: readonly string[], replacements: readonly DeepgramReplacement[]}} opts
 * @returns {string}
 */
export function buildDeepgramUrlQuery(opts) {
  const params = new URLSearchParams();
  params.set("model", opts.model);
  params.set("language", opts.language);
  params.set("smart_format", "true");
  params.set("punctuate", "true");
  params.set("interim_results", "true");
  let query = params.toString();
  for (const term of opts.keyterms) {
    query += `&keyterm=${encodeURIComponent(term)}`;
  }
  for (const r of opts.replacements) {
    query += `&replace=${encodeURIComponent(r.find)}:${encodeURIComponent(r.replace)}`;
  }
  return query;
}
