export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute"
  | "think" | "fetch" | "switch_mode" | "other";
export type ToolStatus = "pending" | "in_progress" | "completed" | "failed" | "other";
export type OptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always" | "other";
export type Outcome = "completed" | "truncated" | "refused" | "cancelled" | "failed"
  | "invalid" | "disconnected" | "unsupported";

export type DisplayProjection =
  | { kind: "tool"; name: string; toolKind: ToolKind; status: ToolStatus; paths: string[] }
  | { kind: "permission"; tool: string; options: { id: string; label: string; optionKind: OptionKind }[] }
  | { kind: "turn"; outcome: Outcome; reason: string }
  | { kind: "text"; excerpt: string };

export type DeckEvent = {
  v: 1;
  id: string;
  seq: number;
  ts: string;
  source: {
    kind: "agent" | "subagent" | "session" | "run" | "stage";
    session?: string;
    generation?: number;
    parent?: string;
    task?: string;
  };
  class: "decision" | "action" | "happened";
  type: "permission.requested" | "permission.answered" | "tool.updated" | "message.chunk"
    | "plan.updated" | "turn.settled" | "turn.disconnected" | "session.unsupported" | "session.failed";
  title: string;
  view: DisplayProjection;
  dedupeKey?: string;
  answers?: string;
};

export function printableId(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[^ -~]/.test(value);
}

function enumValue<const Values extends readonly string[], Fallback extends string>(
  value: string, values: Values, fallback: Fallback,
): Values[number] | Fallback {
  return values.find((entry) => entry === value) ?? fallback;
}

export function displayText(value: string, limit: number): string {
  const text = value.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "");
  const bounded = text.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(bounded) ? bounded.slice(0, -1) : bounded;
}

export function projectDisplay(view: DisplayProjection): DisplayProjection {
  switch (view.kind) {
    case "tool": return {
      kind: "tool", name: displayText(view.name, 120),
      toolKind: enumValue(view.toolKind, ["read", "edit", "delete", "move", "search", "execute",
        "think", "fetch", "switch_mode"], "other"),
      status: enumValue(view.status, ["pending", "in_progress", "completed", "failed"], "other"),
      paths: view.paths.slice(0, 20).map((entry) => displayText(entry, 512)),
    };
    case "permission":
      if (view.options.length > 6 || view.options.some(({ id }) => !printableId(id, 64)) ||
          new Set(view.options.map(({ id }) => id)).size !== view.options.length) {
        throw new Error("Invalid display permission options");
      }
      return {
        kind: "permission", tool: displayText(view.tool, 120), options: view.options.map((option) => ({
          id: option.id, label: displayText(option.label, 80),
          optionKind: enumValue(option.optionKind, ["allow_once", "allow_always", "reject_once", "reject_always"], "other"),
        })),
      };
    case "turn": return {
      kind: "turn", outcome: enumValue(view.outcome, ["completed", "truncated", "refused", "cancelled",
        "failed", "disconnected", "unsupported"], "invalid"), reason: displayText(view.reason, 64),
    };
    case "text": return { kind: "text", excerpt: displayText(view.excerpt, 500) };
  }
}

type EventInput = Omit<DeckEvent, "v" | "id" | "ts" | "seq" | "source">;

export function createEventSource(source: DeckEvent["source"], issueId: () => string) {
  const { kind, session, generation, parent, task } = source;
  for (const identifier of [session, parent, task]) {
    if (identifier !== undefined && !printableId(identifier, 128)) throw new Error("Invalid event source id");
  }
  let sequence = 0;
  return ({ type, title, view, dedupeKey, answers, class: eventClass }: EventInput): DeckEvent => {
    const id = issueId();
    for (const identifier of [id, dedupeKey, answers]) {
      if (identifier !== undefined && !printableId(identifier, 64)) throw new Error("Invalid host event id");
    }
    return {
      v: 1, id, seq: ++sequence, ts: new Date().toISOString(),
      source: { kind, session, generation, parent, task }, class: eventClass, type,
      title: displayText(title, 200), view: projectDisplay(view), dedupeKey, answers,
    };
  };
}
