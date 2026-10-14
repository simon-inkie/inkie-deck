/**
 * drafts.tsx - the Drafts page: a plain Markdown editor over files in the
 * workspace `drafts/` folder (#66). All data goes through /api/drafts.
 *
 * SEAM RULE: the loader only reports whether drafts are configured.
 * ASCII only - no em-dashes.
 */
import type { Route } from "./+types/drafts";
import { draftsEnabled } from "~/lib/drafts.server";
import { DraftEditor } from "~/components/DraftEditor";
import { EmptyState } from "~/components/EmptyState";

export async function loader(_args: Route.LoaderArgs) {
  return { enabled: draftsEnabled(process.env) };
}

export default function Drafts({ loaderData }: Route.ComponentProps) {
  if (!loaderData.enabled) {
    return (
      <EmptyState
        title="Drafts are not set up"
        body="Set WORKSPACE_ROOT to an absolute path. Drafts are saved as Markdown files in its drafts folder."
      />
    );
  }
  return <DraftEditor />;
}
