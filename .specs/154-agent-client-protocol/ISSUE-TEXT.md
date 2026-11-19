<!-- Copy of the published body of #154 (2026-11-18). -->
## Goal

Give Deck a structured way to run supported agents and receive useful session events through Agent Client Protocol (ACP), alongside the terminal-runner migration.

## Scope and first slice

Pin the protocol version and implement one supported adapter. Negotiate capabilities, create or resume a session only when supported, submit a prompt, consume ordered events, request cancellation and report confirmed completion, cancellation or failure. Unsupported capabilities and disconnected or failed sessions must remain explicit.

Define a small shared event envelope for decisions, actions and things that happened, including session and task identity. Bubble meaningful sub-agent events into Deck without displaying a raw reasoning or tool stream. Prove capability refusal, event ordering, cancellation and disconnect handling with fixtures before live use.

## Origin and qualification

Maintainer direction, 18 November 2026; no exact original Linear issue identified in the supplied mapping. ACP is Agent Client Protocol, separate from MCP plugin interoperability. Adapter choice, event mapping and interoperability proofs remain specification work; no existing runtime is declared compatible.

