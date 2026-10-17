import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../../../shared/automations-types'
import {
  routineNextRunDetail,
  routineRowCaption,
  routineRowIndicator,
  routineRowState
} from './routine-row-details'

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0)
const HOUR = 60 * 60 * 1000

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a',
    name: 'Nightly',
    rrule: '0 0 * * *',
    enabled: true,
    nextRunAt: NOW + 2 * HOUR,
    ...overrides
  } as Automation
}

describe('routineRowState / routineRowIndicator', () => {
  it('is idle with no mark while the next run is ahead', () => {
    expect(routineRowState(automation(), NOW)).toBe('idle')
    expect(routineRowIndicator(automation(), NOW)).toBeNull()
  })

  it('is due once the scheduled time has passed without moving on', () => {
    const due = automation({ nextRunAt: NOW - 1 })
    expect(routineRowState(due, NOW)).toBe('due')
    expect(routineRowIndicator(due, NOW)).toBe('due')
    expect(routineRowState(automation({ nextRunAt: NOW }), NOW)).toBe('due')
  })

  it('reads paused before due: a paused routine never claims to be due', () => {
    const paused = automation({ enabled: false, nextRunAt: NOW - HOUR })
    expect(routineRowState(paused, NOW)).toBe('paused')
    expect(routineRowIndicator(paused, NOW)).toBe('paused')
  })
})

describe('routineRowCaption', () => {
  it('prints the schedule and the next run for an active routine', () => {
    expect(routineRowCaption(automation(), NOW)).toEqual(['Daily at 12:00 AM', 'Next in 2 hours'])
  })

  it('prints the schedule with Paused and no next run for a paused one', () => {
    expect(routineRowCaption(automation({ enabled: false }), NOW)).toEqual([
      'Daily at 12:00 AM · Paused'
    ])
  })

  it('drops the next-run line once the time has passed', () => {
    expect(routineRowCaption(automation({ nextRunAt: NOW - 1 }), NOW)).toEqual([
      'Daily at 12:00 AM'
    ])
  })
})

describe('routineNextRunDetail', () => {
  it('gives the relative time with the exact time for the title', () => {
    const detail = routineNextRunDetail(automation(), NOW)!
    expect(detail.text).toBe('in 2 hours')
    expect(detail.title).toMatch(/18/)
  })

  it('says Due now once the time has passed, and nothing while paused', () => {
    expect(routineNextRunDetail(automation({ nextRunAt: NOW - 1 }), NOW)?.text).toBe('Due now')
    expect(routineNextRunDetail(automation({ enabled: false }), NOW)).toBeNull()
  })
})
