# claude-usage-bar

Home of **Mission Control**, a Claude Code mod that docks a live dashboard
beside the chat, plus `statusline.sh`, the older status-line script it
replaces.

- [Mission Control](#mission-control)
  - [Features](#features)
  - [Install](#install)
  - [Commands](#commands)
  - [Development](#development)
- [Legacy status line](#legacy-status-line-statuslinesh)

## Mission Control

The conversation sits on the left and the dashboard on the right. The docked
pane needs the fullscreen layout and at least 110 columns; in a narrower
terminal a compact version (status, total bar, running agents) appears above
the prompt instead.

### Features

- **CLAUDE banner.** Big block letters with a band of light sweeping across
  them from left to right: gray with a white shine when idle, Claude's color
  with a lighter shimmer while work runs, dimmed and asleep while waiting for
  a rate limit to reset. Below it, a status line such as
  `agents at work · 2 agents · 1 queued`.
- **Forecast-driven progress.** Before starting, Claude (and every subagent)
  forecasts its work as checkpoints with time estimates using the mod's
  `progress_plan` tool, then reports each one with `progress_checkpoint`.
  Between checkpoints the bar creeps forward with the estimate (never past
  90% of the segment) and jumps when the checkpoint lands. It shows the
  current checkpoint and the time left, and only ever grows.
- **Agent rows.** The main thread first, then one row per subagent, each with
  its own forecast bar (or its owned tasks when it made no forecast) and a
  plain-English line for what it is doing right now, such as
  `↳ Searching for “foo”`, `↳ Running tests` or `↳ Editing auth.ts`.
- **Live task list.** ✔ done, ◐ in progress, ○ pending, with each task's
  owning agent.
- **Rate limits.** 5-hour and 7-day bars with reset times. Readings are
  synced across every open session, using the same newest-reading-wins rule
  as the status line, so an idle chat still shows current usage.
- **Git stats.** Branch, ahead/behind, pushed/unpushed commits, uncommitted
  +/− lines and total lines of code.
- **Auto-resume after rate limits.** When a turn dies with a rate-limit window
  at 100%, the mod queues the work and sends a resume prompt once the limit
  resets (the terminal must stay open). Typing anything cancels the queued
  resume, and so does the **Cancel auto-resume** button.
- **Queued-message reorganising.** If you queue 3 or more messages while
  Claude is working, it is told to pause at a safe point, fold the remaining
  work and every queued request into the task list, and spin up agents for
  the parts that can run in parallel.

Every chat also gets a system-prompt section telling Claude to forecast its
work, keep a task list for anything that takes more than one step, and spawn
named parallel agents for big changes (3+ files, several areas, or 4+ steps).

### Install

The repo root is a plugin marketplace (`.claude-plugin/marketplace.json`).
Add it from GitHub, then install the plugin:

```
/plugin marketplace add anay-schottlabs/claude-usage-bar
/plugin install mission-control@claude-usage-bar
```

### Commands

| Command | What it does |
| --- | --- |
| `/mission` | Opens the dashboard. |
| `/mission test-resume <secs>` | Simulates a rate-limit stop that auto-resumes in `<secs>` seconds. |
| `/mission cancel-resume` | Cancels a queued auto-resume. |

### Development

```
mission-control/
  hooks/
    register.tsx         entry point: wires controllers, tools, /mission, the pane and the tick timer
    tracker.ts           mirrors tasks, subagents, turns and queued prompts into state
    activity.ts          turns a tool call into a phrase like "Running tests"
    progress.ts          progress_plan / progress_checkpoint tools and plan arithmetic
    limits.ts            rate-limit sync across sessions and auto-resume
    stats.ts             git and lines-of-code figures
    instructions.ts      system-prompt section, resume prompt, queued-message nudge
    pane.tsx             the dashboard renderer (docked and inline layouts)
    avatar.ts            CLAUDE banner, shine animation and spinner glyph
    format.ts            pure text and number helpers
    state.ts, controllers.ts   shared names and long-lived controllers
    *.test.ts(x)         tests
  types/index.d.ts       state shapes
```

Check and test the plugin from the repo root:

```
claude plugin validate mission-control
claude plugin test mission-control
```

## Legacy status line (`statusline.sh`)

A Claude Code status line showing rate-limit usage and project stats.
Mission Control now shows all of this, so the script is kept only as a
fallback.

Claude Code pipes a JSON payload to the configured `statusLine` command on
every render, including `rate_limits.five_hour` / `seven_day`
`used_percentage` and `resets_at` for Pro/Max subscribers. The script renders
colored bars with reset times, then a line of git and code stats:

```
5h [████████░░░░…] 40% · resets 3:45 PM (2h30m)  │  7d [██████░░░░…] 12% · resets Thu Nov 12, 9:00 PM (1d 2h)
main ↑2 ↓0  │  17 pushed, 3 unpushed  │  +12 -4 lines  │  1,924 lines of code
```

- 5h is green under 50% used, yellow 50–79%; 7d is cyan, then magenta. Both
  turn red at 80%.
- Before any rate-limit data is available (start of a session, or
  non-subscriber accounts) a window shows `[········] n/a`.
- The latest reading for each window is cached in
  `~/.claude/claude-usage-bar-cache.json`, shared by every session. Each render
  keeps whichever reading is newest (a later window wins; within the same
  window the higher percentage wins), so all open chats stay in sync, and a
  reopened chat shows the cached value until its first live reading, as long
  as that window hasn't reset.
- The lines-of-code count is cached for 30 seconds per directory in
  `~/.claude/claude-usage-bar-linecount-cache.json`.
- Requires `jq` and `git`.

### Setup

Point `statusLine` in `~/.claude/settings.json` at the script. A
`refreshInterval` re-runs it every 5 seconds so idle chats pick up usage from
active ones:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/path/to/claude-usage-bar/statusline.sh",
    "refreshInterval": 5
  }
}
```

This applies to every Claude Code session on the machine.
