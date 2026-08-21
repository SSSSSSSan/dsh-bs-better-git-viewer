/**
 * Git-change watcher (HOST): watches each repo's `.git` metadata under a
 * session cwd and notifies subscribers when git structure changes — commits,
 * stage/unstage, checkout, branch moves all touch `.git/HEAD`, `.git/index`
 * or `.git/refs/**`. Deliberately OUTSIDE the conversation event pipeline:
 * the panel gets its refresh signal through its own WebSocket, never through
 * DSH's session events.
 *
 * Files edited in the worktree (unstaged, untracked) do NOT touch `.git` and
 * are therefore not covered here — the panel's visible-refresh covers those.
 */
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { discoverRepos } from './git.ts'

/** One subscriber (a WebSocket client) that can receive a change ping. */
export interface GitWatchSubscriber {
  send(data: string): void
}

const DEBOUNCE_MS = 250

/** Read the exclude list from the doc file in the session cwd (shared copy —
 *  keeps git-watch decoupled from index.ts). */
async function readExcludesFile(cwd: string): Promise<string[]> {
  const { readFile } = await import('node:fs/promises')
  try {
    const text = await readFile(join(cwd, '.dsh-bs-git-excludes'), 'utf8')
    return text.split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#'))
  } catch {
    return []
  }
}

export class GitWatchManager {
  private watchers = new Map<string, FSWatcher[]>()
  private watchedRoots = new Map<string, Set<string>>()
  private subscribers = new Map<string, Set<GitWatchSubscriber>>()
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * Make sure every repo under `cwd` is being watched (incremental: only
   * newly discovered roots get watchers). Safe to call repeatedly.
   */
  async ensure(cwd: string): Promise<void> {
    const excludes = ['node_modules', ...(await readExcludesFile(cwd))]
    let repos
    try {
      repos = await discoverRepos(cwd, { excludes })
    } catch {
      return // discovery failure: leave existing watchers alone
    }
    const existing = this.watchedRoots.get(cwd) ?? new Set<string>()
    const added: FSWatcher[] = []
    for (const repo of repos) {
      if (existing.has(repo.root)) continue
      existing.add(repo.root)
      added.push(...this.watchRepo(cwd, repo.root))
    }
    if (added.length > 0) {
      this.watchedRoots.set(cwd, existing)
      this.watchers.set(cwd, [...(this.watchers.get(cwd) ?? []), ...added])
    }
  }

  /** Subscribe to change pings for one cwd. Returns the unsubscribe. */
  subscribe(cwd: string, subscriber: GitWatchSubscriber): () => void {
    let set = this.subscribers.get(cwd)
    if (set === undefined) {
      set = new Set()
      this.subscribers.set(cwd, set)
    }
    set.add(subscriber)
    return () => { set.delete(subscriber) }
  }

  /** Drop every watcher and timer (plugin teardown). */
  dispose(): void {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer)
    this.debounceTimers.clear()
    for (const list of this.watchers.values()) {
      for (const watcher of list) {
        try { watcher.close() } catch { /* already closed */ }
      }
    }
    this.watchers.clear()
    this.watchedRoots.clear()
    this.subscribers.clear()
  }

  private watchRepo(cwd: string, root: string): FSWatcher[] {
    const gitDir = join(root, '.git')
    const watchers: FSWatcher[] = []
    try {
      // HEAD / index live directly in .git; file changes fire directory events.
      watchers.push(watch(gitDir, { persistent: false }, () => this.notifySoon(cwd)))
    } catch {
      // not a real git dir (worktree submodule?) — skip
    }
    try {
      // Branch/remote refs live under .git/refs (recursive on Windows/macOS).
      watchers.push(watch(join(gitDir, 'refs'), { recursive: true, persistent: false }, () => this.notifySoon(cwd)))
    } catch {
      // no refs dir yet — HEAD-only repos still covered by the first watcher
    }
    return watchers
  }

  /** Debounce many fs events from one git operation into one ping. */
  private notifySoon(cwd: string): void {
    const existing = this.debounceTimers.get(cwd)
    if (existing !== undefined) clearTimeout(existing)
    this.debounceTimers.set(cwd, setTimeout(() => {
      this.debounceTimers.delete(cwd)
      const set = this.subscribers.get(cwd)
      if (set === undefined || set.size === 0) return
      for (const subscriber of set) {
        try {
          subscriber.send('refresh')
        } catch {
          // a dead subscriber is dropped on its socket close
        }
      }
    }, DEBOUNCE_MS))
  }
}
