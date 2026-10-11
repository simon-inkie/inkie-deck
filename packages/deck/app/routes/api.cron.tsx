/**
 * api.cron.tsx - resource route for the cron admin page.
 *
 * POST form-encoded with an "intent" field:
 *   create     - { intent, schedule, target, message, enabled }
 *   setEnabled - { intent, id, enabled }
 *   delete     - { intent, id }
 *
 * GET - returns listCrons() result for the page loader.
 *
 * SEAM RULE: imports ONLY from ~/lib/cron.server + ~/lib/instance.server.
 * The crontab runner is never called here directly - cron.server.ts is the seam.
 * Zod-at-boundary, never-throws, degrades to { ok: false }.
 * ASCII only - no em-dashes.
 */

import { z } from "zod";
import type { Route } from "./+types/api.cron";
import {
  listCrons,
  createCron,
  setEnabled,
  deleteCron,
} from "~/lib/cron.server";
import { cronAdminEnabled } from "~/lib/instance.server";
import { cronFormSchema } from "~/lib/cron-validate";

// ---------------------------------------------------------------------------
// Loader - read path (no gate: listing is harmless)
// ---------------------------------------------------------------------------

export async function loader(_args: Route.LoaderArgs) {
  const crons = listCrons();
  return { crons };
}

// ---------------------------------------------------------------------------
// Action schemas
// ---------------------------------------------------------------------------

// Use the shared form schema (same as the page action) so the two create
// paths cannot drift. createCron also validates schedule internally, but
// schema-level validation gives a clean error before reaching the seam.
const createSchema = cronFormSchema.extend({ intent: z.literal("create") });

const setEnabledSchema = z.object({
  intent: z.literal("setEnabled"),
  id: z.string().min(1),
  enabled: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true"),
});

const deleteSchema = z.object({
  intent: z.literal("delete"),
  id: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Action - write path (gated to the operator instance)
// ---------------------------------------------------------------------------

export async function action({ request }: Route.ActionArgs) {
  // Server-side gate - refuses even if the endpoint is POSTed directly.
  if (!cronAdminEnabled(process.env)) {
    return {
      ok: false as const,
      error: "Cron admin is not available on this instance.",
    };
  }

  const formData = await request.formData();
  const raw = Object.fromEntries(formData);
  const intent = raw["intent"];

  if (intent === "create") {
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false as const, error: "Invalid create payload." };
    }
    const result = createCron(parsed.data);
    return result;
  }

  if (intent === "setEnabled") {
    const parsed = setEnabledSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false as const, error: "Invalid setEnabled payload." };
    }
    return setEnabled(parsed.data.id, parsed.data.enabled);
  }

  if (intent === "delete") {
    const parsed = deleteSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false as const, error: "Invalid delete payload." };
    }
    return deleteCron(parsed.data.id);
  }

  return { ok: false as const, error: `Unknown intent: "${String(intent)}".` };
}
