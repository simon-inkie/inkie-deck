/**
 * ReviewPanel.tsx - Side panel for reviewing markdown documents.
 *
 * Desktop (md+): renders as a resizable column beside the thread with
 * independent scroll and a sticky header (basename + truncated full path +
 * close button). Width is user-draggable via a left-edge handle and persisted
 * to localStorage (key: mc.reviewPanel.width). Default is 45% of viewport.
 * Clamp: min 320px, max 70vw. Pointer-event drag with setPointerCapture for
 * robustness; SSR-safe (no bare window/localStorage at module top-level).
 *
 * Mobile (<md): full-screen sheet (fixed inset-0 overlay). Unchanged.
 *
 * State: ?doc= search param on the thread route (set/clear via useSearchParams).
 * Content fetched client-side via a fetcher to /api/review (or the /attachments/
 * URL for attachment-sourced docs). Thread loader is untouched; panel is pure
 * URL-state + client fetch.
 *
 * Two source kinds (per plan):
 *   - doc param starting with /attachments/ -> fetch that URL directly as text.
 *   - everything else -> /api/review?path=<encoded>.
 *
 * Relative image srcs inside the doc are rewritten to /api/review-asset by the
 * Markdown renderer (via reviewDocBasePath prop).
 *
 * No .server imports. ASCII only - no em-dashes.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, useFetcher } from "react-router";
import { X } from "lucide-react";
import { Markdown } from "./Markdown";
import { CodeView } from "./CodeView";

// ---------------------------------------------------------------------------
// Resize constants
// ---------------------------------------------------------------------------

const LS_KEY = "mc.reviewPanel.width";
const MIN_PX = 320;
const MAX_VW = 0.7; // 70vw
const DEFAULT_VW = 0.45; // 45vw

// ---------------------------------------------------------------------------
// Resize helper (module-scope, no window access at definition time)
// ---------------------------------------------------------------------------

/**
 * Clamp a pixel width to [MIN_PX, 70vw]. Called client-side only (window is
 * safe here because it is only invoked inside event handlers / useEffect).
 */
function clampWidth(px: number): number {
  const maxPx = window.innerWidth * MAX_VW;
  return Math.max(MIN_PX, Math.min(maxPx, px));
}

// ---------------------------------------------------------------------------
// useResizablePanel hook
// ---------------------------------------------------------------------------

/**
 * Self-contained left-edge resize handle logic for the ReviewPanel desktop
 * variant. Returns:
 *   - panelWidth: CSS width in px (null during SSR -> falls back to 45% via class)
 *   - handleProps: spread onto the drag handle div
 *
 * SSR-safe: localStorage and window access are guarded inside useEffect / the
 * pointer event handlers (never at module or render top-level).
 */
function useResizablePanel() {
  // SSR-safe: initialise to null; hydrate in useEffect.
  const [panelWidth, setPanelWidth] = useState<number | null>(null);

  const dragStartX = useRef<number>(0);
  const dragStartWidth = useRef<number>(0);

  // Read persisted width on mount (client-only).
  useEffect(() => {
    let stored: number | null = null;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw !== null) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed >= MIN_PX) {
          stored = parsed;
        }
      }
    } catch {
      // localStorage may be unavailable (private browsing etc).
    }
    if (stored !== null) {
      setPanelWidth(stored);
    } else {
      // Default: 45% of current viewport width, clamped.
      setPanelWidth(clampWidth(window.innerWidth * DEFAULT_VW));
    }
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only respond at md breakpoint and above (768px+).
      if (window.innerWidth < 768) return;
      e.preventDefault();
      dragStartX.current = e.clientX;
      // panelWidth is initialised after first mount; fall back to the
      // parent element's rendered width if somehow null.
      dragStartWidth.current =
        panelWidth ?? (e.currentTarget.parentElement?.offsetWidth ?? window.innerWidth * DEFAULT_VW);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [panelWidth]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
      // Dragging left edge: moving pointer left INCREASES panel width.
      const delta = dragStartX.current - e.clientX;
      setPanelWidth(clampWidth(dragStartWidth.current + delta));
    },
    []
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      // Persist to localStorage on drag end.
      setPanelWidth((current) => {
        if (current !== null) {
          try {
            localStorage.setItem(LS_KEY, String(current));
          } catch {
            // Ignore write errors (private browsing etc).
          }
        }
        return current;
      });
    },
    []
  );

  const handleProps = {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
  };

  return { panelWidth, handleProps };
}

// ---------------------------------------------------------------------------
// Search param key
// ---------------------------------------------------------------------------

export const DOC_PARAM = "doc";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function basename(docPath: string): string {
  // Works for both POSIX paths and /attachments/... URLs.
  const parts = docPath.split(/[/\\]/);
  return parts[parts.length - 1] || docPath;
}

/**
 * Returns true when the doc param refers to an HTML file (.html or .htm).
 * Query strings and fragments are stripped before the extension check so
 * /attachments/foo.html?v=2 is correctly identified as HTML.
 * Exported for unit testing.
 */
export function isHtmlDoc(doc: string): boolean {
  const lower = (doc.split(/[?#]/)[0] ?? "").toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

/**
 * Returns true when the doc param refers to a raster image file.
 * SVG is deliberately excluded - the /api/review-asset route denies SVG for safety.
 * Query strings and fragments are stripped before the extension check.
 * Exported for unit testing.
 */
export function isImageDoc(doc: string): boolean {
  const lower = (doc.split(/[?#]/)[0] ?? "").toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp"].some((e) => lower.endsWith(e));
}

/**
 * Given a doc path (used as the ?doc= param), derive the base directory for
 * resolving relative image srcs. For /attachments/... paths there is no
 * meaningful base to resolve from (assets have their own route); for absolute
 * filesystem paths, the dirname is the base.
 */
function docBasePath(docPath: string): string | undefined {
  if (docPath.startsWith("/attachments/")) return undefined;
  // For absolute paths: strip the filename to get the directory.
  const lastSlash = docPath.lastIndexOf("/");
  if (lastSlash > 0) return docPath.slice(0, lastSlash);
  return undefined;
}

// ---------------------------------------------------------------------------
// Fetcher types
// ---------------------------------------------------------------------------

interface ReviewApiResponse {
  ok: boolean;
  path?: string;
  content?: string;
  /** "markdown" or "code" - determines which renderer to use in PanelContent. */
  kind?: "markdown" | "code";
  /** highlight.js language id (relevant when kind === "code"). */
  lang?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Panel content
// ---------------------------------------------------------------------------

interface PanelContentProps {
  docParam: string;
  onClose: () => void;
  onOpenDoc: (doc: string) => void;
}

function PanelContentImpl({ docParam, onClose, onOpenDoc }: PanelContentProps) {
  const fetcher = useFetcher<ReviewApiResponse>();
  const [textContent, setTextContent] = useState<string | null>(null);
  const [fileKind, setFileKind] = useState<"markdown" | "code">("markdown");
  const [fileLang, setFileLang] = useState<string>("plaintext");
  const [loadError, setLoadError] = useState(false);
  const prevDocRef = useRef<string>("");

  // Derive fetch URL from the doc param.
  const isAttachment = docParam.startsWith("/attachments/");
  const isImage = isImageDoc(docParam);
  const fetchUrl = isAttachment
    ? docParam
    : `/api/review?path=${encodeURIComponent(docParam)}`;

  useEffect(() => {
    if (prevDocRef.current === docParam) return;
    prevDocRef.current = docParam;
    setTextContent(null);
    setFileKind("markdown");
    setFileLang("plaintext");
    setLoadError(false);

    // Image docs are rendered via <img> - no text fetch needed.
    if (isImage) return;

    if (isAttachment) {
      // Fetch /attachments/ URL as text directly.
      fetch(fetchUrl)
        .then((res) => {
          if (!res.ok) {
            setLoadError(true);
            return null;
          }
          return res.text();
        })
        .then((text) => {
          if (text !== null) setTextContent(text);
        })
        .catch(() => setLoadError(true));
    } else {
      // Use the fetcher for the /api/review JSON endpoint.
      fetcher.load(fetchUrl);
    }
  }, [docParam, fetchUrl, isAttachment, isImage]);

  // Track fetcher state for non-attachment docs.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data !== undefined) {
      if (fetcher.data.ok && fetcher.data.content !== undefined) {
        setTextContent(fetcher.data.content);
        setFileKind(fetcher.data.kind ?? "markdown");
        setFileLang(fetcher.data.lang ?? "plaintext");
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    }
  }, [fetcher.state, fetcher.data]);

  const name = basename(docParam);
  const basePath = docBasePath(docParam);

  // Images are rendered via <img> and never need a text fetch, so they are
  // never "loading" in the text-fetch sense.
  const isLoading =
    !isImage &&
    textContent === null &&
    !loadError &&
    (fetcher.state !== "idle" || isAttachment);

  return (
    <>
      {/* Sticky header */}
      <div className="sticky top-0 z-10 flex min-h-[44px] shrink-0 items-center gap-3 border-b border-border bg-card/90 px-4 py-2 backdrop-blur-sm">
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-sm font-bold uppercase tracking-tight text-foreground">
            {name}
          </div>
          <div
            className="label-mono truncate text-muted-foreground"
            title={docParam}
          >
            {docParam}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close review panel"
          className="flex size-[44px] shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {isLoading && (
          <div className="label-mono text-muted-foreground">Loading...</div>
        )}
        {loadError && !isLoading && (
          <div
            role="alert"
            className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground"
          >
            Document not available.
          </div>
        )}
        {isImage && !loadError && (
          <img
            src={docParam.startsWith("/attachments/") ? docParam : `/api/review-asset?path=${encodeURIComponent(docParam)}`}
            alt={name}
            className="mx-auto h-auto max-w-full rounded-md border border-border"
            onError={() => setLoadError(true)}
          />
        )}
        {textContent !== null && !loadError && (
          isHtmlDoc(docParam)
            ? (
              <iframe
                srcDoc={textContent}
                sandbox=""
                title={name}
                className="h-full min-h-[60vh] w-full rounded-md border border-border bg-white"
              />
            )
            : fileKind === "code"
            ? (
              // Code files rendered through CodeView (syntax-highlighted).
              // Negative margin (-1rem all sides) cancels the parent px-4 py-4
              // padding so the dark code body fills the panel edge-to-edge
              // (full-bleed, like a real editor pane). Markdown docs keep their
              // padding via the else branch below - no regression there.
              <div style={{ overflow: "hidden", margin: "-1rem" }}>
                <CodeView content={textContent} lang={fileLang} />
              </div>
            )
            : (
              <div className="prose-mc text-sm">
                <Markdown
                  onOpenDoc={onOpenDoc}
                  reviewDocBasePath={basePath}
                >
                  {textContent}
                </Markdown>
              </div>
            )
        )}
      </div>
    </>
  );
}

// Memoise PanelContent so a ReviewPanel re-render that leaves
// docParam/onClose/onOpenDoc unchanged (e.g. a panel resize) does not cascade
// into a fresh Markdown parse. The callback props are stabilised via useCallback
// in ReviewPanel, so this shallow comparison actually holds. Exported so the
// render-count regression test can assert the memo boundary directly.
export const PanelContent = memo(PanelContentImpl);

// ---------------------------------------------------------------------------
// ReviewPanel
// ---------------------------------------------------------------------------

/**
 * ReviewPanel - the split-panel / mobile-sheet for doc review.
 *
 * The caller (thread route) provides onOpenDoc so nested links inside reviewed
 * docs can open further docs in the panel.
 *
 * Usage:
 *   const [searchParams, setSearchParams] = useSearchParams();
 *   const docParam = searchParams.get(DOC_PARAM);
 *   <ReviewPanel />  // reads/writes ?doc= internally
 */
function ReviewPanelImpl() {
  const [searchParams, setSearchParams] = useSearchParams();
  const docParam = searchParams.get(DOC_PARAM);
  const { panelWidth, handleProps } = useResizablePanel();

  // The useCallback wrappers keep the handler references stable across ReviewPanel
  // re-renders so the memo boundaries below (PanelContent -> Markdown) hold.
  // setSearchParams is the only dependency. Note it is NOT referentially stable:
  // React Router v7 memoises it with deps [navigate, searchParams], so it changes
  // whenever location.search changes. It is therefore kept in the deps array (the
  // safe, correct default), which means these handlers legitimately update on a
  // URL-param change - not during composer typing (no URL change there), which is
  // the reported lag. Both bodies use the functional updater form, so they never
  // close over a stale searchParams value regardless.
  const handleClose = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete(DOC_PARAM);
      return next;
    });
  }, [setSearchParams]);

  const handleOpenDoc = useCallback(
    (doc: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set(DOC_PARAM, doc);
        return next;
      });
    },
    [setSearchParams]
  );

  if (!docParam) return null;

  return (
    <>
      {/* Mobile: full-screen sheet (<md). Unchanged - full-screen by design. */}
      <div
        className="fixed inset-0 z-40 flex flex-col bg-background md:hidden"
        data-testid="review-panel-sheet"
      >
        <PanelContent
          docParam={docParam}
          onClose={handleClose}
          onOpenDoc={handleOpenDoc}
        />
      </div>

      {/* Desktop: resizable panel alongside the thread (md+).
          Width is controlled via inline style (px value from useResizablePanel).
          During SSR panelWidth is null so we fall back to the Tailwind default
          (md:w-[45%]) via the class; once hydrated the inline style takes over.
          min-width is enforced both via the clamp in the hook and the Tailwind
          class as a CSS floor so the browser never collapses it below 320px. */}
      <div
        className="relative hidden md:flex md:min-w-[320px] md:flex-col md:border-l md:border-border md:bg-background"
        style={panelWidth !== null ? { width: `${panelWidth}px` } : { width: "45%" }}
        data-testid="review-panel"
      >
        {/* Left-edge drag handle. Sits at the left border of the panel.
            Hit target is 8px wide (invisible overlay); visible divider is the
            1px border-l on the parent. On pointer-drag, cursor is col-resize.
            Only wired up at md+ (mobile sheet is untouched).
            z-10 puts it above the panel content so the grab zone is always
            reachable. */}
        <div
          role="separator"
          aria-label="Resize review panel"
          aria-orientation="vertical"
          className="absolute left-0 top-0 z-10 hidden h-full w-2 cursor-col-resize md:block hover:bg-primary/10 active:bg-primary/20"
          {...handleProps}
        />
        <PanelContent
          docParam={docParam}
          onClose={handleClose}
          onOpenDoc={handleOpenDoc}
        />
      </div>
    </>
  );
}

// Memoise ReviewPanel. It takes zero props, so React.memo's shallow
// prop comparison always succeeds and the render is SKIPPED whenever the parent
// (ThreadView) re-renders for unrelated reasons - notably a composer keystroke
// updating liveDraft, which was defeating Markdown's own memo by re-creating the
// onOpenDoc closure every keystroke and forcing a full re-parse of the open doc.
// ReviewPanel still re-renders on its OWN reactivity: useSearchParams (docParam)
// and useResizablePanel are hook subscriptions React.memo never blocks.
export const ReviewPanel = memo(ReviewPanelImpl);
