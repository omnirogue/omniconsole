import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

import { conversationSourceRowKey } from '../../shared/conversation-source'
import type { NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import { PROMPT_QUEUE_MAX_ENTRIES } from '../../shared/prompt-queue-types'
import type { PersistedState } from '../../shared/persisted-state-types'
import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { enqueueConversationPrompt } from '../runtime/prompt-queue-enqueue'
import {
  decideNextSteps,
  nextStepPromptQueueEntryId,
  readOfferedNextSteps
} from './next-step-decisions'
import { registerParsedNextSteps } from './next-step-turn-answers'
import { NextStepSuggestionService } from './next-step-suggestion-service'
import { NEXT_STEP_DECISIONS_FILE, NextStepSuggestionStore } from './next-step-suggestion-store'

const conversation = { worktreeId: 'repo::/w', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
let dir: string
let store: NextStepSuggestionStore

function harness() {
  const state = { promptQueues: {} } as unknown as PersistedState
  const queues = new PromptQueuePersistence(
    { state, flushOrThrow: () => {}, writesFrozen: false },
    {} as WriteSchedulingOperations
  )
  store = new NextStepSuggestionStore({ directory: dir })
  let ids = 0
  const service = new NextStepSuggestionService({
    store,
    settings: () => ({ enabled: true }),
    readPromptQueue: (source) => queues.readPromptQueue(conversationSourceRowKey(source)),
    isChainBound: () => false,
    // The same authority `promptQueue.enqueue` uses, over the real queue domain.
    enqueue: (source, input) => {
      enqueueConversationPrompt(
        { enqueuePromptQueueEntry: (...args) => queues.enqueuePromptQueueEntry(...args) },
        source,
        input
      )
    },
    generate: vi.fn(),
    newId: () => `set-${++ids}`
  })
  const queued = () =>
    queues.readPromptQueue(conversationSourceRowKey(conversation))?.entries.map((e) => e.text) ?? []
  return { service, queues, queued }
}

function pendingSet(service: NextStepSuggestionService, turnKey = 't1'): NextStepSuggestionSet {
  // Only a turn the host established can be answered: report it, as a hook would.
  service.onTurnSignal({ kind: 'skip', conversation, turnKey, reason: 'turn under test' })
  return store.upsert(
    service.newSet({ conversation, turnKey }, 'ai', 'pending', [
      { id: 's1', title: 'Run tests', prompt: 'Run the tests.', risk: 'safe', kind: 'verify' },
      { id: 's2', title: 'Review diff', prompt: 'Review the diff.', risk: 'safe', kind: 'review' },
      { id: 's3', title: 'Push', prompt: 'Push the branch.', risk: 'risky', kind: 'ship' }
    ])
  )
}

const log = () =>
  readFileSync(join(dir, NEXT_STEP_DECISIONS_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'next-steps-decide-'))
})

afterEach(async () => {
  await store.flush()
  rmSync(dir, { recursive: true, force: true })
})

describe('decideNextSteps', () => {
  it('run queues the chosen prompts in the set order and logs the decision', async () => {
    const { service, queued } = harness()
    const set = pendingSet(service)
    const result = await decideNextSteps(service, set.id, {
      action: 'run',
      suggestionIds: ['s3', 's1']
    })
    expect(result.queued).toEqual(['s1', 's3'])
    expect(result.notQueued).toEqual([])
    expect(result.set.status).toBe('accepted')
    expect(queued()).toEqual(['Run the tests.', 'Push the branch.'])
    expect(log()).toMatchObject([
      {
        setId: set.id,
        origin: 'ai',
        offered: [{ id: 's1' }, { id: 's2' }, { id: 's3', risk: 'risky' }],
        decision: { action: 'run', suggestionIds: ['s1', 's3'] }
      }
    ])
  })

  it('honours the queue limit and reports exactly which ids were not queued', async () => {
    const { service, queues, queued } = harness()
    for (let index = 0; index < PROMPT_QUEUE_MAX_ENTRIES - 1; index++) {
      queues.enqueuePromptQueueEntry(conversation, {
        id: `own-${index}`,
        text: 'mine',
        createdAt: 1,
        state: 'queued'
      })
    }
    const set = pendingSet(service)
    const result = await decideNextSteps(service, set.id, {
      action: 'run',
      suggestionIds: ['s1', 's2', 'nope']
    })
    expect(result.queued).toEqual(['s1'])
    expect(result.notQueued).toEqual([
      { id: 'nope', reason: 'That suggestion is not in this set.' },
      { id: 's2', reason: expect.stringMatching(/most prompts it can hold/) }
    ])
    expect(queued().at(-1)).toBe('Run the tests.')
    expect(result.set.status).toBe('accepted')
  })

  it('logs only what was queued, with what was not and why', async () => {
    const { service, queues } = harness()
    for (let index = 0; index < PROMPT_QUEUE_MAX_ENTRIES - 1; index++) {
      queues.enqueuePromptQueueEntry(conversation, {
        id: `own-${index}`,
        text: 'mine',
        createdAt: 1,
        state: 'queued'
      })
    }
    const set = pendingSet(service)
    await decideNextSteps(service, set.id, { action: 'run', suggestionIds: ['s1', 's2'] })
    expect(log()).toMatchObject([
      {
        decision: { action: 'run', suggestionIds: ['s1'] },
        notQueued: [{ id: 's2', reason: expect.stringMatching(/most prompts/) }]
      }
    ])
  })

  it('nothing queued reopens the set and logs nothing, so a retry logs once', async () => {
    const { service } = harness()
    const set = pendingSet(service)
    const enqueue = service.deps.enqueue
    service.deps.enqueue = () => {
      throw new Error('The conversation is gone.')
    }
    const failed = await decideNextSteps(service, set.id, { action: 'run', suggestionIds: ['s1'] })
    expect(failed).toMatchObject({ queued: [], set: { status: 'pending' } })
    expect(failed.notQueued).toEqual([{ id: 's1', reason: 'The conversation is gone.' }])
    await store.flush()
    expect(() => log()).toThrow()
    service.deps.enqueue = enqueue
    await decideNextSteps(service, set.id, { action: 'run', suggestionIds: ['s1'] })
    expect(log()).toHaveLength(1)
  })

  it('claims the set before queueing: a supersede landing mid-enqueue is never overwritten', async () => {
    const { service } = harness()
    const set = pendingSet(service)
    const seen: string[] = []
    service.deps.enqueue = () => {
      seen.push(store.get(set.id)!.status)
      store.update(set.id, (current) => ({ ...current, status: 'superseded' }))
      throw new Error('queue refused')
    }
    const result = await decideNextSteps(service, set.id, {
      action: 'run',
      suggestionIds: ['s1', 's2']
    })
    expect(seen[0]).toBe('accepted')
    expect(result.set.status).toBe('superseded')
    expect(store.get(set.id)!.status).toBe('superseded')
  })

  it('refuses a set that is not pending', async () => {
    const { service } = harness()
    for (const status of ['dismissed', 'superseded', 'generating', 'failed'] as const) {
      const set = store.upsert({ ...pendingSet(service, `t-${status}`), status })
      await expect(decideNextSteps(service, set.id, { action: 'dismiss' })).rejects.toThrow(
        new RegExp(`${status} and can no longer be answered`)
      )
    }
    await expect(decideNextSteps(service, 'missing', { action: 'dismiss' })).rejects.toThrow(
      /no longer available/
    )
  })

  it('surfaces a decision-log write failure instead of swallowing it', async () => {
    const { service } = harness()
    const set = pendingSet(service)
    vi.spyOn(store, 'appendDecision').mockRejectedValueOnce(new Error('disk full'))
    const result = await decideNextSteps(service, set.id, { action: 'dismiss' })
    expect(result.logError).toMatch(/could not be written to the decision log: disk full/)
    expect(result.set.status).toBe('dismissed')
  })

  it('a repeated run does not queue twice, because the set is no longer open', async () => {
    const { service, queued } = harness()
    const set = pendingSet(service)
    await decideNextSteps(service, set.id, { action: 'run', suggestionIds: ['s1'] })
    await expect(
      decideNextSteps(service, set.id, { action: 'run', suggestionIds: ['s1'] })
    ).rejects.toThrow(/accepted/)
    expect(queued()).toEqual(['Run the tests.'])
    expect(nextStepPromptQueueEntryId(set.id, 's1')).toBe(`next-step:${set.id}:s1`)
  })

  it('dismiss and save change only the status, and both are logged', async () => {
    const { service, queued } = harness()
    const dismissed = pendingSet(service, 't1')
    expect((await decideNextSteps(service, dismissed.id, { action: 'dismiss' })).set.status).toBe(
      'dismissed'
    )
    // Only the current turn can be answered, so the second set belongs to a later turn.
    const saved = pendingSet(service, 't2')
    expect(
      (await decideNextSteps(service, saved.id, { action: 'save', suggestionIds: ['s2'] })).set
        .status
    ).toBe('accepted')
    expect(queued()).toEqual([])
    expect(log().map((entry) => entry.decision.action)).toEqual(['dismiss', 'save'])
  })
})

describe('parsed sets', () => {
  const offered = [
    { id: 'p1', title: 'Deploy it', prompt: 'Deploy to production.', risk: 'safe', kind: 'ship' },
    { title: '', prompt: '' }
  ]

  it('registers a parsed set with the risk floor applied, once per turn', () => {
    const { service } = harness()
    const set = registerParsedNextSteps(service, conversation, 't1', readOfferedNextSteps(offered))
    expect(set).toMatchObject({ origin: 'parsed', status: 'pending', turnKey: 't1' })
    expect(set.suggestions).toEqual([
      expect.objectContaining({ id: 'p1', risk: 'risky', kind: 'ship' })
    ])
    expect(
      registerParsedNextSteps(service, conversation, 't1', readOfferedNextSteps(offered)).id
    ).toBe(set.id)
    expect(() => readOfferedNextSteps([{ title: 'x' }])).toThrow(
      'None of the offered suggestions could be read.'
    )
    expect(() => readOfferedNextSteps('not a list')).toThrow(
      'None of the offered suggestions could be read.'
    )
  })

  it('an AI set for the same turn never supersedes the parsed one', async () => {
    const { service } = harness()
    const parsed = registerParsedNextSteps(
      service,
      conversation,
      't1',
      readOfferedNextSteps(offered)
    )
    const generate = vi.fn(async (_turn: unknown, _signal: unknown, _context?: unknown) => ({
      ok: true as const,
      suggestions: [
        {
          id: 's1',
          title: 'Run tests',
          prompt: 'Run tests.',
          risk: 'safe' as const,
          kind: 'verify' as const
        }
      ]
    }))
    service.deps.generate = generate
    const turn = { conversation, turnKey: 't1', lastAssistantMessage: 'Done.' }
    // The turn's own steps are its answer: no automatic AI call.
    expect(service.onFinishedTurn(turn, { immediate: true }).set?.id).toBe(parsed.id)
    expect(generate).not.toHaveBeenCalled()
    // Asked for explicitly, the AI's steps come beside them and are told what was proposed.
    const generated = service.onFinishedTurn(turn, { immediate: true, explicit: true })
    await vi.waitFor(() => expect(store.get(generated.set!.id)!.status).toBe('pending'))
    expect(generate).toHaveBeenCalledWith(turn, expect.anything(), {
      proposedSteps: ['Deploy it']
    })
    expect(store.get(parsed.id)!.status).toBe('pending')
    const late = registerParsedNextSteps(service, conversation, 't1', readOfferedNextSteps(offered))
    expect(late.id).toBe(parsed.id)
  })
})

describe('options chosen from one offered menu', () => {
  const option = (id: string, title: string) => ({
    id,
    title,
    prompt: `Please go ahead with this option you offered: ${title}`,
    risk: 'safe' as const,
    kind: 'other' as const,
    offered: true as const,
    optionGroup: 'list-3'
  })

  function menuSet(service: NextStepSuggestionService): NextStepSuggestionSet {
    service.onTurnSignal({ kind: 'skip', conversation, turnKey: 't1', reason: 'turn under test' })
    return store.upsert(
      service.newSet({ conversation, turnKey: 't1' }, 'parsed', 'pending', [
        option('o1', 'Claims sheet'),
        option('o2', 'Landing-page register'),
        option('o3', 'Ad-launch guide')
      ])
    )
  }

  it('go as one message, in the menu order, and log every chosen id', async () => {
    const { service, queued } = harness()
    const set = menuSet(service)
    const result = await decideNextSteps(service, set.id, {
      action: 'run',
      suggestionIds: ['o3', 'o1']
    })
    expect(result.queued).toEqual(['o1', 'o3'])
    expect(queued()).toEqual([
      'Please go ahead with these options you offered, together:\n1. Claims sheet\n2. Ad-launch guide'
    ])
    expect(log()).toMatchObject([{ decision: { action: 'run', suggestionIds: ['o1', 'o3'] } }])
  })

  it('a single option goes as its own prompt', async () => {
    const { service, queued } = harness()
    const set = menuSet(service)
    await decideNextSteps(service, set.id, { action: 'run', suggestionIds: ['o2'] })
    expect(queued()).toEqual([
      'Please go ahead with this option you offered: Landing-page register'
    ])
  })

  it("keeps the reply's own marks on client-offered steps", () => {
    const [step] = readOfferedNextSteps([{ ...option('o1', 'Claims sheet'), preselected: true }])
    expect(step).toMatchObject({ offered: true, preselected: true, optionGroup: 'list-3' })
  })
})
