#!/usr/bin/env node
/**
 * leak-gate: denylist scan for internal material that must never appear in
 * this repository.
 *
 * This repository is the OPEN version of an internal system. A clean-room
 * process governs what crosses from the internal side, and this gate is the
 * mechanical backstop for the categories that process exists to keep out:
 * real personal and agent names, internal hostnames and repository names,
 * IP addresses, absolute paths under a real home directory, internal ticket
 * identifiers, and company email addresses. Credential scanning proper is
 * gitleaks's job in CI; this file owns the identity denylist that a generic
 * secret scanner cannot know about.
 *
 * HOW THE PATTERNS ARE WRITTEN, and why it looks odd.
 *
 * Every rule's regex source and its self-test sample are assembled at
 * runtime from split fragments. Written whole, each denied string would
 * itself ship in the repository, be greppable and indexable, and trip the
 * gate on this very file. Split, the repository never contains a literal
 * instance of anything on the list, and this file is scanned like any other.
 *
 * HOW TO EXTEND THE LIST.
 *
 * Add a rule() entry below. Split the fragments mid-word, keep the sample
 * matching the pattern, and say in `why` what the entry prevents, because
 * the next reader cannot infer that from a split string. Then run
 * `node scripts/leak-gate.mjs --self-test` to prove the new rule fires.
 *
 * USAGE
 *   node scripts/leak-gate.mjs                  scan all git-tracked files
 *   node scripts/leak-gate.mjs <file>...        scan the given files only
 *   node scripts/leak-gate.mjs --self-test      prove every rule catches its
 *                                               own sample, using a temp file
 *                                               outside the repository
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * @param {{ label: string, why: string, pattern: string[], flags?: string, sample: string[] }} spec
 */
function rule({ label, why, pattern, flags = "i", sample }) {
  return {
    label,
    why,
    re: new RegExp(pattern.join(""), flags),
    sample: sample.join(""),
  };
}

const RULES = [
  // -- People ---------------------------------------------------------------
  rule({
    label: "principal-first-name",
    why: "First name of the person the internal deployment serves. A real person's name in the open repo is a clean-room breach.",
    pattern: ["\\bsi", "mon\\b"],
    sample: ["si", "mon"],
  }),
  rule({
    label: "second-principal-first-name",
    why: "First name of the second person the internal deployment serves.",
    pattern: ["\\bsop", "hie\\b"],
    sample: ["sop", "hie"],
  }),

  // -- Agent names ----------------------------------------------------------
  // The internal fleet's agents have individual names. Any of them appearing
  // here means internal persona or conversation material crossed over. Names
  // that are also ordinary English words (and would drown the gate in false
  // positives) are deliberately NOT listed; the path and hostname rules
  // below cover the places those names would realistically leak.
  rule({
    label: "fleet-agent-name",
    why: "Name of an agent on the internal fleet. Public examples must use invented names (alice, bob, courier, ...).",
    pattern: [
      "\\b(?:ag", "gy|al", "dus|an", "dor|doc", "tor2|hop",
      "kins|mon", "tani|mag", "gie|se", "th|p", "ea)\\b",
    ],
    sample: ["ag", "gy"],
  }),

  // -- Internal repositories and hosts --------------------------------------
  rule({
    label: "internal-repo-or-host-name",
    why: "Name of an internal repository, project or host. Their names alone reveal internal topology and invite links back into private material.",
    pattern: [
      "\\b(?:the-", "brain|mission-", "control|quill-", "projects|inkie-p",
      "gr|inkie-", "app-v2|inkie-", "worker|inkie-", "functions)\\b",
    ],
    sample: ["mission-", "control"],
  }),

  // -- Network --------------------------------------------------------------
  rule({
    label: "private-ipv4-address",
    why: "A concrete RFC 1918 address is internal network topology. Docs that need an address use 203.0.113.x (TEST-NET-3) or a hostname placeholder.",
    pattern: [
      "\\b(?:192\\.168|10\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01]))",
      "\\.\\d{1,3}\\.\\d{1,3}\\b",
    ],
    flags: "",
    sample: ["192.168", ".0.1"],
  }),

  // -- Filesystem -----------------------------------------------------------
  rule({
    label: "absolute-home-path",
    why: "An absolute path under a real home directory ties content to a real machine and usually embeds a real username. Docs use ~ or the placeholder users you/user/example.",
    pattern: [
      "/(?:home|Users)/",
      "(?!you/|user/|example/)[A-Za-z][A-Za-z0-9_.-]*/",
    ],
    flags: "",
    sample: ["/home/", "leaked", "user/x"],
  }),

  // -- Tickets --------------------------------------------------------------
  rule({
    label: "internal-ticket-id",
    why: "Internal issue-tracker identifiers point straight at private ticket content and internal project structure.",
    pattern: ["\\bIN", "K-\\d+\\b"],
    flags: "",
    sample: ["IN", "K-123"],
  }),

  // -- Email ----------------------------------------------------------------
  rule({
    label: "company-email-address",
    why: "Addresses on the company mail domain are personal contact details, not public repo content.",
    pattern: ["[A-Za-z0-9._-]+@ink", "ie\\.ink\\b"],
    sample: ["someone@ink", "ie.ink"],
  }),

  // -- Credentials (backstop; gitleaks in CI is the primary scanner) --------
  rule({
    label: "private-key-block",
    why: "A pasted private key is a leak whatever else it is. gitleaks covers this in CI; this entry keeps the local gate able to catch it too.",
    pattern: ["-----BEGIN [A-Z ]*", "PRIVATE KEY-----"],
    flags: "",
    sample: ["-----BEGIN ", "PRIVATE KEY-----"],
  }),

  // -- Protocol hygiene -----------------------------------------------------
  rule({
    label: "literal-em-dash",
    why: "U+2014 is a header field separator in the agent message protocol, so a literal one in any file is a latent parsing hazard, and the house style bans it everywhere anyway. Write \\u2014 where the codepoint itself is meant.",
    pattern: ["\\u2014"],
    flags: "",
    // The sample is written as a backslash-u escape so the source bytes hold
    // the escape, not the character; the char exists only in the temp file.
    sample: ["\u2014"],
  }),
];

/** @param {string} filePath @returns {{ file: string, line: number, label: string, why: string }[]} */
function scanFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) {
    return []; // binary file, out of scope for a text denylist
  }
  const findings = [];
  const lines = buffer.toString("utf8").split("\n");
  for (const [index, lineText] of lines.entries()) {
    for (const { label, why, re } of RULES) {
      if (re.test(lineText)) {
        findings.push({ file: filePath, line: index + 1, label, why });
      }
    }
  }
  return findings;
}

function trackedFiles() {
  const output = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], {
    encoding: "utf8",
  });
  return output
    .split("\0")
    .filter(Boolean)
    .map((relative) => path.join(REPO_ROOT, relative))
    .filter((absolute) => fs.existsSync(absolute));
}

/**
 * Prove every rule can fire, without a single denied string ever existing
 * inside the repository. Each rule's sample is assembled at runtime and
 * written to a temp file under the OS temp dir; the gate is then pointed at
 * that file and must report exactly one finding per rule. A rule whose
 * pattern rots (or whose sample drifts from it) fails the self-test, so a
 * silently dead denylist entry cannot pass CI.
 */
function selfTest() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "leak-gate-self-test-"));
  const file = path.join(dir, "sample.txt");
  try {
    fs.writeFileSync(file, RULES.map((r) => r.sample).join("\n") + "\n", "utf8");
    const findings = scanFile(file);
    const missed = RULES.filter((r) => !findings.some((f) => f.label === r.label));
    if (missed.length > 0) {
      for (const r of missed) {
        console.error(`leak-gate self-test: rule ${r.label} failed to catch its own sample`);
      }
      process.exit(1);
    }
    console.log(`leak-gate self-test: all ${RULES.length} rules fire correctly`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--self-test") {
    selfTest();
    return;
  }
  const files = args.length > 0 ? args : trackedFiles();
  const findings = files.flatMap(scanFile);
  if (findings.length > 0) {
    for (const { file, line, label, why } of findings) {
      console.error(`${path.relative(REPO_ROOT, file)}:${line}: [${label}] ${why}`);
    }
    console.error(`\nleak-gate: ${findings.length} finding(s). This material must not enter the repository; see the rule comments in scripts/leak-gate.mjs.`);
    process.exit(1);
  }
  console.log(`leak-gate: clean (${files.length} files scanned, ${RULES.length} rules)`);
}

main();
