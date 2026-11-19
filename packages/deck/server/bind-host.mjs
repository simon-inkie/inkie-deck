export function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function isLoopbackHost(host) {
  return host === "localhost" || isLoopbackAddress(host);
}

export function warnNetworkBind(label, host) {
  if (!isLoopbackHost(host)) {
    console.warn(`[${label}] WARNING: HOST=${host}: anyone who can open this page can message your agents and, if enabled, create scheduled jobs on this machine`);
  }
}
