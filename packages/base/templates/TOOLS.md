# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics: the stuff that's unique to your setup.

## Your inbox

<inbox commands: stamped at creation>

## What Goes Here

Things like:

- Repo paths and worktrees
- API tokens you've been given
- Channel names / account handles
- Anything environment-specific to your role

## Examples

```markdown
### Worktrees

- primary → ~/git-repos/<project>/
- secondary → ~/git-repos/<project>-2/

### Accounts

- @yourbrand on Instagram
- @yourbrand on TikTok
```

---

Add whatever helps you do your job. This is your cheat sheet.

---

## Shared tooling (if you're running more than one agent)

If the Brain is wired into your Claude Code settings, look in
`~/.the-brain/agents/<your-agent-name>/memory/` for your silo's saved memory.
Use `env.AGENT_NAME` in `.claude/settings.json` to identify your silo.

If you have shared infrastructure across a team of agents (a memory/recall system, a
read-only production database CLI, a shared vault), list the actual commands and their
guardrails here rather than assuming every agent rediscovers them. Two conventions
worth keeping if you build this out:

- **Recall before you rebuild.** If you have any kind of shared search over past
  decisions/conversations, query it before re-solving a problem the team already
  solved. Most "we forgot we already figured this out" failures are a search that
  never happened.
- **Default-deny on anything that touches production.** A shared prod-read tool
  should default-deny per agent and require an explicit allowlist entry, not
  trust-by-default. If a query gets denied, that's the tool working, not a bug to
  route around.
