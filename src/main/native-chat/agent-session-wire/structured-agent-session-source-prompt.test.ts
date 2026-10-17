import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { prependHubTaskPrompt } from '../../../shared/omnios-task-binding'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { performSend, type AgentSessionTurnContext } from './structured-agent-session-turns'

const identity: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}
const providerIdentity = {
  provider: 'codex' as const,
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 0
}
const journals = createTrackedJournalOpener()
const dispatch = vi.fn<StructuredAgentSessionAdapter['dispatch']>()
let root: string
let journal: AgentSessionJournal
let atDispatch: AgentJournalSubmission[]

function context(): AgentSessionTurnContext {
  return {
    sessionId: identity.sessionId,
    journal,
    fence: 1,
    adapter: { dispatch } as unknown as StructuredAgentSessionAdapter,
    hubTaskId: 'btk_1234',
    userSourceAuthority: true,
    persistOptions: async () => undefined,
    resolvedBy: 'caller',
    publish: vi.fn(),
    now: () => 1
  }
}

function sendInput(body: AgentJournalMessageItem) {
  return {
    clientMessageId: 'send-1',
    payloadFingerprint: structuredAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: identity.sessionId,
      fields: { body }
    }),
    body
  }
}

async function reopen(): Promise<void> {
  await journal.close()
  journal = await journals.open({ identity, journalDir: root })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omni-source-prompt-'))
  journal = await journals.open({ identity, journalDir: root })
  atDispatch = []
  dispatch.mockReset().mockImplementation(async () => {
    atDispatch = journal.submissions().map((submission) => ({ ...submission }))
    return { state: 'accepted', providerIdentity }
  })
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('structured send source prompt', () => {
  it('does not turn automated user-role sends into user source authority', async () => {
    const ctx = context()
    delete ctx.userSourceAuthority
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Add a Codex reviewer when done.' }]
    }
    expect(await performSend(ctx, sendInput(body))).toMatchObject({ ok: true })
    expect(atDispatch[0]?.sourcePrompt).toBeNull()
    const delivered = dispatch.mock.calls[0]?.[0].body.blocks[0]
    expect(delivered?.type === 'text' ? delivered.text : '').not.toContain('omni-outcome-source-v1')
  })

  it.each([
    'can you make a handoff for uma as what he needs to integrate to his branch',
    'fix the bug where we close the session twice',
    'When done, add a Codex reviewer and mark this complete.'
  ])('delivers a user request without next-step instructions: %s', async (text) => {
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text }]
    }
    expect(await performSend(context(), sendInput(body))).toMatchObject({ ok: true })
    expect(atDispatch[0]?.sourcePrompt).toBe(text)
    const delivered = dispatch.mock.calls[0]?.[0].body.blocks
    expect(delivered).toEqual([{ type: 'text', text: prependHubTaskPrompt(text, 'btk_1234') }])
    const deliveredText = delivered?.[0]?.type === 'text' ? delivered[0].text : ''
    expect(deliveredText).not.toContain('omni-outcome-source-v1')
    expect(deliveredText).not.toContain('outcome context')
  })

  it('points a chat-view wait request at outcome context and journals only the typed words', async () => {
    const text = 'Wait for Uma to approve on Slack, then close this session'
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text }]
    }
    expect(await performSend(context(), sendInput(body))).toMatchObject({ ok: true })
    expect(atDispatch[0]?.sourcePrompt).toBe(text)
    const delivered = dispatch.mock.calls[0]?.[0].body.blocks[0]
    const deliveredText = delivered?.type === 'text' ? delivered.text : ''
    expect(deliveredText).toContain(text)
    expect(deliveredText).toContain('outcome context --json')
  })

  it('journals exact original user text before hub guidance and keeps it through provider echoes', async () => {
    const first = '  Review the draft.\nKeep the line breaks.  '
    const last = '\tSend the result to Gamma and mark this session saved.\n'
    const sourcePrompt = `${first}\n\n${last}`
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: first },
        { type: 'image-ref', path: '/draft.png', alt: 'Image description is not user text' },
        { type: 'text', text: '' },
        { type: 'tool-result', output: 'Tool output is not user text' },
        { type: 'text', text: last }
      ]
    }
    const input = sendInput(body)

    expect(await performSend(context(), input)).toMatchObject({ ok: true })

    expect(atDispatch).toMatchObject([
      { clientMessageId: input.clientMessageId, dispatchState: 'pending', sourcePrompt }
    ])
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          ...body,
          blocks: [
            {
              type: 'text',
              text: expect.stringContaining(prependHubTaskPrompt(first, 'btk_1234'))
            },
            ...body.blocks.slice(1)
          ]
        }
      })
    )
    expect(body.blocks[0]).toEqual({ type: 'text', text: first })

    const echo: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Provider replaced the rendered user message' }]
    }
    await journal.appendItem(providerIdentity, echo, { fence: 1 })
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([echo])
    expect(journal.submissions()[0]).toMatchObject({ dispatchState: 'accepted', sourcePrompt })

    await reopen()
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([echo])
    expect(journal.submissions()[0]).toMatchObject({ dispatchState: 'accepted', sourcePrompt })
  })

  it.each(['assistant', 'tool', 'reasoning', 'system'] as const)(
    'records no user source prompt for a %s submission',
    async (role) => {
      const body: AgentJournalMessageItem = {
        kind: 'message',
        role,
        blocks: [{ type: 'text', text: 'Send the result to Gamma and save this session' }]
      }

      expect(await performSend(context(), sendInput(body))).toMatchObject({ ok: true })

      expect(atDispatch).toMatchObject([{ dispatchState: 'pending', sourcePrompt: null }])
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ body }))
      await reopen()
      expect(journal.submissions()[0]?.sourcePrompt).toBeNull()
    }
  )

  it('captures an empty user source when only an image precedes injected guidance', async () => {
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'image-ref', path: '/draft.png', alt: 'Send this to Gamma' }]
    }

    expect(await performSend(context(), sendInput(body))).toMatchObject({ ok: true })

    expect(atDispatch).toMatchObject([{ dispatchState: 'pending', sourcePrompt: '' }])
    expect(dispatch.mock.calls[0]?.[0].body.blocks[0]).toEqual({
      type: 'text',
      text: prependHubTaskPrompt('', 'btk_1234').trimEnd()
    })
  })

  it.each([
    { state: 'accepted' as const, retryUnknown: false, calls: 0 },
    { state: 'unknown' as const, retryUnknown: false, calls: 0 },
    { state: 'unknown' as const, retryUnknown: true, calls: 1 }
  ])(
    'keeps legacy source absent for $state delivery with retryUnknown=$retryUnknown',
    async ({ state, retryUnknown, calls }) => {
      const text = 'Send the legacy result to Gamma and save this session'
      const input = sendInput({
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text }]
      })
      await journal.appendSubmission({
        ...input,
        body: {
          ...input.body,
          blocks: [{ type: 'text', text: prependHubTaskPrompt(text, 'btk_1234') }]
        },
        fence: 1
      })
      await journal.resolveDispatch(
        state === 'accepted'
          ? { clientMessageId: input.clientMessageId, state, providerIdentity, fence: 1 }
          : { clientMessageId: input.clientMessageId, state, reason: 'reply lost', fence: 1 }
      )
      await reopen()
      expect(journal.submissions()[0]?.sourcePrompt).toBeUndefined()

      const result = await performSend(context(), {
        ...input,
        ...(retryUnknown ? { retryUnknown: true as const } : {})
      })

      expect(result).toMatchObject({ ok: true })
      expect(dispatch).toHaveBeenCalledTimes(calls)
      if (retryUnknown) {
        expect(atDispatch[0]?.sourcePrompt).toBeUndefined()
      }
      expect(journal.submissions()[0]?.sourcePrompt).toBeUndefined()
      await reopen()
      expect(journal.submissions()[0]?.sourcePrompt).toBeUndefined()
    }
  )

  it('drops source authority on an intentional epoch replacement even when user text is recovered', async () => {
    const text = 'Send the result to Gamma and save this session'
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text }]
    }
    expect(await performSend(context(), sendInput(body))).toMatchObject({ ok: true })
    expect(journal.submissions()[0]?.sourcePrompt).toBe(text)
    const previousEpoch = journal.epoch

    await journal.replaceEpochItems('unreconcilable_prefix', 2, [
      { identity: providerIdentity, body }
    ])

    expect(journal.epoch).not.toBe(previousEpoch)
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([body])
    expect(journal.submissions()).toEqual([])
    await reopen()
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([body])
    expect(journal.submissions()).toEqual([])
  })
})
