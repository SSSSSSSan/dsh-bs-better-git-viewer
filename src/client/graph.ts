import type { GitLogEntry } from './api'

/** How a commit row occupies a single lane column. */
export type GraphCell = 'none' | 'line' | 'node' | 'merge'

/** Layout result for one commit row. */
export interface GraphRow {
  /** The commit this row renders. */
  commit: GitLogEntry
  /** Number of lanes in the row (SVG width = lanes * 16). */
  lanes: number
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
   * keeps one color even when it weaves between lanes; freed lanes get a
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
 * costs O(batch) instead of re-running the whole O(total) layout — which
 * matters when the user scrolls deep into a big repository's history.
 *
 * Rows come back in the same order as the appended commits, so row `i`
 * renders `commits[i]` directly. A walker is tied to one `currentBranch`
 * (the fork rule depends on it); rebuild it when the branch changes.
 */
export interface GraphLayoutWalker {
  /** Lay out the next commits (newest-first order). Returns their rows. */
  append(commits: GitLogEntry[]): GraphRow[]
}

export function createGraphLayout(currentBranch?: string): GraphLayoutWalker {
  // lane -> hash it is waiting for (null = free)
  const cols: (string | null)[] = []
  // per lane: still active after the previous row (a line passes through)
  const active: boolean[] = []
  // per lane: palette index — colors follow the branch flow, not the lane
  // number (inherited when a commit continues a lane, fresh on a new branch)
  const colColors: number[] = []
  let nextColor = 0

  const findExpected = (hash: string): number => {
    for (let j = 0; j < cols.length; j++) {
      if (cols[j] === hash) return j
    }
    return -1
  }

  return {
    append(commits) {
      const rows: GraphRow[] = []
      for (const commit of commits) {
        // 1) claim a lane — match by FULL hash (parents arrive as full hashes
        //    via %P, while commit.hash is the short 7-char form). Precedence:
        //    a) a lane already waiting for this commit,
        //    b) the lane its FIRST parent is flowing through (a merge commit
        //       continues the main line, it never drops into a side/free lane),
        //    c) the first free lane, else a brand-new lane.
        // A dangling (unmerged) ref head — e.g. `feature` or `origin/feature` —
        // whose own child never claims a lane (rule a misses) must FORK into its
        // own lane from the shared parent instead of hugging the main line: only
        // the CURRENT branch head (or a ref-less commit) continues the parent lane.
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
            i = cols.length
            cols.push(null)
            active.push(false)
            colColors.push(nextColor++)
          } else {
            // a freed lane is taken over by a NEW branch flow -> fresh color
            colColors[i] = nextColor++
          }
        }

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
        //    No parents = the lane ends here.
        cols[i] = commit.parents[0] ?? null

        // 4) extra parents (merge commits) get or reuse a lane — prefer a lane
        //    already waiting for the same parent, then a freed lane (so the graph
        //    weaves into holes instead of always growing right), then a new lane.
        for (const p of commit.parents.slice(1)) {
          let j = findExpected(p)
          if (j < 0) {
            j = cols.findIndex(c => c === null)
            if (j < 0) {
              j = cols.length
              cols.push(p)
              active.push(false)
              colColors.push(nextColor++)
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
        for (let j = 0; j < laneCount; j++) {
          if (cells[j] !== 'none') lastActive = j
        }
        const rowLanes = lastActive + 1

        rows.push({
          commit,
          lanes: rowLanes,
          cells: cells.slice(0, rowLanes),
          above: above.slice(0, rowLanes),
          below: below.slice(0, rowLanes),
          merges: merges.filter(m => m < rowLanes),
          colors: colColors.slice(0, rowLanes),
        })
      }
      return rows
    },
  }
}

/**
 * One-shot convenience layout (equivalent to a fresh walker over the whole
 * list) — kept for tests and callers that lay out a complete list at once.
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
