/**
 * Type declarations for server/voice-relay.mjs
 * ASCII only - no em-dashes (FND-05).
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
 * Map a raw Deepgram upstream JSON text frame to a client-bound message.
 * Returns null for non-transcript events or empty transcripts.
 */
export function mapUpstreamMessage(rawJson: string): ClientMessage | null;

/**
 * Returns the message shape sent when DEEPGRAM_API_KEY is not configured.
 */
export function noKeyHandshake(): StatusMessage;
export function isOriginAllowed(origin: unknown, allowed: string[]): boolean;

/**
 * Create a new frame buffer for CONNECTING-phase audio frame queuing.
 * Bounds: maxFrames (default 200) or maxBytes (default 2MB).
 * NEVER drops oldest. Returns "overflow" from push() when bound is hit.
 */
export function makeFrameBuffer(maxFrames?: number, maxBytes?: number): FrameBuffer;

/**
 * Build a status frame for downstream client delivery.
 * Valid states: no_key, upstream_connecting, upstream_open, upstream_closed,
 * upstream_error, overflow. `detail` carries the cause for upstream_error and
 * is omitted (not undefined) for every other state.
 */
export function statusFrame(state: UpstreamState, detail?: string): StatusMessage;

/**
 * Team roster, the default keyterm list (measured 2026-07-28).
 */
export const DEFAULT_KEYTERMS: readonly string[];

/**
 * Build the Deepgram streaming WS query string (model/language/keyterms).
 * Repeats `keyterm=` per entry rather than comma-joining.
 */
export function buildDeepgramUrlQuery(opts: {
  model: string;
  language: string;
  keyterms: readonly string[];
}): string;

/**
 * Default origin allowlist: http://localhost:$PORT (default 4242) then the dev
 * port http://localhost:5174, without duplicates.
 */
export function defaultAllowedOrigins(
  env?: Record<string, string | undefined>
): string[];

/**
 * VOICE_ALLOWED_ORIGINS when non-blank, else defaultAllowedOrigins.
 */
export function resolveAllowedOrigins(
  env?: Record<string, string | undefined>
): string[];
