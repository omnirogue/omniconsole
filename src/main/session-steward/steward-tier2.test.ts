import { describe, expect, it } from 'vitest'
import { manageEntry } from '../session-manage/session-manage-test-fixtures'
import {
  STEWARD_TIER2_QUIET_MS,
  stewardLastActivityAt,
  stewardTier2Verdict,
  type StewardTier2Input
} from './steward-tier2'

const NOW = 100 * STEWARD_TIER2_QUIET_MS
const FINISHED = { turnKey: 't1', resolved: 0.93, remainingWork: 0.04, unsure: false }

function input(overrides: Partial<StewardTier2Input> = {}): StewardTier2Input {
  return {
    row: {
      hostUnavailable: false,
      launchPending: false,
      doneArchivePolicy: {
        revision: 'done',
        since: NOW - 7 * 3_600_000,
        delayMs: STEWARD_TIER2_QUIET_MS
      }
    },
    entry: manageEntry(),
    hold: null,
    waitedOnBy: [],
    heldDelivery: false,
    lastActivityAt: NOW - 7 * 3_600_000,
    now: NOW,
    jevOff: null,
    doneness: FINISHED,
    ...overrides
  }
}

const reason = (overrides: Partial<StewardTier2Input>) => {
  const verdict = stewardTier2Verdict(input(overrides))
  return verdict.ok ? null : verdict.reason
}

describe('Tier 2', () => {
  it('archives an idle, quiet, local session JEV reads as finished, with its evidence', () => {
    expect(stewardTier2Verdict(input())).toEqual({
      ok: true,
      evidence: 'JEV resolved 0.93 · quiet 7 h'
    })
    expect(
      stewardTier2Verdict(
        input({
          entry: manageEntry({ verdict: 'exited', state: 'exited', waitingOn: 'Its agent exited.' })
        })
      ).ok
    ).toBe(true)
  })

  it('refuses anything on another computer or out of sight, first', () => {
    expect(reason({ entry: manageEntry({ hostId: 'ssh:box', pinned: true }) })).toMatch(
      /runs on the SSH host box, not on this computer/
    )
    expect(reason({ entry: manageEntry({ verdict: 'unverifiable', state: 'unknown' }) })).toBe(
      'this computer cannot see it, and that is never read as finished'
    )
    expect(reason({ row: { hostUnavailable: true, launchPending: false } })).toMatch(
      /cannot see it/
    )
  })

  it('refuses a session with anything open', () => {
    expect(reason({ entry: manageEntry({ state: 'working' }) })).toBe(
      'it is working, not idle or exited'
    )
    expect(reason({ entry: manageEntry({ queueLength: 1 }) })).toBe(
      'it has prompts waiting in its queue'
    )
    expect(reason({ entry: manageEntry({ pendingSteps: ['x'] }) })).toBe(
      'it has its own next steps waiting'
    )
    expect(reason({ entry: manageEntry({ waitingOn: 'Its plan is waiting for a merge.' }) })).toBe(
      'it is waiting on something (Its plan is waiting for a merge)'
    )
    expect(reason({ heldDelivery: true })).toBe('a held prompt is waiting to be sent to it')
  })

  it('refuses an open recorded commitment, whatever JEV says', () => {
    expect(
      reason({
        hold: 'Its recorded outcomes are not finished.',
        doneness: { ...FINISHED, resolved: 1, remainingWork: 0 }
      })
    ).toBe('its recorded outcomes are not finished')
  })

  it('refuses a session another waits on, a pinned, saved or brought-back one', () => {
    expect(reason({ waitedOnBy: ['tab-9:leaf-1'] })).toBe(
      'another session is waiting on its result'
    )
    expect(reason({ entry: manageEntry({ pinned: true }) })).toBe('it is pinned')
    expect(reason({ entry: manageEntry({ saved: true }) })).toBe('it is saved')
    expect(
      reason({ row: { hostUnavailable: false, launchPending: false, autoArchiveKeep: true } })
    ).toBe('the person brought it back from the archive')
  })

  it('needs the configured continuous Done delay, and never reads an unknown clock as quiet', () => {
    expect(reason({ lastActivityAt: NOW - STEWARD_TIER2_QUIET_MS + 60_000 })).toBe(
      'it has been quiet for 1.9 h; the Done delay has not elapsed'
    )
    expect(reason({ lastActivityAt: null })).toBe(
      'its last activity is unknown, and that is never read as quiet'
    )
    expect(stewardLastActivityAt(null, NOW)).toBeNull()
    expect(stewardLastActivityAt(5, 9, null)).toBe(9)
  })

  it('stops with JEV off or unsure, and archives only a clear finished reading', () => {
    expect(reason({ jevOff: 'JEV is turned off on this computer' })).toBe(
      'JEV is turned off on this computer'
    )
    expect(reason({ doneness: null })).toBe('JEV has no reading of its latest turn')
    expect(reason({ doneness: { ...FINISHED, resolved: 0.6, unsure: true } })).toMatch(
      /^JEV does not read it as finished \(resolved 0\.60/
    )
    expect(reason({ doneness: { ...FINISHED, remainingWork: 0.9 } })).toMatch(/work left 0\.90/)
  })
})
