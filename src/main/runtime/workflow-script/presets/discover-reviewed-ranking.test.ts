import { describe, expect, it } from 'vitest'
import { validateJsonSchema } from '../../../../shared/json-schema-validate'
import rankingSchema from './schemas/discovery-reviewed-ranking.schema.json'
import {
  applyDiscoverReviewedRanking,
  validateDiscoverReviewedRanking,
  type DiscoverReviewedRanking
} from './discover-reviewed-ranking'
import type { SelectedFinding } from './discover-assessment'

const survivor: SelectedFinding = {
  id: 'finding-one',
  issueKey: 'dialog-focus',
  title: 'Focus problem plus unsupported Escape claim',
  location: 'src/Dialog.tsx:1-8',
  trigger: 'Opening leaves focus behind',
  impact: 'Background receives input. Escape cannot close the dialog.',
  severity: 'high',
  evidence: [
    { ref: 'contract:dialog', description: 'Focus stays in the background.' },
    { ref: 'src/Dialog.tsx:1-8', description: 'No focus target or Escape handler.' },
    { ref: 'src/Dialog.tsx:1-8', description: 'No Escape handler or accessible name.' }
  ],
  sources: [{ dimension: 'correctness', index: 0, producer: 'finder' }]
}

const reviewed: DiscoverReviewedRanking = {
  summary: 'One supported focus issue',
  ranking: [
    {
      findingId: survivor.id,
      reason: 'The focus contract establishes the issue.',
      nextAction: 'Move focus into the dialog, contain it, and restore it on close.',
      finding: {
        title: 'Dialog leaves keyboard focus in the background',
        location: survivor.location,
        trigger: survivor.trigger,
        impact: 'Background controls remain keyboard-focusable while the dialog is open.',
        severity: survivor.severity,
        evidence: [
          { ref: 'contract:dialog', description: 'Focus stays in the background.' },
          { ref: 'src/Dialog.tsx:1-8', description: 'The dialog declares aria-modal=true.' }
        ]
      }
    }
  ]
}

describe('Discover reviewed ranking', () => {
  it('accepts a narrowed finding and replaces only reportable claims', () => {
    expect(validateJsonSchema(rankingSchema, reviewed)).toEqual([])
    expect(validateDiscoverReviewedRanking(reviewed, [survivor])).toBeNull()
    const [result] = applyDiscoverReviewedRanking(
      [{ ...survivor, outcome: 'survives', votes: [{ reason: 'Core established' }] }],
      reviewed
    )
    expect(result).toMatchObject({
      id: survivor.id,
      issueKey: survivor.issueKey,
      outcome: 'survives',
      votes: [{ reason: 'Core established' }],
      title: 'Dialog leaves keyboard focus in the background',
      impact: reviewed.ranking[0].finding.impact
    })
    expect(result.evidence).toHaveLength(2)
    expect(JSON.stringify(result)).not.toContain('Escape')
  })

  it('rejects changed locus, new refs, and repeated packet citations', () => {
    const change = (overrides: Partial<DiscoverReviewedRanking['ranking'][number]['finding']>) => ({
      ...reviewed,
      ranking: [
        {
          ...reviewed.ranking[0],
          finding: { ...reviewed.ranking[0].finding, ...overrides }
        }
      ]
    })
    expect(
      validateDiscoverReviewedRanking(change({ location: 'other.ts:1' }), [survivor])
    ).toContain('location and severity')
    expect(
      validateDiscoverReviewedRanking(
        change({ evidence: [{ ref: 'other.ts:1', description: 'Invented source' }] }),
        [survivor]
      )
    ).toContain('packet reference')
    expect(
      validateDiscoverReviewedRanking(
        change({
          evidence: [
            reviewed.ranking[0].finding.evidence[0],
            reviewed.ranking[0].finding.evidence[0]
          ]
        }),
        [survivor]
      )
    ).toContain('packet reference')
  })
})
