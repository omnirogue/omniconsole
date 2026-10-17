import { describe, expect, it } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import { SESSION_RECOVERING_MAX_MS } from '../../shared/session-outcome-block'
import type { SessionOutcome, SessionOutcomeSet } from '../../shared/session-outcome-types'
import { readSessionRun } from '../../shared/session-run-lifecycle'
import { rememberSessionOutcomeBlocks } from './session-outcome-block-since'
import { blockSessionOutcomeSourceCapture } from './session-outcome-source-packet'
import { blockOutcomesForTickFailure } from './session-outcome-tick-failure'

const NOW = 2_000_000

const outcome = (id: string, status: SessionOutcome['status']): SessionOutcome => ({
  id,
  title: id,
  finish: 'complete',
  dependsOn: [],
  conditions: [{ id: 'file', kind: 'file', target: `/workspace/${id}.txt` }],
  actions: [],
  revision: 1,
  status,
  evidence: []
})

function chainOf(extra: Partial<SessionOutcomeSet> = {}): SessionChain {
  return {
    id: 'chain',
    workspacePath: '/workspace',
    worktreeId: 'workspace',
    hostId: 'local',
    sourcePaneKey: 'pane',
    sourceRowKey: 'row',
    auto: true,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps: [],
    outcomeSet: {
      schemaVersion: 1,
      revision: 3,
      updatedAt: 1,
      removals: [],
      attempts: [],
      completedSteps: [],
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
      outcomes: [outcome('first', 'running'), outcome('second', 'pending')],
      ...extra
    }
  }
}

function store(initial: SessionChain) {
  let chain = initial
  const saves: number[] = []
  return {
    saves,
    current: () => chain,
    get: () => chain,
    save: (next: SessionChain, expectedRevision: number) => {
      saves.push(expectedRevision)
      chain = next
      return chain
    }
  }
}

describe('a tick that threw', () => {
  it('is recovering — the next tick runs the same pass again — and asks nobody', () => {
    const access = store(chainOf())
    blockOutcomesForTickFailure(access, 'chain', new Error('database is locked'), NOW)
    const set = access.current().outcomeSet!
    expect(access.saves).toEqual([3])
    for (const entry of set.outcomes) {
      expect(entry).toMatchObject({
        status: 'blocked',
        blockedReason: 'Outcome verification failed: Error: database is locked',
        block: { class: 'recovering', code: 'tick-error', since: NOW }
      })
    }
    expect(set.attention ?? []).toEqual([])
    expect(readSessionRun(set, { now: NOW })).toMatchObject({ phase: 'recovering', attention: [] })
  })

  it('keeps the time it began across repeats, so a tick that never stops throwing reads as failed', () => {
    const access = store(chainOf())
    blockOutcomesForTickFailure(access, 'chain', new Error('database is locked'), NOW)
    const later = NOW + SESSION_RECOVERING_MAX_MS + 1
    blockOutcomesForTickFailure(access, 'chain', new Error('database is locked'), later)
    const set = access.current().outcomeSet!
    expect(set.outcomes[0]!.block).toMatchObject({ class: 'recovering', since: NOW })
    expect(readSessionRun(set, { now: later })).toMatchObject({
      phase: 'failed',
      lifecycle: 'waiting',
      attention: [],
      failure: { code: 'tick-error' }
    })
  })

  it('keeps that time even when the failed pass had already cleared the block before it threw', () => {
    const access = store(chainOf())
    blockOutcomesForTickFailure(access, 'chain', new Error('database is locked'), NOW)
    // The next pass: its status recompute lifts the block it cannot re-derive, saves, then throws.
    const began = rememberSessionOutcomeBlocks(access.current().outcomeSet!)
    const lifted = access.current()
    access.save(
      {
        ...lifted,
        outcomeSet: {
          ...lifted.outcomeSet!,
          outcomes: lifted.outcomeSet!.outcomes.map((entry) => ({
            ...entry,
            status: 'pending' as const,
            blockedReason: undefined,
            block: undefined
          }))
        }
      },
      3
    )
    const later = NOW + SESSION_RECOVERING_MAX_MS + 1
    blockOutcomesForTickFailure(access, 'chain', new Error('database is locked'), later, began)
    const set = access.current().outcomeSet!
    expect(set.outcomes.map((entry) => entry.block?.since)).toEqual([NOW, NOW])
    expect(readSessionRun(set, { now: later })).toMatchObject({ phase: 'failed', attention: [] })
  })

  it('never writes onto a sealed run', () => {
    const access = store(
      chainOf({
        completion: {
          at: 5,
          outcomes: [
            { id: 'first', revision: 1 },
            { id: 'second', revision: 1 }
          ],
          evidenceIds: []
        }
      })
    )
    blockOutcomesForTickFailure(access, 'chain', new Error('late'), NOW)
    expect(access.saves).toEqual([])
  })
})

describe('a source that could not be captured', () => {
  it('is recovering under the code the tick lifts, keeps the host owned, and asks nobody', () => {
    const blocked = blockSessionOutcomeSourceCapture(
      chainOf(),
      new Error('The source report is larger than a launch accepts.'),
      NOW
    )
    const set = blocked.outcomeSet!
    expect(set.continuation.state).toBe('owned')
    expect(set.outcomes.map((entry) => entry.block)).toEqual([
      { class: 'recovering', code: 'source-capture', since: NOW },
      { class: 'recovering', code: 'source-capture', since: NOW }
    ])
    expect(readSessionRun(set, { now: NOW })).toMatchObject({ phase: 'recovering', attention: [] })
  })
})
