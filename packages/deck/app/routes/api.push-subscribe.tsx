/**
 * api.push-subscribe.tsx - push subscription resource route.
 *
 * GET  -> { ok, publicKey }  (the instance's VAPID public key, lazily
 *          self-provisioned - the client needs it for PushManager.subscribe)
 * POST -> intent=subscribe   body: subscription JSON (endpoint + keys)
 *         intent=unsubscribe body: endpoint
 *
 * Subscriptions persist in the instance's data root via push.server.ts
 * (per-instance = per-user). The watcher (server/push-watcher.mjs) reads
 * the same store to deliver.
 *
 * ASCII only - no em-dashes.
 */
import { z } from "zod";
import type { Route } from "./+types/api.push-subscribe";
import {
  getVapidKeys,
  addSubscription,
  removeSubscription,
  PushSubscriptionSchema,
} from "~/lib/push.server";

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
}

export async function loader(_args: Route.LoaderArgs) {
  return json({ ok: true, publicKey: getVapidKeys().publicKey }, 200);
}

const BodySchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("subscribe"),
    subscription: PushSubscriptionSchema,
  }),
  z.object({
    intent: z.literal("unsubscribe"),
    endpoint: z.string().url(),
  }),
]);

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST required" }, 405);
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      { ok: false, error: parsed.error.issues[0]?.message ?? "invalid body" },
      400
    );
  }

  if (parsed.data.intent === "subscribe") {
    addSubscription(
      parsed.data.subscription,
      request.headers.get("user-agent") ?? undefined
    );
    return json({ ok: true }, 200);
  }

  removeSubscription(parsed.data.endpoint);
  return json({ ok: true }, 200);
}
