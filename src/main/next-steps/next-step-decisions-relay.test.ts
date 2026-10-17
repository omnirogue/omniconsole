import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

import { conversationSourceRowKey } from '../../shared/conversation-source'
import type { PersistedState } from '../../shared/persisted-state-types'
import { normalizePromptQueueEntry } from '../../shared/prompt-queue-types'
import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { enqueueConversationPrompt } from '../runtime/prompt-queue-enqueue'
import { decideNextSteps } from './next-step-decisions'
import { nextStepContent } from './next-step-relay-pin'
import { NextStepSuggestionService } from './next-step-suggestion-service'
import { NEXT_STEP_DECISIONS_FILE, NextStepSuggestionStore } from './next-step-suggestion-store'
import { registerParsedNextSteps } from './next-step-turn-answers'

const conversation = { worktreeId: 'repo::/w', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
const requestedBy = { action: 'continue' as const, actor: 'tab-9:leaf-9' }
let dir: string
let store: NextStepSuggestionStore

function harness(title = 'Add the migration') {
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
  service.onTurnSignal({ kind: 'skip', conversation, turnKey: 't1', reason: 'turn under test' })
  const set = registerParsedNextSteps(service, conversation, 't1', [
    {
      id: 's1',
      title,
      prompt: `Please go ahead with this next step you suggested: ${title}`,
      risk: 'safe',
      kind: 'fix',
      offered: true
    }
  ])
  const entries = () =>
    queues.readPromptQueue(conversationSourceRowKey(conversation))?.entries ?? []
  return { service, set, entries }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'next-steps-relay-'))
})

afterEach(async () => {
  await store.flush()
  rmSync(dir, { recursive: true, force: true })
})

describe('decideNextSteps relayed by another session', () => {
  it('queues the session’s own step behind the marker, requested by the relaying session', async () => {
    const { service, set, entries } = harness()
    const result = await decideNextSteps(
      service,
      set.id,
      { action: 'run', suggestionIds: ['s1'] },
      1_000,
      undefined,
      { prefix: '[from Manager] ', requestedBy, via: requestedBy.actor }
    )
    expect(result.queued).toEqual(['s1'])
    expect(result.set.status).toBe('accepted')
    expect(entries()).toMatchObject([
      {
        text: '[from Manager] Please go ahead with this next step you suggested: Add the migration',
        requestedBy
      }
    ])
    const logged = readFileSync(join(dir, NEXT_STEP_DECISIONS_FILE), 'utf8').trim().split('\n')
    expect(JSON.parse(logged[0]!)).toMatchObject({
      setId: set.id,
      decision: { action: 'run', suggestionIds: ['s1'] },
      via: 'tab-9:leaf-9'
    })
  })

  it('answers the turn once: a second relay of the same set is refused', async () => {
    const { service, set } = harness()
    const relayed = { prefix: '[from Manager] ', requestedBy, via: requestedBy.actor }
    await decideNextSteps(
      service,
      set.id,
      { action: 'run', suggestionIds: ['s1'] },
      1,
      undefined,
      relayed
    )
    await expect(
      decideNextSteps(
        service,
        set.id,
        { action: 'run', suggestionIds: ['s1'] },
        2,
        undefined,
        relayed
      )
    ).rejects.toThrow('can no longer be answered')
  })
})

describe('a relayed step is pinned to the words that were checked (review 3, R4-4)', () => {
  const relay = (content: string) => ({
    prefix: '[from Manager] ',
    requestedBy,
    via: requestedBy.actor,
    pinned: { suggestionId: 's1', content }
  })
  const run = { action: 'run' as const, suggestionIds: ['s1'] }

  it('refuses a same-id refresh from "Review the parser" to "Deploy to production" during its await', async () => {
    const { service, set, entries } = harness('Review the parser')
    const deciding = decideNextSteps(
      service,
      set.id,
      run,
      1,
      undefined,
      relay(nextStepContent(set.suggestions[0]!))
    )
    // Decide is awaiting the turn read; the set is refreshed under the same ids.
    store.update(set.id, (current) => ({
      ...current,
      suggestions: current.suggestions.map((step) => ({
        ...step,
        title: 'Deploy to production',
        prompt: 'Please go ahead with this next step you suggested: Deploy to production'
      }))
    }))
    await expect(deciding).rejects.toThrow('changed after it was checked')
    expect(entries()).toEqual([])
    expect(store.get(set.id)?.status).toBe('pending')
  })

  it('queues the exact pinned words', async () => {
    const safe = harness('Review the parser')
    const queued = await decideNextSteps(
      safe.service,
      safe.set.id,
      run,
      1,
      undefined,
      relay(nextStepContent(safe.set.suggestions[0]!))
    )
    expect(queued.queued).toEqual(['s1'])
  })

  it('refuses pinned words a hard stop covers, checked again just before the enqueue', async () => {
    const risky = harness('Deploy to production')
    await expect(
      decideNextSteps(
        risky.service,
        risky.set.id,
        run,
        1,
        undefined,
        relay(nextStepContent(risky.set.suggestions[0]!))
      )
    ).rejects.toThrow('hard stop: deploy')
    expect(risky.entries()).toEqual([])
  })
})

describe('prompt queue relay provenance', () => {
  it('reads back requestedBy, never as an origin, and a pre-release session origin as one', () => {
    const entry = { id: 'e', text: 'hello', createdAt: 1, state: 'queued' }
    const read = normalizePromptQueueEntry({ ...entry, requestedBy })
    expect(read?.requestedBy).toEqual(requestedBy)
    expect(read?.origin).toBeUndefined()
    expect(
      normalizePromptQueueEntry({ ...entry, origin: { kind: 'session', ...requestedBy } })
        ?.requestedBy
    ).toEqual(requestedBy)
    expect(
      normalizePromptQueueEntry({ ...entry, origin: { kind: 'session', action: 'ask' } })
    ).toBeNull()
  })
})
