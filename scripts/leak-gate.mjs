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
 * WHAT A CLONE HANDS OVER, which is more than the working tree.
 *
 * The working-tree scan answers "is the checkout clean". That is not the
 * question a public repository poses. Someone who clones this gets every
 * reachable object and every commit message, and a string removed by a later
 * commit is still served by `git show` from the tree that carried it. So the
 * gate has three scopes, and only all three together mean anything:
 * the working tree, every reachable blob, and every reachable message.
 *
 * USAGE
 *   node scripts/leak-gate.mjs                  scan every file in the working
 *                                               tree that is not gitignored
 *   node scripts/leak-gate.mjs <file>...        scan the given files only
 *   node scripts/leak-gate.mjs --history        scan every blob reachable from
 *                                               any ref, and every object path
 *   node scripts/leak-gate.mjs --messages       scan every reachable commit's
 *                                               subject, body and trailers
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
 * Fixed cut-off for the history-exempt rules: the default-branch commit that was
 * current when those rules were added. Blobs reachable from it are legacy and
 * cannot be unpublished. Every blob introduced AFTER it is scanned with every
 * rule, so new history stays checked. Never move this forward to silence a
 * finding; a finding in a newer blob is a real one.
 */
const LEGACY_CUTOFF = "e398eb22ab24866b8ac5a05aae8d7458a1ea886f";

/**
 * @param {{ label: string, why: string, pattern: string[], flags?: string, sample: string[], messageExempt?: boolean, messageExemptPattern?: string[], historyExempt?: boolean }} spec
 */
function rule({ label, why, pattern, flags = "i", sample, messageExempt = false, messageExemptPattern, contentExemptPattern, historyExempt = false }) {
  return {
    label,
    // Skipped by the --history scan for LEGACY blobs only, meaning blobs
    // reachable from LEGACY_CUTOFF. For a rule added AFTER the material it denies
    // was already published: past blobs cannot be unpublished, so the rule guards
    // the working tree and every blob introduced after the cut-off, and the
    // history scan would otherwise fail forever on content already cleaned up.
    historyExempt,
    why,
    re: new RegExp(pattern.join(""), flags),
    sample: sample.join(""),
    messageExempt,
    // A narrower, anchored allow-pattern: when set, a message-scope match is
    // only skipped if the SAME line also matches this exact shape, everything
    // else the rule's own pattern catches still fires. This is deliberately
    // separate from `messageExempt` (a whole-rule skip), because a rule whose
    // pattern class covers more than one person's identity (an email-domain
    // rule, not a specific name) must not go blind to every OTHER match on
    // that class just to permit one pre-approved instance.
    messageExemptPattern: messageExemptPattern ? new RegExp(messageExemptPattern.join(""), flags) : undefined,
    // Content-scope counterpart: this exact shape is blanked out of the text
    // BEFORE the rule runs, so only that instance is permitted. Anything else
    // the rule's own pattern catches, including the same name elsewhere on the
    // same line, still fires. Global so every instance on a line is blanked.
    contentExemptRe: contentExemptPattern ? new RegExp(contentExemptPattern.join(""), flags.replace("g", "") + "g") : undefined,
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
    why: "First name of the person the internal deployment serves. A real person's name in the open repo is a clean-room breach. Substring match: distinctive, no \\b (see section comment). EXEMPT IN MESSAGE SCOPE ONLY (see messageExempt below): this person is the repository's maintainer and the author and committer fields of every commit here carry his full name and address, by a deliberate decision that is not being revisited. Denying in a commit body what the header of that same commit states outright is theatre, and a rule kept only by being ignored is worse than no rule. It stays fully enforced over file content, where there is no such decision and no such header.",
    pattern: ["si", "mon"],
    sample: ["si", "mon"],
    messageExempt: true,
    // The canonical clone URL carries the GitHub owner, which is this name,
    // and INSTALL.md has to print it. Exempt that one URL and nothing wider:
    // the owner/repo pair is fixed, an optional .git is allowed, and a longer
    // repo name (a fork-style suffix) does not match.
    contentExemptPattern: ["https://github\\.com/si", "mon-ink", "ie/ink", "ie-deck(?:\\.git)?(?![\\w-])"],
  }),
  rule({
    label: "second-principal-first-name",
    why: "First name of the second person the internal deployment serves. Substring match: distinctive, no \\b (see section comment).",
    pattern: ["sop", "hie"],
    sample: ["sop", "hie"],
  }),
  rule({
    label: "third-principal-first-name",
    why: "First name of a third real person the internal deployment serves, named in the internal roster alongside the two above. Substring match: distinctive, no realistic false positive.",
    pattern: ["lou", "ise"],
    sample: ["lou", "ise"],
  }),
  // DELIBERATE OMISSION, so nobody adds it later thinking it was missed.
  // A FOURTH real person shares her first name with one half of the
  // alice/bob placeholder pair, and this repository uses that pair for
  // demo agent names in roughly thirty-six places. A rule for it would
  // fire on every one of them and be deleted within a day. The real
  // exposure is not the bare name, it is the name next to a role, so it
  // is guarded by review: if a fixture ever grows a job title, a company
  // position or a meeting cadence beside that name, that is the leak.

  // -- Children -------------------------------------------------------------
  rule({
    label: "principal-child-first-name",
    why: "First names of the principal's children. These reached the repository as speech-recognition keyterms, with doc comments describing dictation measured against them. Word-bounded and case-sensitive: one is a common word in other cases and inside hyphenated identifiers (a model id in this tree ends in it), and only the capitalised standalone form is the real name.",
    pattern: ["\\b(?:S", "ol|As", "traea)\\b"],
    flags: "",
    sample: ["S", "ol"],
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
  rule({
    label: "fleet-agent-name-boundary",
    why: "Two more internal fleet agent names that must keep \\b bounds because each is a substring of an ordinary English word - one of a word for a collection of work samples, the other of the words for medicine and a paramedic. Weaker than the distinctive rule by construction: a fused occurrence will NOT fire.",
    pattern: [
      "\\b(?:fo", "lio|me", "dic)\\b",
    ],
    sample: ["fo", "lio"],
  }),
  rule({
    label: "fleet-agent-name-platform-specialist",
    why: "The platform specialist agent's two-word name and its internal three-character abbreviation. The distinctive rule above catches only the runtime spelling of this name; the prose spelling and the abbreviation are different strings entirely. The abbreviation was the larger surface in practice: it appeared eleven times across seven files as a code-comment attribution and in no other shape. The separator alternation includes the PERCENT-ENCODED space, which is not decoration: one occurrence of this name lived in a URL query assertion, survived a pass that replaced every other spelling, and was caught by a failing test rather than by this rule.",
    pattern: [
      "(?:doc", "tor(?:[-_ ]|%20)?two|\\bd", "r2\\b)",
    ],
    sample: ["Doc", "tor Two"],
  }),
  rule({
    label: "private-agent-persona-name",
    why: "The internal coordinator agent's persona name. Two letters, so it is word-bounded AND case-sensitive, matching only the capitalised prose form and the all-lowercase identifier form. The all-UPPERCASE spelling is deliberately allowed: it is the ordinary abbreviation for input/output, which this repository's own purity markers use two dozen times, and denying it would make the rule unusable. Both denied spellings are at zero occurrences in this tree, which is what makes a bounded rule for a two-letter name affordable at all. Keep it that way: the demo roster uses a different coordinator name precisely so this can stay empty.",
    pattern: ["\\b(?:I|i)", "o\\b"],
    flags: "",
    sample: ["I", "o"],
  }),
  rule({
    label: "coordinator-attribution-shape",
    why: "Two shapes that name the internal open-source maintainer agent: a parenthesised credit, and a protocol message header naming it as sender. There is DELIBERATELY no bare-word rule for this name, and that omission must not be 'fixed': the name is an ordinary English word that this repository's own documentation uses constantly (a contributing one, an installation one, a style one). Coverage for it is these two shapes plus the agent-home path rule below, and nothing else.",
    pattern: ["(?:\\(G", "uide[),:]|from: g", "uide\\b)"],
    flags: "",
    sample: ["(G", "uide)"],
  }),
  rule({
    label: "real-agent-home-path",
    why: "A path under an agent home directory that names one of the internal fleet's real agents. The <home>/agents/<name> path SHAPE is this product's own shipped convention and is fine on its own; the names in this alternation are not. This is also the only coverage for two names the bare-name rules cannot have: the two-letter coordinator name, and the maintainer name that is an ordinary English word.",
    pattern: [
      "(?:~|/home/[A-Za-z0-9_.-]+)/agents/",
      "(?:i", "o|fo", "lio|gu", "ide|me", "dic|doc", "tor2|al", "dus|ag",
      "gy|an", "dor|mon", "tani|hop", "kins|mag", "gie|p", "ea|se",
      "th|ir", "is)\\b",
    ],
    sample: ["~/agents/", "i", "o/bin/sweep.sh"],
  }),

  // -- Internal repositories and hosts --------------------------------------
  rule({
    label: "internal-repo-or-host-name",
    why: "Name of an internal repository, project or host. Their names alone reveal internal topology and invite links back into private material.",
    // NB the fragment split here is not arbitrary, and it has been wrong
    // twice. Splitting an alternation at its SEPARATORS leaves whichever
    // name follows sitting at the start of a fragment, delimited by a quote
    // on one side and a pipe or hyphen on the other: a bare, word-bounded
    // instance of a denied string, in the denylist itself. This one line
    // held two of them, one three letters and one two, and neither was
    // visible to any rule that existed at the time. Fragments must break
    // the NAMES, never the separators between them.
    pattern: [
      "\\b(?:the-", "brain|mission-", "control|i", "o-projects|inkie-p",
      "gr|inkie-", "app-v2|inkie-", "worker|inkie-", "functions)\\b",
    ],
    sample: ["mission-", "control"],
  }),

  rule({
    label: "internal-worktree-name",
    why: "Names of internal per-agent git worktrees, plus the internal codename the shared memory system grew out of (which survives today as a real agent silo directory name). Leading \\b only, no trailing bound, on purpose: a numbered SECONDARY worktree is the same name with a digit appended, and a trailing \\b silently misses it. One such secondary was in the tree when this rule was written.",
    // Same split discipline as internal-repo-or-host-name above: break the
    // names, not the pipes. A fragment that STARTS with the two-letter
    // coordinator name, with a quote before it and a pipe after, is a bare
    // word-bounded instance of a denied string sitting in the denylist.
    pattern: [
      "\\b(?:inkie-", "gtm|inkie-i", "o|inkie-", "analytics|grey", "matter)",
    ],
    sample: ["inkie-", "gtm"],
  }),
  rule({
    label: "internal-commit-sha-citation",
    why: "A short hex commit id cited in prose as provenance, pointing at a commit in the private repository this one was extracted from. A bare hex run is far too common to deny, so this is shape-scoped: 7 to 12 hex characters containing at least one letter (so a decimal constant such as a cache max-age cannot match), immediately preceded by the word for a commit, an opening parenthesis, or a comma and a space. That covered every instance found in this tree, in eight distinct shapes.",
    pattern: [
      "(?:com", "mit |\\(|, )",
      "(?=[0-9a-f]{7,12}\\b)[0-9a-f]*[a-f][0-9a-f]*\\b",
    ],
    flags: "",
    sample: ["(", "3e5b1a2", ")"],
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
  rule({
    label: "internal-ticket-id-lowercase-hyphenated",
    why: "Internal ticket id with the hyphen kept but lowercased (seen live in a branch-name string inside a slug: git branch conventions lowercase everything, so a real id survives here in neither the case the numeric rule requires nor the no-hyphen shape the fused rule requires). Case-insensitive with a hyphen, but leading \\b so it does not fire inside an unrelated word ending in the same four letters (shrink-0, a real Tailwind class, matches without the boundary).",
    pattern: ["\\bin", "k-\\d+"],
    sample: ["in", "k-691"],
  }),

  // -- Email ----------------------------------------------------------------
  rule({
    label: "company-email-address",
    why: "Addresses on the company mail domain are personal contact details, not public repo content. NARROWLY exempt for one exact message shape only (see messageExemptPattern below), not the whole rule: GitHub's own squash-merge writes a Co-authored-by trailer carrying the maintainer's address onto the merge commit, and that address already sits in the author/committer header of every commit here by the same deliberate, standing decision that exempts his first name (principal-first-name, above). A blanket message-scope skip here would go blind to every OTHER address on the domain in every message shape, not just this one pre-approved instance, this rule's pattern class covers more than one person's identity, unlike a specific name. (An independent model-diverse review pass, 2026-08-17, caught the original blanket exemption on its first look.)",
    pattern: ["[A-Za-z0-9._-]+@ink", "ie\\.ink\\b"],
    sample: ["someone@ink", "ie.ink"],
    messageExemptPattern: ["^Co-au", "thored-by: Si", "mon <si", "mon@ink", "ie\\.ink>$"],
  }),

  // -- Internal tooling -----------------------------------------------------
  rule({
    label: "private-db-tool-name",
    why: "The internal read-only production-database CLI, in its bare, dotfile-prefix and credential-bundle shapes. Bounded on the bare form because the widely-used search tool this repository names about thirty times contains the same three letters fused mid-word; without the bound this rule fires on every one of those and gets deleted.",
    pattern: ["(?:\\bp", "gr\\b|\\.p", "gr-|p", "gr-creds)"],
    sample: ["x.p", "gr-creds.age"],
  }),
  rule({
    label: "private-note-provenance-citation",
    why: "A CITATION, in a comment, pointing at a specific document in a private home-directory vault: a reference verb followed by a home-relative path, or a reference to a date-stamped note. (Written out longhand rather than shown as an example, because an example of this shape matches this rule, and the denylist holding an instance of a denied string is a mistake this file has now made three times.) What leaks is not the path. It is the claim that a named internal document exists and that this code was derived from it, which a reader outside cannot open, cannot check, and cannot act on. DELIBERATELY NARROW, and it has to stay that way: home-relative vault paths are ordinary PRODUCT content here. They are what the review panel resolves and what the file-reference, autolink and project-card parsers are tested against, so a dozen of them are legitimate fixtures and a rule denying the bare shape would be deleted within a day. Two alternations only: a reference verb immediately before the path, and a date-stamped filename two levels into a home directory, which no placeholder fixture has a reason to be. A path built from a variable in a template literal is excluded on purpose, because that is a test constructing a path rather than anything citing a document.",
    pattern: [
      "(?:\\b(?:sou", "rce|s", "ee|r", "ef|p", "er|c", "f)\\b[:.]?\\s+~/[a-z][a-z-]*/",
      "|~/[a-z][a-z-]*/[a-z][a-z-]*/\\d{4}-\\d{2}-\\d{2})",
    ],
    sample: ["Sou", "rce: ~/vault/design/tokens.md"],
  }),
  rule({
    label: "private-session-link",
    why: "A link into a private assistant session transcript. These shipped as a commit-message trailer on most of this repository's history. The transcripts are not public, the URLs mean nothing to anyone who cannot open them, and they tie every commit to a specific private session.",
    pattern: ["cla", "ude\\.ai/co", "de/"],
    sample: ["https://cla", "ude.ai/co", "de/session_abc"],
  }),

  // -- Review provenance and people named in prose ---------------------------
  rule({
    label: "review-tool-citation",
    why: "A numbered change-request reference from the private tracker the code was extracted from, cited as the source of a finding. The number resolves to nothing for an outside reader. State the engineering reason instead of the citation. Shape-scoped: the word finding or fold, or a review tool's name, followed shortly by a change-request sigil and digits. A plain mention that a review tool ran, or a bare change-request reference, is ordinary and does not fire.",
    pattern: ["(?:\\b(?:finding|fold)\\b|[Cc]ode ?", "[Rr]abbit)[^\\n]{0,24}\\bMR ?[!#]\\d+"],
    flags: "",
    sample: ["Code", "Rabbit finding, M", "R !12"],
    historyExempt: true,
  }),
  rule({
    label: "internal-reviewer-fold-citation",
    why: "A review credit in the internal 'fold' shape, naming an internal reviewing agent: a reviewing agent's name followed by the word for folding in a finding, or by an amendment or a call. This was the commonest private-context shape found in the comment sweep. Bare agent names stay legal (they are demo roster names in fixtures); only the credit shapes are denied. Word-bounded and case-sensitive.",
    pattern: ["\\b(?:At", "las|Qu", "ill)(?:'s call| (?:fold|amendment|hole|pin|landed-review)|\\)?, (?:TASK|MR))"],
    flags: "",
    sample: ["At", "las fold"],
    historyExempt: true,
  }),
  rule({
    label: "internal-tracker-prefix-in-comment",
    why: "An internal tracker or requirement id (the TASK, FND, CARD, VALID, QUEUE, THRD and DETECT families) inside a comment. The ids mean nothing outside the original organisation. Scoped to comment lines (a line starting with a comment marker, or a spaced trailing comment) because the same text appears legitimately as parser test data in ticket-url fixtures. Shell and markdown hash comments are not covered: a hash at line start is also a markdown heading. State the reason, not the id.",
    pattern: ["(?:^\\s*(?://|\\*|\\{/\\*|/\\*)| // ).*\\b(?:TA", "SK|FN", "D|CA", "RD|VAL", "ID|QUE", "UE|THR", "D|DETE", "CT)-\\d"],
    flags: "",
    sample: ["// see TA", "SK-123"],
    historyExempt: true,
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

/**
 * Scan a buffer of file content. `display` is only ever used to report the
 * finding, so callers can pass a working-tree path, a "<blob>:<path>" pair,
 * or a commit id; the scanning itself never touches the filesystem.
 *
 * @param {string} display @param {Buffer} buffer
 * @returns {{ file: string, line: number, label: string, why: string }[]}
 */
function scanBuffer(display, buffer, legacyBlob = false) {
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return []; // binary file (NUL in the first 8000 bytes, matching git's own heuristic)
  }
  const findings = [];
  const lines = buffer.toString("utf8").split("\n");
  for (const [index, lineText] of lines.entries()) {
    for (const { label, why, re, contentExemptRe, historyExempt } of RULES) {
      if (legacyBlob && historyExempt) continue;
      const tested = contentExemptRe ? lineText.replace(contentExemptRe, "") : lineText;
      if (re.test(tested)) {
        findings.push({ file: display, line: index + 1, label, why });
      }
    }
  }
  return findings;
}

/** @param {string} filePath @returns {{ file: string, line: number, label: string, why: string }[]} */
function scanFile(filePath) {
  return scanBuffer(filePath, fs.readFileSync(filePath));
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
  return scanName(path.relative(REPO_ROOT, filePath), filePath);
}

/**
 * @param {string} relative repo-relative path to test
 * @param {string} display how to report it
 * @returns {{ file: string, line: number, label: string, why: string }[]}
 */
function scanName(relative, display = relative) {
  const findings = [];
  for (const { label, why, re } of RULES) {
    if (re.test(relative)) {
      findings.push({ file: display, line: 0, label: `${label} (in filename)`, why });
    }
  }
  return findings;
}

/** @param {string[]} args @returns {string} */
function git(args) {
  return execFileSync("git", ["-C", REPO_ROOT, ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
}

/**
 * --history: scan every BLOB reachable from any ref, not every tree.
 *
 * Iterating the 46 trees and scanning each one's 365 files re-reads the same
 * unchanged blob dozens of times: 16,790 file scans to cover 548 distinct
 * objects. Reachability is what the question actually is - "can anyone who
 * clones this get at a denied string" - and a blob is reachable or it is not,
 * regardless of how many trees point at it. So the unit is the blob, and each
 * one is read once.
 *
 * A blob is reported with one of the paths it is stored under, which is enough
 * to find it; `git log --all --find-object=<sha>` gives the commits if needed.
 * Paths are scanned too, for the same reason the working-tree mode scans them:
 * a denied string can live in a name with no trace in any content.
 */
function scanHistory(repo = REPO_ROOT, cutoff = LEGACY_CUTOFF) {
  const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  const findings = [];
  const seenPath = new Set();
  // Legacy blobs: everything reachable from the fixed cut-off. A missing cut-off
  // (a shallow clone) must fail loudly rather than silently exempt nothing or
  // everything.
  try {
    git(["cat-file", "-e", `${cutoff}^{commit}`]);
  } catch {
    console.error(`leak-gate: history cut-off ${cutoff} is not in this clone; fetch full history (git fetch --unshallow).`);
    process.exit(2);
  }
  const legacy = new Set();
  for (const line of git(["rev-list", "--objects", cutoff]).split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) legacy.add(line.slice(0, space));
  }
  const lines = git(["rev-list", "--objects", "--all"]).split("\n").filter(Boolean);
  const blobs = new Map(); // sha -> first path seen
  for (const line of lines) {
    const space = line.indexOf(" ");
    if (space < 0) continue; // commit or root tree: no path, not a blob
    const sha = line.slice(0, space);
    const objectPath = line.slice(space + 1);
    if (!blobs.has(sha)) blobs.set(sha, objectPath);
    if (!seenPath.has(objectPath)) {
      seenPath.add(objectPath);
      findings.push(...scanName(objectPath));
    }
  }
  // One batch-check call for every object's type, rather than one `cat-file -t`
  // per object: rev-list --objects reports directories (trees) with paths too,
  // and telling them apart one spawn at a time costs more than the scan does.
  const types = new Map();
  for (const line of git(["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"]).split("\n")) {
    const [sha, type] = line.split(" ");
    if (sha && type) types.set(sha, type);
  }
  let scanned = 0;
  for (const [sha, objectPath] of blobs) {
    if (types.get(sha) !== "blob") continue;
    scanned += 1;
    const buffer = execFileSync("git", ["-C", repo, "cat-file", "blob", sha], {
      maxBuffer: 512 * 1024 * 1024,
    });
    findings.push(...scanBuffer(`${sha.slice(0, 10)} (${objectPath})`, buffer, legacy.has(sha)));
  }
  return { findings, scanned, paths: seenPath.size };
}

/**
 * Message-scope matching for a single line, pulled out of scanMessages so the
 * self-test can pin the messageExempt / messageExemptPattern semantics
 * directly against synthetic strings, without needing a real commit: git
 * history is append-mostly by design, and this exemption logic is a security
 * boundary that deserves a regression pin, not just a manually-run probe.
 *
 * @param {string} lineText
 * @returns {{ label: string, why: string }[]}
 */
function scanMessageLine(lineText) {
  const findings = [];
  for (const { label, why, re, messageExempt, messageExemptPattern } of RULES) {
    if (messageExempt) continue;
    if (re.test(lineText)) {
      if (messageExemptPattern && messageExemptPattern.test(lineText)) continue;
      findings.push({ label, why });
    }
  }
  return findings;
}

/**
 * --messages: scan every reachable commit's subject, body and trailers.
 *
 * Blob content is only half of what a clone hands over. `git log` is the other
 * half, and it is the half a reader reaches for first. Messages in this
 * repository's history named a real ticket id, a real branch, a real person's
 * observation of a real fleet, and carried a link into a private session
 * transcript on most commits.
 */
function scanMessages() {
  const findings = [];
  const shas = git(["rev-list", "--all"]).split("\n").filter(Boolean);
  // One `git log -1` per commit, rather than one batched call that splits on a
  // separator embedded in the format string. A separator has to be a byte
  // sequence no message can contain, and these message bodies are the very
  // material under audit; guess wrong and a commit is split in half with
  // neither part scanned properly. Forty-six spawns cost milliseconds and
  // cannot be fooled by their own input.
  for (const sha of shas) {
    const message = git(["log", "-1", "--format=%B", sha]);
    for (const [index, lineText] of message.split("\n").entries()) {
      for (const { label, why } of scanMessageLine(lineText)) {
        findings.push({ file: `${sha.slice(0, 10)} (message)`, line: index + 1, label, why });
      }
    }
  }
  return { findings, scanned: shas.length };
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
    // Negative samples: shapes the new prose rules must NOT fire on. Each is
    // built from fragments so this file does not contain a live instance.
    const negatives = [
      ["internal-tracker-prefix-in-comment", "ticket: https://tracker.example/TA" + "SK-12"],
      ["internal-tracker-prefix-in-comment", "# TA" + "SK-12 as a markdown heading"],
      ["internal-reviewer-fold-citation", "the At" + "las agent wrote this fixture"],
      ["review-tool-citation", "a bare !123 is not a citation"],
      ["review-tool-citation", "see MR !12 for background"],
      ["review-tool-citation", "try { } catch (e) { } // see MR !12"],
      ["review-tool-citation", "A review tool ran on the public pull request"],
      ["review-tool-citation", "Code" + "Rabbit finding: prefer a Map here"],
      ["review-tool-citation", "Code" + "Rabbit is a hosted review tool"],
    ];
    for (const [label, text] of negatives) {
      const hit = scanBuffer("negative-sample", Buffer.from(`${text}\n`, "utf8")).some((f) => f.label === label);
      if (hit) {
        console.error(`leak-gate self-test: ${label} fired on a sample it must allow: ${text}`);
        process.exit(1);
      }
    }
    // Pin the cut-off: moving it must be a deliberate, visible edit to this line
    // as well as to the constant, never a side effect of another change.
    if (LEGACY_CUTOFF !== "e398eb22ab24866b8ac5a05aae8d7458a1ea886f") {
      console.error("leak-gate self-test: LEGACY_CUTOFF changed; update this pin deliberately");
      process.exit(1);
    }
    // Prove historyExempt is bounded, not blind: in a throwaway repository a
    // legacy blob (reachable from the cut-off) is exempt, and a blob introduced
    // AFTER the cut-off is still scanned with every rule.
    const exemptRules = RULES.filter((r) => r.historyExempt);
    if (exemptRules.length === 0) {
      console.error("leak-gate self-test: no historyExempt rules to prove");
      process.exit(1);
    }
    const repoDir = path.join(dir, "history-repo");
    fs.mkdirSync(repoDir);
    const run = (...args) =>
      execFileSync("git", ["-C", repoDir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    run("init", "-q");
    exemptRules.forEach((r, i) => fs.writeFileSync(path.join(repoDir, `legacy-${i}.txt`), `${r.sample}\n`));
    run("add", "-A");
    run("commit", "-q", "-m", "legacy");
    const cutoff = run("rev-parse", "HEAD").trim();
    exemptRules.forEach((r, i) => fs.writeFileSync(path.join(repoDir, `newer-${i}.txt`), `${r.sample} new\n`));
    run("add", "-A");
    run("commit", "-q", "-m", "newer");
    const found = scanHistory(repoDir, cutoff);
    for (const [i, r] of exemptRules.entries()) {
      const hits = found.findings.filter((f) => f.label === r.label);
      if (hits.some((f) => f.file.includes(`legacy-${i}.txt`))) {
        console.error(`leak-gate self-test: ${r.label} fired on a legacy blob it is exempt for`);
        process.exit(1);
      }
      if (!hits.some((f) => f.file.includes(`newer-${i}.txt`))) {
        console.error(`leak-gate self-test: ${r.label} did not fire on a blob added after the cut-off`);
        process.exit(1);
      }
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
    // Prove the message-scope EXEMPTION semantics, not just that the rules
    // fire. Regression pin for a caught mistake: the first cut of this
    // mechanism set messageExempt: true on company-email-address wholesale,
    // which silently permitted every address on the domain in every message
    // shape, not just the one pre-approved trailer, an independent review
    // caught it before it shipped. Three cases, assembled from fragments so
    // this file never carries the literal accepted string (see file header):
    // the approved exact shape is skipped, the same address outside that
    // shape still fires, and a DIFFERENT address in the same shape still
    // fires, proving the allow-pattern is anchored to one instance, not the
    // whole rule.
    const emailRule = RULES.find((r) => r.label === "company-email-address");
    if (!emailRule) {
      console.error("leak-gate self-test: company-email-address rule missing");
      process.exit(1);
    }
    const acceptedTrailer = ["Co-au", "thored-by: Si", "mon <si", "mon@ink", "ie.ink>"].join("");
    const proseSameAddress = ["contact si", "mon@ink", "ie.ink for details"].join("");
    const differentAddressTrailer = ["Co-au", "thored-by: Some", "one <some", "one@ink", "ie.ink>"].join("");
    if (scanMessageLine(acceptedTrailer).some((f) => f.label === emailRule.label)) {
      console.error("leak-gate self-test: the approved maintainer trailer shape should be exempt in message scope but fired");
      process.exit(1);
    }
    if (!scanMessageLine(proseSameAddress).some((f) => f.label === emailRule.label)) {
      console.error("leak-gate self-test: the same address outside the approved trailer shape should still fire in message scope");
      process.exit(1);
    }
    if (!scanMessageLine(differentAddressTrailer).some((f) => f.label === emailRule.label)) {
      console.error(
        "leak-gate self-test: a different address in the approved trailer shape should still fire, messageExemptPattern is over-broad",
      );
      process.exit(1);
    }
    // Prove the content-scope URL exemption is narrow: the canonical clone
    // URL passes, and the name still fires on the bare name, on a different
    // URL, on a longer repo name, and beside an exempt URL on the same line.
    const nameRule = RULES.find((r) => r.label === "principal-first-name");
    if (!nameRule?.contentExemptRe) {
      console.error("leak-gate self-test: principal-first-name rule or its content exemption missing");
      process.exit(1);
    }
    const owner = ["si", "mon-ink", "ie"].join("");
    const bareName = ["si", "mon"].join("");
    const exemptCases = [
      { text: `git clone https://github.com/${owner}/inkie-deck.git && cd inkie-deck`, fires: false, why: "the canonical clone URL" },
      { text: `see https://github.com/${owner}/inkie-deck for the source`, fires: false, why: "the canonical URL without .git" },
      { text: `ask ${bareName} about it`, fires: true, why: "the bare name" },
      { text: `https://github.com/${owner}/other-repo.git`, fires: true, why: "a different repo under the same owner" },
      { text: `https://github.com/${owner}/inkie-deck-fork.git`, fires: true, why: "a longer repo name" },
      { text: `http://example.com/${owner}/inkie-deck.git`, fires: true, why: "a different host" },
      { text: `https://github.com/${owner}/inkie-deck.git from ${bareName}`, fires: true, why: "the name beside an exempt URL" },
    ];
    for (const { text, fires, why } of exemptCases) {
      const fired = scanBuffer("case", Buffer.from(text)).some((f) => f.label === nameRule.label);
      if (fired !== fires) {
        console.error(`leak-gate self-test: principal-first-name ${fires ? "should fire on" : "should exempt"} ${why}`);
        process.exit(1);
      }
    }
    console.log(
      `leak-gate self-test: all ${RULES.length} rules fire correctly (content, filename and binary-sniff paths)`,
    );
    console.log("leak-gate self-test: message-scope exemption is narrow (approved shape only, not the whole rule)");
    console.log("leak-gate self-test: content-scope URL exemption is narrow (canonical clone URL only)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {{ file: string, line: number, label: string, why: string }[]} findings
 * @param {string} cleanMessage
 * @param {boolean} relativise
 */
function report(findings, cleanMessage, relativise) {
  if (findings.length > 0) {
    for (const { file, line, label, why } of findings) {
      const shown = relativise ? path.relative(REPO_ROOT, file) : file;
      console.error(`${shown}:${line}: [${label}] ${why}`);
    }
    console.error(`\nleak-gate: ${findings.length} finding(s). This material must not enter the repository; see the rule comments in scripts/leak-gate.mjs.`);
    process.exit(1);
  }
  console.log(cleanMessage);
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--self-test") {
    selfTest();
    return;
  }
  if (args[0] === "--history") {
    const { findings, scanned, paths } = scanHistory();
    report(
      findings,
      `leak-gate --history: clean (${scanned} reachable blobs and ${paths} object paths scanned, ${RULES.length} rules)`,
      false,
    );
    return;
  }
  if (args[0] === "--messages") {
    const { findings, scanned } = scanMessages();
    report(
      findings,
      `leak-gate --messages: clean (${scanned} reachable commit messages scanned, ${RULES.length} rules)`,
      false,
    );
    return;
  }
  const files = args.length > 0 ? args : repositoryFiles();
  const findings = files.flatMap((file) => [...scanFileName(file), ...scanFile(file)]);
  report(
    findings,
    `leak-gate: clean (${files.length} files scanned, ${RULES.length} rules)`,
    true,
  );
}

main();
