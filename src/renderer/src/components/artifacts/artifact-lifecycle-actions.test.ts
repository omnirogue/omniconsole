import { describe, expect, it } from 'vitest'
import type { ArtifactListItem, ArtifactMetadata } from '../../../../shared/artifacts'
import {
  artifactCloseRequest,
  artifactLifecycleActionAvailability,
  artifactLifecycleErrorCode,
  artifactLifecycleErrorWords,
  artifactSupersedeRequest,
  artifactUndoRequest,
  isArtifactLifecycleConflict
} from './artifact-lifecycle-actions'

function row(
  artifact: Partial<ArtifactMetadata> = {},
  extra: Partial<ArtifactListItem> = {}
): ArtifactListItem {
  return {
    artifact: {
      version: 1,
      slug: 'page',
      title: 'Page',
      originalFileName: null,
      sourceContentType: 'text/html',
      renderedContentType: 'text/html',
      createdAt: '',
      updatedAt: '',
      expiresAt: '',
      byteSize: 1,
      deletedAt: null,
      revision: 4,
      review: { question: 'Ship?', reviewers: [], status: 'pending', statusAt: null },
      lifecycle: null,
      closedAt: null,
      closedRef: null,
      supersededBy: null,
      supersededAt: null,
      ...artifact
    },
    shareUrl: 'https://omnios.example/a/page',
    needsYou: true,
    lastDecision: null,
    sessionRef: null,
    sessionAgent: null,
    ...extra
  }
}

const approvedNow = { lastDecision: { revision: 4, decision: 'approved' as const, at: '' } }
const asked = (type: 'decision' | 'review' | 'study') => ({
  review: {
    question: 'Ship?',
    reviewers: [],
    status: 'pending' as const,
    statusAt: null,
    type,
    mode: type === 'decision' ? ('decide' as const) : ('collect' as const)
  }
})
const approvedBefore = { lastDecision: { revision: 3, decision: 'approved' as const, at: '' } }

describe('row action matrix', () => {
  const cases: [string, ArtifactListItem, Record<string, string>][] = [
    [
      'open pending review',
      row(),
      {
        markDone: 'disabled',
        noAction: 'enabled',
        supersede: 'enabled',
        reopen: 'hidden',
        removeSuccessor: 'hidden',
        openSession: 'hidden'
      }
    ],
    ['approved on the current revision', row({}, approvedNow), { markDone: 'enabled' }],
    ['approved on an older revision', row({}, approvedBefore), { markDone: 'disabled' }],
    ['an open review, never approved', row(asked('review')), { markDone: 'enabled' }],
    ['an open study, never approved', row(asked('study')), { markDone: 'enabled' }],
    ['a typed decision, not approved', row(asked('decision')), { markDone: 'disabled' }],
    [
      'a review already closed',
      row({ ...asked('review'), lifecycle: 'done', closedAt: '2026-10-10T10:00:00Z' }),
      { markDone: 'disabled' }
    ],
    [
      'closed as done',
      row({ lifecycle: 'done', closedAt: '2026-09-30T10:00:00Z' }, approvedNow),
      { markDone: 'disabled', noAction: 'disabled', reopen: 'enabled', supersede: 'enabled' }
    ],
    [
      'superseded',
      row({ supersededBy: 'next', supersededAt: '2026-09-30T10:00:00Z' }),
      { supersede: 'hidden', removeSuccessor: 'enabled', noAction: 'disabled', reopen: 'hidden' }
    ],
    [
      'plain share',
      row({ review: null }, { sessionRef: 'als_1' }),
      { markDone: 'hidden', noAction: 'hidden', supersede: 'enabled', openSession: 'enabled' }
    ]
  ]

  it.each(cases)('%s', (_name, item, expected) => {
    expect(artifactLifecycleActionAvailability(item)).toMatchObject(expected)
  })

  it('offers no lifecycle action on an older server row', () => {
    const older = row()
    const {
      lifecycle: _l,
      closedAt: _c,
      closedRef: _r,
      supersededBy: _s,
      supersededAt: _a,
      ...artifact
    } = older.artifact
    const availability = artifactLifecycleActionAvailability({
      artifact,
      shareUrl: older.shareUrl
    })
    expect(Object.values(availability).every((value) => value === 'hidden')).toBe(true)
  })
})

describe('request shaping', () => {
  it('fences every request with the row revision and adds expect only in bulk', () => {
    expect(artifactCloseRequest(row(), 'no_action')).toEqual({
      action: 'close',
      revision: 4,
      lifecycle: 'no_action'
    })
    expect(artifactCloseRequest(row(), 'done', { bulk: true })).toMatchObject({ expect: 'open' })
    expect(artifactSupersedeRequest(row(), 'next', { bulk: true })).toEqual({
      action: 'supersede',
      revision: 4,
      by: 'next',
      expect: 'unsuperseded'
    })
    expect(artifactSupersedeRequest(row(), 'page')).toBeNull()
  })

  it('undoes a close with its closedAt and a supersede with its successor and supersededAt', () => {
    const closed = row({
      lifecycle: 'done',
      closedAt: '2026-09-30T10:00:00.123456+00:00',
      revision: 5
    })
    expect(artifactUndoRequest('close', closed.artifact)).toEqual({
      action: 'reopen',
      revision: 5,
      closedAt: '2026-09-30T10:00:00.123456+00:00'
    })
    const superseded = row({ supersededBy: 'next', supersededAt: '2026-09-30T11:00:00Z' })
    expect(artifactUndoRequest('supersede', superseded.artifact)).toEqual({
      action: 'unsupersede',
      revision: 4,
      by: 'next',
      supersededAt: '2026-09-30T11:00:00Z'
    })
    expect(artifactUndoRequest('close', row().artifact)).toBeNull()
  })
})

describe('error words', () => {
  it('reads the server code from the main-process message', () => {
    const stale = new Error('Artifact page: the page has a newer revision (stale_revision).')
    expect(artifactLifecycleErrorCode(stale)).toBe('stale_revision')
    expect(artifactLifecycleErrorWords('stale_revision')).toBe(
      'This page changed since you loaded it. Refresh.'
    )
    expect(artifactLifecycleErrorWords('needs_approval')).toBe(
      'Mark done needs an approved decision on the current revision.'
    )
    expect(artifactLifecycleErrorWords('review_closed')).toBe('Already closed.')
    expect(artifactLifecycleErrorWords('already_closed')).toBe('Already closed.')
    expect(artifactLifecycleErrorWords('successor_invalid')).toBe(
      'That page cannot be the successor.'
    )
    const shown = new Error('Artifact page: answers were shown (study_answers_shown).')
    expect(artifactLifecycleErrorCode(shown)).toBe('study_answers_shown')
    expect(artifactLifecycleErrorWords('study_answers_shown')).toBe(
      'Its answers were shown when it closed, so this study stays closed. Publish a new study for the people still to answer.'
    )
    const older = new Error('This OmniConsole server cannot change lifecycle yet.')
    expect(artifactLifecycleErrorWords(artifactLifecycleErrorCode(older))).toBe(
      'This OmniConsole server cannot change lifecycle yet.'
    )
    expect(isArtifactLifecycleConflict(artifactLifecycleErrorCode(older))).toBe(false)
    expect(isArtifactLifecycleConflict('expect_failed')).toBe(true)
    expect(artifactLifecycleErrorCode(new Error('network down'))).toBeNull()
  })
})
