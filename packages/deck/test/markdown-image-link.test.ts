/**
 * markdown-image-link.test.ts - Regression tests for chat image link/embed
 * resolution.
 *
 * The bug: a teammate sends a markdown link to a local image, e.g.
 *   [different-view (imp)](~/git-repos/inkie-briar/content/render-pass-two.png)
 * Clicking it opened http://localhost:PORT/threads/~/... because the browser
 * resolved the raw "~/..." href as a relative URL against the current page.
 *
 * The vitest environment is "node" (no jsdom), but react-dom/server's
 * renderToStaticMarkup renders react-markdown to an HTML string without a DOM,
 * so we can pin the actual rendered href/src rather than inspecting source.
 *
 * No JSX here: the file is a .test.ts (the vitest include glob is *.test.ts),
 * so components are constructed via React.createElement.
 *
 * ASCII only - no em-dashes.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "~/components/Markdown";

function render(md: string, props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    React.createElement(Markdown, { children: md, ...props })
  );
}

/**
 * Extracts the first /api/review-asset "path" query value from rendered HTML
 * and decodes it ONE layer (mirroring the server's URLSearchParams.get). The
 * result is the filesystem path the server would actually look up.
 */
function resolvedServerPath(html: string): string | null {
  const m = html.match(/\/api\/review-asset\?path=([^"&]+)/);
  if (!m || m[1] === undefined) return null;
  return decodeURIComponent(m[1]);
}

describe("Markdown - path-shaped image link (the reported regression)", () => {
  const path = "~/git-repos/inkie-briar/content/diagrams/render-pass-two.png";

  it("resolves a [text](~/image.png) link through /api/review-asset, not the raw path", () => {
    const html = render(`[different-view (imp)](${path})`);
    // The fix: href points at the review-asset endpoint with the path encoded.
    expect(html).toContain("/api/review-asset?path=");
    expect(html).toContain(`href="/api/review-asset?path=${encodeURIComponent(path)}"`);
    // The regression: the raw "~/" path must NOT be the href.
    expect(html).not.toContain(`href="${path}"`);
    // Opens in a new tab, no panel behaviour.
    expect(html).toContain('target="_blank"');
    // The link text is preserved.
    expect(html).toContain("different-view (imp)");
  });

  it("resolves an absolute /path.jpg link the same way", () => {
    const abs = "/home/you/pics/shot.jpg";
    const html = render(`[shot](${abs})`);
    expect(html).toContain(`href="/api/review-asset?path=${encodeURIComponent(abs)}"`);
    expect(html).not.toContain(`href="${abs}"`);
  });

  it("strips the query string from the path param (image.png?v=2)", () => {
    const base = "~/pics/shot.png";
    const html = render(`[shot](${base}?v=2)`);
    // The server path param is the bare file path, not the raw "?v=2" string.
    expect(html).toContain(`href="/api/review-asset?path=${encodeURIComponent(base)}"`);
    expect(html).not.toContain(encodeURIComponent(`${base}?v=2`));
  });

  it("strips the fragment from the path param (image.png#frag)", () => {
    const base = "/home/you/pics/shot.png";
    const html = render(`[shot](${base}#frag)`);
    expect(html).toContain(`href="/api/review-asset?path=${encodeURIComponent(base)}"`);
    expect(html).not.toContain(encodeURIComponent(`${base}#frag`));
  });

  it("does NOT rewrite a non-image doc link (still a review-panel / plain link)", () => {
    const href = "~/brain/notes.md";
    const html = render(`[notes](${href})`);
    // No onOpenDoc callback, so a path-shaped doc link falls to the plain
    // anchor - and it must not be routed through review-asset. Pin the plain
    // href so a dropped/replaced link cannot pass this test silently.
    expect(html).not.toContain("/api/review-asset");
    expect(html).toContain(`href="${href}"`);
  });

  it("does NOT rewrite a protocol-relative external image link", () => {
    const href = "//cdn.example.com/x.png";
    const html = render(`[cdn](${href})`);
    expect(html).not.toContain("/api/review-asset");
    expect(html).toContain(`href="${href}"`);
  });

  it("does NOT rewrite an external https image link", () => {
    const html = render("[pic](https://example.com/x.png)");
    expect(html).not.toContain("/api/review-asset");
    expect(html).toContain('href="https://example.com/x.png"');
  });
});

describe("Markdown - path-shaped image EMBED (![alt](~/image.png))", () => {
  it("resolves an image embed through /api/review-asset in a plain message", () => {
    const src = "~/pics/diagram.png";
    const html = render(`![a diagram](${src})`);
    expect(html).toContain(`/api/review-asset?path=${encodeURIComponent(src)}`);
    // Wrapped in an anchor to the same resolved URL (open full image in new tab).
    expect(html).toContain('target="_blank"');
    expect(html).toContain("<img");
    // Raw src must not survive.
    expect(html).not.toContain(`src="${src}"`);
  });

  it("strips the query/fragment from an embed's path param", () => {
    const base = "~/pics/diagram.png";
    const htmlQuery = render(`![d](${base}?v=2)`);
    expect(htmlQuery).toContain(`/api/review-asset?path=${encodeURIComponent(base)}`);
    expect(htmlQuery).not.toContain(encodeURIComponent(`${base}?v=2`));
    const htmlFrag = render(`![d](${base}#frag)`);
    expect(htmlFrag).toContain(`/api/review-asset?path=${encodeURIComponent(base)}`);
    expect(htmlFrag).not.toContain(encodeURIComponent(`${base}#frag`));
  });

  it("keeps a doc-relative embed working when reviewDocBasePath is set", () => {
    const html = render("![rel](images/inline.png)", {
      reviewDocBasePath: "~/brain/docs",
    });
    expect(html).toContain(
      `/api/review-asset?path=${encodeURIComponent("~/brain/docs/images/inline.png")}`
    );
  });

  it("resolves a ~/-rooted embed even when reviewDocBasePath is set (regardless-of-context)", () => {
    // Regression guard for the ordering fix: a tilde-rooted src must resolve to
    // its OWN path, not be mangled onto the doc base path.
    const src = "~/pics/diagram.png";
    const html = render(`![d](${src})`, { reviewDocBasePath: "~/brain/docs" });
    expect(html).toContain(`/api/review-asset?path=${encodeURIComponent(src)}`);
    expect(html).not.toContain(encodeURIComponent("~/brain/docs/~/pics/diagram.png"));
  });

  it("resolves an absolute-rooted embed to its own path when reviewDocBasePath is set", () => {
    // Same ordering guard for a "/"-rooted src: must not be prefixed with the
    // doc base path.
    const src = "/pics/diagram.png";
    const html = render(`![d](${src})`, { reviewDocBasePath: "~/brain/docs" });
    expect(html).toContain(`/api/review-asset?path=${encodeURIComponent(src)}`);
    expect(html).not.toContain(encodeURIComponent("~/brain/docs//pics/diagram.png"));
  });
});

// ---------------------------------------------------------------------------
// Image paths containing SPACES (double-encode regression, review finding).
//
// react-markdown serialises both an angle-bracket destination
// ("<~/pics/my image.png>") and an already-encoded destination
// ("~/pics/my%20image.png") into an href/src prop that already contains "%20".
// A naive encodeURIComponent on top double-encodes ("%20" -> "%2520"); the
// server peels one layer and looks up a file literally containing "%20", which
// does not exist (404). The fix decodes one layer before encoding, so the
// server recovers the real path with a real space character.
// ---------------------------------------------------------------------------
describe("Markdown - image paths with spaces (double-encode regression)", () => {
  const realPath = "~/pics/my image.png"; // the actual file on disk (real space)

  const linkCases: Array<[string, string]> = [
    ["angle-bracket link", "[x](<~/pics/my image.png>)"],
    ["already-encoded link", "[x](~/pics/my%20image.png)"],
  ];
  for (const [label, md] of linkCases) {
    it(`${label}: server path decodes to the real space, not a literal %20`, () => {
      const html = render(md);
      const serverPath = resolvedServerPath(html);
      expect(serverPath).toBe(realPath);
      // Guard against the double-encode signature ("%2520") and the literal
      // "%20" surviving into the recovered path.
      expect(html).not.toContain("my%2520image.png");
      expect(serverPath).not.toContain("%20");
    });
  }

  const embedCases: Array<[string, string]> = [
    ["angle-bracket embed", "![x](<~/pics/my image.png>)"],
    ["already-encoded embed", "![x](~/pics/my%20image.png)"],
  ];
  for (const [label, md] of embedCases) {
    it(`${label}: server path decodes to the real space, not a literal %20`, () => {
      const html = render(md);
      const serverPath = resolvedServerPath(html);
      expect(serverPath).toBe(realPath);
      expect(html).not.toContain("my%2520image.png");
      expect(serverPath).not.toContain("%20");
    });
  }
});
