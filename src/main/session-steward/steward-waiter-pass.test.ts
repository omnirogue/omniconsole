import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeSessionChain, type SessionChain } from '../../shared/session-chain-types'
import type { SessionFolderRelayRequest } from '../../shared/session-folder-cli'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import { reviseSessionOutcomeSet } from '../../shared/session-outcome-state'
import { runStewardPass } from './steward-pass'
import { stalledWaitersFromChains, stewardStalledList } from './steward-stalled-waiters'
import {
  createStewardHarness,
  fakeSession,
  HOUR,
  type FakeSession,
  type StewardHarness
} from './steward-test-fixtures'
import { setSessionWaitersSource } from './steward-waiter-source'

let dir: string
let h: StewardHarness
const restore: (() => void)[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'steward-waiter-pass-'))
  h = createStewardHarness(dir)
})
afterEach(async () => {
  for (const undo of restore.splice(0)) {
    undo()
  }
  await h.dispose()
  rmSync(dir, { recursive: true, force: true })
})

function finished(session: FakeSession): void {
  const turnKey = session.turn.turnKey!
  h.doneness.set(turnKey, { turnKey, resolved: 0.95, remainingWork: 0.05, unsure: false })
}

const pass = () => runStewardPass(h.deps, h.memory)
const archives = () =>
  h.window.mock.calls.filter(
    ([request]) => (request as SessionFolderRelayRequest).kind === 'applyOrganizationChange'
  )

describe('a finished session another one waits on (Tier 2 waiter check)', () => {
  it('is kept with its result card saved, then archived once the waiter has picked it up', async () => {
    const waiters = new Map([['p1', ['p9']]])
    restore.push(setSessionWaitersSource(() => waiters))
    const session = h.add(fakeSession('p1', { lastActivityAt: h.clock.now - 8 * HOUR }))
    finished(session)
    await pass()
    expect(archives()).toHaveLength(0)
    expect(h.cards.read(session.row.viewKey)).toMatchObject({
      paneKey: 'p1',
      turnKey: session.turn.turnKey
    })
    expect(h.state.read().activity.at(-1)?.summary).toMatch(
      /^Kept “Session p1” for the session waiting on its result; its result card is saved\.$/
    )
    const builtAt = h.cards.read(session.row.viewKey)!.builtAt
    h.clock.now += HOUR
    h.memory.seen.clear()
    await pass()
    // One card per finished turn: the waiter reads a stable revision.
    expect(h.cards.read(session.row.viewKey)!.builtAt).toBe(builtAt)
    expect(archives()).toHaveLength(0)
    waiters.clear()
    h.clock.now += HOUR
    h.memory.seen.clear()
    await pass()
    expect(archives()).toHaveLength(1)
  })
})

function waitingChain(paneKey: string, attempt: Partial<SessionOutcomeAttempt>): SessionChain {
  const set = reviseSessionOutcomeSet(
    undefined,
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: 'next',
          title: 'Continue with the billing result',
          finish: 'complete',
          dependsOn: [],
          actions: [],
          conditions: [{ id: 'merge', kind: 'merge', target: 'https://example.test/pull/1' }]
        }
      ]
    },
    {
      owner: 'execution-host',
      hostId: 'local',
      epoch: 'epoch',
      state: 'owned',
      sourceVersion: 'turn1',
      sourceReady: true
    },
    1
  )
  return normalizeSessionChain({
    id: `chain-${paneKey}`,
    workspacePath: '/w',
    worktreeId: 'wt',
    sourcePaneKey: paneKey,
    sourceRowKey: `row-${paneKey}`,
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 3,
    outcomeSet: {
      ...set,
      attempts: [
        {
          id: `attempt-${paneKey}`,
          outcomeId: 'next',
          actionId: 'continue',
          actionKey: 'continue',
          outcomeRevision: 1,
          state: 'blocked',
          startedAt: 4,
          updatedAt: 5,
          ...attempt
        } as SessionOutcomeAttempt
      ]
    }
  })!
}

describe('waiters that could not be woken join Stalled', () => {
  it('lists a waiter whose blocked step reads "Stalled: …", with the reason, and no other', () => {
    const stalled = stalledWaitersFromChains([
      waitingChain('w1', { error: 'Stalled: “Billing” exited and could not be resumed: gone' }),
      waitingChain('w2', { error: 'The merge was refused' }),
      waitingChain('w3', { state: 'running', error: 'Stalled: stale reading' })
    ])
    expect([...stalled]).toEqual([
      ['w1', { at: 5, reason: '“Billing” exited and could not be resumed: gone' }]
    ])
  })

  it('shows them after the steward’s own Stalled sessions, one row per pane, newest first', () => {
    const list = stewardStalledList(
      { sessions: { p1: { updatedAt: 1, title: 'Parser', stalled: { at: 3, reason: 'nudged' } } } },
      { seen: new Map(), titles: new Map([['w1', 'Waiter']]) },
      new Map([
        ['w1', { at: 9, reason: 'could not be resumed' }],
        ['p1', { at: 10, reason: 'duplicate' }]
      ])
    )
    expect(list).toEqual([
      { paneKey: 'w1', title: 'Waiter', at: 9, reason: 'could not be resumed' },
      { paneKey: 'p1', title: 'Parser', at: 3, reason: 'nudged' }
    ])
  })

  it('counts a Stalled waiter as a leftover for the pile-up detector', async () => {
    h.stalledWaiters.set('w1', { at: h.clock.now - HOUR, reason: 'could not be resumed' })
    h.add(fakeSession('w1', { lastActivityAt: h.clock.now - HOUR }))
    await pass()
    expect(h.detector.run).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ paneKey: 'w1', kind: 'stalled', reason: 'could not be resumed' })
      ])
    )
  })
})
