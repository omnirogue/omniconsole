/**
 * + Agent Review and + Agent Handoff compose into ONE sequential track on the one engine.
 *
 * The split is intent, not a second orchestration system: a review stage and a handoff stage
 * are the same agent stage, told apart by the template they carry. These cases compose mixed
 * sequences through the real append → commit → projection path and prove each lands in the
 * order composed, keeps the verdict contract it already had, and reads back with its intent.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

vi.mock('../../conversation-readiness', () => ({
  observeConversationReadiness: async () => ({ ready: true, free: true, unverifiable: false })
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
  type UpNextAgentTemplate,
  type UpNextView
} from '../../../../shared/up-next-types'
import { conversationId, harness, type UpNextHarness } from './up-next-harness'

const list = async (host: UpNextHarness): Promise<UpNextView> =>
  (await host.call(UP_NEXT_RPC.list, { conversationId })).view

const append = (host: UpNextHarness, template: UpNextAgentTemplate, instruction: string) =>
  host.call(UP_NEXT_RPC.append, {
    conversationId,
    draft: { kind: 'agent', template, instruction }
  })

const commit = (host: UpNextHarness): Promise<{ view: UpNextView }> =>
  host.call(UP_NEXT_RPC.commit, { conversationId })

const agentSteps = (host: UpNextHarness): SessionChainAgentStep[] =>
  host.chains()[0]?.steps.filter(isSessionChainAgentStep) ?? []

const stageBlocks = (view: UpNextView): UpNextAgentBlock[] =>
  view.blocks.filter((block): block is UpNextAgentBlock => block.kind === 'agent')

/** The work under review, already queued, as the person's session would have it. */
async function withWork(): Promise<UpNextHarness> {
  const host = harness()
  await append(host, 'implement', 'Sign the receipts.')
  await commit(host)
  return host
}

const SEQUENCES: { name: string; templates: UpNextAgentTemplate[] }[] = [
  { name: 'Verify → Improve', templates: ['verify', 'improve'] },
  { name: 'Review → Improve', templates: ['review', 'improve'] },
  {
    name: 'Adversarial Review → Improve → Verify',
    templates: ['critique', 'improve', 'verify']
  },
  {
    name: 'several reviews followed by a handoff',
    templates: ['review', 'critique', 'verify', 'implement']
  }
]

describe('mixed review and handoff sequences', () => {
  for (const { name, templates } of SEQUENCES) {
    it(`queues ${name} in the order composed, each with its intent`, async () => {
      const host = await withWork()
      for (const [index, template] of templates.entries()) {
        await append(host, template, `Stage ${index + 1}: ${template}.`)
      }
      const drafted = await list(host)
      // A draft already says what it is before anything is queued.
      expect(stageBlocks(drafted).slice(1).map((block) => block.intent)).toEqual(
        templates.map((template) =>
          ['review', 'critique', 'verify'].includes(template) ? 'review' : 'handoff'
        )
      )

      const view = (await commit(host)).view

      // Additive and sequential: the work stays first, then every stage in the order composed.
      expect(agentSteps(host).map((step) => step.presetId)).toEqual(['implement', ...templates])
      expect(host.commits.at(-1)!.outcomes[0]!.stepIds).toEqual(
        agentSteps(host).map((step) => step.id)
      )
      expect(agentSteps(host).some((step) => step.supersededBy)).toBe(false)
      const blocks = stageBlocks(view)
      expect(blocks.map((block) => block.template)).toEqual(['implement', ...templates])
      expect(blocks.map((block) => block.state)).toEqual(blocks.map(() => 'queued'))
      expect(blocks.map((block) => [block.intent, block.output])).toEqual(
        ['implement', ...templates].map((template) =>
          template === 'verify'
            ? ['review', 'verdict']
            : template === 'review' || template === 'critique'
              ? ['review', 'findings']
              : ['handoff', 'result']
        )
      )

      // A Review or an Adversarial review with a stage behind it keeps the verdict contract it
      // always had: the split changed the menus, not what the engine asks of the reviewer.
      const steps = agentSteps(host)
      for (const [index, step] of steps.entries()) {
        const next = steps[index + 1]?.presetId
        if (
          (step.presetId === 'review' || step.presetId === 'critique') &&
          (next === 'improve' || next === 'implement')
        ) {
          expect(step.verdict).toMatchObject({ kind: step.presetId, consumed: 'record' })
        }
      }

      // The stages finish one after another, and the track reads each one done in turn.
      const ids = agentSteps(host).map((step) => step.id)
      for (const [index, id] of ids.entries()) {
        host.finishStage(id)
        const states = stageBlocks(await list(host)).map((block) => block.state)
        expect(states.slice(0, index + 1)).toEqual(ids.slice(0, index + 1).map(() => 'done'))
        expect(states.slice(index + 1)).not.toContain('done')
      }
    })
  }
})
