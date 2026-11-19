# Adding an agent

This is for when [INSTALL.md](../INSTALL.md) is finished, you have an agent
running, and you want a second one. It takes about ten minutes. Every step
below was run on a clean machine and the output shown is what came back.

The examples use `quill`, an agent that drafts a weekly summary. Use your own
name wherever you see it.

New install with no agents yet? Run `packages/base/bin/first-run.sh` instead
([INSTALL.md](../INSTALL.md), "Name your assistant"): it creates an assistant
and a platform agent in one go. This guide is for adding more afterwards. The
platform agent can also do it for you, since its brief carries the path to
`create-agent.sh`: it checks a name with `create-agent.sh --status <name>`
(`absent`, `incomplete` or `complete`), creates only an absent one, and reports
an `incomplete` one for you to remove by hand (see "Removing an agent" below).

## What you are making

An agent lives in two places, and they have to agree:

- **Persona files** in `$AGENTS_HOME/quill/`: who the agent is. Its launcher
  reads these.
- **An inbox** in `$INBOX_ROOT/quill/inbox/`: where messages to and from it
  are kept. Deck reads these.

One command makes both. If you did the install with the usual settings,
`AGENTS_HOME` is `/home/you/agents` and `INBOX_ROOT` is `/home/you/deck/inbox`.
Use the same two values you used for your first agent. If you open a new
terminal, set them again.

## 1. Create it

```text
export AGENTS_HOME=$HOME/agents
export INBOX_ROOT=$HOME/deck/inbox
packages/base/bin/create-agent.sh quill --role "drafts the weekly summary" --model claude-sonnet-5-5
```

Choose the model on purpose. Without `--model` the agent uses your model
tool's default, which may cost more than you expect, and always-on agents add
up. You can change it later by editing `$AGENTS_HOME/quill/.model`.

The script prints where everything went, then proves the persona reached the
model by asking it for a phrase that exists only in its own identity file:

```text
create-agent: CREATED quill
  persona files  /home/you/agents/quill
  inbox          /home/you/deck/inbox/quill/inbox
  ...
create-agent: VERIFIED quill
```

`VERIFIED` is the only result that means it worked end to end. Exit codes:
`0` verified, `1` could not create it, `3` the model did not return the
phrase, `4` created but nothing to check with (no model tool installed).

### Naming rules

A name is lowercase letters, digits and hyphens, starting with a letter or
digit. It becomes a folder name, a tmux window name and a message address, so
it has to survive all three. `Quill`, `quill_2` and `my agent` are refused, and
the message suggests a fix (`Try "bad-name"`). A name that already exists is
also refused, and nothing is changed.

### Choosing a runtime

`quill` above runs on Claude Code, the default. To run an agent on Codex or
Antigravity instead, add `--runtime`:

```text
packages/base/bin/create-agent.sh quill --role "drafts the weekly summary" --runtime codex
packages/base/bin/create-agent.sh quill --role "drafts the weekly summary" --runtime agy
```

Everything else in this guide is the same. The differences:

| | Claude Code | Codex | Antigravity (`agy`) |
| --- | --- | --- | --- |
| Persona file it reads | `CLAUDE.md`, which imports the others | `AGENTS.md`, plus a start-up hook in `.codex/hooks.json` that injects the persona files | `GEMINI.md`, with the persona files copied in |
| After you edit `SOUL.md` | read on the next start | injected on the next start | copied in on the next start by the launcher |
| `create-agent.sh` result | `VERIFIED` when the model quotes the phrase | `CANNOT VERIFY` (4) after local checks pass | `CANNOT VERIFY` (4) after local checks pass |
| Ask the model too | always | add `--live-probe` | add `--live-probe` |
| First message on day one | yes | no: say hello to it yourself | no: say hello to it yourself |

Codex creation refuses an existing `.codex/hooks.json` or a symlinked `.codex`
directory and leaves it untouched. The local check validates the hooks JSON
and both scaffolded commands without executing them. The Antigravity check
refreshes the real `GEMINI.md` and looks for its boot phrase. Neither calls a
model. To prove the phrase reached the model, run
`packages/base/bin/create-agent.sh --verify-only quill --live-probe`, which
uses one turn of your plan or API credit. For Codex, start the agent once
first (step 3) and approve its hooks when Codex asks, because Codex does not
run a folder's hooks until you do; until then it reads only `AGENTS.md`.

## 2. See it in Deck

Reload Deck. The agent is there, and nothing needs restarting: Deck's agent
list is the set of folders under `INBOX_ROOT`.

If it is missing, check `MC_INBOX_AGENT_ALLOWLIST` in `packages/deck/.env`
(or your environment). When that is set, it is a comma-separated list of the
only agents Deck will show. Add `quill` to it and restart Deck. Leave it
unset to show every agent.

## 3. Start it

```text
packages/base/bin/boot-agents.sh
```

This starts the agents that are not running and leaves the others alone, so
it is safe to run again. Each agent gets a window in a tmux session called
`agents`. Check with:

```text
tmux list-windows -t agents -F '#{window_name}'
```

The first time an agent starts, the launcher gives it a first message: do your
day-one steps, then say hello. It fills in `IDENTITY.md` and `SOUL.md` and may
ask you questions. Attach to answer them:

```text
tmux attach -t agents:quill
```

Detach again with `Ctrl-b` then `d`.

The model tool may ask setup questions the first time, such as whether you
trust the folder. **Read them and choose; do not press Enter blindly.** The
default for the trust question is No, which closes the agent.

## 4. Send it a first message

In Deck, open the agent's thread and write to it. Your message is saved as
`$INBOX_ROOT/quill/inbox/<MC_USER>.md`, where `MC_USER` is the name set in
`packages/deck/.env`. The agent answers in the same thread. We sent "please reply
with one sentence saying what you will do each Monday" and a reply arrived
within half a minute.

The agent may stop to ask permission to run its `inbox reply` command. That is
normal the first time. Attach, read the question, and choose "Yes, and don't
ask again" if you are happy for it to reply without asking.

## 5. Day one and what to expect

On its first turn the agent writes its identity and may ask you who you are
and what you want from it. Answer in plain words. You can edit `IDENTITY.md`,
`SOUL.md` and `USER.md` in `$AGENTS_HOME/quill/` at any time; they are
ordinary text files, and the agent reads them each time it starts.

## Removing an agent

There is no remove command. Stop it, then delete both places:

```text
tmux kill-window -t agents:quill
rm -rf "$AGENTS_HOME/quill" "$INBOX_ROOT/quill"
```

Deleting the inbox deletes the conversation history, so copy it somewhere
first if you want it. If you use `MC_INBOX_AGENT_ALLOWLIST`, take `quill` out
of it. Deck stops listing the agent straight away. Check that
`curl -sS http://localhost:4242/` (4242 is the default port) no longer
mentions it.

## If something goes wrong

**The name is refused.** Read the message: it says why and offers a fix. Use
lowercase letters, digits and hyphens only.

**The agent is not in Deck.** Almost always `MC_INBOX_AGENT_ALLOWLIST`, as
above. Otherwise check the folder `$INBOX_ROOT/quill/inbox` exists and that
Deck is reading the same `INBOX_ROOT`.

**The agent started and then closed, or `boot-agents.sh` exits 3.** Exit 3
means "not ready yet", often a setup question waiting for you. Attach with
`tmux attach -t agents:quill`, answer it, then run `boot-agents.sh` again. If
you pressed Enter on the trust question it chose No and the agent exited.
Run `boot-agents.sh` again and choose Yes this time.

**The agent never said hello.** The first message is sent once, and a closed
first launch can use it up. Exit the agent's tool, delete
`$AGENTS_HOME/quill/.first-boot-done`, and run `boot-agents.sh` again.

**It says `CANNOT VERIFY` (exit 4).** For a Claude Code agent, there is no
model tool on this machine. Install and sign in to it, then run
`packages/base/bin/create-agent.sh --verify-only quill`. For a Codex or
Antigravity agent, 4 is the normal result: the local checks passed and no
model was asked. Add `--live-probe` to ask one.

**A Codex agent does not know who it is.** Codex has not been told to trust
the agent's hooks yet. Attach with `tmux attach -t agents:quill`, approve the
hooks when Codex asks, then restart the agent.

For the full option list, see [packages/base/README.md](../packages/base/README.md).
