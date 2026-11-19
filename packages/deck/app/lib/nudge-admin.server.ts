import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";
import type { AppLoadContext } from "react-router";
import { isLoopbackAddress, isLoopbackHost } from "../../server/bind-host.mjs";

export const devSocketAddress = new AsyncLocalStorage<string | undefined>();

export const NUDGES_READ_ONLY =
  "Nudges editing requires an allowed Host, such as localhost. Remote editing also requires MC_CRON_ALLOW_REMOTE_ADMIN=1 on the server. With that setting, IP addresses and names in MC_CRON_ALLOWED_HOSTS are also allowed.";

function isDirectLoopback(request: Request, context: AppLoadContext) {
  const address = context?.socketAddress ?? devSocketAddress.getStore();
  return isLoopbackAddress(address) &&
    !["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"]
      .some((header) => request.headers.has(header));
}

function isAllowedHost(host: string | null, allowRemote: boolean) {
  if (!host) return false;
  const rawHostname = host.match(/^(\[[\da-f:.]+\]|[a-z\d.-]+)(?::\d+)?$/i)?.[1];
  if (!rawHostname) return false;
  const hostname = URL.parse(`http://${host}`)?.hostname.replace(/^\[|\]$/g, "");
  if (hostname === undefined) return false;
  if (isLoopbackHost(hostname) || hostname === "::ffff:7f00:1" ||
    hostname === process.env["HOST"]?.toLowerCase()
  ) return true;
  if (!allowRemote) return false;

  return isIP(rawHostname.replace(/^\[|\]$/g, "")) !== 0 ||
    (process.env["MC_CRON_ALLOWED_HOSTS"]?.split(",")
      .some((allowedHost) => allowedHost.trim().toLowerCase() === hostname) ?? false);
}

export function canManageNudges(request: Request, context: AppLoadContext) {
  const allowRemote = process.env["MC_CRON_ALLOW_REMOTE_ADMIN"] === "1";
  return isAllowedHost(request.headers.get("host"), allowRemote) &&
    (allowRemote || isDirectLoopback(request, context));
}

function hasSameOriginProof(request: Request, context: AppLoadContext) {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;

  const origin = request.headers.get("origin");
  if (origin === null) return site !== null || isDirectLoopback(request, context);

  const parsed = URL.parse(origin);
  if (!parsed || !/^https?:$/.test(parsed.protocol) || parsed.origin !== origin.toLowerCase()) return false;
  return parsed.host === URL.parse(`${parsed.protocol}//${request.headers.get("host")}`)?.host;
}

export function requireNudgeAdmin(request: Request, context: AppLoadContext) {
  if (!canManageNudges(request, context)) {
    throw new Response(NUDGES_READ_ONLY, { status: 403 });
  }
  if (!hasSameOriginProof(request, context)) {
    throw new Response("Nudges writes require a same-origin request.", { status: 403 });
  }
}
