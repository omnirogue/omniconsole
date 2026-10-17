/**
 * The order the person saw, kept through every later commit — and the references that go with it.
 *
 * Up next is edited one block at a time, so what matters is not the first commit but the third:
 * a stage anchored between two queued ones must still run there after the next append, two stages
 * composed in one commit must lower in the order they were shown, and a stage that reads an
 * earlier one must name the step the chain really kept. All of it read back through the real
 * lowering and the real projection, as the panel reads them.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

const readiness = vi.hoisted(() => ({ ready: true }))
vi.mock('../../conversation-readiness', () => ({
  observeConversationReadiness: async () => ({
    ready: readiness.ready,
    // `free` is the reading the Now row and the queue drain use; a stub that only knows
    // whether a turn finished answers both the same way (`conversation-readiness.ts`).
    free: readiness.ready,
    unverifiable: false
  })
}))

vi.mock('../../conversation-delivery', () => ({
  deliverToConversation: async (): Promise<{ door: 'pty'; deliveredAt: number }> => ({
    door: 'pty',
    deliveredAt: 99
  })
}))

import {
  isSessionChainAgentStep,
  type SessionChainAgentStep
} from '../../../../shared/session-chain-types'
import {
  UP_NEXT_RPC,
  type UpNextAgentBlock,
  type UpNextView
} from '../../../../shared/up-next-types'
import { conversationId, harness, type UpNextHarness } from './up-next-harness'

const list = async (host: UpNextHarness): Promise<UpNextView> =>
  (await host.call(UP_NEXT_RPC.list, { conversationId })).view

const append = (
  host: UpNextHarness,
  draft: unknown,
  over: Record<string, unknown> = {}
): Promise<{ view: UpNextView }> =>
  host.call(UP_NEXT_RPC.append, { conversationId, draft, ...over })

const commit = (host: UpNextHarness): Promise<{ view: UpNextView }> =>
  host.call(UP_NEXT_RPC.commit, { conversationId })

const stage = (over: Record<string, unknown> = {}): unknown => ({
  kind: 'agent',
  template: 'improve',
  instruction: 'Improve the receipt signing.',
  ...over
})

const agentSteps = (host: UpNextHarness): SessionChainAgentStep[] =>
  host.chains()[0]?.steps.filter(isSessionChainAgentStep) ?? []

const stageBlocks = (view: UpNextView): UpNextAgentBlock[] =>
  view.blocks.filter((block): block is UpNextAgentBlock => block.kind === 'agent')

const typed = (block: UpNextAgentBlock): string => block.instruction.split('\n')[0]!.trim()

/** The step one stage compiled to, found by the words the person typed. */
const byInstruction = (host: UpNextHarness, text: string): string =>
  agentSteps(host).find((step) => step.prompt.startsWith(text))!.id

/** What the barrier will run, in the order it will run it. */
const stepOrder = (host: UpNextHarness): (string | undefined)[] =>
  (host.commits.at(-1)!.outcomes[0]!.stepIds ?? []).map(
    (id) =>
      agentSteps(host)
        .find((step) => step.id === id)
        ?.prompt.split('\n')[0]
  )

describe('the order a commit leaves behind', () => {
  it('keeps a mid-chain insertion where it was shown through the NEXT commit', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'A.' }))
    await append(host, stage({ instruction: 'B.' }))
    await commit(host)
    const [first] = stageBlocks(await list(host))

    await append(host, stage({ instruction: 'C.' }), { insertAfterBlockId: first!.id })
    await commit(host)
    expect(stepOrder(host)).toEqual(['A.', 'C.', 'B.'])

    // One more ordinary append. The plan is re-read from the chain for it, and a read that
    // rebuilt the order from the step array would put C last again.
    await append(host, stage({ instruction: 'D.' }))
    const view = (await commit(host)).view

    expect(stageBlocks(view).map(typed)).toEqual(['A.', 'C.', 'B.', 'D.'])
    expect(stepOrder(host)).toEqual(['A.', 'C.', 'B.', 'D.'])
  })

  it('lowers two stages composed after the same queued stage in the order shown', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'A.' }))
    await append(host, stage({ instruction: 'B.' }))
    await commit(host)
    const [first] = stageBlocks(await list(host))

    // Both composed "after A", as pressing "configure a stage after this" on A twice does.
    await append(host, stage({ instruction: 'C.' }), { insertAfterBlockId: first!.id })
    await append(host, stage({ instruction: 'D.' }), { insertAfterBlockId: first!.id })
    const composed = await list(host)
    expect(stageBlocks(composed).map(typed)).toEqual(['A.', 'C.', 'D.', 'B.'])

    const view = (await commit(host)).view

    expect(stageBlocks(view).map(typed)).toEqual(['A.', 'C.', 'D.', 'B.'])
    expect(stepOrder(host)).toEqual(['A.', 'C.', 'D.', 'B.'])
    // D was put after C, so it reads what C produced.
    expect(agentSteps(host).find((step) => step.prompt.startsWith('D.'))!.readsFrom).toEqual([
      byInstruction(host, 'C.')
    ])
  })
})

describe('what a stage reads, after the chain has been added to twice', () => {
  it('names the step the chain kept, on the third commit', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'A.' }))
    await commit(host)
    await append(host, stage({ instruction: 'B.' }))
    await commit(host)
    await append(host, stage({ instruction: 'C.' }))
    await commit(host)

    const ids = new Set(host.chains()[0]!.steps.map((step) => step.id))
    const third = agentSteps(host).find((step) => step.prompt.startsWith('C.'))!
    expect(third.readsFrom).toEqual([byInstruction(host, 'B.')])
    for (const step of agentSteps(host)) {
      for (const read of step.readsFrom ?? []) {
        expect(ids).toContain(read)
      }
    }
    // The Outcome names every step of the chain, and nothing else.
    expect([...(host.commits.at(-1)!.outcomes[0]!.stepIds ?? [])].toSorted()).toEqual(
      [...ids].toSorted()
    )
  })

  it('reads the committed Review the chain kept, not the copy the commit dropped', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await commit(host)
    await append(host, stage({ template: 'review', instruction: 'Say whether it holds up.' }))
    await commit(host)
    const review = agentSteps(host).find((step) => step.presetId === 'review')!

    // Appending a reader makes the compiler re-mint the Review (its verdict changed), and an
    // append drops that copy because the chain already carries the stage. What the reader names
    // has to be the stage that really exists.
    await append(host, stage({ instruction: 'Fix what it found.' }))
    await commit(host)

    const fix = agentSteps(host).find((step) => step.prompt.startsWith('Fix what it found.'))!
    expect(fix.readsFrom).toEqual([review.id])
    expect(agentSteps(host).map((step) => step.id)).toContain(review.id)
  })

  // The carried Review does not GAIN the verdict contract, and nothing on the commit path can give
  // it one: `reconcileSessionOutcomeSteps` (session-outcome-revision.ts:146-152) answers any change
  // outside a step's signature with the stored step verbatim, and `verdict` is outside it. Named
  // here rather than asserted, so the gap is visible instead of passing as correct.
  it.todo('gives a committed Review the verdict contract when its reader is appended later')
})
