import { describe, expect, it } from 'vitest'
import { receivedRow } from './backoffice-work-rows'
import type { WorkQueueThread } from './backoffice-work-views'
import { handoffPackageReferences, handoffReference } from './console-handoff-disposition-reference'
import {
  artifactReviewAnswer,
  artifactReviewDecisionEntry,
  artifactReviewDecisionOperationId,
  artifactReviewNote,
  artifactReviewReceiptId,
  artifactReviewReference,
  artifactReviewThreadTitle,
  handoffArtifactReview,
  handoffArtifactReviewOf,
  normalizeHandoffArtifactReview,
  parseArtifactReviewLink,
  parseArtifactReviewReceiptId
} from './handoff-artifact-review'

const PAGE = {
  slug: 'launch-plan_7',
  title: 'Launch plan',
  url: 'https://console.example.com/a/launch-plan_7'
}

describe('page reference on the opening entry', () => {
  it('is a {kind, ref, label} pointer the hub and the console relay both accept', () => {
    const reference = artifactReviewReference(PAGE)
    expect(reference).toEqual({
      kind: 'artifact-review',
      ref: 'launch-plan_7',
      label: 'Launch plan'
    })
    // The relay's and hub's rule: a pointer whose keys are among kind, ref and label.
    expect(Object.keys(reference).sort()).toEqual(['kind', 'label', 'ref'])
    expect(handoffReference.safeParse(reference).success).toBe(true)
    expect(JSON.stringify([reference]).length).toBeLessThan(4096)
  })

  it('rides beside the disposition and reads back from the stored entries', () => {
    const references = handoffPackageReferences({ disposition: 'feedback', artifactReview: PAGE })
    expect(references).toContainEqual(artifactReviewReference(PAGE))
    const entries = [{ references: ['https://example.com/other'] }, { references }]
    expect(handoffArtifactReviewOf(entries)).toEqual({ slug: PAGE.slug, title: PAGE.title })
    expect(
      handoffArtifactReviewOf([{ references: [{ kind: 'artifact-review', ref: 'a/b' }] }])
    ).toBe(null)
  })

  it('keeps a long title inside the label budget', () => {
    const label = artifactReviewReference({ slug: 's1', title: 'x'.repeat(500) }).label
    expect(label.length).toBe(200)
  })
})

describe('what the recipient reads in Needs you', () => {
  it('titles the request "Review: <title>" and the Needs-you row shows exactly that', () => {
    const title = artifactReviewThreadTitle(PAGE)
    expect(title).toBe('Review: Launch plan')
    const thread = {
      id: 'hth_page',
      board_task_id: null,
      author_employee_id: 'emp_sender',
      recipient_employee_id: 'emp_reader',
      title,
      state: 'open',
      action: 'review',
      due_at: null,
      parent_thread_id: null,
      delivery_id: null,
      updated: '2026-09-23T10:00:00Z',
      files: [],
      reviews: []
    } as WorkQueueThread
    expect(receivedRow(thread)).toMatchObject({ title: 'Review: Launch plan', needsYou: true })
  })

  it('never passes the hub title limit', () => {
    expect(artifactReviewThreadTitle({ slug: 's1', title: 'y'.repeat(300) })).toHaveLength(160)
  })

  it('puts the page link in the note, once, for readers that predate the reference', () => {
    expect(artifactReviewNote('', PAGE.url)).toBe(`Review the page and decide there: ${PAGE.url}`)
    expect(artifactReviewNote('Please look', PAGE.url)).toBe(
      `Please look\n\nReview the page and decide there: ${PAGE.url}`
    )
    expect(artifactReviewNote(`See ${PAGE.url}`, PAGE.url)).toBe(`See ${PAGE.url}`)
  })
})

describe('page links', () => {
  it('reads a page link, its /content form, or a bare slug', () => {
    expect(parseArtifactReviewLink(PAGE.url)).toBe(PAGE.slug)
    expect(parseArtifactReviewLink(`${PAGE.url}/content`)).toBe(PAGE.slug)
    expect(parseArtifactReviewLink(' launch-plan_7 ')).toBe(PAGE.slug)
    expect(parseArtifactReviewLink('https://console.example.com/b/launch')).toBe(null)
    expect(parseArtifactReviewLink('ftp://console.example.com/a/launch')).toBe(null)
  })

  it('drops a link that names another page, and refuses it on the wire', () => {
    const other = { ...PAGE, url: 'https://console.example.com/a/someone-else' }
    expect(normalizeHandoffArtifactReview(other)).toEqual({ slug: PAGE.slug, title: PAGE.title })
    expect(handoffArtifactReview.safeParse(other).success).toBe(false)
    expect(handoffArtifactReview.safeParse(PAGE).success).toBe(true)
  })
})

describe('the decision posted back into the thread', () => {
  const decision = {
    id: 'dec_1',
    revision: 2,
    comment: '',
    edits: null,
    by: { email: 'reader@example.com', name: 'Reader' },
    at: '2026-09-23T12:00:00Z'
  }

  it('posts an approval as done, which resolves the thread', () => {
    expect(artifactReviewDecisionEntry({ ...decision, decision: 'approved' }, 'x')).toEqual({
      kind: 'done',
      body: 'Reader approved.'
    })
  })

  it('posts changes or a rejection as a reply with the words', () => {
    expect(
      artifactReviewDecisionEntry(
        { ...decision, decision: 'changes_requested', comment: 'Fix the date' },
        'x'
      )
    ).toEqual({ kind: 'reply', body: 'Reader requested changes: Fix the date' })
    expect(
      artifactReviewDecisionEntry(
        { ...decision, decision: 'rejected', by: { email: '', name: '' } },
        'The reviewer'
      )
    ).toEqual({ kind: 'reply', body: 'The reviewer rejected.' })
  })

  it('answers only with a decision made after the request opened', () => {
    const latest = { ...decision, decision: 'approved' as const }
    expect(artifactReviewAnswer({ latest }, Date.parse('2026-09-23T11:00:00Z'))).toBe(latest)
    expect(artifactReviewAnswer({ latest }, Date.parse('2026-09-23T13:00:00Z'))).toBe(null)
    expect(artifactReviewAnswer({ latest }, Number.NaN)).toBe(null)
    expect(artifactReviewAnswer({ latest: null }, 0)).toBe(null)
  })

  it('keys each post by thread and decision in the hub idempotency shape', () => {
    const key = artifactReviewDecisionOperationId('hth_page', 'dec:1')
    expect(key).toBe('artrev_hth_page_dec_1')
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,160}$/)
  })

  it('round-trips a receipt id with no colon in it', () => {
    const id = artifactReviewReceiptId(PAGE.slug, 'dec_1')
    expect(id).not.toContain(':')
    expect(parseArtifactReviewReceiptId(id)).toEqual({ slug: PAGE.slug, decisionId: 'dec_1' })
    expect(parseArtifactReviewReceiptId('rev_123')).toBe(null)
  })
})
