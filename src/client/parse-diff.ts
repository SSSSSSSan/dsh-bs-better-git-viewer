/**
 * Minimal unified-diff parser for git output (`git diff`, `git show <hash> --
 * <path>`). Handles single-file, multi-file, root, renamed, binary and
 * combined (`diff --cc` / `@@@`) formats — enough to render a colored,
 * resizable diff pane.
 */

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'meta'

export interface DiffLine {
  kind: DiffLineKind
  /** Line body without the +/-/space marker (meta keeps its full text). */
  text: string
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  oldPath: string
  newPath: string
  binary: boolean
  added: boolean
  deleted: boolean
  hunks: DiffHunk[]
}

export interface ParsedDiff {
  files: DiffFile[]
}

/** Strip the `a/` / `b/` prefix git puts on diff paths (not on /dev/null). */
export function displayPath(path: string): string {
  if (path === '/dev/null') return path
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2)
  return path
}

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let hunk: DiffHunk | null = null

  const closeHunk = (): void => {
    hunk = null
  }

  const newFile = (): DiffFile => {
    const file: DiffFile = { oldPath: '', newPath: '', binary: false, added: false, deleted: false, hunks: [] }
    files.push(file)
    return file
  }

  for (const raw of diff.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw
    if (line.startsWith('diff --git ')) {
      closeHunk()
      current = newFile()
      const m = line.match(/^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/)
      if (m !== null) {
        current.oldPath = m[1] ?? ''
        current.newPath = m[2] ?? ''
      }
      continue
    }
    // Merge commits: `git show` emits `diff --cc <path>` / `diff --combined`.
    if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      closeHunk()
      current = newFile()
      current.newPath = line.slice(line.startsWith('diff --cc ') ? 'diff --cc '.length : 'diff --combined '.length).trim()
      current.oldPath = current.newPath
      continue
    }
    if (current === null) continue // preamble before the first file section
    if (line.startsWith('--- ')) {
      closeHunk()
      current.oldPath = line.slice(4)
      if (current.oldPath === '/dev/null') current.added = true
      continue
    }
    if (line.startsWith('+++ ')) {
      current.newPath = line.slice(4)
      if (current.newPath === '/dev/null') current.deleted = true
      continue
    }
    if (line.startsWith('@@')) {
      closeHunk()
      hunk = { header: line, lines: [] }
      current.hunks.push(hunk)
      continue
    }
    if (line.startsWith('Binary files ')) {
      closeHunk()
      current.binary = true
      continue
    }
    if (hunk === null) continue // meta outside hunks (index / mode / rename / similarity)
    if (line === '') continue // the trailing newline split
    const marker = line[0] ?? ''
    const body = line.slice(1)
    if (marker === '+') hunk.lines.push({ kind: 'add', text: body })
    else if (marker === '-') hunk.lines.push({ kind: 'del', text: body })
    else if (marker === ' ') hunk.lines.push({ kind: 'ctx', text: body })
    else hunk.lines.push({ kind: 'meta', text: line }) // `\ No newline at end of file`
  }
  closeHunk()
  return { files }
}

/** Total rendered rows across all files (cap the UI with this). */
export function countDiffRows(parsed: ParsedDiff): number {
  let n = 0
  for (const file of parsed.files) {
    n += 1 // file header
    if (file.binary) continue
    for (const h of file.hunks) n += 1 + h.lines.length
  }
  return n
}
