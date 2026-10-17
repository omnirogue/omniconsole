import { describe, expect, it } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import type { SessionOutcomeSet } from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'
import {
  blockForContinuation,
  blockForPrincipal,
  CONTINUATION_BLOCK,
  isContinuationBlocked,
  liftContinuationBlocks,
  sourceContinuationBlock
} from './session-outcome-continuation-block'

const NOW = 2_000_000

function outcome(id: string, status: 'pending' | 'satisfied' = 'pending') {
  return {
    id,
    title: id,
    finish: 'complete',
    dependsOn: [],
    conditions: [{ id: 'file', kind: 'file', target: `/workspace/${id}.txt` }],
    actions: [],
    revision: 1,
    status,
    evidence: []
  }
}

function set(...outcomes: ReturnType<typeof outcome>[]): SessionOutcomeSet {
  return {
    revision: 1,
    outcomes,
    attempts: [],
    continuation: { state: 'owned' }
  } as unknown as SessionOutcomeSet
}

const chain = (extra: Partial<SessionChain> = {}): SessionChain =>
  ({
    id: 'chain',
    workspacePath: '/workspace',
    worktreeId: 'folder:work',
    sourcePaneKey: 'tab-0:pane-0',
    steps: [],
    ...extra
  }) as unknown as SessionChain

/** A runtime whose source pane is there, or is gone. */
const runtimeWithPane = (present: boolean): OrcaRuntimeService =>
  ({
    resolveTerminalPane: () => {
      if (!present) {
        throw new Error('no such pane')
      }
      return { handle: 'source' }
    }
  }) as unknown as OrcaRuntimeService

describe('a block that is about the continuation', () => {
  it('waits on an unverifiable execution host, and never touches a satisfied outcome', () => {
    const blocked = blockForContinuation(
      set(outcome('done', 'satisfied'), outcome('ship')),
      'The outcome workspace does not match the execution host workspace.',
      { class: 'waiting', code: CONTINUATION_BLOCK.host, wake: 'execution host' },
      NOW
    )
    expect(blocked.outcomes[0]).toMatchObject({ status: 'satisfied' })
    expect(blocked.outcomes[0]!.block).toBeUndefined()
    expect(blocked.outcomes[1]).toMatchObject({
      status: 'blocked',
      block: {
        class: 'waiting',
        code: 'execution-host-unverifiable',
        wake: 'execution host',
        since: NOW
      }
    })
    expect(isContinuationBlocked(blocked.outcomes[1]!)).toBe(true)
    // Lost contact is a wait with a named wake, never a request for the person.
    const alone = blockForContinuation(
      set(outcome('ship')),
      'The outcome workspace does not match the execution host workspace.',
      { class: 'waiting', code: CONTINUATION_BLOCK.host, wake: 'execution host' },
      NOW
    )
    expect(sessionOutcomeProgress(alone, { now: NOW })).toMatchObject({
      phase: 'waiting',
      attention: []
    })
  })

  it('keeps `since` when the same fact is observed again, and lifts only its own code', () => {
    const first = blockForContinuation(
      set(outcome('ship')),
      'Capture failed.',
      { class: 'recovering', code: CONTINUATION_BLOCK.sourceCapture },
      NOW
    )
    const again = blockForContinuation(
      first,
      'Capture failed.',
      { class: 'recovering', code: CONTINUATION_BLOCK.sourceCapture },
      NOW + 4_000
    )
    expect(again.outcomes[0]!.block).toMatchObject({ since: NOW })
    // A capture that never succeeds goes stale by itself and reads as the failure it is.
    expect(sessionOutcomeProgress(again, { now: NOW + 5_000 }).phase).toBe('recovering')
    expect(sessionOutcomeProgress(again, { now: NOW + 16 * 60_000 }).phase).toBe('failed')

    expect(liftContinuationBlocks(again, [CONTINUATION_BLOCK.host])).toBe(again)
    const lifted = liftContinuationBlocks(again, [CONTINUATION_BLOCK.sourceCapture])
    expect(lifted.outcomes[0]).toMatchObject({
      status: 'pending',
      blockedReason: undefined,
      block: undefined
    })
  })

  it('never lifts a block another writer owns', () => {
    const other = {
      ...set(outcome('ship')),
      outcomes: [
        {
          ...outcome('ship'),
          status: 'blocked',
          block: { class: 'failed', code: 'worker-exited', since: 1 }
        }
      ]
    } as unknown as SessionOutcomeSet
    expect(isContinuationBlocked(other.outcomes[0]!)).toBe(false)
    expect(liftContinuationBlocks(other, Object.values(CONTINUATION_BLOCK))).toBe(other)
  })
})

describe('a signed principal that changed', () => {
  it('is ONE request for the whole run, listed on every block it causes', () => {
    const blocked = blockForPrincipal(
      { planVersion: 2 },
      set(outcome('first'), outcome('second')),
      NOW
    )
    expect(blocked.attention).toHaveLength(1)
    const request = blocked.attention![0]!
    expect(request).toMatchObject({
      kind: 'credential',
      state: 'open',
      recipient: { type: 'owner' },
      source: { type: 'principal' },
      action: { kind: 'sign-in' },
      scope: { outcomeId: 'first', outcomeRevision: 1, planVersion: 2 }
    })
    for (const entry of blocked.outcomes) {
      expect(entry.block).toMatchObject({
        class: 'attention',
        code: 'principal-mismatch',
        attentionIds: [request.id]
      })
    }
    expect(sessionOutcomeProgress(blocked, { now: NOW, planVersion: 2 }).phase).toBe('needs-you')
    // Observed again on the next pass: the same request, never a second one.
    const again = blockForPrincipal({ planVersion: 2 }, blocked, NOW + 2_000)
    expect(again.attention).toHaveLength(1)
    expect(again.attention![0]).toMatchObject({ id: request.id, openedAt: NOW })
  })
})

describe('a source that is not ready', () => {
  it('is nothing to block on once it is ready', () => {
    expect(sourceContinuationBlock(runtimeWithPane(true), chain(), { ready: true })).toBeNull()
  })

  it('waits on a source that is still working or asking its person something', () => {
    expect(sourceContinuationBlock(runtimeWithPane(true), chain(), { ready: false })).toMatchObject(
      {
        block: { class: 'waiting', code: 'source-not-ready', wake: 'source session' }
      }
    )
    expect(
      sourceContinuationBlock(runtimeWithPane(true), chain(), {
        ready: false,
        reason: 'The source agent needs your input.'
      })
    ).toMatchObject({
      reason: 'The source agent needs your input.',
      block: { class: 'waiting', code: 'source-not-ready' }
    })
  })

  it('waits on lost contact while the source pane still exists', () => {
    expect(
      sourceContinuationBlock(runtimeWithPane(true), chain(), {
        ready: false,
        unverifiable: true,
        reason: 'Source execution is unverifiable.'
      })
    ).toMatchObject({ block: { class: 'waiting', code: 'source-not-ready' } })
  })

  it('fails honestly when the source pane is gone: it can never become ready', () => {
    expect(
      sourceContinuationBlock(runtimeWithPane(false), chain(), {
        ready: false,
        unverifiable: true,
        reason: 'Source execution is unverifiable.'
      })
    ).toMatchObject({
      reason: 'Source execution is unverifiable.',
      block: { class: 'failed', code: 'source-gone' }
    })
  })

  it('fails honestly when a native source dispatch settled without succeeding', () => {
    const native = chain({
      outcomeSet: {
        continuation: {
          nativeSource: { runId: 'run', projectionTaskId: 'task', sourceDispatchId: 'ctx' }
        }
      } as unknown as SessionChain['outcomeSet']
    })
    expect(
      sourceContinuationBlock(runtimeWithPane(true), native, {
        ready: false,
        reason: 'The original native source did not finish successfully.'
      })
    ).toMatchObject({ block: { class: 'failed', code: 'source-gone' } })
    // Still running is not gone.
    expect(sourceContinuationBlock(runtimeWithPane(true), native, { ready: false })).toMatchObject({
      block: { class: 'waiting', code: 'source-not-ready' }
    })
  })
})
