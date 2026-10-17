import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  OrganizationExecutor,
  OrganizationRecord
} from '../../../shared/session-organization-change'
import {
  getDefaultStewardOrganizeSettings,
  type StewardGuardedFeature,
  type StewardOrganizeMode
} from '../../../shared/session-steward-organize-settings'
import { OrganizationHistoryStore } from '../../session-organization/organization-history-store'
import { StewardAccuracyGuard, stewardGuardTrips } from './steward-accuracy-guard'

const HOUR = 60 * 60 * 1000
const STEWARD: OrganizationExecutor = { kind: 'app', feature: 'steward' }
const PERSON: OrganizationExecutor = { kind: 'person', via: 'sidebar' }

let directory: string
let history: OrganizationHistoryStore
let now: number
let modes: Record<StewardGuardedFeature, StewardOrganizeMode>
let writes: [StewardGuardedFeature, StewardOrganizeMode][]
let created: StewardAccuracyGuard[] = []

function guard(): StewardAccuracyGuard {
  const subject = new StewardAccuracyGuard({
    directory,
    history,
    now: () => now,
    switches: {
      mode: (feature) => modes[feature],
      write: (feature, mode) => {
        writes.push([feature, mode])
        modes[feature] = mode
        return true
      },
      settings: () => getDefaultStewardOrganizeSettings().accuracyGuard
    }
  })
  created.push(subject)
  return subject
}

let seq = 0
function applied(
  kind: OrganizationRecord['kind'],
  sessionKey: string,
  executor: OrganizationExecutor,
  extra: Partial<OrganizationRecord> = {}
): OrganizationRecord {
  const record: OrganizationRecord = {
    opId: `op-${++seq}`,
    kind,
    targets: [{ sessionKey }],
    value: kind === 'move' ? 'folder-steward' : 'Steward title',
    executor,
    phase: 'applied',
    ts: new Date(now).toISOString(),
    ...extra
  }
  history.add(record)
  return record
}

/** Eight steward re-files, an hour apart, one per session. */
function eightRefiles(subject: StewardAccuracyGuard): OrganizationRecord[] {
  return Array.from({ length: 8 }, (_, index) => {
    now += HOUR
    const record = applied('move', `s${index}`, STEWARD, { reason: 'JEV folder fit 0.91' })
    expect(subject.record('refile', record)).toBe(true)
    return record
  })
}

function undo(record: OrganizationRecord): void {
  now += HOUR
  applied(
    'move',
    record.targets[0]!.sessionKey!,
    { kind: 'person', via: 'work' },
    {
      undoOf: record.opId
    }
  )
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'steward-guard-'))
  history = new OrganizationHistoryStore({ directory: join(directory, 'history') })
  now = Date.parse('2026-09-26T08:00:00Z')
  modes = { refile: 'on', retitle: 'on' }
  writes = []
})
afterEach(async () => {
  await Promise.all(created.map((subject) => subject.flush()))
  created = []
  await history.flush()
  await rm(directory, { recursive: true, force: true })
})

describe('steward accuracy guard', () => {
  it('stays on after 2 undone of 8 re-files, pauses after 3, and resumes on one click', async () => {
    const subject = guard()
    const moves = eightRefiles(subject)
    undo(moves[0]!)
    undo(moves[4]!)
    expect(subject.state('refile')).toEqual({ mode: 'on', samples: 8, corrected: 2 })
    expect(subject.notices()).toEqual([])
    expect(writes).toEqual([])

    undo(moves[6]!)
    const paused = subject.state('refile')
    expect(paused).toMatchObject({ mode: 'paused', samples: 8, corrected: 3 })
    expect(writes).toEqual([['refile', 'paused']])
    expect(subject.notices()).toEqual([
      { feature: 'refile', corrected: 3, samples: 8, pausedAt: now }
    ])
    // Re-titling is judged on its own samples.
    expect(subject.state('retitle').mode).toBe('on')

    // A restart keeps the pause and its evidence.
    await subject.flush()
    expect(guard().notices()).toEqual([
      { feature: 'refile', corrected: 3, samples: 8, pausedAt: now }
    ])

    now += HOUR
    const resumed = subject.resume('refile')
    expect(writes.at(-1)).toEqual(['refile', 'on'])
    // Old corrections no longer count: the resume starts a fresh sample.
    expect(resumed).toEqual({ mode: 'on', samples: 0, corrected: 0 })
    expect(subject.notices()).toEqual([])
  })

  it('counts a person changing the same field within 24 hours, not later or another field', () => {
    const subject = guard()
    const moves = eightRefiles(subject)
    now += HOUR
    applied('move', moves[0]!.targets[0]!.sessionKey!, PERSON)
    applied('title', moves[1]!.targets[0]!.sessionKey!, PERSON)
    now += 25 * HOUR
    applied('move', moves[2]!.targets[0]!.sessionKey!, PERSON)
    // Another steward move is not a correction.
    applied('move', moves[3]!.targets[0]!.sessionKey!, STEWARD)
    expect(subject.state('refile')).toMatchObject({ mode: 'on', samples: 8, corrected: 1 })
  })

  it('never pauses on fewer than 5 samples, and ignores what is not a steward re-file', () => {
    const subject = guard()
    const moves = Array.from({ length: 4 }, (_, index) => {
      now += HOUR
      const record = applied('move', `t${index}`, STEWARD)
      subject.record('refile', record)
      return record
    })
    for (const move of moves) {
      undo(move)
    }
    expect(subject.state('refile')).toEqual({ mode: 'on', samples: 4, corrected: 4 })
    const accepted = applied('move', 'x', STEWARD, { request: 'accepted in Work' })
    expect(subject.record('refile', accepted)).toBe(false)
    expect(subject.record('refile', applied('move', 'y', PERSON))).toBe(false)
    expect(subject.record('retitle', applied('move', 'z', STEWARD))).toBe(false)
  })

  it('reads the Settings switch turned back on as a resume', () => {
    const subject = guard()
    const moves = eightRefiles(subject)
    for (const move of moves.slice(0, 3)) {
      undo(move)
    }
    expect(subject.state('refile').mode).toBe('paused')
    modes.refile = 'on'
    expect(subject.state('refile')).toEqual({ mode: 'on', samples: 0, corrected: 0 })
    modes.refile = 'off'
    expect(subject.state('refile').mode).toBe('off')
  })

  it('offers Resume for a feature saved as paused with no record of why', () => {
    modes.retitle = 'paused'
    expect(guard().notices()).toEqual([
      { feature: 'retitle', corrected: 0, samples: 0, pausedAt: now }
    ])
  })

  it('offers no Resume while a steward stop turns the paused feature off', () => {
    const subject = guard()
    for (const move of eightRefiles(subject).slice(0, 3)) {
      undo(move)
    }
    expect(subject.notices()).toHaveLength(1)
    modes.refile = 'off'
    expect(subject.notices()).toEqual([])
    expect(subject.state('refile').paused).toMatchObject({ corrected: 3, samples: 8 })
  })

  it('pauses when undone moves exceed 20%, rounded in the steward’s favour', () => {
    const settings = getDefaultStewardOrganizeSettings().accuracyGuard
    expect(stewardGuardTrips(2, 8, settings)).toBe(false)
    expect(stewardGuardTrips(3, 8, settings)).toBe(true)
    expect(stewardGuardTrips(1, 5, settings)).toBe(false)
    expect(stewardGuardTrips(2, 5, settings)).toBe(true)
    expect(stewardGuardTrips(2, 10, settings)).toBe(false)
    expect(stewardGuardTrips(3, 10, settings)).toBe(true)
    expect(stewardGuardTrips(4, 4, settings)).toBe(false)
  })
})
