/**
 * projects.tsx - Projects kanban board route.
 *
 * Loader reads cards via listCards() from projects.server.ts.
 * Action validates a "move" intent via zod and calls moveCard().
 *
 * Additions:
 *   - ?card=<cardId> URL state: CardDetail overlay (desktop centred modal,
 *     mobile full-screen sheet). Close clears ?card=. Refresh keeps state.
 *   - ?doc= URL state: ReviewPanel mounted on /projects (same wiring as
 *     threads.$agent.tsx). Interaction rule: opening a doc from the detail
 *     SETS ?doc= and CLEARS ?card= (doc panel wins).
 *   - Board face: summary line under the title (rendered in ProjectCard).
 *
 * SEAM RULE: no direct fs imports; no env-key literals here.
 * All fs/env access is in projects.server.ts.
 *
 * MC_NOW pattern (Gotcha 10): the loader passes a server "now" derived from
 * process.env["MC_NOW"] when set, so staleness labels are deterministic in e2e.
 *
 * ASCII only - no em-dashes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher, useSearchParams } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/projects";
import { RouteErrorPanel } from "~/components/RouteErrorPanel";
import { listCards, moveCard, createCard } from "~/lib/projects.server";
import { makeStores } from "~/lib/stores.server";
import { requireSameOriginWrite } from "~/lib/request-origin.server";
import { resolveNow } from "~/lib/time";
import { filterCardsForInstance, mcUser } from "~/lib/instance.server";
import { ProjectBoard } from "~/components/ProjectBoard";
import { CardDetail, CARD_PARAM } from "~/components/CardDetail";
import { ReviewPanel, DOC_PARAM } from "~/components/ReviewPanel";

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Projects - Inkie Deck" },
    { name: "description", content: "Team project kanban board" },
  ];
}

// ---------------------------------------------------------------------------
// Action schema
// ---------------------------------------------------------------------------

const moveSchema = z.object({
  intent: z.literal("move"),
  cardId: z.string().min(1, "cardId is required"),
  column: z.string().min(1, "column is required"),
});

// User-created todo from the board. Agent is REQUIRED at create time, so
// every card has a lane owner from birth.
const createSchema = z.object({
  intent: z.literal("create"),
  title: z.string().min(1).max(200),
  agent: z.string().min(1),
  assignee: z.string().optional(),
  ticket: z.string().optional(),
  body: z.string().max(4000).optional(),
});

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  requireSameOriginWrite(request, context);
  const formData = await request.formData();
  const raw = Object.fromEntries(formData);

  // Create intent (createCard validates + guards paths).
  if (raw["intent"] === "create") {
    const parsedCreate = createSchema.safeParse(raw);
    if (!parsedCreate.success) {
      return { ok: false, error: parsedCreate.error.flatten() };
    }
    try {
      const id = createCard(parsedCreate.data);
      return { ok: true, created: id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const parsed = moveSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.flatten() };
  }
  try {
    moveCard(parsed.data.cardId, parsed.data.column);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader() {
  // Scoped to this instance's agents.
  const cards = filterCardsForInstance(listCards(), process.env);
  // MC_NOW (Gotcha 10): deterministic clock for staleness labels in e2e.
  const now = resolveNow(process.env["MC_NOW"]);
  // Roster for the Add-todo agent picker + instance user
  // as the default assignee. listAgents degrades to [] if the root is unset.
  let agents: string[] = [];
  try {
    agents = await makeStores(process.env).inbox.listAgents();
  } catch {
    // Inbox root unset (bare test envs) - picker falls back to free text.
  }
  const user = mcUser(process.env);
  return { cards, now: now.toISOString(), agents, user };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Projects({ loaderData }: Route.ComponentProps) {
  const { cards, now, agents, user } = loaderData;
  const [, setSearchParams] = useSearchParams();

  // Callback: clicking a card face opens the detail overlay via ?card=.
  const handleCardOpen = useCallback(
    (cardId: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set(CARD_PARAM, cardId);
        // Clear ?doc= when opening a card (doc panel would hide the card detail).
        next.delete(DOC_PARAM);
        return next;
      });
    },
    [setSearchParams]
  );

  return (
    // Outer flex row: board column + optional review panel (same 55/45 idiom
    // as the thread route but applied on the projects surface).
    <div className="flex h-full">
      {/* Board column. min-w-0: without it the flex item defaults to
          min-width:auto and the wide kanban forces the whole column (header
          included) past a mobile viewport. min-w-0 bounds the column; the
          board keeps its own horizontal scroll. */}
      <div className="flex min-h-full min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
          <div>
            <h1 className="font-display text-2xl font-black uppercase tracking-tight text-foreground">
              Projects
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Team project tracking. Five columns, file-backed.
            </p>
          </div>
          <AddTodo agents={agents} defaultAssignee={user} />
        </header>
        <div className="flex-1 overflow-hidden">
          <ProjectBoard cards={cards} now={now} onCardOpen={handleCardOpen} />
        </div>
      </div>

      {/* Review panel (55/45 split on desktop, full-screen sheet on mobile) */}
      <ReviewPanel />

      {/* Card detail overlay (desktop modal, mobile sheet) */}
      <CardDetail cards={cards} now={now} />
    </div>
  );
}

/**
 * AddTodo - user-created todos from the board.
 *
 * Collapsed to a single button by default; expands to a compact row form.
 * Agent is REQUIRED at create time (every card has a lane owner from birth);
 * assignee defaults to the instance user. Posts intent=create to this
 * route's action; the card lands in the todo column on the next
 * revalidation (the AppShell poll makes that feel immediate).
 */
function AddTodo({ agents, defaultAssignee }: { agents: string[]; defaultAssignee: string }) {
  const fetcher = useFetcher<{ ok: boolean; created?: string; error?: unknown }>();
  const [open, setOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const formRef = useRef<HTMLFormElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Close + reset after a successful create.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && fetcher.data.created) {
      formRef.current?.reset();
      setOpen(false);
    }
  }, [fetcher.state, fetcher.data]);

  // Markdown helpers for the description toolbar: wrap the selection in
  // **bold** or prefix selected lines as bullets. The body is markdown -
  // CardDetail renders it - so formatting is real, not decorative.
  const wrapSelection = (before: string, after: string) => {
    const el = bodyRef.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b, value } = el;
    el.value = value.slice(0, a) + before + value.slice(a, b) + after + value.slice(b);
    el.focus();
    el.setSelectionRange(a + before.length, b + before.length);
  };
  const bulletSelection = () => {
    const el = bodyRef.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b, value } = el;
    const lineStart = value.lastIndexOf("\n", a - 1) + 1;
    const block = value.slice(lineStart, b);
    const bulleted = block
      .split("\n")
      .map((l) => (l.startsWith("- ") || l.trim() === "" ? l : `- ${l}`))
      .join("\n");
    el.value = value.slice(0, lineStart) + bulleted + value.slice(b);
    el.focus();
  };

  return (
    <>
      <button
        type="button"
        data-testid="add-todo-open"
        onClick={() => setOpen(true)}
        className="label-mono min-h-[44px] shrink-0 rounded-md bg-primary px-5 text-sm font-bold text-primary-foreground shadow-retro transition-opacity hover:opacity-90"
      >
        + Add todo
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <fetcher.Form
            ref={formRef}
            method="post"
            data-testid="add-todo-form"
            className="w-full max-w-lg rounded-lg border-2 border-border bg-card p-5 shadow-retro"
          >
            <h2 className="font-display mb-4 text-lg font-black uppercase tracking-tight">
              Add todo
            </h2>
            <input type="hidden" name="intent" value="create" />
            <div className="space-y-3">
              <label className="block">
                <span className="label-mono text-[10px] text-muted-foreground">Title</span>
                <input
                  name="title"
                  required
                  maxLength={200}
                  autoFocus
                  placeholder="What needs doing?"
                  className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <div className="flex items-center justify-between">
                  <span className="label-mono text-[10px] text-muted-foreground">Description</span>
                  <span className="flex gap-1">
                    <button
                      type="button"
                      aria-label="Bold"
                      onClick={() => wrapSelection("**", "**")}
                      className="rounded border border-border px-2 py-0.5 text-xs font-bold hover:bg-muted"
                    >
                      B
                    </button>
                    <button
                      type="button"
                      aria-label="Bullet list"
                      onClick={bulletSelection}
                      className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted"
                    >
                      &bull; list
                    </button>
                  </span>
                </div>
                <textarea
                  ref={bodyRef}
                  name="body"
                  maxLength={4000}
                  rows={8}
                  placeholder="Context, links, why it matters... (markdown: **bold**, - bullets)"
                  className="mt-1 block min-h-[10rem] w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </label>
              <div className="flex flex-wrap gap-3">
                <label className="flex flex-col gap-1">
                  <span className="label-mono text-[10px] text-muted-foreground">Agent</span>
                  <select
                    name="agent"
                    required
                    defaultValue={agents.includes("sprout") ? "sprout" : agents[0] ?? ""}
                    className="min-h-[40px] rounded-md border border-border bg-background px-2 text-sm"
                  >
                    {agents.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="label-mono text-[10px] text-muted-foreground">For</span>
                  <select
                    name="assignee"
                    defaultValue={defaultAssignee}
                    className="min-h-[40px] rounded-md border border-border bg-background px-2 text-sm"
                  >
                    <option value="">nobody</option>
                    <option value="alex">alex</option>
                    <option value="robin">robin</option>
                  </select>
                </label>
                <label className="flex flex-1 flex-col gap-1">
                  <span className="label-mono text-[10px] text-muted-foreground">Ticket (optional)</span>
                  <input
                    name="ticket"
                    placeholder="PROJ-123"
                    className="min-h-[40px] w-full rounded-md border border-border bg-background px-3 text-sm"
                  />
                </label>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="label-mono min-h-[40px] rounded-md border border-border px-4 text-sm text-muted-foreground"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                data-testid="add-todo-submit"
                className="label-mono min-h-[40px] rounded-md bg-primary px-5 text-sm font-bold text-primary-foreground disabled:opacity-50"
              >
                {busy ? "Adding..." : "Add"}
              </button>
            </div>
            {fetcher.data && !fetcher.data.ok ? (
              <p className="mt-2 text-xs text-destructive">
                {typeof fetcher.data.error === "string" ? fetcher.data.error : "Could not create the todo."}
              </p>
            ) : null}
          </fetcher.Form>
        </div>
      ) : null}
    </>
  );
}

/**
 * Scoped error boundary: a failure in this
 * route renders here, inside the shell, so the sidebar and the rest of Deck
 * stay usable. The panel shows the actual error text.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return (
    <RouteErrorPanel
      error={error}
      scope="the project board"
      hint="A project card file may have malformed frontmatter."
    />
  );
}
