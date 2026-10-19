import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { AcpStructuredSessionAdapter } from '../../acp/acp-structured-session-adapter'
import { answerClaudePrompt } from '../../claude/claude-structured-control-actions'
import { ClaudePromptRegistry } from '../../claude/claude-structured-prompt-replies'
import type { ClaudeSession } from '../../claude/claude-structured-session-state'
import { answerCodexPrompt, CodexPromptRegistry } from '../../codex/codex-structured-prompt-replies'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { performPrompt, type AgentSessionTurnContext } from './structured-agent-session-turns'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: { kind: 'claude', sessionId: 'claude-1', leafUuid: null }
}
const APPROVAL_IDENTITY = {
  provider: 'legacy' as const,
  agent: 'claude' as const,
  sessionId: 'session-1',
  recordId: 'approval-1'
}
const ITEM_ID = agentJournalItemKey(APPROVAL_IDENTITY)

let root: string | null = null
const journals = createTrackedJournalOpener()

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

async function pendingApproval() {
  root = await mkdtemp(join(tmpdir(), 'omni-turn-prompt-'))
  const journal = await journals.open({ identity: IDENTITY, journalDir: root })
  const appended = await journal.appendItem(
    APPROVAL_IDENTITY,
    {
      kind: 'approval',
      title: 'Run a command?',
      detail: 'ls -la',
      options: [
        { id: 'accept', label: 'Yes' },
        { id: 'decline', label: 'No' }
      ],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { fence: 1 }
  )
  const answerPrompt = vi.fn<StructuredAgentSessionAdapter['answerPrompt']>(async () => undefined)
  const ctx: AgentSessionTurnContext = {
    sessionId: 'session-1',
    journal,
    fence: 1,
    adapter: { answerPrompt } as unknown as StructuredAgentSessionAdapter,
    persistOptions: async () => undefined,
    resolvedBy: 'client-1',
    publish: vi.fn(),
    now: () => 42
  }
  return { journal, ctx, answerPrompt, revision: appended.revision }
}

function approvalBody(journal: AgentSessionTurnContext['journal']) {
  return journal.snapshot().items.find((item) => item.itemId === ITEM_ID)
}

describe('performPrompt', () => {
  it('records the answer only after the agent took it', async () => {
    const { journal, ctx, answerPrompt, revision } = await pendingApproval()
    answerPrompt.mockImplementation(async () => {
      expect(approvalBody(journal)?.body).toMatchObject({ resolution: { state: 'pending' } })
    })

    const result = await performPrompt(ctx, {
      itemId: ITEM_ID,
      expectedRevision: revision,
      optionId: 'accept',
      kind: 'approval'
    })

    const resolution = {
      state: 'resolved',
      selectedOptionId: 'accept',
      resolvedBy: 'client-1',
      resolvedAt: 42
    }
    expect(answerPrompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      itemId: ITEM_ID,
      kind: 'approval',
      optionId: 'accept',
      fence: 1
    })
    expect(result).toEqual({
      ok: true,
      value: { itemId: ITEM_ID, revision: approvalBody(journal)?.revision, resolution }
    })
    expect(approvalBody(journal)?.body).toMatchObject({ kind: 'approval', resolution })
    expect(journal.snapshot().items.some((item) => item.body.kind === 'status')).toBe(false)
  })

  it('leaves a prompt open after a failure a retry can fix, says so, and lets a retry answer it', async () => {
    const { journal, ctx, answerPrompt, revision } = await pendingApproval()
    answerPrompt.mockRejectedValueOnce(new Error('control request timed out'))
    const input = {
      itemId: ITEM_ID,
      expectedRevision: revision,
      optionId: 'accept',
      kind: 'approval' as const
    }

    const failed = await performPrompt(ctx, input)

    expect(failed).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        message: expect.stringContaining('control request timed out')
      }
    })
    expect(approvalBody(journal)).toMatchObject({
      revision,
      body: { resolution: { state: 'pending' } }
    })
    expect(journal.snapshot().items.map((item) => item.body)).toContainEqual({
      kind: 'status',
      text: expect.stringContaining('the approval is still open')
    })

    const retried = await performPrompt(ctx, input)

    expect(retried).toMatchObject({
      ok: true,
      value: { itemId: ITEM_ID, resolution: { state: 'resolved', selectedOptionId: 'accept' } }
    })
    expect(answerPrompt).toHaveBeenCalledTimes(2)
    expect(approvalBody(journal)?.body).toMatchObject({
      resolution: { state: 'resolved', selectedOptionId: 'accept' }
    })
  })

  // Each real adapter's own failure for a prompt its provider no longer holds.
  const goneFailures: [string, StructuredAgentSessionAdapter['answerPrompt']][] = [
    [
      'claude',
      (input) =>
        answerClaudePrompt(
          { prompts: new ClaudePromptRegistry() } as unknown as ClaudeSession,
          input
        )
    ],
    [
      'codex',
      async (input) =>
        answerCodexPrompt(
          new CodexPromptRegistry(),
          { respond: vi.fn() },
          input.itemId,
          input.optionId
        )
    ],
    ['acp', (input) => new AcpStructuredSessionAdapter({} as never).answerPrompt(input)]
  ]

  it.each(goneFailures)(
    'closes a prompt the %s agent stopped waiting on as cancelled, so nothing stays blocked',
    async (_agent, gone) => {
      const { journal, ctx, answerPrompt, revision } = await pendingApproval()
      answerPrompt.mockImplementation(gone)
      const input = {
        itemId: ITEM_ID,
        expectedRevision: revision,
        optionId: 'accept',
        kind: 'approval' as const
      }

      const result = await performPrompt(ctx, input)

      const cancelled = {
        state: 'cancelled',
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null
      }
      expect(result).toMatchObject({
        ok: false,
        refusal: {
          code: 'agent_session_already_resolved',
          message: 'The agent stopped waiting for this answer; nothing was sent.',
          resolution: cancelled
        }
      })
      expect(approvalBody(journal)?.body).toMatchObject({ resolution: cancelled })
      expect(journal.snapshot().items.map((item) => item.body)).toContainEqual({
        kind: 'status',
        text: 'The agent stopped waiting for this answer; nothing was sent.'
      })
      const again = await performPrompt(ctx, {
        ...input,
        expectedRevision: approvalBody(journal)!.revision
      })
      expect(again).toMatchObject({
        ok: false,
        refusal: { code: 'agent_session_already_resolved' }
      })
      expect(answerPrompt).toHaveBeenCalledTimes(1)
    }
  )

  it('refuses a second answer while the first is still with the agent', async () => {
    const { journal, ctx, answerPrompt, revision } = await pendingApproval()
    let release: () => void = () => {}
    answerPrompt.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)))
    const input = {
      itemId: ITEM_ID,
      expectedRevision: revision,
      optionId: 'accept',
      kind: 'approval' as const
    }

    const first = performPrompt(ctx, input)
    await vi.waitFor(() => expect(answerPrompt).toHaveBeenCalledTimes(1))
    const second = await performPrompt(ctx, { ...input, optionId: 'decline' })

    expect(second).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_conflict', currentRevision: revision }
    })
    release()
    expect(await first).toMatchObject({
      ok: true,
      value: { resolution: { state: 'resolved', selectedOptionId: 'accept' } }
    })
    expect(answerPrompt).toHaveBeenCalledTimes(1)
    expect(journal.snapshot().items.some((item) => item.body.kind === 'status')).toBe(false)
  })
})
