/** A browser subscription alone does not prove this instance can deliver. */
export function pushSyncState(
  hasSubscription: boolean,
  serverConfirmed: boolean
): "off" | "out-of-sync" | "subscribed" {
  if (!hasSubscription) return "off";
  return serverConfirmed ? "subscribed" : "out-of-sync";
}

export function applicationServerKeyString(key: ArrayBuffer | null): string | null {
  if (!key) return null;
  return btoa(String.fromCharCode(...new Uint8Array(key)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
