/**
 * Git operations for the multi-repo panel. Everything goes through the
 * system `git` binary spawned per request (no library, no state), with
 * porcelain-parseable output formats (`-z` NUL framing) so parsing never
 * depends on locale or color config. Command shape follows the same
 * conventions as dsh-better-sidebar's git.ts (MIT) — `-C <cwd>`,
 * `--no-pager`, `-c color.ui=false` — but the discovery logic is ours.
 *
 * `-c core.quotepath=false` disables git's C-style path quoting (the
 * `"\ooo\ooo..."` octal escapes shown for non-ASCII names like Chinese
 * filenames in line-oriented outputs: `diff-tree --name-only`, `git diff`
 * headers, `ls-files` …). Without it those paths arrive escaped and the
 * panel would display (and pass back to git) the escaped form instead of
 * the real UTF-8 path. `status` uses `-z` NUL framing, which git never
 * quotes, so it is unaffected either way.
 */
import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** A parsed `git status --porcelain=v1 -z` entry. */
export interface GitStatusEntry {
  path: string
  /** Two-letter index/worktree status (X Y), e.g. 'M ', ' M', 'A ', '??'. */
  xy: string
}

/** The source-control snapshot of one repository. */
export interface GitStatusResult {
  isRepo: boolean
  branch?: string
  entries: GitStatusEntry[]
}

/** One `git log` row. */
export interface GitLogEntry {
  hash: string
  hashFull: string
  subject: string
  author: string
  /** ISO 8601 author date (`%ai`). */
  date: string
  /** Ref decorations (`%D`), e.g. 'HEAD -> main, origin/main'; '' when none. */
  refs: string
  /** Parent hashes (`%P`, space-separated), for the commit graph. */
  parents: string[]
}

/** One discovered repository. */
export interface GitRepo {
  /** Absolute path of the repo root (contains .git). */
  root: string
  /** Directory name of the repo root (display). */
  name: string
  /** 0 = the session cwd itself; 1+ = nested depth under the cwd. */
  depth: number
}

/** One git failure (stderr text as the message). */
export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly command: string,
  ) {
    super(message)
  }
}

/** Parse porcelain v1 -z output into entries (rename/copy pairs collapse). */
export function parsePorcelainZ(output: string): GitStatusEntry[] {
  const tokens = output.split('\0')
  const entries: GitStatusEntry[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    index += 1
    if (token === '') continue
    const xy = token.slice(0, 2)
    const rest = token.slice(3)
    entries.push({ path: rest, xy })
    // Rename/copy entries carry the ORIGIN path as the next NUL field.
    if ((xy[0] === 'R' || xy[0] === 'C') && tokens[index] !== undefined && tokens[index] !== '') {
      index += 1
    }
  }
  return entries
}

/** Parse `git log --pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D%x1f%P` rows. */
export function parseLogLines(output: string): GitLogEntry[] {
  const rows: GitLogEntry[] = []
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [hash, subject, author, date, hashFull, refs, parents] = line.split('\x1f')
    if (hash === undefined || subject === undefined) continue
    rows.push({
      hash,
      subject,
      author: author ?? '',
      date: date ?? '',
      hashFull: hashFull ?? hash,
      refs: refs ?? '',
      parents: parents === undefined || parents === '' ? [] : parents.split(' '),
    })
  }
  return rows
}

/** Run one git command; resolves with stdout, rejects with GitCommandError. */
function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const full = ['-C', cwd, '--no-pager', '-c', 'color.ui=false', '-c', 'core.quotepath=false', ...args]
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn('git', full, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new GitCommandError(`git ${args[0] ?? ''} timed out after ${timeoutMs}ms`, args.join(' ')))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new GitCommandError(`cannot run git: ${error.message}`, args.join(' ')))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(stdout)
      else reject(new GitCommandError(stderr.trim() || `git exited with ${String(code)}`, args.join(' ')))
    })
  })
}

/** Whether `dir` is a git repository root (contains .git). */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const info = await stat(join(dir, '.git'))
    return info.isDirectory() || info.isFile()
  } catch {
    return false
  }
}

/**
 * Discover every git repository under `cwd` (plus the repository `cwd`
 * itself lives in, found by walking up). Excluded directory names (e.g.
 * `node_modules`) are skipped entirely — their subtrees are never scanned,
 * which also bounds the scan cost. Hidden directories (dot-prefixed) are
 * skipped; a hidden git checkout is not a working tree a user manages here.
 */
export async function discoverRepos(
  cwd: string,
  opts: { excludes: readonly string[]; maxDepth?: number } = { excludes: ['node_modules'] },
): Promise<GitRepo[]> {
  const excludes = new Set(opts.excludes.map(name => name.toLowerCase()))
  const maxDepth = opts.maxDepth ?? 3
  const repos: GitRepo[] = []
  const seen = new Set<string>()

  const isExcluded = (name: string): boolean => excludes.has(name.toLowerCase())

  // The repository the session cwd itself belongs to (walk up).
  let walker = cwd
  for (let guard = 0; guard < 8; guard++) {
    if (await isGitRepo(walker)) {
      repos.push({ root: walker, name: basename(walker) || walker, depth: 0 })
      seen.add(walker.toLowerCase())
      break
    }
    const parent = walker.lastIndexOf('\\') > walker.lastIndexOf('/') ? '\\' : '/'
    const up = walker.slice(0, walker.lastIndexOf(parent))
    if (up === walker || up === '') break
    walker = up
  }

  // BFS over the subdirectories of cwd (depth-bounded, exclusions pruned).
  const queue: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }]
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!
    if (depth >= maxDepth) continue
    let entries: string[]
    try {
      entries = await readdir(dir, { withFileTypes: true }).then(list =>
        list.filter(entry => entry.isDirectory()).map(entry => entry.name),
      )
    } catch {
      continue // unreadable dirs are skipped
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue // hidden / .git itself
      if (isExcluded(name)) continue // node_modules etc. — no git inside
      const child = join(dir, name)
      const key = child.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      if (await isGitRepo(child)) {
        repos.push({ root: child, name, depth: depth + 1 })
      }
      queue.push({ dir: child, depth: depth + 1 })
    }
  }

  return repos.sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name))
}

/** status --porcelain=v1 -z + current branch. */
export async function status(repoRoot: string): Promise<GitStatusResult> {
  const [raw, branch] = await Promise.all([
    runGit(repoRoot, ['status', '--porcelain=v1', '-z']).catch(() => ''),
    runGit(repoRoot, ['branch', '--show-current']).catch(() => ''),
  ])
  return {
    isRepo: true,
    branch: branch.trim() === '' ? undefined : branch.trim(),
    entries: parsePorcelainZ(raw),
  }
}

/** Current branch + all local branch names. */
export async function branches(repoRoot: string): Promise<{ current: string; names: string[] }> {
  const [current, list] = await Promise.all([
    runGit(repoRoot, ['branch', '--show-current']).catch(() => ''),
    runGit(repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).catch(() => ''),
  ])
  return {
    current: current.trim(),
    names: list.split('\n').map(line => line.trim()).filter(line => line !== ''),
  }
}

/**
 * Pageable commit log (with parents, for the commit graph). Uses `--all` so
 * the graph shows EVERY branch — including unmerged local/remote branches
 * (e.g. `origin/feature`) and tags — not just the current HEAD's ancestry.
 */
export async function log(repoRoot: string, count: number, skip: number): Promise<GitLogEntry[]> {
  const raw = await runGit(repoRoot, [
    'log',
    '--all',
    '--topo-order',
    `--max-count=${String(count)}`,
    `--skip=${String(skip)}`,
    '--pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D%x1f%P',
  ])
  return parseLogLines(raw)
}

/** The files one commit changed (diff-tree works for merges too). Paths are
 *  raw UTF-8 (`core.quotepath=false` is set in runGit), so non-ASCII names
 *  like Chinese filenames come back unescaped. */
export async function showFiles(repoRoot: string, hash: string): Promise<string[]> {
  const raw = await runGit(repoRoot, [
    'diff-tree', '--no-commit-id', '--name-only', '-r', '-m', hash,
  ])
  const seen = new Set<string>()
  const files: string[] = []
  for (const line of raw.split('\n')) {
    const name = line.trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    files.push(name)
  }
  return files
}

/** The diff of ONE file introduced by ONE commit (git show handles root commits). */
export async function showFile(repoRoot: string, hash: string, path: string): Promise<string> {
  return runGit(repoRoot, ['show', hash, '--', path])
}

/** Stage one path (or everything) in the index. */
export async function stage(repoRoot: string, path: string | undefined): Promise<void> {
  await runGit(repoRoot, path === undefined ? ['add', '-A'] : ['add', '--', path])
}

/** Unstage one path (or everything). */
export async function unstage(repoRoot: string, path: string | undefined): Promise<void> {
  await runGit(repoRoot, path === undefined ? ['reset', '-q'] : ['reset', '-q', '--', path])
}

/** Commit the staged changes with the given message. */
export async function commit(repoRoot: string, message: string): Promise<void> {
  await runGit(repoRoot, ['commit', '-m', message])
}

/** Switch to an existing local branch. */
export async function checkout(repoRoot: string, branch: string): Promise<void> {
  await runGit(repoRoot, ['checkout', branch])
}

/** Discard worktree changes of one path (index untouched). */
export async function discard(repoRoot: string, path: string): Promise<void> {
  await runGit(repoRoot, ['checkout', '--', path])
}

/** Unified diff text for one path (or the whole working tree). */
export async function diff(repoRoot: string, path: string | undefined, staged: boolean): Promise<string> {
  const args = staged ? ['diff', '--cached'] : ['diff']
  if (path !== undefined) args.push('--', path)
  return runGit(repoRoot, args)
}
