import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { resolveIdleAutoCloseGate } from '../../../shared/idle-auto-close-settings'
import { useAppStore } from '@/store'
import { registerTerminalPaneVisibility } from './terminal-pane-visibility-registry'
import {
  cleanups,
  entry,
  guardDeps,
  install,
  linesFor,
  MIN,
  NOW,
  PANE,
  quiet,
  setUpAgentSleepTest,
  tearDownAgentSleepTest,
  ticks
} from './agent-sleep-test-fixture'

// Why: #928's idle rules act in `on` only while the restore flood guard is on, and until #927 was
// merged nothing set it. The guard now ships on by default (every loaded profile carries it), so
// switching the idle rules to `on` over the app defaults acts — and G1-G4 still keep every pane.

const DEFAULTS = getDefaultSettings('/Users/maintainer')
const ON_OVER_DEFAULTS = { ...DEFAULTS, idleAutoCloseMode: 'on' as const }

beforeEach(setUpAgentSleepTest)
afterEach(tearDownAgentSleepTest)

describe('idle rules over the app defaults (restore flood guard on by default)', () => {
  it('the defaults carry the guard on: `on` acts, while the default mode stays a shadow', () => {
    expect(DEFAULTS.restoreFloodGuard).toBe(true)
    expect(resolveIdleAutoCloseGate(DEFAULTS)).toEqual({ mode: 'shadow', act: false })
    expect(resolveIdleAutoCloseGate(ON_OVER_DEFAULTS)).toEqual({ mode: 'on', act: true })
    // The kill switch still refuses.
    const guardOff = { ...ON_OVER_DEFAULTS, restoreFloodGuard: false }
    expect(resolveIdleAutoCloseGate(guardOff)).toEqual({
      mode: 'shadow',
      act: false,
      refused: 'restore-flood-guard-off'
    })
  })

  it('R1 sleeps an idle done agent off screen, with only `on` set over the defaults', async () => {
    const shutdown = install(ON_OVER_DEFAULTS)
    cleanups.push(registerTerminalPaneVisibility('tab-1', { current: false }))
    await ticks(2)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(linesFor('hibernation.sleep')[0]?.audit).toMatchObject({
      rule: 'idle.R1.sleep-done-agent',
      mode: 'on',
      outcome: 'done'
    })
  })

  it('G1: a last reply holding numbered questions keeps it', async () => {
    const shutdown = install(ON_OVER_DEFAULTS, {
      agentStatusByPaneKey: {
        [PANE]: entry({ lastAssistantMessage: 'Before I go on:\n1. Phase 0?\n2. Archive?' })
      }
    })
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('G1: main reading the agent awaiting-user keeps it, though its hook says done', async () => {
    const shutdown = install(ON_OVER_DEFAULTS)
    guardDeps.readKeep.mockImplementation(async (targets) =>
      targets.map((target) => ({ ...quiet(target), state: 'awaiting-user' }))
    )
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('G2: a keystroke in the last 10 minutes keeps it', async () => {
    const shutdown = install(ON_OVER_DEFAULTS)
    useAppStore.getState().recordTerminalInput(PANE, NOW - 5 * MIN)
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('G3: the visible pane is kept', async () => {
    const shutdown = install(ON_OVER_DEFAULTS)
    cleanups.push(registerTerminalPaneVisibility('tab-1', { current: true }))
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('G4: visibility is read again immediately before the shutdown', async () => {
    const shutdown = install(ON_OVER_DEFAULTS)
    const ref = { current: false }
    cleanups.push(registerTerminalPaneVisibility('tab-1', ref))
    guardDeps.readKeep.mockImplementation(async (targets) => {
      ref.current = true // revealed while main answered
      return targets.map(quiet)
    })
    await ticks(3)
    expect(guardDeps.readKeep).toHaveBeenCalled()
    expect(shutdown).not.toHaveBeenCalled()
  })
})
