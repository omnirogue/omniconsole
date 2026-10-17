import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeCondition } from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { verifySessionOutcomeEvent } from '../runtime/session-outcome-event-evidence'
import { assertSessionWaitAdmission } from './session-wait-admission'
import {
  installSessionResultCardReader,
  locateAwaitedSession,
  readAwaitedSessionResult
} from './steward-awaited-session'
import {
  listSessionWaiters,
  pendingEventWaitOf,
  sessionWaitCycle,
  sessionWaitersFromChains
} from './steward-waiters'

const proofs = vi.hoisted(() => new Map<string, string>())
vi.mock('../../shared/session-archive-proof', () => ({
  sessionCommitmentProof: (chain: { id: string }) => proofs.get(chain.id) ?? null
}))

afterEach(() => {
  proofs.clear()
  installSessionResultCardReader(null)
})

function sessionWait(ref: string, id = 'on_other'): SessionOutcomeCondition {
  return {
    id,
    kind: 'event',
    label: `${ref} finishes`,
    target: `${ref} finishes`,
    event: { source: 'session', match: 'result', ref }
  } as SessionOutcomeCondition
}

/** A plan of `paneKey` waiting on `refs`; `picked` names waits whose receipt it already holds. */
function waiter(
  id: string,
  paneKey: string,
  refs: string[],
  options: { picked?: string[]; state?: SessionChain['state']; hostId?: string } = {}
): SessionChain {
  const conditions = refs.map((ref, index) => sessionWait(ref, `wait_${index}`))
  return {
    id,
    sourcePaneKey: paneKey,
    sourceRowKey: JSON.stringify(['local', 'wt', paneKey]),
    worktreeId: 'wt',
    hostId: options.hostId ?? 'local',
    state: options.state ?? 'waiting',
    updatedAt: 1,
    steps: [],
    outcomeSet: {
      revision: 1,
      attempts: [],
      continuation: { state: 'owned' },
      outcomes: [
        {
          id: 'wait',
          revision: 1,
          status: 'pending',
          conditions,
          evidence: conditions
            .filter((condition) =>
              options.picked?.includes((condition.event as { ref: string }).ref)
            )
            .map((condition) => ({ conditionId: condition.id, outcomeRevision: 1 })),
          dependsOn: [],
          actions: []
        }
      ]
    }
  } as unknown as SessionChain
}

/** A plan an awaited session filed itself; `open` keeps it unfinished. */
function ownPlan(id: string, paneKey: string, open: boolean, at = 5_000): SessionChain {
  return {
    id,
    sourcePaneKey: paneKey,
    worktreeId: 'wt',
    hostId: 'local',
    state: open ? 'waiting' : 'done',
    updatedAt: at,
    steps: [],
    outcomeSet: {
      revision: 1,
      attempts: [],
      continuation: { state: 'owned' },
      outcomes: [
        {
          id: 'o',
          revision: 1,
          status: open ? 'pending' : 'satisfied',
          conditions: [{ id: 'report', kind: 'file', target: 'report.md' }],
          evidence: [],
          dependsOn: [],
          actions: []
        }
      ],
      ...(open ? {} : { completion: { at, outcomes: [], evidenceIds: ['e'] } })
    }
  } as unknown as SessionChain
}

function runtime(
  chains: SessionChain[],
  panes: Record<string, string | null> = {},
  lastReply?: string
): OrcaRuntimeService {
  return {
    listSessionChains: () => chains,
    resolveTerminalPane: (paneKey: string) => {
      if (!(paneKey in panes)) {
        throw new Error('terminal_not_found')
      }
      return {
        handle: paneKey,
        tabId: 't',
        leafId: 'l',
        ptyId: 'p',
        ...(panes[paneKey] ? { executionHostId: panes[paneKey] } : {})
      }
    },
    getLastAgentHookRowForPane: () => (lastReply ? { lastAssistantMessage: lastReply } : null)
  } as unknown as OrcaRuntimeService
}

describe('listSessionWaiters', () => {
  it('lists each pending session wait under the session it waits on', () => {
    const waiters = listSessionWaiters(
      runtime([waiter('c1', 'a:1', ['b:1']), waiter('c2', 'c:1', ['b:1', 'd:1'])])
    )
    expect([...waiters.keys()].toSorted()).toEqual(['b:1', 'd:1'])
    expect(waiters.get('b:1')!.map((entry) => [entry.paneKey, entry.chainId])).toEqual([
      ['a:1', 'c1'],
      ['c:1', 'c2']
    ])
    expect(waiters.get('d:1')![0]).toMatchObject({
      paneKey: 'c:1',
      worktreeId: 'wt',
      outcomeId: 'wait',
      conditionId: 'wait_1',
      label: 'd:1 finishes'
    })
  })

  it('drops a wait once its waiter holds the receipt, and plans that ended', () => {
    const waiters = sessionWaitersFromChains([
      waiter('picked', 'a:1', ['b:1'], { picked: ['b:1'] }),
      waiter('cancelled', 'c:1', ['b:1'], { state: 'cancelled' })
    ])
    expect(waiters.size).toBe(0)
  })
})

describe('sessionWaitCycle', () => {
  const index = sessionWaitersFromChains([
    waiter('c1', 'a:1', ['b:1']),
    waiter('c2', 'b:1', ['c:1'])
  ])

  it('names waiting on itself', () => {
    expect(sessionWaitCycle(index, 'a:1', 'a:1')).toEqual(['a:1', 'a:1'])
  })

  it('finds the circle a new wait would close, however long', () => {
    expect(sessionWaitCycle(index, 'b:1', 'a:1')).toEqual(['b:1', 'a:1', 'b:1'])
    expect(sessionWaitCycle(index, 'c:1', 'a:1')).toEqual(['c:1', 'a:1', 'b:1', 'c:1'])
  })

  it('allows a wait that closes nothing', () => {
    expect(sessionWaitCycle(index, 'd:1', 'a:1')).toBeNull()
    expect(sessionWaitCycle(index, 'a:1', 'c:1')).toBeNull()
  })
})

describe('assertSessionWaitAdmission', () => {
  const chains = [waiter('c1', 'b:1', ['a:1'])]
  const panes = { 'a:1': 'local', 'b:1': 'local', 'ssh:1': 'ssh:devbox' }
  const commit = (ref: string) => ({
    outcomes: [{ ...waiter('new', 'a:1', [ref]).outcomeSet!.outcomes[0]!, evidence: [] }]
  })
  const admit = (ref: string, enabled = true, old?: SessionChain) =>
    assertSessionWaitAdmission(
      runtime(chains, panes),
      { id: 'new', sourcePaneKey: 'a:1', worktreeId: 'wt' },
      commit(ref) as never,
      old,
      enabled
    )

  it('refuses a session waiting on its own result', () => {
    expect(() => admit('a:1')).toThrow('A session cannot wait on its own result')
  })

  it('refuses a circular wait', () => {
    expect(() => admit('b:1')).toThrow('This wait would close a circle (a:1 → b:1 → a:1)')
  })

  it('refuses a remote or unknown session', () => {
    expect(() => admit('ssh:1')).toThrow('runs on the SSH host devbox')
    expect(() => admit('gone:1')).toThrow('No session on this computer has pane gone:1')
  })

  it('refuses when session waits are switched off', () => {
    expect(() => admit('c:9', false)).toThrow('Waiting on another session is switched off')
  })

  it('admits a local session, and never re-checks a wait the plan already held', () => {
    expect(() =>
      assertSessionWaitAdmission(
        runtime(chains, { ...panes, 'c:9': null }),
        { id: 'new', sourcePaneKey: 'a:1', worktreeId: 'wt' },
        commit('c:9') as never,
        undefined,
        true
      )
    ).not.toThrow()
    expect(() => admit('gone:1', false, waiter('new', 'a:1', ['gone:1']))).not.toThrow()
  })
})

describe('reading the awaited session', () => {
  const read = (chains: SessionChain[], panes: Record<string, string | null>, ref = 'b:1') =>
    verifySessionOutcomeEvent(sessionWait(ref), undefined, 10_000, runtime(chains, panes, 'Fixed.'))

  it('is pending while the session is here and has no result', async () => {
    const result = await read([], { 'b:1': null })
    expect(result).toMatchObject({ verified: false, wait: { status: 'pending' } })
    expect(result.verified ? '' : result.reason).toBe(
      'The session it waits on (pane b:1) has no finished result yet.'
    )
  })

  it('is met by a Tier 1 seal, with a receipt bound to that seal', async () => {
    proofs.set('own', 'seal-identity-1')
    const first = await read([ownPlan('own', 'b:1', false)], { 'b:1': null })
    expect(first).toMatchObject({
      verified: true,
      wait: { status: 'met', excerpt: 'Fixed.', at: 5_000 }
    })
    proofs.set('own', 'seal-identity-2')
    const second = await read([ownPlan('own', 'b:1', false)], { 'b:1': null })
    const receipt = (value: typeof first) => (value.verified ? value.receipt : '')
    expect(receipt(first)).toMatch(/^event:session:b:1@seal-[0-9a-f]{16}$/)
    expect(receipt(second)).not.toBe(receipt(first))
  })

  it('does not count an older seal while a newer plan of it is still open', async () => {
    proofs.set('old', 'seal-identity-1')
    const result = await read([ownPlan('old', 'b:1', false), ownPlan('new', 'b:1', true)], {
      'b:1': null
    })
    expect(result).toMatchObject({ verified: false, wait: { status: 'pending' } })
  })

  it('is met by a Tier 2 result card the steward saved', async () => {
    installSessionResultCardReader((paneKey) =>
      paneKey === 'b:1' ? { revision: 'op-7', at: 9_000, summary: 'Billing fixed' } : null
    )
    const result = await read([], { 'b:1': null })
    expect(result).toMatchObject({
      verified: true,
      wait: { status: 'met', excerpt: 'Billing fixed', at: 9_000 }
    })
    expect(result.verified && result.receipt).toMatch(/^event:session:b:1@card-[0-9a-f]{16}$/)
  })

  it("reads can't verify for a remote or vanished session, never met", async () => {
    const remote = await read([], { 'b:1': 'ssh:devbox' })
    expect(remote).toMatchObject({ verified: false, wait: { status: 'unavailable' } })
    expect(remote.verified ? '' : remote.reason).toBe(
      "Follow-up not scheduled: The session it waits on (pane b:1) runs on the SSH host devbox, so its result can't be verified here."
    )
    const gone = await read([], {})
    expect(gone).toMatchObject({ verified: false, wait: { status: 'unavailable' } })
  })

  it('locates a closed session by the plan it filed', () => {
    expect(locateAwaitedSession(runtime([ownPlan('own', 'b:1', false)], {}), 'b:1')).toEqual({
      kind: 'local'
    })
    expect(readAwaitedSessionResult(runtime([], {}), 'b:1')).toBeNull()
  })
})

describe('pendingEventWaitOf', () => {
  it("names the unanswered wait in the pane's own plan, and nothing once it is picked up", () => {
    expect(pendingEventWaitOf([waiter('c', 'me:leaf', ['b:1'])], 'me:leaf')).toBe('b:1 finishes')
    expect(pendingEventWaitOf([waiter('c', 'me:leaf', ['b:1'])], 'other:leaf')).toBeNull()
    expect(
      pendingEventWaitOf([waiter('c', 'me:leaf', ['b:1'], { picked: ['b:1'] })], 'me:leaf')
    ).toBeNull()
  })
})
