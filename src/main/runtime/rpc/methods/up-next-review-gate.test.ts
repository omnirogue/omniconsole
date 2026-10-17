/**
 * What opens the work held behind a person Review (owner's rulings A and G): only an OK from EVERY
 * named reviewer of the current version. "1 of 2 said OK" keeps it paused, "needs changes" keeps it
 * paused, and a release the engine refuses is recorded on the run and asked again — never
 * committed twice.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))
vi.mock('../../conversation-readiness', () => ({
  observeConversationReadiness: async () => ({ ready: true, free: true, unverifiable: false })
}))

import { isSessionChainAgentStep, type SessionChain } from '../../../../shared/session-chain-types'
import { auditSessionRuns } from '../../../../shared/session-run-audit'
import { sealSessionRunCompletion } from '../../../../shared/session-run-completion'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  UP_NEXT_REFUSAL_KEYS,
  UP_NEXT_RPC,
  type UpNextPersonBlock,
  type UpNextView
} from '../../../../shared/up-next-types'
import { upNextHeldContinuation } from '../../up-next-held-gates'
import { conversationId, harness, type UpNextHarness } from './up-next-harness'

const append = (host: UpNextHarness, draft: unknown): Promise<{ view: UpNextView }> =>
  host.call(UP_NEXT_RPC.append, { conversationId, draft })

const list = async (host: UpNextHarness): Promise<UpNextView> =>
  (await host.call(UP_NEXT_RPC.list, { conversationId })).view

const improve = { kind: 'agent', template: 'improve', instruction: 'Fix what they found.' }

/** Review by `people`, then an Improve held behind it: the shape the rulings are about. */
async function reviewThenImprove(
  host: UpNextHarness,
  people: { id: string; name: string }[]
): Promise<void> {
  await append(host, { kind: 'person', relationship: 'review', people })
  await append(host, improve)
  const queued = (await host.call(UP_NEXT_RPC.commit, { conversationId })).view
  expect(queued.blocks.map((block) => block.kind)).toEqual(['person', 'agent'])
  expect(queued.blocks[1]!.state).toBe('waiting')
  expect(host.commits).toHaveLength(1)
}

const person = (view: UpNextView): UpNextPersonBlock =>
  view.blocks.find((block): block is UpNextPersonBlock => block.kind === 'person')!

describe('work held behind a person review', () => {
  it('stays paused while 1 of 2 said OK, and is released in the same run when both did', async () => {
    const host = harness()
    await reviewThenImprove(host, [
      { id: 'emp_1', name: 'Jordan Taylor' },
      { id: 'emp_2', name: 'Iris Allen' }
    ])

    host.reply('emp_1', 'approve')
    await host.resume()
    expect(host.commits).toHaveLength(1)
    expect(person(await list(host)).waiting).toMatchObject({
      replied: 1,
      approved: 1,
      total: 2,
      answers: [{ employeeId: 'emp_1', name: 'Jordan Taylor', decision: 'approve' }]
    })

    host.reply('emp_2', 'approve')
    await host.resume()
    expect(host.commits).toHaveLength(2)
    // Appended to the run whose review released it: one chain, no new generation.
    expect(host.chains().map((chain) => chain.id)).toEqual([host.chains()[0]!.id])
    expect(host.commits[1]!.supersede).toBeUndefined()
    expect(host.drafts()).toBeNull()
  })

  it('stays paused when the reviewer asked for changes, however often the host asks', async () => {
    const host = harness()
    await reviewThenImprove(host, [{ id: 'emp_1', name: 'Jordan Taylor' }])

    host.reply('emp_1', 'request_changes')
    await host.resume()
    await host.resume()
    expect(host.commits).toHaveLength(1)
    expect(host.drafts()?.entries.map((entry) => Boolean(entry.held))).toEqual([true])
    const view = await list(host)
    expect(person(view).state).not.toBe('done')
    expect(person(view).waiting).toMatchObject({ replied: 1, approved: 0, total: 1 })
    expect(view.blocks.find((block) => block.kind === 'agent')!.state).toBe('waiting')
  })

  it('records a refused release on the run and commits it once, when the refusal is gone', async () => {
    const seed: { agent: TuiAgent | null } = { agent: null }
    const host = harness({}, seed)
    await reviewThenImprove(host, [{ id: 'emp_1', name: 'Jordan Taylor' }])
    const held = () =>
      upNextHeldContinuation(host.ctx.runtime as never, host.chains()[0]!, host.chains())

    host.reply('emp_1', 'approve')
    // Every pass asks again; no pass commits anything while the engine refuses.
    await host.resume()
    await host.resume()
    expect(host.commits).toHaveLength(1)
    expect(held()).toMatchObject({ refused: UP_NEXT_REFUSAL_KEYS.needsAgent })
    expect(host.drafts()?.entries.map((entry) => Boolean(entry.held))).toEqual([true])

    seed.agent = 'claude'
    await host.resume()
    await host.resume()
    expect(host.commits).toHaveLength(2)
    expect(host.drafts()).toBeNull()
    expect(held()).toBeNull()
  })

  it('releases onto the agent its run last ran when the idle conversation names none', async () => {
    const seed: { agent: TuiAgent | null } = { agent: 'codex' }
    const host = harness({}, seed)
    await append(host, { kind: 'agent', template: 'improve', instruction: 'Draft the intro.' })
    await append(host, {
      kind: 'person',
      relationship: 'review',
      people: [{ id: 'emp_1', name: 'Jordan Taylor' }]
    })
    await append(host, improve)
    await host.call(UP_NEXT_RPC.commit, { conversationId })
    const drafted = host.chains()[0]!.steps.filter(isSessionChainAgentStep)
    expect(drafted.map((step) => step.agent)).toEqual(['codex'])
    host.finishStage(drafted[0]!.id)

    // The pane went idle: started from a shell, it has no launch agent and no foreground one.
    seed.agent = null
    host.reply('emp_1', 'approve')
    await host.resume()
    expect(host.commits).toHaveLength(2)
    expect(host.drafts()).toBeNull()
    const steps = host.chains()[0]!.steps.filter(isSessionChainAgentStep)
    expect(steps).toHaveLength(2)
    expect(steps.every((step) => step.agent === 'codex')).toBe(true)
  })

  it('lists work an older build sealed behind a review, and releases it as new work, seal untouched', async () => {
    const host = harness()
    await reviewThenImprove(host, [{ id: 'emp_1', name: 'Jordan Taylor' }])
    host.reply('emp_1', 'request_changes')
    // What a build that sealed on the last reply wrote, whatever that reply said.
    const chain = host.chains()[0]!
    host.service.save({
      ...chain,
      state: 'done',
      outcomeSet: sealSessionRunCompletion(chain.outcomeSet!, { now: 50, operationId: 'op_seal' })
    })
    const sealed = structuredClone(host.chains()[0]!)
    const held = (entry: SessionChain) =>
      upNextHeldContinuation(host.ctx.runtime as never, entry, host.chains())
    expect(auditSessionRuns(host.chains(), 60, held)).toMatchObject([
      { findings: ['sealed-with-held-continuation'], repair: 'release-continuation' }
    ])

    // The commit door forks a sealed run (`forkFinishedOutcomeSource`); here it records the ask.
    host.service.commit.mockImplementationOnce(async (_raw, input) => {
      host.commits.push(input)
      return { ...sealed, id: 'source_fork' } as never
    })
    await host.resume()
    expect(host.commits).toHaveLength(2)
    expect(host.commits[1]!.expectedRevision).toBe(sealed.outcomeSet!.revision)
    expect(host.commits[1]!.supersede).toBeUndefined()
    expect(host.chains()[0]).toEqual(sealed)
    expect(host.drafts()).toBeNull()
    expect(auditSessionRuns(host.chains(), 70, held)).toEqual([])
  })
})
