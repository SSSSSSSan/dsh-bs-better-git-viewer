import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverRepos } from '../src/git.ts'

const dirs: string[] = []

async function makeTree(root: string, relative: string[]): Promise<void> {
  for (const rel of relative) {
    await mkdir(join(root, rel), { recursive: true })
  }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('discoverRepos', () => {
  it('finds the cwd repo plus nested repos, skipping exclusions and hidden dirs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bsgit-'))
    dirs.push(root)
    await makeTree(root, [
      '.git',
      'a/.git',
      'node_modules/x/.git',
      '.hidden/.git',
      'deep/b/c/.git',
      'deep/b/c/d/.git', // depth 4 — beyond maxDepth
    ])

    const repos = await discoverRepos(root, { excludes: ['node_modules'], maxDepth: 3 })
    const names = repos.map(repo => ({ name: repo.name, depth: repo.depth }))

    expect(names).toContainEqual({ name: 'bsgit-' + root.slice(root.lastIndexOf('-') + 1), depth: 0 })
    expect(names).toContainEqual({ name: 'a', depth: 1 })
    expect(names).toContainEqual({ name: 'c', depth: 3 })
    expect(names).not.toContainEqual(expect.objectContaining({ name: 'x' })) // node_modules
    expect(names).not.toContainEqual(expect.objectContaining({ name: '.hidden' })) // hidden
    expect(names).not.toContainEqual(expect.objectContaining({ name: 'd' })) // depth 4
  })

  it('walks up to the enclosing repo when cwd is nested inside one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bsgit-'))
    dirs.push(root)
    await makeTree(root, ['.git', 'src/deep'])
    const repos = await discoverRepos(join(root, 'src', 'deep'), { excludes: ['node_modules'] })
    expect(repos).toHaveLength(1)
    expect(repos[0]?.depth).toBe(0)
    expect(repos[0]?.root).toBe(root)
  })
})
