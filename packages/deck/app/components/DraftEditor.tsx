/**
 * DraftEditor.tsx - plain-text Markdown editor for workspace drafts (#66).
 *
 * Talks only to /api/drafts. It holds the version (content hash) it loaded and
 * sends it back on save; the server refuses a stale save. While a draft is
 * open it polls the file, and if the version on disk differs from the one
 * loaded it shows a visible warning (role="alert") with a choice: load the
 * other copy, or keep mine and overwrite. A plain textarea: no rich text.
 *
 * Pure helpers are exported for tests. ASCII only - no em-dashes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

export interface DraftSummaryDto {
  name: string;
  savedAt: string;
  writer: "person" | "agent";
}
export interface DraftDto extends DraftSummaryDto {
  content: string;
  version: string;
}

export const DRAFT_POLL_MS = 5000;

/** "Saved by you" / "Last written by the agent" wording for the status line. */
export function writerLabel(writer: "person" | "agent"): string {
  return writer === "person" ? "you" : "the agent (changed outside this editor)";
}

export function formatSavedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

async function api<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(url, init);
  let body: unknown = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, body: body as T };
}

function formBody(fields: Record<string, string | undefined>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) f.set(k, v);
  return f;
}

type SaveBody = { ok: boolean; error?: string; conflict?: boolean; draft?: DraftDto; current?: DraftDto };

export function DraftEditor() {
  const [drafts, setDrafts] = useState<DraftSummaryDto[]>([]);
  const [loaded, setLoaded] = useState<DraftDto | null>(null);
  const [text, setText] = useState("");
  const [remote, setRemote] = useState<DraftDto | null>(null);
  // The open draft no longer exists on disk (removed or renamed outside).
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState("");

  const loadedRef = useRef<DraftDto | null>(null);
  loadedRef.current = loaded;

  const dirty = loaded !== null && text !== loaded.content;

  const refreshList = useCallback(async () => {
    const { body } = await api<{ ok: boolean; drafts?: DraftSummaryDto[] }>("/api/drafts");
    if (body.ok && body.drafts) setDrafts(body.drafts);
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const adopt = useCallback((d: DraftDto) => {
    setLoaded(d);
    setText(d.content);
    setRemote(null);
    setGone(false);
    setError(null);
  }, []);

  const open = useCallback(
    async (name: string) => {
      const { status, body } = await api<{ ok: boolean; draft?: DraftDto }>(
        `/api/drafts?name=${encodeURIComponent(name)}`
      );
      if (status === 200 && body.draft) adopt(body.draft);
      else setError("Could not open that draft.");
    },
    [adopt]
  );

  // Watch the open file for changes made outside this editor.
  useEffect(() => {
    if (!loaded) return;
    const id = setInterval(async () => {
      const asked = loadedRef.current;
      if (!asked) return;
      try {
        const { status, body } = await api<{ ok: boolean; draft?: DraftDto }>(
          `/api/drafts?name=${encodeURIComponent(asked.name)}`
        );
        // Compare against what is loaded NOW: a save may have finished while
        // this GET was in flight, and the GET then reflects that save.
        const now = loadedRef.current;
        if (!now || now.name !== asked.name) return;
        if (status === 200 && body.draft && body.draft.version !== now.version) {
          setRemote(body.draft);
        } else if (status === 404) {
          setGone(true);
        }
      } catch {
        /* transient network error: try again next tick */
      }
    }, DRAFT_POLL_MS);
    return () => clearInterval(id);
  }, [loaded?.name, loaded?.version]);

  const create = useCallback(async () => {
    if (!newName.trim()) return;
    const { status, body } = await api<SaveBody>("/api/drafts", {
      method: "POST",
      body: formBody({ intent: "create", name: newName, content: "" }),
    });
    if (status === 200 && body.draft) {
      setNewName("");
      adopt(body.draft);
      void refreshList();
    } else {
      setError(body.error ?? "Could not create the draft.");
    }
  }, [newName, adopt, refreshList]);

  const save = useCallback(
    async (force: boolean) => {
      if (!loaded) return;
      setSaving(true);
      try {
        const { status, body } = await api<SaveBody>("/api/drafts", {
          method: "POST",
          body: formBody({
            intent: "save",
            name: loaded.name,
            content: text,
            baseVersion: loaded.version,
            force: force ? "1" : undefined,
          }),
        });
        if (status === 200 && body.draft) {
          setLoaded(body.draft);
          setRemote(null);
          setGone(false);
          setError(null);
          void refreshList();
        } else if (body.conflict) {
          if (body.current) setRemote(body.current);
          else setGone(true);
          setError(null);
        } else {
          setError(body.error ?? "Save failed.");
        }
      } finally {
        setSaving(false);
      }
    },
    [loaded, text, refreshList]
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4" data-testid="draft-editor">
      <div className="flex flex-wrap items-end gap-2">
        <label className="label-mono flex min-w-0 flex-col gap-1 text-xs">
          Draft
          <select
            data-testid="draft-select"
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={loaded?.name ?? ""}
            onChange={(e) => e.target.value && void open(e.target.value)}
          >
            <option value="">Choose a draft</option>
            {drafts.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="label-mono flex flex-col gap-1 text-xs">
            New draft
            <Input
              data-testid="draft-new-name"
              value={newName}
              placeholder="release-notes"
              onChange={(e) => setNewName(e.target.value)}
            />
          </label>
          <Button type="submit" variant="outline" data-testid="draft-create">
            Create
          </Button>
        </form>
      </div>

      {error ? (
        <p role="status" data-testid="draft-error" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {gone && !remote ? (
        <div
          role="alert"
          data-testid="draft-gone"
          className="flex flex-col gap-2 rounded-md border-2 border-destructive/60 bg-destructive/10 p-3 text-sm"
        >
          <strong>This draft was removed outside the editor.</strong>
          <span>Your text is still here. You can write it back as a new file.</span>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="destructive" data-testid="draft-recreate" onClick={() => void save(true)}>
              Keep mine and recreate
            </Button>
          </div>
        </div>
      ) : null}

      {remote ? (
        <div
          role="alert"
          data-testid="draft-conflict"
          className="flex flex-col gap-2 rounded-md border-2 border-destructive/60 bg-destructive/10 p-3 text-sm"
        >
          <strong>This draft changed outside the editor.</strong>
          <span>
            Newer copy written by {writerLabel(remote.writer)} at {formatSavedAt(remote.savedAt)}.
            {dirty ? " You also have unsaved edits." : ""}
          </span>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" data-testid="draft-load-theirs" onClick={() => adopt(remote)}>
              Load the newer copy
            </Button>
            <Button size="sm" variant="destructive" data-testid="draft-keep-mine" onClick={() => void save(true)}>
              Keep mine and overwrite
            </Button>
          </div>
        </div>
      ) : null}

      {loaded ? (
        <>
          <textarea
            data-testid="draft-text"
            aria-label={`Editing ${loaded.name}`}
            className="min-h-[50vh] w-full rounded-md border border-border bg-background p-3 font-mono text-sm"
            value={text}
            spellCheck
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button data-testid="draft-save" disabled={saving || !dirty} onClick={() => void save(false)}>
              {saving ? "Saving" : "Save"}
            </Button>
            <span data-testid="draft-status" className="text-xs text-muted-foreground">
              Last saved {formatSavedAt(loaded.savedAt)} by {writerLabel(loaded.writer)}
              {dirty ? " - unsaved changes" : ""}
            </span>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Open a draft or create one. Drafts are Markdown files in the workspace drafts folder.
        </p>
      )}
    </div>
  );
}
