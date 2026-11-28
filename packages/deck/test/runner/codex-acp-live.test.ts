import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.env["DECK_LIVE_CODEX_ACP"] !== "1")(
  "resumes the saved Codex session through the installed ACP adapter",
  async () => {
    const { AcpRunnerRegistry } = await import("../../app/lib/runner/acp-registry.server.js");
    const root = mkdtempSync(join(tmpdir(), "deck-live-codex-"));
    const agent = "codex-resume-check";
    const home = join(root, agent);
    const registry = new AcpRunnerRegistry({
      ...process.env,
      AGENTS_HOME: root,
      MC_ACP_RUNNER: "1",
    }, { dataRoot: root, listWindows: () => [] });
    try {
      mkdirSync(home);
      writeFileSync(join(home, ".runner"), "acp\n");
      writeFileSync(join(home, ".runtime"), "codex\n");

      const initial = await registry.start(agent);
      expect(initial.authRequired).toBe(false);
      expect(initial.activeSessionId).toBeTruthy();
      const sessionId = initial.activeSessionId;
      // A completed turn gives the backend a session history to persist.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          initial.prompt("Reply with OK. Do not use tools or read files."),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("The Codex test turn timed out.")), 30_000);
          }),
        ]);
        expect(outcome).toBe("completed");
      } finally {
        clearTimeout(deadline);
      }
      await registry.stop(agent);
      expect(registry.lastSessionId(agent)).toBe(sessionId);
      expect(registry.canResume(agent)).toBe(true);

      const resumed = await registry.start(agent, { resume: true });
      expect(resumed.state.kind).toBe("idle");
      expect(resumed.activeSessionId).toBe(sessionId);
    } finally {
      try {
        await registry.stop(agent);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
  60_000,
);
