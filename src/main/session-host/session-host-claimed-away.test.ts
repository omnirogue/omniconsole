import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { relocatedAwayIn } from '../session-host-owner/session-host-relocated-journal'
import { yieldSessionHostConversationToClaim } from './session-host-claimed-away'
import {
  adoptTestConversation,
  testHostProcess,
  testHostRoot,
  type TestHostRoot
} from './session-host-test-fixture'

let root: TestHostRoot
beforeEach(() => {
  root = testHostRoot()
})
afterEach(() => root.dispose())

const host = (incarnation: string) => testHostProcess({ root: root.root, incarnation }).service()

describe('a conversation another computer woke from its review copy', () => {
  it('is given up for good, once per claim, so nothing here runs it again', async () => {
    const service = await host('runtime-1')
    const conversation = await adoptTestConversation(service)
    const input = {
      provider: conversation.provider,
      toHostId: 'host_studio',
      claimId: 'plan:9',
      digest: 'a'.repeat(64)
    }
    expect(await yieldSessionHostConversationToClaim(service.store, input)).toEqual({
      status: 'ok'
    })
    expect(await yieldSessionHostConversationToClaim(service.store, input)).toEqual({
      status: 'ok'
    })
    const journal = service.store.snapshot()!
    expect(relocatedAwayIn(journal, conversation.provider)).toEqual({ toHostId: 'host_studio' })
    expect(journal.conversations[conversation.conversationId]).toMatchObject({
      owned: false,
      relinquishment: { grantId: 'wake-claim:plan:9' }
    })
  })

  it('records the hand-over even for a conversation this registry never saw', async () => {
    const service = await host('runtime-1')
    const provider = { agent: 'codex', sessionId: 'never-registered' }
    await yieldSessionHostConversationToClaim(service.store, {
      provider,
      toHostId: 'host_studio',
      claimId: 'plan:9',
      digest: ''
    })
    expect(relocatedAwayIn(service.store.snapshot(), provider)).not.toBeNull()
  })

  it('refuses while another live process of this account runs it', async () => {
    const first = await host('runtime-1')
    const conversation = await adoptTestConversation(first)
    const second = await host('runtime-2')
    expect(
      await yieldSessionHostConversationToClaim(second.store, {
        provider: conversation.provider,
        toHostId: 'host_studio',
        claimId: 'plan:9',
        digest: ''
      })
    ).toMatchObject({ status: 'refused' })
  })
})
