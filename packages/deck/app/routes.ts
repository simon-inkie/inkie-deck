import {
  type RouteConfig,
  index,
  layout,
  route,
} from "@react-router/dev/routes";

export default [
  // Resource route for attachments - outside the shell layout (no chrome needed).
  route("attachments/*", "routes/attachments.$.tsx"),
  // TASK-457: avatar serving - same resource-route discipline as attachments.
  route("avatars/:agent", "routes/avatars.$agent.tsx"),
  // TASK-431: review panel data + asset routes - outside the shell layout.
  route("api/review", "routes/api.review.tsx"),
  route("api/review-asset", "routes/api.review-asset.tsx"),
  // Read/write tmux send seam - both tmux homes POST here (send-keys v1).
  route("api/tmux-send", "routes/api.tmux-send.tsx"),
  // TASK-460: cron admin seam (read + write) - Alex-instance-only gate server-side.
  route("api/cron", "routes/api.cron.tsx"),
  // TASK-469: thread-view load-older pagination (chunked lazy-load).
  route("api/thread-window", "routes/api.thread-window.tsx"),
  // TASK-470: web-push subscription store (GET publicKey / POST subscribe).
  route("api/push-subscribe", "routes/api.push-subscribe.tsx"),
  // Per-agent model selector seam (M4) - operator instances only.
  route("api/agent-model", "routes/api.agent-model.tsx"),
  // File pinner / manifest: per-thread Files panel data + descriptions + pins.
  route("api/file-manifest", "routes/api.file-manifest.tsx"),
  route("api/file-pins", "routes/api.file-pins.tsx"),
  layout("routes/shell.tsx", [
    index("routes/home.tsx"),
    route("threads/:agent", "routes/threads.$agent.tsx"),
    // Thread C: dedicated Decisions + Actions tab (additive second surface).
    route("cards", "routes/cards.tsx"),
    route("projects", "routes/projects.tsx"),
    // TASK-437: live tmux Team tab (readonly v1)
    route("tmux", "routes/tmux.tsx"),
    route("tickets/:ticketId", "routes/tickets.$ticketId.tsx"),
    // TASK-460: cron admin page - Alex-instance-only (404 on non-admin instances).
    route("scheduler", "routes/scheduler.tsx"),
  ]),
] satisfies RouteConfig;
