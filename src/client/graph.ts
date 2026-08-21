import type { GitLogEntry } from './api'

/** How a commit row occupies a single lane column. */
export type GraphCell = 'none' | 'line' | 'node' | 'merge'

/** Layout result for one commit row. */
export interface GraphRow {
  /** The commit this row renders. */
  commit: GitLogEntry
  /** Number of lanes in the row (SVG width = lanes * 16). */
  lanes: number
  /**
   * Snapshot of how many lanes are ACTUALLY in use by this row (non-empty
   * cells — holes/blank columns don't count). This is the number that grows
   * on a branch fork and shrinks on a merge, so the UI can show the lane
   * count correctly following the loaded history.
   */
  activeLanes: number
  /** Per-lane cell kind. `node` appears exactly once. */
  cells: GraphCell[]
  /** Per-lane: draw a vertical segment from the row top to the mid line. */
  above: boolean[]
  /** Per-lane: draw a vertical segment from the mid line to the row bottom. */
  below: boolean[]
  /** Lane indices that connect horizontally to the node at the mid line. */
  merges: number[]
  /**
   * Per-lane palette index. Colors follow the BRANCH FLOW, not the lane
   * number: a commit inherits the color of the lane it continues, so a branch
   * keeps one color even if it weaves between lanes; freed lanes get a
   * fresh color when a new branch takes them over.
   */
  colors: number[]
}

/** Palette for lane colors, index = lane number (cycled). */
export const LANE_PALETTE = [
  '#4f8cff',
  '#3fb950',
  '#e3b341',
  '#f85149',
  '#a371f7',
  '#39c5cf',
  '#d29922',
  '#f778ba',
  '#8b949e',
  '#58a6ff',
]

export function laneColor(lane: number): string {
  return LANE_PALETTE[lane % LANE_PALETTE.length]
}

/**
 * Incremental commit-graph layout. The lane state (cols/active/colColors/
 * nextColor) lives INSIDE the walker, so appending a new batch of commits
 * costs O(batch) instead of re-running the whole O(total) layout 鈥?which
 * matters when the user scrolls deep into a big repository's history.
 *
 * Rows come back in the same order as the appended commits, so row `i`
 * renders `commits[i]` directly. A walker is tied to one `currentBranch`
 * (the fork rule depends on it); rebuild it when the branch changes.
 *
 * Lane management is capped: on a busy history (many branches / merges) the
 * number of simultaneously-waiting lanes can otherwise grow with every paged
 * batch, making each row's SVG balloon. MAX_LANES bounds the width, reusing
 * the rightmost lane for overflow branches; lanes whose awaited parent has
 * ALREADY been processed are closed immediately (the parent can never arrive
 * again). Every row is cached by commit hash and the full row list is kept
 * in `allRows`, so re-laying-out the same sequence is O(1) instead of O(n).
 */
export interface GraphLayoutWalker {
  /** Lay out the next commits (newest-first order). Returns their rows. */
  append(commits: GitLogEntry[]): GraphRow[]
  /** The branch this walker lays out for (fork-rule identity). */
  readonly branch: string | undefined
  /** Every row laid out so far, in append order (replayable in O(1)). */
  readonly allRows: readonly GraphRow[]
}

/** Upper bound on simultaneously drawn lanes; overflow reuses the rightmost
 *  lane (approximate 鈥?the branch line overlaps, colors still distinguish). */
const MAX_LANES = 32

export function createGraphLayout(currentBranch?: string): GraphLayoutWalker {
  // lane -> hash it is waiting for (null = free)
  const cols: (string | null)[] = []
  // per lane: still active after the previous row (a line passes through)
  const active: boolean[] = []
  // per lane: palette index 鈥?colors follow the branch flow, not the lane
  // number (inherited when a commit continues a lane, fresh on a new branch)
  const colColors: number[] = []
  let nextColor = 0
  // Commit-hash-keyed memory: every processed commit (for closing lanes whose
  // awaited parent already arrived) and every laid-out row (for O(1) replays).
  const processed = new Set<string>()
  const rowCache = new Map<string, GraphRow>()
  const allRows: GraphRow[] = []

  const findExpected = (hash: string): number => {
    for (let j = 0; j < cols.length; j++) {
      if (cols[j] === hash) return j
    }
    return -1
  }

  /** Claim a lane for `commit`, honoring the lane cap. Returns the lane index
   *  (may reuse the rightmost lane past MAX_LANES 鈥?an approximation). */
  const claimLane = (commit: GitLogEntry): number => {
    let i = findExpected(commit.hashFull)
    if (i < 0) {
      const first = commit.parents[0]
      const isRefHead = commit.refs !== ''
      const isCurrentHead = isRefHead && currentBranch !== undefined
        && parseRefs(commit.refs, currentBranch).some(ref => ref.head)
      if (first !== undefined && !(isRefHead && !isCurrentHead)) {
        i = findExpected(first)
      }
    }
    if (i < 0) {
      i = cols.findIndex(c => c === null)
      if (i < 0) {
        if (cols.length < MAX_LANES) {
          i = cols.length
          cols.push(null)
          active.push(false)
          colColors.push(nextColor++)
        } else {
          // Lane cap reached: reuse the rightmost lane. The old wait is
          // abandoned (its commit, when it arrives, claims/merges elsewhere),
          // so the row width stays bounded on branch-heavy histories.
          i = cols.length - 1
          colColors[i] = nextColor++
        }
      } else {
        // a freed lane is taken over by a NEW branch flow -> fresh color
        colColors[i] = nextColor++
      }
    }
    return i
  }

  return {
    branch: currentBranch,
    allRows,
    append(commits) {
      const rows: GraphRow[] = []
      // Garbage-collect lanes awaiting a parent that is ALREADY processed 鈥?
      // that commit can never arrive, so the lane would wait forever and
      // inflate the graph width for the rest of the browse session.
      for (let j = 0; j < cols.length; j++) {
        const w = cols[j]
        if (w !== null && processed.has(w)) cols[j] = null
      }
      for (const commit of commits) {
        // Memory-cache hit (replay of the same walker sequence): reuse the
        // cached row instead of re-running the lane state machine.
        const cached = rowCache.get(commit.hashFull)
        if (cached !== undefined) {
          processed.add(commit.hashFull)
          allRows.push(cached)
          rows.push(cached)
          continue
        }
        // 1) claim a lane 鈥?match by FULL hash (parents arrive as full hashes
        //    via %P, while commit.hash is the short 7-char form). Precedence:
        //    a) a lane already waiting for this commit,
        //    b) the lane its FIRST parent is flowing through (a merge commit
        //       continues the main line, it never drops into a side/free lane),
        //    c) the first free lane, else a brand-new lane.
        // A dangling (unmerged) ref head 鈥?e.g. `feature` or `origin/feature` 鈥?
        // whose own child never claims a lane (rule a misses) must FORK into its
        // own lane from the shared parent instead of hugging the main line: only
        // the CURRENT branch head (or a ref-less commit) continues the parent lane.
        const i = claimLane(commit)

        // 2) other lanes waiting for this commit merge into the node
        const merges: number[] = []
        for (let j = 0; j < cols.length; j++) {
          if (j !== i && cols[j] === commit.hashFull) {
            merges.push(j)
            cols[j] = null
          }
        }

        // 3) the first parent continues this lane (write it BEFORE handling extra
        //    parents, so the freed-lane search below cannot grab this lane).
        //    No parents = the lane ends here. A parent that is already
        //    processed can never arrive again, so the lane CLOSES instead of
        //    waiting forever (this is the lane-lifecycle fix: without it,
        //    cross-branch parents left lanes open that never closed).
        const p0 = commit.parents[0]
        cols[i] = p0 === undefined || processed.has(p0) ? null : p0

        // 4) extra parents (merge commits) get or reuse a lane 鈥?prefer a lane
        //    already waiting for the same parent, then a freed lane (so the graph
        //    weaves into holes instead of always growing right), then a new lane.
        for (const p of commit.parents.slice(1)) {
          let j = findExpected(p)
          if (j < 0) {
            j = cols.findIndex(c => c === null)
            if (j < 0) {
              if (cols.length < MAX_LANES) {
                j = cols.length
                cols.push(p)
                active.push(false)
                colColors.push(nextColor++)
              } else {
                j = cols.length - 1
                colColors[j] = nextColor++
              }
            } else {
              cols[j] = p
              colColors[j] = nextColor++
            }
          }
          merges.push(j)
        }

        // 5) build the row cells
        const laneCount = cols.length
        const above: boolean[] = new Array(laneCount)
        const below: boolean[] = new Array(laneCount)
        const cells: GraphCell[] = new Array(laneCount)
        for (let j = 0; j < laneCount; j++) {
          above[j] = active[j] ?? false
          below[j] = cols[j] !== null
          cells[j] =
            j === i
              ? 'node'
              : merges.includes(j)
                ? 'merge'
                : above[j] || below[j]
                  ? 'line'
                  : 'none'
        }

        // 6) persist activity for the next row
        for (let j = 0; j < laneCount; j++) active[j] = below[j]

        // Trim trailing empty lanes: a row's width is its LAST active lane, so
        // sparse early history does not leave blank columns on the right.
        let lastActive = -1
        let activeCount = 0
        for (let j = 0; j < laneCount; j++) {
          if (cells[j] !== 'none') {
            lastActive = j
            activeCount++
          }
        }
        const rowLanes = lastActive + 1

        rows.push({
          commit,
          lanes: rowLanes,
          activeLanes: activeCount,
          cells: cells.slice(0, rowLanes),
          above: above.slice(0, rowLanes),
          below: below.slice(0, rowLanes),
          merges: merges.filter(m => m < rowLanes),
          colors: colColors.slice(0, rowLanes),
        })
        // Commit-hash-keyed memory: cache the laid-out row and mark the commit
        // processed (closes lanes that were waiting for it as a parent).
        rowCache.set(commit.hashFull, rows[rows.length - 1]!)
        processed.add(commit.hashFull)
        allRows.push(rows[rows.length - 1]!)
      }
      return rows
    },
  }
}

/**
 * One-shot convenience layout (equivalent to a fresh walker over the whole
 * list) 鈥?kept for tests and callers that lay out a complete list at once.
 */
export function layoutGraph(commits: GitLogEntry[], currentBranch?: string): GraphRow[] {
  return createGraphLayout(currentBranch).append(commits)
}

export interface RefTag {
  /** Display name without any decorations. */
  name: string
  /** `@` prefix: current branch / HEAD pointer. */
  head: boolean
}

/**
 * Parse `git log --decorate` refs (`%D`) plus the current branch name.
 * Anything naming the current branch or HEAD gets the `@` prefix:
 * `HEAD -> main` -> `@main`, `HEAD` -> `@HEAD`. Tags (`tag: v1.0`) are
 * normalized to their bare name; remote branches stay as-is (`origin/main`).
 */
export function parseRefs(refs: string, currentBranch?: string): RefTag[] {
  if (!refs) return []
  const tags: RefTag[] = []
  const seen = new Set<string>()
  for (const raw of refs.split(',')) {
    const part = raw.trim()
    if (!part) continue
    let name = part
    let head = false
    if (part.startsWith('tag: ')) {
      name = part.slice(5)
    } else if (part.startsWith('HEAD -> ')) {
      name = part.slice('HEAD -> '.length)
      head = true
    } else if (part === 'HEAD') {
      name = 'HEAD'
      head = true
    } else if (currentBranch !== undefined && part === currentBranch) {
      head = true
    }
    if (seen.has(name)) continue
    seen.add(name)
    tags.push({ name, head })
  }
  return tags
}
