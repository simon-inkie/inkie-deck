#!/usr/bin/env node
/**
 * licence-gate: fail CI while the LICENSE copyright holder is a placeholder.
 *
 * The licence is Apache-2.0 and the copyright holder is a limited company
 * whose exact registered name has not been confirmed yet. Guessing it, or
 * substituting a person's name, would be worse than blocking, and a TODO
 * would sit unread until after the first external contribution, at which
 * point correcting the copyright line stops being a one-line edit and
 * becomes a conversation with every contributor. So the missing legal
 * detail blocks the pipeline instead.
 *
 * This gate FAILING is the intended state of the current slice. It goes
 * green the moment the placeholder is replaced with the company's exact
 * registered name, and it never needs editing to make that happen.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LICENSE_PATH = path.join(REPO_ROOT, "LICENSE");
const PLACEHOLDER = "COMPANY-REGISTERED-NAME-PLACEHOLDER";

if (!fs.existsSync(LICENSE_PATH)) {
  console.error("licence-gate: LICENSE is missing from the repository root.");
  process.exit(1);
}

const text = fs.readFileSync(LICENSE_PATH, "utf8");

if (!text.includes("Apache License")) {
  console.error("licence-gate: LICENSE does not appear to be the Apache-2.0 text.");
  process.exit(1);
}

if (text.includes(PLACEHOLDER)) {
  console.error(
    [
      "licence-gate: the LICENSE copyright holder is still the placeholder.",
      "",
      "Needed: replace the token " + PLACEHOLDER + " in LICENSE with the",
      "EXACT registered name of the limited company that holds copyright",
      "(as it appears on the company register, including any 'Ltd'/'Limited'",
      "suffix). Do not use a person's name. Once confirmed, also remove the",
      "explanatory NOTE paragraph beneath the copyright line.",
      "",
      "This failure is deliberate: the legal detail must block the pipeline",
      "rather than sit in a TODO, because it becomes very expensive to",
      "correct after the first external contribution.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log("licence-gate: LICENSE has a real copyright holder.");
