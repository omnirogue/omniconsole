import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ConversationSource } from '../../shared/conversation-source'
import type { DeliverableVerifierSettings } from '../../shared/deliverable-verifier-settings'
import type {
  PromptQueue,
  PromptQueueEnqueueInput,
  PromptQueueEntry
} from '../../shared/prompt-queue-types'
import type { DeliveredFileReading } from '../runtime/delivered-file-read'
import type { FinishedTurn } from '../next-steps/next-step-turn-signal'
import { DeliverableVerificationStore } from './deliverable-verification-store'
import {
  DeliverableVerifierService,
  type DeliverableVerifierDeps
} from './deliverable-verifier-service'

const source: ConversationSource = { worktreeId: 'wt-1', paneKey: 'pane-1', kind: 'pty' }

function setup(
  options: {
    mode?: DeliverableVerifierSettings['mode']
    files?: Record<string, DeliveredFileReading>
  } = {}
) {
  const files = options.files ?? {}
  const settings: DeliverableVerifierSettings = { mode: options.mode ?? 'on', maxRepairs: 2 }
  const queue: PromptQueue = { source, entries: [] }
  const enqueued: PromptQueueEnqueueInput[] = []
  const store = new DeliverableVerificationStore({
    directory: mkdtempSync(join(tmpdir(), 'dv-svc-'))
  })
  const scheduled: (() => void)[] = []
  const cancelled: number[] = []
  const state = { chainBound: false, keepGoing: false, waiting: false, question: false }
  const deps: DeliverableVerifierDeps = {
    settings: () => settings,
    store,
    now: () => 5_000,
    schedule: (run) => {
      const index = scheduled.push(run) - 1
      return () => void cancelled.push(index)
    },
    resolveWorkspace: () => ({ path: '/repo' }),
    hostLabel: () => 'this computer',
    home: () => '/home/me',
    caseInsensitive: () => false,
    readLocalFile: async (path) => files[path] ?? { status: 'unreadable', code: 'ENOENT' },
    readLocalDirectory: async () => null,
    statRemote: () => null,
    writtenPaths: () => [],
    sharedUrls: () => [],
    isChainBound: () => state.chainBound,
    isKeepGoingOn: () => state.keepGoing,
    agentWaiting: () => state.waiting,
    pendingQuestion: () => state.question,
    readQueue: () => queue,
    enqueue: (_source, input) => {
      enqueued.push(input)
      queue.entries.push({
        id: input.id,
        text: input.text,
        createdAt: 1,
        state: 'queued',
        ...(input.automation ? { automation: input.automation } : {})
      })
    }
  }
  return {
    service: new DeliverableVerifierService(deps),
    settings,
    store,
    queue,
    enqueued,
    scheduled,
    cancelled,
    state,
    files
  }
}

const turn = (turnKey: string, reply: string, prompt?: string): FinishedTurn => ({
  conversation: source,
  turnKey,
  lastAssistantMessage: reply,
  ...(prompt ? { lastUserPrompt: prompt } : {})
})

const ok = (path: string): DeliveredFileReading => ({
  status: 'file',
  path,
  hash: 'f'.repeat(64),
  size: 9,
  mtimeMs: 9_000
})

describe('DeliverableVerifierService', () => {
  it('watches only by default: records the gap, sends nothing', async () => {
    const { service, enqueued } = setup({ mode: 'shadow' })
    const record = await service.verify(turn('t1', 'I saved the plan to `docs/plan.md`.'), 1_000)
    expect(record).toMatchObject({
      overall: 'incomplete',
      action: 'would-repair',
      mode: 'shadow',
      repairsSent: 0
    })
    expect(record?.checks[0]).toMatchObject({
      target: 'docs/plan.md',
      verdict: 'missing',
      source: 'claim'
    })
    expect(enqueued).toEqual([])
  })

  it('sends one marked repair in on mode, recorded before it is queued', async () => {
    const { service, enqueued, store } = setup()
    const record = await service.verify(
      turn('t1', 'Done.', 'Write the summary to `docs/summary.md`.'),
      1_000
    )
    expect(record).toMatchObject({ action: 'repair-sent', repairsSent: 1 })
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toMatchObject({
      id: `deliverable-repair:${record!.requestId}:1`,
      automation: { kind: 'deliverable-repair', verificationId: record!.id, attempt: 1 }
    })
    expect(enqueued[0]!.text).toMatch(/^\[from Deliverable check 1\/2 · dv-[a-f0-9]{8}\]/)
    expect(enqueued[0]!.text).toContain('docs/summary.md (you were asked to write it there)')
    expect(store.list()).toHaveLength(1)
    // The same turn again is never a second attempt.
    expect(
      await service.verify(turn('t1', 'Done.', 'Write the summary to `docs/summary.md`.'), 1_000)
    ).toBeNull()
    expect(enqueued).toHaveLength(1)
  })

  it('carries the request into the repair turn and settles when the file appears', async () => {
    const { service, files, enqueued } = setup()
    const first = await service.verify(
      turn('t1', 'Done.', 'Write the summary to `docs/summary.md`.'),
      1_000
    )
    files['/repo/docs/summary.md'] = ok('/repo/docs/summary.md')
    const second = await service.verify(turn('t2', 'Wrote it.', enqueued[0]!.text), null)
    expect(second).toMatchObject({
      requestId: first!.requestId,
      requestStartedAt: 1_000,
      overall: 'complete',
      action: 'none'
    })
  })

  it('stops when a repair turn changes nothing, and after the budget', async () => {
    const { service, enqueued } = setup()
    await service.verify(
      turn('t1', 'Done.', 'Save it to `a.md` and `b.md` too, write both to the repo.'),
      1_000
    )
    const noProgress = await service.verify(turn('t2', 'Still working.', enqueued[0]!.text), null)
    expect(noProgress?.action).toBe('stopped:no-progress')

    const budget = setup()
    await budget.service.verify(turn('t1', 'Done.', 'Create `a.md` and create `b.md`.'), 1_000)
    budget.files['/repo/a.md'] = ok('/repo/a.md')
    budget.queue.entries.length = 0
    const second = await budget.service.verify(
      turn('t2', 'Fixed a.', budget.enqueued[0]!.text),
      null
    )
    expect(second).toMatchObject({ action: 'repair-sent', repairsSent: 2 })
    budget.queue.entries.length = 0
    budget.files['/repo/b.md'] = ok('/repo/b.md')
    const third = await budget.service.verify(
      turn('t3', 'I created `c.md`.', budget.enqueued[1]!.text),
      null
    )
    expect(third?.action).toBe('exhausted')
  })

  it('skips for a person, Keep going or a queued message, and leaves planned sessions alone', async () => {
    const reply = 'I created `x.md`.'
    const asks = setup()
    expect(
      (await asks.service.verify(turn('t1', `${reply} Should I also add tests?`), 1))?.action
    ).toBe('skipped:asks-person')
    const keepGoing = setup()
    keepGoing.state.keepGoing = true
    expect((await keepGoing.service.verify(turn('t1', reply), 1))?.action).toBe(
      'skipped:keep-going'
    )
    const queued = setup()
    queued.queue.entries.push({ id: 'person', text: 'hi', createdAt: 1, state: 'queued' })
    expect((await queued.service.verify(turn('t1', reply), 1))?.action).toBe(
      'skipped:queued-message'
    )
    const planned = setup()
    planned.state.chainBound = true
    expect(await planned.service.verify(turn('t1', reply), 1)).toBeNull()
    const off = setup({ mode: 'off' })
    expect(await off.service.verify(turn('t1', reply), 1)).toBeNull()
  })

  it('records nothing for a turn with nothing to check', async () => {
    const { service, store } = setup()
    expect(await service.verify(turn('t1', 'All good, nothing to write.'), 1)).toBeNull()
    expect(store.list()).toEqual([])
  })

  it('times the request from the first busy signal and checks after the delay', async () => {
    const { service, scheduled, store } = setup({ mode: 'shadow' })
    service.onTurnSignal({ kind: 'busy', conversation: source })
    service.onTurnSignal({ kind: 'finished', turn: turn('t1', 'I created `x.md`.') })
    expect(scheduled).toHaveLength(1)
    scheduled[0]!()
    await vi.waitFor(() => expect(store.list()).toHaveLength(1))
    expect(store.list()[0]?.requestStartedAt).toBe(5_000)
  })

  it('guards delivery: on mode, its own record, no person waiting or queued', async () => {
    const { service, settings, queue, state, enqueued } = setup()
    await service.verify(turn('t1', 'I created `x.md`.'), 1)
    const entry = queue.entries.find(
      (candidate) => candidate.id === enqueued[0]!.id
    ) as PromptQueueEntry
    expect(() => service.assertDelivery(source, entry)).not.toThrow()
    expect(service.hasOutstandingRepair(source)).toBe(true)
    state.question = true
    expect(() => service.assertDelivery(source, entry)).toThrow(/waiting for the person/)
    state.question = false
    queue.entries.push({ id: 'person', text: 'stop', createdAt: 2, state: 'queued' })
    expect(() => service.assertDelivery(source, entry)).toThrow(/Another message is waiting/)
    queue.entries.pop()
    // The steward's prompt, or a failed message of the person's holding the queue, also refuses.
    queue.entries.push({
      id: 'session-manage:1',
      text: '[from steward] Run the tests.',
      createdAt: 2,
      state: 'queued',
      requestedBy: { action: 'continue', actor: 'steward' }
    })
    expect(() => service.assertDelivery(source, entry)).toThrow(/Another message is waiting/)
    queue.entries.pop()
    queue.entries.push({ id: 'failed', text: 'x', createdAt: 2, state: 'failed', holdsQueue: true })
    expect(() => service.assertDelivery(source, entry)).toThrow(/Another message is waiting/)
    queue.entries.pop()
    settings.mode = 'shadow'
    expect(() => service.assertDelivery(source, entry)).toThrow(/not set to ask/)
    settings.mode = 'on'
    expect(() => service.assertDelivery(source, { ...entry, id: 'other' })).toThrow(/no record/)
  })

  it('reads a turn without its prompt as the answer to the repair sent last, never a fresh request', async () => {
    const { service, queue } = setup()
    const first = await service.verify(turn('t1', 'I created `x.md`.'), 1)
    expect(first).toMatchObject({ action: 'repair-sent', repairsSent: 1 })
    queue.entries.length = 0
    // The agent's done payload carried no prompt, and it claims the same missing file again.
    const second = await service.verify(turn('t2', 'I created `x.md`.'), null)
    expect(second).toMatchObject({ requestId: first!.requestId, action: 'stopped:no-progress' })
  })

  it('never sends more than three repairs to one conversation in an hour, whatever the requests', async () => {
    const { service, queue, enqueued } = setup()
    for (const [index, name] of ['a', 'b', 'c'].entries()) {
      const record = await service.verify(turn(`t${index}`, 'Done.', `Create \`${name}.md\`.`), 1)
      expect(record?.action).toBe('repair-sent')
      queue.entries.length = 0
    }
    const fourth = await service.verify(turn('t9', 'Done.', 'Create `d.md`.'), 1)
    expect(fourth?.action).toBe('skipped:hourly-cap')
    expect(enqueued).toHaveLength(3)
  })

  it('waits behind a failed message of the person’s that holds the queue', async () => {
    const { service, queue } = setup()
    queue.entries.push({ id: 'p1', text: 'x', createdAt: 1, state: 'failed', holdsQueue: true })
    expect((await service.verify(turn('t1', 'I created `x.md`.'), 1))?.action).toBe(
      'skipped:queued-message'
    )
  })

  it('cancels only the closed pane’s check, matched whole', async () => {
    const { service, cancelled } = setup({ mode: 'shadow' })
    const other: ConversationSource = { worktreeId: 'wt-1', paneKey: 'pane-10', kind: 'pty' }
    service.onTurnSignal({ kind: 'finished', turn: turn('t1', 'I created `x.md`.') })
    service.onTurnSignal({
      kind: 'finished',
      turn: { ...turn('t2', 'I created `y.md`.'), conversation: other }
    })
    service.onPaneClosed('pane-10')
    expect(cancelled).toEqual([1])
  })
})
