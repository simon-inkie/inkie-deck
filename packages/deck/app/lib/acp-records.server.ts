import fs from "node:fs";
import path from "node:path";
import type { DeckEvent } from "./deck-event";
import type { UnknownExtensionRecord } from "./runner/acp-manifest";
import { confineToRoot } from "./safe-fs.server";

const sessionName = /^acp-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-[1-9][0-9]*$/;
const DEFAULT_RAW_BYTES = 10 * 1024 * 1024;
const DEFAULT_RAW_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const confined = (target: string, root: string) => confineToRoot(target, root, { label: "ACP records", forWrite: true });

export type RecordOptions = { rawBytes?: number; rawAgeMs?: number };

export class AcpRecords {
  readonly directory: string;
  private readonly root: string;
  private readonly raw: string;
  private readonly journal: string;
  private readonly extensions: string;
  private readonly rawLimit: number;
  private readonly expires: NodeJS.Timeout;
  private rawSize = 0;
  private lengths: number[] = [];
  private rawExpired = false;

  constructor(dataRoot: string, name: string, options: RecordOptions = {}) {
    if (!sessionName.test(name) || !path.isAbsolute(dataRoot)) throw new Error("Invalid ACP record directory");
    this.rawLimit = options.rawBytes ?? DEFAULT_RAW_BYTES;
    const age = options.rawAgeMs ?? DEFAULT_RAW_AGE_MS;
    if (!Number.isSafeInteger(this.rawLimit) || this.rawLimit < 1 ||
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
    const file = this.recordPath(this.extensions);
    if (!file) throw new Error("Missing ACP extension log file");
    fs.appendFileSync(file, JSON.stringify(event) + "\n");
  }

  delete(): void {
    clearTimeout(this.expires);
    this.rawExpired = true;
    if (confined(this.directory, this.root) !== this.directory) throw new Error("Refusing linked ACP record directory");
    fs.rmSync(this.directory, { recursive: true, force: true });
  }

  private expireRaw(): void {
    this.rawExpired = true;
    this.lengths = [];
    const file = this.recordPath(this.raw);
    if (file) fs.rmSync(file);
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
    const raw = path.join(directory, "raw.ndjson");
    const stat = fs.lstatSync(raw, { throwIfNoEntry: false });
    if (stat?.isFile() && now - stat.birthtimeMs >= age) fs.rmSync(confined(raw, directory));
  }
}
