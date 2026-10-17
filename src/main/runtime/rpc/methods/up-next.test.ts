/**
 * The Up next contract: who may read it, who may decide it, what it says, and what a write
 * really does to the engine underneath.
 *
 * Two things only this test can check: that an AGENT cannot read or edit the chain of a
 * person's conversation, and that committing composed blocks goes through the ONE lowering
 * the host already has — one Outcome, one condition pair per reviewer, a stage marker on
 * every seat, and prompts that go to the prompt queue or to a stage, never to both.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

const readiness = vi.hoisted(() => ({ ready: true }))
vi.mock('../../conversation-readiness', () => ({
  observeConversationReadiness: async () => ({
    ready: readiness.ready,
    // `free` is the reading the Now row and the queue drain use; a stub that only knows
    // whether a turn finished answers both the same way (`conversation-readiness.ts`).
    free: readiness.ready,
    unverifiable: false
  })
}))

const door = vi.hoisted(() => ({ sent: [] as string[] }))
vi.mock('../../conversation-delivery', () => ({
  deliverToConversation: async (
    _runtime: unknown,
    _source: unknown,
    text: string
  ): Promise<{ door: 'pty'; deliveredAt: number }> => {
    door.sent.push(text)
    return { door: 'pty', deliveredAt: 99 }
  }
}))

import { normalizeUpNextDrafts } from '../../../../shared/up-next-draft-schema'
import type { SessionChain, SessionChainAgentStep } from '../../../../shared/session-chain-types'
import type { SessionOutcomeAttempt } from '../../../../shared/session-outcome-types'
import {
  UP_NEXT_REASON_KEYS,
  UP_NEXT_REFUSAL_KEYS,
  UP_NEXT_RPC,
  type UpNextAgentBlock,
  type UpNextView
} from '../../../../shared/up-next-types'
import { ALL_RPC_METHODS } from './index'
import { conversationId, harness, rowKey, type UpNextHarness } from './up-next-harness'
import { UP_NEXT_METHODS } from './up-next'

const list = async (host: UpNextHarness): Promise<UpNextView> =>
  (await host.call(UP_NEXT_RPC.list, { conversationId })).view

const append = (host: UpNextHarness, draft: unknown): Promise<{ view: UpNextView }> =>
  host.call(UP_NEXT_RPC.append, { conversationId, draft })

const stage = (over: Record<string, unknown> = {}): unknown => ({
  kind: 'agent',
  template: 'improve',
  instruction: 'Improve the receipt signing.',
  ...over
})

/**
 * Where the people who receive this work can read the conversation. Only the real host can
 * name it, so the harness's runtime is given the reading it would have made.
 */
const TRANSCRIPT = {
  kind: 'provider' as const,
  hostId: 'local',
  agent: 'claude',
  sessionId: 'sess_1',
  transcriptPath: '/w/.claude/sess_1.jsonl'
}

function withTranscriptSource(host: UpNextHarness): UpNextHarness {
  Object.assign(host.ctx.runtime as object, {
    getSessionOutcomeTranscriptSource: () => TRANSCRIPT
  })
  return host
}

function committedChain(over: Partial<SessionChain> = {}): SessionChain {
  return {
    id: 'source_1',
    workspacePath: '/w',
    worktreeId: 'wt',
    hostId: 'local',
    sourcePaneKey: conversationId.paneKey,
    sourceRowKey: rowKey,
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 2,
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      outcomes: [
        {
          id: 'o1',
          title: 'Receipts are signed',
          finish: 'my-review',
          dependsOn: [],
          conditions: [{ id: 'o1_review', kind: 'review', target: 'o1' }],
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
        state: 'owned',
        sourceReady: true
      },
      updatedAt: 10
    },
    ...over
  }
}

function agentStep(over: Partial<SessionChainAgentStep> = {}): SessionChainAgentStep {
  return {
    id: 'step_1',
    agent: 'claude',
    prompt: 'Improve it.',
    presetId: 'improve',
    planNodeId: 'work',
    status: 'queued',
    ...over
  }
}

const running = (over: Partial<SessionOutcomeAttempt> = {}): SessionOutcomeAttempt => ({
  id: 'a1',
  outcomeId: 'o1',
  actionId: 'step_step_1',
  actionKey: 'k',
  outcomeRevision: 1,
  state: 'running',
  startedAt: 1_000,
  updatedAt: 2_000,
  ...over
})

describe('upNext registration, schemas and authority', () => {
  it('registers every method on the runtime', () => {
    const registered = new Set(ALL_RPC_METHODS.map((method) => method.name))
    for (const name of Object.values(UP_NEXT_RPC)) {
      expect(registered.has(name)).toBe(true)
    }
    expect(UP_NEXT_METHODS).toHaveLength(Object.keys(UP_NEXT_RPC).length)
  })

  it('refuses a draft the person cannot author, and an impossible reorder', () => {
    const host = harness()
    expect(() =>
      host.parse(UP_NEXT_RPC.append, { conversationId, draft: { kind: 'prompt', text: '' } })
    ).toThrow()
    expect(() =>
      host.parse(UP_NEXT_RPC.append, {
        conversationId,
        draft: { kind: 'agent', template: 'improve', state: 'running' }
      })
    ).toThrow()
    expect(() =>
      host.parse(UP_NEXT_RPC.reorder, { conversationId, blockId: 'node:work', direction: 0 })
    ).toThrow()
    expect(() =>
      host.parse(UP_NEXT_RPC.append, {
        conversationId,
        draft: { kind: 'person', relationship: 'review', people: [{ id: 'emp_1', name: 'Sal' }] }
      })
    ).not.toThrow()
  })

  it('refuses an agent caller — the read included', async () => {
    for (const agent of [
      { orchestrationCapability: 'cap_1' },
      { orchestrationCompatibilityEvidence: { agentSessionId: 'chat_1' } }
    ]) {
      const host = harness(agent as never)
      await expect(list(host)).rejects.toThrow('authenticated user interface')
      await expect(append(host, stage())).rejects.toThrow('authenticated user interface')
      await expect(host.call(UP_NEXT_RPC.commit, { conversationId })).rejects.toThrow(
        'authenticated user interface'
      )
    }
  })

  it('refuses a chat conversation that names no session to address', async () => {
    const host = harness()
    await expect(
      host.call(UP_NEXT_RPC.list, { conversationId: { ...conversationId, kind: 'structured' } })
    ).rejects.toThrow('cannot be addressed')
  })

  it('lets the local CLI read, and refuses every decision from it', async () => {
    const host = harness({ clientId: undefined })
    await expect(list(host)).resolves.toMatchObject({ rowKey })
    for (const [name, params] of [
      [UP_NEXT_RPC.append, { conversationId, draft: stage() }],
      [UP_NEXT_RPC.remove, { conversationId, blockId: 'draft:x' }],
      [UP_NEXT_RPC.commit, { conversationId }],
      [UP_NEXT_RPC.discardDrafts, { conversationId }]
    ] as const) {
      await expect(host.call(name, params)).rejects.toThrow('authenticated user interface')
    }
  })
})

describe('composing Up next', () => {
  it('holds composed blocks as drafts, numbers prompts under their stage, and keeps them across a restart', async () => {
    readiness.ready = false
    const host = harness()
    await append(host, stage())
    await append(host, { kind: 'prompt', text: 'Check every Done When.' })
    const view = (await append(host, { kind: 'prompt', text: 'Have you done your best job?' })).view

    expect(view.blocks.map((block) => [block.kind, block.number, block.state])).toEqual([
      ['agent', '1', 'draft'],
      ['prompt', '1.1', 'draft'],
      ['prompt', '1.2', 'draft']
    ])
    expect(view.blocks[1]!.kind === 'prompt' && view.blocks[1]!.target).toEqual({
      kind: 'stage',
      blockId: view.blocks[0]!.id
    })
    expect(view.blocks[0]!.kind === 'agent' && view.blocks[0]!.promptCount).toBe(2)
    expect(view.draftCount).toBe(3)
    expect(view.summary.start).toBe('after-current-work')

    // Restart survival: the record on disk, read back the way the loader reads it.
    const reloaded = harness(
      {},
      {
        state: {
          upNextDrafts: normalizeUpNextDrafts(JSON.parse(JSON.stringify(host.state.upNextDrafts)))
        }
      }
    )
    const after = await list(reloaded)
    expect(after.blocks.map((block) => [block.kind, block.number, block.state])).toEqual(
      view.blocks.map((block) => [block.kind, block.number, block.state])
    )
  })

  it('ends the track at a handoff, and Done takes nothing after it', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage())
    const withDone = (await append(host, { kind: 'done' })).view
    expect(withDone.blocks.map((block) => block.kind)).toEqual(['agent', 'done'])
    expect(withDone.canAdd.reasons.agent).toBe(UP_NEXT_REASON_KEYS.doneLastRemoveToAdd)
    await expect(append(host, stage())).rejects.toThrow(UP_NEXT_REASON_KEYS.doneLastRemoveToAdd)

    await host.call(UP_NEXT_RPC.discardDrafts, { conversationId })
    await append(host, {
      kind: 'person',
      relationship: 'handoff',
      people: [{ id: 'emp_1', name: 'Jordan Taylor' }]
    })
    const view = await list(host)
    expect(view.canAdd).toMatchObject({ prompt: false, agent: false, person: false, done: false })
    expect(view.canAdd.reasons.agent).toBe(UP_NEXT_REASON_KEYS.handoffTerminal)
    await expect(append(host, stage())).rejects.toThrow(UP_NEXT_REASON_KEYS.handoffTerminal)
    expect(view.notation).toBe('👤 Sal ■')
  })

  it('moves and removes a draft, and refuses to move an end cap', async () => {
    readiness.ready = true
    const host = harness()
    const first = (await append(host, stage({ instruction: 'First.' }))).view.blocks[0]!.id
    await append(host, stage({ instruction: 'Second.' }))
    await append(host, { kind: 'done' })

    const moved = (
      await host.call(UP_NEXT_RPC.reorder, { conversationId, blockId: first, direction: 1 })
    ).view
    expect(
      moved.blocks.map((block) => (block.kind === 'agent' ? block.instruction : block.kind))
    ).toEqual(['Second.', 'First.', 'done'])

    const done = moved.blocks.at(-1)!
    await expect(
      host.call(UP_NEXT_RPC.reorder, { conversationId, blockId: done.id, direction: -1 })
    ).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.capIsTerminal)

    const removed = (await host.call(UP_NEXT_RPC.remove, { conversationId, blockId: first })).view
    expect(removed.blocks.map((block) => block.kind)).toEqual(['agent', 'done'])
    expect(host.drafts()?.entries).toHaveLength(2)

    await host.call(UP_NEXT_RPC.discardDrafts, { conversationId })
    expect(host.drafts()).toBeNull()
    expect((await list(host)).draftCount).toBe(0)
  })

  it('refuses to edit a queued stage and offers a copy after it instead', async () => {
    readiness.ready = true
    const chain = committedChain({
      steps: [agentStep()],
      outcomeSet: { ...committedChain().outcomeSet!, attempts: [running()] }
    })
    const host = harness({}, { chains: [chain] })
    const view = await list(host)
    const block = view.blocks[0]!

    expect(block.state).toBe('running')
    expect(block.locked).toBe(true)
    await expect(
      host.call(UP_NEXT_RPC.update, {
        conversationId,
        blockId: block.id,
        patch: { kind: 'agent', n: 3 }
      })
    ).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.blockRunning)

    const after = (
      await host.call(UP_NEXT_RPC.configureAfter, { conversationId, blockId: block.id })
    ).view
    expect(after.blocks.map((entry) => [entry.kind, entry.state])).toEqual([
      ['agent', 'running'],
      ['agent', 'draft']
    ])
    const copy = after.blocks[1] as UpNextAgentBlock
    expect(copy.template).toBe('improve')
  })
})

describe('queueing Up next', () => {
  it('queues a prompt to the current agent, and sends one Now through the same door', async () => {
    readiness.ready = false
    door.sent = []
    const host = harness()
    await append(host, { kind: 'prompt', text: 'After you finish.' })
    await host.call(UP_NEXT_RPC.commit, { conversationId })

    expect(host.queue()?.entries.map((entry) => [entry.text, entry.state])).toEqual([
      ['After you finish.', 'queued']
    ])
    expect(door.sent).toEqual([])
    expect(host.commits).toHaveLength(0)

    await append(host, { kind: 'prompt', text: 'Now, interrupt.', when: 'now' })
    await host.call(UP_NEXT_RPC.commit, { conversationId })
    expect(door.sent).toEqual(['Now, interrupt.'])
    const sent = host.queue()!.entries.at(-1)!
    expect(sent.state).toBe('delivered')
    expect(sent.deliveryEpoch).toBe('epoch-1')
    expect((await list(host)).summary.prompts).toBe(1)
  })

  it('commits stages as ONE plan with a stage marker, and a council stays one block', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ template: 'improve' }))
    await host.call(UP_NEXT_RPC.commit, { conversationId })

    expect(host.commits).toHaveLength(1)
    const commit = host.commits[0]!
    expect(commit.outcomes).toHaveLength(1)
    expect(commit.source).toBe('user')
    const steps = host.chains()[0]!.steps.filter((step) => step.kind !== 'handoff')
    expect(steps).toHaveLength(1)
    expect(steps[0]!.stage).toMatchObject({ shape: 'solo', width: 1 })
    expect(host.drafts()).toBeNull()

    const view = await list(host)
    expect(view.blocks.map((block) => [block.kind, block.state])).toEqual([['agent', 'queued']])
  })

  it('commits a review by two people as one condition pair each', async () => {
    readiness.ready = true
    const host = withTranscriptSource(harness())
    await append(host, stage())
    await append(host, {
      kind: 'person',
      relationship: 'review',
      people: [
        { id: 'emp_1', name: 'Jordan Taylor' },
        { id: 'emp_2', name: 'Iris Allen' }
      ],
      receive: { transcript: true }
    })
    await host.call(UP_NEXT_RPC.commit, { conversationId })

    const outcome = host.commits[0]!.outcomes[0]!
    // One obligation pair per reviewer, and no criterion the person did not ask for: work
    // that ends at people is answered by those people.
    expect(outcome.conditions.map((condition) => [condition.kind, condition.recipientId])).toEqual([
      ['handoff', 'emp_1'],
      ['review', 'emp_1'],
      ['handoff', 'emp_2'],
      ['review', 'emp_2']
    ])
    expect(outcome.finish).toBe('human-handoff')
    const handoff = host.chains()[0]!.steps.find((step) => step.kind === 'handoff')
    expect(handoff?.kind === 'handoff' && handoff.handoff.disposition).toBe('feedback')
    expect(
      handoff?.kind === 'handoff' && handoff.handoff.recipients.map((person) => person.employeeId)
    ).toEqual(['emp_1', 'emp_2'])

    const view = await list(host)
    const person = view.blocks.find((block) => block.kind === 'person')!
    expect(person.kind === 'person' && person.waitRule).toBe('all')
    expect(person.kind === 'person' && person.waiting).toMatchObject({ replied: 0, total: 2 })

    // What the review returns to: the block the track picks up at once both have replied.
    const next = (await append(host, stage({ instruction: 'Fix what they found.' }))).view
    const waiting = next.blocks.find((block) => block.kind === 'person')!
    expect(waiting.kind === 'person' && waiting.resumesAtBlockId).toBe(next.blocks.at(-1)!.id)
  })

  it('reads a lone prompt as starting now while the conversation is idle', async () => {
    readiness.ready = true
    door.sent = []
    const host = harness()
    const view = (await append(host, { kind: 'prompt', text: 'Do the next thing.' })).view

    expect(view.summary.start).toBe('now')
    expect(view.blocks.map((block) => [block.kind, block.state])).toEqual([['prompt', 'draft']])
    await host.call(UP_NEXT_RPC.commit, { conversationId })
    // Nothing was manufactured: an ordinary prompt is an ordinary message, and the host's own
    // drain sends it because the conversation is free (frozen model, invariant 2).
    expect(host.commits).toHaveLength(0)
    expect(host.chains()).toHaveLength(0)
    expect(host.queue()?.entries.map((entry) => entry.state)).toEqual(['queued'])
  })

  it('commits Done as the finish intent, with the folder the person chose', async () => {
    readiness.ready = true
    const host = harness({}, { chains: [committedChain()] })
    await append(host, { kind: 'done', finish: 'save', folderId: 'fld_acceptance' })
    await host.call(UP_NEXT_RPC.commit, { conversationId })

    expect(host.commits.at(-1)!.sessionFinish).toEqual({
      action: 'save',
      folderId: 'fld_acceptance'
    })
    const view = await list(host)
    const done = view.blocks.find((block) => block.kind === 'done')!
    expect(done.kind === 'done' && done.finish).toBe('save')
    expect(done.kind === 'done' && done.folderId).toBe('fld_acceptance')
  })

  it('holds what the person composed behind a review, and runs it when they reply', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await append(host, {
      kind: 'person',
      relationship: 'review',
      people: [{ id: 'emp_1', name: 'Jordan Taylor' }]
    })
    await append(host, stage({ template: 'improve', instruction: 'Fix what they found.' }))
    await append(host, stage({ template: 'verify', instruction: 'Check every Done When.' }))

    const queued = (await host.call(UP_NEXT_RPC.commit, { conversationId })).view

    // The review is committed with the work; what follows it is the host's to run.
    expect(host.commits).toHaveLength(1)
    expect(queued.blocks.map((block) => [block.kind, block.state])).toEqual([
      ['agent', 'queued'],
      ['person', 'queued'],
      ['agent', 'waiting'],
      ['agent', 'waiting']
    ])
    const held = queued.blocks[2]!
    const review = queued.blocks[1]!
    expect(held.heldFor).toEqual({ kind: 'review', blockId: review.id })
    expect(held.locked).toBe(false)
    expect(queued.draftCount).toBe(0)
    // Counted as work, not as something still to send: three stages and one person.
    expect(queued.summary).toMatchObject({ stages: 3, people: 1 })

    // Nothing runs while the review is out.
    await host.resume()
    expect(host.commits).toHaveLength(1)

    // It survives a restart exactly as it was.
    const reloaded = harness(
      {},
      {
        chains: host.chains(),
        state: {
          upNextDrafts: normalizeUpNextDrafts(JSON.parse(JSON.stringify(host.state.upNextDrafts)))
        }
      }
    )
    const after = await list(reloaded)
    expect(after.blocks.map((block) => [block.kind, block.state])).toEqual(
      queued.blocks.map((block) => [block.kind, block.state])
    )

    // The stage queued with the review finishes, as it does in life.
    const seat = host.chains()[0]!.steps.find((step) => step.kind !== 'handoff')!
    host.finishStage(seat.id)

    // Still nothing: the work is done, but nobody has replied yet. THIS is the review gate.
    await host.resume()
    expect(host.commits).toHaveLength(1)

    // The reviewer replies: the host commits the continuation as the next plan version.
    host.reply('emp_1')
    await host.resume()

    expect(host.commits).toHaveLength(2)
    // The continuation ADDS the work the review held; it does not re-plan the pursuit, so
    // nothing the person queued with the review is retired to make room for it.
    expect(host.commits[1]!.supersede).toBeUndefined()
    expect(
      host.chains()[0]!.steps.filter((step) => step.kind !== 'handoff' && step.status === 'skipped')
    ).toEqual([])
    const view = await list(host)
    expect(view.blocks.filter((block) => block.state === 'waiting')).toEqual([])
    // What the first version finished stays as a done row; the continuation is queued work.
    expect(
      view.blocks.filter((block) => block.kind === 'agent').map((block) => block.state)
    ).toEqual(['done', 'queued', 'queued'])
    expect(host.drafts()).toBeNull()
  })

  it('still refuses anything after a handoff, which ends the track', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, {
      kind: 'person',
      relationship: 'handoff',
      people: [{ id: 'emp_1', name: 'Jordan Taylor' }]
    })
    await expect(append(host, stage())).rejects.toThrow(UP_NEXT_REASON_KEYS.handoffTerminal)
  })

  it('never retires work that has not run yet to make room for the continuation', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await append(host, {
      kind: 'person',
      relationship: 'review',
      people: [{ id: 'emp_1', name: 'Jordan Taylor' }]
    })
    await append(host, stage({ template: 'improve', instruction: 'Fix what they found.' }))
    await host.call(UP_NEXT_RPC.commit, { conversationId })

    // The reviewer answers before the stage queued with them has run: committing the next
    // version now would retire a stage the person queued and nobody ever ran.
    host.reply('emp_1')
    await host.resume()
    expect(host.commits).toHaveLength(1)

    const seat = host.chains()[0]!.steps.find((step) => step.kind !== 'handoff')!
    host.finishStage(seat.id)
    await host.resume()
    expect(host.commits).toHaveLength(2)
  })

  it('lets the person take a held block back before it runs', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, {
      kind: 'person',
      relationship: 'review',
      people: [{ id: 'emp_1', name: 'Jordan Taylor' }]
    })
    await append(host, stage({ instruction: 'Fix what they found.' }))
    const queued = (await host.call(UP_NEXT_RPC.commit, { conversationId })).view
    const held = queued.blocks.find((block) => block.state === 'waiting')!

    const view = (await host.call(UP_NEXT_RPC.remove, { conversationId, blockId: held.id })).view

    expect(view.blocks.some((block) => block.state === 'waiting')).toBe(false)
    host.reply('emp_1')
    await host.resume()
    // Nothing was left behind to run.
    expect(host.commits).toHaveLength(1)
  })

  it('attaches a prompt written under a stage to that stage, not to the conversation', async () => {
    readiness.ready = true
    door.sent = []
    const host = harness()
    await append(host, stage())
    await append(host, { kind: 'prompt', text: 'Check every Done When.' })
    await host.call(UP_NEXT_RPC.commit, { conversationId })

    const seat = host
      .chains()[0]!
      .steps.find((step): step is SessionChainAgentStep => step.kind !== 'handoff')
    expect(seat?.prompts?.map((prompt) => prompt.text)).toEqual(['Check every Done When.'])
    // It is the stage's instruction, so it never went into the conversation's own queue.
    expect(host.queue()).toBeNull()
    expect(door.sent).toEqual([])

    const view = await list(host)
    expect(view.blocks.map((block) => [block.kind, block.number, block.state])).toEqual([
      ['agent', '1', 'queued'],
      ['prompt', '1.1', 'queued']
    ])
  })

  it('composes on an unstarted thread and queues it once the conversation exists', async () => {
    readiness.ready = true
    const thread = { kind: 'thread' as const, threadId: 'hth_1' }
    const host = harness()

    const composed = (
      await host.call(UP_NEXT_RPC.append, { conversationId: thread, draft: stage() })
    ).view
    expect(composed.now).toEqual({ kind: 'idle' })
    expect(composed.header).toEqual({ state: 'idle' })
    expect(composed.blocks.map((block) => [block.kind, block.state])).toEqual([['agent', 'draft']])

    // Nothing can be queued for a thread: it has no conversation to queue into yet.
    await expect(host.call(UP_NEXT_RPC.commit, { conversationId: thread })).rejects.toThrow(
      UP_NEXT_REFUSAL_KEYS.subjectNotStarted
    )

    // Its own surface starts the session; the blocks follow it there.
    const view = (await host.call(UP_NEXT_RPC.commit, { conversationId, adoptFrom: thread })).view
    expect(host.commits).toHaveLength(1)
    expect(view.blocks.map((block) => [block.kind, block.state])).toEqual([['agent', 'queued']])
    expect(host.state.upNextDrafts).toEqual({})
  })

  it('puts a head prompt ahead of every queued stage', async () => {
    readiness.ready = false
    const host = harness()
    await append(host, stage())
    await host.call(UP_NEXT_RPC.commit, { conversationId })

    const view = (
      await host.call(UP_NEXT_RPC.append, {
        conversationId,
        draft: { kind: 'prompt', text: 'Answer this first.' },
        position: 'head'
      })
    ).view

    expect(view.blocks.map((block) => [block.kind, block.state])).toEqual([
      ['prompt', 'draft'],
      ['agent', 'queued']
    ])
    expect(view.blocks[0]!.kind === 'prompt' && view.blocks[0]!.target).toEqual({ kind: 'current' })
    expect(view.summary.start).toBe('after-current-work')
  })

  it('takes a head prompt even when the track ends at a handoff', async () => {
    readiness.ready = false
    const host = harness()
    await append(host, {
      kind: 'person',
      relationship: 'handoff',
      people: [{ id: 'emp_1', name: 'Jordan Taylor' }]
    })
    const view = (
      await host.call(UP_NEXT_RPC.append, {
        conversationId,
        draft: { kind: 'prompt', text: 'One more thing.' },
        position: 'head'
      })
    ).view

    expect(view.blocks.map((block) => block.kind)).toEqual(['prompt', 'person'])
    // The end cap still refuses everything that would run AFTER it.
    await expect(append(host, stage())).rejects.toThrow(UP_NEXT_REASON_KEYS.handoffTerminal)
  })

  it('takes a person named only by id, and keeps the name when it has one', async () => {
    readiness.ready = true
    const host = harness()
    const view = (
      await append(host, { kind: 'person', relationship: 'review', peopleIds: ['emp_7'] })
    ).view

    const person = view.blocks[0]!
    expect(person.kind === 'person' && person.people).toEqual([
      { id: 'emp_7', name: 'emp_7', initials: 'EM' }
    ])
  })

  it('refuses a commit with nothing composed', async () => {
    readiness.ready = true
    const host = harness()
    await expect(host.call(UP_NEXT_RPC.commit, { conversationId })).rejects.toThrow(
      UP_NEXT_REFUSAL_KEYS.noDrafts
    )
  })
})

/**
 * Where a moved row LANDS. A draft crossing a queued block is re-anchored rather than
 * re-ordered, so the anchor it gets is the whole behaviour: one row, in the direction the
 * person pressed, and never still pinned to where it came from.
 */
describe('moving a draft across queued blocks', () => {
  const queued = async (host: UpNextHarness, count: number): Promise<string[]> => {
    for (let n = 0; n < count; n += 1) {
      await append(host, stage({ instruction: `Stage ${n + 1}.` }))
    }
    await host.call(UP_NEXT_RPC.commit, { conversationId })
    return (await list(host)).blocks.map((block) => block.id)
  }

  const move = async (host: UpNextHarness, blockId: string, direction: 1 | -1): Promise<string[]> =>
    (await host.call(UP_NEXT_RPC.reorder, { conversationId, blockId, direction })).view.blocks.map(
      (block) => block.id
    )

  const promptDraft = async (host: UpNextHarness, text: string): Promise<string> =>
    (await append(host, { kind: 'prompt', text, when: 'after' })).view.blocks.at(-1)!.id

  it('lands directly above the queued stage it crossed, not two rows up', async () => {
    readiness.ready = true
    const host = harness()
    const stages = await queued(host, 2)
    const draft = await promptDraft(host, 'Prompt for Stage 2.')
    expect((await list(host)).blocks.map((block) => block.id)).toEqual([...stages, draft])

    // One row up from the end is BETWEEN the two stages, anchored to the one above it.
    expect(await move(host, draft, -1)).toEqual([stages[0]!, draft, stages[1]!])
    expect(host.drafts()?.entries[0]).toMatchObject({ afterBlockId: stages[0]! })
  })

  it('rises to the head when nothing is queued above the stage it crossed', async () => {
    readiness.ready = true
    const host = harness()
    const stages = await queued(host, 1)
    const draft = await promptDraft(host, 'Ask me before you start.')

    // One row up from the end of a one-stage chain is the top: the next thing the agent hears.
    expect(await move(host, draft, -1)).toEqual([draft, stages[0]!])
    expect(host.drafts()?.entries[0]).toMatchObject({ place: 'head' })
    expect(host.drafts()?.entries[0]?.afterBlockId).toBeUndefined()
  })

  it('moves exactly one row per press with several queued stages above it', async () => {
    readiness.ready = true
    const host = harness()
    const stages = await queued(host, 3)
    const draft = await promptDraft(host, 'Prompt for Stage 3.')

    expect(await move(host, draft, -1)).toEqual([stages[0]!, stages[1]!, draft, stages[2]!])
    expect(await move(host, draft, -1)).toEqual([stages[0]!, draft, stages[1]!, stages[2]!])
    // ...and back down, one row at a time, re-anchored under the stage it crossed.
    expect(await move(host, draft, 1)).toEqual([stages[0]!, stages[1]!, draft, stages[2]!])
    expect(host.drafts()?.entries[0]).toMatchObject({ afterBlockId: stages[1]! })
  })

  it('drops the head pin when a head prompt is moved down under a queued stage', async () => {
    readiness.ready = true
    const host = harness()
    const stages = await queued(host, 1)
    const head = (
      await host.call(UP_NEXT_RPC.append, {
        conversationId,
        draft: { kind: 'prompt', text: 'Read this first.' },
        position: 'head'
      })
    ).view.blocks[0]!.id
    expect((await list(host)).blocks.map((block) => block.id)).toEqual([head, stages[0]!])

    // The pin is what the projection reads FIRST, so a moved row that keeps it never moves.
    expect(await move(host, head, 1)).toEqual([stages[0]!, head])
    expect(host.drafts()?.entries[0]?.place).toBeUndefined()
    expect(host.drafts()?.entries[0]).toMatchObject({ afterBlockId: stages[0]! })
  })

  it('swaps the pin as well as the anchor when two drafts trade places', async () => {
    readiness.ready = true
    const host = harness()
    const first = (
      await host.call(UP_NEXT_RPC.append, {
        conversationId,
        draft: { kind: 'prompt', text: 'First.' },
        position: 'head'
      })
    ).view.blocks[0]!.id
    const second = (
      await host.call(UP_NEXT_RPC.append, {
        conversationId,
        draft: { kind: 'prompt', text: 'Second.' },
        position: 'end'
      })
    ).view.blocks[1]!.id

    expect(await move(host, first, 1)).toEqual([second, first])
    // The placements travelled with the rows: pressing up puts them back, unchanged.
    expect(host.drafts()?.entries[0]).toMatchObject({ id: second, place: 'head' })
    expect(host.drafts()?.entries[1]?.place).toBeUndefined()
    expect(await move(host, first, -1)).toEqual([first, second])
    expect(host.drafts()?.entries[0]).toMatchObject({ id: first, place: 'head' })
  })

  it('trades anchors when a draft crosses another draft under a queued stage', async () => {
    readiness.ready = true
    const host = harness()
    const stages = await queued(host, 1)
    const under = (
      await host.call(UP_NEXT_RPC.append, {
        conversationId,
        draft: { kind: 'prompt', text: 'Under the stage.', when: 'after' },
        insertAfterBlockId: stages[0]!
      })
    ).view.blocks[1]!.id
    const tail = await promptDraft(host, 'At the end.')
    expect((await list(host)).blocks.map((block) => block.id)).toEqual([stages[0]!, under, tail])

    expect(await move(host, under, 1)).toEqual([stages[0]!, tail, under])
    expect(host.drafts()?.entries[0]).toMatchObject({ id: tail, afterBlockId: stages[0]! })
    expect(host.drafts()?.entries[1]?.afterBlockId).toBeUndefined()
  })
})
