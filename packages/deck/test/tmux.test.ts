/**
 * test/tmux.test.ts - Unit tests for app/lib/tmux.server.ts (TASK-437).
 *
 * Covers:
 *   - Window-name validation matrix (ROSTER names pass; injection shapes fail).
 *   - buildCaptureArgs/buildListArgs pin the argv-ARRAY shape (the no-shell
 *     guarantee as a regression gate) including the "=" exact-match prefixes.
 *   - Session resolution: env-named, ROSTER-gated, default fallback.
 *   - Degradation: a guaranteed-missing session returns []/undefined.
 *   - WRITE POSTURE (v2): the send-keys argv builders are pinned (literal -l,
 *     "--" flag guard, exact target, Enter as a bare key), and
 *     sendKeysToWindow rejects bad input BEFORE any subprocess.
 *   - TMUX_EXEC_TIMEOUT_MS pinned (wedged tmux must not freeze the loop).
 *
 * No tmux required: argv builders are pure; live calls use a session name
 * that cannot exist, and every send assertion exercises a REJECTION path that
 * short-circuits before the subprocess (no keys are ever really sent here).
 * VALID-03: no repo writes.
 * ASCII only - no em-dashes (FND-05).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  rewriteAttachmentPathsForAgentPane,
  resolveAndRewriteAttachmentPaths,
  isValidWindowName,
  resolveTmuxSession,
  buildListArgs,
  buildCaptureArgs,
  buildSendKeysTextArgs,
  buildSendKeysEnterArgs,
  listTmuxWindows,
  captureTmuxPane,
  sendKeysToWindow,
  SEND_KEYS_MAX_LEN,
  TMUX_EXEC_TIMEOUT_MS,
  buildCaptureViewportArgs,
  ACTIVE_PANE_RE,
  paneTextIsActive,
  IDLE_PROMPT_RE,
  lineHasPromptGlyph,
  paneTextIsIdle,
  SHELL_PROMPT_RE,
  isAgentPaneIdle,
  paneAcceptsSend,
  buildCaptureViewportRawArgs,
} from "~/lib/tmux.server";

describe("isValidWindowName", () => {
  it("accepts ROSTER-convention names", () => {
    for (const ok of ["quill", "fern", "atlas", "summit", "sprout", "a-b-c", "9router"]) {
      expect(isValidWindowName(ok), ok).toBe(true);
    }
  });

  it("rejects injection-shaped and convention-violating names", () => {
    for (const bad of [
      "",
      "IO",
      "quill agent",
      "quill;ls",
      "quill$(x)",
      "../quill",
      "quill:0",
      "-quill",
      "quill\n",
      "agents:quill",
    ]) {
      expect(isValidWindowName(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("argv builders - the no-shell shape pinned", () => {
  it("buildListArgs returns a discrete argv array", () => {
    expect(buildListArgs("agents")).toEqual([
      "list-windows",
      "-t",
      "agents",
      "-F",
      "#{window_name}",
    ]);
  });

  it("buildCaptureArgs forces EXACT match on both target parts (platform-review fold) and captures scrollback", () => {
    expect(buildCaptureArgs("agents", "quill")).toEqual([
      "capture-pane",
      "-t",
      "=agents:=quill",
      "-p",
      "-S",
      "-1000",
    ]);
  });
});

describe("resolveTmuxSession", () => {
  it("uses MC_TMUX_SESSION when valid", () => {
    expect(resolveTmuxSession({ MC_TMUX_SESSION: "mc-e2e" })).toBe("mc-e2e");
  });

  it("defaults to agents when unset or empty", () => {
    expect(resolveTmuxSession({})).toBe("agents");
    expect(resolveTmuxSession({ MC_TMUX_SESSION: "  " })).toBe("agents");
  });

  it("falls back on ROSTER-violating values (argv can never start with -)", () => {
    for (const bad of ["-evil", "My Session", "a;b", "x:y"]) {
      expect(resolveTmuxSession({ MC_TMUX_SESSION: bad }), bad).toBe("agents");
    }
  });
});

describe("degradation - missing session is an empty state, never a throw", () => {
  const env = { MC_TMUX_SESSION: "mc-test-definitely-missing-0" };

  it("listTmuxWindows returns []", () => {
    expect(listTmuxWindows(env)).toEqual([]);
  });

  it("captureTmuxPane returns undefined (and rejects bad names pre-subprocess)", () => {
    expect(captureTmuxPane(env, "quill")).toBeUndefined();
    expect(captureTmuxPane(env, "quill;ls")).toBeUndefined();
    expect(captureTmuxPane(env, "../quill")).toBeUndefined();
  });
});

describe("write posture (v2 send-keys) - argv builders pinned", () => {
  it("buildSendKeysTextArgs sends LITERAL text with a -- flag guard and exact target", () => {
    expect(buildSendKeysTextArgs("agents", "quill", "hello there")).toEqual([
      "send-keys",
      "-t",
      "=agents:=quill",
      "-l",
      "--",
      "hello there",
    ]);
  });

  it("buildSendKeysTextArgs passes flag-shaped text as a literal operand, never an option", () => {
    // "--" upstream means a "-rf"-shaped message can never be read as a flag;
    // the discrete argv array (no shell) means it is one operand regardless.
    expect(buildSendKeysTextArgs("agents", "quill", "-rf")).toEqual([
      "send-keys",
      "-t",
      "=agents:=quill",
      "-l",
      "--",
      "-rf",
    ]);
  });

  it("buildSendKeysEnterArgs presses Enter as a key name (no -l) on the exact target", () => {
    expect(buildSendKeysEnterArgs("agents", "quill")).toEqual([
      "send-keys",
      "-t",
      "=agents:=quill",
      "Enter",
    ]);
  });
});

describe("sendKeysToWindow - gate before subprocess (no keys really sent here)", () => {
  const env = { MC_TMUX_SESSION: "mc-test-definitely-missing-0" };

  it("rejects invalid/injection-shaped window names", async () => {
    for (const bad of ["quill;ls", "../quill", "agents:quill", "-quill", ""]) {
      const r = await sendKeysToWindow(env, bad, "hi");
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("rejects empty / whitespace-only text", async () => {
    expect((await sendKeysToWindow(env, "quill", "")).ok).toBe(false);
    expect((await sendKeysToWindow(env, "quill", "   \n  ")).ok).toBe(false);
  });

  it("rejects over-length text", async () => {
    const huge = "x".repeat(SEND_KEYS_MAX_LEN + 1);
    expect((await sendKeysToWindow(env, "quill", huge)).ok).toBe(false);
  });

  it("rejects a well-formed name that is not live in the session", async () => {
    // Valid name, valid text, but the session cannot exist -> not allowlisted.
    const r = await sendKeysToWindow(env, "quill", "hello");
    expect(r.ok).toBe(false);
  });
});

describe("timeout", () => {
  it("subprocess timeout is pinned tight (wedged tmux must not freeze the loop)", () => {
    expect(TMUX_EXEC_TIMEOUT_MS).toBeLessThanOrEqual(500);
    expect(TMUX_EXEC_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("buildCaptureViewportArgs - viewport-only capture (no -S scrollback) (#91)", () => {
  it("returns the correct discrete argv array without scrollback flags", () => {
    expect(buildCaptureViewportArgs("agents", "quill")).toEqual([
      "capture-pane",
      "-t",
      "=agents:=quill",
      "-p",
    ]);
  });
});

describe("buildCaptureViewportRawArgs - raw (-e) viewport capture for the Codex dim-hint check", () => {
  it("returns the plain viewport argv plus -e (ANSI escapes preserved), exact target", () => {
    expect(buildCaptureViewportRawArgs("agents", "briar")).toEqual([
      "capture-pane",
      "-t",
      "=agents:=briar",
      "-p",
      "-e",
    ]);
  });
});

describe("paneTextIsActive - wake-on-idle gate (#91)", () => {
  const active = [
    "✳ Baking… (2m 33s · ↓ 9.0k tokens)",
    "· Working… (45s · ↑ 1.2k tokens)",
    "(esc to interrupt)",
    "  Esc to interrupt",
  ];
  const idle = [
    "\u276F ",
    "~/agents/summit  Opus 4.8  ctx:19%",
    "Opus 4.8 (1M context) │ quill ██░░ 28%",
    "⏵⏵ auto mode on (shift+tab to cycle)",
    "see commit (3 files) for detail",
  ];

  for (const sample of active) {
    it(`correctly identifies ACTIVE pane: ${JSON.stringify(sample)}`, () => {
      expect(paneTextIsActive(sample)).toBe(true);
    });
  }

  for (const sample of idle) {
    it(`correctly identifies IDLE pane: ${JSON.stringify(sample)}`, () => {
      expect(paneTextIsActive(sample)).toBe(false);
    });
  }

  it("ACTIVE_PANE_RE is exported and matches the same cases as paneTextIsActive", () => {
    expect(ACTIVE_PANE_RE.test("(esc to interrupt)")).toBe(true);
    expect(ACTIVE_PANE_RE.test("ctx:19%")).toBe(false);
  });
});

describe("paneTextIsIdle - positive clean-prompt gate (#91 false-positive fix)", () => {
  // WAKE: genuinely idle, bare empty composer prompt present
  const wake = [
    {
      label: "multi-line idle viewport (real briar capture shape)",
      text: "─────── briar ──\n\u276F \n────────\n  Opus 4.8 | briar\n  auto mode on (shift+tab to cycle)",
    },
    { label: "lone bare prompt with trailing space", text: "\u276F " },
    { label: "lone bare prompt no trailing space", text: "\u276F" },
    {
      label: "agy/Gemini runtime (bare > prompt)",
      text: "───\n>\n───\n? for shortcuts   Gemini 3.5 Flash (Medium) · 1 task(s)",
    },
  ];

  // NO WAKE: every unsafe state - dirty composer, permission dialog, bash shell, ghost
  const noWake = [
    {
      label: "dirty composer - staged text",
      text: "─── quill ──\n\u276F ping me when summit recommits\n───\n  Opus 4.8 | quill  32%",
    },
    { label: "dirty composer 2 - text after prompt", text: "\u276F do the folder reorg" },
    {
      label: "dirty agy composer - text after > prompt",
      text: "───\n> git status\n───\n? for shortcuts   Gemini 3.8 Flash",
    },
    {
      label: "permission dialog",
      text: "Do you want to proceed?\n\u276F 1. Yes\n  2. No",
    },
    {
      label: "bash shell - exited agent",
      text: "alex@demobox:~/agents/echo$ \nalex@demobox:~/agents/echo$ ",
    },
    {
      // Bash PS2 continuation: an unterminated quote renders a bare ">" with
      // the shell prompt ABOVE it and no agy frame border. Must NOT be woken.
      label: "bash PS2 continuation prompt (bare >)",
      text: 'alex@demobox:~/agents/echo$ echo "foo\n>',
    },
    {
      // node REPL left behind by an exited agent: a lone ">" prompt.
      label: "node REPL prompt (bare >)",
      text: "> \nundefined",
    },
    { label: "ghost/auto-suggest text after prompt", text: "\u276F /compact" },
    {
      label: "active spinner (no bare prompt)",
      text: "✻ Baking... (2m 33s · ↓ 9.0k tokens)\n  auto mode on",
    },
  ];

  for (const { label, text } of wake) {
    it(`WAKE - ${label}`, () => {
      expect(paneTextIsIdle(text)).toBe(true);
    });
  }

  for (const { label, text } of noWake) {
    it(`NO WAKE - ${label}`, () => {
      expect(paneTextIsIdle(text)).toBe(false);
    });
  }

  it("IDLE_PROMPT_RE matches a bare prompt with trailing space", () => {
    expect(IDLE_PROMPT_RE.test("\u276F ")).toBe(true);
  });

  it("IDLE_PROMPT_RE does NOT match a prompt with text after it", () => {
    expect(IDLE_PROMPT_RE.test("\u276F git status")).toBe(false);
  });

  // Codex's bare glyph (U+203A) is also a first-pass idle signal - the rare
  // truly-empty Codex composer. (Its usual idle state carries a rotating hint
  // and is handled by the dim-check, see the Codex describe block below.)
  it("IDLE_PROMPT_RE matches a bare Codex prompt glyph (U+203A)", () => {
    expect(IDLE_PROMPT_RE.test("\u203A ")).toBe(true);
    expect(IDLE_PROMPT_RE.test("\u203A do something real")).toBe(false);
  });

  it("IDLE_PROMPT_RE matches a bare agy prompt glyph (>)", () => {
    expect(IDLE_PROMPT_RE.test("> ")).toBe(true);
    expect(IDLE_PROMPT_RE.test(">")).toBe(true);
    expect(IDLE_PROMPT_RE.test("> do something real")).toBe(false);
  });

  // M1: a bare ">" is only an agy composer when the frame border sits above it.
  it("WAKE - agy frame: bare > with a border above is idle", () => {
    expect(paneTextIsIdle("───────\n>\n───────\n? for shortcuts   Gemini 3.8 Flash")).toBe(true);
  });

  it("NO WAKE - bare > with NO border above (PS2 continuation) is refused", () => {
    expect(paneTextIsIdle('alex@demobox:~/agents/echo$ echo "foo\n>')).toBe(false);
  });

  it("NO WAKE - bare > with output (node REPL) is refused", () => {
    expect(paneTextIsIdle("> \nundefined")).toBe(false);
  });

  // M2: a ">" in a statusline/footer must NOT hijack the last-glyph-line scan
  // for a Claude composer. lineHasPromptGlyph anchors ">" to the line start.
  it("WAKE - Claude composer with a > in the statusline below (must not hijack)", () => {
    expect(
      paneTextIsIdle(
        "\u276F \n──────\n  Opus 4.8 | main -> origin  32%"
      )
    ).toBe(true);
  });

  it("NO WAKE - Claude composer with a > in a footer, composer still dirty", () => {
    expect(
      paneTextIsIdle(
        "\u276F git checkout main\n  main -> origin  32%"
      )
    ).toBe(false);
  });

  // CRITICAL false-negative regression: idle agent with ctx-percent statusline
  // must NOT be mistaken for a shell prompt (SHELL_PROMPT_RE requires user@host)
  it("WAKE - idle with ctx:19% statusline below prompt (must not false-negative)", () => {
    expect(
      paneTextIsIdle(
        "\u276F \n\u2500\u2500\u2500\u2500\u2500\u2500 summit \u2500\u2500\n  ~/agents/summit  Opus 4.8  ctx:19%\n  auto mode on (shift+tab to cycle)"
      )
    ).toBe(true);
  });

  it("WAKE - idle with ctx:20% statusline (bare)", () => {
    expect(paneTextIsIdle("\u276F \n  Opus 4.8  ctx:20%")).toBe(true);
  });

  // Stale-shell guard: exited agent leaves old composer frame with bash prompt below
  it("NO WAKE - stale frame: bash prompt below the glyph", () => {
    expect(
      paneTextIsIdle(
        "\u276F \n\u2500\u2500\u2500\n  Opus 4.8  ctx:19%\nResume this session with:\nalex@demobox:~/agents/echo$ "
      )
    ).toBe(false);
  });

  it("NO WAKE - pure bash, no glyph (promptIndex == -1)", () => {
    expect(
      paneTextIsIdle(
        "alex@demobox:~/agents/echo$ \nalex@demobox:~/agents/echo$ "
      )
    ).toBe(false);
  });

  // Scrollback hole: bare prompt in history above DIRTY active composer
  it("NO WAKE - scrollback: old bare glyph above active dirty composer", () => {
    expect(
      paneTextIsIdle(
        "\u276F \n  earlier output\n\u2500\u2500\u2500\n\u276F git checkout main\n\u2500\u2500\u2500\n  Opus 4.8 | quill"
      )
    ).toBe(false);
  });

  // Still-passes: bare in history AND bare active
  it("WAKE - bare prompt in history AND bare active composer", () => {
    expect(
      paneTextIsIdle(
        "\u276F \n  earlier\n\u2500\u2500\u2500\n\u276F \n\u2500\u2500\u2500\n  Opus 4.8 | briar"
      )
    ).toBe(true);
  });

  // SHELL_PROMPT_RE direct assertions
  it("lineHasPromptGlyph anchors > to the line start, keeps includes for TUI glyphs", () => {
    expect(lineHasPromptGlyph("> ")).toBe(true);
    expect(lineHasPromptGlyph("  > ")).toBe(true);
    expect(lineHasPromptGlyph("main -> origin")).toBe(false);
    expect(lineHasPromptGlyph("a => b")).toBe(false);
    expect(lineHasPromptGlyph("\u276F ")).toBe(true);
    expect(lineHasPromptGlyph("prefix \u203A")).toBe(true);
  });

  it("SHELL_PROMPT_RE matches a user@host bash prompt", () => {
    expect(SHELL_PROMPT_RE.test("alex@demobox:~/agents/echo$")).toBe(true);
  });

  it("SHELL_PROMPT_RE does NOT match a Claude ctx-percent statusline", () => {
    expect(SHELL_PROMPT_RE.test("  Opus 4.8  ctx:19%")).toBe(false);
  });
});

describe("isAgentPaneIdle - degradation (#91)", () => {
  const env = { MC_TMUX_SESSION: "mc-test-definitely-missing-0" };

  it("returns false for a valid name when the session is missing (window not live)", () => {
    expect(isAgentPaneIdle(env, "quill")).toBe(false);
  });

  it("returns false for injection-shaped names before any subprocess call", () => {
    expect(isAgentPaneIdle(env, "quill;ls")).toBe(false);
    expect(isAgentPaneIdle(env, "../quill")).toBe(false);
  });
});

describe("paneAcceptsSend - send gate that allows BUSY panes (TASK-537)", () => {
  // The spinner marker shared across busy-pane fixtures (matches ACTIVE_PANE_RE)
  const spinnerLine = "✓ Working... (5s · ↓ 1.2k tokens)";

  // KEY NEW BEHAVIOUR: busy pane with empty composer -> TRUE
  // paneTextIsIdle must return FALSE for the same fixture (regression guard)
  it("BUSY + empty composer -> TRUE (key TASK-537 behaviour)", () => {
    const viewport = [
      "────── quill ──",
      spinnerLine,
      "  some output",
      "❯ ",
      "──────",
      "  Opus 4.8 | quill  28%",
    ].join("\n");
    expect(paneTextIsIdle(viewport)).toBe(false); // spinner blocks idle
    expect(paneAcceptsSend(viewport)).toBe(true);  // but send is still safe
  });

  // Busy pane with (esc to interrupt) marker - also matches ACTIVE_PANE_RE
  it("BUSY via 'esc to interrupt' + empty composer -> TRUE", () => {
    const viewport = [
      "(esc to interrupt)",
      "  processing...",
      "❯ ",
      "  Opus 4.8 | atlas  ctx:42%",
    ].join("\n");
    expect(paneTextIsIdle(viewport)).toBe(false);
    expect(paneAcceptsSend(viewport)).toBe(true);
  });

  // BUSY + real composer text -> FALSE (would concatenate into live composer)
  it("BUSY + real composer text -> FALSE", () => {
    const viewport = [
      spinnerLine,
      "❯ git checkout main",
      "  Opus 4.8 | quill  28%",
    ].join("\n");
    expect(paneAcceptsSend(viewport)).toBe(false);
  });

  // Idle + empty composer -> TRUE (same as paneTextIsIdle for idle pane)
  it("idle + empty composer -> TRUE", () => {
    const viewport = [
      "────── summit ──",
      "❯ ",
      "  ~/agents/summit  Opus 4.8  ctx:19%",
      "  auto mode on (shift+tab to cycle)",
    ].join("\n");
    expect(paneAcceptsSend(viewport)).toBe(true);
  });

  // NBSP rest-state: last glyph line is U+276F + U+00A0 (IDLE_PROMPT_RE uses \s which matches NBSP)
  it("NBSP rest-state: glyph + NBSP -> TRUE", () => {
    const viewport = "❯  ";
    expect(paneAcceptsSend(viewport)).toBe(true);
  });

  // Permission dialog: last glyph line has text after prompt -> FALSE
  it("permission dialog (last glyph line has text) -> FALSE", () => {
    const viewport = [
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
    ].join("\n");
    expect(paneAcceptsSend(viewport)).toBe(false);
  });

  // Dirty composer -> FALSE
  it("dirty composer -> FALSE", () => {
    expect(paneAcceptsSend("❯ do the folder reorg")).toBe(false);
  });

  // Shell prompt line below the composer -> FALSE (stale frame guard)
  it("shell prompt line below composer (stale frame) -> FALSE", () => {
    const viewport = [
      "❯ ",
      "───",
      "  Opus 4.8  ctx:19%",
      "Resume this session with:",
      "alex@demobox:~/agents/echo$ ",
    ].join("\n");
    expect(paneAcceptsSend(viewport)).toBe(false);
  });

  // No glyph at all (pure shell) -> FALSE
  it("no prompt glyph (pure shell) -> FALSE", () => {
    const viewport = [
      "alex@demobox:~/agents/echo$ ",
      "alex@demobox:~/agents/echo$ ",
    ].join("\n");
    expect(paneAcceptsSend(viewport)).toBe(false);
  });

  // Scrollback hole: bare prompt in history above dirty active composer -> FALSE
  it("scrollback: bare glyph in history above dirty active composer -> FALSE", () => {
    const viewport = [
      "❯ ",
      "  earlier output",
      "───",
      "❯ git checkout main",
      "───",
      "  Opus 4.8 | quill",
    ].join("\n");
    expect(paneAcceptsSend(viewport)).toBe(false);
  });

  // ctx:19% statusline below idle prompt must NOT false-negative (SHELL_PROMPT_RE check)
  it("idle with ctx:19% statusline below prompt -> TRUE (no false-negative)", () => {
    const viewport = [
      "❯ ",
      "────── summit ──",
      "  ~/agents/summit  Opus 4.8  ctx:19%",
      "  auto mode on (shift+tab to cycle)",
    ].join("\n");
    expect(paneAcceptsSend(viewport)).toBe(true);
  });
});

describe("rewriteAttachmentPathsForAgentPane - web-relative /attachments/ -> real fs path", () => {
  const ROOT = "/home/you/mc-test-inbox/assets";

  it("rewrites a single markdown image attachment reference", () => {
    const input = "here you go ![diagram.png](/attachments/briar/mc/diagram.png)";
    expect(rewriteAttachmentPathsForAgentPane(input, ROOT)).toBe(
      "here you go ![diagram.png](/home/you/mc-test-inbox/assets/briar/mc/diagram.png)"
    );
  });

  it("rewrites multiple attachment references in one body", () => {
    const input =
      "![a.png](/attachments/briar/mc/a.png) and ![b.png](/attachments/quill/mc/b.png)";
    expect(rewriteAttachmentPathsForAgentPane(input, ROOT)).toBe(
      "![a.png](/home/you/mc-test-inbox/assets/briar/mc/a.png) and " +
        "![b.png](/home/you/mc-test-inbox/assets/quill/mc/b.png)"
    );
  });

  it("no-attachment body passes through unchanged", () => {
    const input = "just a plain message with no image at all";
    expect(rewriteAttachmentPathsForAgentPane(input, ROOT)).toBe(input);
  });

  it("does NOT rewrite prose that mentions /attachments/ outside an image link", () => {
    // Bare prose, and a NON-image link (no leading !) - both left untouched.
    const input =
      "the file lives under /attachments/briar and see [notes](/attachments/briar/mc/n.md)";
    expect(rewriteAttachmentPathsForAgentPane(input, ROOT)).toBe(input);
  });

  it("strips a trailing slash on the root (no double slash)", () => {
    const input = "![x.png](/attachments/briar/mc/x.png)";
    expect(rewriteAttachmentPathsForAgentPane(input, ROOT + "/")).toBe(
      "![x.png](/home/you/mc-test-inbox/assets/briar/mc/x.png)"
    );
  });

  it("leaves a deep traversal reference UNCHANGED (does not escape the root)", () => {
    // Path-traversal attempt: rewriting this would produce an absolute path
    // outside attachmentsRoot. Reject -> leave the original text verbatim.
    const input = "![x](/attachments/../../../etc/passwd)";
    expect(rewriteAttachmentPathsForAgentPane(input, ROOT)).toBe(input);
  });

  it("leaves a single-dot-dot traversal reference UNCHANGED (one .. still escapes)", () => {
    const input = "![x](/attachments/../secret)";
    expect(rewriteAttachmentPathsForAgentPane(input, ROOT)).toBe(input);
  });

  it("rejects PER-MATCH: rewrites the legit ref, leaves the traversal one", () => {
    const input =
      "![ok.png](/attachments/briar/mc/ok.png) and ![bad](/attachments/../../etc/passwd)";
    expect(rewriteAttachmentPathsForAgentPane(input, ROOT)).toBe(
      "![ok.png](/home/you/mc-test-inbox/assets/briar/mc/ok.png) and " +
        "![bad](/attachments/../../etc/passwd)"
    );
  });

  it("still rewrites a legit deeply-nested relPath (no .., fix is not overly broad)", () => {
    const input = "![x.png](/attachments/briar/mc/sub/deeper/x.png)";
    expect(rewriteAttachmentPathsForAgentPane(input, ROOT)).toBe(
      "![x.png](/home/you/mc-test-inbox/assets/briar/mc/sub/deeper/x.png)"
    );
  });

  it("still rewrites a contained .. (resolves back inside root, reject is escape-specific)", () => {
    // A .. that stays inside the root is safe and must NOT be blanket-banned.
    const input = "![x.png](/attachments/briar/../mc/x.png)";
    expect(rewriteAttachmentPathsForAgentPane(input, ROOT)).toBe(
      "![x.png](/home/you/mc-test-inbox/assets/briar/../mc/x.png)"
    );
  });
});

describe("resolveAndRewriteAttachmentPaths - env-backed resolve with graceful fall-back", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rewrites using ATTACHMENTS_ROOT from the environment", () => {
    vi.stubEnv("ATTACHMENTS_ROOT", "/home/you/mc-test-inbox/assets");
    expect(
      resolveAndRewriteAttachmentPaths("![p.png](/attachments/briar/mc/p.png)")
    ).toBe("![p.png](/home/you/mc-test-inbox/assets/briar/mc/p.png)");
  });

  it("falls back to UNCHANGED text when ATTACHMENTS_ROOT is unset (resolve throws)", () => {
    vi.stubEnv("ATTACHMENTS_ROOT", "");
    const input = "![p.png](/attachments/briar/mc/p.png)";
    expect(resolveAndRewriteAttachmentPaths(input)).toBe(input);
  });
});

describe("Codex runtime (U+203A glyph + ANSI dim-hint disambiguation)", () => {
  // Real captured Codex pane fixtures, ported byte-for-byte from
  // packages/base/test/inbox-push.test.sh (proven accurate against a live pane capture,
  // 2026-07-17/18). Bash $'...' octal/UTF-8 bytes converted to JS escapes:
  //   \xe2\x80\xba -> › (Codex glyph), \xc2\xb7 -> · (middot),
  //   \xe2\x80\xa2 -> • (bullet), \xe2\x97\xa6 -> ◦ (working glyph),
  //   \033 -> \x1b (ESC). The dim marker \x1b[2m must survive verbatim in RAW.
  const CODEX_IDLE =
    "some transcript\n\n› Implement {feature}\n\n  gpt-5.6-sol default · ~/agents/briar";
  const CODEX_BUSY =
    "◦ Working (2s • esc to interrupt)\n\n\n› Implement {feature}";
  const CODEX_STAGED =
    "some transcript\n\n› do something real\n\n  gpt-5.6-sol default · ~/agents/briar";
  const CODEX_IDLE_ROTATING_HINT =
    "some transcript\n\n› Run /review on my current changes\n\n  gpt-5.6-sol default · ~/agents/briar";
  const CODEX_IDLE_ROTATING_HINT_RAW =
    "some transcript\n\n\x1b[1m›\x1b[0m\x1b[48;5;235m \x1b[2mRun /review on my current changes\x1b[0m\x1b[48;5;235m \n\n  gpt-5.6-sol default · ~/agents/briar";

  // Guard: the disambiguator hinges on the dim SGR being byte-exact in RAW.
  it("RAW fixture carries the ANSI dim marker on the composer, plain does not", () => {
    expect(CODEX_IDLE_ROTATING_HINT_RAW.includes("\x1b[2m")).toBe(true);
    expect(CODEX_IDLE_ROTATING_HINT.includes("\x1b[2m")).toBe(false);
  });

  // --- IDLE (positive): a dim hint reads clean ONLY when the raw capture is
  // supplied; the second rotating-hint string proves it is the GENERAL dim
  // check, not a hardcoded-literal match. ---
  it("IDLE - rotating-hint composer + raw dim capture -> idle=true, acceptsSend=true", () => {
    expect(paneTextIsIdle(CODEX_IDLE_ROTATING_HINT, CODEX_IDLE_ROTATING_HINT_RAW)).toBe(true);
    // The accept path never inspects the spinner, so this same true result is
    // the "busy-but-queueable" acceptsSend proof (composition per the SPEC's
    // "matching Claude Code's existing semantics"): a busy Codex pane's composer
    // is recognised identically to this idle one.
    expect(paneAcceptsSend(CODEX_IDLE_ROTATING_HINT, CODEX_IDLE_ROTATING_HINT_RAW)).toBe(true);
  });

  // --- Fallback limit: WITHOUT the raw capture a hint is indistinguishable from
  // staged text and conservatively reads dirty (mirrors inbox-push.test.sh (e)).
  // CODEX_IDLE ("Implement {feature}") reading dirty here also proves NO
  // hardcoded-literal fast-path was ported - that literal would false-pass it. ---
  it("no raw capture -> hint reads dirty (idle=false, acceptsSend=false); no hardcoded literal", () => {
    expect(paneTextIsIdle(CODEX_IDLE_ROTATING_HINT)).toBe(false);
    expect(paneAcceptsSend(CODEX_IDLE_ROTATING_HINT)).toBe(false);
    expect(paneTextIsIdle(CODEX_IDLE)).toBe(false);
    expect(paneAcceptsSend(CODEX_IDLE)).toBe(false);
  });

  // --- BUSY: the working spinner ("esc to interrupt", already runtime-agnostic)
  // blocks idle. ---
  it("BUSY - working spinner -> idle=false", () => {
    expect(paneTextIsActive(CODEX_BUSY)).toBe(true);
    expect(paneTextIsIdle(CODEX_BUSY)).toBe(false);
  });

  // --- STAGED: real typed text (no dim wrapping) is dirty. Test BOTH the
  // no-raw fallback AND the live path (raw present). The live path is the
  // safety-critical discriminator: a raw capture that carries NO dim SGR must
  // still read dirty, or MC would send-keys into a half-typed composer. Real
  // staged text has no dim, so CODEX_STAGED doubles as its own no-dim raw. ---
  it("STAGED - real composer text, no raw -> idle=false, acceptsSend=false", () => {
    expect(paneTextIsIdle(CODEX_STAGED)).toBe(false);
    expect(paneAcceptsSend(CODEX_STAGED)).toBe(false);
  });

  it("STAGED - real composer text WITH raw (no dim) -> stays dirty (the crux direction)", () => {
    expect(paneTextIsIdle(CODEX_STAGED, CODEX_STAGED)).toBe(false);
    expect(paneAcceptsSend(CODEX_STAGED, CODEX_STAGED)).toBe(false);
  });

  // --- Rare truly-bare Codex composer: the bare U+203A glyph reads idle via the
  // first-pass IDLE_PROMPT_RE, no raw capture needed. ---
  it("bare U+203A composer -> idle=true, acceptsSend=true", () => {
    expect(paneTextIsIdle("› ")).toBe(true);
    expect(paneAcceptsSend("› ")).toBe(true);
  });
});
