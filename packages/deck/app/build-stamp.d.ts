/**
 * Build stamp global - injected by vite.config.ts `define` at build time
 * (commit short-SHA, or "dev" outside a git checkout). Lets any client
 * surface prove which bundle it is running (stale-bundle diagnosis).
 */
declare const __MC_BUILD_SHA__: string;
