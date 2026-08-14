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
 *   node scripts/leak-gate.mjs                  scan every file in the working
 *                                               tree that is not gitignored
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
  // Names in this section are matched as BARE SUBSTRINGS, with no \b on
  // either side, on purpose. A word-boundary anchor is silently disarmed by
  // adjacent word characters: the observed case was a name preceded by a
  // backslash-n ESCAPE in test source, where the "n" of the escape is a word
  // character and kills the boundary, so a \b-anchored rule read the line and
  // passed it. These names are distinctive enough that a substring match has
  // no realistic false positives, so they get the stronger form.
  rule({
    label: "principal-first-name",
    why: "First name of the person the internal deployment serves. A real person's name in the open repo is a clean-room breach. Substring match: distinctive, no \\b (see section comment).",
    pattern: ["si", "mon"],
    sample: ["si", "mon"],
  }),
  rule({
    label: "second-principal-first-name",
    why: "First name of the second person the internal deployment serves. Substring match: distinctive, no \\b (see section comment).",
    pattern: ["sop", "hie"],
    sample: ["sop", "hie"],
  }),

  // -- Agent names ----------------------------------------------------------
  // The internal fleet's agents have individual names. Any of them appearing
  // here means internal persona or conversation material crossed over. The
  // list is split by match strength:
  //   - DISTINCTIVE names match as bare substrings (no \b), so a name fused
  //     into an identifier or preceded by an escape sequence still fires.
  //     Observed leak shapes: names fused into camelCase variable names, and
  //     into repo/worktree names, both invisible to \b-bounded rules.
  //   - Names that are ordinary English words or too short to be distinctive
  //     keep \b on both sides, or a substring rule would drown the gate in
  //     false positives. The trade-off is real: \b can be defeated by
  //     adjacent word characters, so these three are the gate's weakest
  //     entries and reviewers should keep that in mind.
  rule({
    label: "fleet-agent-name-distinctive",
    why: "Name of an agent on the internal fleet, distinctive enough for substring matching (fires even fused inside identifiers). Public examples must use invented names (alice, bob, courier, ...).",
    pattern: [
      "(?:ag", "gy|al", "dus|doc", "tor2|hop",
      "kins|mon", "tani|mag", "gie)",
    ],
    sample: ["ag", "gy"],
  }),
  rule({
    label: "fleet-agent-name-wordlike",
    why: "Name of an agent on the internal fleet that is also an English word or too short for substring matching (se.., p.., an..), so it keeps \\b bounds and is weaker than the distinctive rule; a fused occurrence will NOT fire.",
    pattern: [
      "\\b(?:se", "th|p", "ea|an", "dor)\\b",
    ],
    sample: ["se", "th"],
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

  rule({
    label: "internal-product-name",
    why: "The internal deployment's former product name (two words, also seen fused or underscore/hyphen-joined). The open product is Inkie Deck; the old name appearing anywhere means internal UI copy, docs or push text crossed over uncleaned. Substring, case-insensitive, so fused identifiers fire too.",
    pattern: ["mis", "sion[-_ ]?con", "trol"],
    sample: ["Mis", "sion Con", "trol"],
  }),
  rule({
    label: "internal-tracker-org-slug",
    why: "The company's real issue-tracker organisation slug (as in linear.app/<slug>). It links straight back to the private workspace; public examples use the example-org placeholder. Substring, case-insensitive.",
    pattern: ["ink", "ie-ai"],
    sample: ["ink", "ie-ai"],
  }),

  // -- Network --------------------------------------------------------------
  rule({
    label: "tailnet-host-fragment",
    why: "Fragment of the internal Tailscale hostname or its tailnet domain (the machine name, the tailnet id, or the tailnet MagicDNS domain suffix). Each fragment alone identifies internal network topology, so all three fire independently and as substrings.",
    pattern: ["(?:a8", "max|tail", "495df7|\\.ts\\.", "net)"],
    sample: ["a8", "max"],
  }),
  rule({
    label: "cgnat-ipv4-address",
    why: "A concrete CGNAT-range address (the 100.64/10 block, the range Tailscale assigns) is internal network topology exactly like an RFC 1918 address, but the private-ipv4-address rule below cannot see it because CGNAT is not RFC 1918.",
    pattern: [
      "\\b100\\.(?:6[4-9]|",
      "[7-9]\\d|1[01]\\d|12[0-7])\\.\\d{1,3}\\.\\d{1,3}\\b",
    ],
    flags: "",
    sample: ["100.64", ".0.1"],
  }),
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
  rule({
    label: "internal-ticket-id-nonnumeric",
    why: "Internal issue-tracker identifiers with a non-numeric suffix (the tracker also mints ids with word suffixes, e.g. ...-ROLLOUT-2), which the numeric rule above cannot see. Case-sensitive, no leading \\b so a fused occurrence still fires.",
    pattern: ["IN", "K-[A-Z0-9]+"],
    flags: "",
    sample: ["IN", "K-FUSED2"],
  }),
  rule({
    label: "internal-ticket-id-fused",
    why: "Internal ticket id with the hyphen dropped and the prefix fused straight onto the number (seen fused into a test FILENAME). Substring, case-insensitive, so it fires inside identifiers and paths.",
    pattern: ["in", "k\\d+"],
    sample: ["in", "k700"],
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

/**
 * How far into a file a NUL byte still means "this file is binary".
 *
 * Git's own buffer_is_binary sniffs a LEADING WINDOW rather than the whole
 * file, and the reason it does is exactly the case this gate met. A whole-file
 * `buffer.includes(0)` exempted any file holding a NUL anywhere from all
 * rules, and the file that tripped it was a test whose hostile-input fixture
 * carries one deliberate literal NUL 20KB in. That single byte took the one
 * uncleaned file in the extraction - real names, paths and ticket ids intact -
 * out of scope, and the gate printed "clean" over it in the same words it uses
 * when it means it.
 *
 * A leading window separates the two real populations correctly: this
 * repository's genuine binaries (PNGs) all carry their first NUL within the
 * first ten bytes, and text that merely CONTAINS a NUL is scanned like the
 * text it is.
 */
const BINARY_SNIFF_BYTES = 8000;

/** @param {string} filePath @returns {{ file: string, line: number, label: string, why: string }[]} */
function scanFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return []; // binary file (NUL in the first 8000 bytes, matching git's own heuristic)
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

/**
 * Denied material can live in a file's NAME with no trace in its content:
 * the observed case was an internal ticket id fused into a test filename,
 * where every in-content reference had been cleaned and the path itself was
 * the only remaining copy. Content scanning cannot see that, so the
 * repo-relative path is run through the same rule set. Findings are
 * reported as line 0 to distinguish them from content findings.
 *
 * @param {string} filePath @returns {{ file: string, line: number, label: string, why: string }[]}
 */
function scanFileName(filePath) {
  const relative = path.relative(REPO_ROOT, filePath);
  const findings = [];
  for (const { label, why, re } of RULES) {
    if (re.test(relative)) {
      findings.push({ file: filePath, line: 0, label: `${label} (in filename)`, why });
    }
  }
  return findings;
}

/**
 * Every file in the working tree that git would consider part of the
 * repository: tracked, plus untracked-and-not-ignored.
 *
 * The `--others --exclude-standard` half is load-bearing rather than
 * defensive. Material arrives here by being copied in from the internal
 * side, and it is untracked for as long as it takes to clean it, which is
 * exactly the window in which the gate is the only thing standing between
 * that material and a commit. Enumerating tracked files alone made the gate
 * report "clean (39 files scanned)" over a working tree holding 291
 * uncleaned files and 2,763 findings: a pass that meant nothing, printed in
 * the same words as a pass that means everything.
 */
function repositoryFiles() {
  const output = execFileSync(
    "git",
    ["-C", REPO_ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  );
  return output
    .split("\0")
    .filter(Boolean)
    .map((relative) => path.join(REPO_ROOT, relative))
    .filter((absolute) => fs.existsSync(absolute) && fs.statSync(absolute).isFile());
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
    // Prove the FILENAME scanning path fires too, not just content scanning:
    // a check that only exercises content would pass while a denied string
    // hides in a file's name. One representative rule is enough to prove the
    // path is alive; the per-rule pattern proofs above cover the rule set.
    const fusedSample = RULES.find((r) => r.label === "internal-ticket-id-fused");
    if (!fusedSample) {
      console.error("leak-gate self-test: internal-ticket-id-fused rule missing");
      process.exit(1);
    }
    const namedFile = path.join(dir, `${fusedSample.sample}.txt`);
    fs.writeFileSync(namedFile, "clean content\n", "utf8");
    if (scanFileName(namedFile).length === 0) {
      console.error("leak-gate self-test: filename scanning failed to catch a denied string in a file name");
      process.exit(1);
    }
    // Prove the BINARY SNIFF is a leading window and not a whole-file check.
    // This is the regression pin for an observed miss, not a hypothetical: one
    // real test file carried a deliberate literal NUL 20KB into a hostile-input
    // fixture, and under a whole-file check that byte exempted the entire file
    // from all rules while the gate reported clean over it. Two files here,
    // because the fix has two halves and either can rot alone: a NUL PAST the
    // window must not stop the scan, and a NUL INSIDE the window must still
    // skip the file (or the gate starts reading PNGs and reporting noise).
    const pinned = RULES.find((r) => r.label === "internal-ticket-id");
    if (!pinned) {
      console.error("leak-gate self-test: internal-ticket-id rule missing");
      process.exit(1);
    }
    const lateNulFile = path.join(dir, "late-nul.txt");
    fs.writeFileSync(
      lateNulFile,
      `${pinned.sample}\n${"filler line\n".repeat(1000)}\0 trailing binary-ish fixture\n`,
      "utf8",
    );
    if (fs.readFileSync(lateNulFile).indexOf(0) <= BINARY_SNIFF_BYTES) {
      console.error("leak-gate self-test: fixture is wrong, its NUL is inside the sniff window");
      process.exit(1);
    }
    if (!scanFile(lateNulFile).some((f) => f.label === pinned.label)) {
      console.error(
        "leak-gate self-test: a text file with a NUL past the sniff window was skipped, so any file holding one anywhere is unscanned",
      );
      process.exit(1);
    }
    const earlyNulFile = path.join(dir, "early-nul.bin");
    fs.writeFileSync(earlyNulFile, Buffer.concat([Buffer.from("\0PNG-ish\n"), Buffer.from(pinned.sample)]));
    if (scanFile(earlyNulFile).length > 0) {
      console.error("leak-gate self-test: a real binary was scanned as text; the sniff window is not being honoured");
      process.exit(1);
    }
    console.log(
      `leak-gate self-test: all ${RULES.length} rules fire correctly (content, filename and binary-sniff paths)`,
    );
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
  const files = args.length > 0 ? args : repositoryFiles();
  const findings = files.flatMap((file) => [...scanFileName(file), ...scanFile(file)]);
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
