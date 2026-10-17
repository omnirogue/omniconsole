import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { NativeChatPlan } from '../../../shared/native-chat-plan'
import {
  activeStructuredAgentSessionTurnId,
  projectStructuredItemsToNativeChat
} from '../../../shared/structured-agent-session-projection'
import { indexAcpConfigOptions } from '../../acp/acp-session-config'
import { applyAcpSessionUpdate } from '../../acp/acp-session-events'
import { publishAcpTurn, type AcpSession } from '../../acp/acp-session-notifications'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventSink
} from '../agent-session-wire/structured-agent-session-event-sink'
import { journalDatabaseFile } from './journal-paths'
import type { AgentSessionJournal } from './journal-store'
import { createTrackedJournalOpener } from './journal-store-test-open'

const SESSION_ID = 'session-provider-plan'
const PROVIDER_ID = 'provider-session-plan'
const TURN_ID = 'turn-plan-1'
const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omni-journal-provider-plan-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function providerDriver(provider: 'acp' | 'codex', sink: StructuredAgentSessionEventSink) {
  if (provider === 'codex') {
    const translator = createCodexJournalTranslator({
      sink,
      primaryThreadId: () => PROVIDER_ID
    })
    const notify = (method: string, params: Record<string, unknown> = {}) => {
      expect(
        translator.handle({
          type: 'notification',
          sessionId: SESSION_ID,
          threadId: PROVIDER_ID,
          method,
          params: { turnId: TURN_ID, ...params }
        })
      ).toEqual({ accepted: true })
    }
    return {
      start: () => notify('turn/started'),
      update: (plan: NativeChatPlan) =>
        notify('turn/plan/updated', {
          plan: plan.entries.map((entry) => ({ step: entry.content, status: entry.status }))
        }),
      complete: () => notify('turn/completed'),
      dispose: () => translator.dispose()
    }
  }

  const session: AcpSession = {
    connection: {
      pid: undefined,
      closed: false,
      initialize: {},
      request: vi.fn(async () => null),
      notify: vi.fn(),
      respond: vi.fn(),
      respondError: vi.fn(),
      close: vi.fn(async () => true)
    },
    acpSessionId: PROVIDER_ID,
    agent: 'gemini',
    fence: 1,
    imageCapable: false,
    config: indexAcpConfigOptions([]),
    pendingPermissions: new Map(),
    promptCount: 1,
    assistant: { text: '' },
    events: sink,
    bypass: false,
    options: {},
    activeTurnId: TURN_ID,
    tools: new Map()
  }
  return {
    start: () => publishAcpTurn(session, TURN_ID, 'running'),
    update: (plan: NativeChatPlan) =>
      applyAcpSessionUpdate({
        sessionId: SESSION_ID,
        agent: session.agent,
        acpSessionId: session.acpSessionId,
        assistantRecordId: `${TURN_ID}:assistant`,
        params: { update: { sessionUpdate: 'plan', entries: plan.entries } },
        events: sink
      }),
    complete: () => publishAcpTurn(session, TURN_ID, 'completed'),
    dispose: () => undefined
  }
}

function expectProjectedPlan(
  journal: AgentSessionJournal,
  plan: NativeChatPlan,
  fallback: string,
  itemId?: string
): string {
  const messages = projectStructuredItemsToNativeChat(journal.snapshot().items)
  expect(messages).toHaveLength(1)
  const message = messages[0]!
  expect(message.role).toBe('system')
  expect(message.blocks).toHaveLength(1)
  const block = message.blocks[0]
  if (block?.type !== 'text') {
    throw new Error('Expected a text block carrying the persisted provider plan')
  }
  expect(block.plan).toEqual(plan)
  expect(block.text).toBe(fallback)
  if (itemId) {
    expect(message.id).toBe(itemId)
  }
  return message.id
}

describe('provider plan persistence and native-chat replay', () => {
  it.each(['acp', 'codex'] as const)(
    '%s replaces and clears snapshots through the deferred sink and SQLite without inventing completion',
    async (provider) => {
      const identity: AgentSessionJournalIdentity = {
        sessionId: SESSION_ID,
        workspaceId: 'workspace-plan',
        hostId: 'host-plan',
        agent: provider === 'codex' ? 'codex' : 'gemini',
        providerHandle:
          provider === 'codex'
            ? { kind: 'codex', threadId: PROVIDER_ID }
            : { kind: 'opaque', agent: 'gemini', value: PROVIDER_ID }
      }
      const errors = vi.fn()
      const publish = vi.fn()
      const deferred = createDeferredStructuredAgentSessionEventSink({ onError: errors })
      const driver = providerDriver(provider, deferred.sink)
      let journal = await journals.open({ identity, journalDir: root })
      const bind = () => deferred.bind({ journal, fence: 1, publish })
      const replay = async () => {
        expect(await deferred.drained()).toEqual({ ok: true })
        const saved = journal.snapshot()
        deferred.unbind()
        await journal.close()
        journal = await journals.open({ identity, journalDir: root })
        expect(journal.snapshot()).toEqual(saved)
        bind()
      }
      const initial: NativeChatPlan = {
        entries: [
          { content: 'Inspect the session', status: 'in_progress' },
          { content: 'Outdated follow-up', status: 'pending' }
        ]
      }
      const replacement: NativeChatPlan = {
        entries: [
          { content: 'Inspect the session', status: 'completed' },
          { content: 'Persist the checklist', status: 'in_progress' },
          { content: 'Verify the reopened session', status: 'pending' }
        ]
      }
      const replacementText =
        '- [x] Inspect the session\n- [ ] Persist the checklist (in progress)\n- [ ] Verify the reopened session'

      try {
        driver.start()
        driver.update(initial)
        expect(journal.snapshot().items).toEqual([])
        bind()
        await replay()
        const itemId = expectProjectedPlan(
          journal,
          initial,
          '- [ ] Inspect the session (in progress)\n- [ ] Outdated follow-up'
        )
        expect(activeStructuredAgentSessionTurnId(journal.snapshot().items)).toBe(TURN_ID)
        expect((await readFile(journalDatabaseFile(root))).subarray(0, 16).toString()).toBe(
          'SQLite format 3\u0000'
        )

        driver.update(replacement)
        await replay()
        expectProjectedPlan(journal, replacement, replacementText, itemId)

        driver.update({ entries: [] })
        await replay()
        expectProjectedPlan(journal, { entries: [] }, 'Plan cleared.', itemId)

        driver.update(replacement)
        expect(await deferred.drained()).toEqual({ ok: true })
        driver.complete()
        await replay()
        expect(activeStructuredAgentSessionTurnId(journal.snapshot().items)).toBeNull()
        expectProjectedPlan(journal, replacement, replacementText, itemId)
        expect(publish).toHaveBeenCalled()
        expect(errors).not.toHaveBeenCalled()
      } finally {
        driver.dispose()
        deferred.close()
      }
    }
  )
})
