# claude-usage-bar

## Mission Control (`mission-control/`)

A Claude Code mod that docks a dashboard beside the chat, with the
conversation on the left and the dashboard on the right. This needs the
fullscreen layout and at least 110 columns. Narrower terminals show a compact
version above the prompt instead.

- **Avatar**: an animated ASCII Claude spark that shows what's happening:
  idle, working, agents at work, waiting for a limit reset, or all done.
- **Total progress**: completed tasks out of all tasks.
- **Agents**: one row per subagent with a progress bar (its owned tasks done
  out of its owned tasks, or a sliding bar if it owns none) and what it's
  doing right now (`↳ Edit auth.ts`).
- **Tasks**: the live task list (✔ done, ◐ in progress, ○ pending), with
  owners.
- **Limits**: the 5h/7d rate-limit bars with reset times. Readings are synced
  across all open sessions using the same newest-reading-wins rule as the
  status line.
- **Project**: branch, ahead/behind, pushed/unpushed, uncommitted +/− lines,
  and total lines of code.

Every chat gets a system-prompt section telling Claude to make a task list
and spawn named parallel agents for big changes (3+ files, several areas, or
4+ steps), and to just do small changes directly. When a turn dies with a
rate-limit window at 100%, the mod queues the work and sends a resume prompt
once the limit resets (the terminal must stay open). Typing anything cancels
the queued resume, and so does the **Cancel auto-resume** button.

Commands: `/mission` opens the dashboard. `/mission test-resume 30` simulates
a limit stop that resumes in 30s. `/mission cancel-resume` cancels a queued
resume.

Install from this repo's marketplace:

```
/plugin install mission-control@claude-usage-bar
```

Tests: `claude plugin test mission-control`.

## Status line (`statusline.sh`)

A persistent Claude Code statusline showing 5-hour rate-limit usage.
Mission Control now shows everything below, so this is kept only as a fallback.

Claude Code pipes a JSON payload to the configured `statusLine` command on
every render, including `rate_limits.five_hour.used_percentage` and
`resets_at` for Pro/Max subscribers. `statusline.sh` reads that payload and
renders a colored progress bar with the reset countdown, e.g.:

```
5h [██████░░░░] 62% · resets 2h15m
```

- Green under 50% used, yellow 50–79%, red 80%+.
- Falls back to `5h [··········] n/a` before the rate-limit data is
  available (start of a session, or non-subscriber accounts).
- The most recent reading for each window is cached to
  `~/.claude/claude-usage-bar-cache.json`. On reopening a chat, before the
  first live reading arrives, the bar shows that cached value dimmed with a
  `~` marker instead of going blank — as long as the cached window hasn't
  reset yet. Once it rolls over, it falls back to `n/a` until fresh data
  arrives.
- The cache is shared by every Claude Code session, so all open chats stay in
  sync: each render keeps whichever reading is newest (a later window wins;
  within the same window the higher percentage wins), and
  `refreshInterval` re-runs the script every 5s so idle chats pick up usage
  from active ones.

## Setup

Configured globally in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/Users/anaydandekar/Documents/code/claude-usage-bar/statusline.sh",
    "refreshInterval": 5
  }
}
```

This applies to every Claude Code session on this machine.
