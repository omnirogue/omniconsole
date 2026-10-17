/**
 * Prompts attached to a stage: delivered into that stage's OWN conversation, only when its
 * seat is idle, in the order they were written, and never twice.
 *
 * The rule the brief asks for is here as a test: a prompt written under an Agent block does
 * nothing until that stage runs. A seat that never launched has no conversation to write to,
 * and a busy seat is left alone until the next tick.
 */
import { describe, expect, it, vi } from 'vitest'

const readiness = vi.hoisted(() => ({ ready: true }))
vi.mock('./conversation-readiness', () => ({
  observeConversationReadiness: async () => ({
    ready: readiness.ready,
    // `free` is the reading the Now row and the queue drain use; a stub that only knows
    // whether a turn finished answers both the same way (`conversation-readiness.ts`).
    free: readiness.ready,
    unverifiable: false
  })
}))

const door = vi.hoisted(() => ({
  sent: [] as { pane: string; text: string }[],
  fail: false,
  hook: null as null | (() => void)
}))
vi.mock('./conversation-delivery', () => ({
  deliverToConversation: async (
    _runtime: unknown,
    source: { paneKey: string },
    text: string
  ): Promise<{ door: 'pty'; deliveredAt: number }> => {
    if (door.fail) {
      throw new Error('the pane is gone')
    }
    door.hook?.()
    door.hook = null
    door.sent.push({ pane: source.paneKey, text })
    return { door: 'pty', deliveredAt: 7 }
  }
}))

import type { PromptQueueEntry } from '../../shared/prompt-queue-types'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import type { UpNextBlock } from '../../shared/up-next-types'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import {
  drainUpNextStagePrompts,
  upNextAttachStagePrompts,
  upNextHoldsStagePrompts
} from './up-next-stage-prompts'
import { upNextCarriedStagePrompts } from './up-next-stage-seat'
import type { OrcaRuntimeService } from './omni-runtime'

const prompt = (
  id: string,
  text: string,
  over: Partial<PromptQueueEntry> = {}
): PromptQueueEntry => ({
  id,
  text,
  createdAt: 1,
  state: 'queued',
  ...over
})

function host(step: Partial<SessionChainAgentStep>) {
  let chain: SessionChain = {
    id: 'source_1',
    workspacePath: '/w',
    worktreeId: 'wt',
    hostId: 'local',
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: JSON.stringify(['local', 'wt', 'tab-1:leaf-1']),
    auto: true,
    steps: [
      {
        id: 'step_1',
        agent: 'claude',
        prompt: 'Review it.',
        presetId: 'review',
        status: 'queued',
        ...step
      }
    ],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 2,
    outcomeSet: {
      schemaVersion: 1,
      revision: 3,
      outcomes: [
        {
          id: 'o1',
          title: 'Receipts signed',
          finish: 'my-review',
          dependsOn: [],
          conditions: [{ id: 'c1', kind: 'review', target: 'o1' }],
          actions: [],
          revision: 1,
          status: 'pending',
          evidence: []
        }
      ],
      removals: [],
      attempts: [],
      continuation: {
        owner: 'execution-host',
        hostId: 'local',
        epoch: 'e1',
        state: 'owned'
      },
      updatedAt: 3
    }
  }
  const saves: number[] = []
  // The worker pane a host launch records: the Dispatch row, not the step. A seat launched by
  // the renderer carries `launchedPaneKey` instead; both read as the same conversation.
  const dispatches: Record<string, { assignee_pane_key: string | null }> = {
    dispatch_1: { assignee_pane_key: 'worker-9:leaf-3' }
  }
  const runtime = {
    listSessionChains: () => [chain],
    getOrchestrationDb: () => ({
      getDispatchContextById: (id: string) => dispatches[id],
      getDispatchContext: () => undefined
    }),
    getSessionOutcomeService: () => ({
      epoch: 'epoch-1',
      save: (next: SessionChain, expectedRevision: number) => {
        saves.push(expectedRevision)
        if (expectedRevision !== chain.outcomeSet!.revision) {
          throw new Error('Outcome revision conflict. Reload the saved outcomes.')
        }
        chain = next
        return next
      }
    })
  } as unknown as OrcaRuntimeService
  const seat = (): SessionChainAgentStep => chain.steps[0] as SessionChainAgentStep
  const write = (prompts: PromptQueueEntry[]): void => {
    chain = { ...chain, steps: [{ ...seat(), prompts }] }
  }
  return {
    runtime,
    saves,
    prompts: (): PromptQueueEntry[] => seat().prompts ?? ([] as PromptQueueEntry[]),
    attempts: () => chain.outcomeSet!.attempts,
    /** What another writer — the host tick — does behind the drain's back. */
    settleFromTick: (id: string, change: Partial<PromptQueueEntry>): void => {
      write(
        (seat().prompts ?? []).map((prompt) =>
          prompt.id === id ? ({ ...prompt, ...change } as PromptQueueEntry) : prompt
        )
      )
    },
    recordAttemptFromTick: (over: Partial<SessionOutcomeAttempt> = {}): void => {
      chain = {
        ...chain,
        outcomeSet: {
          ...chain.outcomeSet!,
          attempts: [
            {
              id: 'a1',
              outcomeId: 'o1',
              actionId: 'step_step_1',
              actionKey: 'k',
              outcomeRevision: 1,
              state: 'running',
              startedAt: 1,
              updatedAt: 2,
              ...over
            }
          ]
        }
      }
    },
    /** The chain as the tick snapshotted it, before anything else wrote to the seat. */
    snapshot: (): SessionChain => structuredClone(chain),
    save: (next: SessionChain): void => {
      runtime.getSessionOutcomeService().save(next, chain.outcomeSet!.revision)
    },
    attach: (text: string, state: UpNextBlock['state'] = 'draft'): void => {
      void upNextAttachStagePrompts({ runtime, rowKey: chain.sourceRowKey }, [
        {
          id: 'draft:p',
          kind: 'prompt',
          state,
          number: '1.1',
          locked: false,
          text,
          target: { kind: 'stage', blockId: 'node:step_1' }
        }
      ])
    },
    onDeliver: (hook: () => void): void => {
      door.hook = hook
    }
  }
}

describe('stage prompts', () => {
  it('sends nothing for a stage that has not launched', async () => {
    door.sent = []
    readiness.ready = true
    const world = host({ prompts: [prompt('p1', 'Check every Done When.')] })

    await drainUpNextStagePrompts(world.runtime, { epoch: 'epoch-1' })

    expect(door.sent).toEqual([])
    expect(world.prompts().map((entry) => entry.state)).toEqual(['queued'])
  })

  it('waits while the stage’s own seat is busy', async () => {
    door.sent = []
    readiness.ready = false
    const world = host({
      status: 'launched',
      launchedPaneKey: 'worker-1:leaf-1',
      prompts: [prompt('p1', 'Check every Done When.')]
    })

    await drainUpNextStagePrompts(world.runtime, { epoch: 'epoch-1' })

    expect(door.sent).toEqual([])
    expect(world.prompts().map((entry) => entry.state)).toEqual(['queued'])
  })

  it('delivers one prompt at a time into the seat’s own conversation, with its receipt', async () => {
    door.sent = []
    readiness.ready = true
    const world = host({
      status: 'launched',
      launchedPaneKey: 'worker-1:leaf-1',
      prompts: [prompt('p1', 'Check every Done When.'), prompt('p2', 'Continue')]
    })

    await drainUpNextStagePrompts(world.runtime, { epoch: 'epoch-1' })
    expect(door.sent).toEqual([{ pane: 'worker-1:leaf-1', text: 'Check every Done When.' }])
    expect(world.prompts().map((entry) => [entry.id, entry.state])).toEqual([
      ['p1', 'delivered'],
      ['p2', 'queued']
    ])
    expect(world.prompts()[0]!.deliveryEpoch).toBe('epoch-1')
    // Every write went through the outcome revision CAS.
    expect(world.saves.every((revision) => revision === 3)).toBe(true)

    await drainUpNextStagePrompts(world.runtime, { epoch: 'epoch-1' })
    expect(door.sent.map((entry) => entry.text)).toEqual(['Check every Done When.', 'Continue'])
  })

  it('records a delivery that could not be made, and never retries it silently', async () => {
    door.sent = []
    door.fail = true
    readiness.ready = true
    const world = host({
      status: 'launched',
      launchedPaneKey: 'worker-1:leaf-1',
      prompts: [prompt('p1', 'Check every Done When.')]
    })

    await drainUpNextStagePrompts(world.runtime, { epoch: 'epoch-1' })
    door.fail = false

    expect(world.prompts()[0]).toMatchObject({ state: 'failed', reason: 'the pane is gone' })
    await drainUpNextStagePrompts(world.runtime, { epoch: 'epoch-1' })
    expect(door.sent).toEqual([])
  })

  it('never clobbers what the tick wrote while it was sending', async () => {
    door.sent = []
    readiness.ready = true
    const world = host({
      status: 'launched',
      launchedPaneKey: 'worker-1:leaf-1',
      prompts: [prompt('p1', 'Check every Done When.'), prompt('p2', 'Continue')]
    })
    // The tick settles this prompt while the delivery is in flight: the drain's own
    // settlement must lose, because the state it expected is no longer there.
    world.onDeliver(() => world.settleFromTick('p1', { state: 'failed', reason: 'tick got there' }))

    await drainUpNextStagePrompts(world.runtime, { epoch: 'epoch-1' })

    expect(world.prompts()[0]).toMatchObject({ state: 'failed', reason: 'tick got there' })
    // And the seat's other prompts are exactly as the tick left them.
    expect(world.prompts().map((entry) => entry.id)).toEqual(['p1', 'p2'])
  })

  it('leaves an attempt the tick recorded in place when it appends a prompt', () => {
    readiness.ready = true
    const world = host({ status: 'launched', launchedPaneKey: 'worker-1:leaf-1' })
    world.recordAttemptFromTick()

    world.attach('Check every Done When.')

    expect(world.attempts()).toHaveLength(1)
    expect(world.prompts().map((entry) => entry.text)).toEqual(['Check every Done When.'])
  })

  it('attaches a prompt a review was holding, not only a fresh draft', () => {
    readiness.ready = true
    const world = host({ status: 'launched', launchedPaneKey: 'worker-1:leaf-1' })

    // The commit that queues the held stage passes its own blocks; a held one reads
    // `waiting`, and attaching it is the whole difference between delivered and deleted.
    world.attach('Start with the receipt test.', 'waiting')

    expect(world.prompts().map((entry) => [entry.text, entry.state])).toEqual([
      ['Start with the receipt test.', 'queued']
    ])
  })

  it('delivers into the pane a HOST launch recorded, with no pane key on the step', async () => {
    door.sent = []
    readiness.ready = true
    // Exactly what the outcome executor leaves behind: an attempt with a Dispatch, and a step
    // that never learned a pane — the renderer launcher is the only writer of `launchedPaneKey`
    // and it refuses outcome-bound chains. This seat used to hold its prompt forever.
    const world = host({ prompts: [prompt('p1', 'Check every Done When.')] })
    world.recordAttemptFromTick({ dispatchId: 'dispatch_1' })
    expect(world.prompts().map((entry) => entry.state)).toEqual(['queued'])

    await drainUpNextStagePrompts(world.runtime, { epoch: 'epoch-1' })

    expect(door.sent).toEqual([{ pane: 'worker-9:leaf-3', text: 'Check every Done When.' }])
    expect(world.prompts().map((entry) => entry.state)).toEqual(['delivered'])
  })

  it('holds no prompt once every one of them is settled', () => {
    readiness.ready = true
    const world = host({
      status: 'launched',
      launchedPaneKey: 'worker-1:leaf-1',
      prompts: [prompt('p1', 'Check every Done When.', { state: 'delivered', deliveredAt: 7 })]
    })

    // The guard is a question about state, not about an array that is never emptied: a seat
    // whose history is delivered rows makes every later tick await a drain that does nothing.
    expect(upNextHoldsStagePrompts(world.runtime)).toBe(false)

    world.attach('And one more thing.')
    expect(upNextHoldsStagePrompts(world.runtime)).toBe(true)
  })

  it('would send one prompt twice if a stale whole-chain save rolled its receipt back', async () => {
    door.sent = []
    readiness.ready = true
    const world = host({
      status: 'launched',
      launchedPaneKey: 'worker-1:leaf-1',
      prompts: [prompt('p1', 'Check every Done When.'), prompt('p2', 'Continue')]
    })
    // The tick takes ONE snapshot and saves it whole, at the same revision, after its awaits.
    const stale = world.snapshot()

    await drainUpNextStagePrompts(world.runtime, { epoch: 'epoch-1' })
    expect(world.prompts().map((entry) => entry.state)).toEqual(['delivered', 'queued'])

    world.save(stale)

    expect(world.prompts().map((entry) => entry.state)).toEqual(['queued', 'queued'])
    await drainUpNextStagePrompts(world.runtime, { epoch: 'epoch-1' })
    // The bytes moved twice: this is the write the tick now carries prompts through.
    expect(door.sent.map((entry) => entry.text)).toEqual([
      'Check every Done When.',
      'Check every Done When.'
    ])
  })

  it('carries the live prompts into that save, so the receipt stands', async () => {
    door.sent = []
    readiness.ready = true
    const world = host({
      status: 'launched',
      launchedPaneKey: 'worker-1:leaf-1',
      prompts: [prompt('p1', 'Check every Done When.'), prompt('p2', 'Continue')]
    })
    const stale = world.snapshot()

    await drainUpNextStagePrompts(world.runtime, { epoch: 'epoch-1' })
    const carried = upNextCarriedStagePrompts(world.runtime, stale)
    world.save(carried)

    expect(world.prompts().map((entry) => [entry.id, entry.state])).toEqual([
      ['p1', 'delivered'],
      ['p2', 'queued']
    ])
    await drainUpNextStagePrompts(world.runtime, { epoch: 'epoch-1' })
    // In order, once each: the next prompt, never the one already sent.
    expect(door.sent.map((entry) => entry.text)).toEqual(['Check every Done When.', 'Continue'])
  })

  it('settles a send this process cannot account for instead of repeating it', async () => {
    door.sent = []
    readiness.ready = true
    const world = host({
      status: 'launched',
      launchedPaneKey: 'worker-1:leaf-1',
      prompts: [
        prompt('p1', 'Check every Done When.', {
          state: 'sending',
          deliveryEpoch: 'a-dead-process'
        })
      ]
    })

    await drainUpNextStagePrompts(world.runtime, { epoch: 'epoch-1' })

    expect(door.sent).toEqual([])
    expect(world.prompts()[0]!.state).toBe('failed')
    expect(world.prompts()[0]!.reason).toContain('restarted')
  })
})
