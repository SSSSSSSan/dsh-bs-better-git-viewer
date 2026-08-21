/**
 * Typed fetch wrapper over the plugin's own /bsgit JSON API (host half).
 * Same-origin, no token — only the Host/Origin trust fence.
 */

export interface GitRepo {
  root: string
  name: string
  depth: number
}

export interface GitStatusEntry {
  path: string
  /** Two-letter index/worktree status (X Y), e.g. 'M ', ' M', 'A ', '??'. */
  xy: string
}

export interface GitStatusResult {
  isRepo: boolean
  branch?: string
  entries: GitStatusEntry[]
}

export interface GitLogEntry {
  hash: string
  hashFull: string
  subject: string
  author: string
  date: string
  refs: string
  parents: string[]
}

/** One request's session scope. */
export interface SessionScope {
  sessionId: string
  cwd?: string
}

export class BsGitApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/bsgit/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (error) {
    throw new BsGitApiError('network', error instanceof Error ? error.message : String(error))
  }
  const parsed: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } | null
    = await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new BsGitApiError(
      parsed?.error?.code ?? 'http',
      parsed?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  return parsed.value as T
}

function scopePayload(scope: SessionScope, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: scope.sessionId,
    ...(scope.cwd !== undefined && scope.cwd !== '' ? { cwd: scope.cwd } : {}),
    ...extra,
  }
}

/** The /bsgit API surface. */
export const api = {
  reposList: (scope: SessionScope, signal?: AbortSignal) =>
    call<{ cwd: string; current: string | null; repos: GitRepo[] }>('repos.list', scopePayload(scope, {}), signal),
  /** Read the current exclude list (one directory name per line, comments stripped). */
  excludesGet: (scope: SessionScope, signal?: AbortSignal) =>
    call<{ excludes: string[] }>('excludes.get', scopePayload(scope, {}), signal),
  /** Rewrite the exclude list (one directory name per line). */
  excludesSet: (scope: SessionScope, lines: string[]) =>
    call<{ ok: true }>('excludes.set', scopePayload(scope, { lines })),
  status: (repoRoot: string, scope: SessionScope, signal?: AbortSignal) =>
    call<GitStatusResult>('git.status', scopePayload(scope, { repoRoot }), signal),
  branches: (repoRoot: string, scope: SessionScope, signal?: AbortSignal) =>
    call<{ current: string; names: string[] }>('git.branch', scopePayload(scope, { repoRoot }), signal),
  log: (repoRoot: string, scope: SessionScope, count: number, skip: number, signal?: AbortSignal) =>
    call<{ entries: GitLogEntry[] }>('git.log', scopePayload(scope, { repoRoot, count, skip }), signal),
  showFiles: (repoRoot: string, scope: SessionScope, hash: string, signal?: AbortSignal) =>
    call<{ files: string[] }>('git.showFiles', scopePayload(scope, { repoRoot, hash }), signal),
  showFile: (repoRoot: string, scope: SessionScope, hash: string, path: string, signal?: AbortSignal) =>
    call<{ diff: string }>('git.showFile', scopePayload(scope, { repoRoot, hash, path }), signal),
  stage: (repoRoot: string, scope: SessionScope, path?: string) =>
    call<{ ok: true }>('git.stage', scopePayload(scope, { repoRoot, ...(path !== undefined ? { path } : {}) })),
  unstage: (repoRoot: string, scope: SessionScope, path?: string) =>
    call<{ ok: true }>('git.unstage', scopePayload(scope, { repoRoot, ...(path !== undefined ? { path } : {}) })),
  commit: (repoRoot: string, scope: SessionScope, message: string) =>
    call<{ ok: true }>('git.commit', scopePayload(scope, { repoRoot, message })),
  checkout: (repoRoot: string, scope: SessionScope, branch: string) =>
    call<{ ok: true }>('git.checkout', scopePayload(scope, { repoRoot, branch })),
  discard: (repoRoot: string, scope: SessionScope, path: string) =>
    call<{ ok: true }>('git.discard', scopePayload(scope, { repoRoot, path })),
  diff: (repoRoot: string, scope: SessionScope, path: string | undefined, staged: boolean, signal?: AbortSignal) =>
    call<{ diff: string }>('git.diff', scopePayload(scope, { repoRoot, ...(path !== undefined ? { path } : {}), staged }), signal),
}
