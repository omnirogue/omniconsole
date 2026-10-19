import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionRefusalOperationState } from '../../../shared/agent-session-refusal-retry'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }
const journals = createTrackedJournalOpener()
let root: string | null = null

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

async function hostWithPendingApproval() {
  root = await mkdtemp(join(tmpdir(), 'omni-prompt-retry-'))
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: THREAD }
    },
    journalDir: journalDirectoryFor(root, { workspaceId: 'workspace-1', sessionId: SESSION })
  })
  const prompt = await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 99 },
    {
      kind: 'approval',
      title: 'Run the command?',
      detail: null,
      options: [{ id: 'allow', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { fence: 1 }
  )
  const store = await AgentSessionRecordStore.open({
    directory: join(root, 'store'),
    hostId: 'local'
  })
  const answerPrompt = vi.fn<StructuredAgentSessionAdapter['answerPrompt']>(async () => undefined)
  const host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire: async ({ fence }) => ({
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: NOW - 1_000,
          spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
        },
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex', threadId: THREAD },
          origin: 'created',
          mintedAtFence: fence,
          observedAt: NOW
        }
      }),
      dispatch: async () => ({ state: 'unknown', reason: 'unused' }),
      cancelTurn: async () => ({ cancelled: true }),
      answerPrompt,
      setOption: async () => undefined
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: 'allow' }
  const respond = (clientOperationId = hostTestOperationId()) =>
    host.respondToPrompt(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId,
        expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.respondTo:approval',
          sessionId: SESSION,
          fields
        })
      },
      kind: 'approval',
      ...fields
    })
  return { host, answerPrompt, respond, itemId: prompt.itemId }
}

describe('a structured answer the agent refused', () => {
  it('stays open and is answered by the client’s retry', async () => {
    const { host, answerPrompt, respond, itemId } = await hostWithPendingApproval()
    answerPrompt.mockRejectedValueOnce(new Error('pipe closed'))

    const failed = await respond()
    expect(failed).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    // The window then retries under a new operation id, as it does for every settled refusal.
    expect(
      !failed.ok &&
        agentSessionRefusalOperationState('agentSession.respondTo:approval', failed.refusal.code)
    ).toBe('settled-rejected')
    const page = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.items.find((entry) => entry.itemId === itemId)?.body).toMatchObject(
      { resolution: { state: 'pending' } }
    )

    expect(await respond()).toMatchObject({
      ok: true,
      replayed: false,
      value: { itemId, resolution: { state: 'resolved', selectedOptionId: 'allow' } }
    })
    expect(answerPrompt).toHaveBeenCalledTimes(2)
    await host.flushAllStreamedEvents()
  })

  it('never lets a second answer reach the agent while the first is still with it', async () => {
    const { host, answerPrompt, respond } = await hostWithPendingApproval()
    let release: () => void = () => {}
    answerPrompt.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)))
    const sameId = hostTestOperationId()

    const first = respond(sameId)
    await vi.waitFor(() => expect(answerPrompt).toHaveBeenCalledTimes(1))
    const repeated = respond(sameId)
    const another = respond()
    release()

    expect(await first).toMatchObject({ ok: true, replayed: false })
    expect(await repeated).toMatchObject({ ok: true, replayed: true })
    // Mutations on one session run one at a time, so it finds the prompt already answered.
    expect(await another).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_item_revision_stale',
        resolution: { state: 'resolved', selectedOptionId: 'allow' }
      }
    })
    expect(answerPrompt).toHaveBeenCalledTimes(1)
    await host.flushAllStreamedEvents()
  })
})
