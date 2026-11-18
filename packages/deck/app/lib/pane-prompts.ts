/** Bare composer on any line; wake callers still corroborate an ASCII `>` with its frame. */
export const IDLE_PROMPT_RE = /^\s*[\u276F\u203A>]\s*$/m;
/** Require a user@host prefix so a status line ending in a sigil does not match. */
export const SHELL_PROMPT_RE = /\w+@[\w.-]+[:\s].*[$#%]\s*$/;
