import {
  type RouteConfig,
  index,
  layout,
  route,
} from "@react-router/dev/routes";

export default [
  // Resource route for attachments - outside the shell layout (no chrome needed).
  route("attachments/*", "routes/attachments.$.tsx"),
  // Avatar serving - same resource-route discipline as attachments.
  route("avatars/:agent", "routes/avatars.$agent.tsx"),
  // Review panel data + asset routes - outside the shell layout.
  route("api/review", "routes/api.review.tsx"),
  route("api/review-asset", "routes/api.review-asset.tsx"),
  // Read/write tmux send seam - both tmux homes POST here (send-keys v1).
  route("api/tmux-send", "routes/api.tmux-send.tsx"),
  route("api/runner", "routes/api.runner.tsx"),
  route("api/acp", "routes/api.acp.tsx"),
  // Cron admin seam (read + write) - gated to the operator instance server-side.
  route("api/cron", "routes/api.cron.tsx"),
  // Thread-view load-older pagination (chunked lazy-load).
  route("api/thread-window", "routes/api.thread-window.tsx"),
  // Web-push subscription store (GET publicKey / POST subscribe).
  route("api/push-subscribe", "routes/api.push-subscribe.tsx"),
  // Per-agent model selector seam (M4) - operator instances only.
  route("api/agent-model", "routes/api.agent-model.tsx"),
  // File pinner / manifest: per-thread Files panel data + descriptions + pins.
  route("api/file-manifest", "routes/api.file-manifest.tsx"),
  route("api/file-pins", "routes/api.file-pins.tsx"),
  // #66: workspace Markdown drafts (read, create, save with conflict check).
  route("api/drafts", "routes/api.drafts.tsx"),
  // Read-only card stream for Deck Flows Slice 1b.
  route("api/flows", "routes/api.flows.tsx"),
  layout("routes/shell.tsx", [
    route("drafts", "routes/drafts.tsx"),
    index("routes/home.tsx"),
    route("threads/:agent", "routes/threads.$agent.tsx"),
    // Thread C: dedicated Decisions + Actions tab (additive second surface).
    route("cards", "routes/cards.tsx"),
    route("projects", "routes/projects.tsx"),
    route("flows", "routes/flows.tsx"),
    // Live tmux Team tab (readonly v1)
    route("tmux", "routes/tmux.tsx"),
    route("tickets/:ticketId", "routes/tickets.$ticketId.tsx"),
    // Cron admin page - operator-instance-only (404 on non-admin instances).
    route("scheduler", "routes/scheduler.tsx"),
  ]),
] satisfies RouteConfig;
