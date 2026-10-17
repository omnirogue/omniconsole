import { describe, expect, it } from 'vitest'
import type { ArtifactListItem, ArtifactMetadata } from '../../../../shared/artifacts'
import {
  artifactItemHasLifecycle,
  artifactListHasLifecycle,
  capitalizeAgentName,
  deriveArtifactRowStatus,
  shortSessionRef,
  type ArtifactRowStatus
} from './artifact-lifecycle-model'
import {
  artifactDecisionsSummary,
  artifactStatusText,
  artifactWhoLabel
} from './artifact-lifecycle-labels'

type Overrides = Partial<ArtifactMetadata> & {
  needsYou?: boolean
  lastDecision?: ArtifactListItem['lastDecision']
  reviewStatus?: 'pending' | 'approved' | 'changes_requested' | 'rejected' | null
}

function row({
  needsYou = false,
  lastDecision = null,
  reviewStatus = 'pending',
  ...artifact
}: Overrides = {}): ArtifactListItem {
  return {
    artifact: {
      version: 1,
      slug: 'page',
      title: 'Page',
      originalFileName: null,
      sourceContentType: 'text/html',
      renderedContentType: 'text/html',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      expiresAt: '2026-10-02T00:00:00.000Z',
      byteSize: 10,
      deletedAt: null,
      revision: 3,
      review:
        reviewStatus === null
          ? null
          : { question: 'Ship?', reviewers: [], status: reviewStatus, statusAt: null },
      lifecycle: null,
      closedAt: null,
      closedRef: null,
      supersededBy: null,
      supersededAt: null,
      ...artifact
    },
    shareUrl: 'https://omnios.example/a/page',
    needsYou,
    lastDecision,
    sessionRef: null,
    sessionAgent: null
  }
}

const decision = (
  revision: number,
  kind: 'approved' | 'changes_requested' | 'rejected' = 'approved'
) => ({
  revision,
  decision: kind,
  at: '2026-09-03T00:00:00.000Z'
})

describe('deriveArtifactRowStatus', () => {
  const cases: [string, ArtifactListItem, ArtifactRowStatus, string][] = [
    [
      'superseded wins over done',
      row({ supersededBy: 'next', lifecycle: 'done', closedRef: 'https://r' }),
      { kind: 'superseded', successorSlug: 'next' },
      'Superseded → Next page'
    ],
    [
      'superseded plain share',
      row({ supersededBy: 'next', reviewStatus: null }),
      { kind: 'superseded', successorSlug: 'next' },
      'Superseded → Next page'
    ],
    [
      'done with a result link',
      row({ lifecycle: 'done', closedRef: 'https://example.com/pr/1', lastDecision: decision(3) }),
      { kind: 'done', closedRef: 'https://example.com/pr/1' },
      'Done'
    ],
    [
      'no action',
      row({ lifecycle: 'no_action', needsYou: true }),
      { kind: 'no_action' },
      'No action'
    ],
    [
      'decided on the current revision beats needs you',
      row({ needsYou: true, lastDecision: decision(3, 'changes_requested') }),
      { kind: 'decided', decision: 'changes_requested', revision: 3 },
      'Decided · Changes requested · rev 3'
    ],
    [
      'needs you, decided at an older revision',
      row({ needsYou: true, lastDecision: decision(2) }),
      { kind: 'needs_you', decidedAtRevision: 2 },
      'Needs you · decided at rev 2'
    ],
    [
      'needs you, never decided',
      row({ needsYou: true }),
      { kind: 'needs_you', decidedAtRevision: null },
      'Needs you'
    ],
    ['pending, not for this viewer', row({ needsYou: false }), { kind: 'pending' }, 'Pending'],
    ['plain share', row({ reviewStatus: null }), { kind: 'none' }, ''],
    [
      'review approved with no decision row is blank',
      row({ reviewStatus: 'approved' }),
      { kind: 'none' },
      ''
    ]
  ]

  it.each(cases)('%s', (_name, item, expected, words) => {
    const status = deriveArtifactRowStatus(item)
    expect(status).toEqual(expected)
    expect(artifactStatusText(status, 'Next page')).toBe(words)
  })
})

describe('a decision this build does not know', () => {
  it('is shown as sent, never as Approved, and never throws', () => {
    const unknown = {
      revision: 3,
      decision: 'needs_more_info' as never,
      at: '2026-10-10T00:00:00Z'
    }
    const status = deriveArtifactRowStatus(row({ lastDecision: unknown }))
    expect(artifactStatusText(status, '')).toBe('Decided · needs more info · rev 3')
    expect(
      artifactDecisionsSummary([{ ...unknown, by: { email: 'a@example.com', name: 'A' } }])
    ).toContain('needs more info rev 3')
  })
})

describe('lifecycle detection', () => {
  it('reads an older server payload (no lifecycle keys) as unsupported', () => {
    const older: ArtifactListItem = {
      artifact: {
        version: 1,
        slug: 'old',
        title: null,
        originalFileName: 'old.html',
        sourceContentType: 'text/html',
        renderedContentType: 'text/html',
        createdAt: '',
        updatedAt: '',
        expiresAt: '',
        byteSize: 1,
        deletedAt: null
      },
      shareUrl: 'https://omnios.example/a/old'
    }
    expect(artifactItemHasLifecycle(older)).toBe(false)
    expect(artifactListHasLifecycle([older])).toBe(false)
    expect(artifactListHasLifecycle([older, row()])).toBe(true)
  })
})

describe('who label', () => {
  it('names the agent and the local session title, else the shortened ledger id', () => {
    const item = { ...row(), sessionRef: 'als_0123456789a3f2', sessionAgent: 'claude' }
    expect(artifactWhoLabel(item, 'Fix the login bug')).toBe('Claude · Fix the login bug')
    expect(artifactWhoLabel(item, null)).toBe('Claude · session …a3f2')
    expect(artifactWhoLabel(row(), null)).toBe('')
    expect(shortSessionRef('als_abcd')).toBe('…abcd')
    expect(capitalizeAgentName(' codex ')).toBe('Codex')
  })
})
