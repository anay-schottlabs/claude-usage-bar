# claude-usage-bar

A persistent Claude Code statusline showing 5-hour rate-limit usage.

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

## Pause button (`pause-button/`)

A Claude Code mod that adds a **⏸ Pause** button above the prompt while Claude
is working. Pressing it tells Claude to stop at the earliest safe point and
reply in the chat with "Done so far" and "Still to do" summaries. The button
then becomes **▶ Continue**, which resumes from the "Still to do" list.

Install (this repo is its own plugin marketplace):

```
/plugin install pause-button --marketplace anay-schottlabs/claude-usage-bar
```

Or from a local clone: `claude plugin marketplace add <clone path>` then
`claude plugin install pause-button@claude-usage-bar --scope user`.
