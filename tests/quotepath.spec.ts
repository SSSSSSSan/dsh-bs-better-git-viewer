/**
 * Regression: git's default `core.quotepath=true` renders non-ASCII paths
 * (Chinese filenames, …) as C-style octal escapes (`"\344\270\255..."`) in
 * line-oriented outputs. runGit must set `core.quotepath=false` so the
 * panel receives raw UTF-8 paths — the commit changed-file list
 * (`showFiles`, diff-tree) is the surface where this used to show up.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { showFiles, status } from '../src/git.ts'

/** `\ooo` octal escape — the form git uses when core.quotepath is on. */
const OCTAL_ESCAPE = /\\[0-7]{3}/

let dir: string

function git(args: string[], cwd: string = dir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bsgit-quotepath-'))
  git(['init', '-q'])
  git(['config', 'user.email', 't@t.t'])
  git(['config', 'user.name', 't'])
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('non-ASCII paths arrive unescaped', () => {
  it('showFiles (commit changed-file list) returns raw UTF-8 names', async () => {
    // Two commits: diff-tree is a no-op for the root commit, so the Chinese
    // name must live in a non-root commit for this surface to list it.
    writeFileSync(join(dir, 'base.txt'), 'base', 'utf8')
    git(['add', '-A'])
    git(['commit', '-qm', 'base'])
    writeFileSync(join(dir, '中文文件.txt'), 'hello', 'utf8')
    git(['add', '-A'])
    git(['commit', '-qm', 'add chinese'])

    const files = await showFiles(dir, git(['rev-parse', 'HEAD']))
    expect(files).toEqual(['中文文件.txt'])
    expect(files.some(path => OCTAL_ESCAPE.test(path))).toBe(false)
  })

  it('status returns raw UTF-8 names for untracked and modified entries', async () => {
    writeFileSync(join(dir, '新增中文.md'), 'x', 'utf8')
    const untracked = await status(dir)
    expect(untracked.entries.map(entry => entry.path)).toContain('新增中文.md')
    expect(untracked.entries.some(entry => OCTAL_ESCAPE.test(entry.path))).toBe(false)

    writeFileSync(join(dir, '新增中文.md'), 'modified', 'utf8')
    git(['add', '-A'])
    git(['commit', '-qm', 'add chinese'])
    writeFileSync(join(dir, '新增中文.md'), 'dirty', 'utf8')
    const modified = await status(dir)
    expect(modified.entries.map(entry => entry.path)).toContain('新增中文.md')
    expect(modified.entries.some(entry => OCTAL_ESCAPE.test(entry.path))).toBe(false)
  })
})
