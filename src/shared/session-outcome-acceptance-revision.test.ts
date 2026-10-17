import { describe, expect, it } from 'vitest'
import { recordSessionOutcomeEvidence, reviseSessionOutcomeSet } from './session-outcome-state'
import { sessionOutcomeConditionKey, type SessionOutcomeDefinition } from './session-outcome-types'

const owner = {
  owner: 'execution-host',
  hostId: 'local',
  epoch: 'fixture',
  state: 'owned'
} as const
const definition: SessionOutcomeDefinition = {
  id: 'report',
  title: 'Usage report',
  finish: 'complete',
  dependsOn: [],
  actions: [],
  stepIds: ['produce'],
  instructions: 'Include seven days.',
  conditions: [{ id: 'file', kind: 'file', target: 'report.json', label: 'Includes seven days' }]
}

describe('acceptance evidence belongs to the requirement revision that was checked', () => {
  const prepared = () => {
    const set = reviseSessionOutcomeSet(
      undefined,
      { expectedRevision: 0, source: 'user', outcomes: [definition] },
      owner,
      1
    )
    const condition = definition.conditions[0]!
    const evidence = {
      id: 'seven_days',
      outcomeId: 'report',
      conditionId: 'file',
      outcomeRevision: 1,
      conditionKey: sessionOutcomeConditionKey(condition),
      kind: condition.kind,
      target: condition.target,
      receipt: 'verified:seven-days',
      verifiedAt: 2,
      verifier: 'execution-host' as const
    }
    return {
      set: recordSessionOutcomeEvidence({ ...set, completedSteps: ['produce'] }, evidence),
      evidence
    }
  }

  it.each(['instructions', 'label', 'title'] as const)(
    'requires fresh evidence for seven to fourteen days in %s',
    (field) => {
      const { set, evidence } = prepared()
      const next = structuredClone(definition)
      if (field === 'label') {
        next.conditions[0]!.label = 'Includes fourteen days'
      } else {
        next[field] = 'Include fourteen days.'
      }
      const revised = reviseSessionOutcomeSet(
        set,
        { expectedRevision: 1, source: 'user', outcomes: [next] },
        owner,
        3
      )
      expect(revised.outcomes[0]).toMatchObject({ revision: 2, status: 'pending', evidence: [] })
      expect(revised.evidenceHistory).toEqual([evidence])
      expect(() => recordSessionOutcomeEvidence(revised, evidence)).toThrow('stale')
      expect(() =>
        recordSessionOutcomeEvidence(revised, { ...evidence, outcomeRevision: 2 })
      ).toThrow('receipt ID conflict')
      const current = recordSessionOutcomeEvidence(revised, {
        ...evidence,
        id: 'fourteen_days',
        outcomeRevision: 2,
        receipt: 'verified:fourteen-days',
        verifiedAt: 4
      })
      expect(current.outcomes[0]!.status).toBe('satisfied')
    }
  )

  it('keeps unchanged acceptance proof when only the execution plan changes', () => {
    const { set, evidence } = prepared()
    const revised = reviseSessionOutcomeSet(
      set,
      {
        expectedRevision: 1,
        source: 'user',
        outcomes: [{ ...definition, stepIds: ['new_step'] }]
      },
      owner,
      3
    )
    expect(revised.outcomes[0]).toMatchObject({ revision: 1, evidence: [evidence] })
    expect(revised.evidenceHistory).toEqual([])
  })
})
