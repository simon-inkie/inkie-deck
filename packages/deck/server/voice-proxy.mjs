/**
 * server/voice-proxy.mjs - Standalone WebSocket proxy for Deepgram realtime STT.
 *
 * Listens on VOICE_PROXY_PORT (default 5176), path /voice.
 * Per client connection:
 *   - If DEEPGRAM_API_KEY is unset: sends {type:"status", state:"no_key"} and closes.
 *   - Else: opens upstream wss://api.deepgram.com/v1/listen with the key
 *     in the Authorization header (server-side only), relays binary audio frames
 *     up and maps Deepgram JSON responses to interim/final messages downstream.
 *
 * Buffer-until-open (TASK-433 fix): binary frames received while the upstream is
 * still CONNECTING are queued via makeFrameBuffer rather than dropped. On upstream
 * open the queue is flushed in order so the webm EBML container header (chunk 1)
 * is never lost. On overflow: sends status overflow and closes both sockets.
 *
 * Status frames: sent downstream on every upstream lifecycle event so the debug
 * panel can show the second hop without any server-side log scraping.
 *
 * debug_on opt-in: if the client sends a text frame {type:"debug_on"}, the proxy
 * mirrors each raw upstream Deepgram frame as {type:"dg_raw", text:<truncated 500>}.
 * Without the opt-in the behaviour is identical to before. The key NEVER appears
 * in any client-bound message; Deepgram response bodies are transcripts/metadata only.
 *
 * The key NEVER appears in any client-bound message. See voice-relay.mjs for
 * the pure mapping logic (unit-tested separately).
 *
 * Spawned by scripts/dev.mjs alongside the RR dev server.
 *
 * ASCII only - no em-dashes (FND-05).
 */

import { WebSocketServer, WebSocket } from "ws";
import {
  mapUpstreamMessage,
  noKeyHandshake,
  isOriginAllowed,
  resolveAllowedOrigins,
  makeFrameBuffer,
  statusFrame,
  buildDeepgramUrlQuery,
  DEFAULT_KEYTERMS,
  DEFAULT_REPLACEMENTS,
} from "./voice-relay.mjs";

const PORT = parseInt(process.env["VOICE_PROXY_PORT"] ?? "5176", 10);

// Peer-review fold (Atlas, TASK-433 plan): the key was protected but the
// keyhole was open. Two closures:
// (a) Bind 127.0.0.1 by default - widening the bind is an TASK-435/Tailscale
//     decision, never a default.
const HOST = process.env["VOICE_PROXY_HOST"] ?? "127.0.0.1";
// (b) Origin allowlist on the WS upgrade: browsers do NOT apply same-origin
//     policy to WebSocket connects, so without this any webpage the operator
//     visits could open ws://localhost:5176 and spend Deepgram minutes
//     through our key. Absent or non-matching Origin = reject the upgrade
//     before any upstream connection exists.
//     Default: Deck's own http://localhost:$PORT (4242 unless PORT is set) and
//     the dev port; see defaultAllowedOrigins in voice-relay.mjs. An unset OR
//     blank VOICE_ALLOWED_ORIGINS falls back to it, since an empty allowlist
//     would reject every upgrade.
const ALLOWED_ORIGINS = resolveAllowedOrigins(process.env);

// Model + language are explicit (2026-06-11): with `model` unspecified,
// Deepgram silently falls back to the legacy "base-general" model, which is
// what made Alex's dictation wonky - nothing to do with his accent. nova-3
// is the current best for UK English; en-GB hints the variant. Both
// env-overridable so an instance can pin a different model without a code
// change.
const DG_MODEL = process.env["DEEPGRAM_MODEL"] ?? "nova-3";
const DG_LANGUAGE = process.env["DEEPGRAM_LANGUAGE"] ?? "en-GB";

// Base is overridable for the same reason model and language are: so an
// instance can be pointed elsewhere without a code change. It also makes the
// upstream-failure path testable, since a test can point this at a local
// server that rejects the upgrade. Default is the live literal, so an
// unset env is byte-identical to the previous behaviour.
//
// The API key is NOT in this URL. It travels in the Authorization header at
// the WebSocket construction below, so overriding the base cannot leak it into
// a query string. test/voice-proxy-upstream-error.test.ts asserts that no
// downstream frame contains the key rather than leaving it as reasoning.
const DG_URL_BASE =
  process.env["DEEPGRAM_URL_BASE"] ?? "wss://api.deepgram.com/v1/listen";

// Keyterm prompting (measured 2026-07-28 against real dictation): a bare
// roster name transcribed as a common English near-neighbour mid-sentence on
// the untouched config; a keyterm entry for it fixed that directly, and
// smart_format/language variants did not, which rules both out as the cause.
// Confirmed on the STREAMING endpoint specifically - the docs describe the
// batch API, and the two are not the same surface.
//
// Default list is the demo roster (DEFAULT_KEYTERMS, voice-relay.mjs).
// Deliberately NOT capped or validated here: an allowlist on term COUNT would
// go stale the moment the roster changes, and an overflow list 400s the
// upgrade rather than degrading - that failure now surfaces as a real
// diagnostic (the upstream_error status frame above) rather than a silently
// dead mic, so there is somewhere for it to be seen instead of a predictive
// guard on the input today.
//
// Comma-separated in the env var (matches VOICE_ALLOWED_ORIGINS' shape); the
// query builder below turns that into REPEATED keyterm= params, since
// Deepgram does not accept a comma-joined value (confirmed empirically, not
// from the docs).
const DG_KEYTERMS = process.env["DEEPGRAM_KEYTERMS"]
  ? process.env["DEEPGRAM_KEYTERMS"].split(",").map((t) => t.trim()).filter(Boolean)
  : DEFAULT_KEYTERMS;

// Find-and-replace (see DEFAULT_REPLACEMENTS, voice-relay.mjs): keyterm alone
// was not reliably beating "inky" for "Inkie", so replace is layered on top
// as a deterministic substitution rather than a rerank.
//
// Comma-separated find:replacement pairs in the env var, e.g.
// DEEPGRAM_REPLACEMENTS="inky:Inkie,foo:Bar" - same convention as
// DEEPGRAM_KEYTERMS above. Parsed defensively (CR on !31): split on the FIRST
// colon only, so a replacement containing its own colon survives intact;
// `find` is lowercased, since Deepgram requires that and a hand-set env var
// will not always match it; and a malformed or whitespace-only env var falls
// back to DEFAULT_REPLACEMENTS rather than silently resolving to an empty
// list, which would drop the "inky" guard entirely with no signal anywhere.
const DG_REPLACEMENTS = (() => {
  const raw = process.env["DEEPGRAM_REPLACEMENTS"];
  if (!raw) return DEFAULT_REPLACEMENTS;
  const parsed = raw
    .split(",")
    .map((pair) => {
      const sep = pair.indexOf(":");
      if (sep === -1) return null;
      const find = pair.slice(0, sep).trim().toLowerCase();
      const replace = pair.slice(sep + 1).trim();
      return find && replace ? { find, replace } : null;
    })
    .filter((r) => r !== null);
  return parsed.length > 0 ? parsed : DEFAULT_REPLACEMENTS;
})();

const DG_URL =
  `${DG_URL_BASE}?${buildDeepgramUrlQuery({
    model: DG_MODEL,
    language: DG_LANGUAGE,
    keyterms: DG_KEYTERMS,
    replacements: DG_REPLACEMENTS,
  })}`;

const wss = new WebSocketServer({
  host: HOST,
  port: PORT,
  path: "/voice",
  verifyClient: ({ origin }) => {
    const ok = isOriginAllowed(origin, ALLOWED_ORIGINS);
    if (!ok) {
      console.warn(
        `[voice-proxy] rejected upgrade from origin "${origin ?? "(absent)"}"`
      );
    }
    return ok;
  },
});

// The listening line is emitted by the "listening" EVENT, not by reaching the
// next statement. Previously it printed unconditionally right after the
// constructor, so the process announced it was serving before the bind had
// been confirmed, and still announced it when the bind failed.
wss.on("listening", () => {
  console.log(
    `[voice-proxy] listening on ws://${HOST}:${PORT}/voice (origins: ${ALLOWED_ORIGINS.join(", ")})`
  );
});

// There was no error listener on this server at all, so an EADDRINUSE reached
// an EventEmitter with no handler and threw, AFTER we had already claimed to be
// listening: claim first, contradiction second.
//
// Exit non-zero. A proxy that cannot bind is serving nothing, and dev.mjs
// keeping a live process that serves nothing is worse than a dead one, because
// the failure then presents as a mic that does not work rather than as a
// process that is missing.
wss.on("error", (err) => {
  console.error(
    `[voice-proxy] failed to bind ${HOST}:${PORT}: ${err.message}`
  );
  process.exit(1);
});

wss.on("connection", (client) => {
  const key = process.env["DEEPGRAM_API_KEY"];

  if (!key) {
    console.log("[voice-proxy] no key configured - sending no_key and closing");
    client.send(JSON.stringify(noKeyHandshake()));
    client.close();
    return;
  }

  console.log("[voice-proxy] client connected - opening upstream to Deepgram");

  // Buffer for frames that arrive while upstream is still CONNECTING.
  // Bounds: 200 frames or 2MB. NEVER drop-oldest (that is the bug).
  const frameBuffer = makeFrameBuffer();

  // debug_on: set to true when the client opts in with a {type:"debug_on"} frame.
  let debugOn = false;

  const upstream = new WebSocket(DG_URL, {
    headers: { Authorization: `Token ${key}` },
  });

  // Notify the client that the upstream dial has begun.
  try {
    client.send(JSON.stringify(statusFrame("upstream_connecting")));
  } catch {
    // client may have closed before the send
  }

  upstream.on("open", () => {
    console.log("[voice-proxy] upstream connected to Deepgram");

    // Notify client that the second hop is live.
    try {
      client.send(JSON.stringify(statusFrame("upstream_open")));
    } catch {
      // client may have closed
    }

    // Flush buffered frames in order - this is the fix for the EBML header drop.
    const buffered = frameBuffer.flush();
    for (const frame of buffered) {
      try {
        upstream.send(frame, { binary: true });
      } catch {
        // upstream may have closed between flush items; safe to ignore here
      }
    }
  });

  upstream.on("error", (err) => {
    console.error("[voice-proxy] upstream error:", err.message);
    // Tell the client WHY before closing. Every other lifecycle path in this
    // file sends a status frame; this one did not, so a rejected upgrade (bad
    // model, over-long keyterm list, revoked key, Deepgram outage) reached the
    // user as a mic that silently did nothing.
    //
    // The send must come BEFORE client.close(): once the socket is CLOSING, ws
    // drops the frame internally (sendAfterClose just adds to _bufferedAmount,
    // it neither throws nor emits), so a later send is silently lost rather
    // than caught. Ordering is the fix, not the try/catch.
    //
    // err.message on a rejected upgrade reads "Unexpected server response:
    // 400", which is the diagnostic worth having in the debug panel. This
    // deliberately reports whatever happened rather than validating the causes
    // we predicted.
    try {
      client.send(JSON.stringify(statusFrame("upstream_error", err.message)));
    } catch {
      // client may have closed first; nothing to report to
    }
    // Deliberately NOT closing the client here. ws emits "close" after "error"
    // on a rejected upgrade (verified in ws 8.21.0: abortHandshake at
    // websocket.js:1102 schedules emitErrorAndClose, which at :1053 emits
    // "error" then "close" in sequence), so the close handler below runs and
    // sends upstream_closed on its own.
    //
    // Closing here suppressed that frame. Not via the try/catch, which never
    // fires: ws drops a send on a CLOSING socket internally without throwing.
    // The frame was simply lost, which is why this path produced silence
    // rather than even a generic closed status.
    //
    // SCOPE OF WHAT IS PROVEN: only the rejected-upgrade path. abortHandshake
    // has a second branch at :1122 (the no-setHeader case) that routes through
    // stream.destroy(err) and a once("error") forward, and nobody has walked
    // it. If that branch can emit "error" without a following "close", this
    // leaves the client socket open and the client-side silence timer is what
    // stops the session. That is the reason this is its own commit: revert it
    // alone and the upstream_error diagnostic stays.
  });

  upstream.on("message", (data) => {
    // Deepgram sends text frames (JSON).
    const rawStr = data.toString("utf8");

    // debug_on: mirror the raw frame (truncated to 500 chars) before mapping.
    if (debugOn) {
      const truncated = rawStr.length > 500 ? rawStr.slice(0, 500) + "..." : rawStr;
      try {
        client.send(JSON.stringify({ type: "dg_raw", text: truncated }));
      } catch {
        // client may have closed
      }
    }

    const mapped = mapUpstreamMessage(rawStr);
    if (mapped !== null) {
      try {
        client.send(JSON.stringify(mapped));
      } catch {
        // client may have closed
      }
    }
  });

  upstream.on("close", () => {
    console.log("[voice-proxy] upstream closed");
    try {
      client.send(JSON.stringify(statusFrame("upstream_closed")));
    } catch {
      // client may have closed
    }
    try {
      client.close();
    } catch {
      // already closed
    }
  });

  // Relay binary audio frames from client to Deepgram.
  // While CONNECTING: buffer them so the webm container header is not lost.
  // While OPEN: send directly.
  client.on("message", (data, isBinary) => {
    if (isBinary) {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: true });
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        const result = frameBuffer.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        if (result === "overflow") {
          console.warn("[voice-proxy] frame buffer overflow - closing connection");
          try {
            client.send(JSON.stringify(statusFrame("overflow")));
          } catch {
            // client may have closed
          }
          try {
            client.close();
          } catch {
            // already closed
          }
          upstream.terminate();
        }
      }
      // readyState CLOSING or CLOSED: drop silently (client should detect this via close event)
      return;
    }

    // Text frame: check for debug_on opt-in.
    if (!isBinary && typeof data === "object") {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (msg && typeof msg === "object" && msg.type === "debug_on") {
        debugOn = true;
      }
    }
  });

  client.on("close", () => {
    console.log("[voice-proxy] client disconnected");
    // Atlas landed-review micro-note: a client that disconnects while the
    // upstream is still CONNECTING must not leave that connect to complete
    // and idle until Deepgram times it out - the last sliver of the
    // orphaned-upstream-socket leak the plan named.
    if (upstream.readyState === WebSocket.CONNECTING) {
      upstream.terminate();
    } else if (upstream.readyState === WebSocket.OPEN) {
      upstream.close();
    }
  });

  client.on("error", (err) => {
    console.error("[voice-proxy] client error:", err.message);
    try {
      upstream.close();
    } catch {
      // already closed
    }
  });
});
