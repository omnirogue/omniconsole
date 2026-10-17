import { afterEach, describe, expect, it } from 'vitest'
import type { SessionFolderOp } from '../../../shared/session-folder-cli'
import {
  largestRelatedGroup,
  renameStewardFolder,
  stewardOwnsFolderName
} from './steward-refile-clusters'
import {
  folder,
  HOUR,
  organizeHarness,
  organizeRow,
  PERSON
} from './steward-organize-test-fixtures'
import { runStewardOrganizePass } from './steward-organize-pass'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()!()
  }
})

const RELATED = new Set(['Checkout A', 'Checkout B', 'Checkout C'])

async function threeRelated() {
  const rows = ['Checkout A', 'Checkout B', 'Checkout C', 'Blog post'].map((title, index) =>
    organizeRow(
      index + 1,
      { title, repoId: 'shop', repoLabel: 'shop' },
      { title, lastActivityAt: index }
    )
  )
  const h = await organizeHarness(rows, [folder('f-ads', 'Ads')], {
    folder: () => ({ path: 'none', p: 0.9 }),
    project: (left, right) => (RELATED.has(left) && RELATED.has(right) ? 0.9 : 0.1)
  })
  cleanups.push(h.cleanup)
  return h
}

describe('a new project folder for related unplaced sessions', () => {
  it('files three related sessions into one steward-named folder, once', async () => {
    const h = await threeRelated()
    const outcome = await runStewardOrganizePass(h.deps)
    expect(outcome.filed).toEqual(['view-1', 'view-2', 'view-3'])
    expect(outcome.unplaced).toEqual(['view-4'])
    expect(h.applied).toHaveLength(1)
    const { plan } = h.applied[0]!
    expect(plan.folders).toEqual([{ create: 'shop · Work on Checkout A' }])
    expect(plan.changes.map((change) => change.folder)).toEqual([
      'shop · Work on Checkout A',
      'shop · Work on Checkout A',
      'shop · Work on Checkout A'
    ])
    // Six ordered reads for three pairs with the blog post, six for the related trio.
    const pairReads = h.calls.filter((request) => request.questions.project).length
    expect(pairReads).toBe(12)

    h.advance(HOUR)
    await runStewardOrganizePass(h.deps)
    expect(h.applied).toHaveLength(1)
    expect(h.calls.filter((request) => request.questions.project)).toHaveLength(pairReads)
  })

  it('lets the steward rename its folder until a person renames it', async () => {
    const h = await threeRelated()
    await runStewardOrganizePass(h.deps)
    const created = h.folders.find((entry) => entry.path === 'shop · Work on Checkout A')!
    const ops: SessionFolderOp[] = []
    const renamer = {
      history: h.deps.history,
      mutateFolder: async (op: SessionFolderOp) => {
        ops.push(op)
      }
    }
    expect(stewardOwnsFolderName(await h.deps.history(`folder:${created.id}`))).toBe(true)
    await renameStewardFolder(renamer, created, 'Checkout', 'a better name')
    expect(ops).toEqual([{ kind: 'renameFolder', folder: created.path, name: 'Checkout' }])

    h.record({
      kind: 'folder.rename',
      targets: [{ folderId: created.id }],
      value: 'My checkout',
      executor: PERSON
    })
    expect(stewardOwnsFolderName(await h.deps.history(`folder:${created.id}`))).toBe(false)
    await expect(renameStewardFolder(renamer, created, 'Other', 'why')).rejects.toThrow(
      'no longer names'
    )
    expect(ops).toHaveLength(1)
  })

  it('stops reading pairs when the day’s budget is spent', async () => {
    const h = await threeRelated()
    h.deps.pairReadsPerDay = () => 2
    const outcome = await runStewardOrganizePass(h.deps)
    expect(outcome.filed).toEqual([])
    expect(h.calls.filter((request) => request.questions.project)).toHaveLength(4)
  })

  it('finds the largest group where every pair is related', () => {
    const pairs = new Set(['a|b', 'a|c', 'b|c', 'c|d'])
    const related = (x: string, y: string) => pairs.has([x, y].toSorted().join('|'))
    expect(largestRelatedGroup(['a', 'b', 'c', 'd'], related)).toEqual(['a', 'b', 'c'])
    expect(largestRelatedGroup(['a', 'c', 'd'], related)).toEqual([])
  })
})
