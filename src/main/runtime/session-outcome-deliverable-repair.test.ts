/**
 * A finished outcome whose promised file is missing goes back to the run's own agent at most
 * twice per outcome revision — exactly once per repair across passes and restarts — and only then
 * fails as it always did.
 *
 * Real: the prompt queue's own persistence, the repair record and the hold classification.
 * Stubbed only where the world is: the pane's readiness, the send door and the conversation lookup.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

const pane = vi.hoisted(() => ({
  ready: true,
  version: 'turn-1' as string | undefined,
  unverifiable: false,
  open: true,
  sent: [] as string[],
  /** The send failed after bytes moved: its result is unknown. */
  refuse: false,
  /** The door refused before any byte moved. */
  notSent: false
}))
vi.mock('./conversation-readiness', () => ({
  observeConversationReadiness: async () => ({
    ready: pane.ready,
    free: pane.ready,
    unverifiable: pane.unverifiable,
    ...(pane.version ? { version: pane.version } : {})
  })
}))
vi.mock('./conversation-delivery', async () => {
  const { ConversationNotSentError } = await import('./conversation-delivery-not-sent')
  return {
    deliverToConversation: async (_runtime: unknown, _source: unknown, text: string) => {
      if (pane.notSent) {
        throw new ConversationNotSentError('This terminal conversation is no longer open.')
      }
      if (pane.refuse) {
        throw new Error('terminal_handle_stale')
      }
      pane.sent.push(text)
      return { door: 'pty' as const, deliveredAt: 99 }
    }
  }
})
vi.mock('./session-outcome-conversation-turn', () => ({
  sameConversationSource: () =>
    pane.open ? { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const } : null
}))

import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { conversationSourceRowKey } from '../../shared/conversation-source'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { SessionChain } from '../../shared/session-chain-types'
import { SESSION_RECOVERING_MAX_MS } from '../../shared/session-outcome-block'
import type { SessionOutcome } from '../../shared/session-outcome-types'
import {
  advanceSessionOutcomeDeliverableRepairs,
  sessionOutcomeDeliverableRepairPrompt
} from './session-outcome-deliverable-repair'
import {
  sessionOutcomeDeliverableRepairHold,
  sessionOutcomeDeliverableRepairKey
} from './session-outcome-deliverable-repair-hold'
import {
  installSessionOutcomeDeliverableRepairStore,
  SessionOutcomeDeliverableRepairStore
} from './session-outcome-deliverable-repair-store'
import { sessionOutcomeVerificationHold } from './session-outcome-verification-hold'

const ROW = conversationSourceRowKey({ worktreeId: 'wt', paneKey: 'tab-1:leaf-1' })
const MISSING = 'The expected file is missing or exceeds the verification size limit.'

function outcome(overrides: Partial<SessionOutcome> = {}): SessionOutcome {
  return {
    id: 'o1',
    title: 'Spec written',
    finish: 'complete',
    dependsOn: [],
    stepIds: ['write'],
    conditions: [
      { id: 'spec', kind: 'file', target: 'docs/spec.md', label: 'The spec is saved' },
      { id: 'notes', kind: 'file', target: 'docs/notes.md' }
    ],
    actions: [],
    revision: 1,
    status: 'blocked',
    blockedReason: MISSING,
    block: { class: 'recovering', code: 'deliverable-repair', since: 10 },
    evidence: [],
    ...overrides
  } as SessionOutcome
}

function run(entry: SessionOutcome = outcome(), extra: Record<string, unknown> = {}): SessionChain {
  return {
    id: 'chain_1',
    workspacePath: '/w',
    worktreeId: 'wt',
    hostId: 'local',
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: ROW,
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 2,
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      outcomes: [entry],
      removals: [],
      attempts: [],
      completedSteps: ['write'],
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'e1', state: 'owned' },
      updatedAt: 3,
      ...extra
    }
  } as SessionChain
}

function host(initial: SessionChain) {
  let chain = initial
  const state = { promptQueues: {} } as unknown as PersistedState
  const prompts = new PromptQueuePersistence(
    { state, flushOrThrow: () => {}, writesFrozen: false },
    {} as WriteSchedulingOperations
  )
  const runtime = {
    listSessionChains: () => [chain],
    readPromptQueue: (key: string) => prompts.readPromptQueue(key),
    enqueuePromptQueueEntry: (
      ...args: Parameters<PromptQueuePersistence['enqueuePromptQueueEntry']>
    ) => prompts.enqueuePromptQueueEntry(...args),
    removePromptQueueEntry: (
      ...args: Parameters<PromptQueuePersistence['removePromptQueueEntry']>
    ) => prompts.removePromptQueueEntry(...args),
    markPromptQueueEntrySendingAndFlush: (
      ...args: Parameters<PromptQueuePersistence['markPromptQueueEntrySendingAndFlush']>
    ) => prompts.markPromptQueueEntrySendingAndFlush(...args),
    settlePromptQueueEntry: (
      ...args: Parameters<PromptQueuePersistence['settlePromptQueueEntry']>
    ) => prompts.settlePromptQueueEntry(...args)
  }
  return {
    runtime,
    prompts,
    chain: () => chain,
    set: (next: SessionChain) => {
      chain = next
    },
    pass: (now = 100, epoch = 'epoch-1') =>
      advanceSessionOutcomeDeliverableRepairs({
        runtime: runtime as never,
        read: () => chain,
        epoch,
        now
      })
  }
}

/** What the verification hold classifies this run's missing file as, given its repair record. */
function hold(chain: SessionChain) {
  const set = chain.outcomeSet!
  return sessionOutcomeVerificationHold(chain, set, set.outcomes[0]!, MISSING).block
}

let directory: string
let store: SessionOutcomeDeliverableRepairStore

beforeEach(() => {
  Object.assign(pane, {
    ready: true,
    version: 'turn-1',
    unverifiable: false,
    open: true,
    sent: [],
    refuse: false,
    notSent: false
  })
  directory = mkdtempSync(join(tmpdir(), 'deliverable-repair-'))
  store = new SessionOutcomeDeliverableRepairStore(join(directory, 'repairs.json'))
  installSessionOutcomeDeliverableRepairStore(store)
})

afterEach(() => {
  installSessionOutcomeDeliverableRepairStore(null)
  rmSync(directory, { recursive: true, force: true })
})

describe('the hold for a finished outcome whose file is missing', () => {
  it('fails as before on a host without the repair record', () => {
    installSessionOutcomeDeliverableRepairStore(null)
    expect(hold(run())).toEqual({ class: 'failed', code: 'deliverable-unverified' })
  })

  it('is recovering while a repair is left, and fails as before for a workflow run', () => {
    expect(hold(run())).toEqual({ class: 'recovering', code: 'deliverable-repair' })
    expect(hold(run(outcome(), { workflow: {} }))).toEqual({
      class: 'failed',
      code: 'deliverable-unverified'
    })
  })

  it('names the file conditions still unproven at this revision', async () => {
    const proven = outcome({
      evidence: [
        {
          id: 'ev_spec',
          outcomeId: 'o1',
          conditionId: 'spec',
          outcomeRevision: 1,
          conditionKey: 'k',
          kind: 'file',
          target: 'docs/spec.md',
          receipt: 'sha256:abc:/w/docs/spec.md',
          verifiedAt: 5,
          verifier: 'execution-host'
        }
      ]
    })
    const h = host(run(proven))
    await h.pass()
    expect(pane.sent).toHaveLength(1)
    expect(pane.sent[0]).toContain('docs/notes.md')
    expect(pane.sent[0]).not.toContain('docs/spec.md')
    const [record] = store.list(sessionOutcomeDeliverableRepairKey(h.chain(), proven))
    expect(record?.conditionIds).toEqual(['notes'])
  })
})

describe('advancing a repair', () => {
  it('sends one prompt after a finished turn, waits on the turn that answers it, and settles it', async () => {
    const h = host(run())
    await h.pass()
    await h.pass(110)
    expect(pane.sent).toHaveLength(1)
    expect(pane.sent[0]).toMatch(/^\[from Deliverable check 1\/2\] “Spec written” is not finished/)
    expect(pane.sent[0]).toContain('1. docs/spec.md (The spec is saved)')
    expect(pane.sent[0]).toContain('2. docs/notes.md')
    const key = sessionOutcomeDeliverableRepairKey(h.chain(), h.chain().outcomeSet!.outcomes[0]!)
    expect(store.list(key)).toMatchObject([{ attempt: 1, turnVersion: 'turn-1', deliveredAt: 99 }])
    expect(hold(h.chain())).toEqual({
      class: 'waiting',
      code: 'deliverable-repair',
      wake: 'repair turn'
    })

    pane.version = 'turn-2'
    await h.pass(120)
    expect(store.list(key)[0]?.settledAt).toBe(120)
    expect(pane.sent).toHaveLength(1)
  })

  it('stops after two repairs, or sooner when a repair turn changed nothing', async () => {
    const h = host(run())
    await h.pass()
    pane.version = 'turn-2'
    await h.pass(120)
    // The turn wrote one of the two files: progress, so a second repair is allowed.
    const progressed = outcome({
      evidence: [
        {
          id: 'ev_spec',
          outcomeId: 'o1',
          conditionId: 'spec',
          outcomeRevision: 1,
          conditionKey: 'k',
          kind: 'file',
          target: 'docs/spec.md',
          receipt: 'sha256:abc:/w/docs/spec.md',
          verifiedAt: 115,
          verifier: 'execution-host'
        }
      ]
    })
    h.set(run(progressed))
    expect(hold(h.chain())).toEqual({ class: 'recovering', code: 'deliverable-repair' })
    await h.pass(130)
    expect(pane.sent).toHaveLength(2)
    expect(pane.sent[1]).toMatch(/^\[from Deliverable check 2\/2\]/)
    pane.version = 'turn-3'
    await h.pass(140)
    expect(hold(h.chain())).toEqual({ class: 'failed', code: 'deliverable-unverified' })

    // A fresh run whose one repair turn left the same files missing stops at once.
    const other = host(run(outcome({ id: 'o2' })))
    await other.pass()
    pane.version = 'turn-4'
    await other.pass(150)
    expect(hold(other.chain())).toEqual({ class: 'failed', code: 'deliverable-unverified' })
  })

  it('counts and never resends a repair whose result is unknown', async () => {
    pane.refuse = true
    const h = host(run())
    await h.pass()
    const key = sessionOutcomeDeliverableRepairKey(h.chain(), h.chain().outcomeSet!.outcomes[0]!)
    expect(store.list(key)).toMatchObject([{ attempt: 1, failed: 'terminal_handle_stale' }])
    // The second and last repair goes out on a later pass; the unknown one is never repeated.
    pane.refuse = false
    await h.pass(110)
    await h.pass(120)
    expect(pane.sent).toHaveLength(1)
    expect(pane.sent[0]).toMatch(/^\[from Deliverable check 2\/2\]/)
    expect(store.list(key).map((record) => record.attempt)).toEqual([1, 2])
  })

  it('withdraws a repair the door refused before any byte moved, and asks again under a new id', async () => {
    pane.notSent = true
    const h = host(run())
    await h.pass()
    const key = sessionOutcomeDeliverableRepairKey(h.chain(), h.chain().outcomeSet!.outcomes[0]!)
    expect(store.list(key)).toEqual([])
    expect(h.prompts.readPromptQueue(ROW)?.entries ?? []).toEqual([])
    pane.notSent = false
    await h.pass(110)
    expect(pane.sent).toHaveLength(1)
    expect(store.list(key)).toMatchObject([{ attempt: 1, deliveredAt: 99 }])
  })

  it('fails as before when the queue cannot take the prompt', async () => {
    const h = host(run())
    h.runtime.enqueuePromptQueueEntry = () => {
      throw new Error('This runtime cannot queue prompts.')
    }
    await h.pass()
    await h.pass(110)
    const key = sessionOutcomeDeliverableRepairKey(h.chain(), h.chain().outcomeSet!.outcomes[0]!)
    expect(store.list(key)).toMatchObject([
      { attempt: 1, unrepairable: 'This runtime cannot queue prompts.' }
    ])
    expect(pane.sent).toEqual([])
    expect(hold(h.chain())).toEqual({ class: 'failed', code: 'deliverable-unverified' })
  })

  it('never sends over a pending capacity recovery', async () => {
    const h = host(run())
    const read = h.runtime.readPromptQueue
    h.runtime.readPromptQueue = (key: string) => ({
      source: { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const },
      entries: [],
      ...read(key),
      recovery: { phase: 'waiting' } as never
    })
    await h.pass()
    expect(pane.sent).toEqual([])
  })

  it('keeps its count across a restart', async () => {
    const h = host(run())
    await h.pass()
    pane.version = 'turn-2'
    await h.pass(120)
    installSessionOutcomeDeliverableRepairStore(
      new SessionOutcomeDeliverableRepairStore(join(directory, 'repairs.json'))
    )
    await h.pass(130, 'epoch-2')
    expect(pane.sent).toHaveLength(1)
    // Same files still missing after the settled turn: the reloaded record stops the repairs.
    expect(hold(h.chain())).toEqual({ class: 'failed', code: 'deliverable-unverified' })
  })

  it('fails as before once the conversation has been gone for the stale window', async () => {
    pane.open = false
    const h = host(run())
    // Not restored yet, perhaps: asked again on later passes, nothing recorded.
    await h.pass()
    expect(hold(h.chain())).toEqual({ class: 'recovering', code: 'deliverable-repair' })
    await h.pass(10 + SESSION_RECOVERING_MAX_MS)
    expect(pane.sent).toEqual([])
    expect(hold(h.chain())).toEqual({ class: 'failed', code: 'deliverable-unverified' })
  })

  it('waits for a finished turn, for contact, and behind the person’s own queued prompt', async () => {
    const h = host(run())
    pane.ready = false
    await h.pass()
    pane.ready = true
    pane.unverifiable = true
    await h.pass()
    pane.unverifiable = false
    h.prompts.enqueuePromptQueueEntry(
      { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' },
      { id: 'person-1', text: 'One more thing', createdAt: 50, state: 'queued' }
    )
    await h.pass()
    expect(pane.sent).toEqual([])
  })

  it('leaves a sealed run, and an outcome held for anything else, alone', async () => {
    const sealed = host(
      run(outcome(), {
        completion: {
          at: 5,
          outcomes: [{ id: 'o1', revision: 1 }],
          planVersion: 1,
          evidenceIds: []
        }
      })
    )
    await sealed.pass()
    const other = host(
      run(
        outcome({ block: { class: 'waiting', code: 'evidence-poll', since: 1, wake: 'evidence' } })
      )
    )
    await other.pass()
    expect(pane.sent).toEqual([])
  })
})

describe('the repair prompt', () => {
  it('lists at most ten files and stays within 2,000 characters', () => {
    const conditions = Array.from({ length: 14 }, (_, index) => ({
      id: `f${index}`,
      kind: 'file' as const,
      target: `docs/${'very-long-name-'.repeat(8)}${index}.md`
    }))
    const text = sessionOutcomeDeliverableRepairPrompt({
      outcome: outcome({ conditions }),
      files: conditions,
      attempt: 1
    })
    expect(text.length).toBeLessThanOrEqual(2_000)
    expect(text).toContain('10. docs/')
    expect(text).not.toContain('11. docs/')
  })

  it('carries the check’s reason and forbids unapproved outward steps', () => {
    const text = sessionOutcomeDeliverableRepairPrompt({
      outcome: outcome(),
      files: outcome().conditions,
      attempt: 2
    })
    expect(text).toContain(`The check said: ${MISSING}`)
    expect(text).toContain('Do not take any irreversible or outward-facing step')
  })
})

describe('the hold classification alone', () => {
  it('reads no repair from another revision or plan version', () => {
    const chain = run()
    store.add({
      ...sessionOutcomeDeliverableRepairKey(chain, outcome({ revision: 2 })),
      attempt: 1,
      conditionIds: ['spec'],
      createdAt: 1,
      unrepairable: 'gone'
    })
    expect(
      sessionOutcomeDeliverableRepairHold(chain, chain.outcomeSet!, chain.outcomeSet!.outcomes[0]!)
    ).toEqual({ block: { class: 'recovering', code: 'deliverable-repair' }, attention: [] })
  })
})
