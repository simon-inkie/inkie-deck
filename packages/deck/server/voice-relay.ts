/**
 * server/voice-relay.ts - Pure Deepgram message mapping logic (TypeScript).
 *
 * Factored out of voice-proxy.mjs so it can be unit-tested without real sockets.
 * voice-proxy.mjs contains its own copy of this logic (identical semantics)
 * because plain .mjs files cannot import .ts files without a loader.
 *
 * Exports:
 *   mapUpstreamMessage(rawJson) -> ClientMessage | null
 *     Maps a Deepgram transcript message to a client-bound message.
 *     Returns null for non-transcript events (metadata, speech_started, etc.)
 *
 *   noKeyHandshake() -> StatusMessage
 *     Shape sent to client when DEEPGRAM_API_KEY is absent.
 *
 *   makeFrameBuffer(maxFrames?, maxBytes?) -> FrameBuffer
 *     Pure helper for buffering binary audio frames while upstream is CONNECTING.
 *     Never drops oldest (drop-oldest is the bug). On overflow returns "overflow".
 *
 *   statusFrame(state) -> StatusMessage
 *     Build a status frame for any upstream lifecycle state.
 *
 * KEY INVARIANT: this module never receives or handles the API key.
 * The proxy holds the key; this module handles only message shapes.
 *
 * ASCII only - no em-dashes.
 */

export type ClientMessage =
  | { type: "interim"; text: string }
  | { type: "final"; text: string };

export type UpstreamState =
  | "no_key"
  | "upstream_connecting"
  | "upstream_open"
  | "upstream_closed"
  | "upstream_error"
  | "overflow";

export type StatusMessage = {
  type: "status";
  state: UpstreamState;
  detail?: string;
};

export interface FrameBuffer {
  push(frame: Buffer | Uint8Array): "ok" | "overflow";
  flush(): Array<Buffer | Uint8Array>;
  byteCount(): number;
  frameCount(): number;
}

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
 */
export function mapUpstreamMessage(rawJson: string): ClientMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(rawJson);
  } catch {
    return null;
  }

  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;

  if (m["type"] !== "Results") return null;

  const channel = m["channel"];
  if (!channel || typeof channel !== "object") return null;
  const c = channel as Record<string, unknown>;

  const alternatives = c["alternatives"];
  if (!Array.isArray(alternatives) || alternatives.length === 0) return null;

  const first = alternatives[0] as Record<string, unknown> | undefined;
  const text = typeof first?.["transcript"] === "string" ? first["transcript"] : "";
  if (!text) return null;

  const type = m["is_final"] ? "final" : "interim";
  return { type, text } as ClientMessage;
}

/**
 * The message sent to a client when DEEPGRAM_API_KEY is not configured.
 */
export function noKeyHandshake(): StatusMessage {
  return { type: "status", state: "no_key" };
}

/**
 * Origin allowlist check for the WS upgrade.
 * Browsers do not apply same-origin policy to WebSocket connects; absent or
 * non-matching Origin must reject the upgrade before any upstream connect.
 */
export function isOriginAllowed(origin: unknown, allowed: string[]): boolean {
  return typeof origin === "string" && Array.isArray(allowed) && allowed.includes(origin);
}

// ---------------------------------------------------------------------------
// makeFrameBuffer - pure buffer helper for CONNECTING-phase audio frames.
// Frames arriving while upstream is CONNECTING used to be silently
// dropped, losing the webm EBML container header. Buffer and flush in order.
// Bounds: 200 frames or 2MB. NEVER drop-oldest.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_FRAMES = 200;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2MB

/**
 * Create a new frame buffer.
 * Bounds: maxFrames frames or maxBytes total, whichever is hit first.
 * push returns "overflow" when the bound would be exceeded.
 * Caller must then send a status overflow frame and close both sockets.
 */
export function makeFrameBuffer(
  maxFrames: number = DEFAULT_MAX_FRAMES,
  maxBytes: number = DEFAULT_MAX_BYTES
): FrameBuffer {
  const queue: Array<Buffer | Uint8Array> = [];
  let totalBytes = 0;

  return {
    push(frame: Buffer | Uint8Array): "ok" | "overflow" {
      if (queue.length >= maxFrames || totalBytes + frame.byteLength > maxBytes) {
        return "overflow";
      }
      queue.push(frame);
      totalBytes += frame.byteLength;
      return "ok";
    },

    flush(): Array<Buffer | Uint8Array> {
      const frames = queue.splice(0, queue.length);
      totalBytes = 0;
      return frames;
    },

    byteCount(): number {
      return totalBytes;
    },

    frameCount(): number {
      return queue.length;
    },
  };
}

// ---------------------------------------------------------------------------
// statusFrame - build upstream lifecycle status frames.
// ---------------------------------------------------------------------------

/**
 * Build a status frame for downstream client delivery.
 * Valid states: no_key, upstream_connecting, upstream_open, upstream_closed,
 * upstream_error, overflow.
 *
 * `detail` is optional free text for the debug panel (currently the upstream
 * error message). It is OMITTED rather than set to undefined when absent, so
 * frames for every pre-existing state serialise byte-identically to before.
 *
 * Do NOT put anything key-derived in `detail`. The KEY-NEVER-DOWNSTREAM test
 * covers this file; the caller is responsible for what it passes.
 */
export function statusFrame(state: UpstreamState, detail?: string): StatusMessage {
  return detail === undefined
    ? { type: "status", state }
    : { type: "status", state, detail };
}

// ---------------------------------------------------------------------------
// buildDeepgramUrl - the streaming WS endpoint, with keyterm prompting.
// ---------------------------------------------------------------------------

/**
 * The demo roster plus the product terms, as the default keyterm list.
 *
 * Keyterm prompting was measured against real dictation: a roster
 * name transcribed as a common English near-neighbour mid-sentence on the
 * untouched config, a keyterm entry for it fixed that directly, and
 * smart_format/language variants did not, ruling both out as the cause.
 *
 * Risk criterion (an entry is risky iff it has a plausible English neighbour
 * ordinary speech would produce): Quill, Sprout, Forge and Mux do; Atlas,
 * Scribe, Summit, Deepgram, Inkie, Linkie, Briar, Echo and Nova do
 * not. The risky half is inference from that negative result (keyterm reranks
 * acoustically plausible candidates only), not separately proven per entry.
 *
 * This is a DEFAULT, not a policy: it exists so the bundled demo dictates
 * sensibly out of the box. Set DEEPGRAM_KEYTERMS to override it with your own
 * roster. Nothing here needs to be the names your agents actually use.
 */
export const DEFAULT_KEYTERMS: readonly string[] = [
  "Quill", "Sprout", "Forge", "Mux",
  "Atlas", "Scribe", "Summit", "Deepgram", "Inkie", "Linkie",
  "Briar", "Echo", "Nova",
];

export type DeepgramReplacement = { readonly find: string; readonly replace: string };

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
 * independently verified against a recorded audio sample - there is
 * no confirmed transcript yet showing "inky" is the actual wrong output.
 * "inky" is simply the most probable candidate (a real, common word one
 * phoneme off from "Inkie"). Revisit if a real sample surfaces a different
 * wrong word.
 */
export const DEFAULT_REPLACEMENTS: readonly DeepgramReplacement[] = [
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
 */
export function buildDeepgramUrlQuery(opts: {
  model: string;
  language: string;
  keyterms: readonly string[];
  replacements: readonly DeepgramReplacement[];
}): string {
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
