import { describe, expect, it } from 'vitest'
import type { ArtifactListItem, ArtifactMetadata } from '../../../../shared/artifacts'
import {
  artifactBulkConfirmation,
  artifactBulkOutcomeSummary,
  planArtifactBulkAction,
  runArtifactLifecycleQueue
} from './artifact-bulk-lifecycle'

function row(
  slug: string,
  artifact: Partial<ArtifactMetadata> = {},
  extra: Partial<ArtifactListItem> = {}
): ArtifactListItem {
  return {
    artifact: {
      version: 1,
      slug,
      title: slug.toUpperCase(),
      originalFileName: null,
      sourceContentType: 'text/html',
      renderedContentType: 'text/html',
      createdAt: '',
      updatedAt: '',
      expiresAt: '',
      byteSize: 1,
      deletedAt: null,
      revision: 2,
      review: { question: 'Ship?', reviewers: [], status: 'pending', statusAt: null },
      lifecycle: null,
      closedAt: null,
      closedRef: null,
      supersededBy: null,
      supersededAt: null,
      ...artifact
    },
    shareUrl: `https://omnios.example/a/${slug}`,
    lastDecision: null,
    ...extra
  }
}

const approved = { lastDecision: { revision: 2, decision: 'approved' as const, at: '' } }
const selection = [
  row('approved', {}, approved),
  row('pending'),
  row('share', { review: null }),
  row('closed', { lifecycle: 'no_action', closedAt: 't' }, approved),
  row('gone', { supersededBy: 'x', supersededAt: 't' })
]

describe('bulk plan', () => {
  it('marks done only rows approved on their current revision', () => {
    const plan = planArtifactBulkAction('done', selection)
    expect(plan.acted.map(({ item }) => item.artifact.slug)).toEqual(['approved'])
    expect(plan.acted[0].request).toEqual({
      action: 'close',
      revision: 2,
      lifecycle: 'done',
      expect: 'open'
    })
    expect(plan.skipped.map(({ item, reason }) => [item.artifact.slug, reason])).toEqual([
      ['pending', 'not_approved'],
      ['share', 'not_review'],
      ['closed', 'already_closed'],
      ['gone', 'already_closed']
    ])
  })

  it('marks a review done without an approval, but never an unapproved decision or a study', () => {
    const review = (slug: string, type: 'decision' | 'review' | 'study') =>
      row(slug, {
        review: { question: 'Ship?', reviewers: [], status: 'pending', statusAt: null, type }
      })
    const asks = [
      review('review', 'review'),
      review('study', 'study'),
      review('decision', 'decision')
    ]
    const plan = planArtifactBulkAction('done', asks)
    expect(plan.acted.map(({ item }) => item.artifact.slug)).toEqual(['review'])
    expect(plan.skipped.map(({ item, reason }) => [item.artifact.slug, reason])).toEqual([
      ['study', 'study'],
      ['decision', 'not_approved']
    ])
    expect(artifactBulkConfirmation(plan, null).description).toContain(
      '1 a study (close it on its own)'
    )
    for (const action of ['no_action', 'supersede'] as const) {
      const other = planArtifactBulkAction(
        action,
        asks,
        action === 'supersede' ? 'next' : undefined
      )
      expect(other.skipped.map(({ item, reason }) => [item.artifact.slug, reason])).toEqual([
        ['study', 'study']
      ])
    }
  })

  it('closes any open review page as no action', () => {
    const plan = planArtifactBulkAction('no_action', selection)
    expect(plan.acted.map(({ item }) => item.artifact.slug)).toEqual(['approved', 'pending'])
  })

  it('supersedes any page not yet superseded, never the successor itself', () => {
    const plan = planArtifactBulkAction('supersede', selection, 'pending')
    expect(plan.acted.map(({ item }) => item.artifact.slug)).toEqual([
      'approved',
      'share',
      'closed'
    ])
    expect(plan.acted[0].request).toEqual({
      action: 'supersede',
      revision: 2,
      by: 'pending',
      expect: 'unsuperseded'
    })
    expect(plan.skipped.map(({ reason }) => reason)).toEqual(['is_successor', 'already_superseded'])
  })

  it('states the action, the acted and skipped counts with reasons, and the successor', () => {
    const done = artifactBulkConfirmation(planArtifactBulkAction('done', selection), null)
    expect(done.title).toBe('Mark done for 1 page(s)?')
    expect(done.description).toBe(
      '1 page(s) will be closed as “Mark done”.\n4 skipped: 1 not approved, 1 not a review page, 2 already closed.'
    )
    const supersede = artifactBulkConfirmation(
      planArtifactBulkAction('supersede', selection, 'pending'),
      'Pending plan'
    )
    expect(supersede.description).toBe(
      '3 page(s) will be marked superseded by “Pending plan”.\n2 skipped: 1 is the successor, 1 already superseded.'
    )
    expect(supersede.confirmLabel).toBe('Superseded by')
  })

  it('summarises the run with names of rows that changed since selection', () => {
    expect(
      artifactBulkOutcomeSummary(
        {
          changed: [{ slug: 'a', name: 'A', undo: null }],
          conflicts: ['B', 'C', 'D'],
          failures: []
        },
        ['E', 'F']
      )
    ).toBe('1 changed · 2 skipped: E, F · 3 changed since you selected them: B, C, D')
  })
})

describe('bulk queue', () => {
  it('runs every task once with at most four in flight, and survives a failure', async () => {
    let inFlight = 0
    let peak = 0
    const seen: number[] = []
    await runArtifactLifecycleQueue(
      Array.from({ length: 10 }, (_, index) => index),
      async (task) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight -= 1
        seen.push(task)
        if (task === 3) {
          throw new Error('boom')
        }
      }
    )
    expect(peak).toBe(4)
    expect(seen.toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})
