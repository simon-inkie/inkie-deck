import { AsyncLocalStorage } from "node:async_hooks";
import type { AppLoadContext } from "react-router";
import { isLoopbackAddress } from "../../server/bind-host.mjs";

export const devSocketAddress = new AsyncLocalStorage<string | undefined>();

export const NUDGES_READ_ONLY =
  "Nudges are read-only unless you connect directly from this machine or set MC_CRON_ALLOW_REMOTE_ADMIN=1 on the server.";

export function canManageNudges(request: Request, context: AppLoadContext) {
  if (process.env["MC_CRON_ALLOW_REMOTE_ADMIN"] === "1") return true;
  const address = context?.socketAddress ?? devSocketAddress.getStore();
  return isLoopbackAddress(address) &&
    !["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"]
      .some((header) => request.headers.has(header));
}

export function requireNudgeAdmin(request: Request, context: AppLoadContext) {
  if (!canManageNudges(request, context)) {
    throw new Response(NUDGES_READ_ONLY, { status: 403 });
  }
}
