import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import { observeStructuredAgentSessionOutcome } from '../../shared/structured-agent-session-outcome-observation'
import { structuredAgentSessionPayloadFingerprint } from '../../shared/structured-agent-session-mutation'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-store-test-open'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CodexStructuredLiveInput } from './codex-structured-live-input'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

const THREAD_ID = 'root-thread'
const TURN_ID = 'turn-1'
const identity: AgentSessionJournalIdentity = {
  sessionId: 'codex-outcome-session',
  workspaceId: 'folder-workspace',
  hostId: 'local',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: THREAD_ID }
}
const journals = createTrackedJournalOpener()
const errors = vi.fn()
let root: string
let journal: AgentSessionJournal
let deferred: ReturnType<typeof createDeferredStructuredAgentSessionEventSink>
let liveInput: CodexStructuredLiveInput
let translator: ReturnType<typeof createCodexJournalTranslator>

function providerIdentity(turnId = TURN_ID) {
  return { provider: 'codex' as const, threadId: THREAD_ID, turnId, ordinal: 0 }
}

async function admitTurn(clientMessageId: string, turnId = TURN_ID): Promise<void> {
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: `Finish ${clientMessageId}` }]
  }
  await journal.appendSubmission({
    clientMessageId,
    payloadFingerprint: structuredAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: identity.sessionId,
      fields: { body }
    }),
    body,
    fence: 1
  })
  await journal.resolveDispatch({
    clientMessageId,
    state: 'accepted',
    providerIdentity: providerIdentity(turnId),
    fence: 1
  })
}

async function admitSteer(clientMessageId: string, beforeAck?: () => Promise<void>): Promise<void> {
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: clientMessageId }]
  }
  await journal.appendSubmission({
    clientMessageId,
    body,
    payloadFingerprint: clientMessageId,
    fence: 1
  })
  const outcome = await liveInput.steer(
    {
      threadId: THREAD_ID,
      options: new Map(),
      turnIdWaiters: [],
      connection: {
        request: async () => {
          notify('item/completed', {
            turnId: TURN_ID,
            item: {
              type: 'userMessage',
              id: clientMessageId,
              clientId: `omni-steer:${clientMessageId}`,
              content: [{ type: 'text', text: clientMessageId }]
            }
          })
          await deferred.drained()
          await beforeAck?.()
          return { turnId: TURN_ID }
        }
      }
    },
    { clientMessageId, body }
  )
  if (outcome.state !== 'accepted') {
    throw new Error('steer was not accepted')
  }
  await journal.resolveDispatch({ clientMessageId, ...outcome, fence: 1 })
}

function notify(method: string, params: unknown, threadId = THREAD_ID): void {
  expect(
    translator.handle({
      type: 'notification',
      sessionId: identity.sessionId,
      threadId,
      method,
      params
    })
  ).toEqual({ accepted: true })
}

function settlements() {
  return journal
    .snapshot()
    .items.flatMap(({ body }) =>
      body.kind === 'status' && body.turnLifecycle?.settlement
        ? [body.turnLifecycle.settlement]
        : []
    )
}

async function reopen(): Promise<void> {
  await deferred.drained()
  expect(errors).not.toHaveBeenCalled()
  translator.dispose()
  deferred.close()
  await journal.close()
  journal = await journals.open({ identity, journalDir: root })
}

beforeEach(async () => {
  errors.mockReset()
  root = await mkdtemp(join(tmpdir(), 'omni-codex-outcome-'))
  journal = await journals.open({ identity, journalDir: root })
  deferred = createDeferredStructuredAgentSessionEventSink({ onError: errors })
  deferred.bind({ journal, fence: 1, publish: () => undefined })
  liveInput = new CodexStructuredLiveInput()
  liveInput.observe('turn/started', { turn: { id: TURN_ID } })
  translator = createCodexJournalTranslator({
    sink: deferred.sink,
    primaryThreadId: () => THREAD_ID,
    steeringMessageForTurn: (turnId) => liveInput.steeringMessageForTurn(turnId)
  })
  await admitTurn('message-1')
  notify('turn/started', { turn: { id: TURN_ID, status: 'inProgress' } })
  await deferred.drained()
})

afterEach(async () => {
  translator.dispose()
  deferred.close()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('Codex durable source completion evidence', () => {
  it('deduplicates early echoes and settles multiple steers even when completion precedes acknowledgment', async () => {
    await admitSteer('correction-1')
    await admitSteer('correction-2', async () => {
      notify('turn/completed', { turn: { id: TURN_ID, status: 'completed' } })
      await deferred.drained()
      expect(observeStructuredAgentSessionOutcome(journal.snapshot()).ready).toBe(false)
    })
    expect(observeStructuredAgentSessionOutcome(journal.snapshot()).ready).toBe(true)
    await reopen()
    expect(observeStructuredAgentSessionOutcome(journal.snapshot()).ready).toBe(true)
    const userMessages = journal
      .snapshot()
      .items.filter(({ body }) => body.kind === 'message' && body.role === 'user')
    expect(userMessages).toHaveLength(3)
    expect(settlements()).toHaveLength(2)
  })

  it.each(['failed', 'interrupted', 'inProgress'])(
    'never releases Next Steps after steering a %s turn',
    async (status) => {
      await admitSteer('correction')
      notify('turn/completed', { turn: { id: TURN_ID, status } })
      await reopen()
      expect(observeStructuredAgentSessionOutcome(journal.snapshot()).ready).toBe(false)
    }
  )

  it('does not release Next Steps when Stop races with provider success', async () => {
    await admitSteer('correction')
    translator.handle({
      type: 'notification',
      sessionId: identity.sessionId,
      threadId: THREAD_ID,
      method: 'turn/completed',
      params: { turn: { id: TURN_ID, status: 'completed' } },
      interrupted: true
    })
    await reopen()
    expect(settlements().map((settlement) => settlement.outcome)).toEqual([
      'cancelled',
      'cancelled'
    ])
    expect(observeStructuredAgentSessionOutcome(journal.snapshot()).ready).toBe(false)
  })

  it('keeps a declined request attached to the whole steered turn', async () => {
    translator.handle({
      type: 'server-request',
      sessionId: identity.sessionId,
      threadId: THREAD_ID,
      method: 'item/tool/requestUserInput',
      params: { turnId: TURN_ID }
    })
    await deferred.drained()
    await admitSteer('correction')
    notify('turn/completed', { turn: { id: TURN_ID, status: 'completed' } })
    await reopen()
    expect(observeStructuredAgentSessionOutcome(journal.snapshot())).toMatchObject({
      ready: false,
      reason: 'The source turn ended with an unanswered input request.'
    })
  })

  it('keeps a cancelled prompt from before steering attached to the owning turn', async () => {
    deferred.sink.appendItem(
      { provider: 'omni', clientMessageId: 'prompt' },
      {
        kind: 'question',
        question: 'Destination?',
        options: [],
        resolution: {
          state: 'cancelled',
          selectedOptionId: null,
          resolvedBy: null,
          resolvedAt: 200
        }
      }
    )
    await deferred.drained()
    await admitSteer('correction')
    notify('turn/completed', { turn: { id: TURN_ID, status: 'completed' } })
    await reopen()
    expect(observeStructuredAgentSessionOutcome(journal.snapshot())).toMatchObject({
      ready: false,
      reason: 'The source turn ended with cancelled input.'
    })
  })

  it('restores a verified successful root turn and its exact admission receipt after reopening', async () => {
    expect(observeStructuredAgentSessionOutcome(journal.snapshot()).ready).toBe(false)

    notify('turn/completed', { turn: { id: TURN_ID, status: 'completed', error: null } })
    await deferred.drained()

    const receipt = agentJournalItemKey(providerIdentity())
    expect(journal.snapshot().submissions.at(-1)).toMatchObject({
      clientMessageId: 'message-1',
      dispatchState: 'accepted',
      providerItemId: receipt
    })
    expect(settlements()).toEqual([{ providerItemId: receipt, outcome: 'succeeded' }])
    const observation = observeStructuredAgentSessionOutcome(journal.snapshot())
    expect(observation).toMatchObject({ ready: true, version: expect.any(String) })

    await reopen()

    expect(settlements()).toEqual([{ providerItemId: receipt, outcome: 'succeeded' }])
    expect(observeStructuredAgentSessionOutcome(journal.snapshot())).toEqual(observation)
  })

  it.each([
    { label: 'failed', turn: { status: 'failed' }, outcome: 'failed' },
    { label: 'interrupted', turn: { status: 'interrupted' }, outcome: 'cancelled' },
    {
      label: 'completed with a provider error',
      turn: { status: 'completed', error: { message: 'Provider failed' } },
      outcome: 'failed'
    },
    { label: 'missing status', turn: {}, outcome: undefined },
    { label: 'malformed status', turn: { status: true }, outcome: undefined },
    { label: 'nonterminal status', turn: { status: 'inProgress' }, outcome: undefined }
  ])('never reports ready for $label after reopening', async ({ turn, outcome }) => {
    notify('turn/completed', { turn: { id: TURN_ID, ...turn } })

    await reopen()

    expect(observeStructuredAgentSessionOutcome(journal.snapshot()).ready).toBe(false)
    expect(settlements()).toEqual(
      outcome ? [{ providerItemId: agentJournalItemKey(providerIdentity()), outcome }] : []
    )
  })

  it('treats an error on the completion envelope as failed even with completed turn status', async () => {
    notify('turn/completed', {
      turn: { id: TURN_ID, status: 'completed' },
      error: { message: 'Connection could not commit the result' }
    })

    await reopen()

    expect(settlements()).toEqual([
      { providerItemId: agentJournalItemKey(providerIdentity()), outcome: 'failed' }
    ])
    expect(observeStructuredAgentSessionOutcome(journal.snapshot()).ready).toBe(false)
  })

  it('never promotes provider exit into root success', async () => {
    expect(
      translator.handle({
        type: 'ended',
        sessionId: identity.sessionId,
        reason: 'Provider connection lost',
        cause: 'unexpected-exit',
        fence: 1,
        acquisitionGeneration: 'generation-1'
      })
    ).toEqual({ accepted: true })

    await reopen()

    expect(settlements()).toEqual([])
    expect(observeStructuredAgentSessionOutcome(journal.snapshot())).toMatchObject({
      ready: false,
      unverifiable: true
    })
  })

  it('does not let a child thread complete the root even when their turn IDs match', async () => {
    notify('turn/started', { turn: { id: TURN_ID, status: 'inProgress' } }, 'child-thread')
    notify('turn/completed', { turn: { id: TURN_ID, status: 'completed' } }, 'child-thread')

    await reopen()

    expect(settlements()).toEqual([])
    expect(observeStructuredAgentSessionOutcome(journal.snapshot()).ready).toBe(false)
  })

  it('does not use an earlier successful root turn to finish a newer accepted submission', async () => {
    notify('turn/completed', { turn: { id: TURN_ID, status: 'completed' } })
    await deferred.drained()
    expect(observeStructuredAgentSessionOutcome(journal.snapshot()).ready).toBe(true)
    await admitTurn('message-2', 'turn-2')

    await reopen()

    expect(settlements()).toEqual([
      { providerItemId: agentJournalItemKey(providerIdentity()), outcome: 'succeeded' }
    ])
    expect(journal.snapshot().submissions.at(-1)?.providerItemId).toBe(
      agentJournalItemKey(providerIdentity('turn-2'))
    )
    expect(observeStructuredAgentSessionOutcome(journal.snapshot())).toMatchObject({
      ready: false,
      unverifiable: true
    })
  })
})
