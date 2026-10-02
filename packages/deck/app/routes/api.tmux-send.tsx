/**
 * api.tmux-send.tsx - the ONE send seam for the read/write tmux view (v2).
 *
 * POST { window, text } or { window, key } (form-encoded). Runs send-keys against the agent's
 * window: literal text, ~1s delay, then Enter as a separate keystroke (the
 * Claude TUI races a combined text+Enter). Named keys send once without an
 * automatic Enter. Both tmux homes (the /tmux Team tab
 * and the per-thread ?view=tmux pane) POST here via useFetcher, so the send
 * logic lives in exactly one place - mirrors the api.review resource-route
 * precedent.
 *
 * SEAM RULE (FND-02): imports ONLY from tmux.server - the subprocess never
 * appears in route code. Validates at the boundary (parse-don't-validate).
 *
 * READONLY FALLBACK: this route is purely additive. If it fails, the capture
 * loaders still render the pane - Alex is never worse off than read-only.
 *
 * ASCII only - no em-dashes (FND-05).
 */
import { z } from "zod";
import { data } from "react-router";
import type { Route } from "./+types/api.tmux-send";
import { sendKeysToWindow, sendNamedKeyToWindow, SEND_KEYS_ALLOWED_KEYS, SEND_KEYS_MAX_LEN } from "~/lib/tmux.server";
import { tmuxEnabled } from "~/lib/instance.server";

const windowSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const sendSchema = z.union([
  z.object({ window: windowSchema, text: z.string().min(1).max(SEND_KEYS_MAX_LEN).refine((text) => text.trim() !== "") }).strict(),
  z.object({ window: windowSchema, key: z.enum(SEND_KEYS_ALLOWED_KEYS) }).strict(),
]);

export async function action({ request }: Route.ActionArgs) {
  // TASK-462: server-side gate, not just hidden UI - a tmux-disabled instance
  // (Robin's) refuses sends even if the endpoint is POSTed directly.
  if (!tmuxEnabled(process.env)) {
    return { ok: false as const, error: "The terminal is not available on this instance." };
  }
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return data({ ok: false as const, error: "Invalid send payload." }, { status: 400 });
  }
  if (["window", "text", "key"].some((field) => formData.getAll(field).length > 1)) {
    return data({ ok: false as const, error: "Invalid send payload." }, { status: 400 });
  }
  const parsed = sendSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return data({ ok: false as const, error: "Invalid send payload." }, { status: 400 });
  }
  // sendKeysToWindow carries the ROSTER + live-allowlist gate and degrades to
  // { ok: false } on any failure - it never throws.
  return "key" in parsed.data
    ? sendNamedKeyToWindow(process.env, parsed.data.window, parsed.data.key)
    : sendKeysToWindow(process.env, parsed.data.window, parsed.data.text);
}
