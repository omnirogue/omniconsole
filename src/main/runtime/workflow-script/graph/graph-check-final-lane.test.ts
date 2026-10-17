import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGraphChecker } from './graph-check'
import {
  NODE,
  VALUE_TWO,
  laneLanes,
  lanePatchCheck,
  laneRepository,
  withDiff,
  type LaneRepository
} from './graph-check-lane.test-fixtures'
import type { GraphJevStore } from './graph-jev-store'
import type { GraphCall } from './graph-plan-types'

const made: LaneRepository[] = []
afterEach(async () => {
  await Promise.all(made.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })))
})

describe('the final test runs in fresh private copies', () => {
  it('never reuses a copy an earlier version was tested in, nor lends its own out', async () => {
    const repo = await laneRepository()
    made.push(repo)
    const lanes = laneLanes(repo)
    const folder = join(repo.parent, 'run', 'lanes')
    await lanePatchCheck(lanes, { candidate: withDiff(VALUE_TWO) })
    // The version's test left a file in copy 0; a reused copy would have been reset first.
    expect(await readFile(join(folder, '0', 'stray.txt'), 'utf8')).toBe('left by the test')
    const final = await lanePatchCheck(lanes, {
      command: `${NODE} test.mjs {case}`,
      candidate: withDiff(VALUE_TWO),
      cases: ['kept-one', 'kept-two'],
      sealed: true
    })
    expect(final).toMatchObject({ passed: true, cases: { total: 2, passed: 2, unavailable: 0 } })
    expect(final.detail).toContain('2 of 2 kept-back cases passed.')
    expect(await readFile(join(folder, '0', 'stray.txt'), 'utf8')).toBe('left by the test')
    // Its copy is removed, not returned: the next version reuses copy 0, never copy 1.
    await vi.waitFor(() => expect(existsSync(join(folder, '1'))).toBe(false))
    await lanePatchCheck(lanes, { candidate: 'No change', unchanged: true })
    expect(existsSync(join(folder, '1'))).toBe(false)
    expect(existsSync(join(folder, '2'))).toBe(false)
    await lanes.dispose()
  })

  it('replays a recorded final test and never runs one that is not recorded', async () => {
    const records = new Map<string, unknown>()
    const store = {
      read: (id: string) => records.get(id),
      write: (id: string, value: unknown) => records.set(id, value),
      remove: (id: string) => records.delete(id)
    } as unknown as GraphJevStore
    const run = vi.fn()
    const checker = createGraphChecker({ store, starts: store, cacheOnly: true, run })
    const call = {
      id: 'improve/final/best/check',
      check: { command: 'npm test', candidate: 'x', cases: ['kept'], sealed: true }
    } as unknown as GraphCall
    await expect(checker(call)).rejects.toThrow('Check is not recorded: improve/final/best/check')
    expect(run).not.toHaveBeenCalled()
  })
})
