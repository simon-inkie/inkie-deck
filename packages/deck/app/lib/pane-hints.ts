import { IDLE_PROMPT_RE, SHELL_PROMPT_RE } from "./pane-prompts";

/** Pattern provenance: base boot fixtures and synthetic examples; CLI versions unverified. */
const DIALOGS = [
  ["H1", /^(?:(?:Do you trust|Trust) (?:the files|this folder|this workspace)\b|Yes, I trust this folder\b|Quick safety check\b)/i],
  ["H2", /^Select login method\b/i],
  ["H3", /^(?:Detected a custom API key\b|(?:\u26A0\uFE0F?\s*)?Do you want to use this API key\b)/i],
  ["H4", /^(?:Resume a conversation\b|Select a conversation\b|Resume picker\b|(?:Try|Use|Enable|Switch to) (?:the )?full.?screen (?:renderer|mode)\b|Choose the text style\b)/i],
] as const;

export type PaneHintId = (typeof DIALOGS)[number][0] | "H5";

const BORDER_START_RE = /^[\s\u2500-\u257F]+/;
const BORDER_END_RE = /[\s\u2500-\u257F]+$/;
const SELECTION_RE = /^[\u276F\u203A]\s*(?=\S)/;
const NUMBERED_OPTION_RE = /^\d+[.)]\s+/;
const CONFIRM_RE = /^Enter to confirm\b/i;

export function classifyPaneHint(capture: string): PaneHintId | null {
  const tail = capture.trimEnd().split("\n").slice(-30);
  if (SHELL_PROMPT_RE.test(tail.at(-1) ?? "")) return "H5";

  const lines = tail.map((line) =>
    line.replaceAll("\u00A0", " ").replace(BORDER_START_RE, "").replace(BORDER_END_RE, ""),
  );
  const lastPrompt = lines.map((line) => IDLE_PROMPT_RE.test(line) || SHELL_PROMPT_RE.test(line)).lastIndexOf(true);
  const current = lines.slice(lastPrompt + 1);
  const selections = current.filter((line) => SELECTION_RE.test(line));
  const hasUnnumberedTrustSelection = selections.length > 0 && !selections.some((line) =>
    NUMBERED_OPTION_RE.test(line.replace(SELECTION_RE, "")),
  );

  for (const [hint, phrase] of DIALOGS) {
    if (hint === "H1" && hasUnnumberedTrustSelection) continue;

    if (current.some((line, index) => {
      const wording = line.replace(SELECTION_RE, "").replace(NUMBERED_OPTION_RE, "");
      return phrase.test(wording) && current.some((other, otherIndex) =>
        otherIndex !== index && (SELECTION_RE.test(other) || CONFIRM_RE.test(other)),
      );
    })) return hint;
  }

  return null;
}
