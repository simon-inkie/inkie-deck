import { createRequire } from "node:module";
import type { AnyResponse, JsonRpcId, StopReason } from "@agentclientprotocol/sdk";
import type { Outcome } from "./deck-event";

type Schema = {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  not?: Schema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
};

const { $defs: definitions } = createRequire(import.meta.url)("@agentclientprotocol/sdk/schema/v1/schema.unstable.json") as {
  $defs: Record<string, Schema>;
};

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueType(value: unknown, type: string): boolean {
  switch (type) {
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return isObject(value);
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    default: return typeof value === type;
  }
}

function matches(value: unknown, schema: Schema, depth = 0): boolean {
  if (depth > 100) throw new Error("Excessive ACP schema nesting");
  const child = (entry: Schema) => matches(value, entry, depth + 1);
  if (schema.$ref && !child(definition(schema.$ref.slice("#/$defs/".length)))) return false;
  if (schema.type && ![schema.type].flat().some((type) => valueType(value, type))) return false;
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (schema.allOf && !schema.allOf.every(child)) return false;
  if (schema.anyOf && !schema.anyOf.some(child)) return false;
  if (schema.oneOf && schema.oneOf.filter(child).length !== 1) return false;
  if (schema.not && child(schema.not)) return false;
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (typeof value === "string" && value.length < (schema.minLength ?? 0)) return false;
  if (isObject(value)) {
    if (schema.required?.some((key) => !Object.hasOwn(value, key))) return false;
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key) && !matches(value[key], property, depth + 1)) return false;
    }
  }
  const items = schema.items;
  return !items || !Array.isArray(value) || value.every((entry) => matches(entry, items, depth + 1));
}

function definition(name: string): Schema {
  const schema = definitions[name];
  if (!schema) throw new Error(`Missing pinned ACP schema: ${name}`);
  return schema;
}

type InboundSchema = "InitializeResponse" | "NewSessionResponse" | "SessionNotification" | "RequestPermissionRequest";

export function validPayload(value: unknown, name: InboundSchema): boolean {
  return matches(value, definition(name));
}

const promptSchema = definition("PromptResponse");
const { stopReason: _, ...promptFields } = promptSchema.properties ?? {};
const promptWithoutReason = {
  ...promptSchema, properties: promptFields, required: promptSchema.required?.filter((key) => key !== "stopReason"),
};
const outcomes = {
  end_turn: "completed", max_tokens: "truncated", max_turn_requests: "truncated", refusal: "refused", cancelled: "cancelled",
} satisfies Record<StopReason, Outcome>;

export function promptSettlement(result: unknown): { outcome: Outcome; reason: string } | undefined {
  if (!isObject(result) || !matches(result, promptWithoutReason)) return undefined;
  const reason = result.stopReason;
  if (Object.hasOwn(result, "stopReason") && typeof reason !== "string") return undefined;
  if (typeof reason !== "string" || !Object.hasOwn(outcomes, reason) || !matches(result, promptSchema)) {
    return { outcome: "invalid", reason: typeof reason === "string" ? reason : "Invalid or missing stop reason" };
  }
  return { outcome: outcomes[reason as StopReason], reason };
}

export function rpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || Number.isSafeInteger(value);
}

export function responseEnvelope(value: Record<string, unknown>): value is Record<string, unknown> & AnyResponse {
  if (value.jsonrpc !== "2.0" || !rpcId(value.id) || "method" in value || "params" in value) return false;
  if ("result" in value) return !("error" in value);
  return isObject(value.error) && Number.isSafeInteger(value.error.code) && typeof value.error.message === "string";
}

export class LineFramer {
  private chunks: Buffer[] = [];
  private size = 0;
  private oversized = false;

  constructor(private readonly limit: number) {}

  *push(chunk: Buffer): Generator<{ bytes: Buffer; issue?: "oversized" }> {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      const remaining = this.limit - this.size;
      if (end - start > remaining) this.oversized = true;
      const kept = Math.min(end - start, remaining);
      if (kept) {
        this.chunks.push(Buffer.from(chunk.subarray(start, start + kept)));
        this.size += kept;
      }
      if (newline === -1) break;
      const line = this.take();
      yield { bytes: line.bytes, issue: line.oversized ? "oversized" : undefined };
      start = newline + 1;
    }
  }

  finish(): { bytes: Buffer; issue: "oversized" | "partial" } | undefined {
    if (!this.size && !this.oversized) return undefined;
    const line = this.take();
    return { bytes: line.bytes, issue: line.oversized ? "oversized" : "partial" };
  }

  private take() {
    const line = { bytes: Buffer.concat(this.chunks, this.size), oversized: this.oversized };
    this.chunks = [];
    this.size = 0;
    this.oversized = false;
    return line;
  }
}
