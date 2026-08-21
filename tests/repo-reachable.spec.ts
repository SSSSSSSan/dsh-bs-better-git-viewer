import { describe, expect, it } from 'vitest'
import { isRepoReachable } from '../src/index.ts'

describe('isRepoReachable', () => {
  it('allows the cwd itself (workspace root IS the repo)', () => {
    expect(isRepoReachable('C:/work/app', 'C:/work/app')).toBe(true)
  })

  it('allows repos inside the cwd', () => {
    expect(isRepoReachable('C:/work/app', 'C:/work/app/packages/lib')).toBe(true)
  })

  it('allows an ancestor repo found by walk-up discovery', () => {
    expect(isRepoReachable('C:/work/app/src', 'C:/work/app')).toBe(true)
  })

  it('rejects repos outside the tree', () => {
    expect(isRepoReachable('C:/work/app', 'C:/other/thing')).toBe(false)
    expect(isRepoReachable('C:/work/app', 'C:/work/other')).toBe(false)
  })
})
