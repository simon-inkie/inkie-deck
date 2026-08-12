/**
 * The hosted-capability seam.
 *
 * WHY THIS INDIRECTION EXISTS, read before suggesting its removal.
 *
 * Three optional paid hosted services will eventually plug in here:
 * backup/sync, push notification relay, and speech to text. None of them
 * exist yet, so on day one every capability resolves to `absent` and this
 * file looks like indirection with no benefit. That is the intended state,
 * not an oversight. The seam exists BEFORE the services because it enforces
 * two properties that are cheap to hold now and expensive to retrofit:
 *
 * 1. Absence is a supported state, not an error state. Every consumer of a
 *    capability must handle `absent` by degrading (feature hidden, reduced
 *    behaviour), never by throwing. If the open client breaks without the
 *    hosted service, the open-source version is crippleware and the licence
 *    story stops being true. tests/capabilities.test.ts checks this
 *    mechanically and CI runs it on every push.
 *
 * 2. No hosted endpoint URL of ours may ever be welded into a code path.
 *    A capability is configured entirely from the environment: the user
 *    points it at their own infrastructure with their own credentials, or
 *    at a hosted endpoint they chose to pay for, or at nothing. There is no
 *    default endpoint constant in this repository, and the test suite greps
 *    the source to keep it that way.
 *
 * Deleting this seam and calling services directly would pass review today
 * (nothing calls it yet) and quietly destroy both properties the first time
 * a hosted integration lands under deadline pressure. That is the suggestion
 * this comment exists to answer.
 */

/** The three planned hosted capabilities. Nothing else may be added without
 * also adding its env var pair below and an absence test. */
export type CapabilityName = "backupSync" | "pushRelay" | "speechToText";

export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  "backupSync",
  "pushRelay",
  "speechToText",
];

/**
 * One env var pair per capability. The endpoint var is what makes the
 * capability exist at all; the credential var is optional because a
 * self-hosted endpoint on a private network may not need one.
 *
 * Plain env vars, not a config file, so that the zero-config state (no vars
 * set, everything absent, client fully working) is also the default state.
 */
const ENV_VARS: Record<CapabilityName, { endpoint: string; credential: string }> = {
  backupSync: { endpoint: "DECK_BACKUP_SYNC_URL", credential: "DECK_BACKUP_SYNC_TOKEN" },
  pushRelay: { endpoint: "DECK_PUSH_RELAY_URL", credential: "DECK_PUSH_RELAY_TOKEN" },
  speechToText: { endpoint: "DECK_SPEECH_TO_TEXT_URL", credential: "DECK_SPEECH_TO_TEXT_TOKEN" },
};

/** A capability that is configured and may be called. */
export interface ConfiguredCapability {
  readonly status: "configured";
  readonly name: CapabilityName;
  /** Where the service lives. Always the user's choice, never a default. */
  readonly endpoint: string;
  /** Bearer credential for the endpoint, if one was provided. */
  readonly credential: string | null;
}

/**
 * A capability that is not configured. Deliberately not an Error and
 * deliberately impossible to call: there is no endpoint field to reach for,
 * so a consumer cannot forget to branch. `reason` is for surfacing to a
 * human ("backups are off because..."), not for control flow.
 */
export interface AbsentCapability {
  readonly status: "absent";
  readonly name: CapabilityName;
  readonly reason: string;
}

export type Capability = ConfiguredCapability | AbsentCapability;

/**
 * Resolve one capability from an environment. Pure and total: any
 * environment, including an empty one, yields a valid Capability.
 *
 * `env` is a parameter rather than a process.env read so tests and callers
 * can resolve against an explicit environment; pass process.env at the edge.
 */
export function resolveCapability(
  name: CapabilityName,
  env: Record<string, string | undefined>,
): Capability {
  const vars = ENV_VARS[name];
  const endpoint = env[vars.endpoint]?.trim();
  if (!endpoint) {
    return {
      status: "absent",
      name,
      reason: `${vars.endpoint} is not set. This is a supported state: the feature stays off and everything else works.`,
    };
  }
  const credential = env[vars.credential]?.trim();
  return {
    status: "configured",
    name,
    endpoint,
    credential: credential || null,
  };
}

/** Resolve all three capabilities at once, e.g. for a status surface. */
export function resolveCapabilities(
  env: Record<string, string | undefined>,
): Record<CapabilityName, Capability> {
  return {
    backupSync: resolveCapability("backupSync", env),
    pushRelay: resolveCapability("pushRelay", env),
    speechToText: resolveCapability("speechToText", env),
  };
}

/**
 * Run `whenConfigured` if the capability is configured, otherwise return
 * `fallback`. The helper every consumer should reach for: it makes the
 * degraded path a required argument rather than an afterthought.
 */
export function withCapability<T>(
  capability: Capability,
  whenConfigured: (capability: ConfiguredCapability) => T,
  fallback: T,
): T {
  if (capability.status === "configured") {
    return whenConfigured(capability);
  }
  return fallback;
}
