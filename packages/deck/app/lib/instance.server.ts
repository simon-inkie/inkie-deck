/**
 * instance.server.ts - per-instance configuration.
 *
 * Inkie Deck can run as one instance per person: each daemon is the SAME
 * codebase started with different env. This module is the single place that env is interpreted.
 *
 * - MC_USER: whose world this instance serves. Drives which participant
 *   files are read/written (<agent>/inbox/<user>.md), the own-message
 *   exclusion in the queue, and the `from:` on replies/card answers.
 *   Default is the built-in operator id, so an instance with no env behaves as the
 *   single-user default.
 *
 * - MC_TMUX_ENABLED: the tmux view + send surface. Typing into agent
 *   sessions is the classifier-consent surface and stays the operator's; any other
 *   instance starts with this off. Default enabled; set "0" or "false" to
 *   disable. Gates the nav item, the thread toggle, the /tmux route body,
 *   and the api/tmux-send action (server-side, not just UI).
 *
 * - ACTIVITY_ROOT / MC_ACTIVITY_ENABLED: the agent-activity panel.
 *   Presence of the root IS the gate; see activityEnabled below.
 *
 * SEAM RULE: .server module - loaders/actions call these with
 * process.env; nothing client-side imports this.
 * ASCII only - no em-dashes.
 */

import { resolveActivityRoot } from "./activity.server";

type Env = Record<string, string | undefined>;

/** The user this instance serves. Defaults to the built-in operator id (zero-change legacy). */
export function mcUser(env: Env): string {
  const v = env["MC_USER"]?.trim();
  return v ? v : "alex";
}

/** Whether the tmux view/send surface is enabled on this instance. */
export function tmuxEnabled(env: Env): boolean {
  const v = env["MC_TMUX_ENABLED"]?.trim().toLowerCase();
  return !(v === "0" || v === "false");
}

/**
 * Whether the agent-activity panel is exposed on this instance.
 *
 * CONFIG PRESENCE IS THE GATE. An instance sees the panel exactly when its
 * .env names an ACTIVITY_ROOT for it to read; another instance does not,
 * so it shows nothing without any explicit disable flag anywhere, and turning it
 * on there later is one line in its .env rather than a code change. This
 * is deliberately NOT a second boolean mirroring MC_TMUX_ENABLED: a
 * default-enabled boolean would need every other instance to carry an explicit
 * "off", which is a rule you can only get wrong by forgetting it, and the panel
 * cannot render a single thing without the root anyway.
 *
 * MC_ACTIVITY_ENABLED="0"/"false" is an explicit kill switch on top, following
 * cronAdminEnabled's shape (explicit off beats the derived default). It exists
 * so a misbehaving panel can be turned off in one env var without removing the
 * root that the CLI half of this feature is also documented against.
 */
export function activityEnabled(env: Env): boolean {
  const explicit = env["MC_ACTIVITY_ENABLED"]?.trim().toLowerCase();
  if (explicit === "0" || explicit === "false") return false;
  return resolveActivityRoot(env) !== undefined;
}

/**
 * Top-bar workspace label for this instance. A non-default user's instance
 * shows a "<name>'s workspace" label next to the wordmark so it is
 * unmistakable whose world you are in. MC_INSTANCE_LABEL overrides; default
 * derives from MC_USER for any user other than the default; the operator's
 * instance shows none (it is their daily driver and needs no extra chrome).
 */
export function instanceLabel(env: Env): string | undefined {
  const override = env["MC_INSTANCE_LABEL"]?.trim();
  if (override) return override;
  const user = mcUser(env);
  if (user === "alex") return undefined;
  return `${user.charAt(0).toUpperCase()}${user.slice(1)}'s workspace`;
}

/**
 * Whether the per-agent model selector (selector contract, M4-M6) is exposed
 * on this instance. OPERATOR control: which model an agent runs is a cost +
 * capability decision, and a "change an agent's model" dropdown on another user's
 * surface is a footgun and out of their remit. The operator IS the default
 * user, so no new env is needed: the operator's instance (MC_USER unset)
 * gets the control, an instance with MC_USER set to another user never sees it. Gates the
 * top-bar UI via the shell loader AND the api/agent-model loader + action
 * server-side (same posture as the api/tmux-send gate - hidden UI alone is
 * not a gate).
 */
export function modelSelectorEnabled(env: Env): boolean {
  return mcUser(env) === "alex";
}

/**
 * Whether the cron admin page is enabled on this instance.
 *
 * Enabled for the known trusted principals by default. Writing the system
 * crontab is operator-grade, so the list is deliberately short. Set
 * MC_CRON_ADMIN_ENABLED=0 or "false" to explicitly disable on any instance.
 */
export function cronAdminEnabled(env: Env): boolean {
  const explicit = env["MC_CRON_ADMIN_ENABLED"]?.trim().toLowerCase();
  if (explicit === "0" || explicit === "false") return false;
  const user = mcUser(env);
  return user === "alex" || user === "robin";
}

/**
 * Per-instance projects-board scope: a second user's board must show their own
 * agents' cards, not the whole team kanban.
 *
 * MC_PROJECTS_AGENTS: comma-separated agent allowlist. Unset/empty = no
 * filter (the operator's instance sees everything, unchanged). Applied to every
 * listCards consumer: the board, the bell's blocked feed, the home queue's
 * blocked kind, the work strip, and the ticket-lens card match.
 */
export function projectsAgents(env: Env): string[] | undefined {
  const raw = env["MC_PROJECTS_AGENTS"]?.trim();
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
  return list.length > 0 ? list : undefined;
}

/**
 * Filter project cards to this instance's scope (no-op when unset).
 * A card passes when its agent is allowlisted OR it is explicitly assigned
 * to this instance's user - a todo another agent owns but
 * this user is waiting on still reaches their board.
 */
export function filterCardsForInstance<T extends { agent: string; assignee?: string }>(
  cards: T[],
  env: Env
): T[] {
  const allow = projectsAgents(env);
  if (!allow) return cards;
  const user = mcUser(env);
  return cards.filter(
    (c) => allow.includes(c.agent.toLowerCase()) || c.assignee === user
  );
}
