// Turns a tool call into a short, friendly, present-tense phrase for an agent's
// "currently doing" line: Read {file_path: 'src/auth.ts'} → "Reading auth.ts",
// Bash {command: 'cd x && git status'} → "Checking git status".
//
// Everything here is a pure function of (tool, input). Phrases are written for
// someone who doesn't read code: no flags, no full paths, search terms in curly
// quotes, and short enough (~48 chars) that the pane rarely has to truncate.

type Input = Record<string, unknown>

// ─── Small text helpers ──────────────────────────────────────────────────────

/** A string field of the input, or '' when missing or not a string. */
const str = (input: Input, key: string): string => {
  const v = input[key]
  return typeof v === 'string' ? v : ''
}

/** A string-or-number field (task ids arrive as either), or ''. */
const id = (input: Input, key: string): string => {
  const v = input[key]
  return typeof v === 'string' || typeof v === 'number' ? String(v) : ''
}

/** Last segment of a path: "/a/b/auth.ts" → "auth.ts", "src/" → "src". */
export const baseName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

/** Shortens free text embedded in a phrase, ending with "…" when cut. */
const clip = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : t.slice(0, Math.max(0, max - 1)) + '…'
}

/** A search term in curly quotes, clipped so the whole phrase stays short. */
const quote = (term: string, max = 28) => `“${clip(term, max)}”`

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s)

/** "search_threads" / "searchThreads" / "search-threads" → "search threads". */
const words = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()

/** Host of a URL without "www.": "https://www.example.com/x" → "example.com". */
export const hostOf = (url: string): string => {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/?#:]+)/i.exec(url) ?? /^([^/?#:\s]+)/.exec(url)
  return (m?.[1] ?? url).replace(/^www\./i, '')
}

// ─── Turning an imperative description into a present-tense phrase ──────────

// Verbs Claude Code commonly opens a Bash `description` with. Only these get
// turned into "-ing" form, so a description like "Git status" is left alone.
const VERBS = new Set(
  (
    'add apply archive build bump capture check clean clone commit compare compile confirm copy count create ' +
    'debug delete deploy diff display download export extract fetch find fix format generate get import inspect ' +
    'install kill launch link lint list load look make measure merge move open ping preview print publish pull ' +
    'push query read rebase remove rename reset restart restore revert run save scan search serve set show start ' +
    'stop sync tag take tail test trigger try type-check unpack unzip update upgrade upload validate verify view ' +
    'wait watch write'
  ).split(' '),
)

// Short verbs whose last consonant doubles before "-ing" (run → running).
const DOUBLED = new Set(['run', 'stop', 'get', 'set', 'put', 'cut', 'plan', 'scan', 'tag', 'ship', 'zip', 'unzip', 'debug', 'commit', 'drop', 'swap', 'trim', 'wrap', 'skip', 'step', 'strip', 'split', 'map', 'pin', 'log', 'rerun'])

/** "run" → "running", "write" → "writing", "check" → "checking". */
const gerund = (verb: string): string => {
  if (DOUBLED.has(verb)) return verb + verb.charAt(verb.length - 1) + 'ing'
  if (/ie$/.test(verb)) return verb.slice(0, -2) + 'ying'
  if (/[^eoy]e$/.test(verb)) return verb.slice(0, -1) + 'ing'
  return verb + 'ing'
}

/**
 * Cleans a Bash tool `description` into a phrase: first line, no trailing
 * period, and a leading imperative verb made present-tense
 * ("Run the unit tests." → "Running the unit tests"). '' when there is none.
 */
export const fromDescription = (description: string): string => {
  const line = (description.split('\n')[0] ?? '').trim().replace(/[.!:;]+$/, '')
  if (!line) return ''
  const space = line.indexOf(' ')
  const first = (space < 0 ? line : line.slice(0, space)).toLowerCase()
  if (!VERBS.has(first)) return capitalize(line)
  return capitalize(gerund(first) + (space < 0 ? '' : line.slice(space)))
}

// ─── A tiny shell parser ─────────────────────────────────────────────────────
//
// Enough of POSIX shell to find "what program is this really running": quotes
// and escapes are honoured, `$(…)` and backticks stay inside their word, and
// `&&`, `||`, `;`, `|`, `&` and newlines split the line into simple commands.
// Redirections are pulled out of the word list; an output target is kept so
// `cat > notes.md` can read as "Writing notes.md".

type Token = { kind: 'word'; text: string } | { kind: 'op'; text: string } | { kind: 'redirect'; text: string }

/** Splits a command line into words, operators and redirection markers. */
export const tokenize = (cmd: string): Token[] => {
  const out: Token[] = []
  let cur = ''
  let has = false // true once `cur` is a real word, even an empty '' one
  const flush = () => {
    if (has) out.push({ kind: 'word', text: cur })
    cur = ''
    has = false
  }
  let i = 0
  const at = (k: number) => cmd.charAt(k)

  /** Copies a balanced `$( … )` group verbatim into the current word. */
  const readSubshell = () => {
    let depth = 0
    while (i < cmd.length) {
      const c = at(i)
      cur += c
      i++
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) return
    }
  }

  while (i < cmd.length) {
    const c = at(i)
    const c2 = at(i + 1)
    if (c === '\\') {
      if (c2 !== '\n') {
        cur += c2
        has = true
      }
      i += 2
    } else if (c === "'") {
      const end = cmd.indexOf("'", i + 1)
      const stop = end < 0 ? cmd.length : end
      cur += cmd.slice(i + 1, stop)
      has = true
      i = stop + 1
    } else if (c === '"') {
      i++
      while (i < cmd.length && at(i) !== '"') {
        if (at(i) === '\\' && i + 1 < cmd.length) i++
        if (at(i) === '$' && at(i + 1) === '(') readSubshell()
        else cur += at(i++)
      }
      has = true
      i++
    } else if (c === '$' && c2 === '(') {
      readSubshell()
      has = true
    } else if (c === '`') {
      const end = cmd.indexOf('`', i + 1)
      const stop = end < 0 ? cmd.length : end
      cur += cmd.slice(i, stop + 1)
      has = true
      i = stop + 1
    } else if (c === ' ' || c === '\t' || c === '\r') {
      flush()
      i++
    } else if (c === '\n' || c === ';' || c === '(' || c === ')') {
      flush()
      out.push({ kind: 'op', text: ';' })
      i++
    } else if (c === '#' && !has) {
      while (i < cmd.length && at(i) !== '\n') i++
    } else if (c === '&' && c2 === '>') {
      flush()
      i += at(i + 2) === '>' ? 3 : 2
      out.push({ kind: 'redirect', text: '>' })
    } else if (c === '&' || c === '|') {
      flush()
      const double = c2 === c
      i += double || (c === '|' && c2 === '&') ? 2 : 1
      out.push({ kind: 'op', text: double ? c + c : c })
    } else if (c === '<' || c === '>') {
      // A bare fd number right before the arrow ("2>") belongs to the redirect.
      if (has && /^\d+$/.test(cur)) {
        cur = ''
        has = false
      }
      flush()
      let op = c
      i++
      while (/[<>&|]/.test(at(i))) op += at(i++)
      out.push({ kind: 'redirect', text: op })
    } else {
      cur += c
      has = true
      i++
    }
  }
  flush()
  return out
}

/** One simple command: its words and where its output is redirected, if anywhere. */
type Simple = { words: string[]; writesTo?: string }

/** Groups tokens into simple commands, dropping redirections from the words. */
export const splitCommands = (cmd: string): Simple[] => {
  const tokens = tokenize(cmd)
  const cmds: Simple[] = [{ words: [] }]
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]
    const current = cmds[cmds.length - 1]
    if (!t || !current) continue
    if (t.kind === 'op') {
      cmds.push({ words: [] })
    } else if (t.kind === 'redirect') {
      const target = tokens[k + 1]
      if (target?.kind === 'word') {
        k++
        const isFile = t.text.startsWith('>') && !t.text.includes('&') && target.text !== '/dev/null'
        if (isFile) current.writesTo = target.text
      }
    } else {
      current.words.push(t.text)
    }
  }
  return cmds.filter(c => c.words.length > 0)
}

// Two-word launchers that just run whatever follows ("pnpm exec tsc").
const LAUNCHERS = new Set(['pnpm exec', 'pnpm dlx', 'npm exec', 'yarn dlx', 'yarn exec', 'bun x', 'uv run', 'poetry run', 'bundle exec', 'pipenv run'])

/**
 * Drops everything in front of the real program: `FOO=1`, `sudo`, `env`,
 * `nohup`, `time`, `timeout 30`, `npx -y -p pkg`, `pnpm exec`, and so on.
 */
export const stripPrefixes = (input: string[]): string[] => {
  let w = input.slice()
  const dropFlags = (valueFlags: string[] = []) => {
    while (w[0]?.startsWith('-')) {
      const flag = w.shift() ?? ''
      if (valueFlags.includes(flag)) w.shift()
    }
  }
  for (let guard = 0; guard < 10 && w.length > 0; guard++) {
    const head = w[0] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      w.shift()
    } else if (head === 'sudo' || head === 'doas') {
      w.shift()
      dropFlags(['-u', '-g', '-C', '-h', '-p'])
    } else if (head === 'env') {
      w.shift()
      dropFlags(['-u', '-C', '-S'])
    } else if (['nohup', 'time', 'exec', 'builtin', 'caffeinate', 'stdbuf'].includes(head) || (head === 'command' && w[1] !== '-v')) {
      w.shift()
      dropFlags()
    } else if (head === 'nice') {
      w.shift()
      dropFlags(['-n'])
    } else if (head === 'timeout' || head === 'gtimeout') {
      w.shift()
      dropFlags(['-s', '-k', '--signal', '--kill-after'])
      w.shift() // the duration
    } else if (head === 'npx' || head === 'bunx' || head === 'pnpx') {
      w.shift()
      // `-p pkg` names the package; what follows is then the binary to run.
      while (w[0]?.startsWith('-')) {
        const flag = w.shift() ?? ''
        if (flag === '-p' || flag === '--package') w.shift()
      }
      if (w[0] === '--') w.shift()
    } else if (LAUNCHERS.has(`${head} ${w[1] ?? ''}`)) {
      w = w.slice(2)
      dropFlags()
      if (w[0] === '--') w.shift()
    } else {
      break
    }
  }
  return w
}

/** "/usr/bin/git" → "git", "typescript@5.6.3" → "typescript", "python3.12" → "python". */
export const programName = (word: string): string => {
  const name = baseName(word).replace(/(.)@[^@]*$/, '$1')
  if (/^python[\d.]*$/.test(name)) return 'python'
  if (/^pip[\d.]*$/.test(name)) return 'pip'
  return name
}

/**
 * The non-flag arguments, skipping the value after any flag in `valueFlags`
 * ("grep -A 3 foo src" with ['-A'] → ['foo', 'src']).
 */
const positional = (args: string[], valueFlags: string[] = []): string[] => {
  const out: string[] = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? ''
    if (a === '--') return out.concat(args.slice(k + 1))
    if (a.startsWith('-') && a.length > 1) {
      if (valueFlags.includes(a)) k++
    } else out.push(a)
  }
  return out
}

/** "Reading auth.ts", or a fallback phrase when there is no file argument. */
const withFile = (verb: string, file: string | undefined, fallback: string) =>
  file ? `${verb} ${baseName(file)}` : fallback

/** "Deleting auth.ts" for one file, "Deleting 3 files" for several. */
const files = (verb: string, list: string[]) =>
  list.length === 1 ? `${verb} ${baseName(list[0] ?? '')}` : list.length > 1 ? `${verb} ${list.length} files` : `${verb} files`

// ─── Per-program phrasing ────────────────────────────────────────────────────

const GIT: Record<string, string> = {
  status: 'Checking git status',
  diff: 'Looking at the changes',
  log: 'Reading git history',
  reflog: 'Reading git history',
  shortlog: 'Reading git history',
  show: 'Looking at a commit',
  add: 'Staging changes',
  commit: 'Committing changes',
  push: 'Pushing changes to the remote',
  pull: 'Pulling the latest changes',
  fetch: 'Fetching updates',
  'rev-parse': 'Checking the repository',
  rebase: 'Rebasing the branch',
  stash: 'Stashing changes',
  reset: 'Resetting changes',
  restore: 'Restoring files',
  revert: 'Reverting a commit',
  'cherry-pick': 'Applying a commit',
  init: 'Setting up a git repository',
  tag: 'Tagging a release',
  remote: 'Checking git remotes',
  'ls-files': 'Listing tracked files',
  worktree: 'Managing worktrees',
  config: 'Checking git settings',
  rm: 'Removing files from git',
  mv: 'Renaming files in git',
}

const describeGit = (args: string[]): string => {
  const rest = positional(args, ['-C', '-c', '--git-dir', '--work-tree'])
  const sub = rest[0] ?? ''
  const subArgs = args.slice(args.indexOf(sub) + 1)
  const pos = positional(subArgs, ['-m', '-b', '-B', '-c', '-n', '--format', '--pretty', '-u', '-o'])
  switch (sub) {
    case 'checkout':
    case 'switch': {
      const created = subArgs.findIndex(a => a === '-b' || a === '-c' || a === '-B')
      if (created >= 0) {
        const branch = subArgs[created + 1]
        return branch ? `Creating branch ${clip(branch, 28)}` : 'Creating a branch'
      }
      return pos[0] ? `Switching to ${clip(pos[0], 30)}` : 'Switching branches'
    }
    case 'branch':
      return pos.length > 0 && !subArgs.some(a => /^-[dD]$|^--delete$/.test(a))
        ? `Creating branch ${clip(pos[0] ?? '', 28)}`
        : subArgs.some(a => /^-[dD]$|^--delete$/.test(a))
          ? 'Deleting a branch'
          : 'Listing branches'
    case 'merge':
      return pos[0] ? `Merging ${clip(pos[0], 32)}` : 'Merging branches'
    case 'clone':
      return withFile('Cloning', pos[0]?.replace(/\.git$/, ''), 'Cloning a repository')
    case 'blame':
      return withFile('Checking who changed', pos[pos.length - 1], 'Checking who changed what')
    case 'grep':
      return pos[0] ? `Searching for ${quote(pos[0])}` : 'Searching the repository'
    case '':
      return 'Using git'
    default:
      return GIT[sub] ?? `Running git ${sub}`
  }
}

/** npm / pnpm / yarn / bun: map the script or subcommand to a phrase. */
const describePackageManager = (prog: string, args: string[]): string => {
  const pos = positional(args, ['--prefix', '-C', '--filter', '-w', '--workspace', '--cwd'])
  const sub = pos[0] ?? ''
  const script = sub === 'run' || sub === 'run-script' ? (pos[1] ?? '') : ''
  const named = script || sub
  if (!sub) return prog === 'yarn' || prog === 'bun' ? 'Installing dependencies' : `Running ${prog}`
  if (['install', 'i', 'ci', 'add'].includes(sub)) {
    return (sub === 'add' || sub === 'install' || sub === 'i') && pos[1] ? `Installing ${clip(pos[1], 28)}` : 'Installing dependencies'
  }
  if (['remove', 'uninstall', 'rm', 'un'].includes(sub)) return withFile('Removing', pos[1], 'Removing a package')
  if (['update', 'upgrade', 'up'].includes(sub)) return 'Updating dependencies'
  if (sub === 'publish') return 'Publishing the package'
  if (sub === 'outdated') return 'Checking for outdated packages'
  if (sub === 'audit') return 'Checking packages for security issues'
  if (sub === 'init' || sub === 'create') return 'Setting up a new project'
  if (prog === 'bun' && /\.[cm]?[jt]sx?$/.test(sub)) return `Running ${baseName(sub)}`
  if (/^test/.test(named) || named === 't') return 'Running tests'
  if (/^build/.test(named)) return 'Building'
  if (/^(dev|start|serve|preview)$/.test(named)) return 'Starting the dev server'
  if (/^lint/.test(named)) return 'Checking code style'
  if (/^(format|fmt|prettier)/.test(named)) return 'Formatting code'
  if (/^(typecheck|type-check|tsc|check-types)/.test(named)) return 'Type-checking'
  if (script || prog !== 'npm') return `Running the ${clip(named, 24)} script`
  return `Running npm ${sub}`
}

const describeGh = (args: string[]): string => {
  const pos = positional(args, ['-R', '--repo', '-t', '--title', '-b', '--body', '-B', '--base', '-H', '--head', '--json', '-q', '--jq'])
  const [area = '', action = '', target = ''] = pos
  const num = /^\d+$/.test(target) ? ` #${target}` : ''
  if (area === 'pr') {
    switch (action) {
      case 'create':
        return 'Opening a pull request'
      case 'view':
      case 'diff':
        return num ? `Looking at pull request${num}` : 'Looking at a pull request'
      case 'list':
        return 'Listing pull requests'
      case 'merge':
        return 'Merging a pull request'
      case 'checks':
        return 'Checking CI on a pull request'
      case 'checkout':
        return 'Checking out a pull request'
      case 'comment':
      case 'review':
        return 'Commenting on a pull request'
      default:
        return 'Working on a pull request'
    }
  }
  if (area === 'issue') return action === 'create' ? 'Opening an issue' : action === 'list' ? 'Listing issues' : 'Working on an issue'
  if (area === 'run' || area === 'workflow') return 'Checking CI runs'
  if (area === 'api') return 'Asking the GitHub API'
  if (area === 'repo') return action === 'clone' ? 'Cloning a repository' : 'Working on the repository'
  if (area === 'release') return 'Working on a release'
  return 'Using GitHub'
}

const describeCurl = (args: string[]): string => {
  const url = args.find(a => /^[a-z]+:\/\//i.test(a)) ?? args.find(a => !a.startsWith('-') && /^(localhost|[\w-]+(\.[\w-]+)+)([:/]|$)/i.test(a))
  const sends = args.some((a, k) => /^(-d|--data.*|-F|--form|--json|-T|--upload-file)$/.test(a) || ((a === '-X' || a === '--request') && args[k + 1] !== 'GET'))
  if (!url) return sends ? 'Sending a web request' : 'Fetching a web page'
  return `${sends ? 'Sending a request to' : 'Fetching'} ${hostOf(url)}`
}

/** grep / rg / ag: the pattern is the first positional, or the value of -e. */
const describeGrep = (args: string[]): string => {
  const e = args.findIndex(a => a === '-e' || a === '--regexp')
  const pos = positional(args, ['-e', '--regexp', '-f', '-A', '-B', '-C', '-m', '--max-count', '-g', '--glob', '-t', '--type', '-T', '--type-not', '--include', '--exclude', '-d', '-D', '-j', '--threads', '-M', '--max-columns'])
  const pattern = e >= 0 ? args[e + 1] : pos[0]
  if (!pattern) return 'Searching files'
  const where = (e >= 0 ? pos[0] : pos[1]) ?? ''
  const inWhere = where && where !== '.' && !where.startsWith('-') ? ` in ${baseName(where)}` : ''
  return `Searching for ${quote(pattern)}${inWhere}`
}

/** An interpreter (python, node, …): the script it runs, or "a quick script". */
const describeInterpreter = (prog: string, args: string[]): string => {
  const lang = prog === 'python' ? 'Python' : prog === 'node' || prog === 'deno' || prog === 'tsx' || prog === 'ts-node' ? 'JavaScript' : prog === 'ruby' ? 'Ruby' : ''
  if (args.some(a => a === '-c' || a === '-e' || a === '--eval' || a === '-p' || a === '--print')) {
    return lang ? `Running a quick ${lang} snippet` : 'Running a quick script'
  }
  const m = args.indexOf('-m')
  if (m >= 0) {
    const mod = args[m + 1] ?? ''
    if (mod === 'pytest' || mod === 'unittest') return 'Running tests'
    if (mod === 'pip') return describePip(args.slice(m + 2))
    if (mod === 'http.server') return 'Starting a web server'
    if (mod === 'venv') return 'Creating a virtual environment'
    return mod ? `Running ${mod}` : `Running ${prog}`
  }
  const script = positional(args, ['-W', '-X', '--require', '-r', '--import', '--loader'])[0]
  if (prog === 'deno' && (script === 'run' || script === 'task')) {
    const rest = positional(args.slice(args.indexOf(script) + 1))
    return withFile('Running', rest[0], 'Running a Deno script')
  }
  if (prog === 'deno' && script === 'test') return 'Running tests'
  return withFile('Running', script, `Running ${prog}`)
}

const describePip = (args: string[]): string => {
  const pos = positional(args, ['-r', '--requirement', '-i', '--index-url', '-c', '--constraint', '-t', '--target'])
  const sub = pos[0] ?? ''
  if (sub === 'install') return pos.length === 2 && pos[1] ? `Installing ${clip(pos[1], 28)}` : 'Installing dependencies'
  if (sub === 'uninstall') return 'Removing a package'
  if (sub === 'list' || sub === 'freeze' || sub === 'show') return 'Checking installed packages'
  return 'Managing Python packages'
}

/** cargo / go subcommands. */
const describeToolchain = (prog: string, args: string[]): string => {
  const sub = positional(args, ['-p', '--package', '--manifest-path', '-C'])[0] ?? ''
  if (sub === 'test') return 'Running tests'
  if (sub === 'build' || sub === 'install') return sub === 'install' ? 'Installing' : 'Building'
  if (sub === 'run') return 'Running the program'
  if (sub === 'check' || sub === 'vet' || sub === 'clippy') return 'Checking the code'
  if (sub === 'fmt') return 'Formatting code'
  if (sub === 'add' || sub === 'get') return 'Adding a dependency'
  if (sub === 'mod' || sub === 'update' || sub === 'fetch') return 'Updating dependencies'
  return sub ? `Running ${prog} ${sub}` : `Running ${prog}`
}

const describeDocker = (args: string[]): string => {
  const pos = positional(args, ['-f', '--file', '-t', '--tag', '-p', '-e', '-v', '--name', '-w', '--network'])
  const sub = pos[0] === 'compose' ? `compose ${pos[1] ?? ''}` : (pos[0] ?? '')
  if (sub === 'build') return 'Building a Docker image'
  if (sub === 'run' || sub === 'compose up' || sub === 'start') return 'Starting a container'
  if (sub === 'ps' || sub === 'compose ps' || sub === 'images') return 'Checking containers'
  if (sub === 'logs' || sub === 'compose logs') return 'Reading container logs'
  if (sub === 'stop' || sub === 'compose down' || sub === 'rm' || sub === 'kill') return 'Stopping a container'
  if (sub === 'exec') return 'Running inside a container'
  if (sub === 'pull') return 'Downloading a Docker image'
  if (sub === 'push') return 'Uploading a Docker image'
  return 'Using Docker'
}

const TEST_RUNNERS = new Set(['pytest', 'jest', 'vitest', 'mocha', 'ava', 'tap', 'karma', 'phpunit', 'rspec', 'ctest'])
const INTERPRETERS = new Set(['python', 'node', 'deno', 'tsx', 'ts-node', 'ruby', 'perl', 'php', 'bash', 'sh', 'zsh', 'osascript', 'lua'])
const LISTERS = new Set(['ls', 'tree', 'exa', 'eza', 'll'])
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'xxd', 'hexdump', 'strings', 'file', 'stat'])

/**
 * Phrase for one simple command (words already stripped of prefixes), or ''
 * when the program is unknown and the caller should fall back.
 */
export const describeProgram = (words: string[], writesTo?: string): string => {
  const prog = programName(words[0] ?? '')
  const args = words.slice(1)
  const pos = positional(args)
  if (args.length === 1 && /^(--version|-v|-V|version)$/.test(args[0] ?? '')) return `Checking the ${prog} version`
  if (writesTo && ['cat', 'echo', 'printf', 'tee'].includes(prog)) return `Writing ${baseName(writesTo)}`
  switch (prog) {
    case 'git':
      return describeGit(args)
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return describePackageManager(prog, args)
    case 'claude':
      if (pos[0] === 'plugin' && pos[1] === 'test') return 'Running plugin tests'
      if (pos[0] === 'plugin' && pos[1] === 'validate') return 'Validating the plugin'
      if (pos[0] === 'plugin') return 'Managing plugins'
      if (pos[0] === 'mcp') return 'Managing MCP servers'
      return 'Running Claude'
    case 'tsc':
    case 'vue-tsc':
      return args.includes('--watch') || args.includes('-w') ? 'Watching for type errors' : 'Type-checking'
    case 'eslint':
    case 'biome':
    case 'ruff':
    case 'flake8':
    case 'pylint':
    case 'shellcheck':
    case 'stylelint':
      return 'Checking code style'
    case 'prettier':
    case 'black':
    case 'gofmt':
    case 'rustfmt':
      return 'Formatting code'
    case 'mypy':
    case 'pyright':
      return 'Type-checking'
    case 'find':
    case 'fd':
    case 'locate':
    case 'mdfind':
      return 'Finding files'
    case 'grep':
    case 'egrep':
    case 'rg':
    case 'ag':
    case 'ack':
      return describeGrep(args)
    case 'sed':
      if (args.some(a => /^-i/.test(a) || a === '--in-place')) return withFile('Editing', pos[pos.length - 1], 'Editing text')
      if (args.includes('-n')) return withFile('Reading', pos[pos.length - 1], 'Reading a file')
      return 'Editing text'
    case 'awk':
    case 'gawk':
    case 'cut':
    case 'sort':
    case 'uniq':
    case 'tr':
      return 'Processing text'
    case 'jq':
    case 'yq':
      return 'Reading JSON data'
    case 'wc':
      return withFile('Counting lines in', pos[0], 'Counting lines')
    case 'diff':
    case 'cmp':
      return 'Comparing files'
    case 'mkdir':
      return 'Creating a folder'
    case 'touch':
      return files('Creating', pos)
    case 'rm':
    case 'rmdir':
    case 'trash':
      return files('Deleting', pos)
    case 'mv':
      return files('Moving', pos.slice(0, -1))
    case 'cp':
    case 'rsync':
    case 'scp':
    case 'ditto':
      return files('Copying', pos.slice(0, -1))
    case 'ln':
      return 'Creating a link'
    case 'chmod':
    case 'chown':
      return 'Changing file permissions'
    case 'tar':
    case 'unzip':
    case 'gunzip':
      return prog === 'tar' && args.some(a => /^-?[a-z]*c/.test(a) && !/x/.test(a)) ? 'Packing files' : 'Unpacking files'
    case 'zip':
    case 'gzip':
      return 'Packing files'
    case 'curl':
    case 'wget':
    case 'http':
    case 'xh':
      return describeCurl(args)
    case 'gh':
      return describeGh(args)
    case 'make':
    case 'cmake':
    case 'ninja':
    case 'gradle':
    case 'mvn':
    case 'xcodebuild':
    case 'swift':
      if (pos.includes('test') || pos.includes('check')) return 'Running tests'
      if (pos[0] === 'install') return 'Installing'
      if (pos[0] === 'clean') return 'Cleaning the build'
      return 'Building'
    case 'cargo':
    case 'go':
      return describeToolchain(prog, args)
    case 'pip':
    case 'pipx':
    case 'uv':
      return prog === 'uv' && pos[0] === 'sync' ? 'Installing dependencies' : describePip(prog === 'uv' && pos[0] === 'pip' ? args.slice(args.indexOf('pip') + 1) : args)
    case 'brew':
    case 'apt':
    case 'apt-get':
      return pos[0] === 'install' ? withFile('Installing', pos[1], 'Installing software') : 'Managing installed software'
    case 'docker':
    case 'podman':
      return describeDocker(args)
    case 'sleep':
      return 'Waiting'
    case 'wait':
      return 'Waiting for a task to finish'
    case 'echo':
    case 'printf':
      return 'Printing output'
    case 'pwd':
      return 'Checking the current folder'
    case 'which':
    case 'whereis':
    case 'type':
      return withFile('Looking up', pos[0], 'Looking up a program')
    case 'command':
      return withFile('Looking up', pos[0], 'Looking up a program')
    case 'kill':
    case 'pkill':
    case 'killall':
      return 'Stopping a process'
    case 'ps':
    case 'pgrep':
    case 'top':
    case 'lsof':
      return 'Checking running processes'
    case 'open':
    case 'xdg-open':
      return withFile('Opening', pos[0] && /^[a-z]+:\/\//i.test(pos[0]) ? hostOf(pos[0]) : pos[0], 'Opening something')
    case 'date':
      return 'Checking the time'
    case 'du':
    case 'df':
      return 'Checking disk space'
    case 'tee':
      return withFile('Writing', pos[0], 'Saving output')
    case 'ssh':
      return 'Connecting to a server'
    case 'defaults':
    case 'plutil':
      return 'Checking system settings'
    case 'cd':
      return 'Changing folder'
    case 'export':
      return 'Setting environment variables'
    case 'source':
    case '.':
      return 'Loading settings'
  }
  if (LISTERS.has(prog)) {
    const dir = pos[0]
    return dir && dir !== '.' ? `Listing files in ${baseName(dir)}` : 'Listing files'
  }
  if (READERS.has(prog)) return withFile('Reading', pos[pos.length - 1], 'Reading a file')
  if (TEST_RUNNERS.has(prog) || (prog === 'playwright' && pos[0] === 'test')) return 'Running tests'
  if (INTERPRETERS.has(prog)) return describeInterpreter(prog, args)
  if (/^\.{0,2}\//.test(words[0] ?? '') || /\.(sh|py|js|ts|rb)$/.test(prog)) return `Running ${prog}`
  return ''
}

// Commands that only set the stage (change folder, set variables); a later
// command in the same line says more about what is going on.
const SETUP = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'unset', 'source', '.', 'true', 'false', ':', 'alias', 'shopt', 'trap', 'ulimit', 'umask'])
// Commands that are only interesting when nothing else is happening: banner
// `echo`s, and prep steps like `mkdir -p out &&` or `git add -A &&` whose
// follow-up ("cp …", "git commit") is the real action.
const QUIET = new Set(['echo', 'printf', 'clear', 'mkdir'])
const isQuiet = (c: Simple) => {
  const prog = programName(c.words[0] ?? '')
  if (c.writesTo) return false
  return QUIET.has(prog) || (prog === 'git' && positional(c.words.slice(1), ['-C', '-c'])[0] === 'add')
}

/**
 * Phrase for a Bash call. Picks the first command that matters (skipping
 * `cd x &&`, `export`, banner `echo`s and prep steps; in a pipeline the
 * first stage is the one described), strips
 * launch prefixes, and maps the program to a phrase. Unknown programs fall back
 * to the call's `description` when one was given, else "Running <program>".
 */
export const describeBash = (command: string, description = ''): string => {
  const candidates = splitCommands(command)
    .map(c => ({ words: stripPrefixes(c.words), writesTo: c.writesTo }))
    .filter(c => c.words.length > 0)
  const meaningful = candidates.filter(c => !SETUP.has(programName(c.words[0] ?? '')))
  const loud = meaningful.filter(c => !isQuiet(c))
  const pick = loud[0] ?? meaningful[0] ?? candidates[0]
  const phrase = pick ? describeProgram(pick.words, pick.writesTo) : ''
  if (phrase) return phrase
  const described = fromDescription(description)
  if (described) return described
  return pick ? `Running ${clip(programName(pick.words[0] ?? ''), 32)}` : 'Running a command'
}

// ─── Tool-level phrasing ─────────────────────────────────────────────────────

/** "mcp__claude_ai_Gmail__search_threads" → "Using Gmail (search threads)". */
const describeMcp = (tool: string): string => {
  const [, server = '', ...rest] = tool.split('__')
  const name = server.replace(/^claude_ai_/, '').replace(/[_-]+/g, ' ').trim()
  const action = words(rest.join(' '))
  return action ? `Using ${name} (${action})` : `Using ${name}`
}

/** Glob pattern → "Looking for *.ts files" / "Looking for package.json". */
const describeGlob = (pattern: string, path: string): string => {
  const last = baseName(pattern)
  const where = path ? ` in ${baseName(path)}` : ''
  if (!last || last === '*' || last === '**') return `Listing files${where}`
  return last.includes('*') ? `Looking for ${clip(last, 24)} files${where}` : `Looking for ${clip(last, 28)}${where}`
}

/**
 * One-line, present-tense description of a tool call for an agent's
 * "currently doing" line. `input` is the tool's raw input object.
 */
export const describeActivity = (tool: string, input: Record<string, unknown>): string => {
  const s = (k: string) => str(input, k)
  const file = s('file_path') || s('notebook_path') || s('path')
  switch (tool) {
    case 'Read':
      return withFile('Reading', file, 'Reading a file')
    case 'Edit':
    case 'MultiEdit':
      return withFile('Editing', file, 'Editing a file')
    case 'Write':
      return withFile('Writing', file, 'Writing a file')
    case 'NotebookEdit':
      return withFile('Editing', file, 'Editing a notebook')
    case 'Bash':
      return describeBash(s('command'), s('description'))
    case 'BashOutput':
      return 'Checking command output'
    case 'KillShell':
    case 'KillBash':
      return 'Stopping a command'
    case 'Grep': {
      const where = s('path') && s('path') !== '.' ? ` in ${baseName(s('path'))}` : s('glob') ? ` in ${clip(s('glob'), 16)} files` : ''
      return s('pattern') ? `Searching for ${quote(s('pattern'))}${where}` : 'Searching files'
    }
    case 'Glob':
      return describeGlob(s('pattern'), s('path'))
    case 'LS':
      return file && file !== '.' ? `Listing files in ${baseName(file)}` : 'Listing files'
    case 'WebSearch':
      return s('query') ? `Searching the web for ${quote(s('query'), 26)}` : 'Searching the web'
    case 'WebFetch':
      return s('url') ? `Reading ${hostOf(s('url'))}` : 'Reading a web page'
    case 'Agent':
    case 'Task': {
      const what = s('description')
      return what ? `Starting an agent to ${lowerFirst(clip(what, 40))}` : 'Starting an agent'
    }
    case 'TaskCreate':
      return s('subject') ? `Adding a task: ${clip(s('subject'), 34)}` : 'Adding a task'
    case 'TaskUpdate': {
      const n = id(input, 'taskId')
      const which = n ? `task #${n}` : 'a task'
      const status = s('status')
      if (status === 'in_progress') return `Starting ${which}`
      if (status === 'completed') return `Finishing ${which}`
      if (status === 'deleted') return `Removing ${which}`
      return `Updating ${which}`
    }
    case 'TaskList':
      return 'Checking the task list'
    case 'TaskGet':
      return id(input, 'taskId') ? `Checking task #${id(input, 'taskId')}` : 'Checking a task'
    case 'TaskStop':
    case 'TaskOutput':
      return tool === 'TaskStop' ? 'Stopping a background task' : 'Checking a background task'
    case 'TodoWrite':
      return 'Updating the to-do list'
    case 'ToolSearch':
      return 'Loading tools'
    case 'Skill': {
      const skill = s('skill').split(':').pop() ?? ''
      return skill ? `Using the ${clip(skill, 28)} skill` : 'Using a skill'
    }
    case 'AskUserQuestion':
      return 'Asking you a question'
    case 'EnterPlanMode':
      return 'Planning'
    case 'ExitPlanMode':
      return 'Presenting a plan'
    case 'SendMessage':
      return 'Sending a message'
    case 'SubagentHandback':
      return 'Reporting back'
    case 'Monitor':
      return 'Keeping an eye on a process'
    case 'LSP':
      return 'Looking up code definitions'
    case 'EnterWorktree':
      return 'Setting up a worktree'
    case 'ExitWorktree':
      return 'Leaving the worktree'
    case 'Artifact':
      return 'Working on a page'
    case 'mcp__mission-control__progress_plan':
      return 'Planning the work'
    case 'mcp__mission-control__progress_checkpoint':
      return s('label') ? `Reached: ${clip(s('label'), 38)}` : 'Hit a checkpoint'
  }
  if (tool.startsWith('mcp__')) return describeMcp(tool)
  return capitalize(words(tool)) || 'Working'
}
