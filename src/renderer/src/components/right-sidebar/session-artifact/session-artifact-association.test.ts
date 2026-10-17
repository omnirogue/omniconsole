import { describe, expect, it } from 'vitest'
import type { ArtifactSessionRecord } from '../../../../../shared/artifact-session'
import { type ArtifactSessionTarget, artifactsForSession } from './session-artifact-association'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function record(
  slug: string,
  overrides: Partial<ArtifactSessionRecord> = {}
): ArtifactSessionRecord {
  return {
    slug,
    shareUrl: `https://console.example.com/a/${slug}`,
    sourceKey: `/elsewhere/${slug}.html`,
    savedAt: 1,
    contentUrl: `https://console.example.com/a/${slug}/content`,
    origin: null,
    ...overrides
  }
}

const target: ArtifactSessionTarget = {
  worktreeId: 'wt-1',
  tabId: 'tab-a',
  leafId: null
}

describe('artifactsForSession', () => {
  it('ties an artifact to the pane that published it and to no other session', () => {
    const mine = record('mine', { origin: { paneKey: `tab-a:${LEAF_A}`, worktreeId: 'wt-1' } })
    const sibling = record('sibling', {
      // Same worktree, even a source file inside it: the pane is the stronger evidence.
      sourceKey: '/repo/wt-1/plan.html',
      origin: { paneKey: `tab-b:${LEAF_B}`, worktreeId: 'wt-1' }
    })
    expect(artifactsForSession([mine, sibling], target).map((r) => r.slug)).toEqual(['mine'])
  })

  it('matches only the focused pane of a split terminal tab', () => {
    const left = record('left', { origin: { paneKey: `tab-a:${LEAF_A}` } })
    const right = record('right', { origin: { paneKey: `tab-a:${LEAF_B}` } })
    expect(
      artifactsForSession([left, right], { ...target, leafId: LEAF_B }).map((r) => r.slug)
    ).toEqual(['right'])
  })

  it('shows no workspace-only or origin-less record, even one whose file is in the folder', () => {
    // Conversations share one folder, so these matched every conversation in it (one page everywhere).
    const workspaceOnly = record('workspace', { origin: { worktreeId: 'wt-1' } })
    const legacyInside = record('inside', { sourceKey: '/repo/wt-1/docs/plan.md' })
    expect(artifactsForSession([workspaceOnly, legacyInside], target)).toEqual([])
  })

  it('returns nothing when no session is on screen or none of its artifacts exist', () => {
    expect(artifactsForSession([record('a')], null)).toEqual([])
    expect(artifactsForSession([], target)).toEqual([])
    expect(artifactsForSession([record('a')], target)).toEqual([])
  })

  it('orders the session artifacts most recent first', () => {
    const origin = { paneKey: `tab-a:${LEAF_A}` }
    const older = record('older', { savedAt: 10, origin })
    const newer = record('newer', { savedAt: 20, origin })
    const unknown = record('unknown', { savedAt: null, origin })
    expect(artifactsForSession([older, unknown, newer], target).map((r) => r.slug)).toEqual([
      'newer',
      'older',
      'unknown'
    ])
  })
})
