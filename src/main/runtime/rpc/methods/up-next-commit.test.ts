/**
 * What a commit really does to the plan underneath — the cases a normal person hits.
 *
 * Queueing is ADDITIVE: a second `+ Agent` lands behind the stage that is already queued or
 * running instead of superseding it, work composed behind a review that has not come back
 * waits for those people instead of being refused, a stage anchored mid-chain runs where it
 * was shown, and Advanced (model, Council, rounds, reads-from, end-on-success) reaches the
 * chain rather than being dropped at lowering. Every assertion is about what the real
 * `commitWorkPlan` lowering compiled, read back through the same projection the panel shows.
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

import { buildSessionVerdictInstructions } from '../../../../shared/session-chain-verdict-prompt'
import {
  isSessionChainAgentStep,
  type SessionChain,
  type SessionChainAgentStep
} from '../../../../shared/session-chain-types'
import type { SessionOutcomeAttempt } from '../../../../shared/session-outcome-types'
import {
  UP_NEXT_REFUSAL_KEYS,
  UP_NEXT_RPC,
  type UpNextAgentBlock,
  type UpNextBlock,
  type UpNextView
} from '../../../../shared/up-next-types'
import { upNextCommitDrafts } from '../../up-next-commit'
import { upNextView } from '../../up-next'
import { conversationId, harness, rowKey, type UpNextHarness } from './up-next-harness'

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

/**
 * The line the person typed. A committed stage's instruction carries the brief the lowering
 * adds to it (the Outcome, the Done When, where to write the result), so the row is read back
 * by its first line — which is what the panel shows as the row's own words.
 */
const typed = (block: UpNextAgentBlock): string => block.instruction.split('\n')[0]!.trim()

/** The same reading for any block, so a held row can be named by the words on it. */
const typed2 = (block: UpNextBlock): string =>
  block.kind === 'agent' ? typed(block) : (block.number ?? '')

/** The attempt the host writes when a seat is launched and still working. */
const running = (stepId: string): SessionOutcomeAttempt => ({
  id: 'a1',
  outcomeId: 'o1',
  actionId: `step_${stepId}`,
  actionKey: 'k',
  outcomeRevision: 1,
  state: 'running',
  startedAt: 1_000,
  updatedAt: 2_000
})

/** That seat is working now, as the tick would have recorded it. */
function startStage(host: UpNextHarness, stepId: string): void {
  const chain = host.chains()[0]!
  host.service.save({
    ...chain,
    outcomeSet: { ...chain.outcomeSet!, attempts: [running(stepId)] },
    steps: chain.steps.map((step) =>
      step.id === stepId && step.kind !== 'handoff' ? { ...step, status: 'launched' } : step
    )
  })
}

/** The host's own reading of where the people can read this conversation. */
const TRANSCRIPT = {
  kind: 'provider' as const,
  hostId: 'local',
  agent: 'claude',
  sessionId: 'sess_1',
  transcriptPath: '/w/.claude/sess_1.jsonl'
}

/** A model catalogue the host really probed: two launchable families, so a judge is possible. */
const PROBED: Record<string, unknown> = {
  claude: {
    success: true,
    catalogOrigin: 'probe',
    defaultModelId: 'opus-4',
    models: [{ id: 'opus-4', label: 'Opus 4', isDefault: true }]
  },
  codex: {
    success: true,
    catalogOrigin: 'probe',
    defaultModelId: 'gpt-5-codex',
    models: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex', isDefault: true }]
  }
}

function withHostCatalogue(host: UpNextHarness): UpNextHarness {
  Object.assign(host.ctx.runtime as object, {
    getSessionOutcomeTranscriptSource: () => TRANSCRIPT,
    discoverRuntimeCommitMessageModels: async (_selector: string, agent: string) =>
      PROBED[agent] ?? { success: false, catalogOrigin: 'spec', models: [] }
  })
  return host
}

describe('queueing behind work that is already there', () => {
  it('lands a second Agent behind the first, which keeps its place and its state', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await commit(host)
    await append(host, stage({ instruction: 'Then check the ledger.' }))
    const view = (await commit(host)).view

    // Both stages are the person's work: A did not make room for B.
    expect(stageBlocks(view).map((block) => [typed(block), block.state])).toEqual([
      ['Sign the receipts.', 'queued'],
      ['Then check the ledger.', 'queued']
    ])
    expect(agentSteps(host).map((step) => step.status)).toEqual(['queued', 'queued'])
    expect(agentSteps(host).some((step) => step.supersededBy)).toBe(false)
    // Adding work is not a new strategy, so the plan version does not move and the second
    // commit says nothing about superseding anything.
    expect(host.commits[1]!.supersede).toBeUndefined()
    expect(host.chains()[0]!.planVersion).toBe(1)
    // The Outcome names its steps in the order they run; the barrier reads exactly that.
    expect(host.commits[1]!.outcomes[0]!.stepIds).toEqual(agentSteps(host).map((step) => step.id))
  })

  it('lands a second Agent behind one that is RUNNING instead of refusing the queue', async () => {
    readiness.ready = false
    const host = harness()
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await commit(host)
    const first = agentSteps(host)[0]!
    startStage(host, first.id)

    await append(host, stage({ instruction: 'Then check the ledger.' }))
    const view = (await commit(host)).view

    expect(host.commits).toHaveLength(2)
    expect(stageBlocks(view).map((block) => [typed(block), block.state, block.locked])).toEqual([
      ['Sign the receipts.', 'running', true],
      ['Then check the ledger.', 'queued', false]
    ])
    // The running seat was not touched: same identity, same status, same attempt.
    expect(agentSteps(host).find((step) => step.id === first.id)).toMatchObject({
      status: 'launched'
    })
    expect(host.chains()[0]!.outcomeSet!.attempts.map((attempt) => attempt.state)).toEqual([
      'running'
    ])
  })

  it('never queues the same stage twice when the person commits again', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await commit(host)
    await append(host, stage({ instruction: 'Then check the ledger.' }))
    await commit(host)
    await append(host, stage({ instruction: 'And file it.' }))
    await commit(host)

    expect(agentSteps(host).map((step) => step.planNodeId)).toHaveLength(3)
    expect(new Set(agentSteps(host).map((step) => step.id)).size).toBe(3)
    expect(stageBlocks(await list(host)).map(typed)).toEqual([
      'Sign the receipts.',
      'Then check the ledger.',
      'And file it.'
    ])
  })
})

describe('queueing behind a committed review', () => {
  const reviewer = {
    kind: 'person' as const,
    relationship: 'review' as const,
    people: [{ id: 'emp_1', name: 'Jordan Taylor' }]
  }

  it('holds what is composed while the review is out, and commits it once it returns', async () => {
    readiness.ready = true
    const host = withHostCatalogue(harness())
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await append(host, reviewer)
    await commit(host)
    const review = (await list(host)).blocks.find((block) => block.kind === 'person')!

    // The review is out. What the person composes behind it is not refused as "nothing
    // composed" — it waits for the people who have not answered.
    await append(host, stage({ instruction: 'Fix what they found.' }))
    const held = (await commit(host)).view
    const waiting = held.blocks.find((block) => block.state === 'waiting')!
    expect(waiting.heldFor).toEqual({ kind: 'review', blockId: review.id })
    expect(host.commits).toHaveLength(1)

    // The reviewer answers; the same composition now commits straight through.
    host.finishStage(agentSteps(host)[0]!.id)
    host.reply('emp_1')
    await host.resume()
    expect(host.commits).toHaveLength(2)

    await append(host, stage({ instruction: 'And file it.' }))
    const after = (await commit(host)).view
    expect(host.commits).toHaveLength(3)
    expect(after.blocks.some((block) => block.state === 'waiting')).toBe(false)
    expect(stageBlocks(after).map(typed)).toEqual([
      'Sign the receipts.',
      'Fix what they found.',
      'And file it.'
    ])
  })

  it('holds Improve, Review 2 and Verify behind the review that is still out', async () => {
    readiness.ready = true
    const host = withHostCatalogue(harness())
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await append(host, reviewer)
    await commit(host)
    const review = (await list(host)).blocks.find((block) => block.kind === 'person')!

    // Improve → Review 2 → Verify, composed in ONE go behind a review that is still out.
    // Nothing here may be queued: the work would run before emp_1 ever saw it, and committing
    // Review 2 would replace the finish and take emp_1's own condition with it.
    await append(host, stage({ instruction: 'Fix what they found.' }))
    await append(host, {
      kind: 'person',
      relationship: 'review',
      people: [{ id: 'emp_2', name: 'Iris Allen' }]
    })
    await append(host, stage({ template: 'verify', instruction: 'Check every Done When.' }))
    const held = (await commit(host)).view

    expect(host.commits).toHaveLength(1)
    expect(
      held.blocks.filter((block) => block.state === 'waiting').map((block) => block.heldFor)
    ).toEqual([
      { kind: 'review', blockId: review.id },
      { kind: 'review', blockId: review.id },
      { kind: 'review', blockId: review.id }
    ])
    const firstAsk = host.chains()[0]!.steps.findLast((step) => step.kind === 'handoff')!.id
    expect(host.drafts()?.entries.map((entry) => entry.held?.reviewStepId)).toEqual([
      firstAsk,
      firstAsk,
      firstAsk
    ])

    // emp_1 answers. Improve and Review 2 queue now; Verify waits for emp_2 — on emp_2's own
    // ask, which is a step of its own and not the request emp_1 already answered.
    host.finishStage(agentSteps(host)[0]!.id)
    host.reply('emp_1')
    await host.resume()

    expect(host.commits).toHaveLength(2)
    const asks = host.chains()[0]!.steps.filter((step) => step.kind === 'handoff')
    expect(asks).toHaveLength(2)
    expect(asks[1]!.id).not.toBe(firstAsk)
    expect(host.drafts()?.entries.map((entry) => entry.held?.reviewStepId)).toEqual([asks[1]!.id])
    const view = await list(host)
    expect(stageBlocks(view).map(typed)).toEqual([
      'Sign the receipts.',
      'Fix what they found.',
      'Check every Done When.'
    ])
    expect(view.blocks.filter((block) => block.state === 'waiting').map(typed2)).toEqual([
      'Check every Done When.'
    ])
  })

  it('asks the SAME reviewer a second time as its own step, and gates on that ask', async () => {
    readiness.ready = true
    const host = withHostCatalogue(harness())
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await append(host, reviewer)
    await commit(host)
    const firstAsk = host.chains()[0]!.steps.findLast((step) => step.kind === 'handoff')!.id
    host.finishStage(agentSteps(host)[0]!.id)
    host.reply('emp_1')

    // The same person, asked again about the fix — a deliberate second ask, with work behind it.
    await append(host, stage({ instruction: 'Fix what they found.' }))
    await append(host, reviewer)
    await append(host, stage({ template: 'verify', instruction: 'Check every Done When.' }))
    const view = (await commit(host)).view

    const asks = host.chains()[0]!.steps.filter((step) => step.kind === 'handoff')
    expect(asks).toHaveLength(2)
    expect(asks[1]!.id).not.toBe(firstAsk)
    expect(
      asks[1]!.kind === 'handoff' && asks[1]!.handoff.recipients.map((r) => r.employeeId)
    ).toEqual(['emp_1'])
    // Verify waits on the SECOND ask, not on the answered first one.
    expect(host.drafts()?.entries.map((entry) => entry.held?.reviewStepId)).toEqual([asks[1]!.id])
    expect(view.blocks.filter((block) => block.state === 'waiting').map(typed2)).toEqual([
      'Check every Done When.'
    ])
  })

  it('still refuses a commit with nothing composed at all', async () => {
    readiness.ready = true
    const host = harness()
    await expect(commit(host)).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.noDrafts)
  })
})

describe('the anchor a stage was given', () => {
  it('runs a stage anchored between two queued stages where it was shown', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'A.' }))
    await append(host, stage({ instruction: 'B.' }))
    await commit(host)
    const [first] = stageBlocks(await list(host))

    await append(host, stage({ instruction: 'C.' }), { insertAfterBlockId: first!.id })
    const composed = await list(host)
    expect(stageBlocks(composed).map(typed)).toEqual(['A.', 'C.', 'B.'])

    const view = (await commit(host)).view

    // The compiled chain runs them in the order the panel showed, and the panel re-reads it.
    expect(stageBlocks(view).map(typed)).toEqual(['A.', 'C.', 'B.'])
    const byInstruction = (text: string): string =>
      agentSteps(host).find((step) => step.prompt.startsWith(text))!.id
    expect(host.commits.at(-1)!.outcomes[0]!.stepIds).toEqual([
      byInstruction('A.'),
      byInstruction('C.'),
      byInstruction('B.')
    ])
    // C reads what A produced, which is what "after A" means.
    expect(agentSteps(host).find((step) => step.prompt.startsWith('C.'))!.readsFrom).toEqual([
      byInstruction('A.')
    ])
  })
})

describe('Advanced reaches the chain', () => {
  it('commits a Council and an explicitly chosen model against the host catalogue', async () => {
    readiness.ready = true
    const host = withHostCatalogue(harness())
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await commit(host)

    await append(
      host,
      stage({ template: 'review', shape: 'council', n: 3, instruction: 'Review it three ways.' })
    )
    await commit(host)

    const council = agentSteps(host).filter((step) => step.stage?.shape === 'council')
    expect(council.length).toBeGreaterThan(1)
    expect(new Set(council.map((step) => step.agent)).size).toBeGreaterThan(1)
    expect(council.some((step) => step.presetId === 'judge')).toBe(true)
    // One stage, one block, whatever the shape compiled to.
    const view = await list(host)
    expect(stageBlocks(view).map((block) => [block.template, block.shape])).toEqual([
      ['improve', 'solo'],
      ['review', 'council']
    ])

    await append(
      host,
      stage({ instruction: 'And once more, on Opus.', advanced: { model: 'opus-4' } })
    )
    await commit(host)
    expect(agentSteps(host).find((step) => step.prompt.startsWith('And once more'))).toMatchObject({
      model: 'opus-4'
    })
  })

  it('queues a FIRST stage on the model the person chose, with no catalogue probed', async () => {
    readiness.ready = true
    // No council, no earlier launch, no host catalogue: the only fact about this model is that
    // the person picked it in Advanced — which is the fact the commit has to carry, or opening
    // Advanced on the first ＋ Agent and choosing a model refuses the queue outright.
    const host = harness()
    await append(
      host,
      stage({
        instruction: 'Sign the receipts.',
        advanced: { model: 'opus-4', effort: 'high' }
      })
    )
    const view = (await commit(host)).view

    expect(host.commits).toHaveLength(1)
    expect(agentSteps(host)[0]).toMatchObject({ model: 'opus-4', effort: 'high' })
    expect(stageBlocks(view).at(-1)!.advanced).toMatchObject({ model: 'opus-4', effort: 'high' })
  })

  it('carries the model of a stage appended behind one that is already queued', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await commit(host)
    await append(
      host,
      stage({ instruction: 'And once more, on Opus.', advanced: { model: 'opus-4' } })
    )
    await commit(host)

    expect(host.commits).toHaveLength(2)
    expect(agentSteps(host).find((step) => step.prompt.startsWith('And once more'))).toMatchObject({
      model: 'opus-4'
    })
  })

  it('lowers rounds, the stop rule and reads-from, and reads them back', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await commit(host)
    const [first] = stageBlocks(await list(host))

    await append(
      host,
      stage({
        template: 'review',
        instruction: 'Review the signing.',
        advanced: { rounds: 3, stopWhen: 'zero_blockers', readsFrom: [first!.id] }
      })
    )
    const view = (await commit(host)).view

    const rounds = agentSteps(host).filter((step) => step.review)
    expect(rounds.map((step) => step.review?.round)).toEqual([1, 2, 3])
    expect(rounds[0]!.review?.maxRounds).toBe(3)
    const block = stageBlocks(view).at(-1)!
    expect(block.advanced).toMatchObject({
      rounds: 3,
      stopWhen: 'zero_blockers',
      readsFrom: [first!.id]
    })
  })

  it('reads the stage composed above it in the SAME batch, by the name the person ticked', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'A.' }))
    await append(host, stage({ instruction: 'B.' }))
    await append(host, stage({ instruction: 'C.' }))
    const drafts = stageBlocks(await list(host))
    // "Earlier stages (automatic)" off, B unticked: C reads A and nothing else. A is a draft too,
    // so the only name it has is its draft id — which the commit has to resolve to the stage it
    // just queued rather than dropping it and reading the stage directly above instead.
    await host.call(UP_NEXT_RPC.update, {
      conversationId,
      blockId: drafts[2]!.id,
      patch: { kind: 'agent', advanced: { readsFrom: [drafts[0]!.id] } }
    })
    const view = (await commit(host)).view

    const step = (text: string): SessionChainAgentStep =>
      agentSteps(host).find((entry) => entry.prompt.startsWith(text))!
    expect(step('C.').readsFrom).toEqual([step('A.').id])
    expect(stageBlocks(view).at(-1)!.advanced.readsFrom).toEqual([stageBlocks(view)[0]!.id])
  })

  it('refuses a reads-from that names a block Up next no longer has', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'A.' }))
    await append(host, stage({ instruction: 'C.' }))
    const drafts = stageBlocks(await list(host))
    await host.call(UP_NEXT_RPC.update, {
      conversationId,
      blockId: drafts[1]!.id,
      patch: { kind: 'agent', advanced: { readsFrom: [drafts[0]!.id] } }
    })
    await host.call(UP_NEXT_RPC.remove, { conversationId, blockId: drafts[0]!.id })

    // Reading "the stage above" is what the DEFAULT means, so answering a named input with it
    // would show one thing in the composer and execute another.
    await expect(commit(host)).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.unknownBlock)
    expect(host.commits).toHaveLength(0)
  })

  it('refuses a stop rule the review loop cannot honour, with or without rounds', async () => {
    readiness.ready = true
    for (const advanced of [
      { rounds: 3, stopWhen: 'max_rounds' },
      { stopWhen: 'all_gaps_closed' }
    ]) {
      const host = harness()
      await append(host, stage({ template: 'review', instruction: 'Review it.', advanced }))
      await expect(commit(host)).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.stopRuleUnsupported)
      expect(host.commits).toHaveLength(0)
    }
  })

  it('ends the session on success when the person asked, and says so on the stage', async () => {
    readiness.ready = true
    const host = harness()
    await append(
      host,
      stage({
        template: 'verify',
        instruction: 'Check every Done When.',
        advanced: { endOnSuccess: true }
      })
    )
    const view = (await commit(host)).view

    // The plan finishes on completion rather than coming back to the person.
    expect(host.commits[0]!.outcomes[0]!.finish).toBe('complete')
    expect(host.chains()[0]!.end).toBe('done')
    expect(stageBlocks(view).at(-1)!.advanced.endOnSuccess).toBe(true)
  })

  it('does not close a session the Outcome still needs the person for', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await commit(host)

    // This Outcome is done when the PERSON has reviewed it, and only they can drop that.
    await append(
      host,
      stage({
        template: 'verify',
        instruction: 'Check every Done When.',
        advanced: { endOnSuccess: true }
      })
    )
    const view = (await commit(host)).view

    expect(host.commits.at(-1)!.outcomes[0]!.finish).toBe('my-review')
    expect(host.chains()[0]!.end).toBe('me')
    // So the row does not claim it either.
    expect(stageBlocks(view).at(-1)!.advanced.endOnSuccess).toBeUndefined()
  })

  it('gives a Review and an Adversarial review the verdict contract they promise', async () => {
    readiness.ready = true
    for (const template of ['review', 'critique'] as const) {
      const host = harness()
      await append(host, stage({ instruction: 'Sign the receipts.' }))
      await commit(host)
      await append(host, stage({ template, instruction: 'Say whether it holds up.' }))
      await append(host, stage({ instruction: 'Fix what it found.' }))
      await commit(host)

      const step = agentSteps(host).find((entry) => entry.presetId === template)!
      expect(step.verdict).toMatchObject({ kind: template, consumed: 'record' })
      expect(step.verdict!.over.length).toBeGreaterThan(0)
      // With a verdict on the step, the brief carries the marker the host reads back.
      expect(
        buildSessionVerdictInstructions(
          step,
          step.verdict!.over.map((stepId) => ({ stepId })),
          { title: 'Receipts are signed', doneWhen: [] }
        )
      ).toContain('OMNI_VERDICT')
    }
  })

  it('lets the stage a Review fed be removed, and the Review keeps no verdict', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await commit(host)
    await append(host, stage({ template: 'review', instruction: 'Say whether it holds up.' }))
    await append(host, stage({ instruction: 'Fix what it found.' }))
    await commit(host)
    const improve = stageBlocks(await list(host)).at(-1)!

    // Removing the reader leaves the Review deciding for nobody, which the plan may not
    // carry: the verdict goes with its reader rather than refusing the removal, and the
    // re-minted seat gets an id this chain has not used.
    await expect(
      host.call(UP_NEXT_RPC.remove, { conversationId, blockId: improve.id })
    ).resolves.toBeTruthy()

    const review = agentSteps(host).findLast((step) => step.presetId === 'review')!
    expect(review.verdict).toBeUndefined()
    expect(new Set(agentSteps(host).map((step) => step.id)).size).toBe(agentSteps(host).length)
  })

  it('claims no verdict for a Review that ends the track, and still queues it', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await commit(host)
    await append(host, stage({ template: 'review', instruction: 'Say whether it holds up.' }))
    await commit(host)

    // A verdict nobody spends never runs, so a Review with nothing behind it reports its
    // findings in prose rather than claiming a contract the host could not consume.
    const step = agentSteps(host).find((entry) => entry.presetId === 'review')!
    expect(step.verdict).toBeUndefined()
    expect(stageBlocks(await list(host)).map((block) => block.output)).toEqual([
      'result',
      'findings'
    ])
  })
})

describe('the Person payload and the plain finish', () => {
  it('delivers the note the person wrote and the transcript they ticked', async () => {
    readiness.ready = true
    const host = withHostCatalogue(harness())
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await append(host, {
      kind: 'person',
      relationship: 'review',
      people: [{ id: 'emp_1', name: 'Jordan Taylor' }],
      receive: { transcript: true, note: 'Only the signing matters here.' }
    })
    const view = (await commit(host)).view

    const handoff = host.chains()[0]!.steps.find((step) => step.kind === 'handoff')!
    expect(handoff.kind === 'handoff' && handoff.handoff.note).toBe(
      'Only the signing matters here.'
    )
    expect(handoff.kind === 'handoff' && handoff.handoff.transcriptSource).toEqual(TRANSCRIPT)
    const person = view.blocks.find((block) => block.kind === 'person')!
    expect(person.kind === 'person' && person.receive).toMatchObject({
      transcript: true,
      note: 'Only the signing matters here.'
    })
  })

  it('hands a lone Done on an ordinary conversation to the surface that owns it', async () => {
    readiness.ready = true
    for (const done of [
      { kind: 'done' as const },
      { kind: 'done' as const, finish: 'save' as const, folderId: 'fld_acceptance' }
    ]) {
      const host = harness()
      await append(host, done)
      const ctx = { runtime: host.ctx.runtime as never, conversationId, rowKey }
      const result = await upNextCommitDrafts(ctx, await upNextView(ctx.runtime, conversationId))

      expect(result.finish).toEqual(
        done.finish === 'save' ? { action: 'save', folderId: 'fld_acceptance' } : { action: 'end' }
      )
      // Nothing was manufactured for a conversation that never became a pursuit.
      expect(host.commits).toHaveLength(0)
      expect(host.chains()).toEqual([])
    }
  })

  it('records the finish on the pursuit when there is one', async () => {
    readiness.ready = true
    const host = harness()
    await append(host, stage({ instruction: 'Sign the receipts.' }))
    await commit(host)
    await append(host, { kind: 'done', finish: 'save', folderId: 'fld_acceptance' })
    const ctx = { runtime: host.ctx.runtime as never, conversationId, rowKey }
    const result = await upNextCommitDrafts(ctx, await upNextView(ctx.runtime, conversationId))

    expect(result.finish).toBeUndefined()
    expect(host.commits.at(-1)!.sessionFinish).toEqual({
      action: 'save',
      folderId: 'fld_acceptance'
    })
  })
})

/** The chain the harness seeds is only ever read through the projection, never asserted raw. */
export type UpNextCommitTestChain = SessionChain
