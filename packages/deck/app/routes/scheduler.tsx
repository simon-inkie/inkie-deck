/**
 * scheduler.tsx - Scheduler admin page.
 *
 * Lists managed schedules (MC-CRON-tagged crontab lines) and provides a form to
 * create new ones. Hidden entirely + server-refused when not on the operator's
 * instance (cronAdminEnabled = false).
 *
 * Internal names (cron.server, cron-validate, MC-CRON tag, cronAdminEnabled,
 * api/cron path) are preserved. This file is the user-facing rename only.
 *
 * Ask-1: agent messages use a large textarea; delivered via bracketed-paste.
 * Ask-2: every-N-min presets added to SCHEDULE_PRESETS in cron-validate.ts.
 * Ask-3: targetType toggle (agent | script).
 *
 * SEAM RULE: imports ONLY from ~/lib/*.server and ~/lib/cron-validate.
 * No fs, no subprocess, no literal paths in this file.
 * ASCII only - no em-dashes.
 */

import { useState, useEffect } from "react";
import { useFetcher } from "react-router";
import type { Route } from "./+types/scheduler";
import { listCrons, listAgentDirs } from "~/lib/cron.server";
import { cronAdminEnabled } from "~/lib/instance.server";
import {
  SCHEDULE_PRESETS,
  validateCronExpression,
  humanizeSchedule,
} from "~/lib/cron-validate";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Select, SelectItem } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader(_args: Route.LoaderArgs) {
  // Gate: only the operator's instance can see/use this page.
  if (!cronAdminEnabled(process.env)) {
    throw new Response("Not found", { status: 404 });
  }
  const crons = listCrons();
  const agents = listAgentDirs();
  return { crons, agents };
}

// ---------------------------------------------------------------------------
// Action (thin wrapper - same gate as api.cron.tsx, inline for simplicity)
// ---------------------------------------------------------------------------

export async function action({ request }: Route.ActionArgs) {
  if (!cronAdminEnabled(process.env)) {
    return { ok: false as const, error: "Nudges admin is not available on this instance." };
  }
  // Proxy to cron.server functions directly (same seam, no HTTP round-trip needed).
  const { createCron, updateCron, setEnabled, deleteCron } = await import("~/lib/cron.server");
  const formData = await request.formData();
  const raw = Object.fromEntries(formData);
  const intent = raw["intent"];

  if (intent === "create") {
    const schedule = String(raw["schedule"] ?? "").trim();
    const target = String(raw["target"] ?? "").trim();
    const message = String(raw["message"] ?? "").trim();
    const targetType = raw["targetType"] === "script" ? "script" as const : "agent" as const;
    // Use === "true" not !== "false": an unchecked native checkbox is OMITTED
    // from formData (undefined), so undefined !== "false" was always true.
    // A hidden input with value="false" + the Switch value="true" when checked
    // ensures the field is always present with the correct value.
    const enabled = raw["enabled"] === "true";
    if (!schedule || !target || !message) {
      return { ok: false as const, error: "Missing required fields." };
    }
    const expr = validateCronExpression(schedule);
    if (!expr.ok) return { ok: false as const, error: expr.error };
    return createCron({ schedule: expr.expression, target, message, enabled, targetType });
  }

  if (intent === "edit") {
    const id = String(raw["id"] ?? "").trim();
    const schedule = String(raw["schedule"] ?? "").trim();
    const target = String(raw["target"] ?? "").trim();
    const message = String(raw["message"] ?? "").trim();
    const targetType = raw["targetType"] === "script" ? "script" as const : "agent" as const;
    const enabled = raw["enabled"] === "true";
    if (!id || !schedule || !target || !message) {
      return { ok: false as const, error: "Missing required fields." };
    }
    // updateCron re-runs the SAME validation internally (the seam owns the
    // injection guard); validate here too so a bad schedule is rejected before
    // the seam call, mirroring the create path.
    const expr = validateCronExpression(schedule);
    if (!expr.ok) return { ok: false as const, error: expr.error };
    return updateCron({ id, schedule: expr.expression, target, message, enabled, targetType });
  }

  if (intent === "setEnabled") {
    const id = String(raw["id"] ?? "").trim();
    const enabled = raw["enabled"] === "true";
    return setEnabled(id, enabled);
  }

  if (intent === "delete") {
    const id = String(raw["id"] ?? "").trim();
    return deleteCron(id);
  }

  return { ok: false as const, error: `Unknown intent: "${String(intent)}".` };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SchedulerPage({ loaderData }: Route.ComponentProps) {
  const { crons, agents } = loaderData;
  const fetcher = useFetcher();
  const [schedulePreset, setSchedulePreset] = useState("daily-0730");
  const [customExpr, setCustomExpr] = useState("");
  const [exprError, setExprError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [targetType, setTargetType] = useState<"agent" | "script">("agent");

  const resolvedSchedule =
    schedulePreset === "custom"
      ? customExpr
      : SCHEDULE_PRESETS.find((p) => p.value === schedulePreset)?.cron ?? "";

  function handlePresetChange(e: React.ChangeEvent<HTMLSelectElement>) {
    setSchedulePreset(e.target.value);
    setExprError(null);
  }

  function handleCustomChange(e: React.ChangeEvent<HTMLInputElement>) {
    setCustomExpr(e.target.value);
    const result = validateCronExpression(e.target.value);
    setExprError(result.ok ? null : result.error);
  }

  const isSubmitting = fetcher.state !== "idle";
  const actionError =
    fetcher.data && "ok" in fetcher.data && !fetcher.data.ok
      ? (fetcher.data as { ok: false; error: string }).error
      : null;

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <div>
        <h1 className="font-display text-2xl font-black uppercase tracking-tight text-foreground">
          Nudges
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          System crontab entries that survive CC restarts and compacts.
          Each entry writes a nudge script to the target agent&apos;s bin/ directory.
        </p>
      </div>

      {/* Create form */}
      <Card>
        <CardHeader>
          <CardTitle>New nudge</CardTitle>
        </CardHeader>
        <CardContent>
          <fetcher.Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="create" />
            <input type="hidden" name="targetType" value={targetType} />

            {/* Target type toggle */}
            <div className="space-y-2">
              <Label>Type</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={targetType === "agent" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setTargetType("agent")}
                >
                  Agent nudge
                </Button>
                <Button
                  type="button"
                  variant={targetType === "script" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setTargetType("script")}
                >
                  Bash script
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {targetType === "agent"
                  ? "Paste a markdown prompt into the agent's tmux pane via bracketed-paste."
                  : "Run a bash script directly from cron (no tmux). Script body is arbitrary shell."}
              </p>
            </div>

            {/* Schedule */}
            <div className="space-y-2">
              <Label htmlFor="schedule-preset">Schedule</Label>
              <Select
                id="schedule-preset"
                value={schedulePreset}
                onChange={handlePresetChange}
              >
                {SCHEDULE_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </Select>

              {schedulePreset === "custom" ? (
                <div className="space-y-1">
                  <Input
                    name="schedule"
                    placeholder="*/30 * * * *"
                    value={customExpr}
                    onChange={handleCustomChange}
                    aria-describedby="custom-expr-hint"
                  />
                  <p
                    id="custom-expr-hint"
                    className="text-xs text-muted-foreground"
                  >
                    5-field cron expression (minimum every 1 minute).
                  </p>
                  {exprError ? (
                    <p className="text-xs text-destructive">{exprError}</p>
                  ) : null}
                </div>
              ) : (
                <input
                  type="hidden"
                  name="schedule"
                  value={resolvedSchedule}
                />
              )}

              {resolvedSchedule && schedulePreset !== "custom" ? (
                <p className="label-mono text-xs text-muted-foreground">
                  Resolved: {resolvedSchedule}
                </p>
              ) : null}
            </div>

            {/* Target agent (agent mode only) */}
            {targetType === "agent" ? (
              <div className="space-y-2">
                <Label htmlFor="target">Target agent</Label>
                <Select id="target" name="target" defaultValue="">
                  <SelectItem value="" disabled>
                    Select an agent...
                  </SelectItem>
                  {agents.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </Select>
              </div>
            ) : (
              /* Script mode: target still required (determines bin/ dir) */
              <div className="space-y-2">
                <Label htmlFor="target">Agent directory (bin/ location)</Label>
                <Select id="target" name="target" defaultValue="">
                  <SelectItem value="" disabled>
                    Select an agent...
                  </SelectItem>
                  {agents.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </Select>
                <p className="text-xs text-muted-foreground">
                  Script is written to ~/agents/&lt;agent&gt;/bin/ and run directly.
                </p>
              </div>
            )}

            {/* Message / script body */}
            <div className="space-y-2">
              <Label htmlFor="message">
                {targetType === "agent" ? "Prompt" : "Script body"}
              </Label>
              <textarea
                id="message"
                name="message"
                rows={8}
                maxLength={4000}
                placeholder={
                  targetType === "agent"
                    ? "07:33 morning check-in: generate today's dashboard and check the inbox..."
                    : "#!/usr/bin/env bash\n# Your cron script here\npnpm --dir ~/projects/the-vault run some-task"
                }
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 font-mono"
              />
              <p className="text-xs text-muted-foreground">
                {targetType === "agent"
                  ? "Markdown is fine. Pasted verbatim via bracketed-paste (max 4000 chars)."
                  : "Bash script body run directly by cron (max 4000 chars). Arbitrary shell."}
              </p>
            </div>

            {/* Enabled toggle */}
            {/* Hidden input ensures "false" is submitted when the Switch is unchecked.
                A native unchecked checkbox is omitted from formData entirely;
                the Switch (value="true") overrides this when checked. */}
            <div className="flex items-center gap-3">
              <input type="hidden" name="enabled" value="false" />
              <Switch
                id="enabled-toggle"
                name="enabled"
                checked={enabled}
                value="true"
                onChange={(e) => setEnabled(e.target.checked)}
                label="Enable immediately"
              />
            </div>

            {actionError ? (
              <p className="text-sm text-destructive">{actionError}</p>
            ) : null}

            <Button
              type="submit"
              disabled={
                isSubmitting ||
                (schedulePreset === "custom" && (exprError !== null || !customExpr))
              }
            >
              {isSubmitting ? "Saving..." : "Create nudge"}
            </Button>
          </fetcher.Form>
        </CardContent>
      </Card>

      {/* Nudge list */}
      <div className="space-y-3">
        <h2 className="font-display text-lg font-bold uppercase tracking-tight text-foreground">
          Nudges ({crons.length})
        </h2>

        {crons.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No nudges yet. Create one above.
          </p>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border bg-card">
            {crons.map((cron) => (
              <CronRow key={cron.id} cron={cron} agents={agents} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CronRow
// ---------------------------------------------------------------------------

interface CronRowProps {
  cron: {
    id: string;
    schedule: string;
    target: string;
    message: string;
    targetType: string;
    scriptPath: string;
    enabled: boolean;
    lastFired: string | null;
    lastDelivered: string | null;
  };
  agents: string[];
}

function CronRow({ cron, agents }: CronRowProps) {
  const fetcher = useFetcher();
  const [isEditing, setIsEditing] = useState(false);

  function handleToggle() {
    const formData = new FormData();
    formData.set("intent", "setEnabled");
    formData.set("id", cron.id);
    formData.set("enabled", cron.enabled ? "false" : "true");
    fetcher.submit(formData, { method: "post" });
  }

  function handleDelete() {
    if (!window.confirm(`Delete nudge ${cron.id} for ${cron.target}?`)) return;
    const formData = new FormData();
    formData.set("intent", "delete");
    formData.set("id", cron.id);
    fetcher.submit(formData, { method: "post" });
  }

  const isWorking = fetcher.state !== "idle";

  // When editing, the whole row becomes the pre-filled edit form. Same field
  // shapes + validation as the create form (custom-expression path), so an edit
  // round-trips through the SAME updateCron seam guards.
  if (isEditing) {
    return (
      <EditCronForm
        cron={cron}
        agents={agents}
        onClose={() => setIsEditing(false)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="label-mono text-xs font-bold text-foreground">
            {cron.id}
          </span>
          <Badge
            variant={cron.enabled ? "default" : "secondary"}
            className="text-[10px]"
          >
            {cron.enabled ? "enabled" : "disabled"}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {cron.targetType === "script" ? "script" : "agent"}
          </Badge>
          <Badge
            variant="outline"
            className="label-mono border-transparent bg-accent px-2.5 py-0.5 text-xs font-bold text-accent-foreground"
          >
            {cron.target}
          </Badge>
        </div>
        <p className="text-sm font-medium text-foreground">
          {humanizeSchedule(cron.schedule)}
        </p>
        <p className="label-mono text-xs text-muted-foreground">{cron.schedule}</p>
        {cron.message ? (
          <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground font-mono bg-muted/40 rounded p-2 max-h-32 overflow-y-auto">
            {cron.message}
          </pre>
        ) : null}
        <div className="flex gap-4 text-[10px] text-muted-foreground">
          <span>
            Fired:{" "}
            {cron.lastFired
              ? new Date(cron.lastFired).toLocaleString()
              : "Never"}
          </span>
          <span>
            Delivered:{" "}
            {cron.lastDelivered
              ? new Date(cron.lastDelivered).toLocaleString()
              : "Never"}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isWorking}
          onClick={() => setIsEditing(true)}
        >
          Edit
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isWorking}
          onClick={handleToggle}
        >
          {cron.enabled ? "Disable" : "Enable"}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={isWorking}
          onClick={handleDelete}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EditCronForm - inline edit form pre-filled with an existing nudge's values
// ---------------------------------------------------------------------------

interface EditCronFormProps {
  cron: CronRowProps["cron"];
  agents: string[];
  onClose: () => void;
}

function EditCronForm({ cron, agents, onClose }: EditCronFormProps) {
  const fetcher = useFetcher();
  const targetType: "agent" | "script" =
    cron.targetType === "script" ? "script" : "agent";

  // Pre-fill the schedule as a custom 5-field expression (always round-trips,
  // no preset-matching needed). Same client-side validation as the create form.
  const [customExpr, setCustomExpr] = useState(cron.schedule);
  const [exprError, setExprError] = useState<string | null>(null);
  const [target, setTarget] = useState(cron.target);
  const [enabled, setEnabled] = useState(cron.enabled);

  function handleCustomChange(e: React.ChangeEvent<HTMLInputElement>) {
    setCustomExpr(e.target.value);
    const result = validateCronExpression(e.target.value);
    setExprError(result.ok ? null : result.error);
  }

  // Submitted state lives on this fetcher; close the form once the edit lands
  // (revalidation re-renders the list with the new values).
  const isSubmitting = fetcher.state !== "idle";
  const actionData = fetcher.data as
    | { ok: true }
    | { ok: false; error: string }
    | undefined;
  const actionError =
    actionData && "ok" in actionData && !actionData.ok ? actionData.error : null;
  const submitSucceeded =
    actionData !== undefined && "ok" in actionData && actionData.ok === true;

  // Close on the idle-after-success transition (effect, not during render).
  useEffect(() => {
    if (submitSucceeded && fetcher.state === "idle") {
      onClose();
    }
  }, [submitSucceeded, fetcher.state, onClose]);

  return (
    <div className="bg-muted/30 p-4">
      <fetcher.Form method="post" className="space-y-4">
        <input type="hidden" name="intent" value="edit" />
        <input type="hidden" name="id" value={cron.id} />
        <input type="hidden" name="targetType" value={targetType} />

        <p className="label-mono text-xs font-bold text-foreground">
          Editing nudge {cron.id}
        </p>

        {/* Schedule (custom expression) */}
        <div className="space-y-1">
          <Label htmlFor={`edit-schedule-${cron.id}`}>Schedule</Label>
          <Input
            id={`edit-schedule-${cron.id}`}
            name="schedule"
            placeholder="*/30 * * * *"
            value={customExpr}
            onChange={handleCustomChange}
            aria-describedby={`edit-expr-hint-${cron.id}`}
          />
          <p
            id={`edit-expr-hint-${cron.id}`}
            className="text-xs text-muted-foreground"
          >
            5-field cron expression (minimum every 1 minute).
          </p>
          {exprError ? (
            <p className="text-xs text-destructive">{exprError}</p>
          ) : null}
        </div>

        {/* Target agent */}
        <div className="space-y-2">
          <Label htmlFor={`edit-target-${cron.id}`}>
            {targetType === "agent" ? "Target agent" : "Agent directory (bin/ location)"}
          </Label>
          <Select
            id={`edit-target-${cron.id}`}
            name="target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <SelectItem value="" disabled>
              Select an agent...
            </SelectItem>
            {agents.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </Select>
        </div>

        {/* Message / script body */}
        <div className="space-y-2">
          <Label htmlFor={`edit-message-${cron.id}`}>
            {targetType === "agent" ? "Prompt" : "Script body"}
          </Label>
          <textarea
            id={`edit-message-${cron.id}`}
            name="message"
            rows={8}
            maxLength={4000}
            defaultValue={cron.message}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 font-mono"
          />
        </div>

        {/* Enabled toggle */}
        <div className="flex items-center gap-3">
          <input type="hidden" name="enabled" value="false" />
          <Switch
            id={`edit-enabled-${cron.id}`}
            name="enabled"
            checked={enabled}
            value="true"
            onChange={(e) => setEnabled(e.target.checked)}
            label="Enabled"
          />
        </div>

        {actionError ? (
          <p className="text-sm text-destructive">{actionError}</p>
        ) : null}

        <div className="flex gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={isSubmitting || exprError !== null || !customExpr}
          >
            {isSubmitting ? "Saving..." : "Save nudge"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isSubmitting}
            onClick={onClose}
          >
            Cancel
          </Button>
        </div>
      </fetcher.Form>
    </div>
  );
}
