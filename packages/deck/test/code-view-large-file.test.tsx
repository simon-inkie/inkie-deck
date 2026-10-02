import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeView, shouldRenderPlainCode } from "~/components/CodeView";

describe("CodeView large-file path", () => {
  it("switches at the character budget boundary", () => {
    expect(shouldRenderPlainCode("x".repeat(128 * 1024))).toBe(false);
    expect(shouldRenderPlainCode("x".repeat(128 * 1024 + 1))).toBe(true);
  });

  it("keeps normal files highlighted and line-numbered", () => {
    const content = '{"ok":true}\n';
    expect(shouldRenderPlainCode(content)).toBe(false);

    const html = renderToStaticMarkup(<CodeView content={content} lang="json" />);
    expect(html).toContain('class="hljs language-json"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('data-testid="large-code-plain"');
  });

  it("skips highlighting and the gutter for a 1 MB JSON file", () => {
    const content = JSON.stringify({ rows: "x".repeat(1_050_000), marker: "<script>hello</script>" });
    expect(shouldRenderPlainCode(content)).toBe(true);

    const html = renderToStaticMarkup(<CodeView content={content} lang="json" />);
    expect(html).toContain('data-testid="large-code-plain"');
    expect(html).not.toContain('aria-hidden="true"');
    expect(html).not.toContain('class="hljs language-json"');
    expect(html).toContain('&lt;script&gt;hello&lt;/script&gt;');
    expect(html).not.toContain('<script>hello</script>');
  });

  it("skips the gutter for a smaller file with too many lines", () => {
    const content = "line\n".repeat(4_001);
    expect(content.length).toBeLessThan(128 * 1024);
    expect(shouldRenderPlainCode(content)).toBe(true);

    const html = renderToStaticMarkup(<CodeView content={content} lang="plaintext" />);
    expect(html).toContain('data-testid="large-code-plain"');
    expect(html).not.toContain('aria-hidden="true"');
  });
});
