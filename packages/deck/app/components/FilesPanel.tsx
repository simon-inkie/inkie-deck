/**
 * FilesPanel.tsx - per-thread auto-collected Files panel + pin-to-top (INK file-pinner).
 *
 * SPEC:
 *   1. Auto-manifest: every file the thread referenced, newest-first, each row
 *      = name + generated description + timestamp + open-in-side-panel + pin.
 *   2. Pin-to-top: pinned rows float above, in pin order; persisted per thread.
 *   3. Descriptions: lazily fetched per row (one gemini-3.5-flash-lite call each,
 *      cached server-side). Until a description lands the row shows the agent's
 *      link text (graceful degrade).
 *   4. Placement: a collapsible slide-out (desktop, right side) / full-screen
 *      sheet (mobile). NOT a permanent rail - toggled by a button.
 *
 * State: ?files=1 search param (same URL-state discipline as ?doc= ReviewPanel).
 *   Opening fetches the manifest; rows without a cached description fire a
 *   POST describe sequentially (cheap, cached).
 *
 * Opening a file in the review side-panel = set ?doc=<path> (reuses ReviewPanel,
 * so path-safety is the existing review.server root confinement - no new parse).
 *
 * No .server imports. ASCII only - no em-dashes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import {
  Files,
  FileText,
  FileImage,
  File as FileIcon,
  Pin,
  PinOff,
  X,
  Search,
  Sparkles,
} from "lucide-react";
import { Timestamp } from "./Timestamp";
import { cn } from "~/lib/utils";
import { computeWindow, isImageRowExt } from "~/lib/file-window";

export const FILES_PARAM = "files";

// ---------------------------------------------------------------------------
// Types (mirror api.file-manifest ManifestRow)
// ---------------------------------------------------------------------------

interface ManifestRow {
  path: string;
  name: string;
  ext: string;
  linkText: string;
  firstSeenTimestamp: string;
  lastSeenTimestamp: string;
  description: string | null;
}

interface ManifestResponse {
  ok: boolean;
  agent: string;
  rows: ManifestRow[];
  pins: string[];
}

// ---------------------------------------------------------------------------
// Icon by extension (mirrors Markdown.tsx attachmentIcon)
// ---------------------------------------------------------------------------

function extIcon(ext: string) {
  const e = ext.replace(/^\./, "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(e)) {
    return <FileImage className="size-4 shrink-0 text-muted-foreground" />;
  }
  if (["md", "txt", "markdown", "log", "csv", "json"].includes(e)) {
    return <FileText className="size-4 shrink-0 text-muted-foreground" />;
  }
  return <FileIcon className="size-4 shrink-0 text-muted-foreground" />;
}

// ---------------------------------------------------------------------------
// Ordering: pinned first (pin order), then the rest newest-first.
// ---------------------------------------------------------------------------

function orderRows(rows: ManifestRow[], pins: string[]): ManifestRow[] {
  const pinSet = new Set(pins);
  const pinned: ManifestRow[] = [];
  for (const p of pins) {
    const r = rows.find((row) => row.path === p);
    if (r) pinned.push(r);
  }
  const rest = rows
    .filter((r) => !pinSet.has(r.path))
    .sort((a, b) =>
      a.lastSeenTimestamp < b.lastSeenTimestamp
        ? 1
        : a.lastSeenTimestamp > b.lastSeenTimestamp
          ? -1
          : 0
    );
  return [...pinned, ...rest];
}

// ---------------------------------------------------------------------------
// Image detection helper (isImageRowExt is shared with file-window's row-height
// math so the tile decision and the virtualization offsets never diverge).
// ---------------------------------------------------------------------------

function imageSrc(path: string): string {
  return path.startsWith("/attachments/")
    ? path
    : `/api/review-asset?path=${encodeURIComponent(path)}`;
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function FileRow({
  row,
  pinned,
  now,
  onOpen,
  onTogglePin,
}: {
  row: ManifestRow;
  pinned: boolean;
  now: string;
  onOpen: (path: string) => void;
  onTogglePin: (path: string) => void;
}) {
  const description = row.description ?? row.linkText ?? row.name;
  const isFallback = row.description === null;
  const isImage = isImageRowExt(row.ext);

  // IMAGE ROW - full-bleed tile with hover overlay.
  if (isImage) {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open ${row.name}`}
        onClick={() => onOpen(row.path)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onOpen(row.path);
          if (e.key === " ") { e.preventDefault(); onOpen(row.path); }
        }}
        className={cn(
          "group relative block w-full cursor-pointer overflow-hidden border-b border-border",
          pinned && "ring-2 ring-primary ring-inset"
        )}
        data-testid="files-panel-row"
      >
        {/* Full-bleed image, fixed height */}
        <div className="relative h-44 w-full bg-muted">
          <img
            src={imageSrc(row.path)}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />
        </div>

        {/* Persistent bottom caption - always visible, even without hover */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2.5">
          <div className="truncate font-display text-sm font-bold text-white">{row.name}</div>
        </div>

        {/* Hover overlay - description + name + timestamp over translucent bg */}
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-end gap-1 bg-black/60 p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <div className="font-display text-sm font-bold text-white">{row.name}</div>
          <p className="text-xs leading-snug text-white/90">{row.description ?? row.linkText ?? row.name}</p>
          <div className="text-[11px] text-white/70"><Timestamp iso={row.lastSeenTimestamp} now={now} /></div>
        </div>

        {/* Pin button - floats top-right, always reachable over image */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onTogglePin(row.path); }}
          aria-label={pinned ? `Unpin ${row.name}` : `Pin ${row.name}`}
          aria-pressed={pinned}
          className="absolute right-2 top-2 z-10 flex size-8 items-center justify-center rounded-md bg-black/45 text-white backdrop-blur-sm hover:bg-black/65"
        >
          {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
        </button>
      </div>
    );
  }

  // NON-IMAGE ROW - unchanged media-object layout.
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${row.name}`}
      onClick={() => onOpen(row.path)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(row.path);
        if (e.key === " ") { e.preventDefault(); onOpen(row.path); }
      }}
      className={cn(
        "flex items-start gap-2.5 border-b border-border px-2.5 py-2",
        "cursor-pointer hover:bg-muted/60",
        pinned && "bg-muted/40"
      )}
      data-testid="files-panel-row"
    >
      {/* Left column: type-icon */}
      <div className="flex size-11 shrink-0 items-center justify-center">
        {extIcon(row.ext)}
      </div>

      {/* Right column: name + description + timestamp */}
      <div className="min-w-0 flex-1 overflow-hidden">
        <div
          className="truncate font-display text-sm font-bold tracking-tight text-foreground"
          title={row.path}
        >
          {row.name}
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
          {isFallback ? (
            <span className="inline-flex items-center gap-1">
              <Sparkles className="size-3 shrink-0 animate-pulse opacity-50" />
              <span className="italic opacity-70">{description}</span>
            </span>
          ) : (
            description
          )}
        </p>
        <div className="mt-0.5">
          <Timestamp iso={row.lastSeenTimestamp} now={now} />
        </div>
      </div>

      {/* Pin button */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onTogglePin(row.path); }}
        aria-label={pinned ? `Unpin ${row.name}` : `Pin ${row.name}`}
        aria-pressed={pinned}
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-muted",
          pinned ? "text-primary" : "text-muted-foreground"
        )}
      >
        {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel body
// ---------------------------------------------------------------------------

function PanelBody({
  agent,
  now,
  onClose,
  onOpenDoc,
}: {
  agent: string;
  now: string;
  onClose: () => void;
  onOpenDoc: (path: string) => void;
}) {
  const [rows, setRows] = useState<ManifestRow[]>([]);
  const [pins, setPins] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const describeStartedRef = useRef<Set<string>>(new Set());

  // Virtualization: the scroll container's live scrollTop + measured height feed
  // the pure computeWindow (file-window.ts), which returns the bounded row slice
  // to mount plus the two spacer heights. Only mounted rows fire a describe POST.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  // Load the manifest on mount / agent change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setQuery("");
    setScrollTop(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    describeStartedRef.current = new Set();
    fetch(`/api/file-manifest?agent=${encodeURIComponent(agent)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("load failed"))))
      .then((data: ManifestResponse) => {
        if (cancelled) return;
        if (!data.ok) {
          setError(true);
          return;
        }
        setRows(data.rows);
        setPins(data.pins);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agent]);

  // Client-side search: substring match over the already-loaded rows (name /
  // path / description / linkText), case-insensitive. Pure client-side - no
  // refetch. linkText is included because a null-description row displays
  // `linkText ?? name` (see FileRow), so a query matching the visible fallback
  // text must match here too.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q) ||
        r.linkText.toLowerCase().includes(q)
    );
  }, [rows, query]);

  const ordered = useMemo(() => orderRows(filtered, pins), [filtered, pins]);

  // Bounded window over the ordered rows: only `visible` rows mount, regardless
  // of manifest size. topPad/bottomPad spacers preserve the full scroll extent.
  const win = useMemo(
    () => computeWindow(ordered.map((r) => r.ext), scrollTop, viewportHeight),
    [ordered, scrollTop, viewportHeight]
  );
  const visible = useMemo(
    () => ordered.slice(win.start, win.end),
    [ordered, win.start, win.end]
  );

  // Lazily fill descriptions: fire a describe POST only for MOUNTED (visible)
  // rows missing one - not all ~300 up front. Sequential so we never burst the
  // model; each is cached server-side and describeStartedRef stops a scroll-back
  // from refetching.
  useEffect(() => {
    const missing = visible.filter(
      (r) => r.description === null && !describeStartedRef.current.has(r.path)
    );
    if (missing.length === 0) return;
    let cancelled = false;
    // Rows this run marked started, and the subset that reached a terminal
    // outcome (described or definitively failed). Anything started-but-unsettled
    // when the run is torn down had its response dropped, so it is released from
    // describeStartedRef on cleanup and can retry if it re-enters view.
    const startedThisRun: string[] = [];
    const settled = new Set<string>();
    void (async () => {
      for (const row of missing) {
        if (cancelled) return;
        describeStartedRef.current.add(row.path);
        startedThisRun.push(row.path);
        try {
          const form = new FormData();
          form.set("intent", "describe");
          form.set("agent", agent);
          form.set("path", row.path);
          const res = await fetch("/api/file-manifest", {
            method: "POST",
            body: form,
          });
          // Torn down mid-flight: drop the result and leave the row unsettled so
          // cleanup releases it for a retry on re-entry.
          if (cancelled) return;
          if (!res.ok) {
            settled.add(row.path);
            continue;
          }
          const data = (await res.json()) as {
            ok: boolean;
            path: string;
            description: string;
          };
          if (cancelled) return;
          settled.add(row.path);
          if (!data.ok) continue;
          setRows((prev) =>
            prev.map((r) =>
              r.path === data.path ? { ...r, description: data.description } : r
            )
          );
        } catch {
          // Network/parse error: leave the fallback link text and mark settled
          // so we do not retry-loop a persistently failing describe.
          settled.add(row.path);
        }
      }
    })();
    return () => {
      cancelled = true;
      for (const path of startedThisRun) {
        if (!settled.has(path)) describeStartedRef.current.delete(path);
      }
    };
  }, [visible, agent]);

  // A new search query shortens the list: jump back to the top so a stale
  // (large) scrollTop cannot land the window past the filtered end and render
  // an empty slice until the next scroll event. Resets the DOM element too so
  // state and el.scrollTop stay in agreement.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
  }, [query]);

  // Measure the scroll container's visible height (drives the window bound) and
  // keep it current across viewport resizes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportHeight(el.clientHeight || 600);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading, error]);

  const handleTogglePin = useCallback(
    (filePath: string) => {
      // Optimistic flip.
      setPins((prev) =>
        prev.includes(filePath)
          ? prev.filter((p) => p !== filePath)
          : [...prev, filePath]
      );
      const form = new FormData();
      form.set("intent", "toggle");
      form.set("agent", agent);
      form.set("path", filePath);
      fetch("/api/file-pins", { method: "POST", body: form })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { ok: boolean; pins: string[] } | null) => {
          if (data && data.ok) setPins(data.pins);
        })
        .catch(() => {
          // Revert on failure.
          setPins((prev) =>
            prev.includes(filePath)
              ? prev.filter((p) => p !== filePath)
              : [...prev, filePath]
          );
        });
    },
    [agent]
  );

  const pinSet = new Set(pins);

  return (
    <>
      {/* Sticky header (title row + search) */}
      <div className="sticky top-0 z-10 flex shrink-0 flex-col gap-2 border-b border-border bg-card/90 px-4 py-2 backdrop-blur-sm">
        <div className="flex min-h-[28px] items-center gap-2">
          <Files className="size-4 shrink-0 text-muted-foreground" />
          <div className="flex-1 font-display text-sm font-bold uppercase tracking-tight text-foreground">
            Files
            {rows.length > 0 ? (
              <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                {rows.length}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close files panel"
            className="flex size-[44px] shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Client-side filter over the loaded manifest (no server round-trip). */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files..."
            aria-label="Search files"
            data-testid="files-panel-search"
            className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {/* Body - virtualized scroll container: only rows in `visible` mount. */}
      <div
        ref={scrollRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="flex-1 overflow-y-auto"
      >
        {loading && (
          <div className="label-mono px-4 py-4 text-muted-foreground">Loading...</div>
        )}
        {error && !loading && (
          <div
            role="alert"
            className="m-4 rounded-md border border-border bg-card p-4 text-sm text-muted-foreground"
          >
            Files unavailable.
          </div>
        )}
        {!loading && !error && ordered.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {query.trim() === ""
              ? "No files referenced in this thread yet."
              : "No files match your search."}
          </div>
        )}
        {!loading && !error && ordered.length > 0 && (
          <>
            <div style={{ height: win.topPad }} aria-hidden="true" />
            {visible.map((row) => (
              <FileRow
                key={row.path}
                row={row}
                pinned={pinSet.has(row.path)}
                now={now}
                onOpen={onOpenDoc}
                onTogglePin={handleTogglePin}
              />
            ))}
            <div style={{ height: win.bottomPad }} aria-hidden="true" />
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// FilesPanel - slide-out (desktop) / sheet (mobile), toggled by ?files=1.
// ---------------------------------------------------------------------------

export function FilesPanel({ agent, now }: { agent: string; now: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const open = searchParams.get(FILES_PARAM) === "1";

  const handleClose = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete(FILES_PARAM);
      return next;
    });
  }, [setSearchParams]);

  const handleOpenDoc = useCallback(
    (path: string) => {
      // Open in the review side-panel; close the files sheet on mobile so the
      // doc is visible (desktop keeps both - the doc panel sits beside).
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("doc", path);
        return next;
      });
    },
    [setSearchParams]
  );

  if (!open) return null;

  return (
    <>
      {/* Mobile: full-screen sheet (<md) */}
      <div
        className="fixed inset-0 z-50 flex flex-col bg-background md:hidden"
        data-testid="files-panel-sheet"
      >
        <PanelBody agent={agent} now={now} onClose={handleClose} onOpenDoc={handleOpenDoc} />
      </div>

      {/* Desktop: slide-out column on the right (md+) */}
      <div
        className="hidden md:flex md:w-[340px] md:min-w-[300px] md:flex-col md:border-l md:border-border md:bg-background"
        data-testid="files-panel"
      >
        <PanelBody agent={agent} now={now} onClose={handleClose} onOpenDoc={handleOpenDoc} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// FilesPanelToggle - the button that opens the panel (?files=1).
// ---------------------------------------------------------------------------

export function FilesPanelToggle() {
  const [searchParams, setSearchParams] = useSearchParams();
  const open = searchParams.get(FILES_PARAM) === "1";

  function toggle() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (open) next.delete(FILES_PARAM);
      else next.set(FILES_PARAM, "1");
      return next;
    });
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle files panel"
      aria-pressed={open}
      className={cn(
        "flex size-9 items-center justify-center rounded-md border border-border hover:bg-muted",
        open ? "bg-muted text-foreground" : "text-muted-foreground"
      )}
      title="Files in this thread"
    >
      <Files className="size-4" />
    </button>
  );
}
