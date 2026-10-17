import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import { structuredAgentSessionPayloadFingerprint } from '../../shared/structured-agent-session-mutation'
import { observeStructuredAgentSessionOutcome } from '../../shared/structured-agent-session-outcome-observation'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-store-test-open'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CODEX_MCP_ELICITATION_METHOD } from './codex-server-request-disposition'
import {
  createCodexJournalTranslator,
  MAX_CODEX_GENERIC_ROWS_PER_TURN
} from './codex-structured-journal-translation'
import { CodexPromptRegistry } from './codex-structured-prompt-replies'
import { deliverCodexServerRequest } from './codex-structured-provider-events'
import type { CodexSession, CodexStructuredSessionEvent } from './codex-structured-session-state'

const THREAD_ID = 'root-thread'
const TURN_ID = 'turn-1'
const identity: AgentSessionJournalIdentity = {
  sessionId: 'codex-input-session',
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
let translator: ReturnType<typeof createCodexJournalTranslator>

function providerIdentity(turnId = TURN_ID) {
  return { provider: 'codex' as const, threadId: THREAD_ID, turnId, ordinal: 0 }
}

function bindTranslator(): void {
  deferred = createDeferredStructuredAgentSessionEventSink({ onError: errors })
  deferred.bind({ journal, fence: 1, publish: () => undefined })
  translator = createCodexJournalTranslator({
    sink: deferred.sink,
    primaryThreadId: () => THREAD_ID
  })
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

function emit(event: CodexStructuredSessionEvent): void {
  expect(translator.handle(event)).toEqual({ accepted: true })
}

function turn(method: 'turn/started' | 'turn/completed', turnId = TURN_ID): void {
  emit({
    type: 'notification',
    sessionId: identity.sessionId,
    threadId: THREAD_ID,
    method,
    params: { turn: { id: turnId, status: method === 'turn/started' ? 'inProgress' : 'completed' } }
  })
}

function declinedRequest(params: unknown = {}, threadId = THREAD_ID): void {
  emit({
    type: 'server-request',
    sessionId: identity.sessionId,
    threadId,
    method: CODEX_MCP_ELICITATION_METHOD,
    params
  })
}

function blockedInputs() {
  return journal
    .snapshot()
    .items.flatMap(({ body }) =>
      body.kind === 'status' && body.inputBlocked ? [body.inputBlocked] : []
    )
}

function expectSuccessfulProviderTurn(turnId = TURN_ID): void {
  expect(
    journal
      .snapshot()
      .items.flatMap(({ body }) =>
        body.kind === 'status' && body.turnLifecycle?.settlement
          ? [body.turnLifecycle.settlement]
          : []
      )
  ).toContainEqual({
    providerItemId: agentJournalItemKey(providerIdentity(turnId)),
    outcome: 'succeeded'
  })
}

async function reopen(): Promise<void> {
  await deferred.drained()
  expect(errors).not.toHaveBeenCalled()
  translator.dispose()
  deferred.close()
  await journal.close()
  journal = await journals.open({ identity, journalDir: root })
  bindTranslator()
}

beforeEach(async () => {
  errors.mockReset()
  root = await mkdtemp(join(tmpdir(), 'omni-codex-input-'))
  journal = await journals.open({ identity, journalDir: root })
  bindTranslator()
  await admitTurn('message-1')
})

afterEach(async () => {
  translator.dispose()
  deferred.close()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('Codex declined input and durable outcome readiness', () => {
  it('does not turn a rejected dynamic tool into an unanswered user-input request', async () => {
    turn('turn/started')
    emit({
      type: 'server-request',
      sessionId: identity.sessionId,
      threadId: THREAD_ID,
      method: 'item/tool/call',
      params: { turnId: TURN_ID }
    })
    turn('turn/completed')
    await reopen()
    expect(blockedInputs()).toEqual([])
    expect(observeStructuredAgentSessionOutcome(journal.snapshot()).ready).toBe(true)
  })

  it.each([
    { label: 'explicit request turn', params: { turnId: TURN_ID } },
    { label: 'current running turn', params: {} }
  ])('keeps $label blocked after a later successful completion and reopen', async ({ params }) => {
    turn('turn/started')
    declinedRequest(params)
    turn('turn/completed')

    await reopen()

    expectSuccessfulProviderTurn()
    expect(blockedInputs()).toEqual([
      {
        providerItemId: agentJournalItemKey(providerIdentity()),
        reason: 'provider-request-declined'
      }
    ])
    expect(observeStructuredAgentSessionOutcome(journal.snapshot()).ready).toBe(false)
  })

  it.each([false, true])(
    'blocks declined input with no known turn, source message missing=%s',
    async (missingSourceMessage) => {
      declinedRequest()
      turn('turn/completed')
      await deferred.drained()
      if (missingSourceMessage) {
        await journal.appendTombstone(
          { provider: 'omni', clientMessageId: 'message-1' },
          { fence: 1 }
        )
      }

      await reopen()

      expectSuccessfulProviderTurn()
      expect(journal.snapshot().submissions.at(-1)?.dispatchState).toBe('accepted')
      expect(blockedInputs()).toEqual([
        { providerItemId: null, reason: 'provider-request-declined' }
      ])
      expect(observeStructuredAgentSessionOutcome(journal.snapshot()).ready).toBe(false)
    }
  )

  it.each([true, false])(
    'allows a fresh successful user turn after a prior block, known turn=%s',
    async (knownTurn) => {
      if (knownTurn) {
        turn('turn/started')
      }
      declinedRequest()
      turn('turn/completed')
      await reopen()
      expect(observeStructuredAgentSessionOutcome(journal.snapshot()).ready).toBe(false)
      const previousMarkers = blockedInputs()
      expect(previousMarkers).toHaveLength(1)

      await admitTurn('message-2', 'turn-2')
      turn('turn/started', 'turn-2')
      turn('turn/completed', 'turn-2')
      await reopen()

      expect(blockedInputs()).toEqual(previousMarkers)
      expectSuccessfulProviderTurn('turn-2')
      expect(observeStructuredAgentSessionOutcome(journal.snapshot())).toMatchObject({
        ready: true
      })
    }
  )

  it('keeps a new unknown-turn decline after reopening distinct from an older decline', async () => {
    declinedRequest()
    turn('turn/completed')
    await reopen()
    const firstMarkers = journal
      .snapshot()
      .items.filter(
        ({ body }) => body.kind === 'status' && body.inputBlocked?.providerItemId === null
      )
    expect(firstMarkers).toHaveLength(1)

    await admitTurn('message-2', 'turn-2')
    const submissionSequence = journal
      .snapshot()
      .items.find((item) => item.itemId === agentJournalSubmissionKey('message-2'))?.sequence
    expect(submissionSequence).toBeTypeOf('number')
    declinedRequest()
    turn('turn/completed', 'turn-2')

    await reopen()

    const markers = journal
      .snapshot()
      .items.filter(
        ({ body }) => body.kind === 'status' && body.inputBlocked?.providerItemId === null
      )
    expect(markers).toHaveLength(2)
    expect(markers[0]?.itemId).toBe(firstMarkers[0]?.itemId)
    expect(markers[0]?.sequence).toBe(firstMarkers[0]?.sequence)
    expect(markers[0]?.sequence).toBeLessThan(submissionSequence!)
    expect(markers[1]?.itemId).not.toBe(markers[0]?.itemId)
    expect(markers[1]?.sequence).toBeGreaterThan(submissionSequence!)
    expectSuccessfulProviderTurn('turn-2')
    expect(observeStructuredAgentSessionOutcome(journal.snapshot()).ready).toBe(false)
  })

  it('does not block root completion for a request from a child thread', async () => {
    turn('turn/started')
    declinedRequest({ turnId: TURN_ID }, 'child-thread')
    turn('turn/completed')

    await reopen()

    expect(blockedInputs()).toEqual([])
    expectSuccessfulProviderTurn()
    expect(observeStructuredAgentSessionOutcome(journal.snapshot()).ready).toBe(true)
  })

  it('retains the blocking evidence after the generic provider frame limit is exhausted', async () => {
    turn('turn/started')
    for (let index = 0; index < MAX_CODEX_GENERIC_ROWS_PER_TURN + 1; index += 1) {
      emit({
        type: 'notification',
        sessionId: identity.sessionId,
        threadId: THREAD_ID,
        method: 'future/notification',
        params: { value: index }
      })
    }
    declinedRequest()
    turn('turn/completed')

    await reopen()

    expectSuccessfulProviderTurn()
    expect(
      journal.snapshot().items.filter(({ body }) => body.kind === 'status' && body.providerFrame)
    ).toHaveLength(MAX_CODEX_GENERIC_ROWS_PER_TURN)
    expect(blockedInputs()).toEqual([
      {
        providerItemId: agentJournalItemKey(providerIdentity()),
        reason: 'provider-request-declined'
      }
    ])
    expect(observeStructuredAgentSessionOutcome(journal.snapshot()).ready).toBe(false)
  })

  it('persists a real elicitation decline from provider delivery through outcome observation', async () => {
    turn('turn/started')
    const connection = { respond: vi.fn(), respondWithError: vi.fn() }
    const session = {
      threadId: THREAD_ID,
      connection,
      prompts: new CodexPromptRegistry()
    } as unknown as CodexSession

    expect(
      deliverCodexServerRequest(
        identity.sessionId,
        session,
        {
          id: 7,
          method: CODEX_MCP_ELICITATION_METHOD,
          params: { threadId: THREAD_ID, turnId: TURN_ID }
        },
        (_session, event) => translator.handle(event)
      )
    ).toEqual({ accepted: true })
    expect(connection.respond).toHaveBeenCalledExactlyOnceWith(7, {
      action: 'decline',
      content: null,
      _meta: null
    })
    expect(connection.respondWithError).not.toHaveBeenCalled()
    turn('turn/completed')

    await reopen()

    expectSuccessfulProviderTurn()
    expect(blockedInputs()).toEqual([
      {
        providerItemId: agentJournalItemKey(providerIdentity()),
        reason: 'provider-request-declined'
      }
    ])
    expect(observeStructuredAgentSessionOutcome(journal.snapshot()).ready).toBe(false)
  })
})
