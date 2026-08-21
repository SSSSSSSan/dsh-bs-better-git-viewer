/**
 * Colored, resizable unified-diff viewer. The parent owns the box header
 * (path + close button); this component renders the body: a top drag handle,
 * then a scrollable, line-tinted diff (additions green, deletions red).
 */
import { Fragment, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { displayPath, parseUnifiedDiff } from './parse-diff.ts'
import type { DiffFile, DiffLine } from './parse-diff.ts'
import css from './git-view.module.css'

const DEFAULT_HEIGHT = 200
const MIN_HEIGHT = 80
const MAX_HEIGHT = 560

/** The tag shown next to a file path: added / deleted / renamed / binary. */
function fileTag(file: DiffFile): string | null {
  if (file.binary) return '二进制'
  if (file.oldPath === '/dev/null') return '新增'
  if (file.newPath === '/dev/null') return '删除'
  const from = displayPath(file.oldPath)
  const to = displayPath(file.newPath)
  if (from !== to) return '重命名'
  return null
}

export function DiffBlock(props: { text: string; emptyText?: string; showFileHeaders?: boolean }): ReactNode {
  const { text, emptyText = '(无差异)', showFileHeaders = true } = props
  const parsed = useMemo(() => parseUnifiedDiff(text), [text])
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  const drag = useRef<{ startY: number; startH: number } | null>(null)

  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startY: e.clientY, startH: height }
  }
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return
    const next = drag.current.startH + (e.clientY - drag.current.startY)
    setHeight(Math.min(Math.max(next, MIN_HEIGHT), MAX_HEIGHT))
  }
  const onHandleUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  if (parsed.files.length === 0) {
    return <div className={css.diffEmpty}>{emptyText}</div>
  }

  // Flatten to one row list; every row renders (no cap — the scroll area
  // handles huge diffs). File headers can be hidden when the parent already
  // shows the path (inline per-file diffs), to avoid repeated titles.
  type FlatRow = { key: string; node: ReactNode }
  const all: FlatRow[] = []
  parsed.files.forEach((file, fileIndex) => {
    if (showFileHeaders) all.push({ key: `f${fileIndex}`, node: <FileHeader file={file} /> })
    if (file.binary) return
    file.hunks.forEach((hunk, hunkIndex) => {
      all.push({
        key: `f${fileIndex}h${hunkIndex}`,
        node: <div className={css.diffHunk}>{hunk.header}</div>,
      })
      hunk.lines.forEach((line, lineIndex) => {
        all.push({ key: `f${fileIndex}h${hunkIndex}l${lineIndex}`, node: <DiffLineRow line={line} /> })
      })
    })
  })

  return (
    <div className={css.diffBlock} style={{ height }}>
      <div
        className={css.diffResize}
        title="拖拽调整高度"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
      >
        <span className={css.diffResizeGrip} />
      </div>
      <div className={css.diffScroll}>
        {all.map(row => <Fragment key={row.key}>{row.node}</Fragment>)}
      </div>
    </div>
  )
}

function FileHeader(props: { file: DiffFile }): ReactNode {
  const { file } = props
  const tag = fileTag(file)
  const to = displayPath(file.newPath)
  const from = displayPath(file.oldPath)
  return (
    <div className={css.diffFile}>
      <span className={css.diffFilePath}>{to}</span>
      {from !== to && <span className={css.diffFileOld}>← {from}</span>}
      {tag !== null && (
        <span
          className={css.diffFileTag}
          data-kind={file.binary ? 'binary' : file.oldPath === '/dev/null' ? 'add' : file.newPath === '/dev/null' ? 'del' : 'ren'}
        >
          {tag}
        </span>
      )}
    </div>
  )
}

function DiffLineRow(props: { line: DiffLine }): ReactNode {
  const { line } = props
  const marker: string = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : line.kind === 'ctx' ? ' ' : ''
  return (
    <div className={css.diffLine} data-kind={line.kind}>
      <span className={css.diffMarker}>{marker}</span>
      <span className={css.diffText}>{line.text === '' ? ' ' : line.text}</span>
    </div>
  )
}
