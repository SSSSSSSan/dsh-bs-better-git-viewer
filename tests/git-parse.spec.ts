import { describe, expect, it } from 'vitest'
import { parseLogLines, parsePorcelainZ } from '../src/git.ts'

describe('parsePorcelainZ', () => {
  it('parses simple entries with XY status', () => {
    const out = ' M src/a.ts\u0000?? new-file.txt\u0000'
    const entries = parsePorcelainZ(out)
    expect(entries).toEqual([
      { path: 'src/a.ts', xy: ' M' },
      { path: 'new-file.txt', xy: '??' },
    ])
  })

  it('collapses rename pairs to the new path', () => {
    // porcelain -z: first NUL field carries status + NEW path, next field is the origin.
    const out = 'R  new.ts\u0000old.ts\u0000'
    const entries = parsePorcelainZ(out)
    expect(entries).toEqual([{ path: 'new.ts', xy: 'R ' }])
  })
})

describe('parseLogLines', () => {
  it('parses one row per line with unit separators', () => {
    const out = 'abc1234\u001fFix thing\u001fAlice\u001f2026-01-01 10:00:00 +0800\u001fABC1234FULL\u001fHEAD -> main, origin/main\u001fPARENT1FULL parent2\n'
    const rows = parseLogLines(out)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      hash: 'abc1234',
      subject: 'Fix thing',
      author: 'Alice',
      hashFull: 'ABC1234FULL',
      refs: 'HEAD -> main, origin/main',
      parents: ['PARENT1FULL', 'parent2'],
    })
  })

  it('parses a root commit with no parents', () => {
    const out = 'abc1234\u001fInit\u001fBob\u001f2026-01-01 10:00:00 +0800\u001fABC1234FULL\u001f\u001f\n'
    const rows = parseLogLines(out)
    expect(rows[0].parents).toEqual([])
  })
})
