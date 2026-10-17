import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionTidyRow } from '../../shared/session-manage-types'
import { unattendedTidyPlan } from '../session-manage/session-manage-unattended-admission'
import { createStewardTier2Check } from './steward-tier2-check'
import { StewardResultCardStore } from './steward-result-card'
import {
  createStewardHarness,
  fakeSession,
  HOUR,
  type StewardHarness
} from './steward-test-fixtures'
import { setSessionWaitersSource } from './steward-waiter-source'

let dir: string
let h: StewardHarness
const cleanups: (() => void)[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'steward-tier2-'))
  h = createStewardHarness(dir)
})
afterEach(async () => {
  while (cleanups.length) {
    cleanups.pop()!()
  }
  await h.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const context = { source: 'cleanup-run' as const, runId: 'run-1' }

function finishedQuiet(paneKey: string, hoursQuiet = 8, row = {}) {
  const session = h.add(
    fakeSession(paneKey, { row, lastActivityAt: h.clock.now - hoursQuiet * HOUR })
  )
  h.doneness.set(session.turn.turnKey!, {
    turnKey: session.turn.turnKey!,
    resolved: 0.92,
    remainingWork: 0.03,
    unsure: false
  })
  return session
}

describe('the Tier 2 check S1 asks before an unattended archive', () => {
  it('says yes with its evidence and has saved the result card by then', async () => {
    finishedQuiet('p1')
    const check = createStewardTier2Check(h.deps.tier2)
    expect(await check({ target: { paneKey: 'p1', tabId: 'tab-p1' }, context })).toEqual({
      ok: true,
      evidence: expect.stringContaining('JEV resolved 0.92 · quiet 8 h')
    })
    expect(h.cards.read('view-p1')).toMatchObject({
      key: 'view-p1',
      evidence: expect.stringContaining('JEV resolved 0.92 · quiet 8 h')
    })
  })

  it('refuses a session on another computer before reading it', async () => {
    finishedQuiet('p1', 8, { hostId: 'ssh:box' })
    const check = createStewardTier2Check(h.deps.tier2)
    const verdict = await check({ target: { paneKey: 'p1' }, context })
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringMatching(/SSH host box/) })
    expect(h.deps.tier2.observe).not.toHaveBeenCalled()
  })

  it('refuses a session another one waits on (saving its card for the waiter), and one that left the sidebar', async () => {
    finishedQuiet('p1')
    cleanups.push(setSessionWaitersSource(() => new Map([['p1', ['p9']]])))
    const check = createStewardTier2Check(h.deps.tier2)
    expect(await check({ target: { paneKey: 'p1' }, context })).toEqual({
      ok: false,
      reason: 'another session is waiting on its result'
    })
    expect(await check({ target: { paneKey: 'gone' }, context })).toEqual({
      ok: false,
      reason: 'it is no longer in the sidebar'
    })
    // Why saved: the card is what meets the waiter's wait; the archive waits until it has.
    expect(h.cards.read('view-p1')).toMatchObject({ key: 'view-p1', turnKey: 'turn-p1-1' })
  })

  it('archives nothing when its result card cannot be saved', async () => {
    finishedQuiet('p1')
    const blocked = new StewardResultCardStore(join(dir, 'missing-parent', '\0bad'))
    const check = createStewardTier2Check({
      ...h.deps.tier2,
      saveCard: (card) => blocked.save(card)
    })
    const verdict = await check({ target: { paneKey: 'p1' }, context })
    expect(verdict).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^its result card could not be saved/)
    })
    expect(existsSync(h.cards.directory)).toBe(false)
  })

  it('decides what an automatic cleanup session’s tidy may archive', async () => {
    finishedQuiet('p1')
    finishedQuiet('p2', 1)
    const row = (paneKey: string): SessionTidyRow => ({
      paneKey,
      tabId: `tab-${paneKey}`,
      title: `Session ${paneKey}`,
      folder: null,
      hostId: 'local',
      state: 'idle',
      verdict: 'live',
      action: 'archive',
      reason: 'Idle with no pending steps, no queue and nothing waiting on the person.'
    })
    const plan = await unattendedTidyPlan(
      { rows: [row('p1'), row('p2')], counts: { archive: 2, hold: 0, skip: 0, junkTitles: 0 } },
      context
    )
    expect(plan.rows.map((entry) => [entry.paneKey, entry.action])).toEqual([
      ['p1', 'archive'],
      ['p2', 'hold']
    ])
    expect(plan.rows[1]!.reason).toBe(
      'Not archived by a steward run: it has been quiet for 1 h; the Done delay has not elapsed.'
    )
    expect(plan.counts).toMatchObject({ archive: 1, hold: 1 })
  })
})
