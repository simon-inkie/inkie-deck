import fs from "node:fs";
import path from "node:path";
import type { DeckEvent } from "./deck-event";
import type { UnknownExtensionRecord } from "./runner/acp-manifest";
import { confineToRoot } from "./safe-fs.server";

const sessionName = /^acp-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-[1-9][0-9]*$/;
const DEFAULT_RAW_BYTES = 10 * 1024 * 1024;
const DEFAULT_EXTENSIONS_BYTES = 2 * 1024 * 1024;
const MAX_EXTENSION_RECORD_BYTES = 8 * 1024;
const DEFAULT_RAW_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const confined = (target: string, root: string) => confineToRoot(target, root, { label: "ACP records", forWrite: true });

export type RecordOptions = {
  rawBytes?: number;
  rawAgeMs?: number;
  extensionsBytes?: number;
  maxExtensionRecordBytes?: number;
};

export function summarizeExtensionParams(params: unknown): string | null {
  if (params === undefined || params === null) return null;
  if (typeof params === "string") return `string(len:${params.length})`;
  if (typeof params === "number" || typeof params === "boolean") return typeof params;
  if (Array.isArray(params)) return `array(len:${params.length})`;
  if (typeof params === "object") {
    return `object(keys:${Object.keys(params as Record<string, unknown>).length})`;
  }
  return `<${typeof params}>`;
}

export class AcpRecords {
  readonly directory: string;
  private readonly root: string;
  private readonly raw: string;
  private readonly journal: string;
  private readonly extensions: string;
  private readonly rawLimit: number;
  private readonly extLimit: number;
  private readonly extRecordLimit: number;
  private readonly expires: NodeJS.Timeout;
  private rawSize = 0;
  private lengths: number[] = [];
  private rawExpired = false;
  private extSize = 0;
  private extLengths: number[] = [];
  private extExpired = false;

  constructor(dataRoot: string, name: string, options: RecordOptions = {}) {
    if (!sessionName.test(name) || !path.isAbsolute(dataRoot)) throw new Error("Invalid ACP record directory");
    this.rawLimit = options.rawBytes ?? DEFAULT_RAW_BYTES;
    this.extLimit = options.extensionsBytes ?? DEFAULT_EXTENSIONS_BYTES;
    this.extRecordLimit = options.maxExtensionRecordBytes ?? MAX_EXTENSION_RECORD_BYTES;
    const age = options.rawAgeMs ?? DEFAULT_RAW_AGE_MS;
    if (!Number.isSafeInteger(this.rawLimit) || this.rawLimit < 1 ||
        !Number.isSafeInteger(this.extLimit) || this.extLimit < 1 ||
        !Number.isSafeInteger(this.extRecordLimit) || this.extRecordLimit < 64 ||
        !Number.isSafeInteger(age) || age < 1 || age > 2_147_483_647) throw new Error("Invalid ACP record limits");
    this.root = fs.realpathSync(dataRoot);
    const directory = path.join(this.root, name);
    const safeDirectory = confined(directory, dataRoot);
    if (safeDirectory !== directory) throw new Error("Refusing linked ACP record directory");
    expireOldRecords(dataRoot, age);
    fs.mkdirSync(safeDirectory, { mode: 0o700 });
    this.directory = safeDirectory;
    this.raw = confined(path.join(this.directory, "raw.ndjson"), this.directory);
    this.journal = confined(path.join(this.directory, "display.ndjson"), this.directory);
    this.extensions = confined(path.join(this.directory, "extensions.ndjson"), this.directory);
    for (const file of [this.raw, this.journal, this.extensions]) fs.writeFileSync(file, "", { mode: 0o600, flag: "wx" });
    this.expires = setTimeout(() => {
      try { this.expireRaw(); } catch { return; }
    }, age).unref();
  }

  frame(direction: "in" | "out", bytes: Buffer, issue?: string): void {
    if (this.rawExpired) return;
    const encode = (prefix: Buffer, truncated?: boolean) => Buffer.from(JSON.stringify({
      direction, issue, truncated, bytes: prefix.toString("base64"),
    }) + "\n");
    let line = encode(bytes);
    if (line.length > this.rawLimit) {
      const overhead = encode(Buffer.alloc(0), true).length;
      const kept = Math.max(0, Math.floor((this.rawLimit - overhead) / 4) * 3);
      line = encode(bytes.subarray(0, kept), true);
    }
    if (line.length > this.rawLimit) return;
    const file = this.recordPath(this.raw);
    if (!file) return;
    if (this.rawSize + line.length > this.rawLimit) {
      let dropped = 0;
      let count = 0;
      while (this.rawSize - dropped + line.length > this.rawLimit) dropped += this.lengths[count++]!;
      const retained = fs.readFileSync(file).subarray(dropped);
      fs.writeFileSync(file, Buffer.concat([retained, line]));
      this.lengths = this.lengths.slice(count);
      this.rawSize -= dropped;
    } else {
      fs.appendFileSync(file, line);
    }
    this.lengths.push(line.length);
    this.rawSize += line.length;
  }

  event(event: DeckEvent): void {
    const file = this.recordPath(this.journal);
    if (!file) throw new Error("Missing ACP display journal");
    fs.appendFileSync(file, JSON.stringify(event) + "\n");
  }

  unknownExtension(event: UnknownExtensionRecord): void {
    if (this.extExpired) return;
    const normalized: UnknownExtensionRecord = {
      v: 1,
      ts: event.ts,
      session: event.session ?? null,
      extensionName: event.extensionName.slice(0, 128),
      method: event.method.slice(0, 128),
      classification: event.classification,
      paramsSummary: event.paramsSummary === null ? null : event.paramsSummary.slice(0, 512),
    };
    let line = Buffer.from(JSON.stringify(normalized) + "\n");
    if (line.length > this.extRecordLimit) {
      normalized.paramsSummary = normalized.paramsSummary ? normalized.paramsSummary.slice(0, 64) + "...[truncated]" : null;
      line = Buffer.from(JSON.stringify(normalized) + "\n");
    }
    if (line.length > this.extRecordLimit || line.length > this.extLimit) return;
    try {
      const file = this.recordPath(this.extensions);
      if (!file) return;
      if (this.extSize + line.length > this.extLimit) {
        let dropped = 0;
        let count = 0;
        while (count < this.extLengths.length && this.extSize - dropped + line.length > this.extLimit) {
          dropped += this.extLengths[count++]!;
        }
        const retained = fs.readFileSync(file).subarray(dropped);
        fs.writeFileSync(file, Buffer.concat([retained, line]));
        this.extLengths = this.extLengths.slice(count);
        this.extSize -= dropped;
      } else {
        fs.appendFileSync(file, line);
      }
      this.extLengths.push(line.length);
      this.extSize += line.length;
    } catch {
      // Extension diagnostics are best-effort and must not crash the live transport loop.
    }
  }

  delete(): void {
    clearTimeout(this.expires);
    this.rawExpired = true;
    this.extExpired = true;
    if (confined(this.directory, this.root) !== this.directory) throw new Error("Refusing linked ACP record directory");
    fs.rmSync(this.directory, { recursive: true, force: true });
  }

  private expireRaw(): void {
    this.rawExpired = true;
    this.extExpired = true;
    this.lengths = [];
    this.extLengths = [];
    const rawFile = this.recordPath(this.raw);
    if (rawFile) fs.rmSync(rawFile);
    const extFile = this.recordPath(this.extensions);
    if (extFile) fs.rmSync(extFile);
  }

  private recordPath(file: string): string | undefined {
    if (confined(this.directory, this.root) !== this.directory || confined(file, this.directory) !== file) {
      throw new Error("Refusing linked ACP record path");
    }
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid ACP record file");
    return file;
  }
}

export function expireOldRecords(dataRoot: string, age = DEFAULT_RAW_AGE_MS, now = Date.now()): void {
  for (const entry of fs.readdirSync(dataRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !sessionName.test(entry.name)) continue;
    const directory = confined(path.join(dataRoot, entry.name), dataRoot);
    for (const fileName of ["raw.ndjson", "extensions.ndjson"]) {
      const target = path.join(directory, fileName);
      const stat = fs.lstatSync(target, { throwIfNoEntry: false });
      if (stat?.isFile() && now - stat.birthtimeMs >= age) fs.rmSync(confined(target, directory));
    }
  }
}
