import { describe, expect, it } from 'vitest'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { graphImproveRules } from './graph-improve-rules'
import type { GraphCall } from './graph-plan'
import { drive, text } from './graph-test-harness'

type Round = 'unjudged' | 'failed' | 'new-best' | 'kept'

function run(
  rounds: Round[],
  options: {
    legacy?: boolean
    maxRounds?: number
    patience?: number
    explore?: 'low' | 'normal'
  } = {}
) {
  const template = workflowTemplate('improve', ['claude', 'codex', 'grok'])
  const spec = {
    ...template,
    repeat: {
      ...template.repeat!,
      maxRounds: options.maxRounds ?? 10,
      patience: options.patience ?? 1,
      explore: options.explore ?? ('low' as const)
    }
  }
  const snapshot = options.legacy ? {} : { host: { improveUnresolvedRounds: true } }
  return drive(
    spec,
    (call: GraphCall) => {
      const result = rounds[call.round - 2] ?? 'kept'
      if (call.stepId === 'improve') {
        return call.round > 1 && result === 'failed' ? undefined : text(`v${call.round}`)
      }
      if (!call.jev) {
        return undefined
      }
      const candidates = [...call.jev.candidates].sort((a, b) => {
        const aNew = a.markdown === `v${call.round}` ? 1 : 0
        const bNew = b.markdown === `v${call.round}` ? 1 : 0
        return result === 'new-best' || result === 'unjudged' ? bNew - aNew : aNew - bNew
      })
      return {
        markdown: `FINAL RANKING:\n${candidates.map((entry, i) => `${i + 1}. ${entry.label}`).join('\n')}`,
        unsure: result === 'unjudged'
      }
    },
    graphImproveRules(snapshot)
  )
}

const results = (plan: ReturnType<typeof run>) =>
  plan.loop!.improve!.rounds.map((entry) => entry.result)

describe('Improve unresolved rounds, frozen opt-in', () => {
  it.each(['unjudged', 'failed'] as const)(
    '%s does not consume patience or request divergence',
    (result) => {
      const plan = run([result, 'new-best'], { maxRounds: 3, explore: 'normal' })
      expect(results(plan)).toEqual(['first', result, 'new-best'])
      expect(plan.loop).toMatchObject({ status: 'max-rounds', improve: { stale: 0 } })
      expect(plan.loop!.improve!.rounds.map((entry) => entry.mode)).toEqual([
        'first',
        'improve',
        'improve'
      ])
      const single = run([result], { maxRounds: 2 })
      expect(single.loop).toMatchObject({ status: 'max-rounds', improve: { stale: 0 } })
    }
  )

  it.each([
    ['unjudged', 'unjudged'],
    ['failed', 'failed'],
    ['unjudged', 'failed'],
    ['failed', 'unjudged']
  ] as Round[][])('stops undecided after consecutive %s and %s rounds', (first, second) => {
    const plan = run([first, second])
    expect(results(plan)).toEqual(['first', first, second])
    expect(plan.loop).toMatchObject({
      status: 'undecided',
      round: 3,
      improve: { stale: 0, stop: 'undecided', best: { round: 1 } }
    })
    expect(plan.outcome?.final?.markdown).toContain(
      'Stopped: two rounds in a row could not be judged.'
    )
  })

  it.each(['new-best', 'kept'] as const)(
    '%s resets the unresolved streak and permits a later plateau',
    (judged) => {
      const plan = run(['unjudged', judged, 'unjudged', 'kept', 'kept'], { patience: 2 })
      expect(results(plan)).toEqual([
        'first',
        'unjudged',
        judged,
        'unjudged',
        'kept',
        ...(judged === 'new-best' ? ['kept'] : [])
      ])
      expect(plan.loop).toMatchObject({ status: 'plateau', improve: { stop: 'plateau', stale: 2 } })
    }
  )

  it('does not declare a plateau when the divergent round is unresolved', () => {
    const plan = run(['kept', 'unjudged', 'unjudged'], { explore: 'normal' })
    expect(results(plan)).toEqual(['first', 'kept', 'unjudged', 'unjudged'])
    expect(plan.loop).toMatchObject({ status: 'undecided', improve: { stale: 1 } })
  })

  it('gives the round limit priority over the unresolved stop', () => {
    const plan = run(['unjudged', 'failed'], { maxRounds: 3 })
    expect(plan.loop).toMatchObject({
      status: 'max-rounds',
      improve: { stop: 'max-rounds', stale: 0 }
    })
  })

  it.each(['unjudged', 'failed'] as const)(
    'replays snapshots without the opt-in with the old %s plateau',
    (result) => {
      const plan = run([result, result], { legacy: true, explore: 'normal' })
      expect(results(plan)).toEqual(['first', result, result])
      expect(plan.loop).toMatchObject({ status: 'plateau', improve: { stop: 'plateau', stale: 2 } })
      expect(plan.loop!.improve!.rounds[2].mode).toBe('divergent')
    }
  )

  it('does not opt older or malformed snapshots into new behavior', () => {
    for (const snapshot of [{}, { host: {} }, { host: { improveUnresolvedRounds: 'true' } }]) {
      expect(graphImproveRules(snapshot)).toEqual({})
    }
  })
})
