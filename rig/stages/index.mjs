/**
 * THE DECLARATION.
 *
 * This list is the run's definition of complete. It is data, it is read
 * before anything executes, and the report's "N of N" takes both numbers from
 * here rather than from what happened. Adding a stage means adding it here;
 * a stage module that exists but is not listed will never run, which is the
 * intended failure mode - the alternative, a runner that discovers stage
 * files from disk, reports a triumphant green over an empty set on the day
 * its glob stops matching.
 *
 * Stages 05 to 08 measure INSTALL.md, and they measure it by EXECUTING IT:
 * the document's fenced blocks are extracted and run, in order, unmodified, in
 * fresh containers built from a base that has none of the tools the document
 * tells a reader to install. No stage here reimplements an instruction in its
 * own words, because a script that does the same thing as the document is a
 * second artefact that agrees with it exactly once.
 *
 * Still absent from this declaration, and absent rather than skipped: the
 * final outputs of the plan (phase 7). A skip is a colour and this rig does
 * not have a colour for "we did not look".
 */
import baseAttestation from "./00-base-attestation.mjs";
import sourceEntry from "./01-source-entry.mjs";
import toolchain from "./02-toolchain.mjs";
import documentedChecks from "./03-documented-checks.mjs";
import nodeTwentyFloor from "./04-node20-floor.mjs";
import installDoc from "./05-install-doc.mjs";
import installTryIt from "./06-install-try-it.mjs";
import installRunIt from "./07-install-run-it.mjs";
import installAgents from "./08-install-agents.mjs";

export const STAGES = [
  baseAttestation,
  sourceEntry,
  toolchain,
  documentedChecks,
  nodeTwentyFloor,
  installDoc,
  installTryIt,
  installRunIt,
  installAgents,
];
