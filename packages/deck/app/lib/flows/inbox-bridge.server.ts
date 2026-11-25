/**
 * inbox-bridge.server.ts - Idempotent inbox decision & action card bridge for Deck Flows Slice 2.
 *
 * Consumes FileInboxRepository and blocks/* parsers/schemas cleanly without modifying
 * their internals. Ensures every emitted decision/action card passes CardSchema/ActionSchema
 * validation, carries (flow-run-id, flow-head-seq, flow-head-hash, flow-step-id),
 * and reads back answered/customAnswer/dismissed/superseded writebacks idempotently.
 *
 * ASCII only - no em-dashes.
 */

import crypto from "node:crypto";
import YAML from "yaml";
import {
  ActionSchema,
  CardSchema,
  parseBlock,
  serializeBlock,
  type MessageBlock,
} from "../blocks/index.js";
import { isCustomAnswer } from "../blocks/answer.js";
import { FileInboxRepository, type InboxRepository } from "../inbox.server.js";
import { FlowIdRegex } from "./types.js";

export interface InboxBridgeTarget {
  inboxRoot: string;
  agentName: string;
  participantName: string;
  repo?: InboxRepository;
}

export interface EmitDecisionCardParams {
  target: InboxBridgeTarget;
  handoffId: string;
  runId: string;
  headSeq: number;
  headHash: string;
  stepId: string;
  reasonCode: string;
  title?: string;
  alwaysDecide?: boolean;
  options: Array<{ key: string; label?: string; detail?: string }>;
  validOptionKeys?: readonly string[];
  nowIso?: string;
}

export interface EmitNotifyCardParams {
  target: InboxBridgeTarget;
  actionId: string;
  runId: string;
  headSeq: number;
  headHash: string;
  stepId: string;
  reasonCode: string;
  priority?: "urgent" | "high" | "normal";
  summary?: string;
  nowIso?: string;
}

export type DecisionCardResolution =
  | {
      status: "pending";
      cardPresent: boolean;
    }
  | {
      status: "answered";
      cardPresent: true;
      choiceKey: string;
      customAnswer?: string;
      actorId: string;
    }
  | {
      status: "dismissed";
      cardPresent: true;
      superseded: boolean;
      reason?: string;
      actorId: string;
    };

function getRepo(target: InboxBridgeTarget): InboxRepository {
  return target.repo ?? new FileInboxRepository(target.inboxRoot);
}

function sanitizeInlineText(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, " ")
    .replace(/[\u2014\u2013]/g, "-")
    .trim();
}

function formatBlockTimestamp(nowIso?: string): string {
  const iso = nowIso ?? new Date().toISOString();
  return iso.replace(/\.\d{1,6}Z$/, "Z");
}

function resolveActorId(candidate: string | undefined, fallback: string): string {
  const raw = (candidate ?? fallback).toLowerCase();
  if (FlowIdRegex.test(raw)) {
    return raw;
  }
  const cleaned = raw.replace(/[^a-z0-9_-]/g, "_").slice(0, 64);
  return FlowIdRegex.test(cleaned) ? cleaned : "operator";
}

/**
 * Derive deterministic 24-character handoffId (`hnd_<20 hex>`) matching FlowIdRegex.
 */
export function buildDeterministicHandoffId(
  runId: string,
  stepId: string,
  occurrence: number,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(["deck-flow-handoff-v1", runId, stepId, occurrence]))
    .digest("hex")
    .slice(0, 20);
  return `hnd_${digest}`;
}

/**
 * Derive deterministic 24-character actionId (`act_<20 hex>`) matching FlowIdRegex.
 */
export function buildDeterministicNotifyCardId(
  runId: string,
  stepId: string,
  occurrence: number,
  reasonCode: string,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(["deck-flow-notify-v1", runId, stepId, occurrence, reasonCode]))
    .digest("hex")
    .slice(0, 20);
  return `act_${digest}`;
}

function parseFlowHandoffId(rawMeta: string): string | undefined {
  if (!rawMeta.trim()) return undefined;
  try {
    const parsed: unknown = YAML.parse(rawMeta);
    if (parsed !== null && typeof parsed === "object") {
      const val = (parsed as Record<string, unknown>)["flow-handoff-id"];
      if (typeof val === "string" && val.length > 0) return val;
    }
  } catch {
    // ignore malformed YAML
  }
  return undefined;
}

function findCardsForHandoff(
  blocks: readonly MessageBlock[],
  handoffId: string,
): Array<{ index: number; block: MessageBlock }> {
  const matches: Array<{ index: number; block: MessageBlock }> = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (!b.card) continue;
    if (b.card.decisionId === handoffId || parseFlowHandoffId(b.rawMeta) === handoffId) {
      matches.push({ index: i, block: b });
    }
  }
  return matches;
}

/**
 * Count how many emitted cards for `handoffId` were answered with a key outside `validOptionKeys`.
 */
export async function countInvalidAnsweredDecisionCards(
  target: InboxBridgeTarget,
  handoffId: string,
  validOptionKeys: readonly string[],
): Promise<number> {
  const repo = getRepo(target);
  const blocks = await repo.readBlocks(target.agentName, target.participantName);
  const matches = findCardsForHandoff(blocks, handoffId);
  return matches.filter(
    ({ block }) =>
      Boolean(block.card?.answered) &&
      !block.card?.dismissed &&
      !block.card?.superseded &&
      !validOptionKeys.includes(block.card!.answered!),
  ).length;
}

/**
 * Idempotently emit a CardSchema-valid decision card to an agent inbox thread.
 * If an active/valid block for `handoffId` already exists, does not write a duplicate.
 * When `validOptionKeys` is passed and the latest card was answered with an invalid option
 * (such as `custom` or `pushback`), emits a fresh retry card (`<handoffId>_r<N>`) so UI
 * taps are never deadlocked.
 */
export async function emitDecisionCardToInbox(
  params: EmitDecisionCardParams,
): Promise<{ emitted: boolean; alreadyPresent: boolean; decisionId: string }> {
  const repo = getRepo(params.target);
  const existing = await repo.readBlocks(
    params.target.agentName,
    params.target.participantName,
  );
  const matching = findCardsForHandoff(existing, params.handoffId);
  let cardDecisionId = params.handoffId;
  if (matching.length > 0) {
    const latestCard = matching[matching.length - 1]!.block.card!;
    const latestAnsweredInvalid =
      params.validOptionKeys !== undefined &&
      Boolean(latestCard.answered) &&
      !latestCard.dismissed &&
      !latestCard.superseded &&
      !params.validOptionKeys.includes(latestCard.answered!);
    if (!latestAnsweredInvalid) {
      return {
        emitted: false,
        alreadyPresent: true,
        decisionId: latestCard.decisionId,
      };
    }
    cardDecisionId = `${params.handoffId}_r${matching.length}`;
    if (existing.some((b) => b.card?.decisionId === cardDecisionId)) {
      return {
        emitted: false,
        alreadyPresent: true,
        decisionId: cardDecisionId,
      };
    }
  }

  const normalizedOptions = params.options.map((opt) => {
    const label = sanitizeInlineText(opt.label ?? opt.key) || opt.key;
    const detail = sanitizeInlineText(opt.detail ?? label) || label;
    return {
      key: opt.key,
      label,
      detail,
    };
  });

  const metaObj: Record<string, unknown> = {
    "decision-id": cardDecisionId,
    ...(cardDecisionId !== params.handoffId ? { "flow-handoff-id": params.handoffId } : {}),
    "flow-run-id": params.runId,
    "flow-head-seq": params.headSeq,
    "flow-head-hash": params.headHash,
    "flow-step-id": params.stepId,
    "flow-reason-code": params.reasonCode,
    ...(params.alwaysDecide ? { "flow-always-decide": true } : {}),
    options: normalizedOptions,
  };

  const schemaCheck = CardSchema.safeParse(metaObj);
  if (!schemaCheck.success) {
    throw new Error(
      `Decision card metadata failed CardSchema validation: ${JSON.stringify(schemaCheck.error.issues)}`,
    );
  }

  const rawMeta = YAML.stringify(metaObj, { lineWidth: 0 }).trimEnd();
  if (rawMeta.includes("\n\n")) {
    throw new Error("Decision card rawMeta must not contain blank lines");
  }

  const subject = sanitizeInlineText(
    `Flow ${params.runId} decision (${params.stepId}: ${params.reasonCode})`,
  );
  const body = sanitizeInlineText(
    params.title ??
      `Flow run ${params.runId} at step ${params.stepId} requires decision (${params.reasonCode}).`,
  );

  const block: MessageBlock = {
    header: {
      timestamp: formatBlockTimestamp(params.nowIso),
      from: params.target.agentName,
      status: "sent",
      subject,
    },
    body,
    rawMeta,
    card: {
      decisionId: cardDecisionId,
      options: normalizedOptions,
    },
  };

  const roundTrip = parseBlock(serializeBlock(block));
  if (!roundTrip.card || roundTrip.card.decisionId !== cardDecisionId) {
    throw new Error(`Decision card failed round-trip parseBlock validation for '${cardDecisionId}'`);
  }

  await repo.writeReply(
    params.target.agentName,
    params.target.participantName,
    block,
  );

  return { emitted: true, alreadyPresent: false, decisionId: cardDecisionId };
}

/**
 * Idempotently emit an ActionSchema-valid notify action card to an agent inbox thread.
 */
export async function emitNotifyCardToInbox(
  params: EmitNotifyCardParams,
): Promise<{ emitted: boolean; alreadyPresent: boolean }> {
  const repo = getRepo(params.target);
  const existing = await repo.readBlocks(
    params.target.agentName,
    params.target.participantName,
  );
  if (existing.some((b) => b.actionCard?.actionId === params.actionId)) {
    return { emitted: false, alreadyPresent: true };
  }

  const metaObj: Record<string, unknown> = {
    "action-id": params.actionId,
    priority: params.priority ?? "normal",
    "flow-run-id": params.runId,
    "flow-head-seq": params.headSeq,
    "flow-head-hash": params.headHash,
    "flow-step-id": params.stepId,
    "flow-reason-code": params.reasonCode,
  };

  const schemaCheck = ActionSchema.safeParse(metaObj);
  if (!schemaCheck.success) {
    throw new Error(
      `Notify card metadata failed ActionSchema validation: ${JSON.stringify(schemaCheck.error.issues)}`,
    );
  }

  const rawMeta = YAML.stringify(metaObj, { lineWidth: 0 }).trimEnd();
  const subject = sanitizeInlineText(
    `Flow ${params.runId} notice (${params.stepId}: ${params.reasonCode})`,
  );
  const body = sanitizeInlineText(
    params.summary ??
      `Flow run ${params.runId} at step ${params.stepId} raised notice (${params.reasonCode}).`,
  );

  const block: MessageBlock = {
    header: {
      timestamp: formatBlockTimestamp(params.nowIso),
      from: params.target.agentName,
      status: "sent",
      subject,
    },
    body,
    rawMeta,
  };

  const roundTrip = parseBlock(serializeBlock(block));
  if (!roundTrip.actionCard || roundTrip.actionCard.actionId !== params.actionId) {
    throw new Error(`Notify card failed round-trip parseBlock validation for '${params.actionId}'`);
  }

  await repo.writeReply(
    params.target.agentName,
    params.target.participantName,
    block,
  );

  return { emitted: true, alreadyPresent: false };
}

/**
 * Read back resolution status of a previously emitted decision card.
 * Returns pending | answered | dismissed.
 */
export async function readDecisionCardResolution(
  target: InboxBridgeTarget,
  handoffId: string,
): Promise<DecisionCardResolution> {
  const repo = getRepo(target);
  const blocks = await repo.readBlocks(target.agentName, target.participantName);
  const matching = findCardsForHandoff(blocks, handoffId);
  if (matching.length === 0) {
    return { status: "pending", cardPresent: false };
  }

  const latest = matching[matching.length - 1]!;
  const cardIdx = latest.index;
  const cardBlock = latest.block;
  const card = cardBlock.card!;

  const findReplyActor = (): string => {
    const expectedSubject = cardBlock.header.subject
      ? `Re: ${cardBlock.header.subject}`
      : "Re: decision";
    for (let i = cardIdx + 1; i < blocks.length; i++) {
      const b = blocks[i]!;
      if (b.header.subject === expectedSubject && b.header.from) {
        return resolveActorId(b.header.from, target.participantName);
      }
    }
    return resolveActorId(target.participantName, "operator");
  };

  if (card.dismissed) {
    return {
      status: "dismissed",
      cardPresent: true,
      superseded: false,
      ...(card.dismissReason ? { reason: card.dismissReason } : {}),
      actorId: findReplyActor(),
    };
  }

  if (card.superseded) {
    return {
      status: "dismissed",
      cardPresent: true,
      superseded: true,
      ...(card.supersedeNote ? { reason: card.supersedeNote } : {}),
      actorId: findReplyActor(),
    };
  }

  if (card.answered) {
    const customAnswer = isCustomAnswer(card) ? card.customAnswer : undefined;
    return {
      status: "answered",
      cardPresent: true,
      choiceKey: card.answered,
      ...(customAnswer !== undefined ? { customAnswer } : {}),
      actorId: findReplyActor(),
    };
  }

  return { status: "pending", cardPresent: true };
}
