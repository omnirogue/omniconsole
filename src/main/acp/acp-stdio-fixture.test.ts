import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AcpStructuredSessionAdapter } from './acp-structured-session-adapter'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'

describe('ACP over a real stdio child', () => {
  it.each([false, true])(
    'completes a permission round trip (Bypass=%s) and resumes the journal identity',
    async (bypass) => {
      let onApproval = (): void => undefined
      let onCompleted = (): void => undefined
      const approval = new Promise<void>((resolve) => {
        onApproval = resolve
      })
      const completed = new Promise<void>((resolve) => {
        onCompleted = resolve
      })
      const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
      const adapter = new AcpStructuredSessionAdapter({
        resolveLaunch: async () => ({
          command: process.execPath,
          args: [fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url))],
          cwd: process.cwd()
        }),
        readProcessStartTime: async () => Date.now()
      })
      const input = {
        identity: {
          sessionId: 'omni-fixture-session',
          workspaceId: 'fixture-folder',
          hostId: 'local',
          agent: 'omp',
          providerHandle: { kind: 'opaque' as const, agent: 'omp', value: 'pending' }
        },
        fence: 1,
        spawnToken: 'fixture-token',
        options: { chatPermissionMode: bypass ? 'bypass' : 'ask' },
        events: {
          appendItem: (identity: AgentJournalItemIdentity, body: AgentJournalItemBody) => {
            items.push({ identity, body })
            if (body.kind === 'approval') {
              onApproval()
            }
            if (body.kind === 'status' && body.turnLifecycle?.state === 'completed') {
              onCompleted()
            }
          },
          appendTombstone: () => undefined,
          publish: () => undefined
        }
      }
      try {
        const acquisition = await adapter.acquire(input)
        expect(acquisition.link.handle).toEqual({
          provider: 'omp',
          sessionId: 'fixture-acp-session'
        })
        const sent = await adapter.dispatch({
          sessionId: input.identity.sessionId,
          fence: 1,
          clientMessageId: 'fixture-message',
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Run fixture tool' }]
          }
        })
        expect(sent.state).toBe('accepted')
        if (!bypass) {
          await approval
          const card = items.find(({ body }) => body.kind === 'approval')!
          await adapter.answerPrompt({
            sessionId: input.identity.sessionId,
            fence: 1,
            kind: 'approval',
            itemId: agentJournalItemKey(card.identity),
            optionId: 'yes'
          })
        }
        await completed
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(items.some(({ body }) => body.kind === 'approval')).toBe(!bypass)
        expect(items.findLast(({ body }) => body.kind === 'message')?.body).toMatchObject({
          blocks: [{ type: 'text', text: 'Fixture complete 🦋' }]
        })
        expect(items.filter(({ body }) => body.kind === 'tool-call')).toHaveLength(2)
        expect(items.findLast(({ body }) => body.kind === 'tool-call')?.body).toMatchObject({
          name: 'Fixture tool',
          input: { fixture: true },
          state: 'completed'
        })
        await adapter.setOption({
          sessionId: input.identity.sessionId,
          fence: 1,
          key: 'model',
          value: 'fixture-2'
        })
        expect(
          (await adapter.readOptions({ sessionId: input.identity.sessionId, fence: 1 })).current
            .model
        ).toBe('fixture-2')
        expect(await adapter.closeSession(input.identity.sessionId)).toBe(true)
        const resumed = await adapter.acquire({
          ...input,
          fence: 2,
          identity: {
            ...input.identity,
            providerHandle: { ...input.identity.providerHandle, value: 'fixture-acp-session' }
          }
        })
        expect(resumed.link.origin).toBe('resumed')
        expect(resumed.link.handle).toEqual(acquisition.link.handle)
      } finally {
        expect(await adapter.closeSession(input.identity.sessionId)).toBe(true)
      }
    }
  )
})
