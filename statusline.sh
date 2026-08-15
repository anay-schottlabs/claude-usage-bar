#!/usr/bin/env bash
# Claude Code statusline: shows 5-hour and 7-day rate-limit usage as progress bars.
# Reads the statusline JSON payload from stdin (see `claude` docs: statusline.md).

set -euo pipefail

input="$(cat)"

bar_width=40
reset='\033[0m'

# Build a filled/empty block bar string of the given width for a percentage.
render_bar() {
  local pct_int="$1" width="$2"
  local filled=$(( pct_int * width / 100 ))
  local empty=$(( width - filled ))
  local bar
  bar="$(printf '%*s' "$filled" '' | tr ' ' '█')"
  bar+="$(printf '%*s' "$empty" '' | tr ' ' '░')"
  printf '%s' "$bar"
}

# "3:45 PM (2h30m)" (or, with include_date=1, "Thu Jan 30, 3:45 PM (4d15h)")
# style exact-time-plus-countdown string for an epoch seconds value.
format_reset() {
  local resets_at="$1" include_date="${2:-0}" now remaining time_str dur_str h m d

  now="$(date +%s)"
  remaining=$(( resets_at - now ))
  [ "$remaining" -lt 0 ] && remaining=0

  if [ "$include_date" = "1" ]; then
    time_str="$(date -r "$resets_at" '+%a %b %e, %l:%M %p' 2>/dev/null | tr -s ' ')"
  else
    time_str="$(date -r "$resets_at" '+%l:%M %p' 2>/dev/null | sed 's/^ //')"
  fi

  if [ "$remaining" -ge 86400 ]; then
    d=$(( remaining / 86400 ))
    h=$(( (remaining % 86400) / 3600 ))
    dur_str="${d}d ${h}h"
  else
    h=$(( remaining / 3600 ))
    m=$(( (remaining % 3600) / 60 ))
    dur_str="${h}h${m}m"
  fi

  printf '%s (%s)' "$time_str" "$dur_str"
}

# label, jq path, bar width, low color, mid color, include_date -- high color is always red.
render_section() {
  local label="$1" pct_path="$2" resets_path="$3" low_color="$4" mid_color="$5" include_date="${6:-0}"
  local pct resets_at pct_int bar color reset_str

  pct="$(jq -r "$pct_path // empty" <<<"$input")"
  resets_at="$(jq -r "$resets_path // empty" <<<"$input")"

  if [ -z "$pct" ]; then
    local dots
    dots="$(printf '%*s' "$bar_width" '' | tr ' ' '·')"
    printf '%s [%s] n/a' "$label" "$dots"
    return
  fi

  pct_int="$(awk -v p="$pct" 'BEGIN { printf "%d", (p + 0.5) }')"
  [ "$pct_int" -gt 100 ] && pct_int=100
  [ "$pct_int" -lt 0 ] && pct_int=0

  if [ "$pct_int" -ge 80 ]; then
    color='\033[31m' # red
  elif [ "$pct_int" -ge 50 ]; then
    color="$mid_color"
  else
    color="$low_color"
  fi

  bar="$(render_bar "$pct_int" "$bar_width")"

  reset_str=""
  if [ -n "$resets_at" ]; then
    reset_str=" · resets $(format_reset "$resets_at" "$include_date")"
  fi

  printf "%s [${color}%s${reset}] %d%%%s" "$label" "$bar" "$pct_int" "$reset_str"
}

# "+123 -45 lines" from this session's cumulative edits (green/red, 0 omitted if both are 0).
render_lines_changed() {
  local added removed
  added="$(jq -r '.cost.total_lines_added // 0' <<<"$input")"
  removed="$(jq -r '.cost.total_lines_removed // 0' <<<"$input")"

  if [ "$added" -eq 0 ] && [ "$removed" -eq 0 ]; then
    printf 'lines ±0'
    return
  fi

  printf "\033[32m+%s\033[0m \033[31m-%s\033[0m lines" "$added" "$removed"
}

# "main ✓ clean ↑2↓0" / "main ●3 ↑0↓1" style branch + dirty + ahead/behind summary.
render_git_status() {
  local cwd branch dirty_count ahead behind status_str

  cwd="$(jq -r '.cwd // empty' <<<"$input")"
  [ -z "$cwd" ] && cwd="."

  branch="$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)" || { printf 'no git repo'; return; }

  dirty_count="$(git -C "$cwd" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$dirty_count" -eq 0 ]; then
    status_str="\033[32m✓ clean${reset}"
  else
    status_str="\033[33m●${dirty_count}${reset}"
  fi

  read -r behind ahead <<<"$(git -C "$cwd" rev-list --left-right --count '@{upstream}...HEAD' 2>/dev/null)" || true
  local sync_str=""
  if [ -n "$ahead" ]; then
    sync_str=" ↑${ahead} ↓${behind}"
  fi

  printf '%s %b%s' "$branch" "$status_str" "$sync_str"
}

# Total commit count on the current branch.
render_commit_count() {
  local cwd count
  cwd="$(jq -r '.cwd // empty' <<<"$input")"
  [ -z "$cwd" ] && cwd="."

  count="$(git -C "$cwd" rev-list --count HEAD 2>/dev/null)" || { printf ''; return; }
  printf '%s commits' "$count"
}

five_hour="$(render_section "5h" '.rate_limits.five_hour.used_percentage' '.rate_limits.five_hour.resets_at' '\033[32m' '\033[33m')"
seven_day="$(render_section "7d" '.rate_limits.seven_day.used_percentage' '.rate_limits.seven_day.resets_at' '\033[36m' '\033[35m' 1)"
lines_changed="$(render_lines_changed)"
git_status="$(render_git_status)"
commit_count="$(render_commit_count)"

stats_line="$git_status"
[ -n "$commit_count" ] && stats_line="$stats_line  │  $commit_count"
stats_line="$stats_line  │  $(printf '%b' "$lines_changed")"

printf "\n%s  │  %s\n%b\n\n" "$five_hour" "$seven_day" "$stats_line"
