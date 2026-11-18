import { HINT_SHELL_PROMPT_RE } from "./pane-prompts";

/** Pattern provenance: base boot fixtures and synthetic examples; CLI versions unverified. */
const DIALOGS = [
  ["H1", /^(?:(?:Do you trust|Trust) (?:the files|this folder|this workspace)\b|Yes, I trust this folder\b|Quick safety check[:.!]?$)/i],
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
const MENU_SIGNAL_WINDOW = 6;

export function classifyPaneHint(capture: string): PaneHintId | null {
  const tail = capture.trimEnd().split("\n").slice(-30);
  if (HINT_SHELL_PROMPT_RE.test(tail.at(-1) ?? "")) return "H5";

  const lines = tail.map((line) =>
    line.replaceAll("\u00A0", " ").replace(BORDER_START_RE, "").replace(BORDER_END_RE, ""),
  );
  while (lines.at(-1) === "") lines.pop();

  for (const [hint, phrase] of DIALOGS) {
    if (lines.some((line, index) => {
      const option = line.replace(SELECTION_RE, "");
      const wording = option.replace(NUMBERED_OPTION_RE, "");
      if (!phrase.test(wording)) return false;

      const menu = lines.slice(index + (lines[index + 1] === "" ? 2 : 1));
      if (!menu.slice(0, MENU_SIGNAL_WINDOW).some((row) => SELECTION_RE.test(row) || CONFIRM_RE.test(row))) {
        return false;
      }

      const options = CONFIRM_RE.test(menu.at(-1) ?? "") ? menu.slice(0, -1) : menu;
      if (!options.every((row) => SELECTION_RE.test(row) || NUMBERED_OPTION_RE.test(row))) return false;
      if ([line, ...options].filter((row) => SELECTION_RE.test(row)).length > 1) return false;
      if (hint !== "H1") return true;

      if ((SELECTION_RE.test(line) || /^Yes,/i.test(wording)) && !NUMBERED_OPTION_RE.test(option)) return false;
      return options.every((row) => NUMBERED_OPTION_RE.test(row.replace(SELECTION_RE, "")));
    })) return hint;
  }

  return null;
}
