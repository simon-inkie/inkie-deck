/**
 * tmux.server.ts - tmux pane capture (read) + send-keys (write) for the live
 * Team tab and per-thread terminal view (TASK-437 v1 read, v2 adds write).
 *
 * FIRST SUBPROCESS IN MC - the guard posture is the point of this module:
 *
 *   1. NO SHELL, EVER. Every invocation is execFileSync("tmux", argv) with
 *      a discrete argument array - there is no command string to inject
 *      into. buildCaptureArgs/buildListArgs/buildSendKeys*Args are exported
 *      pure so the argv-array shape is PINNED by unit tests.
 *   2. Window names are validated against the ROSTER regex BEFORE any
 *      subprocess call, AND must appear in the live `tmux list-windows`
 *      output (the session itself is the allowlist). This gates WRITES the
 *      same way it gates reads - you cannot send to a window that is not
 *      a live ROSTER-shaped agent window.
 *   3. Session name comes from MC_TMUX_SESSION env (default "agents") -
 *      no machine-specific value hardcoded, and e2e points it at a
 *      guaranteed-missing session for deterministic empty states.
 *   4. WRITE POSTURE (v2): send-keys exists now, deliberately. v1 was
 *      readonly-by-construction; the remote-auth lockout of 2026-06-09
 *      (Alex could read but not authorise over MC mobile) earned the flip.
 *      It is acceptable because MC is tailnet-only + Alex's own devices -
 *      blast radius is just him. The write path carries the SAME gate as the
 *      read path, sends arbitrary prose LITERALLY (-l, never interpreted as
 *      key names) with a "--" flag-injection guard, and submits Enter as a
 *      SEPARATE call after a short delay (text+Enter in one call races the
 *      Claude TUI and leaves the text unsubmitted - load-bearing).
 *   5. Every failure (tmux absent, session missing, window gone, non-zero
 *      exit) degrades to []/undefined / {ok:false} - the route renders an
 *      honest empty/error state, never a 500. The read path is never broken
 *      by a write failure, so the readonly fallback is always intact.
 *
 * ASCII only - no em-dashes (FND-05).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { resolveAttachmentsRoot } from "./attachments.server.js";

/** ROSTER agent-name convention - the pre-subprocess gate. */
export const WINDOW_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Subprocess hard deadline (Atlas fold, 437 review). execFileSync BLOCKS
 * the event loop - a wedged tmux server (suspended laptop, dead socket)
 * would otherwise freeze every MC request, re-frozen each 1s poll tick.
 * capture-pane is ~ms when healthy; 500ms is generous, and a timeout
 * lands in the same degrade-to-empty path as every other failure.
 */
export const TMUX_EXEC_TIMEOUT_MS = 500;

/** True when a window name is safe to pass as a tmux target segment. */
export function isValidWindowName(name: string): boolean {
  return WINDOW_NAME_RE.test(name);
}

/**
 * Resolve the tmux session name (env-named; default "agents").
 * Platform-review fold: the session value is one more thing that lands in argv, so it
 * passes the SAME ROSTER gate - which also guarantees no argv element can
 * ever begin with "-". Invalid values fall back to the default.
 */
export function resolveTmuxSession(env: NodeJS.ProcessEnv): string {
  const session = (env["MC_TMUX_SESSION"] ?? "").trim();
  return session !== "" && WINDOW_NAME_RE.test(session) ? session : "agents";
}

/**
 * argv for listing window names. Pure - the no-shell shape is unit-pinned.
 */
export function buildListArgs(session: string): string[] {
  return ["list-windows", "-t", session, "-F", "#{window_name}"];
}

/**
 * How many lines of scrollback history to capture. The default capture is the
 * visible viewport only (~35 lines) - Alex could not scroll back past the last
 * screenful. "-S -N" pulls N lines of scrollback so the browser pane (which is
 * overflow-auto) has real history to scroll. Verified live: these agent panes
 * run alternate_on=0, so scrollback holds linear chat history (not an
 * alt-screen redraw), and -S -1000 returns ~1000+ real lines.
 */
export const TMUX_CAPTURE_SCROLLBACK_LINES = 1000;

/**
 * argv for capturing one window's pane WITH scrollback. Pure - unit-pinned.
 *
 * Platform-review fold (the sharp one): tmux target matching is exact-THEN-prefix-THEN-
 * fnmatch by default - if window "quill" vanished in the TOCTOU gap after
 * list-windows, a bare target could silently capture "quill-backup" instead.
 * The "=" prefix forces EXACT match - applied to BOTH parts (verified live:
 * "=agents:=i" errors where prefix-match would silently resolve to "quill").
 * Wrong-pane becomes an error, and the error becomes the empty state.
 *
 * "-S -N" starts the capture N lines back in the scrollback buffer (history).
 * Plain capture (no -e): no ANSI escapes, nothing to strip, no colour dep
 * (v1 disclosed omission).
 */
export function buildCaptureArgs(session: string, window: string): string[] {
  return [
    "capture-pane",
    "-t",
    `=${session}:=${window}`,
    "-p",
    "-S",
    `-${TMUX_CAPTURE_SCROLLBACK_LINES}`,
  ];
}

function runTmux(args: string[]): string | undefined {
  try {
    return execFileSync("tmux", args, {
      encoding: "utf8",
      timeout: TMUX_EXEC_TIMEOUT_MS,
      // Belt-and-braces: never inherit stdio, never grow unbounded.
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // tmux absent, session/window missing, timeout - all degrade the same.
    return undefined;
  }
}

/**
 * Live window names for the session, [] when the session is unreachable.
 * Names that fail the ROSTER regex are dropped (they could not be captured
 * anyway - the validate-before-subprocess gate would reject them).
 */
export function listTmuxWindows(env: NodeJS.ProcessEnv): string[] {
  const out = runTmux(buildListArgs(resolveTmuxSession(env)));
  if (out === undefined) return [];
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && isValidWindowName(l));
}

/**
 * Capture the visible pane of one window. undefined on any failure or any
 * validation miss (unknown window, bad name) - the route shows the empty
 * state.
 */
export function captureTmuxPane(
  env: NodeJS.ProcessEnv,
  window: string
): string | undefined {
  if (!isValidWindowName(window)) return undefined;
  // Live allowlist: the window must exist in the session right now.
  if (!listTmuxWindows(env).includes(window)) return undefined;
  return runTmux(buildCaptureArgs(resolveTmuxSession(env), window));
}

// ---------------------------------------------------------------------------
// Write path (v2 - send-keys)
// ---------------------------------------------------------------------------

/**
 * Delay between the literal-text send and the Enter send. Text+Enter in one
 * call races the Claude TUI - the text lands but sits unsubmitted because the
 * Enter arrives before the TUI has registered the input. SEPARATE calls with a
 * gap is the documented fix (the send-keys-then-Enter memory
 * + the tmux-wake note). 1s is generous and matches an interactive wake.
 */
export const SEND_KEYS_ENTER_DELAY_MS = 1000;

/** Upper bound on a single send. A pasted essay is not a chat turn. */
export const SEND_KEYS_MAX_LEN = 2000;

/**
 * Upper bound on a sender tag inside a pane payload. tmux window names are
 * short; this exists so buildPanePayload's capped-payload contract cannot be
 * broken by the tag alone, independent of caller validation.
 */
export const MAX_TAG_LEN = 64;

/**
 * argv for sending literal text to a window. Pure - unit-pinned.
 *
 * "-l" sends the bytes LITERALLY: arbitrary prose is never interpreted as tmux
 * key names, so a message containing "Enter", "C-c" or ";" goes through as
 * typed. "--" ends option parsing so text beginning with "-" can never be read
 * as a flag. Same "=session:=window" EXACT-match target as capture (TOCTOU
 * fold: a bare target could resolve a vanished "quill" to "quill-backup").
 */
export function buildSendKeysTextArgs(
  session: string,
  window: string,
  text: string
): string[] {
  return ["send-keys", "-t", `=${session}:=${window}`, "-l", "--", text];
}

/**
 * argv for pressing Enter in a window. Pure - unit-pinned. No "-l": "Enter" is
 * a key NAME here, not literal text - this is the keystroke that submits.
 */
export function buildSendKeysEnterArgs(
  session: string,
  window: string
): string[] {
  return ["send-keys", "-t", `=${session}:=${window}`, "Enter"];
}

/** Run a tmux verb for its side effect; true on clean exit, false on any failure. */
function runTmuxVoid(args: string[]): boolean {
  try {
    execFileSync("tmux", args, {
      encoding: "utf8",
      timeout: TMUX_EXEC_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export type SendKeysResult = { ok: true } | { ok: false; error: string };

/**
 * Send a line of literal text to an agent's window, then submit it with Enter.
 *
 * Carries the SAME validate-before-subprocess gate as capture: the window must
 * be ROSTER-shaped AND present in the live session. Empty/whitespace-only and
 * over-length text are rejected before any subprocess. The Enter is a SEPARATE
 * call after SEND_KEYS_ENTER_DELAY_MS (see that constant). Any failure returns
 * { ok: false } - it never throws and never touches the read path, so the
 * readonly fallback survives a broken write.
 */
export async function sendKeysToWindow(
  env: NodeJS.ProcessEnv,
  window: string,
  text: string
): Promise<SendKeysResult> {
  if (!isValidWindowName(window)) {
    return { ok: false, error: "Unknown or invalid window." };
  }
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: false, error: "Nothing to send." };
  }
  if (text.length > SEND_KEYS_MAX_LEN) {
    return { ok: false, error: `Message too long (max ${SEND_KEYS_MAX_LEN}).` };
  }
  // Live allowlist: the window must exist in the session right now.
  if (!listTmuxWindows(env).includes(window)) {
    return { ok: false, error: "Window is not live in the session." };
  }

  const session = resolveTmuxSession(env);
  // Send the raw text the operator typed (not the trimmed copy) so leading
  // whitespace they intended is preserved; the trim only gates emptiness.
  if (!runTmuxVoid(buildSendKeysTextArgs(session, window, text))) {
    return { ok: false, error: "Could not send text to the window." };
  }
  await new Promise((resolve) => setTimeout(resolve, SEND_KEYS_ENTER_DELAY_MS));
  if (!runTmuxVoid(buildSendKeysEnterArgs(session, window))) {
    // Text landed but Enter did not - the message sits in the prompt unsubmitted.
    return { ok: false, error: "Text sent but submit (Enter) failed." };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Wake-on-idle (#91) - the complement to the #78 Monitor-drop
// ---------------------------------------------------------------------------

/**
 * argv for capturing ONLY the visible viewport (no `-S` scrollback). The
 * liveness probe reads just the live footer, where the working-spinner renders
 * - scrollback would drag in historical lines that could false-match. Pure -
 * unit-pinned.
 */
export function buildCaptureViewportArgs(session: string, window: string): string[] {
  return ["capture-pane", "-t", `=${session}:=${window}`, "-p"];
}

/**
 * argv for capturing the visible viewport WITH ANSI escape codes preserved
 * (`-e`). Used ONLY to disambiguate a Codex dim-hint placeholder from real
 * staged text (see composerIsClean / DIM_SGR): the plain `-p` capture strips
 * the styling that tells the two apart, so we take a SECOND, raw capture just
 * for that check. Kept separate from buildCaptureViewportArgs so nothing else
 * in this module ever has to strip escapes. Pure - unit-pinned.
 */
export function buildCaptureViewportRawArgs(session: string, window: string): string[] {
  return ["capture-pane", "-t", `=${session}:=${window}`, "-p", "-e"];
}

/**
 * Detects the Claude Code CORE working-spinner footer (a turn in flight). The
 * one cross-agent-stable ACTIVE marker is the elapsed-timer shape the core TUI
 * renders while working: "(2m 33s . <tokens>)", "(45s . <tokens>)", plus the
 * early-turn "(esc to interrupt)". This is core CC, NOT the per-agent custom
 * statusline (idle statuslines vary - "ctx:19%" on one agent, a bar "28%" on
 * another), so it is the reliable signal. The regex errs toward ACTIVE (a chat
 * line like "(3s ..." reads active and just SKIPS the wake - the safe
 * direction; a wrong wake risks stray text in a live composer).
 */
export const ACTIVE_PANE_RE = /esc to interrupt|\((?:\d+h\s)?(?:\d+m\s)?\d+s\s/i;

/** True when a captured viewport shows the working spinner (turn in flight). */
export function paneTextIsActive(viewport: string): boolean {
  return ACTIVE_PANE_RE.test(viewport);
}

/**
 * The bare, EMPTY composer prompt: a lone prompt glyph on its own line, nothing
 * typed after it. This is the POSITIVE idle signal - the one state where a wake
 * is safe. Two glyphs are recognised: Claude Code's U+276F and Codex's U+203A
 * (the runtimes MC live-wakes). Everything else fails it on purpose:
 *   - dirty composer ("U+276F git checkout main")  -> text after the prompt, no match
 *   - permission dialog ("U+276F 1. Yes")           -> text after the prompt, no match
 *   - ghost / auto-suggest ("U+276F /compact")      -> text after the prompt, no match (benign skip)
 *   - exited agent at a bash shell ("user@host$")   -> no prompt glyph at all, no match
 *   - agy / Gemini runtime (">")                    -> different glyph, no match (separate wake path)
 * Validated against live panes: it matched ONLY the genuinely-idle agents and
 * rejected every unsafe state. Multiline (`m`) so any viewport line can be the
 * composer (the statusline + separator render BELOW the prompt in this TUI).
 *
 * NB: Codex's idle composer is almost never genuinely bare - it shows a rotating
 * hint placeholder after the glyph, which fails this bare check by design. That
 * case is handled downstream by the ANSI dim-hint disambiguation (DIM_SGR); this
 * regex only covers the truly-bare state (Claude's usual rest, Codex's rare one).
 */
export const IDLE_PROMPT_RE = /^\s*[\u276F\u203A]\s*$/m;

/**
 * The prompt glyphs MC recognises as a live agent composer: Claude Code's U+276F
 * and Codex's U+203A. agy / Gemini's ">" is deliberately excluded - it has its
 * own separate wake path and never carries the dim-hint placeholder below.
 */
export const COMPOSER_PROMPT_GLYPHS = ["\u276F", "\u203A"] as const;

/**
 * The ANSI "dim" SGR marker (ESC[2m). Codex wraps every rotating hint placeholder
 * ("Implement {feature}", "Run /review on my current changes", ...) in this code;
 * real user-typed text never is. A raw (-e) capture therefore tells a hint apart
 * from genuinely-staged text for ANY hint string, without hardcoding a literal
 * (an exact-string allowlist already broke once when Codex rotated to a second
 * hint - CLI inbox-push, 2026-07-18). See composerIsClean.
 */
export const DIM_SGR = "\x1b[2m";

/** Index of the LAST viewport line bearing a composer prompt glyph, or -1. */
function findPromptLineIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && COMPOSER_PROMPT_GLYPHS.some((g) => line.includes(g))) {
      return i;
    }
  }
  return -1;
}

/**
 * True when the composer line of a RAW (-e) capture is a Codex dim-hint
 * placeholder rather than real staged text: find the last raw line bearing a
 * prompt glyph and check whether it carries the dim SGR marker. undefined/empty
 * raw (capture failed, or none supplied) reads false - the conservative
 * direction, so an unrecognised composer stays "dirty" and is not woken.
 */
function composerLineIsDimHint(rawViewport: string | undefined): boolean {
  if (rawViewport === undefined || rawViewport === "") return false;
  const rawLines = rawViewport.split("\n");
  const idx = findPromptLineIndex(rawLines);
  if (idx === -1) return false;
  const rawLine = rawLines[idx];
  return rawLine !== undefined && rawLine.includes(DIM_SGR);
}

/**
 * Shared composer gate for paneTextIsIdle / paneAcceptsSend: the pane shows a
 * live composer that is safe to send into, AND no stale shell frame sits below
 * it. "Safe" means the composer is either genuinely bare (IDLE_PROMPT_RE) OR
 * holds only a Codex dim-hint placeholder (composerLineIsDimHint on the raw
 * capture). Does NOT consider the working spinner - the two callers differ ONLY
 * on whether an active spinner is a skip, and each handles that itself.
 *
 * The composer is the LAST line bearing a prompt glyph - the statusline and
 * separator render below it but carry no glyph. Checking only that line (not /m
 * across the whole viewport) closes the scrollback hole: a bare prompt in
 * history above a DIRTY active composer must not read as clean.
 */
function composerIsClean(viewport: string, rawViewport?: string): boolean {
  const lines = viewport.split("\n");
  const promptIndex = findPromptLineIndex(lines);
  if (promptIndex === -1) return false;
  const promptLine = lines[promptIndex];
  if (promptLine === undefined) return false;
  // A genuinely-bare prompt reads clean at once. Otherwise the composer has text
  // after the glyph: real staged text (dirty) OR a Codex rotating hint. Codex
  // renders every hint in the ANSI dim SGR (DIM_SGR); real typed text never is,
  // so the raw capture disambiguates for ANY hint string, not a hardcoded one.
  if (!IDLE_PROMPT_RE.test(promptLine) && !composerLineIsDimHint(rawViewport)) {
    return false;
  }
  // Stale-frame guard: a shell prompt below the composer means the agent exited
  // to a bash shell - a send-keys there would execute at the shell. A Claude
  // "ctx:NN%" statusline has no user@host shape and is never matched here.
  for (let i = promptIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && SHELL_PROMPT_RE.test(line)) return false;
  }
  return true;
}

/**
 * A Unix shell prompt left behind by an EXITED agent, e.g.
 * "alex@demobox:~/agents/echo$". Requires the user@host shape so a Claude
 * statusline that merely ends in a sigil (e.g. "Opus 4.8  ctx:19%") is NEVER
 * mistaken for a shell prompt - that false-negative would silently disable the
 * wake for agents with a ctx-percent statusline.
 */
export const SHELL_PROMPT_RE = /\w+@[\w.-]+[:\s].*[$#%]\s*$/;

/**
 * True when the viewport shows a CONFIRMED-idle agent composer: no working
 * spinner AND a clean composer (see composerIsClean). "Absence of spinner" alone
 * is NOT idle - a dirty composer, permission dialog, or stale bash shell all
 * lack a spinner yet must never be woken.
 *
 * A clean composer is a bare prompt glyph (Claude U+276F, Codex U+203A) OR - for
 * Codex, whose composer always shows a rotating hint placeholder after the glyph
 * - a hint recognised via the ANSI dim marker in the raw (-e) capture. Pass
 * rawViewport (the buildCaptureViewportRawArgs capture) so a Codex hint pane is
 * not misread as dirty; omit it and the conservative direction (no wake) holds.
 *
 * Scrollback hole fix: the composer is the LAST line bearing a prompt glyph -
 * the statusline and separator render below it but carry no glyph. Checking only
 * that line (not /m across the whole viewport) closes the scrollback hole: a
 * bare prompt in history above a DIRTY active composer must not read as idle.
 *
 * NOTE (latent dependency, shared with the pane readers): the last-glyph-line scan assumes the
 * statusline separator is the pipe glyph (U+2502), NOT a prompt glyph. A prompt
 * glyph appearing in the statusline would make this scan grab the statusline
 * instead of the composer and misread idle. True today (verified live: an idle
 * composer rests at U+276F + U+00A0 NBSP, which \s in IDLE_PROMPT_RE eats);
 * re-check if the statusline is ever redesigned.
 *
 * Stale-frame guard: an agent that exited to a shell leaves its old composer
 * frame with the shell prompt appended below (handled in composerIsClean).
 */
export function paneTextIsIdle(viewport: string, rawViewport?: string): boolean {
  if (paneTextIsActive(viewport)) return false;
  return composerIsClean(viewport, rawViewport);
}

/**
 * Positively-idle probe. Captures the live viewport (plain + a raw -e capture
 * for the Codex dim-hint check) and returns true ONLY when the pane shows a
 * CONFIRMED-idle agent composer: no working spinner AND a clean composer (see
 * paneTextIsIdle / composerIsClean). Returns false on ANY uncertainty - invalid
 * name, window not live, capture failure, an active spinner, a dirty composer,
 * a permission dialog, a bash shell, or an agy (">") prompt. Conservative on
 * purpose: a missed wake just falls back to next-turn hook-inject, but a wrong
 * wake could corrupt a live composer or execute text at a shell. "Absence of
 * spinner" is NOT treated as idle.
 */
export function isAgentPaneIdle(env: NodeJS.ProcessEnv, window: string): boolean {
  if (!isValidWindowName(window)) return false;
  if (!listTmuxWindows(env).includes(window)) return false;
  const session = resolveTmuxSession(env);
  const out = runTmux(buildCaptureViewportArgs(session, window));
  if (out === undefined) return false;
  // Second, raw (-e) capture: lets composerIsClean tell a Codex dim-hint
  // placeholder apart from real staged text. undefined (capture failed) reads
  // as "no dim available" -> the conservative dirty direction.
  const raw = runTmux(buildCaptureViewportRawArgs(session, window));
  return paneTextIsIdle(out, raw);
}

/**
 * paneAcceptsSend - true when it is SAFE to send-keys to this pane, even if a
 * turn is in flight. Differs from paneTextIsIdle in ONE way: an active working
 * spinner is NOT a skip condition. A busy pane with an EMPTY composer still
 * accepts the send: Claude Code queues the keystrokes and auto-submits them when
 * the current turn ends (verified live, TASK-537 / inbox-push parity).
 *
 * The ONLY skip conditions are:
 *   - no composer glyph present (a shell or unknown pane) -> don't send,
 *   - a REAL non-ghost composer entry (fails composerIsClean) -> would
 *     concatenate into half-typed text, and also covers permission dialogs
 *     ("U+276F 1. Yes"),
 *   - a stale/shell frame below the prompt (SHELL_PROMPT_RE) -> send-keys there
 *     would execute at a shell.
 *
 * Codex parity: a Codex composer always carries a rotating hint placeholder
 * after its U+203A glyph, which is NOT real staged text. Pass rawViewport (the
 * buildCaptureViewportRawArgs capture) so composerIsClean can recognise the
 * hint via its ANSI dim marker and accept the send; omit it and a Codex hint
 * pane conservatively reads dirty (skipped, never woken wrongly).
 *
 * Always paired with an inbox write upstream (threads.$agent.tsx persists the
 * block before the fire-and-forget push), so a skip is never a lost message.
 *
 * NOTE: Claude ghost / auto-suggest text still skips here (it fails the bare
 * check and, being un-dimmed today, is not treated as a hint). That is benign
 * (promptSuggestionEnabled=false team-wide, so ghosts never render). Ghost-aware
 * handling for Claude is deferred to TASK-535; do NOT add it here.
 */
export function paneAcceptsSend(viewport: string, rawViewport?: string): boolean {
  return composerIsClean(viewport, rawViewport);
}

/**
 * Live viewport probe for paneAcceptsSend. Parallel to isAgentPaneIdle but
 * calls paneAcceptsSend instead of paneTextIsIdle, so a busy pane whose
 * composer is empty still returns true (CC queues the keystroke and
 * auto-submits it at turn end).
 *
 * Returns false on ANY uncertainty: invalid name, window not live, capture
 * failure, a real non-ghost composer entry, a permission dialog, or a shell
 * frame below the prompt.
 */
export function paneAcceptsSendLive(env: NodeJS.ProcessEnv, window: string): boolean {
  if (!isValidWindowName(window)) return false;
  if (!listTmuxWindows(env).includes(window)) return false;
  const session = resolveTmuxSession(env);
  const out = runTmux(buildCaptureViewportArgs(session, window));
  if (out === undefined) return false;
  // Second, raw (-e) capture for the Codex dim-hint disambiguation (see
  // isAgentPaneIdle). undefined reads as the conservative dirty direction.
  const raw = runTmux(buildCaptureViewportRawArgs(session, window));
  return paneAcceptsSend(out, raw);
}

export type WakeResult = { woke: boolean; reason: "sent" | "active" | "send-failed" };

/**
 * Wake an agent so it picks up a just-delivered MC message at once. The
 * #78 Monitor-drop made hook-inject the sole DM surface, and hook-inject only
 * delivers on the agent's NEXT turn - an idle-but-alive agent takes no turn on
 * its own, so the DM would sit unseen. This fires a tmux send-keys poke,
 * prefixed [inbox from <user>], when the pane accepts a send (TASK-537).
 *
 * Gate: paneAcceptsSendLive - sends in every pane state EXCEPT a real non-ghost
 * composer entry, a permission dialog, or a stale shell frame. A BUSY pane with
 * an empty composer still receives the send: CC queues the keystroke and
 * auto-submits it when the current turn ends (verified live, TASK-537).
 *
 * A reply-hint is appended to the pane text so the recipient knows how to
 * respond via their inbox rather than replying in the terminal (TASK-532).
 * The hint format matches the agent-to-agent CLI push in packages/base
 * so both push paths look identical to the recipient.
 *
 * Callers should NOT await this (fire-and-forget): sendKeysToWindow sleeps
 * ~1s between text and Enter, and the operator's send must not block on it.
 * Never throws.
 */
export async function wakeIdleAgent(
  env: NodeJS.ProcessEnv,
  window: string,
  fromUser: string
): Promise<WakeResult> {
  if (!paneAcceptsSendLive(env, window)) return { woke: false, reason: "active" };
  const tag = isValidWindowName(fromUser) ? fromUser : "inkie-deck";
  const text = `[inbox from ${tag}] new message in Inkie Deck, check your inbox [reply via inbox: inbox reply ${tag}]`;
  const res = await sendKeysToWindow(env, window, text);
  return res.ok ? { woke: true, reason: "sent" } : { woke: false, reason: "send-failed" };
}

/**
 * Attachment markdown image reference inside a message body:
 *   ![alt](/attachments/<agent>/<thread>/<file>)
 * The URL segment is a WEB-relative HTTP route (MC serves it via
 * app/routes/attachments.$.tsx against ATTACHMENTS_ROOT). A browser resolves it
 * over HTTP; an agent reading the raw text in its pane cannot - it has no HTTP
 * client, it needs a real local filesystem path for its file/image-view tool.
 *
 * Conservative shape: only a "/attachments/<relPath>" URL that is the target of
 * a markdown image link ("![...](" immediately before it) is rewritten. Plain
 * prose that merely mentions "/attachments/foo" is left untouched. The relPath
 * run stops at the first ")" or whitespace, so a trailing markdown title
 * (![alt](/attachments/x "t")) is preserved as-is.
 */
const ATTACHMENT_IMG_RE = /(!\[[^\]]*\]\()\/attachments\/([^)\s]+)/g;

/**
 * Lexical containment test for a captured /attachments/ relPath. Returns true
 * when `${root}/${rel}` would resolve OUTSIDE the root, i.e. the relPath carries
 * enough `..` traversal to escape. Pure string maths, NO filesystem I/O: we
 * normalise `rel` against a synthetic single-segment root and reject anything
 * that lands at or above it.
 *
 * A single-segment synthetic root is the shallowest possible anchor, so this is
 * exactly equivalent to containment under the real (deeper) root: net upward
 * `..` movement escapes any root regardless of its depth, and a rel with no net
 * upward movement is contained by every root. Using `path.posix.join` (not
 * `resolve`) keeps a leading-slash rel relative, matching the `${root}/${rel}`
 * shape the rewrite actually emits.
 */
const SYNTHETIC_ROOT = "/__attachments_root__";
function relPathEscapesRoot(rel: string): boolean {
  const resolved = path.posix.normalize(path.posix.join(SYNTHETIC_ROOT, rel));
  return resolved !== SYNTHETIC_ROOT && !resolved.startsWith(SYNTHETIC_ROOT + "/");
}

/**
 * Rewrite web-relative /attachments/<relPath> markdown image references to
 * absolute filesystem paths rooted at attachmentsRoot, so an agent reading the
 * pushed text in its pane can pass the path to its own file/image-view tool.
 *
 * Pure + exported for direct unit testing. No-op (returns unchanged) when the
 * body carries no matching markdown image link. Handles multiple references in
 * one body.
 *
 * CONTAINMENT INVARIANT: a candidate relPath whose normalised form would escape
 * attachmentsRoot (any net `..` traversal, e.g. /attachments/../../etc/passwd)
 * is REJECTED per-match - that single reference is left completely UNCHANGED
 * (the original /attachments/... text is preserved, never rewritten to an
 * escaping path). Rejection is per-match, so other valid references in the same
 * body still rewrite normally, and the function never throws. The check is
 * lexical only (relPathEscapesRoot), so this function stays pure with no fs I/O.
 */
export function rewriteAttachmentPathsForAgentPane(
  text: string,
  attachmentsRoot: string
): string {
  const root = attachmentsRoot.replace(/\/+$/, "");
  return text.replace(
    ATTACHMENT_IMG_RE,
    (_m, pre: string, rel: string) =>
      relPathEscapesRoot(rel) ? _m : `${pre}${root}/${rel}`
  );
}

/**
 * Resolve ATTACHMENTS_ROOT and rewrite the body's attachment references for
 * live pane delivery. If resolveAttachmentsRoot throws (env var unset/relative
 * in some deployment), degrade gracefully: return the text UNCHANGED. A missing
 * env var must never crash a live wake push - leaving the web-relative path is
 * strictly no worse than the pre-fix behaviour. A one-time-per-call console.warn
 * surfaces a persistent misconfiguration (CodeRabbit nitpick, MR !18) rather
 * than silently degrading every push forever with no signal.
 */
export function resolveAndRewriteAttachmentPaths(text: string): string {
  try {
    const root = resolveAttachmentsRoot();
    return rewriteAttachmentPathsForAgentPane(text, root);
  } catch (err) {
    console.warn(
      `[tmux] ATTACHMENTS_ROOT unresolved, live-pushed attachment refs stay ` +
        `web-relative: ${err instanceof Error ? err.message : String(err)}`
    );
    return text;
  }
}

export type PushResult = { pushed: boolean };

/**
 * Push the actual chat-box text to an agent's pane (TASK-524, extended TASK-537).
 *
 * This is the text-carry complement to wakeIdleAgent: instead of a generic
 * "check your inbox" nudge, it delivers the operator's own message text
 * directly to the pane, prefixed [inbox from <fromUser>] so the agent sees both the
 * sender and the content in one shot.
 *
 * GATE: calls paneAcceptsSendLive before sending. If the pane does NOT accept
 * a send, returns { pushed: false } without touching the pane (no-op). The
 * inbox file write upstream already happened, so this is purely additive and
 * never worse than the pre-TASK-524 behaviour - the agent picks the message up
 * via hook-inject on its next turn exactly as before.
 *
 * paneAcceptsSendLive sends in every pane state EXCEPT a real non-ghost
 * composer entry, a permission dialog, or a stale shell frame. A BUSY pane
 * with an empty composer still receives the send: CC queues the keystroke and
 * auto-submits it when the current turn ends (TASK-537, verified live).
 *
 * A reply-hint is appended to the pane payload so the recipient knows how to
 * respond via their inbox rather than replying in the terminal (TASK-532).
 * The hint format matches the agent-to-agent CLI push in packages/base
 * for a consistent recipient experience.
 *
 * Payload construction, including the MARKED truncation, lives in
 * buildPanePayload - see the note there on why an unmarked cut was a data-loss
 * bug rather than a cosmetic one.
 *
 * Callers should NOT await this (fire-and-forget): sendKeysToWindow sleeps
 * ~1s between text and Enter, and the operator's send must not block on it.
 * Never throws. ASCII only - no em-dashes (FND-05).
 */
/**
 * Builds the exact pane payload for a pushed inbox message. Pure and exported
 * so the truncation behaviour is testable without a live pane.
 *
 * NUDGE, NEVER A SILENT PARTIAL (2026-07-26). This used to end in a bare
 * `head.slice(0, maxHead) + hint`, which cost 2974 characters of an Alex
 * brief with no way to notice. The hint was appended AFTER the cut, so a
 * truncated message still terminated in a well-formed
 * "[reply via inbox: ...]" footer and read as a complete, finished thought.
 * The one artefact that could have signalled loss was the one thing engineered
 * to always survive.
 *
 * A truncated message and a short message must not be indistinguishable.
 *
 * The agent-to-agent CLI (packages/base/bin/inbox) had already solved this, degrading
 * to a nudge rather than ever delivering a partial, and stating in its own
 * comment that a partial "could drop the important part". This path copied that
 * CLI's hint FORMAT for a consistent recipient experience and did not copy its
 * safety rule, which is why the principal's messages were the only ones being
 * cut.
 *
 * The two paths now agree on the BEHAVIOUR: nudge, never a partial. They do
 * NOT agree on the nudge CONTENT - this one reports a character count and the
 * read command, the CLI's is a subject nudge. That divergence is deliberate
 * and stated here rather than left for the next reader to discover, because
 * "consistent with the other path" is the exact claim that produced this bug.
 * The count is the better nudge and belongs in the CLI too; that is a change
 * to live fleet-wide comms and is proposed separately, not smuggled in here.
 *
 * sourceLength is what the RECIPIENT will find when they follow the nudge and
 * read the stored message. It is passed separately because `body` has already
 * been through resolveAndRewriteAttachmentPaths, which swaps /attachments/
 * URLs for longer absolute paths: reporting the rewritten length would
 * overstate the message on anything carrying an image, and a marker whose
 * number does not reconcile with the file is worth less than no marker.
 *
 * TWO DIFFERENT NUMBERS LIVE HERE AND THEY NEED DIFFERENT UNITS (2026-07-26).
 * They shared a unit only because they happened to share a variable:
 *
 *   1. THE CAP (SEND_KEYS_MAX_LEN, measured with String.length, UTF-16 code
 *      units). Its job is payload safety. UTF-16 OVER-estimates relative to
 *      code points for non-BMP characters, and over-estimating is the safe
 *      direction on a bound, so this stays exactly as it is.
 *
 *   2. THE REPORTED COUNT (sourceLength, CODE POINTS via spread). Its only job
 *      is to reconcile against what the recipient finds when they go and read
 *      the file. That reader is either a human, to whom an emoji is one
 *      character, or the-vault tooling, which is Python and counts code points.
 *      An emoji is 2 to UTF-16 and 1 to everyone who will ever check this
 *      number, so UTF-16 was simply the wrong unit for reporting.
 *
 * Before the split, this path and the CLI reported DIFFERENT counts for
 * identical text (off by the number of non-BMP characters). They now agree in
 * substance, not merely in wording.
 *
 * EXACTLY WHAT THE REPORTED NUMBER COUNTS, because a precise number invites
 * re-measurement and a mismatch reads as a bug (a re-count made 3025 into 3024 and
 * nearly filed one):
 *   - Code points of the stored message body.
 *   - INCLUDES a trailing newline if the stored body has one. That newline is
 *     invisible on screen, so counting only what you can SEE gives one less.
 *   - EXCLUDES the subject line, the "[inbox from x]" prefix and the hint.
 */
export function buildPanePayload(
  rawTag: string,
  body: string,
  sourceLength: number = [...body].length,
  dictated: boolean = false
): string {
  // Bound the tag so the capped-payload contract holds for ANY caller. The tag
  // appears three times in the nudge, so a pathological one could otherwise
  // push the payload over the cap on its own. Callers today pass a validated
  // window name, but this helper is exported and pure, so it defends itself.
  // Note the asymmetry: clamping a TAG is safe because it is a routing label,
  // whereas clamping a BODY is the exact data loss this function exists to
  // prevent. Truncating identifiers is not the same act as truncating content.
  const tag = rawTag.length > MAX_TAG_LEN ? rawTag.slice(0, MAX_TAG_LEN) : rawTag;
  const hint = ` [reply via inbox: inbox reply ${tag}]`;
  // DICTATION PROVENANCE (2026-08-11). The stored block already carries
  // "dictated: true" via rawMeta; this is the pane-side half, which was missing.
  // Dictation mangles words, and knowing text is transcribed changes both how a
  // reader decodes it and how they should answer it (ask, do not guess).
  //
  // AHEAD OF THE TEXT, not after: it changes how the following words are read, so
  // arriving late is arriving useless. Bracketed uppercase so it cannot be
  // mistaken for the message's own content.
  //
  // A PARAMETER RATHER THAN SOMETHING THE CALLER GLUES ONTO THE BODY, and this is
  // the load-bearing part: the over-cap branch below carries no body text at all,
  // so a body-prefixed marker would be silently eaten on exactly the messages that
  // most need it. A long dictated message is the likeliest to carry transcription
  // wonk AND the one the recipient is about to go and read in full.
  //
  // Excluded from sourceLength by the same contract that excludes the prefix and
  // the hint: the reported count has to keep reconciling with what `inbox read`
  // shows, or the number teaches the reader to distrust the mechanism.
  const mark = dictated ? "[DICTATED] " : "";
  const head = `[inbox from ${tag}] ${mark}${body}`;
  const maxHead = SEND_KEYS_MAX_LEN - hint.length;
  if (head.length <= maxHead) return head + hint;

  // OVER THE CAP: NUDGE, NEVER A PARTIAL.
  // Matching the agent-to-agent CLI rule exactly rather than merely resembling
  // it. A partial invites the recipient to act on two thirds of a brief and
  // report the job done; a nudge cannot be mistaken for a whole message.
  //
  // Deliberately carries NO body text and NO subject. Alex's subjects are
  // dictated and routinely stale or unrelated to the body (Quill's standing
  // calibration), so a subject-led nudge on his thread would be actively
  // misleading. The character count plus the read command is the whole payload:
  // it says only "there is more, here is how much, go and get it".
  return (
    `[inbox from ${tag}] ${mark}MESSAGE TOO LONG TO DELIVER IN FULL ` +
    `(${sourceLength} chars). Full text: inbox read ${tag}${hint}`
  );
}

export async function pushMessageToIdleAgent(
  env: NodeJS.ProcessEnv,
  window: string,
  fromUser: string,
  text: string,
  dictated: boolean = false
): Promise<PushResult> {
  try {
    if (!paneAcceptsSendLive(env, window)) return { pushed: false };
    const tag = isValidWindowName(fromUser) ? fromUser : "inkie-deck";
    // Rewrite web-relative /attachments/ image refs to real filesystem paths
    // BEFORE the length cap (the absolute path is longer than the URL, so it
    // must be counted against the cap). Degrades to the unchanged text if
    // ATTACHMENTS_ROOT is unset (never crashes the push).
    const body = resolveAndRewriteAttachmentPaths(text);
    // Report the PRE-rewrite length in CODE POINTS: that is what the recipient
    // sees in the stored thread when they follow the nudge and read it, and it
    // is the unit both a human reader and the Python tooling use. The cap keeps
    // UTF-16 units; see buildPanePayload on why these are two different numbers.
    const safe = buildPanePayload(tag, body, [...text].length, dictated);
    const res = await sendKeysToWindow(env, window, safe);
    return { pushed: res.ok };
  } catch {
    return { pushed: false };
  }
}
