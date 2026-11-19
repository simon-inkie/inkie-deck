import type { AppLoadContext } from "react-router";
import { hasSameOriginProof, isAllowedHost, isDirectLoopback } from "./request-origin.server";

export { devSocketAddress } from "./request-origin.server";

export const NUDGES_READ_ONLY =
  "Nudges editing requires an allowed Host, such as localhost. Remote editing also requires MC_CRON_ALLOW_REMOTE_ADMIN=1 on the server. With that setting, IP addresses and names in MC_CRON_ALLOWED_HOSTS are also allowed.";

export function canManageNudges(request: Request, context: AppLoadContext) {
  const allowRemote = process.env["MC_CRON_ALLOW_REMOTE_ADMIN"] === "1";
  const extraHosts = allowRemote ? process.env["MC_CRON_ALLOWED_HOSTS"] : undefined;
  return isAllowedHost(request.headers.get("host"), extraHosts, allowRemote) &&
    (allowRemote || isDirectLoopback(request, context));
}

export function requireNudgeAdmin(request: Request, context: AppLoadContext) {
  if (!canManageNudges(request, context)) {
    throw new Response(NUDGES_READ_ONLY, { status: 403 });
  }
  if (!hasSameOriginProof(request, context)) {
    throw new Response("Nudges writes require a same-origin request.", { status: 403 });
  }
}
