#!/usr/bin/env bash
# Claude Code statusline: shows 5-hour and 7-day rate-limit usage as progress bars.
# Reads the statusline JSON payload from stdin (see `claude` docs: statusline.md).

set -euo pipefail

input="$(cat)"

bar_width=40
reset='\033[0m'
cache_file="$HOME/.claude/claude-usage-bar-cache.json"
line_count_cache="$HOME/.claude/claude-usage-bar-linecount-cache.json"

# Last-known used_percentage/resets_at for a rate-limit window ("five_hour" or
# "seven_day"), read from the on-disk cache. Empty if no cache or field missing.
read_cache_field() {
  local key="$1" field="$2"
  [ -f "$cache_file" ] || return 0
  jq -r --arg k "$key" --arg f "$field" '.[$k][$f] // empty' "$cache_file" 2>/dev/null || true
}

# Persist the latest live reading for a rate-limit window, preserving the
# other window's cached entry. Best-effort: failures here never break the bar.
write_cache_field() {
  local key="$1" pct="$2" resets_at="$3" tmp
  tmp="$(mktemp "${cache_file}.XXXXXX" 2>/dev/null)" || return 0
  if [ -f "$cache_file" ]; then
    jq --arg k "$key" --argjson pct "$pct" --argjson resets "$resets_at" \
      '.[$k] = {used_percentage: $pct, resets_at: $resets}' "$cache_file" >"$tmp" 2>/dev/null
  else
    jq -n --arg k "$key" --argjson pct "$pct" --argjson resets "$resets_at" \
      '{($k): {used_percentage: $pct, resets_at: $resets}}' >"$tmp" 2>/dev/null
  fi
  mv "$tmp" "$cache_file" 2>/dev/null || rm -f "$tmp"
}

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

# label, jq path, bar width, low color, mid color, cache key, include_date -- high color is always red.
render_section() {
  local label="$1" pct_path="$2" resets_path="$3" low_color="$4" mid_color="$5" cache_key="$6" include_date="${7:-0}"
  local pct resets_at pct_int bar color reset_str

  pct="$(jq -r "$pct_path // empty" <<<"$input")"
  resets_at="$(jq -r "$resets_path // empty" <<<"$input")"

  # A live window with no percentage reported yet (e.g. genuinely 0% used) --
  # treat as 0 rather than falling through to n/a.
  if [ -z "$pct" ] && [ -n "$resets_at" ]; then
    pct=0
  fi

  if [ -n "$pct" ] && [ -n "$resets_at" ]; then
    write_cache_field "$cache_key" "$pct" "$resets_at"
  fi

  # No live reading yet this session (e.g. right after reopening a chat, before
  # the first response) -- fall back to the last-known value if its window
  # hasn't rolled over yet.
  if [ -z "$pct" ]; then
    local cached_resets
    cached_resets="$(read_cache_field "$cache_key" "resets_at")"
    if [ -n "$cached_resets" ] && [ "$cached_resets" -gt "$(date +%s)" ]; then
      pct="$(read_cache_field "$cache_key" "used_percentage")"
      resets_at="$cached_resets"
    fi
  fi

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

# "main ↑2 ↓0" style branch + ahead/behind summary.
render_git_status() {
  local cwd branch ahead behind sync_str

  cwd="$(jq -r '.cwd // empty' <<<"$input")"
  [ -z "$cwd" ] && cwd="."

  branch="$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)" || { printf 'no git repo'; return; }

  read -r behind ahead <<<"$(git -C "$cwd" rev-list --left-right --count '@{upstream}...HEAD' 2>/dev/null)" || true
  sync_str=""
  if [ -n "$ahead" ]; then
    sync_str=" ↑${ahead} ↓${behind}"
  fi

  printf '%s%s' "$branch" "$sync_str"
}

# "142 pushed, 3 unpushed" (against the tracked upstream) or, with no
# upstream configured, "142 commits (no upstream)".
render_commit_stats() {
  local cwd pushed unpushed total
  cwd="$(jq -r '.cwd // empty' <<<"$input")"
  [ -z "$cwd" ] && cwd="."

  git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { printf ''; return; }

  if git -C "$cwd" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
    pushed="$(git -C "$cwd" rev-list --count '@{upstream}' 2>/dev/null)" || pushed=0
    unpushed="$(git -C "$cwd" rev-list --count '@{upstream}..HEAD' 2>/dev/null)" || unpushed=0
    printf '%s pushed, %s unpushed' "$pushed" "$unpushed"
  else
    total="$(git -C "$cwd" rev-list --count HEAD 2>/dev/null)" || total=0
    printf '%s commits (no upstream)' "$total"
  fi
}

# Source-file extensions counted as "code" — excludes docs, config/data,
# lockfiles, and binary/vendored assets.
code_globs=(
  '*.sh' '*.bash' '*.zsh' '*.py' '*.rb' '*.js' '*.mjs' '*.cjs' '*.jsx' '*.ts' '*.mts' '*.cts' '*.tsx'
  '*.go' '*.rs' '*.java' '*.kt' '*.kts' '*.c' '*.h' '*.cpp' '*.cc' '*.cxx' '*.hpp' '*.hh' '*.cs'
  '*.php' '*.swift' '*.m' '*.mm' '*.scala' '*.clj' '*.cljs' '*.ex' '*.exs' '*.erl' '*.hrl' '*.hs'
  '*.lua' '*.pl' '*.pm' '*.r' '*.sql' '*.html' '*.htm' '*.css' '*.scss' '*.sass' '*.less' '*.vue' '*.svelte'
)

# Line count across code files under $1, restricted to code_globs. Uses
# `git ls-files` (respects .gitignore, so node_modules/build/vendor stay
# excluded) when inside a repo; otherwise walks the tree directly, pruning
# the usual vendor/build directories.
count_code_lines() {
  local dir="$1" files
  if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    files="$(git -C "$dir" ls-files --cached --others --exclude-standard -- "${code_globs[@]}" 2>/dev/null)"
    (cd "$dir" && printf '%s' "$files" | xargs cat -- 2>/dev/null) | wc -l | tr -d ' '
  else
    local find_expr=()
    for g in "${code_globs[@]}"; do
      find_expr+=(-iname "$g" -o)
    done
    unset 'find_expr[${#find_expr[@]}-1]'
    find "$dir" -type d \( -name node_modules -o -name .git -o -name dist -o -name build \
        -o -name vendor -o -name .venv -o -name venv -o -name __pycache__ -o -name target \
        -o -name .next -o -name .nuxt -o -name out -o -name coverage -o -name .cache \) -prune -o \
      -type f \( "${find_expr[@]}" \) -exec cat {} + 2>/dev/null | wc -l | tr -d ' '
  fi
}

# Total line count of code files under cwd, for the whole codebase regardless
# of subfolder depth. Cached for 30s per directory since a full recursive
# scan is too slow to run on every refresh.
render_total_lines() {
  local cwd now cached_cwd cached_total cached_time total tmp formatted
  cwd="$(jq -r '.cwd // empty' <<<"$input")"
  [ -z "$cwd" ] && cwd="."
  [ -d "$cwd" ] || { printf ''; return; }

  now="$(date +%s)"
  total=""

  if [ -f "$line_count_cache" ]; then
    read -r cached_cwd cached_total cached_time <<<"$(jq -r '[.cwd, .total, .computed_at] | @tsv' "$line_count_cache" 2>/dev/null)" || true
    if [ "$cached_cwd" = "$cwd" ] && [ -n "$cached_time" ] && [ $(( now - cached_time )) -lt 30 ]; then
      total="$cached_total"
    fi
  fi

  if [ -z "$total" ]; then
    total="$(count_code_lines "$cwd")" || total=0
    tmp="$(mktemp "${line_count_cache}.XXXXXX" 2>/dev/null)" && {
      jq -n --arg cwd "$cwd" --argjson total "$total" --argjson t "$now" \
        '{cwd: $cwd, total: $total, computed_at: $t}' >"$tmp" 2>/dev/null
      mv "$tmp" "$line_count_cache" 2>/dev/null || rm -f "$tmp"
    }
  fi

  formatted="$(printf '%s' "$total" | rev | sed 's/[0-9]\{3\}/&,/g;s/,$//' | rev)"
  printf '%s lines of code' "$formatted"
}

five_hour="$(render_section "5h" '.rate_limits.five_hour.used_percentage' '.rate_limits.five_hour.resets_at' '\033[32m' '\033[33m' 'five_hour')"
seven_day="$(render_section "7d" '.rate_limits.seven_day.used_percentage' '.rate_limits.seven_day.resets_at' '\033[36m' '\033[35m' 'seven_day' 1)"
lines_changed="$(render_lines_changed)"
git_status="$(render_git_status)"
commit_stats="$(render_commit_stats)"
total_lines="$(render_total_lines)"

stats_line="$git_status"
[ -n "$commit_stats" ] && stats_line="$stats_line  │  $commit_stats"
stats_line="$stats_line  │  $(printf '%b' "$lines_changed")"
[ -n "$total_lines" ] && stats_line="$stats_line  │  $total_lines"

# A plain blank line here gets trimmed away by Claude Code before it renders
# the statusline, so use an invisible (but non-whitespace) character to force
# a visually-blank row that survives trailing-whitespace trimming.
zwsp=$'​'
printf "\n%s  │  %s\n%b\n%s\n" "$five_hour" "$seven_day" "$stats_line" "$zwsp"
