import { describe, expect, it } from 'vitest'
import { countDiffRows, displayPath, parseUnifiedDiff } from '../src/client/parse-diff.ts'

describe('parseUnifiedDiff', () => {
  it('parses a single-file edit into hunks with typed lines', () => {
    const out = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index abc1234..def5678 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' keep this',
      '-drop this',
      '+add this',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    const parsed = parseUnifiedDiff(out)
    expect(parsed.files).toHaveLength(1)
    const file = parsed.files[0]
    expect(file.oldPath).toBe('a/src/a.ts')
    expect(file.newPath).toBe('b/src/a.ts')
    expect(file.added).toBe(false)
    expect(file.deleted).toBe(false)
    expect(file.hunks).toHaveLength(1)
    expect(file.hunks[0].header).toBe('@@ -1,3 +1,4 @@')
    expect(file.hunks[0].lines).toEqual([
      { kind: 'ctx', text: 'keep this' },
      { kind: 'del', text: 'drop this' },
      { kind: 'add', text: 'add this' },
      { kind: 'meta', text: '\\ No newline at end of file' },
    ])
  })

  it('marks new / deleted files and renames', () => {
    const added = parseUnifiedDiff('diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n')
    expect(added.files[0].added).toBe(true)
    expect(added.files[0].deleted).toBe(false)

    const removed = parseUnifiedDiff('diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n')
    expect(removed.files[0].deleted).toBe(true)
    expect(removed.files[0].added).toBe(false)

    const renamed = parseUnifiedDiff('diff --git "a/old name.txt" "b/new name.txt"\nsimilarity index 100%\nrename from old name.txt\nrename to new name.txt')
    const file = renamed.files[0]
    expect(displayPath(file.oldPath)).toBe('old name.txt')
    expect(displayPath(file.newPath)).toBe('new name.txt')
  })

  it('marks binary files', () => {
    const parsed = parseUnifiedDiff('diff --git a/img.png b/img.png\nindex 0000000..abc1234 100644\nBinary files a/img.png and b/img.png differ\n')
    expect(parsed.files[0].binary).toBe(true)
    expect(parsed.files[0].hunks).toHaveLength(0)
  })

  it('handles multiple files and combined (merge) diffs', () => {
    const out = [
      'diff --git a/x b/x',
      'index 111..222 100644',
      '--- a/x',
      '+++ b/x',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --cc merged.txt',
      'index 111,222..333',
      '@@@ -1,1 -1,1 +1,1 @@@',
      '  context',
      '--left',
      '++right',
      '',
    ].join('\n')
    const parsed = parseUnifiedDiff(out)
    expect(parsed.files).toHaveLength(2)
    expect(parsed.files[1].newPath).toBe('merged.txt')
    expect(parsed.files[1].hunks[0].lines).toEqual([
      { kind: 'ctx', text: ' context' },
      { kind: 'del', text: '-left' },
      { kind: 'add', text: '+right' },
    ])
  })

  it('counts rows for the cap', () => {
    const out = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '+c',
      '',
    ].join('\n')
    expect(countDiffRows(parseUnifiedDiff(out))).toBe(1 + 1 + 3)
  })

  it('returns no files for empty input', () => {
    expect(parseUnifiedDiff('').files).toHaveLength(0)
  })
})
