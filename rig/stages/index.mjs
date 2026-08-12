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
 * Phases 3 to 7 of the plan (the demo path, the production path, the live
 * agent path, INSTALL.md and the outputs) are deliberately not here yet. An
 * unimplemented stage is absent from the declaration rather than present and
 * skipped, because a skip is a colour and this rig does not have a colour for
 * "we did not look".
 */
import baseAttestation from "./00-base-attestation.mjs";
import sourceEntry from "./01-source-entry.mjs";
import toolchain from "./02-toolchain.mjs";
import documentedChecks from "./03-documented-checks.mjs";
import nodeTwentyFloor from "./04-node20-floor.mjs";

export const STAGES = [baseAttestation, sourceEntry, toolchain, documentedChecks, nodeTwentyFloor];
