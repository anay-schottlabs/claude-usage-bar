#!/usr/bin/env bash
# Claude Code statusline: shows 5-hour rate-limit usage as a progress bar.
# Reads the statusline JSON payload from stdin (see `claude` docs: statusline.md).

set -euo pipefail

input="$(cat)"

pct="$(jq -r '.rate_limits.five_hour.used_percentage // empty' <<<"$input")"
resets_at="$(jq -r '.rate_limits.five_hour.resets_at // empty' <<<"$input")"

bar_width=40

if [ -z "$pct" ]; then
  dots="$(printf '%*s' "$bar_width" '' | tr ' ' '·')"
  printf '\n5h [%s] n/a\n' "$dots"
  exit 0
fi

# Round to nearest integer.
pct_int="$(awk -v p="$pct" 'BEGIN { printf "%d", (p + 0.5) }')"
[ "$pct_int" -gt 100 ] && pct_int=100
[ "$pct_int" -lt 0 ] && pct_int=0

filled="$(( pct_int * bar_width / 100 ))"
empty="$(( bar_width - filled ))"

bar="$(printf '%*s' "$filled" '' | tr ' ' '█')"
bar+="$(printf '%*s' "$empty" '' | tr ' ' '░')"

# Color thresholds: green < 50%, yellow 50-79%, red >= 80%.
reset='\033[0m'
if [ "$pct_int" -ge 80 ]; then
  color='\033[31m' # red
elif [ "$pct_int" -ge 50 ]; then
  color='\033[33m' # yellow
else
  color='\033[32m' # green
fi

reset_str=""
if [ -n "$resets_at" ]; then
  now="$(date +%s)"
  remaining=$(( resets_at - now ))
  if [ "$remaining" -gt 0 ]; then
    h=$(( remaining / 3600 ))
    m=$(( (remaining % 3600) / 60 ))
    reset_str=" · resets ${h}h${m}m"
  fi
fi

printf "\n5h [${color}%s${reset}] %d%%%s\n" "$bar" "$pct_int" "$reset_str"
