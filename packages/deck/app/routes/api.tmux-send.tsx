/**
 * api.tmux-send.tsx - the ONE send seam for the read/write tmux view (v2).
 *
 * POST { window, text } (form-encoded). Runs send-keys against the agent's
 * window: literal text, ~1s delay, then Enter as a separate keystroke (the
 * Claude TUI races a combined text+Enter). Both tmux homes (the /tmux Team tab
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
import type { Route } from "./+types/api.tmux-send";
import { sendKeysToWindow, SEND_KEYS_MAX_LEN } from "~/lib/tmux.server";
import { tmuxEnabled } from "~/lib/instance.server";

const sendSchema = z.object({
  window: z.string().min(1),
  text: z.string().min(1).max(SEND_KEYS_MAX_LEN),
});

export async function action({ request }: Route.ActionArgs) {
  // TASK-462: server-side gate, not just hidden UI - a tmux-disabled instance
  // (Robin's) refuses sends even if the endpoint is POSTed directly.
  if (!tmuxEnabled(process.env)) {
    return { ok: false as const, error: "The terminal is not available on this instance." };
  }
  const formData = await request.formData();
  const parsed = sendSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { ok: false as const, error: "Invalid send payload." };
  }
  // sendKeysToWindow carries the ROSTER + live-allowlist gate, verifies the
  // submit, and degrades to { ok: false } on any failure - it never throws.
  const result = await sendKeysToWindow(process.env, parsed.data.window, parsed.data.text);
  if (result.status === "submitted") {
    return { ok: true as const };
  }
  // "unverified" means text AND Enter were sent but delivery could not be
  // proven. Surface it distinctly so the operator is told "sent, could not
  // confirm" rather than "failed", which would invite a duplicate resend.
  if (result.status === "unverified") {
    return { ok: false as const, unverified: true as const, error: result.error };
  }
  return { ok: false as const, error: result.error };
}
