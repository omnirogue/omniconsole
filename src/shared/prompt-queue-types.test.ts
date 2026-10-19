import { describe, expect, it } from 'vitest'
import {
  conversationSourceRowKey,
  normalizeConversationSource,
  structuredConversationSource
} from './conversation-source'
import {
  capPromptQueueEntries,
  nextPromptQueueEntry,
  normalizePromptQueue,
  normalizePromptQueueEntry,
  normalizePromptQueues,
  isUnattendedPromptQueueEntry,
  promptQueuePausedBy,
  promptQueuePending,
  promptQueueWaitReason,
  PROMPT_QUEUE_MAX_SETTLED_ENTRIES,
  type PromptQueue,
  type PromptQueueEntry
} from './prompt-queue-types'

const source = { worktreeId: 'wt-1', paneKey: 'tab:leaf', kind: 'pty' as const }

const entry = (over: Partial<PromptQueueEntry> = {}): PromptQueueEntry => ({
  id: 'e1',
  text: 'Have you done your best job?',
  createdAt: 10,
  state: 'queued',
  ...over
})

describe('a conversation source', () => {
  it('names the same row the session chain source authority names', () => {
    expect(conversationSourceRowKey(source)).toBe(JSON.stringify(['local', 'wt-1', 'tab:leaf']))
  })

  it('refuses a chat conversation with no session to send to', () => {
    expect(normalizeConversationSource({ ...source, kind: 'structured' })).toBeNull()
    expect(
      normalizeConversationSource({ ...source, kind: 'structured', sessionId: 'chat-1' })
    ).toEqual({ ...source, kind: 'structured', sessionId: 'chat-1' })
  })

  it('round-trips a structured source through its own pane key', () => {
    const structured = structuredConversationSource('wt-1', 'chat-1')
    expect(normalizeConversationSource(JSON.parse(JSON.stringify(structured)))).toEqual(structured)
  })

  it('drops fields it does not know and refuses what it cannot address', () => {
    expect(normalizeConversationSource({ ...source, somethingNew: 1 })).toEqual(source)
    expect(normalizeConversationSource({ ...source, kind: 'carrier-pigeon' })).toBeNull()
    expect(normalizeConversationSource({ paneKey: 'p', kind: 'pty' })).toBeNull()
    expect(normalizeConversationSource(null)).toBeNull()
  })
})

describe('a persisted prompt queue', () => {
  it('round-trips every field a delivery receipt carries', () => {
    const queue: PromptQueue = {
      source,
      entries: [
        entry(),
        entry({
          id: 'e2',
          state: 'delivered',
          deliveredAt: 44,
          door: 'pty',
          operationId: 'prompt-queue:abc',
          deliveryEpoch: 'epoch-1'
        }),
        entry({
          id: 'e3',
          state: 'failed',
          reason: 'This terminal conversation is no longer open.'
        })
      ]
    }
    expect(normalizePromptQueue(JSON.parse(JSON.stringify(queue)))).toEqual(queue)
  })

  it('keeps the queue when ONE entry is malformed, and says so by dropping only it', () => {
    const queue = normalizePromptQueue({
      source,
      entries: [
        entry(),
        { id: 'broken', text: '   ', createdAt: 1, state: 'queued' },
        { id: 'also-broken', text: 'fine', createdAt: 1, state: 'teleported' },
        entry({ id: 'e4', text: 'Continue' })
      ]
    })
    expect(queue?.entries.map((row) => row.id)).toEqual(['e1', 'e4'])
  })

  it('refuses a whole queue only when it names no conversation', () => {
    expect(normalizePromptQueue({ entries: [entry()] })).toBeNull()
    expect(normalizePromptQueues({ 'row-a': { entries: [entry()] } })).toEqual({})
  })

  it('drops an unknown field on an entry rather than the entry', () => {
    const queue = normalizePromptQueue({
      source,
      entries: [{ ...entry(), inventedByANewerBuild: { deep: true } }]
    })
    expect(queue?.entries).toEqual([entry()])
  })

  it('keeps empty queues out of the persisted map', () => {
    expect(normalizePromptQueues({ 'row-a': { source, entries: [] } })).toEqual({})
  })
})

describe('what the drain is allowed to take next', () => {
  it('takes the first waiting entry, in the order they were queued', () => {
    const queue: PromptQueue = { source, entries: [entry(), entry({ id: 'e2' })] }
    expect(nextPromptQueueEntry(queue)?.id).toBe('e1')
    expect(promptQueuePending(queue).map((row) => row.id)).toEqual(['e1', 'e2'])
  })

  it('takes nothing while a delivery whose result is unknown holds the line', () => {
    const queue: PromptQueue = {
      source,
      entries: [entry({ state: 'sending' }), entry({ id: 'e2' })]
    }
    expect(nextPromptQueueEntry(queue)).toBeNull()
  })

  it('takes nothing while a later entry sent now is still in flight', () => {
    const queue: PromptQueue = {
      source,
      entries: [entry(), entry({ id: 'e2', state: 'sending' })]
    }
    expect(nextPromptQueueEntry(queue)).toBeNull()
  })

  it('looks past entries that already settled', () => {
    const queue: PromptQueue = {
      source,
      entries: [entry({ state: 'delivered', deliveredAt: 1 }), entry({ id: 'e2' })]
    }
    expect(nextPromptQueueEntry(queue)?.id).toBe('e2')
  })
})

describe('what a queue keeps', () => {
  it('never drops a waiting entry to make room for history', () => {
    const settled = Array.from({ length: PROMPT_QUEUE_MAX_SETTLED_ENTRIES + 5 }, (_, index) =>
      entry({ id: `d${index}`, state: 'delivered', deliveredAt: index })
    )
    const kept = capPromptQueueEntries([...settled, entry({ id: 'waiting' })])
    expect(kept.filter((row) => row.state === 'queued')).toHaveLength(1)
    expect(kept.filter((row) => row.state === 'delivered')).toHaveLength(
      PROMPT_QUEUE_MAX_SETTLED_ENTRIES
    )
    expect(kept.at(-1)?.id).toBe('waiting')
  })
})

describe('an automatic entry’s provenance', () => {
  const base = { id: 'e1', text: 'Go on', createdAt: 1, state: 'queued' }
  it('round-trips a Keep going origin', () => {
    const origin = { kind: 'keep-going', runToken: 'run001', round: 2 }
    expect(normalizePromptQueueEntry({ ...base, origin })).toEqual({ ...base, origin })
    expect(
      normalizePromptQueueEntry(JSON.parse(JSON.stringify({ ...base, origin })))?.origin
    ).toEqual(origin)
  })

  it('drops an entry whose origin cannot be read, rather than treating it as the person’s', () => {
    for (const origin of [
      { kind: 'other' },
      { kind: 'keep-going', round: 0, runToken: 'x' },
      'x'
    ]) {
      expect(normalizePromptQueueEntry({ ...base, origin })).toBeNull()
    }
    expect(normalizePromptQueueEntry(base)).toEqual(base)
  })
})

describe('a prompt another session queued for the person (requestedBy)', () => {
  const base = {
    id: 'session-manage:1',
    text: '[from Manager] Run the tests.',
    createdAt: 1,
    state: 'queued'
  }
  const requestedBy = { action: 'continue', actor: 'tab-9:leaf-1' }

  it('round-trips as its own optional field and never as an origin', () => {
    const entry = normalizePromptQueueEntry({ ...base, requestedBy })
    expect(entry).toEqual({ ...base, requestedBy })
    expect(entry).not.toHaveProperty('origin')
  })

  it('reads a pre-release `origin.kind: session` as what it is', () => {
    const legacy = normalizePromptQueueEntry({
      ...base,
      origin: { kind: 'session', ...requestedBy }
    })
    expect(legacy).toEqual({ ...base, requestedBy })
  })

  it('stays readable by a decoder that knows only Keep going origins', () => {
    // The pre-PR rule: an origin it cannot read drops the entry. The published entry has none,
    // so such a decoder keeps it, with its visible "[from …]" marker.
    const published = JSON.parse(
      JSON.stringify(normalizePromptQueueEntry({ ...base, requestedBy }))
    )
    expect(published.origin).toBeUndefined()
    expect(published.text).toContain('[from Manager]')
  })

  it('ignores an unreadable requestedBy rather than inventing one', () => {
    expect(
      normalizePromptQueueEntry({ ...base, requestedBy: { action: 'delete', actor: 'x' } })
    ).toEqual(base)
  })
})

describe('a prompt the session host admitted (Phase 4)', () => {
  const base = { id: 'session-manage:2', text: '[from person on Laptop] Summarize.', createdAt: 1 }
  const hostOperation = {
    operationId: `1790337600001-${'a'.repeat(32)}`,
    conversationId: `conv_${'b'.repeat(32)}`
  }

  it('keeps the host operation it carries, so a restart can reconcile it from the entry', () => {
    const requestedBy = { action: 'continue', actor: 'remote', hostOperation }
    expect(normalizePromptQueueEntry({ ...base, state: 'queued', requestedBy })).toEqual({
      ...base,
      state: 'queued',
      requestedBy
    })
  })

  it('drops a malformed host operation rather than trusting it', () => {
    const requestedBy = { action: 'continue', actor: 'remote', hostOperation: { operationId: 'x' } }
    expect(normalizePromptQueueEntry({ ...base, state: 'queued', requestedBy })).toEqual({
      ...base,
      state: 'queued',
      requestedBy: { action: 'continue', actor: 'remote' }
    })
  })

  it('keeps proof that a failed entry sent nothing, and only on a failed one', () => {
    expect(
      normalizePromptQueueEntry({ ...base, state: 'failed', reason: 'changed', unsent: true })
    ).toMatchObject({ state: 'failed', unsent: true })
    expect(
      normalizePromptQueueEntry({ ...base, state: 'delivered', unsent: true })
    ).not.toHaveProperty('unsent')
  })
})

describe('a queue paused behind the person’s failed prompt', () => {
  const failed = entry({ id: 'f1', state: 'failed', reason: 'gone', holdsQueue: true })
  const keepGoing = entry({
    id: 'kg',
    origin: { kind: 'keep-going', runToken: 'run001', round: 1 }
  })
  const relay = entry({ id: 'relay', requestedBy: { action: 'ask', actor: 'steward' } })

  it('takes none of the person’s prompts until they act on the failed one', () => {
    const queue: PromptQueue = { source, entries: [failed, entry({ id: 'e2' })] }
    expect(promptQueuePausedBy(queue)?.id).toBe('f1')
    expect(nextPromptQueueEntry(queue)).toBeNull()
    expect(promptQueueWaitReason(queue)).toEqual({ kind: 'paused-after-failure', entryId: 'f1' })
  })

  it('still takes Keep going and relayed work, by provenance, past the person’s prompts', () => {
    expect(
      nextPromptQueueEntry({ source, entries: [failed, entry({ id: 'e2' }), keepGoing] })?.id
    ).toBe('kg')
    expect(
      nextPromptQueueEntry({ source, entries: [failed, entry({ id: 'e2' }), relay] })?.id
    ).toBe('relay')
  })

  it('is not paused by a failure that does not hold it', () => {
    const queue: PromptQueue = {
      source,
      entries: [entry({ id: 'old', state: 'failed' }), entry({ id: 'e2' })]
    }
    expect(promptQueueWaitReason(queue)).toBeNull()
    expect(nextPromptQueueEntry(queue)?.id).toBe('e2')
  })

  it('keeps the pause through a reload, and only on a failed entry', () => {
    const reloaded = normalizePromptQueue(JSON.parse(JSON.stringify({ source, entries: [failed] })))
    expect(reloaded?.entries[0]?.holdsQueue).toBe(true)
    expect(normalizePromptQueueEntry({ ...entry(), holdsQueue: true })?.holdsQueue).toBeUndefined()
  })

  it('never drops the entry it is paused behind to make room for history', () => {
    const history = Array.from({ length: PROMPT_QUEUE_MAX_SETTLED_ENTRIES + 3 }, (_, index) =>
      entry({ id: `d${index}`, state: 'delivered' })
    )
    const kept = capPromptQueueEntries([failed, ...history])
    expect(kept[0]?.id).toBe('f1')
    expect(kept.filter((row) => row.state === 'delivered')).toHaveLength(
      PROMPT_QUEUE_MAX_SETTLED_ENTRIES
    )
  })
})

describe('a deliverable check repair (automation)', () => {
  const base = {
    id: 'deliverable-repair:abc:1',
    text: '[from Deliverable check 1/2 · dv-7f3a9c01] Before this is finished…',
    createdAt: 1,
    state: 'queued'
  }
  const automation = { kind: 'deliverable-repair', verificationId: 'v-1', attempt: 1 }

  it('round-trips as its own optional field, never an origin, and is unattended', () => {
    const entry = normalizePromptQueueEntry({ ...base, automation })
    expect(entry).toEqual({ ...base, automation })
    expect(entry).not.toHaveProperty('origin')
    expect(isUnattendedPromptQueueEntry(entry!)).toBe(true)
  })

  it('drops an unreadable automation and keeps the entry', () => {
    for (const bad of [
      { kind: 'other', verificationId: 'v', attempt: 1 },
      { ...automation, attempt: 0 }
    ]) {
      expect(normalizePromptQueueEntry({ ...base, automation: bad })).toEqual(base)
    }
  })
})
