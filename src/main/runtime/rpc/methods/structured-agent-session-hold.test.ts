import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/structured-agent-session-event-sink'
// The wire half of a session's lifetime: who takes a hold, and what happens when they vanish.
//
// Run against the REAL subscription registry rather than a stub, because the backstop being tested
// IS that registry's connection sweep — a stubbed `registerSubscriptionCleanup` would prove that
// the handler called a function, which is not the claim.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { structuredAgentSessionProcessState } from '../../../native-chat/agent-session-wire/structured-agent-session-process-state'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  resetHostTestOperationIds
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { AgentSessionRecordStore } from '../../agent-session-record-store'
import { OrcaRuntimeService } from '../../omni-runtime'
import type { RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'

const CONNECTION = 'connection-1'
const GRACE_MS = 5
const CLIENT = {
  clientId: 'device-1',
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
  connectionId: CONNECTION
}

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let runtime: OrcaRuntimeService
let dispatcher: RpcDispatcher
let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let providerEvents: StructuredAgentSessionEventSink | undefined
let requests = 0

async function call(method: string, params: unknown): Promise<RpcResponse> {
  const replies: RpcResponse[] = []
  requests += 1
  await dispatcher.dispatchStreaming(
    { id: `request-${requests}`, authToken: 'token', method, params },
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
    CLIENT
  )
  return replies[0] as RpcResponse
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omni-hold-wire-'))
  resetHostTestOperationIds()
  requests = 0
  closeSession = vi.fn(async () => true)
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  acquire = vi.fn(async ({ fence, spawnToken, events }) => {
    providerEvents = events
    return {
      process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
      link: {
        linkId: `link-${fence}`,
        handle: { provider: 'codex' as const, threadId: THREAD },
        origin: store.getRecord(SESSION)?.providerHandleChain.length
          ? ('resumed' as const)
          : ('created' as const),
        mintedAtFence: fence,
        observedAt: NOW
      }
    }
  })
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire,
      closeSession,
      dispatch: async () => ({ state: 'rejected', reason: 'unused' }),
      cancelTurn: async () => ({ cancelled: false }),
      answerPrompt: async () => undefined,
      setOption: async () => undefined
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    releaseGraceMs: GRACE_MS,
    now: () => NOW
  })
  setStructuredAgentSessionHost(host)
  runtime = new OrcaRuntimeService()
  dispatcher = new RpcDispatcher({ runtime, methods: STRUCTURED_AGENT_SESSION_METHODS })
  expect(await host.attach({ callerKey: 'client-1' }, hostTestAttachParams(null))).toMatchObject({
    ok: true
  })
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('a client that holds a session', () => {
  it('keeps the provider child while the hold stands', async () => {
    expect(
      await call('agentSession.hold', { sessionId: SESSION, holderId: 'chat-1' })
    ).toMatchObject({ ok: true })

    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 20))

    expect(closeSession).not.toHaveBeenCalled()
    expect(host.hasSession(SESSION)).toBe(true)
  })

  it('releases it when the client says so', async () => {
    await call('agentSession.hold', { sessionId: SESSION, holderId: 'chat-1' })

    expect(
      await call('agentSession.release', { sessionId: SESSION, holderId: 'chat-1' })
    ).toMatchObject({ ok: true })

    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
    expect(closeSession).toHaveBeenCalledWith(SESSION)
  })

  it('does not report success when no provider child can be acquired', async () => {
    const response = await call('agentSession.hold', {
      sessionId: 'session-missing',
      holderId: 'chat-missing'
    })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'agent_session_identity_required' }
    })
    expect(host.isHeld('session-missing')).toBe(false)
  })
})

describe('a client that disappears without cleanup', () => {
  it('still releases the session when its transport closes', async () => {
    await call('agentSession.hold', { sessionId: SESSION, holderId: 'chat-1' })

    runtime.cleanupSubscriptionsForConnection(CONNECTION)

    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
    expect(closeSession).toHaveBeenCalledWith(SESSION)
  })

  it('does not release a hold another connection is still holding', async () => {
    await call('agentSession.hold', { sessionId: SESSION, holderId: 'chat-1' })
    await dispatcher.dispatchStreaming(
      {
        id: 'request-other',
        authToken: 'token',
        method: 'agentSession.hold',
        params: { sessionId: SESSION, holderId: 'chat-1' }
      },
      () => {},
      { ...CLIENT, clientId: 'device-2', connectionId: 'connection-2' }
    )

    runtime.cleanupSubscriptionsForConnection(CONNECTION)
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 20))

    expect(closeSession).not.toHaveBeenCalled()
    expect(host.hasSession(SESSION)).toBe(true)
  })

  it('does not let an old connection sweep release its same-document replacement', async () => {
    await call('agentSession.hold', { sessionId: SESSION, holderId: 'chat-1' })
    await dispatcher.dispatchStreaming(
      {
        id: 'request-replacement',
        authToken: 'token',
        method: 'agentSession.hold',
        params: { sessionId: SESSION, holderId: 'chat-1' }
      },
      () => {},
      { ...CLIENT, connectionId: 'connection-2' }
    )

    runtime.cleanupSubscriptionsForConnection(CONNECTION)
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 20))

    expect(closeSession).not.toHaveBeenCalled()
    expect(host.hasSession(SESSION)).toBe(true)

    runtime.cleanupSubscriptionsForConnection('connection-2')
    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
  })

  it('releases a desktop subscription when its renderer transport dies', async () => {
    const transport = new AbortController()
    await dispatcher.dispatchStreaming(
      {
        id: 'desktop-subscription',
        authToken: 'token',
        method: 'agentSession.subscribe',
        params: { sessionId: SESSION }
      },
      () => {},
      {
        signal: transport.signal,
        clientId: 'desktop-renderer',
        clientKind: 'runtime',
        clientCapabilities: CLIENT.clientCapabilities
      }
    )
    expect(host.isHeld(SESSION)).toBe(true)

    transport.abort()

    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
    expect(closeSession).toHaveBeenCalledWith(SESSION)
  })

  it('does not let a stream alone resume a released session', async () => {
    await host.close(SESSION)
    expect(host.hasSession(SESSION)).toBe(false)
    await host.restoreReadableSessions()
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')

    await dispatcher.dispatchStreaming(
      {
        id: 'request-subscribe',
        authToken: 'token',
        method: 'agentSession.subscribe',
        params: { sessionId: SESSION }
      },
      () => {},
      CLIENT
    )

    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  })
})

describe('passive viewer RPC', () => {
  it.each(['release', 'disconnect'])(
    'cancels a pending viewer acquisition on %s before delayed reveal finishes',
    async (action) => {
      let finish!: () => void
      const loading = new Promise<void>((resolve) => {
        finish = resolve
      })
      const originalReveal = host.revealSession.bind(host)
      const reveal = vi
        .spyOn(host, 'revealSession')
        .mockImplementation(() => loading.then(() => originalReveal(SESSION)))
      const retain = vi.spyOn(host, 'hold')
      const pending = call('agentSession.hold', {
        sessionId: SESSION,
        holderId: 'late',
        mode: 'viewer'
      })
      await vi.waitFor(() => expect(reveal).toHaveBeenCalledOnce())
      if (action === 'release') {
        expect(
          await call('agentSession.release', { sessionId: SESSION, holderId: 'late' })
        ).toMatchObject({ ok: true })
      } else {
        runtime.cleanupSubscriptionsForConnection(CONNECTION)
      }
      finish()
      expect(await pending).toMatchObject({ ok: false })
      expect(retain).not.toHaveBeenCalled()
      expect(host.isHeld(SESSION)).toBe(false)
      reveal.mockRestore()
      retain.mockRestore()
    }
  )

  it('does not let a cancelled delayed acquisition release its replacement', async () => {
    let finish!: () => void
    const loading = new Promise<void>((resolve) => {
      finish = resolve
    })
    const originalReveal = host.revealSession.bind(host)
    const reveal = vi
      .spyOn(host, 'revealSession')
      .mockImplementationOnce(() => loading.then(() => originalReveal(SESSION)))
    const params = { sessionId: SESSION, holderId: 'same', mode: 'viewer' }
    const old = call('agentSession.hold', params)
    await vi.waitFor(() => expect(reveal).toHaveBeenCalledOnce())
    expect(await call('agentSession.hold', params)).toMatchObject({ ok: true })
    finish()
    expect(await old).toMatchObject({ ok: false })
    expect(host.isHeld(SESSION)).toBe(true)
    expect(
      await call('agentSession.release', { sessionId: SESSION, holderId: 'same' })
    ).toMatchObject({ ok: true })
    expect(host.isHeld(SESSION)).toBe(false)
    reveal.mockRestore()
  })

  it('does not mistake a readable session owned elsewhere for an exited process', () => {
    const record = store.getRecord(SESSION)!
    expect(structuredAgentSessionProcessState(record, false)).toBe('unverifiable')
    expect(
      structuredAgentSessionProcessState(
        {
          ...record,
          lease: {
            ...record.lease,
            claimStatus: 'released',
            ownerProcess: null,
            unreconciled: true
          }
        },
        false
      )
    ).toBe('unverifiable')
    expect(
      structuredAgentSessionProcessState(
        { ...record, lease: { ...record.lease, claimStatus: 'conflicted' } },
        false
      )
    ).toBe('unverifiable')
  })

  it('restores dormant history without acquiring a child, then resumes only on explicit request', async () => {
    providerEvents!.appendItem(
      { provider: 'omni', clientMessageId: 'saved-message' },
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Saved history' }]
      }
    )
    await host.flushStreamedEvents(SESSION)
    await host.close(SESSION)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      unreconciled: false,
      deathEvidence: { kind: 'exit-observed' }
    })
    acquire.mockClear()
    expect(
      await call('agentSession.hold', { sessionId: SESSION, holderId: 'viewer', mode: 'viewer' })
    ).toMatchObject({ ok: true, result: { held: true, processState: 'exited' } })
    expect(host.hasSession(SESSION)).toBe(true)
    expect(host.processState(SESSION)).toBe('exited')
    expect(acquire).not.toHaveBeenCalled()
    expect(
      await call('agentSession.history', { sessionId: SESSION, direction: 'tail' })
    ).toMatchObject({
      ok: true,
      result: {
        ok: true,
        page: {
          items: [{ body: { kind: 'message', blocks: [{ type: 'text', text: 'Saved history' }] } }]
        }
      }
    })
    expect(acquire).not.toHaveBeenCalled()
    expect(
      await call('agentSession.hold', { sessionId: SESSION, holderId: 'explicit-resume' })
    ).toMatchObject({ ok: true, result: { held: true } })
    expect(acquire).toHaveBeenCalledOnce()
    expect(host.processState(SESSION)).toBe('live')
    await call('agentSession.release', { sessionId: SESSION, holderId: 'explicit-resume' })
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 20))
    expect(host.processState(SESSION)).toBe('live')
    await call('agentSession.release', { sessionId: SESSION, holderId: 'viewer' })
    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
  })
  it('confirms an existing child without acquiring another one', async () => {
    acquire.mockClear()
    expect(
      await call('agentSession.hold', { sessionId: SESSION, holderId: 'viewer', mode: 'viewer' })
    ).toMatchObject({ ok: true, result: { held: true, processState: 'live' } })
    expect(acquire).not.toHaveBeenCalled()
  })
  it('returns an identity failure rather than reporting a missing record as exited', async () => {
    expect(
      await call('agentSession.hold', {
        sessionId: 'session-missing',
        holderId: 'viewer',
        mode: 'viewer'
      })
    ).toMatchObject({ ok: false, error: { code: 'agent_session_identity_required' } })
    expect(host.isHeld('session-missing')).toBe(false)
  })
})
