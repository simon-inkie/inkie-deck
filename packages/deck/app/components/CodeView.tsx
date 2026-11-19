/**
 * CodeView.tsx - Syntax-highlighted code file renderer.
 *
 * Input: content (raw file text) + lang (highlight.js language id).
 * Highlights with highlight.js directly (v11, already installed as a direct
 * dep promoted from the transitive rehype-highlight chain).
 *
 * Rendering:
 *   - hljs.highlight(content, { language, ignoreIllegals: true }) with a
 *     fallback to hljs.highlightAuto for unknown languages.
 *   - Output is injected as innerHTML inside <pre><code class="hljs ...">
 *     (safe: highlight.js escapes file text and emits only span markup).
 *   - Monospace, overflow-x: auto (no wrap for long lines).
 *   - Line-number gutter rendered as a left column (CSS counter-based).
 *
 * Uses the .code-view .hljs* VS Code Dark Modern theme from app.css.
 * The .prose-mc Inkie palette is deliberately NOT applied here so fenced code
 * blocks in markdown docs keep the cream/teal look while code files get the
 * dark editor look.
 *
 * No .server imports - pure client component.
 * ASCII only - no em-dashes.
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

// Keep large review files usable without highlighting the entire payload or
// creating a DOM node for every line. The server's 2 MB read cap is a security
// bound, not a safe client-side syntax-highlighting budget.
const MAX_HIGHLIGHT_CHARS = 128 * 1024;
const MAX_GUTTER_LINES = 4_000;

export function shouldRenderPlainCode(content: string): boolean {
  if (content.length > MAX_HIGHLIGHT_CHARS) return true;

  let lines = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 && ++lines > MAX_GUTTER_LINES) return true;
  }
  return false;
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
 * can query them by line number without DOM changes here.
 */
export function CodeView({ content, lang }: CodeViewProps) {
  const plain = useMemo(() => shouldRenderPlainCode(content), [content]);
  const highlightedHtml = useMemo(
    () => plain ? null : highlightContent(content, lang),
    [content, lang, plain]
  );

  // Split the highlighted HTML into per-line spans.
  // highlight.js never emits raw newlines inside a span that wraps multiple
  // lines for common languages, so splitting on \n is reliable. We join the
  // lines as individual <span data-line> elements for future anchor support.
  const lineCount = useMemo(
    () => plain ? 0 : content.split("\n").length,
    [content, plain]
  );

  if (plain) {
    return (
      <div
        className="code-view"
        style={{ background: "#1f1f1f", color: "#d4d4d4", fontFamily: "var(--font-mono)", fontSize: "0.8125rem", lineHeight: "1.55" }}
      >
        <div className="px-3 py-2 text-xs text-muted-foreground">
          Large file: syntax highlighting and line numbers are off for responsiveness.
        </div>
        <pre
          data-testid="large-code-plain"
          style={{ margin: 0, padding: "0.75em", overflow: "auto", whiteSpace: "pre" }}
        >
          <code>{content}</code>
        </pre>
      </div>
    );
  }

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
          File text may come from an uploaded attachment. Only the output of
          highlightContent reaches dangerouslySetInnerHTML: highlight.js
          escapes text and emits span markup, and our fallback escapes text
          without adding markup. Never pass raw file text here.
        */}
        {/* eslint-disable-next-line react/no-danger */}
        <code
          className={`hljs language-${lang}`}
          style={{ background: "transparent", padding: 0, fontSize: "inherit" }}
          dangerouslySetInnerHTML={{ __html: highlightedHtml ?? "" }}
        />
      </pre>
    </div>
  );
}
