<!-- Copy of the published body of #201, "first-run hints in Deck", taken 2026-11-18. The longer design is in SPEC.md. -->
## Goal

When someone opens an agent's thread on first run, show what to do if the agent is waiting for them in its terminal. Today an empty thread says "Send the first reply below", even when the agent is stopped at a setup question.

## Proposed first slice

Show one hint on the thread page and, when relevant, next to the terminal's existing keys. Cover these states in priority order:

1. The CLI is asking whether to trust its folder.
2. The CLI is showing a sign-in menu.
3. The CLI is asking whether to use an API key it found.
4. The CLI is showing another recognised setup menu, such as a theme or resume picker.
5. A successful capture ends at a shell prompt. Explain that the agent appears to have exited, and link to its terminal so the user can check before starting it again.
6. The thread is empty and no more specific hint applies. Explain that a new agent can write first on its initial boot, while still guiding users on later empty threads. Point to the terminal when enabled.

A chat hint can link to the terminal. For recognised menus, the terminal hint can explain which existing controls to use. The user decides whether to trust the folder, sign in or use a key. Re-evaluate the hint on the existing refresh. Keep raw pane text out of the chat payload. If the pane cannot be read, keep the terminal availability message neutral and fall back to empty-thread guidance when applicable.

## Acceptance

- Fixture-backed prompts show the correct chat guidance and terminal controls. A phrase in scrollback, a login error without a menu, an idle composer or an uncertain capture does not trigger a specific prompt hint.
- The hint updates on the next successful refresh. Empty-thread guidance works when a pane cannot be detected.
- Rendering and navigation send no keys and approve no prompts. The slice adds no credential reads, CLI invocations, setup wizard or persistent onboarding flag.
- Recognise only prompt variants supported by sanitised fixture captures. A real smoke check remains pending and must confirm the prompt in the terminal before checking the matching hint.

## Open decisions

Confirm the trust wording, which agents and runs are eligible, whether and how hints can be hidden, whether the provider badge belongs elsewhere, the recovery link for the not-running state, and whether a sidebar marker is a follow-up.

## Related and origin

Maintainer direction, 18 November 2026. [#150](https://github.com/simon-inkie/inkie-deck/issues/150) and [#151](https://github.com/simon-inkie/inkie-deck/issues/151) cover starter agents and setup. [#162](https://github.com/simon-inkie/inkie-deck/issues/162) covers approval requests for agent actions. This issue covers guidance for the CLI's own setup prompts.
