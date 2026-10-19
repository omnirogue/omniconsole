import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationSource } from '../../shared/conversation-source'
import type { PromptQueueEntry } from '../../shared/prompt-queue-types'
import type { DeliverableVerifierService } from '../deliverable-verifier/deliverable-verifier-service'
import { setDeliverableVerifier } from '../deliverable-verifier/deliverable-verifier-slot'
import type { OrcaRuntimeService } from './omni-runtime'
import { assertPromptQueueEntryDelivery } from './prompt-queue-entry-guard'

vi.mock('./conversation-chain-ownership', () => ({ isChainBoundToConversation: () => false }))
vi.mock('./conversation-capacity-recovery-delivery', () => ({
  assertCapacityRecoveryDelivery: () => undefined
}))

const source: ConversationSource = { worktreeId: 'wt', paneKey: 'pane', kind: 'pty' }
const entry: PromptQueueEntry = {
  id: 'deliverable-repair:r:1',
  text: '[from Deliverable check 1/2 · dv-abcd1234] …',
  createdAt: 1,
  state: 'sending',
  automation: { kind: 'deliverable-repair', verificationId: 'v', attempt: 1 }
}
const runtime = {
  readPromptQueue: () => ({ source, entries: [entry] })
} as unknown as OrcaRuntimeService

describe('assertPromptQueueEntryDelivery for a deliverable check repair', () => {
  afterEach(() => setDeliverableVerifier(null))

  it('refuses when the check is not running on this host', () => {
    expect(() => assertPromptQueueEntryDelivery(runtime, 'row', source, entry)).toThrow(
      /deliverable check is not running/
    )
  })

  it("defers to the check's own re-read", () => {
    const assertDelivery = vi.fn()
    setDeliverableVerifier({ assertDelivery } as unknown as DeliverableVerifierService)
    assertPromptQueueEntryDelivery(runtime, 'row', source, entry)
    expect(assertDelivery).toHaveBeenCalledWith(source, entry)
    assertDelivery.mockImplementation(() => {
      throw new Error('no')
    })
    expect(() => assertPromptQueueEntryDelivery(runtime, 'row', source, entry)).toThrow('no')
  })

  it('leaves the person’s own prompts alone', () => {
    const { automation: _automation, ...person } = entry
    expect(() => assertPromptQueueEntryDelivery(runtime, 'row', source, person)).not.toThrow()
  })
})
