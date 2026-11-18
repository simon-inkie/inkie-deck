/**
 * The INSTALL.md runs, declared as data.
 *
 * Same discipline as the stage list: the runs are written down before
 * anything executes, the block ids are asserted against the document rather
 * than discovered from it, and an executable block that no run claims fails
 * the rig. A harness that simply "ran the blocks it found" would report a
 * green run over a document whose examples had quietly stopped being executed.
 *
 * Three runs rather than one, for a reason that is a property of the product
 * and not of the harness: the dev sandbox and the production launcher both
 * want port 4242, and the loopback default and the published bind are
 * mutually exclusive states of one file. Each run is a fresh container from a
 * provably bare image, and between them they execute every executable block in
 * the document.
 */

/** The document under test, relative to the repository root. */
export const INSTALL_DOC = "INSTALL.md";

/** Fence languages this plan executes. Everything else must be listed below. */
export const EXECUTABLE_LANGS = ["sh"];

/**
 * Fence languages the document is allowed to contain at all.
 *
 * `text` is recorded output and `zsh` is the macOS path, which a Linux
 * container cannot run and which the document therefore marks as unverified.
 * `sh-manual` is the "Keep it running" section: a container has no systemd
 * user manager, and a detached second Deck would collide with the one the run
 * already started. The document says those blocks are not executed.
 * `powershell` is the Windows side of the WSL section: a Linux container
 * cannot run it, and the document says so.
 * A language outside this list fails the shape stage: unhandled, it would be
 * neither executed nor accounted for.
 */
export const KNOWN_LANGS = ["sh", "text", "zsh", "sh-manual", "powershell"];

const PREREQUISITES = ["1-prerequisites/sh#1", "1-prerequisites/sh#2", "1-prerequisites/sh#3"];
const DEPENDENCIES = ["2-install-the-dependencies/sh#1", "2-install-the-dependencies/sh#2"];
const TRY_IT = ["3-try-it/sh#1", "3-try-it/sh#2"];
const CONFIGURE = [
  "4-run-it-for-real/sh#1",
  "4-run-it-for-real/sh#2",
  "who-deck-thinks-you-are/sh#1",
];
const PUBLISH_BIND = ["reaching-it-from-another-machine/sh#1"];
const BUILD_AND_START = ["build-and-start/sh#1", "build-and-start/sh#2", "build-and-start/sh#3"];
const AGENTS = [
  "create-an-agent/sh#1",
  "start-the-sessions/sh#1",
  "start-the-sessions/sh#2",
  "start-the-sessions/sh#3",
  "send-a-message-and-answer-it-as-the-agent/sh#1",
  "send-a-message-and-answer-it-as-the-agent/sh#2",
  "send-a-message-and-answer-it-as-the-agent/sh#3",
];

/**
 * Quick setup's unattended block, the only one of its section that can run in a
 * container (the other needs a terminal). It runs as an ordinary user: setup
 * refuses root, and the document says to run it as your own user.
 */
const QUICK_SETUP = ["quick-setup/sh#2"];

export const RUNS = {
  /** Tier 1. The dev sandbox, from a machine with no toolchain at all. */
  "try-it": [...PREREQUISITES, ...DEPENDENCIES, ...TRY_IT],
  /**
   * Tier 2 as the document's default leaves it: bound to loopback.
   *
   * This run exists to be UNREACHABLE from outside the container. That is the
   * negative control for the run below, and the only way to prove the
   * published-port probe is measuring the bind rather than reporting a colour.
   */
  "run-it-loopback": [...PREREQUISITES, ...DEPENDENCIES, ...CONFIGURE, ...BUILD_AND_START],
  /**
   * The same, plus the document's optional publish block and nothing else.
   *
   * One variable between this run and the one above, deliberately: a control
   * that differs from the thing it controls in more than one place measures
   * nothing in particular.
   */
  "run-it-reachable": [
    ...PREREQUISITES,
    ...DEPENDENCIES,
    ...CONFIGURE,
    ...PUBLISH_BIND,
    ...BUILD_AND_START,
  ],
  /**
   * Quick setup, from a bare machine: the prerequisites, then
   * `scripts/setup.sh --yes --no-key`, which on a machine with no model CLI
   * must exit 4 with Deck running and the agents not started.
   */
  "quick-setup": [...PREREQUISITES, ...QUICK_SETUP],
  /** The whole document in one container, tier 3 included. */
  "run-it-and-agents": [
    ...PREREQUISITES,
    ...DEPENDENCIES,
    ...CONFIGURE,
    ...PUBLISH_BIND,
    ...BUILD_AND_START,
    ...AGENTS,
  ],
};

/**
 * Executable blocks that are deliberately not run, each with the reason.
 *
 * A skip is declared rather than implied, so the coverage accounting still
 * sees the block: it counts as claimed, and a skip naming a block that has left
 * the document fails the rig as a stale claim.
 *
 * The clone step cannot run here. The rig copies the working tree into a
 * container that has no network credentials, so `git clone` of the real URL
 * would be testing the host's access rather than the document, and while the
 * repository is private it cannot succeed at all. Every later block runs from
 * the copied tree, which is what the clone would have produced.
 */
export const SKIPPED = {
  "1-prerequisites/sh#4": "git clone of the real URL: no credentials in the container, and the rig copies the tree in instead",
  "name-your-assistant-first-run/sh#1": "creates the default agent names inkie and doctor, which the create-an-agent block after it also creates, so the one-container run of the whole document cannot include both; first-run.sh itself is executed by the quick-setup run",
  "quick-setup/sh#1": "the interactive form: it asks for names and a key choice, and a container run has no terminal to answer; the unattended block beside it is executed",
};

/**
 * Blocks that never return, and the sentence in the document that says so.
 *
 * The runner has to know that `pnpm dev` does not exit, and that knowledge
 * lives in the runner rather than in the document, which is precisely the
 * drift this whole mechanism exists to prevent. So the declaration also names
 * the words in the document that tell a reader the same thing, and a probe
 * requires them to still be there. Reword that paragraph and the rig goes red
 * rather than quietly running on a private assumption.
 *
 * `waitSeconds` is how long the runner waits before the next block, which
 * stands in for a reader watching the server come up.
 */
export const LONG_RUNNING = {
  "3-try-it/sh#1": { waitSeconds: 45, prose: /keeps running until you stop it|Leave it/i },
  "build-and-start/sh#2": { waitSeconds: 20, prose: /keeps running too/i },
};

/**
 * Blocks whose correct outcome is a non-zero exit, and the words in the
 * document that promise it.
 *
 * `create-agent.sh` exits 4 (CANNOT VERIFY) on a machine with no model CLI,
 * because it refuses to report a persona as proven when it had nothing to ask.
 * That is the honest boundary of tier 3, so the rig asserts the exact code
 * rather than tolerating "non-zero", and asserts that the document states it.
 */
export const EXPECTED_EXITS = {
  "create-an-agent/sh#1": { code: 4, prose: /exits 4/ },
  "quick-setup/sh#2": { code: 4, prose: /that command exits 4/ },
};

/**
 * Claims the document makes that are not commands, checked as text.
 *
 * Not style policing. Each of these is a statement the rig can execute
 * something against, so if the sentence disappears the assertion downstream is
 * no longer describing the document.
 */
export const REQUIRED_CLAIMS = [
  {
    id: "no-authentication",
    title: "the document says, before any network step, that there is no authentication",
    pattern: /no login, no password, and no authentication of any kind/i,
  },
  {
    id: "tier-3-is-manual",
    title: "the document says tier 3 cannot be automated from here",
    pattern: /This tier is manual, and cannot be otherwise from here/i,
  },
  {
    id: "macos-unverified",
    title: "the document says the macOS instructions are unverified",
    pattern: /macOS instructions in this document are unverified/i,
  },
];

/** Section headings the document must still have, since the runs are keyed to them. */
export const REQUIRED_HEADINGS = ["1. Prerequisites", "3. Try it", "4. Run it for real", "5. Bring your agents to life"];
