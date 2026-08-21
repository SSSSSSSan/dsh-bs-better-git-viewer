import { describe, expect, it } from 'vitest'
import { layoutGraph, parseRefs } from '../src/client/graph.ts'
import type { GitLogEntry } from '../src/client/api.ts'

function commit(hash: string, parents: string[], refs = ''): GitLogEntry {
  return { hash: hash.slice(0, 7), hashFull: hash, subject: `c ${hash}`, author: 'T', date: '2026-01-01 00:00:00 +0800', refs, parents }
}

describe('layoutGraph', () => {
  it('renders a linear history in a single lane', () => {
    const rows = layoutGraph([commit('c3', ['c2']), commit('c2', ['c1']), commit('c1', [])])
    expect(rows.map(r => r.cells)).toEqual([
      ['node'],
      ['node'],
      ['node'],
    ])
    // c3: line below only; c2: line above and below; c1: line above only
    expect(rows[0].above).toEqual([false])
    expect(rows[0].below).toEqual([true])
    expect(rows[1].above).toEqual([true])
    expect(rows[1].below).toEqual([true])
    expect(rows[2].above).toEqual([true])
    expect(rows[2].below).toEqual([false])
  })

  it('puts a merge second parent on its own lane and merges it back', () => {
    // newest-first: M merges A and B; A and B are both children of C.
    const rows = layoutGraph([
      commit('M', ['A', 'B']),
      commit('A', ['C']),
      commit('B', ['C']),
      commit('C', []),
    ])
    // M: node on lane 0, connector to lane 1 (B's lane starts here)
    expect(rows[0].cells).toEqual(['node', 'merge'])
    expect(rows[0].merges).toEqual([1])
    expect(rows[0].below).toEqual([true, true])
    // A: node on lane 0, lane 1 still passes through
    expect(rows[1].cells).toEqual(['node', 'line'])
    expect(rows[1].merges).toEqual([])
    // B: node on lane 1, lane 0 passes through
    expect(rows[2].cells).toEqual(['line', 'node'])
    // C: node on lane 0; lane 1 waited for C and merges into the node
    expect(rows[3].cells).toEqual(['node', 'merge'])
    expect(rows[3].merges).toEqual([1])
    expect(rows[3].below).toEqual([false, false])
  })

  it('reuses a lane already waiting for a merge parent', () => {
    // M2 merges M1 and D; M1 merges A and B; D derives from A; A and B from C.
    const rows = layoutGraph([
      commit('M2', ['M1', 'D']),
      commit('M1', ['A', 'B']),
      commit('D', ['A']),
      commit('A', ['C']),
      commit('B', ['C']),
      commit('C', []),
    ])
    // M2: node lane 0, connector to lane 1 (D's lane opens here)
    expect(rows[0].cells).toEqual(['node', 'merge'])
    expect(rows[0].merges).toEqual([1])
    // M1: node lane 0, lane 1 passes (D still waiting), connector to lane 2 (B)
    expect(rows[1].cells).toEqual(['node', 'line', 'merge'])
    expect(rows[1].merges).toEqual([2])
    // D: node on lane 1
    expect(rows[2].cells).toEqual(['line', 'node', 'line'])
    // A: node lane 0; lane 1 also waited for A and merges into the node
    expect(rows[3].cells).toEqual(['node', 'merge', 'line'])
    expect(rows[3].merges).toEqual([1])
    // B: node on lane 2 (lane 1 already closed)
    expect(rows[4].cells).toEqual(['line', 'none', 'node'])
    // C: node lane 0; lane 2 waited for C and merges in
    expect(rows[5].cells).toEqual(['node', 'none', 'merge'])
    expect(rows[5].merges).toEqual([2])
  })

  it('keeps every row in input order', () => {
    const commits = [commit('M', ['A', 'B']), commit('A', ['C']), commit('B', ['C']), commit('C', [])]
    const rows = layoutGraph(commits)
    expect(rows.map(r => r.commit.hash)).toEqual(['M', 'A', 'B', 'C'])
  })

  it('matches lanes by full hash (short hash in log, full hashes in parents)', () => {
    // Regression: parents arrive from %P as FULL hashes, commit.hash is the
    // 7-char short form — the lane matcher must compare hashFull.
    const fullA = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const fullB = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    const rows = layoutGraph([commit(fullA, [fullB]), commit(fullB, [])])
    expect(rows[0].commit.hash).toBe(fullA.slice(0, 7))
    expect(rows[0].cells).toEqual(['node'])
    expect(rows[0].above).toEqual([false])
    expect(rows[0].below).toEqual([true])
    expect(rows[1].cells).toEqual(['node'])
    expect(rows[1].above).toEqual([true])
    expect(rows[1].below).toEqual([false])
  })

  it('weaves a merge second parent into a freed lane instead of growing right', () => {
    // Regression (real dsh-better-sidebar history): a merge's extra parent
    // must reuse a lane freed by an earlier merge closure — the graph weaves
    // into holes, never blindly widening.
    const rows = layoutGraph([
      commit('M1', ['A', 'S1']),
      commit('A', ['C']),
      commit('S1', ['C']),
      commit('C', []),
      commit('M2', ['B', 'S2']),
      commit('B', ['D']),
      commit('S2', ['D']),
      commit('D', []),
    ])
    // M1: lane0=A, S1 lane1; C root merges lane1 in; lanes [null, null]
    // M2: claims lane0 (first free), S2 weaves into freed lane1
    expect(rows[4].cells).toEqual(['node', 'merge'])
    expect(rows[4].merges).toEqual([1])
    expect(rows[6].cells[1]).toBe('node') // S2 on lane1
    expect(rows[7].lanes).toBe(2)         // never grew past 2 lanes
  })

  it('keeps a branch color stable while the flow continues', () => {
    const rows = layoutGraph([
      commit('M', ['A', 'S']),
      commit('A', ['B']),
      commit('B', ['C']),
      commit('S', ['C']),
      commit('C', []),
    ])
    const main = rows[0].colors[0]
    expect(rows[0].colors[1]).not.toBe(main) // side branch: fresh color
    expect(rows[1].colors[0]).toBe(main)     // A continues the flow
    expect(rows[2].colors[0]).toBe(main)     // B continues the flow
    expect(rows[3].colors[1]).not.toBe(main) // S stays on its own branch color
    expect(rows[4].colors[0]).toBe(main)     // C (root) still the main line
  })

  it('gives a fresh color when a freed lane is taken over by a new branch', () => {
    const rows = layoutGraph([
      commit('M1', ['A', 'S1']),
      commit('A', ['C']),
      commit('S1', ['C']),
      commit('C', []),
      commit('M2', ['B', 'S2']),
      commit('B', ['D']),
      commit('S2', ['D']),
      commit('D', []),
    ])
    expect(rows[0].colors[0]).toBe(0)
    expect(rows[0].colors[1]).toBe(1)
    const m2 = rows[4].colors[0]
    expect(m2).not.toBe(0)                // freed lane0: new flow color
    expect(rows[5].colors[0]).toBe(m2)    // B continues M2's flow
    expect(rows[6].colors[1]).not.toBe(1) // freed lane1 taken by S2: fresh color
  })

  it('keeps one color for a branch that merged and kept developing', () => {
    // B merged into master (M's second parent is Btip) and B got a new commit
    // B2 afterwards (B2 is HEAD). The B lane must keep its color across the
    // merge row, and the merge connector uses that same branch color.
    const rows = layoutGraph([
      commit('B2', ['Btip']),
      commit('M', ['A', 'Btip']),
      commit('A', ['C']),
      commit('Btip', ['C']),
      commit('C', []),
    ])
    const bColor = rows[0].colors[0]           // B2 opens the B lane
    expect(rows[1].cells[0]).toBe('merge')     // M's connector targets B lane
    expect(rows[1].colors[0]).toBe(bColor)     // connector lane = B color
    expect(rows[3].colors[0]).toBe(bColor)     // Btip still on the B lane
    expect(rows[1].colors[1]).not.toBe(bColor) // master lane: different color
  })

  it('merge node keeps the main color, connector uses the branch color', () => {
    const rows = layoutGraph([
      commit('M', ['A', 'Btip']),
      commit('A', ['C']),
      commit('Btip', ['C']),
      commit('C', []),
    ])
    const main = rows[0].colors[0]                    // M node = main line
    expect(rows[0].cells).toEqual(['node', 'merge'])
    expect(rows[0].colors[1]).not.toBe(main)          // branch lane: its own
    expect(rows[2].colors[1]).toBe(rows[0].colors[1]) // Btip keeps branch color
  })

  it('forks a dangling (unmerged) branch head into its own lane', () => {
    // main head A (HEAD -> main) continues lane 0; the unmerged branch head B
    // (refs 'feature') must fork into a NEW lane from the shared parent P —
    // not sit on the main line.
    const rows = layoutGraph([
      commit('A', ['P'], 'HEAD -> main'),
      commit('B', ['P'], 'feature'),
      commit('P', []),
    ], 'main')
    expect(rows[0].cells[0]).toBe('node')        // A on lane 0 (main line)
    expect(rows[1].cells[0]).toBe('line')        // lane 0 passes through B's row
    expect(rows[1].cells[1]).toBe('node')        // B forks into its own lane
    expect(rows[2].cells).toEqual(['node', 'merge']) // P claims lane 0, B lane merges
  })

  it('keeps the current branch head on the main line even with other refs', () => {
    // A is the current branch head AND carries a tag; it must still continue
    // the parent lane (no fork) while the dangling branch B forks.
    const rows = layoutGraph([
      commit('A', ['P'], 'HEAD -> main, tag: v1.0'),
      commit('B', ['P'], 'feature'),
      commit('P', []),
    ], 'main')
    expect(rows[0].cells).toEqual(['node'])
    expect(rows[1].cells[1]).toBe('node')        // B forked
  })
})

describe('parseRefs', () => {
  it('marks the current branch and HEAD with @', () => {
    expect(parseRefs('HEAD -> main, origin/main', 'main')).toEqual([
      { name: 'main', head: true },
      { name: 'origin/main', head: false },
    ])
  })

  it('marks detached HEAD', () => {
    expect(parseRefs('HEAD, tag: v1.0')).toEqual([
      { name: 'HEAD', head: true },
      { name: 'v1.0', head: false },
    ])
  })

  it('returns nothing for empty refs', () => {
    expect(parseRefs('')).toEqual([])
  })
})
