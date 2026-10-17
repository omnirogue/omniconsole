import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: { kind: 'claude', sessionId: 'provider-1', leafUuid: 'leaf-1' }
}

let root = ''

function message(
  role: 'assistant' | 'user',
  uuid: string,
  content: unknown[]
): ClaudeStructuredSessionEvent {
  return {
    type: 'message',
    sessionId: 'orca-session',
    message: {
      type: role,
      uuid,
      session_id: 'provider-1',
      message: { role, content }
    }
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-provider-fallback-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('Claude provider fallback', () => {
  it('keeps a rejected quota event visible without surfacing informational capacity updates', () => {
    const items: AgentJournalItemBody[] = []
    const translator = createClaudeJournalTranslator({
      sink: {
        appendItem: (_identity, body) => {
          items.push(body)
        },
        appendTombstone: vi.fn(),
        publish: vi.fn()
      }
    })
    for (const status of ['allowed', 'rejected']) {
      translator.handle({
        type: 'message',
        sessionId: 'orca-session',
        message: { type: 'rate_limit_event', rate_limit_info: { status, resetsAt: 1900000000 } }
      } as ClaudeStructuredSessionEvent)
    }
    expect(items).toHaveLength(1)
    expect(JSON.stringify(items)).toContain('limit')
  })

  it('drops suppressed init frames instead of dereferencing a null translation', () => {
    const items: { identity: unknown; body: AgentJournalItemBody }[] = []
    const sink = {
      appendItem: (identity: unknown, body: AgentJournalItemBody) => {
        items.push({ identity, body })
      },
      appendTombstone: vi.fn(),
      publish: vi.fn()
    }
    const translator = createClaudeJournalTranslator({ sink })
    const initEvent: ClaudeStructuredSessionEvent = {
      type: 'message',
      sessionId: 'orca-session',
      message: {
        type: 'system',
        subtype: 'init',
        session_id: 'provider-1',
        uuid: 'init-1'
      }
    }

    expect(() => translator.handle(initEvent)).not.toThrow()
    expect(items).toEqual([])
  })

  it('keeps provider-fallback rows distinct across acquisitions', async () => {
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      now: () => 1_700_000_000_000,
      mintEpoch: () => 'epoch-1'
    })
    const deferred = createDeferredStructuredAgentSessionEventSink()
    deferred.bind({
      journal,
      fence: 1,
      publish: vi.fn()
    })

    const first = createClaudeJournalTranslator({ sink: deferred.sink, fallbackIdPrefix: '1' })
    const second = createClaudeJournalTranslator({ sink: deferred.sink, fallbackIdPrefix: '2' })

    first.handle(message('assistant', 'assistant-1', [{ type: 'future_event', message: 'first' }]))
    await deferred.drained()
    second.handle(
      message('assistant', 'assistant-2', [{ type: 'future_event', message: 'second' }])
    )
    await deferred.drained()

    const fallbackRows = journal
      .snapshot()
      .items.filter(
        (item) =>
          item.body.kind === 'status' &&
          item.body.providerFrame?.kind === 'message:assistant:content:future_event'
      )

    expect(fallbackRows).toHaveLength(2)
    expect(fallbackRows.map(statusText)).toEqual(['first', 'second'])
  })
})

function statusText(row: { body: AgentJournalItemBody }): string {
  if (row.body.kind !== 'status') {
    throw new Error('expected status row')
  }
  return row.body.text
}
