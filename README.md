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

## Setup

Configured globally in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/Users/anaydandekar/Documents/code/claude-usage-bar/statusline.sh"
  }
}
```

This applies to every Claude Code session on this machine.
