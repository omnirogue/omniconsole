import { describe, expect, it } from 'vitest'
import { resolvePaneLaunchTrigger, type PaneLaunchFacts } from './pane-launch-trigger'

const base: PaneLaunchFacts = {
  resumesAgentSession: false,
  hibernationWakeInFlight: false,
  sleepingRecord: null,
  hasStartupCommand: true,
  visible: true,
  revealedByPerson: true
}

describe('resolvePaneLaunchTrigger', () => {
  it('never labels restore-interrupted itself (only main knows the pane was mid-turn)', () => {
    const results = new Set<string>()
    for (const resumesAgentSession of [true, false]) {
      for (const hibernationWakeInFlight of [true, false]) {
        for (const origin of ['quit', 'live', 'worktree-sleep', undefined] as const) {
          for (const visible of [true, false]) {
            for (const revealedByPerson of [true, false]) {
              results.add(
                resolvePaneLaunchTrigger({
                  ...base,
                  resumesAgentSession,
                  hibernationWakeInFlight,
                  sleepingRecord: { origin },
                  visible,
                  revealedByPerson
                })
              )
            }
          }
        }
      }
    }
    expect(results.has('restore-interrupted')).toBe(false)
  })

  it('labels a hibernated pane waking, whatever woke it', () => {
    expect(resolvePaneLaunchTrigger({ ...base, hibernationWakeInFlight: true })).toBe(
      'hibernation-wake'
    )
    expect(
      resolvePaneLaunchTrigger({
        ...base,
        resumesAgentSession: true,
        sleepingRecord: { origin: 'worktree-sleep' },
        visible: false
      })
    ).toBe('hibernation-wake')
    expect(
      resolvePaneLaunchTrigger({ ...base, resumesAgentSession: true, sleepingRecord: {} })
    ).toBe('hibernation-wake')
  })

  it('splits a cold-restore resume by who could see the pane and who revealed it', () => {
    const resume = {
      ...base,
      resumesAgentSession: true,
      sleepingRecord: { origin: 'quit' as const }
    }
    expect(resolvePaneLaunchTrigger(resume)).toBe('person-reveal')
    expect(resolvePaneLaunchTrigger({ ...resume, visible: false, revealedByPerson: false })).toBe(
      'background-mount'
    )
    expect(resolvePaneLaunchTrigger({ ...resume, visible: false, revealedByPerson: true })).toBe(
      'background-mount'
    )
    expect(resolvePaneLaunchTrigger({ ...resume, revealedByPerson: false })).toBe(
      'cold-restore-mount'
    )
    expect(
      resolvePaneLaunchTrigger({
        ...base,
        resumesAgentSession: true,
        sleepingRecord: { origin: 'live' },
        visible: false
      })
    ).toBe('background-mount')
  })

  it('labels a fresh startup command as a new launch, visible or not', () => {
    expect(resolvePaneLaunchTrigger(base)).toBe('new')
    expect(resolvePaneLaunchTrigger({ ...base, visible: false, revealedByPerson: false })).toBe(
      'new'
    )
  })

  it('labels the startup cold restore of the visible active tab as a restore, not a reveal', () => {
    // After a restart the daemon has no live session for the active tab's panes: they
    // resume visible (and in the active tab) before any person has touched the app.
    for (const origin of ['quit', 'live'] as const) {
      expect(
        resolvePaneLaunchTrigger({
          ...base,
          resumesAgentSession: true,
          sleepingRecord: { origin },
          visible: true,
          revealedByPerson: false
        })
      ).toBe('cold-restore-mount')
    }
  })

  it('names a fresh plain shell as new', () => {
    expect(resolvePaneLaunchTrigger({ ...base, hasStartupCommand: false })).toBe('new')
  })
})
