import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { Stats } from '../types'

// statusline.sh's code_globs: source files only, no docs, config or lockfiles.
const CODE_GLOBS = [
  '*.sh', '*.bash', '*.zsh', '*.py', '*.rb', '*.js', '*.mjs', '*.cjs', '*.jsx', '*.ts', '*.mts', '*.cts', '*.tsx',
  '*.go', '*.rs', '*.java', '*.kt', '*.kts', '*.c', '*.h', '*.cpp', '*.cc', '*.cxx', '*.hpp', '*.hh', '*.cs',
  '*.php', '*.swift', '*.m', '*.mm', '*.scala', '*.clj', '*.cljs', '*.ex', '*.exs', '*.erl', '*.hrl', '*.hs',
  '*.lua', '*.pl', '*.pm', '*.r', '*.sql', '*.html', '*.htm', '*.css', '*.scss', '*.sass', '*.less', '*.vue', '*.svelte',
]

// Counts lines of the code files under "$1". In a repo it uses git ls-files,
// which respects .gitignore; otherwise it walks the tree, pruning vendor/build dirs.
const COUNT_SCRIPT = String.raw`
dir="$1"; shift
if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  cd "$dir" && git ls-files -z --cached --others --exclude-standard -- "$@" 2>/dev/null | xargs -0 cat -- 2>/dev/null | wc -l
else
  i=0
  for g in "$@"; do
    [ $i -eq 0 ] && set --
    [ $i -gt 0 ] && set -- "$@" -o
    set -- "$@" -iname "$g"
    i=$((i + 1))
  done
  find "$dir" -type d \( -name node_modules -o -name .git -o -name dist -o -name build -o -name vendor \
      -o -name .venv -o -name venv -o -name __pycache__ -o -name target -o -name .next -o -name .nuxt \
      -o -name out -o -name coverage -o -name .cache \) -prune -o -type f \( "$@" \) -print0 \
    | xargs -0 cat -- 2>/dev/null | wc -l
fi
`

const CODE_LINES_TTL_MS = 30 * 1000
let lastCount: { cwd: string; at: number; total: number } | undefined

/** `$.process.run`, handed in as a plain function. */
export type Run = (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>

const int = (s: string | undefined) => {
  const n = s === undefined ? NaN : parseInt(s, 10)
  return Number.isFinite(n) ? n : undefined
}

const countCodeLines = async (run: Run, cwd: string, now: number) => {
  if (lastCount && lastCount.cwd === cwd && now - lastCount.at < CODE_LINES_TTL_MS) return lastCount.total
  const r = await run(['sh', '-c', COUNT_SCRIPT, 'count', cwd, ...CODE_GLOBS], { timeoutMs: 20000 })
  const total = int(r.stdout.trim())
  if (total !== undefined) lastCount = { cwd, at: now, total }
  return total
}

/** The status line's git, commit and line figures, for the pane's project section. */
export const collectStats = async (run: Run, cwd: string, now: number): Promise<Stats> => {
  const git = async (args: string[]) => {
    const r = await run(['git', '-C', cwd, ...args], { timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() : undefined
  }
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const codeLines = await countCodeLines(run, cwd, now)
  const out: Stats = { isRepo: branch !== undefined, added: 0, removed: 0, ...(codeLines !== undefined && { codeLines }) }
  if (branch === undefined) return out
  out.branch = branch

  const hasUpstream = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])) !== undefined
  if (hasUpstream) {
    const [behind, ahead] = ((await git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])) ?? '')
      .split(/\s+/)
      .map(s => int(s))
    if (ahead !== undefined) out.ahead = ahead
    if (behind !== undefined) out.behind = behind
    const pushed = int(await git(['rev-list', '--count', '@{upstream}']))
    const unpushed = int(await git(['rev-list', '--count', '@{upstream}..HEAD']))
    if (pushed !== undefined) out.pushed = pushed
    if (unpushed !== undefined) out.unpushed = unpushed
  } else {
    const commits = int(await git(['rev-list', '--count', 'HEAD']))
    if (commits !== undefined) out.commits = commits
  }

  // Uncommitted changes, the stand-in for the old per-session +/- line figure.
  for (const line of ((await git(['diff', '--numstat', 'HEAD'])) ?? '').split('\n')) {
    const [a, r] = line.split('\t')
    out.added += int(a) ?? 0
    out.removed += int(r) ?? 0
  }
  return out
}
