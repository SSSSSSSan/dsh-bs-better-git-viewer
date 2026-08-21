/**
 * dsh-bs-better-git — HOST half.
 *
 * Serves the /bsgit JSON API: repository discovery (every git repo under the
 * session workspace, with an exclude list) plus git commands executed against
 * the system `git` binary. Every route passes the same browser-trust fence as
 * the /api gateway. All operations are conversation-scoped (sessionId + the
 * session's authoritative cwd from the session store).
 */
import { isAbsolute, join, relative } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.webServer merge (route registration) into this program.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { discoverRepos, isGitRepo, status, branches, log, showFiles, showFile, stage, unstage, commit, checkout, discard, diff } from './git.ts'
import { isTrustedApiRequest } from './trust-fence.ts'
import { GitWatchManager } from './git-watch.ts'
import { ApiError, readJsonBody, writeError, writeJson, writeOk } from './wire.ts'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-bs-better-git'

/** Services required before mounting. */
export const inject = ['webServer', 'sessions', 'webRuntime']

/** Structural face of ctx.sessions (host) used by this plugin. */
interface SessionStore {
  get(sessionId: string): { header: { cwd?: string } } | undefined
}

/** Whether `child` is strictly inside `parent` (path-boundary safe). */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Whether a repo root is reachable from the session cwd: the root may be the
 * cwd itself (the workspace root IS a git repo), a directory inside the cwd,
 * or an ancestor of the cwd (walk-up discovery found the enclosing repo).
 */
export function isRepoReachable(cwd: string, repoRoot: string): boolean {
  if (relative(cwd, repoRoot) === '') return true // same dir (case-insensitive on win32)
  if (isWithin(cwd, repoRoot)) return true
  return isWithin(repoRoot, cwd)
}

/** Resolve the session's authoritative cwd (header wins, caller cwd next). */
function sessionCwdOf(ctx: Context, sessionId: string, clientCwd?: string): string {
  const session = (ctx.get('sessions') as SessionStore | undefined)?.get(sessionId)
  const headerCwd = session?.header.cwd
  if (headerCwd !== undefined && headerCwd !== '') return headerCwd
  if (clientCwd !== undefined && clientCwd !== '' && isAbsolute(clientCwd)) return clientCwd
  return process.cwd()
}

/** Validate that a repo root is a real git repo under the session cwd. */
async function assertRepo(ctx: Context, sessionId: string, repoRoot: unknown, clientCwd?: string): Promise<string> {
  if (typeof repoRoot !== 'string' || repoRoot === '') {
    throw new ApiError('bad-request', 'repoRoot is required')
  }
  const cwd = sessionCwdOf(ctx, sessionId, clientCwd)
  if (!isAbsolute(repoRoot) || !isRepoReachable(cwd, repoRoot)) {
    throw new ApiError('forbidden', 'repoRoot is outside the session working directory')
  }
  if (!(await isGitRepo(repoRoot))) {
    throw new ApiError('not-found', 'not a git repository')
  }
  return repoRoot
}

function stringOf(payload: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = payload[key]
  if (typeof value === 'string' && value !== '') return value
  if (required) throw new ApiError('bad-request', `${key} is required`)
  return undefined
}

function booleanOf(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true
}

function numberOf(payload: Record<string, unknown>, key: string, fallback: number): number {
  const value = payload[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** The exclude-list document (one directory name per line, # comments). */
const EXCLUDES_FILE = '.dsh-bs-git-excludes'
const EXCLUDES_DEFAULT = '# 每行一个要排除的目录名（例如 node_modules）。\n# 排除后该目录子树中的 git 仓库不会被发现。\n'

/** Read the exclude list from the doc file in the session cwd. */
async function readExcludesFile(cwd: string): Promise<string[]> {
  try {
    const text = await readFile(join(cwd, EXCLUDES_FILE), 'utf8')
    return text.split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#'))
  } catch {
    return []
  }
}

/** Request handlers keyed by /bsgit/api/<method>. */
function buildApi(ctx: Context): Record<string, (payload: unknown) => Promise<unknown>> {
  return {
    'repos.list': async (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>
      const sessionId = stringOf(record, 'sessionId')!
      const cwd = sessionCwdOf(ctx, sessionId, stringOf(record, 'cwd', false))
      // Exclude sources: built-in node_modules + the doc file in the session cwd.
      const fileExcludes = await readExcludesFile(cwd)
      const repos = await discoverRepos(cwd, { excludes: ['node_modules', ...fileExcludes] })
      return {
        cwd,
        // The repo that contains the session cwd itself (walk-up result, depth 0).
        current: repos.find(repo => repo.depth === 0)?.root ?? null,
        repos,
      }
    },

    'excludes.get': async (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>
      const sessionId = stringOf(record, 'sessionId')!
      const cwd = sessionCwdOf(ctx, sessionId, stringOf(record, 'cwd', false))
      return { excludes: await readExcludesFile(cwd) }
    },

    'excludes.set': async (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>
      const sessionId = stringOf(record, 'sessionId')!
      const cwd = sessionCwdOf(ctx, sessionId, stringOf(record, 'cwd', false))
      const lines = record.lines
      if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string')) {
        throw new ApiError('bad-request', 'lines must be an array of strings')
      }
      const names = (lines as string[]).map(line => line.trim()).filter(line => line !== '')
      // Rewrite the doc file: keep the comment header, then one name per line.
      await writeFile(join(cwd, EXCLUDES_FILE), EXCLUDES_DEFAULT + names.join('\n') + (names.length > 0 ? '\n' : ''), 'utf8')
      return { ok: true }
    },

    'git.status': async (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>
      const sessionId = stringOf(record, 'sessionId')!
      const repoRoot = await assertRepo(ctx, sessionId, record.repoRoot, stringOf(record, 'cwd', false))
      return status(repoRoot)
    },

    'git.branch': async (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>
      const sessionId = stringOf(record, 'sessionId')!
      const repoRoot = await assertRepo(ctx, sessionId, record.repoRoot, stringOf(record, 'cwd', false))
      return branches(repoRoot)
    },

    'git.log': async (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>
      const sessionId = stringOf(record, 'sessionId')!
      const repoRoot = await assertRepo(ctx, sessionId, record.repoRoot, stringOf(record, 'cwd', false))
      const count = Math.max(1, Math.min(200, numberOf(record, 'count', 20)))
      const skip = Math.max(0, numberOf(record, 'skip', 0))
      return { entries: await log(repoRoot, count, skip) }
    },

    'git.showFiles': async (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>
      const sessionId = stringOf(record, 'sessionId')!
      const repoRoot = await assertRepo(ctx, sessionId, record.repoRoot, stringOf(record, 'cwd', false))
      const hash = stringOf(record, 'hash')!
      return { files: await showFiles(repoRoot, hash) }
    },

    'git.showFile': async (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>
      const sessionId = stringOf(record, 'sessionId')!
      const repoRoot = await assertRepo(ctx, sessionId, record.repoRoot, stringOf(record, 'cwd', false))
      const hash = stringOf(record, 'hash')!
      const path = stringOf(record, 'path')!
      return { diff: await showFile(repoRoot, hash, path) }
    },

    'git.stage': async (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>
      const sessionId = stringOf(record, 'sessionId')!
      const repoRoot = await assertRepo(ctx, sessionId, record.repoRoot, stringOf(record, 'cwd', false))
      await stage(repoRoot, stringOf(record, 'path', false))
      return { ok: true }
    },

    'git.unstage': async (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>
      const sessionId = stringOf(record, 'sessionId')!
      const repoRoot = await assertRepo(ctx, sessionId, record.repoRoot, stringOf(record, 'cwd', false))
      await unstage(repoRoot, stringOf(record, 'path', false))
      return { ok: true }
    },

    'git.commit': async (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>
      const sessionId = stringOf(record, 'sessionId')!
      const repoRoot = await assertRepo(ctx, sessionId, record.repoRoot, stringOf(record, 'cwd', false))
      const message = stringOf(record, 'message')!
      await commit(repoRoot, message)
      return { ok: true }
    },

    'git.checkout': async (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>
      const sessionId = stringOf(record, 'sessionId')!
      const repoRoot = await assertRepo(ctx, sessionId, record.repoRoot, stringOf(record, 'cwd', false))
      await checkout(repoRoot, stringOf(record, 'branch')!)
      return { ok: true }
    },

    'git.discard': async (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>
      const sessionId = stringOf(record, 'sessionId')!
      const repoRoot = await assertRepo(ctx, sessionId, record.repoRoot, stringOf(record, 'cwd', false))
      await discard(repoRoot, stringOf(record, 'path')!)
      return { ok: true }
    },

    'git.diff': async (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>
      const sessionId = stringOf(record, 'sessionId')!
      const repoRoot = await assertRepo(ctx, sessionId, record.repoRoot, stringOf(record, 'cwd', false))
      const text = await diff(repoRoot, stringOf(record, 'path', false), booleanOf(record, 'staged'))
      return { diff: text }
    },
  }
}

/** Plugin body. */
export function apply(ctx: Context): void {
  const api = buildApi(ctx)

  const fence = (req: IncomingMessage): boolean =>
    isTrustedApiRequest(req.headers, (ctx.get('webRuntime') as { trustedHosts?: readonly string[] } | undefined)?.trustedHosts ?? [])

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/bsgit/api',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (!fence(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/bsgit/api/') ? pathname.slice('/bsgit/api/'.length) : undefined
      if (method === undefined || method.includes('/')) {
        writeError(res, new ApiError('not-found', 'unknown bsgit API method'))
        return
      }
      try {
        const payload = await readJsonBody(req)
        const handler = api[method]
        if (handler === undefined) {
          throw new ApiError('not-found', `unknown bsgit API method "${method}"`)
        }
        writeOk(res, await handler(payload))
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-bs-better-git: /bsgit/api routes')

  // ── Git-changes WebSocket ────────────────────────────────────────────────
  // The panel's auto-refresh signal: the host watches each repo's .git
  // metadata under the session cwd (fs.watch) and pings subscribers here.
  // Deliberately OUTSIDE the conversation event pipeline — DSH's session
  // events must not be touched by plugins (see the conversationEvents
  // incident), so this is the plugin's own socket.
  const gitWatch = new GitWatchManager()
  const wss = new WebSocketServer({ noServer: true })
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/bsgit/ws/changes',
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!fence(req)) {
        socket.destroy()
        return
      }
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const sessionId = url.searchParams.get('sessionId')
      if (sessionId === null || sessionId === '') {
        socket.destroy()
        return
      }
      const cwd = sessionCwdOf(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
      wss.handleUpgrade(req as unknown as IncomingMessage, socket as unknown as Duplex, head as Buffer, (ws) => {
        const unsub = gitWatch.subscribe(cwd, {
          send: (data) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(data)
          },
        })
        void gitWatch.ensure(cwd)
        ws.on('close', () => unsub())
        ws.on('error', () => unsub())
      })
    },
  }), 'dsh-bs-better-git: git-changes WebSocket')

  // Plugin teardown: drop watchers/timers and the socket server. cordis's
  // apply returns void, so hook the built-in dispose event (its key is not on
  // the typed Events map — assert the structural face).
  ;(ctx as unknown as { on(event: string, listener: () => void): unknown }).on('dispose', () => {
    gitWatch.dispose()
    wss.close()
  })
}
