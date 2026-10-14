/**
 * Markdown.tsx - Sanitized markdown renderer for agent message bodies.
 *
 * Renders semi-trusted agent content safely using react-markdown with
 * rehype-sanitize (schema extended to allow className on code/span/pre for
 * rehype-highlight) and remark-gfm for GitHub-flavored markdown support.
 * rehype-highlight runs after sanitize so syntax-highlighting classes survive.
 *
 * Component overrides:
 *   img: capped height (max-h-72), lazy-loaded, wrapped in an anchor to the
 *        same URL so clicking opens the full image in a new tab. Only applies
 *        to /attachments/ src URLs; external images keep default rendering.
 *        In panel context, relative image srcs are rewritten to /api/review-asset.
 *   a:   /attachments/ hrefs with a text-class extension (.md/.txt) render as a
 *        clickable chip that opens the review panel (via onOpenDoc callback).
 *        /attachments/ image chips keep new-tab behaviour.
 *        Path-shaped hrefs ending in .md/.txt/.markdown (starts with "/" or "~/")
 *        become panel-open clicks via onOpenDoc if provided.
 *        Other links open in a new tab (default).
 *
 * rehype-sanitize schema:
 *   The default schema is extended minimally to allow className on code, span,
 *   and pre (needed by rehype-highlight for syntax class application). No new
 *   tags, no event handlers, no style attributes. Script/handler stripping
 *   from the default schema is fully intact; highlight runs post-sanitize so
 *   its classes are not stripped.
 *
 * All rendering is via react-markdown component output (sanitized).
 * No raw HTML injection is used anywhere in this component.
 *
 * No .server imports - components receive plain string props only.
 * ASCII only - no em-dashes.
 */
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import { FileText, FileImage, File } from "lucide-react";
import type { Components } from "react-markdown";
import { isReviewablePath, isPathShapedImage, reviewAssetUrl } from "~/lib/review-exts";

// ---------------------------------------------------------------------------
// Sanitize schema: extend default to allow className on code/span/pre (for
// rehype-highlight) and the inert checkbox attributes on input (for GFM task
// lists). No new tags, no handlers, no style attrs; the
// task-list inputs are always rendered disabled by remark-gfm.
// ---------------------------------------------------------------------------

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      "className",
    ],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      "className",
    ],
    pre: [
      ...(defaultSchema.attributes?.pre ?? []),
      "className",
    ],
    input: [
      ...(defaultSchema.attributes?.input ?? []),
      "type",
      "checked",
      "disabled",
    ],
  },
};

// The rehype plugin chain: sanitize first (security), then highlight (cosmetic).
// Highlight runs on sanitized output so user-authored content cannot inject
// classes via the highlight path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rehypePlugins: Array<any> = [
  [rehypeSanitize, sanitizeSchema],
  rehypeHighlight,
];

// ---------------------------------------------------------------------------
// Review-openable detection helpers
// ---------------------------------------------------------------------------

const TEXT_CHIP_EXTS = new Set([".md", ".txt"]);

/**
 * Returns true when an /attachments/ href carries a text-class extension
 * that should open in the review panel rather than a new tab.
 */
function isAttachmentTextChip(href: string): boolean {
  if (!href.startsWith("/attachments/")) return false;
  const ext = href.slice(href.lastIndexOf(".")).toLowerCase();
  return TEXT_CHIP_EXTS.has(ext);
}

/**
 * Returns true when an href is a path-shaped link to a doc the panel can open.
 * Delegates to isReviewablePath from review-exts so the allowlist (markdown +
 * code extensions from review-exts) is always in sync with the server gate.
 */
function isPathShapedDocLink(href: string): boolean {
  return isReviewablePath(href);
}

// ---------------------------------------------------------------------------
// Attachment chip component
// ---------------------------------------------------------------------------

function attachmentIcon(href: string) {
  const ext = href.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
    return <FileImage className="size-4 shrink-0" />;
  }
  if (["md", "txt", "log", "csv", "json", "svg"].includes(ext)) {
    return <FileText className="size-4 shrink-0" />;
  }
  return <File className="size-4 shrink-0" />;
}

function AttachmentChip({ href, children }: { href: string; children: React.ReactNode }) {
  const filename = href.split("/").pop() ?? href;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-[44px] items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground no-underline hover:bg-muted"
      aria-label={`Attachment: ${filename}`}
    >
      {attachmentIcon(href)}
      <span className="label-mono truncate">{String(children) || filename}</span>
    </a>
  );
}

/** Chip that opens the review panel on click instead of navigating. */
function ReviewableChip({
  href,
  children,
  onOpenDoc,
}: {
  href: string;
  children: React.ReactNode;
  onOpenDoc: (doc: string) => void;
}) {
  const filename = href.split("/").pop() ?? href;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        onOpenDoc(href);
      }}
      className="inline-flex min-h-[44px] items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground no-underline hover:bg-muted cursor-pointer"
      aria-label={`Open in review panel: ${filename}`}
    >
      {attachmentIcon(href)}
      <span className="label-mono truncate">{String(children) || filename}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MarkdownProps {
  children: string;
  /**
   * Optional callback: called when the user clicks a review-openable link.
   * The argument is the doc path/url as written in the markdown (before any
   * server-side expansion). When omitted, review-openable links fall back to
   * plain anchor behaviour.
   */
  onOpenDoc?: (doc: string) => void;
  /**
   * Optional: base path for resolving relative image srcs inside a reviewed
   * document. When provided, relative image srcs (not starting with / or http)
   * are rewritten to /api/review-asset?path=<base>/<relative>.
   */
  reviewDocBasePath?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a markdown string as sanitized HTML via react-markdown.
 *
 * T-02-05: Uses rehype-sanitize (schema extended for highlight classNames)
 * to strip scripts and event handlers from semi-trusted agent content.
 * Never emits raw HTML.
 */
function MarkdownImpl({ children, onOpenDoc, reviewDocBasePath }: MarkdownProps) {
  // Build components object inside the render function so onOpenDoc is captured.
  const markdownComponents: Components = {
    img({ src, alt }) {
      if (!src) return <img src={src} alt={alt ?? ""} />;

      // Resolve the src to a servable URL.
      //   1. Path-shaped image ("~/" or "/"-rooted, image ext): route through
      //      /api/review-asset regardless of reviewDocBasePath, so image embeds
      //      work in plain chat messages, not just inside a reviewed doc. The
      //      /attachments/ guard keeps real attachment URLs on their own route
      //      (they also start with "/" and match isPathShapedImage).
      //   2. Otherwise, a relative src inside a reviewed doc: combine with the
      //      doc base path.
      let resolvedSrc = src;
      if (!src.startsWith("/attachments/") && isPathShapedImage(src)) {
        // Strip query/fragment and normalise percent-encoding so the path param
        // matches the real file on disk (incl. spaces, see reviewAssetUrl).
        resolvedSrc = reviewAssetUrl(src);
      } else if (
        reviewDocBasePath &&
        !src.startsWith("/") &&
        !src.startsWith("http://") &&
        !src.startsWith("https://") &&
        !src.startsWith("data:")
      ) {
        // Combine base path + relative src then encode for the query param.
        const absPath = reviewDocBasePath + "/" + src;
        resolvedSrc = "/api/review-asset?path=" + encodeURIComponent(absPath);
      }

      if (!resolvedSrc.startsWith("/attachments/") && !resolvedSrc.startsWith("/api/review-asset")) {
        // External or non-attachment image: default rendering.
        return <img src={resolvedSrc} alt={alt ?? ""} />;
      }
      return (
        <a href={resolvedSrc} target="_blank" rel="noopener noreferrer">
          <img
            src={resolvedSrc}
            alt={alt ?? ""}
            loading="lazy"
            className="max-h-72 max-w-full rounded object-contain"
          />
        </a>
      );
    },

    a({ href, children: linkChildren }) {
      if (!href) {
        return <a>{linkChildren}</a>;
      }

      // /attachments/ text-class chip: open in review panel if callback available.
      if (isAttachmentTextChip(href)) {
        if (onOpenDoc) {
          return (
            <ReviewableChip href={href} onOpenDoc={onOpenDoc}>
              {linkChildren}
            </ReviewableChip>
          );
        }
        // No panel available: render as plain chip (new tab).
        return <AttachmentChip href={href}>{linkChildren}</AttachmentChip>;
      }

      // /attachments/ image chip: always opens new tab.
      if (href.startsWith("/attachments/")) {
        return <AttachmentChip href={href}>{linkChildren}</AttachmentChip>;
      }

      // Path-shaped doc link: open in panel if callback available.
      if (isPathShapedDocLink(href)) {
        if (onOpenDoc) {
          return (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                onOpenDoc(href);
              }}
              className="text-primary underline underline-offset-2 cursor-pointer bg-transparent border-none p-0"
            >
              {linkChildren}
            </button>
          );
        }
        // No panel: fall through to default link.
      }

      // Path-shaped image link ("~/" or "/"-rooted, image ext): resolve through
      // the review-asset endpoint so it opens the actual image bytes in a new
      // tab, instead of the raw path (which the browser resolves as a broken
      // relative URL against the current page). Images never open the review
      // panel (they open in a new tab only), so this deliberately does NOT
      // route through onOpenDoc.
      if (isPathShapedImage(href)) {
        // Strip query/fragment and normalise percent-encoding so the path param
        // matches the real file on disk (incl. spaces, see reviewAssetUrl).
        const resolved = reviewAssetUrl(href);
        return (
          <a href={resolved} target="_blank" rel="noopener noreferrer">
            {linkChildren}
          </a>
        );
      }

      // Non-attachment, non-doc links: default rendering (new tab).
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {linkChildren}
        </a>
      );
    },
  };

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={rehypePlugins}
      components={markdownComponents}
    >
      {children}
    </ReactMarkdown>
  );
}

// Safe memo re-do: memoise ONLY Markdown - the expensive render
// (parse + sanitize + highlight). The interactive cards are deliberately NOT
// memoised, so they always re-render correctly on state change (no skipped-
// render misselect - that was the bug the full-feed memo caused, twice). Here
// the card still re-renders per keystroke, but its <Markdown>{block.body}</>
// returns cached output (children string + useCallback onOpenDoc are stable),
// so the dominant per-keystroke cost - re-parsing every message's markdown -
// is gone. Gated by e2e/flows/card-long-thread.test.ts (tap C -> type -> tap A).
export const Markdown = memo(MarkdownImpl);
