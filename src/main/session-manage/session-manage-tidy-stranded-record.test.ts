import { describe, expect, it } from 'vitest'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import { recordOnlyMirrorDeleteRefusal } from './session-manage-delete-guard'
import { classifySessionTidyFor } from './session-manage-tidy'
import { manageEntry, sidebarRow } from './session-manage-test-fixtures'

// Live (6 Oct): six Studio rows were only its records of MacBook worktrees deleted there
// (…/omnirogue-worktrees/review-1411-1412-*): no host it can name, no workspace anyone lists.
const PANE =
  'web-terminal-b8fa480c-cd79-4cb2-a1a5-6fcb1945ae70:fe7341de-955f-48bc-bdfb-ad8ed4dae623'
const STRANDED = {
  ...sidebarRow(),
  paneKey: PANE,
  tabId: null,
  hostId: null,
  ownershipUnverified: 'absence-unverified' as const,
  strandedMirrorRecord: true as const
}
const NOW = 10 * 60 * 60_000

function entry(overrides: Partial<SessionManageEntry> = {}): SessionManageEntry {
  return manageEntry({
    paneKey: PANE,
    tabId: null,
    hostId: null,
    title: STRANDED.title,
    verdict: 'unverifiable',
    state: 'unknown',
    ...overrides
  })
}

const classify = (
  mode: Parameters<typeof classifySessionTidyFor>[0],
  overrides: Partial<SessionManageEntry> = {},
  include: string[] = []
) => classifySessionTidyFor(mode, STRANDED, entry(overrides), null, new Set(include))

describe('a stranded record of another computer’s pane (A4)', () => {
  it('is kept by ordinary tidy and by tidy --delete without --unverified', () => {
    expect(classify({ now: NOW })).toMatchObject({ action: 'skip' })
    const kept = classify({ delete: true, now: NOW })
    expect(kept).toMatchObject({ action: 'skip', group: 'unverifiable' })
    expect(kept.reason).toContain('add --unverified')
  })

  it('is deleted by tidy --delete --unverified, which drops only this computer’s record', () => {
    const verdict = classify({ delete: true, unverified: true, now: NOW })
    expect(verdict).toMatchObject({ action: 'delete', unverified: true })
    expect(verdict.reason).toContain('nothing runs or ends anywhere')
  })

  it('still keeps pinned, saved and recently active ones unless named', () => {
    const mode = { delete: true, unverified: true, now: NOW }
    expect(classify(mode, { pinned: true }).group).toBe('pinned')
    expect(classify(mode, { saved: true }).group).toBe('saved')
    expect(classify(mode, { lastActivityAt: NOW - 60_000 }).action).toBe('skip')
    expect(classify(mode, { lastActivityAt: NOW - 60_000 }, [PANE]).action).toBe('delete')
  })

  it('a host-less row that is not a stranded record is still kept, --unverified or not', () => {
    const verdict = classifySessionTidyFor(
      { delete: true, unverified: true, now: NOW },
      { ...STRANDED, strandedMirrorRecord: undefined },
      entry(),
      null,
      new Set([PANE])
    )
    expect(verdict).toMatchObject({ action: 'skip', group: 'unverifiable' })
  })

  it('omni session delete lets it go only with --unverified, stranded or with a named host', () => {
    for (const stranded of [true, false]) {
      const refusal = recordOnlyMirrorDeleteRefusal('Old review', { unverified: false }, stranded)
      expect(refusal).toContain('--unverified')
      expect(refusal).not.toContain('delete it there')
      expect(recordOnlyMirrorDeleteRefusal('Old review', { unverified: true }, stranded)).toBeNull()
    }
  })
})
