# Voice dictation repeats text when the mic is clicked while connecting

- Issue: none (reported directly by the operator)
- Branch: fix/voice-single-session
- Started: 2026-10-19

## TL;DR

`toggleMic` in `packages/deck/app/components/Compose.tsx` only refused a new
session when `status === "active"`, which is set after `getUserMedia` and the
socket `open`. The mic is slow to respond, so clicks during that window each
started another session (own stream, socket, recorder). Each overwrote the
refs, so `stopVoice` lost the older ones, and every live socket called
`onFinalTextRef.current`: each Deepgram final was inserted once per session.

Fix: one session at a time. A `liveRef` lock set on the first click makes a
click while connecting cancel the pending start; a `sessionIdRef` bumped on
every release lets the in-flight start notice it was cancelled after
`getUserMedia` resolves and drop its stream. Every socket listener checks
`wsRef.current === ws`, so a superseded socket can neither insert text nor
stop the live session. A new `connecting` voice state shows a spinner with
`aria-busy` and the label "Connecting voice, click to cancel".

## Scope

In scope: `useVoice` and the mic button in `Compose.tsx`; one jsdom test.

Out of scope: the voice proxy, the Deepgram relay, other components.

## Test plan

- `test/compose-voice-single-session.test.tsx` (stubs getUserMedia,
  WebSocket, MediaRecorder): two clicks before the socket opens create one
  socket and release it; a click during the permission prompt opens no
  socket and stops the stream; a stale socket's final, open and close do not
  reach the textarea or stop the live session. All three fail on the
  pre-fix code.
- Not yet verified in a real browser.

## Follow-ups

- None.
