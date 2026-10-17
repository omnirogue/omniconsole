import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  adoptTestConversation,
  testHostProcess,
  testHostRoot,
  type TestHostRoot
} from '../session-host/session-host-test-fixture'
import { setRuntimeSessionHostProcessForTests } from '../session-host/session-host-runtime'
import { restartSession } from '../session-manage/session-manage-control'
import { manageEntry, sidebarRow } from '../session-manage/session-manage-test-fixtures'
import { relocatedAwayRefusal } from './session-host-relocated-away'

let root: TestHostRoot
beforeEach(() => {
  root = testHostRoot()
})
afterEach(() => {
  setRuntimeSessionHostProcessForTests(null)
  root.dispose()
})

async function relinquished(sessionId: string) {
  const process = testHostProcess({ root: root.root, incarnation: 'runtime-1' })
  setRuntimeSessionHostProcessForTests(process)
  const service = await process.service()
  const { conversationId } = await adoptTestConversation(service, sessionId)
  await service.store.mutate(async (journal) => {
    journal.conversations[conversationId]!.owned = false
    return { value: null, changed: true }
  })
  return service
}

describe('a conversation moved to another computer is not started here again', () => {
  it('refuses its provider identity, and not another one', async () => {
    await relinquished('claude-moved')
    expect(relocatedAwayRefusal({ agent: 'claude', sessionId: 'claude-moved' })).toMatch(
      /moved to another computer and runs there now/
    )
    expect(relocatedAwayRefusal({ agent: 'claude', sessionId: 'claude-other' })).toBeNull()
  })

  it('once relocated back (an owned registration again), it may run here again', async () => {
    const service = await relinquished('claude-moved')
    await adoptTestConversation(service, 'claude-moved')
    expect(relocatedAwayRefusal({ agent: 'claude', sessionId: 'claude-moved' })).toBeNull()
  })

  it('session restart refuses to resume its old exited pane', async () => {
    await relinquished('claude-moved')
    const row = sidebarRow({ resumable: true, providerSessionId: 'claude-moved' })
    await expect(
      restartSession(
        {
          interrupt: async () => {},
          stopKeepGoing: () => false,
          lastOutputAt: async () => null,
          stillWorking: async () => false,
          resume: async () => ({ summary: 'Resumed.', tabId: 'tab-2' }),
          rename: async () => {
            throw new Error('not used')
          },
          sleep: async () => {},
          now: () => 0
        },
        {
          actor: { kind: 'cli' },
          target: {
            entry: manageEntry({ verdict: 'exited', state: 'exited' }),
            row,
            source: null,
            agentProcess: null
          },
          dryRun: true
        }
      )
    ).rejects.toThrow(/moved to another computer/)
  })
})
