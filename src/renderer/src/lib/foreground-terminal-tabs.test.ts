import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  forgetForegroundTerminalTabs,
  getForegroundTerminalTabIds,
  getForegroundTerminalTabLastSeenAtById,
  getForegroundTerminalTabRevealedAt,
  registerVisibleTerminalTab,
  resetForegroundTerminalTabIdsForTests,
  setForegroundTerminalTabIds
} from './foreground-terminal-tabs'
import {
  notePersonInputForRevealEvidence,
  resetPersonRevealEvidenceForTests,
  wasTerminalTabRevealedByPerson
} from './launch-trigger/person-reveal-evidence'

afterEach(() => {
  resetForegroundTerminalTabIdsForTests()
  resetPersonRevealEvidenceForTests()
  vi.useRealTimers()
})

describe('foreground terminal tabs', () => {
  it('returns the union of explicit foreground ids and visible terminal claims', () => {
    setForegroundTerminalTabIds(['tab-explicit', null, '', undefined])
    const unregister = registerVisibleTerminalTab('tab-visible')

    expect(getForegroundTerminalTabIds().sort()).toEqual(['tab-explicit', 'tab-visible'])

    unregister()
    expect(getForegroundTerminalTabIds()).toEqual(['tab-explicit'])
  })

  it('keeps duplicate visible terminal tab claims until every token unregisters', () => {
    const unregisterFirst = registerVisibleTerminalTab('tab-visible')
    const unregisterSecond = registerVisibleTerminalTab('tab-visible')

    expect(getForegroundTerminalTabIds()).toEqual(['tab-visible'])

    unregisterFirst()
    expect(getForegroundTerminalTabIds()).toEqual(['tab-visible'])

    unregisterSecond()
    expect(getForegroundTerminalTabIds()).toEqual([])
  })

  it('records last-seen timestamps for explicit foreground entries and clears them in tests', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)

    setForegroundTerminalTabIds(['tab-explicit', null, '', undefined])

    expect(getForegroundTerminalTabLastSeenAtById()).toEqual({ 'tab-explicit': 1_000 })

    resetForegroundTerminalTabIdsForTests()
    expect(getForegroundTerminalTabLastSeenAtById()).toEqual({})
  })

  it('refreshes last-seen when explicit foreground ids leave the combined foreground set', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    setForegroundTerminalTabIds(['tab-old'])

    vi.setSystemTime(2_000)
    setForegroundTerminalTabIds(['tab-new'])

    expect(getForegroundTerminalTabLastSeenAtById()).toEqual({
      'tab-old': 2_000,
      'tab-new': 2_000
    })
  })

  it('does not refresh an explicit foreground removal while a visible claim remains', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    setForegroundTerminalTabIds(['tab-combined'])

    vi.setSystemTime(2_000)
    const unregister = registerVisibleTerminalTab('tab-combined')

    vi.setSystemTime(3_000)
    setForegroundTerminalTabIds([])

    expect(getForegroundTerminalTabIds()).toEqual(['tab-combined'])
    expect(getForegroundTerminalTabLastSeenAtById()).toEqual({ 'tab-combined': 2_000 })

    vi.setSystemTime(4_000)
    unregister()

    expect(getForegroundTerminalTabLastSeenAtById()).toEqual({ 'tab-combined': 4_000 })
  })

  it('refreshes visible-claim last-seen only when the last claim leaves', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const unregisterFirst = registerVisibleTerminalTab('tab-visible')

    vi.setSystemTime(2_000)
    const unregisterSecond = registerVisibleTerminalTab('tab-visible')

    vi.setSystemTime(3_000)
    unregisterFirst()

    expect(getForegroundTerminalTabIds()).toEqual(['tab-visible'])
    expect(getForegroundTerminalTabLastSeenAtById()).toEqual({ 'tab-visible': 2_000 })

    vi.setSystemTime(4_000)
    unregisterSecond()

    expect(getForegroundTerminalTabIds()).toEqual([])
    expect(getForegroundTerminalTabLastSeenAtById()).toEqual({ 'tab-visible': 4_000 })
  })

  it('keeps visible-claim cleanup idempotent for last-seen timestamps', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const unregister = registerVisibleTerminalTab('tab-visible')

    vi.setSystemTime(2_000)
    unregister()

    vi.setSystemTime(3_000)
    unregister()

    expect(getForegroundTerminalTabLastSeenAtById()).toEqual({ 'tab-visible': 2_000 })
  })

  it('records when each foreground visit began, never when it ended', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const releaseFirst = registerVisibleTerminalTab('tab-a')
    vi.setSystemTime(2_000)
    // A second pane of the same tab, and the page-level foreground set, extend the same visit.
    const releaseSecond = registerVisibleTerminalTab('tab-a')
    setForegroundTerminalTabIds(['tab-a'])
    expect(getForegroundTerminalTabRevealedAt('tab-a')).toBe(1_000)

    vi.setSystemTime(3_000)
    releaseFirst()
    releaseSecond()
    setForegroundTerminalTabIds([])
    // Leaving stamps last-seen (the sleep timer), not the reveal.
    expect(getForegroundTerminalTabLastSeenAtById()['tab-a']).toBe(3_000)
    expect(getForegroundTerminalTabRevealedAt('tab-a')).toBe(1_000)

    vi.setSystemTime(4_000)
    setForegroundTerminalTabIds(['tab-a'])
    expect(getForegroundTerminalTabRevealedAt('tab-a')).toBe(4_000)

    forgetForegroundTerminalTabs(['tab-a'])
    expect(getForegroundTerminalTabRevealedAt('tab-a')).toBeUndefined()
  })
})

describe('foreground entries for person reveal evidence (latency telemetry)', () => {
  it('decides once per foreground visit, not per sibling claim or explicit refresh', () => {
    // Startup: the tab on screen at boot has no person press before it.
    const unregisterStartup = registerVisibleTerminalTab('tab-a')
    expect(wasTerminalTabRevealedByPerson('tab-a')).toBe(false)

    notePersonInputForRevealEvidence()
    // Same visit: a sibling pane's claim and explicit-list churn do not re-decide it.
    const unregisterSibling = registerVisibleTerminalTab('tab-a')
    setForegroundTerminalTabIds(['tab-a'])
    setForegroundTerminalTabIds([])
    setForegroundTerminalTabIds(['tab-a'])
    expect(wasTerminalTabRevealedByPerson('tab-a')).toBe(false)

    // A tab brought on screen right after the press is a person reveal.
    setForegroundTerminalTabIds(['tab-b'])
    expect(wasTerminalTabRevealedByPerson('tab-b')).toBe(true)

    unregisterStartup()
    unregisterSibling()
  })

  it('decides again when a tab leaves the foreground and a person brings it back', () => {
    setForegroundTerminalTabIds(['tab-a'])
    expect(wasTerminalTabRevealedByPerson('tab-a')).toBe(false)
    setForegroundTerminalTabIds([])

    notePersonInputForRevealEvidence()
    const unregister = registerVisibleTerminalTab('tab-a')
    expect(wasTerminalTabRevealedByPerson('tab-a')).toBe(true)
    unregister()
  })
})

describe('one reveal source for the restore flood guard and the launch trigger', () => {
  it('stamps the reveal start and decides person evidence on the same visit, once', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    // Startup: on screen before any press — a reveal start for the guard, no person for #926.
    const unregister = registerVisibleTerminalTab('tab-a')
    expect(getForegroundTerminalTabRevealedAt('tab-a')).toBe(1_000)
    expect(wasTerminalTabRevealedByPerson('tab-a')).toBe(false)
    unregister()

    // A person brings it back: both readers see the new visit begin, at the same moment.
    vi.setSystemTime(5_000)
    notePersonInputForRevealEvidence()
    setForegroundTerminalTabIds(['tab-a'])
    expect(getForegroundTerminalTabRevealedAt('tab-a')).toBe(5_000)
    expect(wasTerminalTabRevealedByPerson('tab-a')).toBe(true)

    // A sibling claim during the visit changes neither.
    vi.setSystemTime(6_000)
    const sibling = registerVisibleTerminalTab('tab-a')
    expect(getForegroundTerminalTabRevealedAt('tab-a')).toBe(5_000)
    expect(wasTerminalTabRevealedByPerson('tab-a')).toBe(true)
    sibling()
  })
})
