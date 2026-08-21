/**
 * The multi-repo Git panel — READ-ONLY preview (v0.3):
 *
 * Writes are deliberately NOT offered here: commits / staging / discards /
 * branch switches belong to the agent, which performs them in the session
 * (with user confirmation) using its own git tools. This panel only lets you
 * look: discover every git repository under the session workspace (exclude
 * list in `.dsh-bs-git-excludes`), switch the active repo, browse status,
 * open an inline diff per changed file, and walk the commit graph
 * (VSCode-style: lanes + nodes; click a commit to list its changed files,
 * click a file to view that commit's diff).
 *
 * The exclude list (`.dsh-bs-git-excludes` in the session cwd) is edited in
 * the sidebar settings panel (the tab's gear): one directory name per line.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { IconBranchOutline16, IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TabComponentProps } from 'dsh-better-sidebar/client/service'
import { api } from './api.ts'
import type { GitLogEntry, GitRepo, GitStatusEntry } from './api.ts'
import { laneColor, layoutGraph, parseRefs } from './graph.ts'
import type { GraphRow } from './graph.ts'
import { DiffBlock } from './DiffBlock.tsx'
import css from './git-view.module.css'

const LOG_BATCH = 100
const ROW_H = 22
const LANE_W = 12
const NODE_R = 4
/** Radius of the rounded corner where a merge connector meets a lane. */
const MERGE_R = 4

/** Commit-detail panel sizing (drag-resizable, same pattern as the diff block). */
const DETAIL_DEFAULT_HEIGHT = 320
const DETAIL_MIN_HEIGHT = 120
const DETAIL_MAX_HEIGHT = 560

/** Lane spacing is FIXED (small): dynamic widths moved the same lane's line
 *  between rows when the lane count crossed a threshold, breaking the
 *  verticals. A constant spacing keeps every lane column stable. */
function laneWidth(_lanes: number): number {
  return LANE_W
}

/** The XY status letter a row badge shows (X = index, Y = worktree). */
function badgeOf(entry: GitStatusEntry): string {
  const index = entry.xy[0]
  const worktree = entry.xy[1]
  if (index !== undefined && index !== ' ' && index !== '?') return index
  if (worktree !== undefined && worktree !== ' ' && worktree !== '?') return worktree
  return '?'
}

/** Whether the entry carries STAGED (index) changes. */
function isStagedEntry(entry: GitStatusEntry): boolean {
  const index = entry.xy[0]
  return index !== undefined && index !== ' ' && index !== '?'
}

/** Whether the entry carries UNSTAGED (worktree) changes (?? counts too). */
function isUnstagedEntry(entry: GitStatusEntry): boolean {
  if (entry.xy === '??') return true
  const worktree = entry.xy[1]
  return worktree !== undefined && worktree !== ' ' && worktree !== '?'
}

/** '2026-01-02 03:04:05 +0800' -> '01-02 03:04'. */
function shortDate(date: string): string {
  return date.length >= 16 ? date.slice(5, 16) : date
}

export function GitView(props: TabComponentProps): ReactNode {
  const { scope, visible } = props
  const [repos, setRepos] = useState<GitRepo[]>([])
  const [currentRoot, setCurrentRoot] = useState<string | null>(null)
  const [status, setStatus] = useState<{ branch?: string; entries: GitStatusEntry[] } | null>(null)
  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([])
  const [logEnded, setLogEnded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [diffView, setDiffView] = useState<{ path: string; staged: boolean; text: string } | null>(null)
  const [diffLoading, setDiffLoading] = useState<string | null>(null)
  const diffSeq = useRef(0)

  // Commit-graph detail: which commit is expanded, its changed files, and the
  // currently viewed per-file diff for that commit.
  const [commitDetail, setCommitDetail] = useState<{
    hashFull: string
    hash: string
    subject: string
    files: string[]
    loading: boolean
  } | null>(null)
  const [fileDiff, setFileDiff] = useState<{ path: string; text: string; loading: boolean } | null>(null)
  const detailSeq = useRef(0)
  // Commit-detail box height: drag-resizable (default 320px, min 120px, max 560px).
  const [detailHeight, setDetailHeight] = useState(DETAIL_DEFAULT_HEIGHT)
  const detailDrag = useRef<{ startY: number; startH: number } | null>(null)
  // The scrolling log container (lazy-load anchor) and its in-flight guard.
  const listRef = useRef<HTMLDivElement | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingMoreRef = useRef(false)
  // Paging cursor for the commit log. A REF (not state): the value is only
  // consumed by loadMoreLog at call time, and a ref keeps a stale render
  // closure from reading an outdated skip after a reset.
  const logSkipRef = useRef(0)
  // The latest log entries, mirrored into a ref so stable callbacks can read
  // the current list without recreating themselves on every append.
  const logEntriesRef = useRef<GitLogEntry[]>([])
  logEntriesRef.current = logEntries
  // Whether the tab is actually visible. Mirrored into a ref so async callbacks
  // (loadMoreLog completing) can check the LIVE visibility instead of the
  // render-time value they closed over.
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  // Epoch guard: any whole-list reset (repo switch, manual refresh, ws refresh,
  // hash-change reload) bumps this counter; a loadMoreLog that started before
  // the bump discards its result instead of appending stale/offset batches.
  const logEpoch = useRef(0)

  // Remember the user's repo selection per session+cwd; a remembered root
  // that is gone (excluded / deleted / different workspace) falls back to
  // the default behavior on the next load.
  const repoMemoryKey = (): string => `dsh-bs-git:repo:${scope.sessionId}:${scope.cwd ?? ''}`
  const rememberRepo = (root: string | null): void => {
    try {
      if (root === null) localStorage.removeItem(repoMemoryKey())
      else localStorage.setItem(repoMemoryKey(), root)
    } catch {
      // storage unavailable; selection just won't be remembered
    }
  }

  const loadRepos = useCallback(async (): Promise<void> => {
    try {
      const result = await api.reposList(scope)
      setRepos(result.repos)
      // A remembered selection beats the default while the repo still exists.
      let remembered: string | null = null
      try {
        remembered = localStorage.getItem(repoMemoryKey())
      } catch {
        remembered = null
      }
      const rememberedValid = remembered !== null && result.repos.some(repo => repo.root === remembered)
      const next = rememberedValid
        ? remembered
        : (result.current ?? result.repos[0]?.root ?? null)
      setCurrentRoot(prev => (prev !== null && result.repos.some(repo => repo.root === prev) ? prev : next))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [scope.sessionId, scope.cwd])

  const loadAll = useCallback(async (root: string | null): Promise<void> => {
    if (root === null) {
      setStatus(null)
      setLogEntries([])
      setLoading(false)
      return
    }
    const epoch = ++logEpoch.current
    setLoading(true)
    setError(null)
    try {
      const [statusResult, logResult] = await Promise.all([
        api.status(root, scope),
        api.log(root, scope, LOG_BATCH, 0),
      ])
      if (epoch !== logEpoch.current) return // superseded by a newer reset
      setStatus(statusResult)
      setLogEntries(logResult.entries)
      setLogEnded(logResult.entries.length < LOG_BATCH)
      logSkipRef.current = 0
      setDiffView(null)
      setCommitDetail(null)
      setFileDiff(null)
      listRef.current?.scrollTo(0, 0)
    } catch (reason) {
      if (epoch === logEpoch.current) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (epoch === logEpoch.current) setLoading(false)
    }
  }, [scope.sessionId, scope.cwd])

  useEffect(() => { void loadRepos() }, [loadRepos])
  useEffect(() => { void loadAll(currentRoot) }, [currentRoot, loadAll])

  /** Content-only refresh: status + history, keeping the selected repo,
   *  expanded diffs and scroll position intact. Bumps the epoch so an
   *  in-flight loadMoreLog started before it discards its result. */
  const refreshContent = useCallback(async (): Promise<void> => {
    if (currentRoot === null) return
    const epoch = ++logEpoch.current
    try {
      const [statusResult, logResult] = await Promise.all([
        api.status(currentRoot, scope),
        api.log(currentRoot, scope, LOG_BATCH, 0),
      ])
      if (epoch !== logEpoch.current) return
      setStatus(statusResult)
      setLogEntries(logResult.entries)
      setLogEnded(logResult.entries.length < LOG_BATCH)
      logSkipRef.current = 0
    } catch (reason) {
      if (epoch === logEpoch.current) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    }
  }, [currentRoot, scope.sessionId, scope.cwd])

  /** Refresh just the status (worktree changes don't touch .git, so the
   *  watcher never pings for them). Kept separate from the log so returning
   *  to the tab doesn't have to reset the history. */
  const refreshStatus = useCallback(async (): Promise<void> => {
    if (currentRoot === null) return
    try {
      const statusResult = await api.status(currentRoot, scope)
      setStatus(statusResult)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [currentRoot, scope.sessionId, scope.cwd])

  /** Reload the log only when its NEWEST commit changed (new commits, branch
   *  moves, resets). When the tip is unchanged the loaded history stays as-is
   *  — scroll position, expanded commit and loaded batches all survive a tab
   *  switch, which is what makes browsing early commits of a big repo usable. */
  const refreshLogIfChanged = useCallback(async (): Promise<void> => {
    if (currentRoot === null) return
    const epoch = logEpoch.current
    try {
      const result = await api.log(currentRoot, scope, 1, 0)
      if (epoch !== logEpoch.current) return
      const newest = result.entries[0]?.hashFull
      if (newest !== logEntriesRef.current[0]?.hashFull) {
        await loadAll(currentRoot)
      }
    } catch (reason) {
      if (epoch === logEpoch.current) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    }
  }, [currentRoot, scope.sessionId, scope.cwd, loadAll])

  // When the tab becomes visible again (returning from another tab), refresh
  // the repo list + status, and reload the history ONLY if its tip moved —
  // never a blind reset (which would destroy the user's browsing position).
  useEffect(() => {
    if (!visible || currentRoot === null) return
    void loadRepos()
    void refreshStatus()
    void refreshLogIfChanged()
  }, [visible, currentRoot, loadRepos, refreshStatus, refreshLogIfChanged])

  // Git-change WebSocket: the host pings when .git metadata changes under the
  // session cwd (commits, stage/unstage, checkout, branch moves) — debounced,
  // content-only refresh. Purely our own channel; never touches DSH's session
  // event pipeline.
  useEffect(() => {
    if (!visible || currentRoot === null) return undefined
    const url = new URL('/bsgit/ws/changes', location.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const params = new URLSearchParams({ sessionId: scope.sessionId })
    if (scope.cwd !== undefined && scope.cwd !== '') params.set('cwd', scope.cwd)
    url.search = params.toString()
    let socket: WebSocket | null = null
    let closed = false
    let retry: number | undefined
    let timer: number | undefined
    const refreshSoon = (): void => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => { void refreshContent() }, 250)
    }
    const connect = (): void => {
      if (closed) return
      socket = new WebSocket(url.toString())
      socket.onmessage = () => refreshSoon()
      socket.onclose = () => { if (!closed) retry = window.setTimeout(connect, 2000) }
      socket.onerror = () => { socket?.close() }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      if (timer !== undefined) window.clearTimeout(timer)
      socket?.close()
    }
  }, [visible, currentRoot, scope.sessionId, scope.cwd, refreshContent])

  const refresh = (): void => {
    void loadRepos()
    void loadAll(currentRoot)
  }

  const openDiff = async (entry: GitStatusEntry): Promise<void> => {
    if (currentRoot === null) return
    const staged = isStagedEntry(entry)
    if (diffView !== null && diffView.path === entry.path && diffView.staged === staged) {
      setDiffView(null)
      return
    }
    const seq = ++diffSeq.current
    setDiffLoading(entry.path)
    try {
      const result = await api.diff(currentRoot, scope, entry.path, staged)
      if (seq !== diffSeq.current) return
      setDiffView({ path: entry.path, staged, text: result.diff })
    } catch (reason) {
      if (seq !== diffSeq.current) return
      setDiffView({ path: entry.path, staged, text: `(diff failed: ${reason instanceof Error ? reason.message : String(reason)})` })
    } finally {
      if (seq === diffSeq.current) setDiffLoading(null)
    }
  }

  const loadMoreLog = async (): Promise<void> => {
    // Hidden tabs are display:none — never keep fetching for them. This is the
    // guard that stops the "fill the viewport" loop from running wild in the
    // background (scrollHeight is 0 under display:none, so the fill condition
    // is always true).
    if (currentRoot === null || !visibleRef.current || logEnded || loadingMoreRef.current) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    const epoch = logEpoch.current
    const skip = logSkipRef.current + LOG_BATCH
    try {
      const result = await api.log(currentRoot, scope, LOG_BATCH, skip)
      if (epoch !== logEpoch.current) return // a reset happened mid-flight: drop
      setLogEntries(prev => [...prev, ...result.entries])
      setLogEnded(result.entries.length < LOG_BATCH)
      logSkipRef.current = skip
    } catch (reason) {
      if (epoch === logEpoch.current) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }

  /** Lazy load: fetch the next batch when the user scrolls near the bottom. */
  const onListScroll = useCallback((): void => {
    if (!visibleRef.current) return
    const el = listRef.current
    if (el === null || logEnded || loading || loadingMoreRef.current) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
      void loadMoreLog()
    }
  }, [logEnded, loading, loadMoreLog])

  // Fill the tab: keep fetching while the log is shorter than the viewport
  // (no button needed — the list grows until it fills the panel or history
  // ends). GATED on `visible`: under display:none the container reports
  // scrollHeight = clientHeight = 0, so without this check the effect would
  // load every remaining batch while the user is on another tab.
  useEffect(() => {
    if (!visible) return
    const el = listRef.current
    if (el === null || loading || logEnded || loadingMoreRef.current) return
    if (el.scrollHeight - el.clientHeight < 80) void loadMoreLog()
  }, [visible, logEntries.length, logEnded, loading, loadMoreLog])

  /** Toggle a commit's changed-file list; click again to collapse. */
  const openCommit = async (entry: GitLogEntry): Promise<void> => {
    if (currentRoot === null) return
    if (commitDetail !== null && commitDetail.hashFull === entry.hashFull) {
      setCommitDetail(null)
      setFileDiff(null)
      return
    }
    const seq = ++detailSeq.current
    setFileDiff(null)
    setCommitDetail({ hashFull: entry.hashFull, hash: entry.hash, subject: entry.subject, files: [], loading: true })
    try {
      const result = await api.showFiles(currentRoot, scope, entry.hashFull)
      if (seq !== detailSeq.current) return
      setCommitDetail({ hashFull: entry.hashFull, hash: entry.hash, subject: entry.subject, files: result.files, loading: false })
    } catch (reason) {
      if (seq !== detailSeq.current) return
      setError(reason instanceof Error ? reason.message : String(reason))
      setCommitDetail(prev => (prev !== null ? { ...prev, loading: false } : prev))
    }
  }

  /** Toggle a changed file's diff for the expanded commit. */
  const openCommitFile = async (path: string): Promise<void> => {
    if (currentRoot === null || commitDetail === null) return
    if (fileDiff !== null && fileDiff.path === path) {
      setFileDiff(null)
      return
    }
    const seq = ++detailSeq.current
    setFileDiff({ path, text: '', loading: true })
    try {
      const result = await api.showFile(currentRoot, scope, commitDetail.hashFull, path)
      if (seq !== detailSeq.current) return
      setFileDiff({ path, text: result.diff, loading: false })
    } catch (reason) {
      if (seq !== detailSeq.current) return
      setFileDiff({ path, text: `(diff failed: ${reason instanceof Error ? reason.message : String(reason)})`, loading: false })
    }
  }

  const staged = (status?.entries ?? []).filter(isStagedEntry)
  const unstaged = (status?.entries ?? []).filter(isUnstagedEntry)
  const repoName = (root: string | null): string =>
    repos.find(repo => repo.root === root)?.name ?? (root === null ? '—' : root.slice(root.lastIndexOf('\\') + 1))

  const currentBranch = status?.branch
  const rows = useMemo(() => layoutGraph(logEntries, currentBranch), [logEntries, currentBranch])

  /** Drag the commit-detail resize handle to change the box height (120–560px). */
  const onDetailHandleDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    detailDrag.current = { startY: e.clientY, startH: detailHeight }
  }
  const onDetailHandleMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (detailDrag.current === null) return
    const next = detailDrag.current.startH + (e.clientY - detailDrag.current.startY)
    setDetailHeight(Math.min(Math.max(next, DETAIL_MIN_HEIGHT), DETAIL_MAX_HEIGHT))
  }
  const onDetailHandleUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    detailDrag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  // The expanded commit's changed files + per-file diff, rendered inline right
  // under the clicked commit row. Each file's diff expands directly below its
  // own row (no extra header — the path is already in the file row). The box
  // is height-capped and drag-resizable: the header + resize handle stay put,
  // the file list scrolls inside (a commit may touch thousands of files).
  const commitDetailNode = (): ReactNode =>
    commitDetail === null ? null : (
      <div className={css.commitDetail} style={{ height: detailHeight }}>
        <div className={css.diffHeader}>
          <span className={css.commitDetailHash}>{commitDetail.hash}</span>
          <span className={css.commitDetailSubject}>{commitDetail.subject}</span>
          <span className={css.spacer} />
          <button type="button" className={css.iconButton} onClick={() => { setCommitDetail(null); setFileDiff(null) }} title="关闭">✕</button>
        </div>
        <div
          className={css.diffResize}
          title="拖拽调整高度"
          onPointerDown={onDetailHandleDown}
          onPointerMove={onDetailHandleMove}
          onPointerUp={onDetailHandleUp}
        >
          <span className={css.diffResizeGrip} />
        </div>
        <div className={css.commitDetailBody}>
          {commitDetail.loading && <div className={css.statusLine}>加载变更文件…</div>}
          {!commitDetail.loading && commitDetail.files.length === 0 && <div className={css.statusLine}>(无文件变更)</div>}
          {!commitDetail.loading && commitDetail.files.map(path => (
            <Fragment key={path}>
              <div className={css.commitFileRow}>
                <button
                  type="button"
                  className={css.pathButton}
                  onClick={() => { void openCommitFile(path) }}
                  title={path}
                >
                  {path}
                  {fileDiff !== null && fileDiff.path === path && (
                    <span className={css.diffDot}>{fileDiff.loading ? '…' : '▾'}</span>
                  )}
                </button>
              </div>
              {fileDiff !== null && fileDiff.path === path && (
                <div className={css.commitFileDiff}>
                  {fileDiff.loading
                    ? <div className={css.statusLine}>加载中…</div>
                    : <DiffBlock text={fileDiff.text} showFileHeaders={false} />}
                </div>
              )}
            </Fragment>
          ))}
        </div>
      </div>
    )

  return (
    <div className={css.root} data-dsh-bs-git>
      {/* ── Repository bar (fixed) ── */}
      <div className={css.repoBar}>
        <IconBranchOutline16 className={css.repoIcon} />
        <select
          className={css.repoSelect}
          value={currentRoot ?? ''}
          disabled={loading}
          title="选择 git 仓库"
          onChange={event => {
            const value = event.target.value === '' ? null : event.target.value
            setCurrentRoot(value)
            rememberRepo(value)
          }}
        >
          {currentRoot === null && <option value="">（未发现仓库）</option>}
          {repos.map(repo => (
            <option key={repo.root} value={repo.root}>
              {repo.depth === 0 ? '⟰ ' : ''}{repo.name}
            </option>
          ))}
        </select>
        <button type="button" className={css.iconButton} title="刷新" onClick={refresh} disabled={loading}>
          <IconRefreshOutline16 />
        </button>
      </div>
      {error !== null && <div className={css.errorLine}>{error}</div>}

      {/* ── Status (fixed, read-only preview) ── */}
      {loading && <div className={css.statusLine}>加载中…</div>}
      {!loading && currentRoot !== null && (
        <>
          <div className={css.sectionTitle}>
            {repoName(currentRoot)}
            {status?.branch !== undefined && <span className={css.branchTag}>{status.branch}</span>}
          </div>
          {status?.entries.length === 0 && <div className={css.statusLine}>工作区干净 ✓</div>}
          {staged.length > 0 && <StatusSection title="已暂存" entries={staged} onOpenDiff={openDiff} diffLoading={diffLoading} diffView={diffView} />}
          {unstaged.length > 0 && <StatusSection title="未暂存" entries={unstaged} onOpenDiff={openDiff} diffLoading={diffLoading} diffView={diffView} />}
        </>
      )}

      {/* ── Diff preview (fixed) ── */}
      {diffView !== null && (
        <div className={css.diffBox}>
          <div className={css.diffHeader}>
            <span className={css.diffPath}>{diffView.staged ? '(staged) ' : ''}{diffView.path}</span>
            <span className={css.spacer} />
            <button type="button" className={css.iconButton} onClick={() => setDiffView(null)} title="关闭">✕</button>
          </div>
          <DiffBlock text={diffView.text} />
        </div>
      )}

      {/* ── History: commit graph (scrolls + lazy-loads) ── */}
      <div className={css.sectionTitle}>历史</div>
      <div className={css.logList} ref={listRef} onScroll={onListScroll}>
        {rows.map(row => {
          const selected = commitDetail !== null && commitDetail.hashFull === row.commit.hashFull
          return (
            <Fragment key={row.commit.hashFull}>
              <CommitGraphRow
                row={row}
                currentBranch={currentBranch}
                selected={selected}
                onClick={() => { void openCommit(row.commit) }}
              />
              {selected && commitDetailNode()}
            </Fragment>
          )
        })}
        {loadingMore && <div className={css.statusLine}>加载中…</div>}
      </div>
    </div>
  )
}

/** One commit row: SVG lane lines + node + refs + subject. */
function CommitGraphRow(props: {
  row: GraphRow
  currentBranch?: string
  selected: boolean
  onClick: () => void
}): ReactNode {
  const { row, currentBranch, selected, onClick } = props
  const { commit, lanes, cells, above, below, merges, colors } = row
  const refs = parseRefs(commit.refs, currentBranch)
  const nodeLane = cells.indexOf('node')
  const lw = laneWidth(lanes)
  const width = lanes * lw
  // Ref capsules stack VERTICALLY (one per row) so every branch/tag on a
  // commit stays visible. Each chip is 14px tall with a 3px gap, so a row
  // carrying n refs is max(ROW_H, 17n − 3) tall; the SVG lane drawing grows
  // with it (node re-centered at midY), keeping vertical lines continuous
  // across rows of different heights (top/bottom halves meet at row borders).
  const refsStackH = refs.length > 0 ? refs.length * 17 - 3 : 0
  const rowH = Math.max(ROW_H, refsStackH)
  const midY = rowH / 2
  return (
    <div
      className={`${css.graphRow}${selected ? ' ' + css.graphRowSelected : ''}`}
      onClick={onClick}
      title={commit.subject}
      role="button"
    >
      <svg className={css.graphSvg} width={width} height={rowH} style={{ minWidth: width }}>
        {cells.map((cell, j) => {
          if (cell === 'none') return null
          const x = j * lw + lw / 2
          const color = laneColor(colors[j] ?? j)
          const segs: ReactNode[] = []
          // A lane that receives a merge connector: if the lane line passes
          // straight through this row (both above+below), keep the line
          // continuous and let the connector simply meet it; only when the
          // lane starts or ends here (a single side) does the line step aside
          // for a rounded arc, so there is never a gap at the corner.
          const hasConnector = merges.includes(j)
          const passThrough = hasConnector && above[j] && below[j]
          if (hasConnector && !passThrough) {
            if (above[j]) {
              segs.push(<line key="a" x1={x} y1={0} x2={x} y2={midY - MERGE_R} stroke={color} strokeWidth={1.5} />)
            }
            if (below[j]) {
              segs.push(<line key="b" x1={x} y1={midY + MERGE_R} x2={x} y2={rowH} stroke={color} strokeWidth={1.5} />)
            }
          } else {
            if (above[j]) segs.push(<line key="a" x1={x} y1={0} x2={x} y2={midY} stroke={color} strokeWidth={1.5} />)
            if (below[j]) segs.push(<line key="b" x1={x} y1={midY} x2={x} y2={rowH} stroke={color} strokeWidth={1.5} />)
          }
          if (cell === 'node') {
            segs.push(
              <circle
                key="n"
                cx={x}
                cy={midY}
                r={NODE_R}
                fill={color}
                stroke="var(--dsw-alias-bg-layer-1)"
                strokeWidth={1.5}
              />,
            )
          }
          return <g key={j}>{segs}</g>
        })}
        {nodeLane >= 0 && merges.map(j => {
          if (j === nodeLane) return null
          const x1 = nodeLane * lw + lw / 2
          const x2 = j * lw + lw / 2
          const color = laneColor(colors[j] ?? j)
          const dirX = x2 > x1 ? 1 : -1
          const hx = x2 - dirX * MERGE_R
          // Rounded quadratic corner (no SVG arc sweep ambiguity): horizontal
          // run from the node, then a smooth 90° turn into the target lane's
          // line — down when the lane continues below, up when it ends here.
          const dirY = below[j] ? 1 : -1
          const d = `M ${x1} ${midY} H ${hx} Q ${x2} ${midY} ${x2} ${midY + dirY * MERGE_R}`
          return (
            <path
              key={`m${j}`}
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          )
        })}
      </svg>
      <div className={css.graphBody}>
        {refs.length > 0 && (
          <span className={css.graphRefs}>
            {refs.map(ref => (
              <span
                key={ref.name}
                className={ref.head ? css.refChipHead : css.refChip}
                title={ref.head ? `当前分支 / HEAD：${ref.name}` : ref.name}
              >
                {ref.head ? '@' : ''}{ref.name}
              </span>
            ))}
          </span>
        )}
        <span className={css.logSubject}>{commit.subject}</span>
        <span className={css.logMeta}>{commit.author} · {shortDate(commit.date)}</span>
      </div>
    </div>
  )
}

/** A read-only status section: badge + path, click opens the inline diff.
 *  The rows scroll inside a height cap (a worktree can carry thousands of
 *  changes; uncapped rows would push the 历史 section out of view). */
function StatusSection(props: {
  title: string
  entries: GitStatusEntry[]
  onOpenDiff: (entry: GitStatusEntry) => void
  diffLoading: string | null
  diffView: { path: string; staged: boolean; text: string } | null
}): ReactNode {
  const { title, entries, onOpenDiff, diffLoading, diffView } = props
  return (
    <>
      <div className={css.sectionTitle}>{title}</div>
      <div className={css.statusList}>
        {entries.map(entry => (
          <div key={entry.path} className={css.statusRow}>
            <span className={css.statusBadge} data-xy={entry.xy}>{badgeOf(entry)}</span>
            <button
              type="button"
              className={css.pathButton}
              onClick={() => { onOpenDiff(entry) }}
              title={entry.path}
            >
              {entry.path}
              {diffLoading === entry.path && <span className={css.diffDot}>…</span>}
              {diffView !== null && diffView.path === entry.path && <span className={css.diffDot}>▾</span>}
            </button>
          </div>
        ))}
      </div>
    </>
  )
}
