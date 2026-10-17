import { describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { readStructuredSessionOutcomeSourceContext } from './structured-agent-session-source-context'

function fixture() {
  const record = agentSessionRecordFixture(agentSessionLeaseFixture({ runtimeKind: 'native' }))
  record.options = { model: 'next-turn-model', effort: 'low' }
  const snapshot: AgentJournalSnapshot = {
    sessionId: record.sessionId,
    cursor: { epoch: 'epoch', sequence: 10 },
    submissions: [
      {
        clientMessageId: 'source-turn',
        fence: 7,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'accepted',
        providerItemId: 'user',
        reason: null,
        submittedAt: 1,
        resolvedAt: 2
      }
    ],
    items: [
      {
        itemId: 'old',
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Old result' }] }
      },
      {
        itemId: 'user',
        revision: 1,
        sequence: 2,
        observedAt: 2,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'Write the result' }]
        }
      },
      {
        itemId: 'diff',
        revision: 1,
        sequence: 3,
        observedAt: 3,
        body: {
          kind: 'diff',
          path: './result.md',
          patch: {
            head: '+result',
            byteLength: 7,
            digest: 'digest',
            truncated: false
          }
        }
      },
      {
        itemId: 'response',
        revision: 1,
        sequence: 4,
        observedAt: 4,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Final result written.' }]
        }
      },
      {
        itemId: 'settled',
        revision: 1,
        sequence: 5,
        observedAt: 5,
        body: {
          kind: 'status',
          text: '',
          turnLifecycle: {
            turnId: 'source-turn',
            state: 'completed',
            settlement: { providerItemId: 'user', outcome: 'succeeded' }
          }
        }
      }
    ]
  }
  const session = {
    params: { location: record.location },
    fence: 7,
    hasProviderChild: true,
    journal: { snapshot: () => structuredClone(snapshot) }
  } as unknown as StructuredAgentSessionHostSession
  const readSourceOptions = vi.fn(async () => ({ model: 'claude-source', effort: 'high' }))
  const context = {
    sessions: new Map([[record.sessionId, session]]),
    store: { getRecord: () => record } as unknown as AgentSessionRecordStore,
    adapter: { readSourceOptions } as unknown as StructuredAgentSessionAdapter
  }
  const paneKey = structuredAgentSessionPaneKey(
    structuredAgentSessionTabId(record.sessionId),
    record.sessionId
  )
  const read = (workspace = record.location.workspaceId) =>
    readStructuredSessionOutcomeSourceContext(context, paneKey, workspace)
  return { record, session, snapshot, readSourceOptions, read }
}

describe('host-owned structured source context', () => {
  it('captures this completed response and diffs with its actual turn model', async () => {
    const f = fixture()
    expect(await f.read()).toMatchObject({
      agent: 'claude',
      model: 'claude-source',
      effort: 'high',
      summary: 'Final result written.',
      files: ['./result.md']
    })
    expect(f.readSourceOptions).toHaveBeenCalledWith({
      sessionId: f.record.sessionId,
      fence: 7,
      clientMessageId: 'source-turn'
    })
  })

  it('never fills missing model evidence from next-turn preferences', async () => {
    const f = fixture()
    f.readSourceOptions.mockResolvedValue({ model: '', effort: 'high' })
    expect(await f.read()).toBeNull()
  })

  it('refuses mismatched workspaces, unreconciled owners and obsolete fences', async () => {
    const f = fixture()
    expect(await f.read('another-workspace')).toBeNull()
    f.record.lease.unreconciled = true
    expect(await f.read()).toBeNull()
    f.record.lease.unreconciled = false
    f.session.fence += 1
    expect(await f.read()).toBeNull()
  })

  it('refuses failed completion and cannot borrow an old final response', async () => {
    const f = fixture()
    f.snapshot.items = f.snapshot.items.filter((item) => item.itemId !== 'response')
    expect(await f.read()).toBeNull()
    const settled = f.snapshot.items.at(-1)!.body
    if (settled.kind === 'status') {
      settled.turnLifecycle!.settlement!.outcome = 'failed'
    }
    expect(await f.read()).toBeNull()
  })

  it('rechecks source ownership and turn identity after reading provider settings', async () => {
    const f = fixture()
    f.readSourceOptions.mockImplementation(async () => {
      f.snapshot.cursor.sequence += 1
      return { model: 'claude-source', effort: 'high' }
    })
    expect(await f.read()).toBeNull()
  })
})
