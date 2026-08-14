/**
 * Public surface of the blocks pure module.
 * No fs, no IO - these are all pure functions operating on strings.
 *
 * Import via: import { parseBlock, serializeBlock, ... } from "~/lib/blocks"
 */
export type { MessageBlock, DecisionCard, ActionCard, Option, BlockHeader, AnswerResult, CustomAnswerResult, PushBackResult, DoneResult, DismissResult, DoneNoteResult, DismissDecisionResult, SupersedeActionResult, SupersedeDecisionResult } from "./model.js";
export { CardSchema, OptionSchema, ActionSchema } from "./schema.js";
export { splitBlocks, isBlockHeaderLine } from "./split.js";
export { parseHeader, serializeHeader, HEADER_RE } from "./header.js";
export { parseBlock } from "./parse.js";
export { serializeBlock } from "./serialize.js";
export { applyAnswer, applyCustomAnswer, applyPushBack, applyDone, applyDismiss, applyDoneNote, applyDismissDecision, applySupersedeAction, applySupersedeDecision, PUSHBACK_RESOLUTION, PUSHBACK_REPLY_MARKER } from "./answer.js";
