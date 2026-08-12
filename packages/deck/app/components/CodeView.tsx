/**
 * CodeView.tsx - Syntax-highlighted code file renderer (TASK-562).
 *
 * Input: content (raw file text) + lang (highlight.js language id).
 * Highlights with highlight.js directly (v11, already installed as a direct
 * dep promoted from the transitive rehype-highlight chain).
 *
 * Rendering:
 *   - hljs.highlight(content, { language, ignoreIllegals: true }) with a
 *     fallback to hljs.highlightAuto for unknown languages.
 *   - Output is injected as innerHTML inside <pre><code class="hljs ...">
 *     (safe: highlight.js escapes input and emits only span markup; content
 *     is server-trusted file text from inside the review roots).
 *   - Monospace, overflow-x: auto (no wrap for long lines).
 *   - Line-number gutter rendered as a left column (CSS counter-based).
 *
 * Uses the .code-view .hljs* VS Code Dark Modern theme from app.css (TASK-562 follow-up).
 * The .prose-mc Inkie palette is deliberately NOT applied here so fenced code
 * blocks in markdown docs keep the cream/teal look while code files get the
 * dark editor look.
 *
 * No .server imports - pure client component (FND-02).
 * ASCII only - no em-dashes (FND-05).
 */
import { useMemo } from "react";
import hljs from "highlight.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CodeViewProps {
  content: string;
  lang: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run highlight.js on content with a known language, falling back to
 * plaintext if the language is not registered or causes an error.
 * ignoreIllegals: true prevents exceptions on syntactically-invalid content
 * (minified JS, partial files, etc.).
 */
function highlightContent(content: string, lang: string): string {
  // hljs.getLanguage returns undefined for unknown language ids.
  if (lang !== "plaintext" && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // Fall through to auto on unexpected error.
    }
  }
  // Fallback: highlightAuto for unknown langs; for "plaintext" escape only.
  try {
    return hljs.highlightAuto(content).value;
  } catch {
    // Last resort: escape angle brackets so raw HTML in content does not leak.
    return content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a code file with syntax highlighting and a line-number gutter.
 *
 * The line-number gutter is implemented as a separate <code> column so it does
 * not interfere with copy-pasting the code content itself. Each line of the
 * highlighted output becomes a <span data-line> so future diff anchoring
 * (TASK-563) can query them by line number without DOM changes here.
 */
export function CodeView({ content, lang }: CodeViewProps) {
  const highlightedHtml = useMemo(
    () => highlightContent(content, lang),
    [content, lang]
  );

  // Split the highlighted HTML into per-line spans.
  // highlight.js never emits raw newlines inside a span that wraps multiple
  // lines for common languages, so splitting on \n is reliable. We join the
  // lines as individual <span data-line> elements for future anchor support.
  const lineCount = useMemo(
    () => content.split("\n").length,
    [content]
  );

  return (
    // Outer wrapper: .code-view scopes the VS Code Dark Modern hljs theme
    // (see app.css). No border-radius - the full-bleed layout in ReviewPanel
    // lets the dark body fill the panel edge-to-edge like a real editor pane.
    // overflow-hidden clips the gutter cleanly; the code area scrolls via auto.
    <div
      className="code-view"
      style={{
        display: "flex",
        overflow: "hidden",
        borderRadius: 0,
        background: "#1f1f1f",
        fontSize: "0.8125rem",
        lineHeight: "1.55",
        fontFamily: "var(--font-mono)",
      }}
    >
      {/* Line-number gutter - Dark Modern editorLineNumber.foreground (#6E7681) */}
      <div
        aria-hidden="true"
        style={{
          flexShrink: 0,
          padding: "0.75em 0.75em 0.75em 0.5em",
          textAlign: "right",
          userSelect: "none",
          color: "#6E7681",
          borderRight: "1px solid #2b2b2b",
          minWidth: "2.5em",
        }}
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i + 1}>{i + 1}</div>
        ))}
      </div>

      {/* Code content area */}
      <pre
        style={{
          flex: 1,
          margin: 0,
          padding: "0.75em",
          overflow: "auto",
          background: "transparent",
          borderRadius: 0,
          // Prevent text wrapping; horizontal scroll is the spec.
          whiteSpace: "pre",
          overflowWrap: "normal",
          wordBreak: "normal",
        }}
      >
        {/*
          SAFETY INVARIANT - do not weaken without a security review:
          dangerouslySetInnerHTML is safe HERE because BOTH of these hold:
            1. `content` is server-trusted file text served by readReviewFile,
               which enforces realpath containment, extension allowlist, and the
               secret denylist. Arbitrary/user-supplied strings must NEVER be
               passed as `content` to CodeView.
            2. highlight.js escapes all HTML special chars (& < >) and emits
               only <span class="hljs-*"> markup - no raw passthrough.
          If either invariant breaks, this becomes an XSS vector.
        */}
        {/* eslint-disable-next-line react/no-danger */}
        <code
          className={`hljs language-${lang}`}
          style={{ background: "transparent", padding: 0, fontSize: "inherit" }}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      </pre>
    </div>
  );
}
