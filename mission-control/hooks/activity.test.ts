import { expect, test } from 'claude-code/testing'
import { describeActivity } from './activity'

/** Shorthand for a Bash call, optionally with Claude Code's `description`. */
const bash = (command: string, description?: string) =>
  describeActivity('Bash', description === undefined ? { command } : { command, description })

test('file tools name just the file', async () => {
  expect(describeActivity('Read', { file_path: '/Users/me/src/auth.ts' })).toBe('Reading auth.ts')
  expect(describeActivity('Edit', { file_path: '/repo/hooks/pane.tsx' })).toBe('Editing pane.tsx')
  expect(describeActivity('MultiEdit', { file_path: 'a/b.ts' })).toBe('Editing b.ts')
  expect(describeActivity('Write', { file_path: '/repo/notes.md' })).toBe('Writing notes.md')
  expect(describeActivity('NotebookEdit', { notebook_path: '/n/analysis.ipynb' })).toBe('Editing analysis.ipynb')
})

test('search tools quote the term with curly quotes', async () => {
  expect(describeActivity('Grep', { pattern: 'describeCall', path: '/repo/hooks' })).toBe('Searching for “describeCall” in hooks')
  expect(describeActivity('Grep', { pattern: 'TODO' })).toBe('Searching for “TODO”')
  expect(describeActivity('Glob', { pattern: '**/*.ts' })).toBe('Looking for *.ts files')
  expect(describeActivity('WebSearch', { query: 'bun test runner' })).toBe('Searching the web for “bun test runner”')
  expect(describeActivity('WebFetch', { url: 'https://www.example.com/docs?x=1' })).toBe('Reading example.com')
})

test('agent and task tools', async () => {
  expect(describeActivity('Agent', { description: 'Fix the login bug' })).toBe('Starting an agent to fix the login bug')
  expect(describeActivity('TaskCreate', { subject: 'Write tests' })).toBe('Adding a task: Write tests')
  expect(describeActivity('TaskUpdate', { taskId: '3', status: 'in_progress' })).toBe('Starting task #3')
  expect(describeActivity('TaskUpdate', { taskId: 3, status: 'completed' })).toBe('Finishing task #3')
  expect(describeActivity('TaskUpdate', { taskId: '4', owner: 'x' })).toBe('Updating task #4')
  expect(describeActivity('TodoWrite', { todos: [] })).toBe('Updating the to-do list')
  expect(describeActivity('ToolSearch', { query: 'x' })).toBe('Loading tools')
  expect(describeActivity('Skill', { skill: 'anthropic-skills:pdf' })).toBe('Using the pdf skill')
  expect(describeActivity('AskUserQuestion', {})).toBe('Asking you a question')
})

test('mission-control, other MCP, and unknown tools', async () => {
  expect(describeActivity('mcp__mission-control__progress_plan', { checkpoints: [] })).toBe('Planning the work')
  expect(describeActivity('mcp__mission-control__progress_checkpoint', { label: 'Tests pass' })).toBe('Reached: Tests pass')
  expect(describeActivity('mcp__mission-control__progress_checkpoint', {})).toBe('Hit a checkpoint')
  expect(describeActivity('mcp__claude_ai_Gmail__search_threads', {})).toBe('Using Gmail (search threads)')
  expect(describeActivity('NotebookRead', {})).toBe('Notebook read')
})

test('bash: git subcommands, behind cd and prep steps', async () => {
  expect(bash('cd /x && git status')).toBe('Checking git status')
  expect(bash('git diff --stat HEAD~1')).toBe('Looking at the changes')
  expect(bash('git -C /repo log --oneline -5')).toBe('Reading git history')
  expect(bash(`git add -A && git commit -m "$(cat <<'EOF'\nFix (things)\nEOF\n)"`)).toBe('Committing changes')
  expect(bash('git push origin main')).toBe('Pushing changes to the remote')
  expect(bash('git checkout -b feature/login')).toBe('Creating branch feature/login')
  expect(bash('echo "---"; git log -3')).toBe('Reading git history')
})

test('bash: package managers and build tools', async () => {
  expect(bash('FOO=1 npm test 2>&1 | tail -20')).toBe('Running tests')
  expect(bash('pnpm install')).toBe('Installing dependencies')
  expect(bash('npm run build')).toBe('Building')
  expect(bash('yarn storybook')).toBe('Running the storybook script')
  expect(bash('cd /tmp/tc && npx -y -p typescript@5.6.3 tsc -p tsconfig.json')).toBe('Type-checking')
  expect(bash('claude plugin test /a/b/mission-control')).toBe('Running plugin tests')
  expect(bash('claude plugin validate .')).toBe('Validating the plugin')
  expect(bash('make -j4')).toBe('Building')
  expect(bash('pytest -q tests/')).toBe('Running tests')
  expect(bash('cargo test --release')).toBe('Running tests')
  expect(bash('sudo timeout 30 docker build -t app .')).toBe('Building a Docker image')
})

test('bash: files, search and the web', async () => {
  expect(bash('ls -la /Users/me/src')).toBe('Listing files in src')
  expect(bash('find . -name "*.ts" | head')).toBe('Finding files')
  expect(bash("sed -n '1,40p' hooks/tracker.ts")).toBe('Reading tracker.ts')
  expect(bash('grep -rn "describeCall" hooks')).toBe('Searching for “describeCall” in hooks')
  expect(bash('rg -n --type ts "foo bar" src/')).toBe('Searching for “foo bar” in src')
  expect(bash('mkdir -p out && cp a.txt out/')).toBe('Copying a.txt')
  expect(bash('rm -rf dist')).toBe('Deleting dist')
  expect(bash("cat > notes.md <<'EOF'\n# hi\nEOF")).toBe('Writing notes.md')
  expect(bash('curl -s https://api.github.com/repos/x | jq .')).toBe('Fetching api.github.com')
  expect(bash('gh pr view 12')).toBe('Looking at pull request #12')
})

test('bash: scripts, odds and ends, and the description fallback', async () => {
  expect(bash('python3 scripts/gen.py --out x')).toBe('Running gen.py')
  expect(bash('node -e "console.log(1)"')).toBe('Running a quick JavaScript snippet')
  expect(bash('node --version')).toBe('Checking the node version')
  expect(bash('sleep 5')).toBe('Waiting')
  expect(bash('echo "hello"')).toBe('Printing output')
  expect(bash('weirdtool --flag', 'Run the deploy check.')).toBe('Running the deploy check')
  expect(bash('weirdtool --flag', 'Git status overview')).toBe('Git status overview')
  expect(bash('weirdtool --flag')).toBe('Running weirdtool')
})
