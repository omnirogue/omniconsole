import { describe, expect, it, vi } from 'vitest'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import {
  holdsConversation,
  messageDeliveryAdapter,
  messageReferenceOf,
  type MessageHoldDeps
} from './message-delivery-adapter'
import type { WorkDeliveryApi, WorkDeliveryReceipt } from './work-delivery-api'
import {
  WorkDeliveryClaimer,
  WorkDeliveryHold,
  type WorkDeliveryDeps,
  type WorkHolder,
  type WorkPane
} from './work-delivery-claimer'
import type { ClaimableDelivery, WorkDeliveryKindAdapter } from './work-delivery-kind'

vi.mock('../answer-delivery/answer-delivery-target', () => ({
  organizationFields: vi.fn(async () => ({}))
}))
vi.mock('../session-manage/session-manage-runtime-actions', () => ({ readSidebarRows: vi.fn() }))
vi.mock('../session-manage/session-transcript-locate', () => ({ locateTranscripts: vi.fn() }))

const CONVERSATION = '5b7cfeb8-f58f-4b87-a739-1bfee2bbf8ea'
const TEXT =
  '[OmniOS message] From Sal, sent from Claude (iPhone) (their own words):\n\n  Keep going, skip the migration.  '

const DELIVERY: ClaimableDelivery = {
  key: `session:claude.${CONVERSATION}:m-0123456789abcdef0123456789abcdef`,
  workItem: `session:claude.${CONVERSATION}`,
  kind: 'message',
  text: TEXT,
  context: {
    provider: 'claude',
    conversationId: CONVERSATION,
    ref: `claude:${CONVERSATION}@local`
  },
  state: 'pending',
  step: '',
  heldReason: null,
  attempts: 0,
  createdAt: '2026-10-12T18:00:00Z',
  eventAt: '2026-10-12T18:00:00Z',
  respawnedRef: null,
  owner: null
}

const RUNTIME = {} as OrcaRuntimeService

function row(providerSessionId: string): SessionManageSidebarRow {
  return { hostId: 'local', agent: 'claude', providerSessionId, transcriptPath: null } as never
}

function hold(rows: SessionManageSidebarRow[], transcripts = 0): MessageHoldDeps {
  return { rows: async () => rows, transcripts: async () => transcripts }
}

describe('messageReferenceOf', () => {
  it('names the conversation on this computer from the context', () => {
    expect(messageReferenceOf(DELIVERY)).toEqual({
      agent: 'claude',
      sessionId: CONVERSATION,
      hostId: 'local'
    })
  })

  it.each([
    [{ provider: 'grok', conversationId: CONVERSATION }],
    [{ provider: 'claude', conversationId: '' }],
    [{ provider: 'claude', conversationId: '../x' }],
    [{ provider: 'claude' }],
    [{}]
  ])('names nothing for a context without a valid conversation (%j)', (context) => {
    expect(messageReferenceOf({ ...DELIVERY, context })).toBeNull()
  })
})

describe('holdsConversation', () => {
  const reference = { agent: 'claude' as const, sessionId: CONVERSATION, hostId: 'local' }

  it('holds it when a sidebar row lists it or its transcript is here', async () => {
    expect(await holdsConversation(hold([row(CONVERSATION)]), reference)).toBe(true)
    expect(await holdsConversation(hold([row('other')], 1), reference)).toBe(true)
    expect(await holdsConversation(hold([row('other')], 0), reference)).toBe(false)
  })

  it('still checks transcripts when the window cannot list rows', async () => {
    const deps: MessageHoldDeps = {
      rows: async () => {
        throw new Error('no window')
      },
      transcripts: async () => 1
    }
    expect(await holdsConversation(deps, reference)).toBe(true)
    expect(
      await holdsConversation(
        {
          rows: deps.rows,
          transcripts: async () => {
            throw new Error('io')
          }
        },
        reference
      )
    ).toBe(false)
  })
})

describe('messageDeliveryAdapter', () => {
  it('resolves only a conversation this computer holds, and types the stored text exactly', async () => {
    const here = messageDeliveryAdapter('/tmp/user', () => hold([row(CONVERSATION)]))
    const target = await here.resolve(DELIVERY, RUNTIME)
    expect(target).toEqual({ ref: `claude:${CONVERSATION}@local`, transcript: 'present' })
    expect(here.text(DELIVERY, target!)).toBe(TEXT)
    const elsewhere = messageDeliveryAdapter('/tmp/user', () => hold([], 0))
    expect(await elsewhere.resolve(DELIVERY, RUNTIME)).toBeNull()
  })

  it('claims only when held, never respawns, and never brings back a deleted conversation', () => {
    const adapter = messageDeliveryAdapter('/tmp/user', () => hold([]))
    expect(adapter.kind).toBe('message')
    expect(adapter.claimOnlyWhenHeld).toBe(true)
    expect(adapter.noRespawn).toBe(true)
    expect(adapter.respawnBrief).toBeUndefined()
    expect(adapter.restoreDeleted).toBeUndefined()
    expect(adapter.deliverLive).toBeUndefined()
  })

  it("uses a previous binding's pane, account, model and folder only for the same conversation", async () => {
    const adapter = messageDeliveryAdapter('/tmp/user', () => hold([row(CONVERSATION)]))
    const owner = {
      hostId: 'mbp',
      hostLabel: 'MacBook',
      provider: 'claude',
      accountId: 'acct-1',
      conversationId: CONVERSATION,
      model: 'opus',
      effort: 'high',
      folder: '/Work',
      paneKey: 'tab-1:leaf-1',
      title: 'x'
    }
    expect(await adapter.resolve({ ...DELIVERY, owner }, RUNTIME)).toEqual({
      ref: `claude:${CONVERSATION}@local`,
      paneKey: 'tab-1:leaf-1',
      accountId: 'acct-1',
      model: 'opus',
      effort: 'high',
      folder: '/Work',
      transcript: 'present'
    })
    expect(
      await adapter.resolve({ ...DELIVERY, owner: { ...owner, conversationId: 'other' } }, RUNTIME)
    ).toEqual({ ref: `claude:${CONVERSATION}@local`, transcript: 'present' })
  })
})

const PANE: WorkPane = {
  paneKey: 'tab-1:leaf-1',
  worktreeId: 'w',
  tabId: 'tab-1',
  archived: false,
  title: 'Sal’s session'
}

function claimerHarness(options: {
  held: boolean
  holder?: WorkHolder
  resume?: () => Promise<WorkPane>
  deleted?: boolean
}) {
  const receipts: WorkDeliveryReceipt[] = []
  const enqueued: string[] = []
  let offered = 0
  const api: WorkDeliveryApi = {
    claimable: vi.fn(async () => ({
      status: 'ok' as const,
      value: offered++ === 0 ? [DELIVERY] : []
    })),
    claim: vi.fn(async () => ({ status: 'ok' as const, value: DELIVERY })),
    receipt: vi.fn(async (_key: string, _host: string, receipt: WorkDeliveryReceipt) => {
      receipts.push(receipt)
      return { status: 'ok' as const, value: {} }
    }),
    bindOwner: vi.fn(),
    sessionState: vi.fn()
  }
  const adapter: WorkDeliveryKindAdapter = messageDeliveryAdapter('/tmp/user', () =>
    hold(options.held ? [row(CONVERSATION)] : [])
  )
  const deps: WorkDeliveryDeps = {
    api,
    adapters: new Map([['message', adapter]]),
    hostId: () => 'host_mac',
    hostLabel: 'MacBook',
    resolveTarget: async (a, d) => {
      const target = await a.resolve(d, RUNTIME)
      return target && options.deleted ? { ...target, deleted: true } : target
    },
    findHolder: vi.fn(async () => options.holder ?? { kind: 'live' as const, pane: PANE }),
    windowAttached: () => true,
    unarchive: vi.fn(async () => {}),
    resume: vi.fn(options.resume ?? (async () => PANE)),
    respawn: vi.fn(),
    enqueue: vi.fn(async (_pane: WorkPane, _target, _id: string, text: string) => {
      enqueued.push(text)
      return true
    }),
    queueState: () => 'queued',
    busy: vi.fn(async () => true),
    audit: () => {},
    now: () => Date.parse('2026-10-12T18:00:30Z')
  }
  return { claimer: new WorkDeliveryClaimer(deps), deps, receipts, enqueued }
}

describe('WorkDeliveryClaimer with message deliveries', () => {
  it('never claims a message for a conversation this computer does not hold', async () => {
    const { claimer, deps, receipts } = claimerHarness({ held: false })
    await claimer.pass()
    expect(deps.api.claim).not.toHaveBeenCalled()
    expect(receipts).toEqual([])
    expect(claimer.caps()).toEqual(['message'])
  })

  it('claims a held conversation and queues the exact text into its live pane, busy or not', async () => {
    const { claimer, deps, receipts, enqueued } = claimerHarness({ held: true })
    await claimer.pass()
    expect(deps.api.claim).toHaveBeenCalledTimes(1)
    expect(enqueued).toEqual([TEXT])
    expect(receipts).toEqual([{ state: 'claimed', step: 'queued' }])
  })

  it('holds transcript_gone instead of starting a fresh session', async () => {
    const { claimer, deps, receipts } = claimerHarness({
      held: true,
      holder: { kind: 'none' },
      resume: async () => {
        throw new WorkDeliveryHold('transcript_gone', 'No transcript was found')
      }
    })
    await claimer.pass()
    expect(deps.respawn).not.toHaveBeenCalled()
    expect(receipts).toEqual([
      {
        state: 'held',
        heldReason: 'transcript_gone',
        detail: { message: 'No transcript was found' }
      }
    ])
  })

  it('holds protection for a deleted or hidden conversation', async () => {
    const { claimer, receipts, enqueued } = claimerHarness({ held: true, deleted: true })
    await claimer.pass()
    expect(enqueued).toEqual([])
    expect(receipts[0]).toMatchObject({ state: 'held', heldReason: 'protection' })
  })

  it('resumes an exited conversation in place and then queues it', async () => {
    const { claimer, deps, receipts, enqueued } = claimerHarness({
      held: true,
      holder: { kind: 'none' }
    })
    await claimer.pass()
    expect(deps.resume).toHaveBeenCalledTimes(1)
    expect(enqueued).toEqual([TEXT])
    expect(receipts).toEqual([
      { state: 'claimed', step: 'resumed' },
      { state: 'claimed', step: 'queued' }
    ])
  })
})
