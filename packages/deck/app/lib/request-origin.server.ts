import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";
import type { AppLoadContext } from "react-router";
import { isLoopbackAddress, isLoopbackHost } from "../../server/bind-host.mjs";

export const devSocketAddress = new AsyncLocalStorage<string | undefined>();

export function isDirectLoopback(request: Request, context: AppLoadContext) {
  const address = context?.socketAddress ?? devSocketAddress.getStore();
  return isLoopbackAddress(address) &&
    !["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"]
      .some((header) => request.headers.has(header));
}

export function isAllowedHost(host: string | null, extraHosts?: string, allowAnyIp = false) {
  if (!host) return false;
  const rawHostname = host.match(/^(\[[\da-f:.]+\]|[a-z\d.-]+)(?::\d+)?$/i)?.[1];
  if (!rawHostname) return false;
  const hostname = URL.parse(`http://${host}`)?.hostname.replace(/^\[|\]$/g, "");
  if (hostname === undefined) return false;
  if (isLoopbackHost(hostname) || hostname === "::ffff:7f00:1" ||
    hostname === process.env["HOST"]?.toLowerCase()
  ) return true;

  return (allowAnyIp && isIP(rawHostname.replace(/^\[|\]$/g, "")) !== 0) ||
    (extraHosts?.split(",").some((allowedHost) => allowedHost.trim().toLowerCase() === hostname) ?? false);
}

export function hasSameOriginProof(request: Request, context: AppLoadContext) {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;

  const origin = request.headers.get("origin");
  if (origin === null) return site !== null || isDirectLoopback(request, context);

  const parsed = URL.parse(origin);
  if (!parsed || !/^https?:$/.test(parsed.protocol) || parsed.origin !== origin.toLowerCase()) return false;
  return parsed.host === URL.parse(`${parsed.protocol}//${request.headers.get("host")}`)?.host;
}

export function requireSameOriginWrite(request: Request, context: AppLoadContext) {
  const error = !isAllowedHost(request.headers.get("host"), process.env["MC_ALLOWED_HOSTS"])
    ? "Writes require an allowed Host. Add trusted public hostnames to MC_ALLOWED_HOSTS."
    : !hasSameOriginProof(request, context)
      ? "Writes require a same-origin request."
      : null;

  if (error) {
    throw Response.json({ ok: false, error }, {
      status: 403,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
