import { describe, expect, it } from 'vitest'
import type { ArtifactReviewStatus } from '../shared/artifact-review'
import type { ArtifactListItem } from '../shared/artifacts'
import {
  ARTIFACT_COLLECT_NEXT_STEP,
  ARTIFACT_REVIEW_NEXT_STEP,
  formatArtifactReviewStatus,
  formatArtifactShared
} from './artifact-format'

const item: ArtifactListItem = {
  artifact: {
    version: 1,
    slug: 'artifact-1',
    title: 'Launch plan',
    originalFileName: 'plan.html',
    sourceContentType: 'text/html',
    renderedContentType: 'text/html',
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    expiresAt: '2026-10-23T00:00:00.000Z',
    byteSize: 12,
    deletedAt: null
  },
  shareUrl: 'https://console.example.com/a/artifact-1'
}

const reviewed: ArtifactListItem = {
  ...item,
  artifact: {
    ...item.artifact,
    audience: 'team',
    revision: 2,
    review: { question: 'Ship it?', reviewers: [], status: 'pending', statusAt: null }
  }
}

function statusResult(overrides: Partial<ArtifactReviewStatus> = {}): ArtifactReviewStatus {
  return {
    artifact: reviewed.artifact,
    shareUrl: reviewed.shareUrl,
    status: 'pending',
    latest: null,
    decisions: [],
    viewer: { signedIn: true, isOwner: true, canDecide: false },
    ...overrides
  }
}

describe('artifact formatting', () => {
  it('prints only the URL for a plain share (older servers included)', () => {
    expect(formatArtifactShared(item)).toBe(item.shareUrl)
    expect(formatArtifactShared({ ...item, artifact: { ...item.artifact, review: null } })).toBe(
      item.shareUrl
    )
  })

  it('prints one line per publish warning hint', () => {
    const warnings = [
      { code: 'category_missing', hint: 'Filed under Other. Send review.about.category.' },
      { code: 'reviewer_unknown', hint: 'nobody@example.com reaches nobody.' }
    ]
    expect(formatArtifactShared({ ...reviewed, warnings })).toBe(
      [
        reviewed.shareUrl,
        'review: pending',
        'warning: Filed under Other. Send review.about.category.',
        'warning: nobody@example.com reaches nobody.',
        ARTIFACT_REVIEW_NEXT_STEP
      ].join('\n')
    )
    expect(formatArtifactShared({ ...item, warnings })).toBe(
      [item.shareUrl, `warning: ${warnings[0].hint}`, `warning: ${warnings[1].hint}`].join('\n')
    )
  })

  it('says when the page is not tied to the session that published it', () => {
    const sessionBinding = {
      state: 'unbound' as const,
      reason: 'no agent is running in its terminal'
    }
    const line =
      'session: not bound, no agent is running in its terminal. Decisions on this page will not be delivered to this session; read them with `omni artifacts status <file>`.'
    expect(formatArtifactShared({ ...item, sessionBinding })).toBe(`${item.shareUrl}\n${line}`)
    expect(formatArtifactShared({ ...reviewed, sessionBinding })).toBe(
      [reviewed.shareUrl, 'review: pending', line, ARTIFACT_REVIEW_NEXT_STEP].join('\n')
    )
  })

  it('adds the review status and next step for a review share', () => {
    expect(formatArtifactShared(reviewed)).toBe(
      [reviewed.shareUrl, 'review: pending', ARTIFACT_REVIEW_NEXT_STEP].join('\n')
    )
    expect(ARTIFACT_REVIEW_NEXT_STEP).toBe(
      'Open it signed in to OmniConsole to approve, request changes or reject; read the decision with `omni artifacts status <file>`.'
    )
  })

  it('says whether the publishing session sleeps for the decision', () => {
    expect(
      formatArtifactShared({ ...reviewed, sessionSleep: { state: 'armed', liveMinutes: 60 } })
    ).toContain('This session waits for a decision for 1 hour after this turn ends')
    expect(formatArtifactShared({ ...reviewed, sessionSleep: { state: 'kept' } })).toContain(
      'keeps running (--keep-session)'
    )
  })

  it('tells a review or study share that people answer it and nobody approves it', () => {
    const collect: Parameters<typeof formatArtifactShared>[0] = {
      ...reviewed,
      artifact: {
        ...reviewed.artifact,
        review: { ...reviewed.artifact.review!, type: 'study', mode: 'collect' }
      },
      sessionSleep: { state: 'armed', liveMinutes: 60 }
    }
    const text = formatArtifactShared(collect)
    expect(text).toContain(ARTIFACT_COLLECT_NEXT_STEP)
    expect(text).not.toContain(ARTIFACT_REVIEW_NEXT_STEP)
    expect(text).toContain('This session waits for the responses for 1 hour after this turn ends')
    expect(formatArtifactShared({ ...collect, sessionSleep: { state: 'kept' } })).toContain(
      'the responses are queued to it once they are in'
    )
  })

  it('shows how many answered while a review or study is still collecting', () => {
    const progress = {
      id: 'artifact-1:2',
      revision: 2,
      submitted: 1,
      of: 3,
      setAside: 0,
      everyone: false,
      ready: false,
      readyAt: null,
      reason: null,
      overdue: false,
      people: []
    }
    const named = formatArtifactReviewStatus(statusResult({ progress }))
    expect(named).toContain('status: pending')
    expect(named).toContain('responses: 1 of 3 answered')
    expect(named).not.toContain('not an approval')
    expect(
      formatArtifactReviewStatus(
        statusResult({ progress: { ...progress, of: null, everyone: true } })
      )
    ).toContain('responses: 1 answered; anyone may answer until the due time')
  })

  it('tells only the owner how to sum up and close, by type, and never when nobody answered', () => {
    const ready = {
      id: 'artifact-1:2',
      revision: 2,
      submitted: 2,
      of: 2,
      setAside: 0,
      everyone: false,
      ready: true,
      readyAt: '2026-10-10T12:00:00Z',
      reason: 'all' as const,
      overdue: false,
      people: []
    }
    const study = {
      ...reviewed.artifact,
      review: { ...reviewed.artifact.review!, type: 'study' as const, mode: 'collect' as const }
    }
    const owner = formatArtifactReviewStatus(statusResult({ artifact: study, progress: ready }))
    expect(owner).toContain('status: responses_in')
    expect(owner).toContain(
      'in your reply to the owner. Never comment on the page while the study is open'
    )
    expect(owner).toContain('--done --revision 2 --note')
    const other = formatArtifactReviewStatus(
      statusResult({
        artifact: study,
        progress: ready,
        viewer: { signedIn: true, isOwner: false, canDecide: false }
      })
    )
    expect(other).toContain(
      'responses: in, 2 of 2 answered. This is not an approval; the owner decides what happens next and closes the ask.'
    )
    expect(other).not.toContain('omni artifacts close')
    const otherNone = formatArtifactReviewStatus(
      statusResult({
        artifact: study,
        progress: { ...ready, submitted: 0, reason: 'due' },
        viewer: { signedIn: true, isOwner: false, canDecide: false }
      })
    )
    expect(otherNone).toContain(
      'responses: none, the due time passed (0 of 2 answered). This is not an approval;'
    )
    expect(otherNone).not.toContain('tell the owner')
    const blind = formatArtifactReviewStatus(
      statusResult({ artifact: study, progress: ready, blind: true })
    )
    expect(blind).toContain('You see them once you submit your own answers.')
    expect(blind).not.toContain('omni artifacts close')
    const none = formatArtifactReviewStatus(
      statusResult({ artifact: study, progress: { ...ready, submitted: 0, reason: 'due' } })
    )
    expect(none).toContain(
      'responses: none, the due time passed (0 of 2 answered). Nobody answered'
    )
    expect(none).not.toContain('sum up their')
    expect(none).not.toContain('omni artifacts close')
  })

  it('shows a pending review without a decision', () => {
    expect(formatArtifactReviewStatus(statusResult())).toBe(
      [`url: ${reviewed.shareUrl}`, 'revision: 2', 'status: pending', 'question: Ship it?'].join(
        '\n'
      )
    )
  })

  it('shows the latest decision with its comment and compact edits', () => {
    const latest = {
      id: 'd1',
      revision: 2,
      decision: 'changes_requested' as const,
      comment: 'Lower the budget',
      edits: { budget: 50, headline: 'New' },
      by: { email: 'sal@example.com', name: 'Sal' },
      at: '2026-09-23T10:00:00.000Z'
    }
    const text = formatArtifactReviewStatus(
      statusResult({ status: 'changes_requested', latest, decisions: [latest] })
    )
    expect(text).toContain('status: changes_requested')
    expect(text).toContain(
      'decision: changes_requested by Sal <sal@example.com> at 2026-09-23T10:00:00.000Z'
    )
    expect(text).toContain('comment: Lower the budget')
    expect(text).toContain('edits: {"budget":50,"headline":"New"}')
  })

  it('handles no review, older servers, and decisions on earlier revisions', () => {
    const earlier = {
      id: 'd0',
      revision: 1,
      decision: 'rejected' as const,
      comment: '',
      edits: null,
      by: { email: 'sal@example.com', name: '' },
      at: '2026-09-22T10:00:00.000Z'
    }
    const text = formatArtifactReviewStatus(
      statusResult({ artifact: item.artifact, status: null, decisions: [earlier] })
    )
    expect(text).toContain('revision: unknown')
    expect(text).toContain('status: no review requested')
    expect(text).toContain('no decision on this revision yet (1 on earlier revisions)')
  })
})
