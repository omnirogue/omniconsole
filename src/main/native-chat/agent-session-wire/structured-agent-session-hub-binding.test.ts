import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { prependHubTaskPrompt } from '../../../shared/omnios-task-binding'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

let directory: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
const caller = { callerKey: 'client-1' }
const dispatch = vi.fn<StructuredAgentSessionAdapter['dispatch']>()

function createHost(hubTaskId: string): StructuredAgentSessionHost {
  const adapter: StructuredAgentSessionAdapter = {
    acquire: async ({ fence, spawnToken }) => ({
      process: {
        hostId: 'local',
        pid: 4242 + fence,
        processStartTimeMs: HOST_TEST_NOW,
        spawnToken
      },
      link: {
        linkId: `link-${fence}`,
        handle: { provider: 'codex', threadId: HOST_TEST_THREAD },
        origin: fence === 1 ? 'created' : 'resumed',
        mintedAtFence: fence,
        observedAt: HOST_TEST_NOW
      }
    }),
    dispatch,
    cancelTurn: async () => ({ cancelled: true }),
    answerPrompt: async () => undefined,
    setOption: async () => undefined
  }
  return new StructuredAgentSessionHost({
    store,
    adapter,
    journalRoot: directory,
    claimKeyId: 'key-1',
    probeOwner: async () => ({ outcome: 'pid-absent' }),
    resolveWorkspaceHubTaskId: () => hubTaskId,
    now: () => HOST_TEST_NOW
  })
}

function sendParams(text: string) {
  const body = hostTestMessage(text)
  return {
    body,
    envelope: {
      sessionId: HOST_TEST_SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: HOST_TEST_SESSION,
        fields: { body }
      })
    }
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'omni-structured-hub-binding-'))
  resetHostTestOperationIds()
  dispatch.mockReset().mockResolvedValue({
    state: 'accepted',
    providerIdentity: {
      provider: 'codex',
      threadId: HOST_TEST_THREAD,
      turnId: 'turn-1',
      ordinal: 0
    }
  })
  store = await AgentSessionRecordStore.open({
    directory: join(directory, 'store'),
    hostId: 'local'
  })
  host = createHost('btk_1234')
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(directory, { recursive: true, force: true })
})

describe('structured hub card binding', () => {
  it('pins host metadata before acquisition and prefixes the first turn without changing its client fingerprint', async () => {
    expect(await host.attach(caller, hostTestAttachParams(null))).toMatchObject({ ok: true })
    expect(store.getRecord(HOST_TEST_SESSION)?.hubTaskId).toBe('btk_1234')

    const first = sendParams('Create the customer reply')
    expect(await host.send(caller, first)).toMatchObject({ ok: true, replayed: false })
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: hostTestMessage(prependHubTaskPrompt('Create the customer reply', 'btk_1234'))
      })
    )
    expect(await host.send(caller, first)).toMatchObject({ ok: true, replayed: true })
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('keeps the card through host restart and sends later turns without a repeated introduction', async () => {
    expect(await host.attach(caller, hostTestAttachParams(null))).toMatchObject({ ok: true })
    expect(await host.send(caller, sendParams('Create the content'))).toMatchObject({ ok: true })
    const fence = store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
    await host.flushAllStreamedEvents()
    store = await AgentSessionRecordStore.open({
      directory: join(directory, 'store'),
      hostId: 'local'
    })
    host = createHost('btk_5678')
    const stale = await host.attach(caller, hostTestAttachParams(fence))
    expect(stale).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale' }
    })
    if (stale.ok || stale.refusal.currentFence === undefined) {
      throw new Error('Restart must return the replacement fence for the next attach.')
    }
    expect(stale.refusal.currentFence).toBeGreaterThan(fence)
    expect(
      await host.attach(caller, hostTestAttachParams(stale.refusal.currentFence))
    ).toMatchObject({
      ok: true
    })
    expect(store.getRecord(HOST_TEST_SESSION)?.hubTaskId).toBe('btk_1234')
    expect(await host.send(caller, sendParams('Continue from the saved draft'))).toMatchObject({
      ok: true
    })
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: hostTestMessage('Continue from the saved draft')
      })
    )
  })

  it('retains the same introduction when a user explicitly retries an unknown first delivery', async () => {
    dispatch.mockResolvedValueOnce({ state: 'unknown', reason: 'reply lost' })
    expect(await host.attach(caller, hostTestAttachParams(null))).toMatchObject({ ok: true })
    const first = sendParams('Create the content')
    expect(await host.send(caller, first)).toMatchObject({ ok: true })
    expect(await host.send(caller, { ...first, retryUnknown: true })).toMatchObject({ ok: true })
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[0]?.[0].body).toEqual(dispatch.mock.calls[1]?.[0].body)
    expect(dispatch.mock.calls[1]?.[0].body).toEqual(
      hostTestMessage(prependHubTaskPrompt('Create the content', 'btk_1234'))
    )
  })

  it('does not duplicate a card introduction already supplied by a workspace startup prompt', async () => {
    expect(await host.attach(caller, hostTestAttachParams(null))).toMatchObject({ ok: true })
    const text = prependHubTaskPrompt('Create the content', 'btk_1234')
    expect(await host.send(caller, sendParams(text))).toMatchObject({ ok: true })
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ body: hostTestMessage(text) }))
  })
})
