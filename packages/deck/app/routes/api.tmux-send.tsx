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
 * The subprocess never appears in route code. An opted-in agent is routed
 * through the PTY registry, never back to a draining tmux pane.
 *
 * READONLY FALLBACK: this route is purely additive. If it fails, the capture
 * loaders still render the pane - the operator is never worse off than read-only.
 *
 * ASCII only - no em-dashes.
 */
import { z } from "zod";
import { data } from "react-router";
import type { Route } from "./+types/api.tmux-send";
import {
  sendKeysToWindow,
  sendNamedKeyToWindow,
  SEND_KEYS_ALLOWED_KEYS,
  SEND_KEYS_MAX_LEN,
} from "~/lib/tmux.server";
import { tmuxEnabled } from "~/lib/instance.server";
import { requireSameOriginWrite } from "~/lib/request-origin.server";
import { acpRunnerRegistry } from "~/lib/runner/acp-registry.server";
import { runnerRegistry } from "~/lib/runner/registry.server";

const windowSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const sendSchema = z.union([
  z
    .object({
      window: windowSchema,
      text: z
        .string()
        .min(1)
        .max(SEND_KEYS_MAX_LEN)
        .refine((text) => text.trim() !== ""),
    })
    .strict(),
  z.object({ window: windowSchema, key: z.enum(SEND_KEYS_ALLOWED_KEYS) }).strict(),
]);

export async function action({ request, context }: Route.ActionArgs) {
  requireSameOriginWrite(request, context);
  // Server-side gate, not just hidden UI - a tmux-disabled instance (such as a
  // second user's) refuses sends even if the endpoint is POSTed directly.
  if (!tmuxEnabled(process.env)) {
    return {
      ok: false as const,
      error: "The terminal is not available on this instance.",
    };
  }
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return data(
      { ok: false as const, error: "Invalid send payload." },
      { status: 400 }
    );
  }
  if (
    ["window", "text", "key"].some(
      (field) => formData.getAll(field).length > 1
    )
  ) {
    return data(
      { ok: false as const, error: "Invalid send payload." },
      { status: 400 }
    );
  }
  const parsed = sendSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return data(
      { ok: false as const, error: "Invalid send payload." },
      { status: 400 }
    );
  }
  // Minor 2: Refuse legacy tmux sends once an agent opts into or is controlled by the ACP runner.
  if (acpRunnerRegistry.isOptedIn(parsed.data.window) || acpRunnerRegistry.canControl(parsed.data.window)) {
    return data(
      { ok: false as const, error: "This agent is controlled by the ACP runner; use the ACP thread." },
      { status: 409 }
    );
  }
  const pty = runnerRegistry.handlesTerminal(parsed.data.window);
  if ("key" in parsed.data) {
    if (pty) {
      const result = await runnerRegistry.key(parsed.data.window, parsed.data.key);
      if (result.status === "written") return { ok: true as const };
      return { ok: false as const, error: result.reason === "unsafe-pane"
        ? "A PTY send is already in progress." : "Could not send the key to a running, opted-in PTY session." };
    }
    return sendNamedKeyToWindow(
      process.env,
      parsed.data.window,
      parsed.data.key
    );
  }
  // sendKeysToWindow carries the ROSTER + live-allowlist gate, verifies the
  // submit, and degrades to { ok: false } on any failure - it never throws.
  const result = pty ? await runnerRegistry.submit(parsed.data.window, parsed.data.text) : await sendKeysToWindow(
    process.env,
    parsed.data.window,
    parsed.data.text
  );
  if (result.status === "submitted") {
    return { ok: true as const };
  }
  // "unverified" means text AND Enter were sent but delivery could not be
  // proven. Surface it distinctly so the operator is told "sent, could not
  // confirm" rather than "failed", which would invite a duplicate resend.
  if (result.status === "unverified" || (pty && result.status === "not-submitted" && result.enterAttempts > 1)) {
    return {
      ok: false as const,
      unverified: true as const,
      error: pty ? "Sent, could not confirm delivery." : result.error,
    };
  }
  return { ok: false as const, error: result.error };
}
