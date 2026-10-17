import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IdleKeepReading } from '../../../shared/idle-auto-close-settings'
import { useAppStore } from '@/store'
import { agentProcessKeepReason, type ProcessInspection } from './agent-sleep-guards'
import {
  agentGone,
  guardDeps,
  HIBERNATION,
  install,
  linesFor,
  PANE,
  quiet,
  setUpAgentSleepTest,
  tearDownAgentSleepTest,
  ticks
} from './agent-sleep-test-fixture'

const { readKeep, inspectProcess } = guardDeps

beforeEach(setUpAgentSleepTest)
afterEach(tearDownAgentSleepTest)

function reading(overrides: Partial<IdleKeepReading>): IdleKeepReading {
  return { ...quiet({ paneKey: PANE }), ...overrides }
}

function inspection(
  foregroundProcess: string | null,
  hasChildProcesses: boolean
): ProcessInspection {
  return { foregroundProcess, hasChildProcesses }
}

const GONE = { state: 'exited', agentForeground: false } as const
const UNREADABLE_PROCESSES: ProcessInspection = {
  foregroundProcess: null,
  hasChildProcesses: false,
  unavailable: true
}

describe('R1 sleeps only an agent it can prove is there (requirement 2)', () => {
  it.each<[string, Partial<IdleKeepReading>, ProcessInspection, string | null]>([
    ['its own idle agent, proven', {}, inspection('claude', true), null],
    ['a bare login shell left behind', GONE, inspection('-zsh', false), 'shell-foreground'],
    ['a dev server after the agent exited', GONE, inspection('node', true), 'foreground-not-agent'],
    [
      'an editor main reads idle by a stale title',
      { agentForeground: false },
      inspection('vim', false),
      'foreground-not-agent'
    ],
    [
      'another agent kind holding the pane',
      { agentForeground: false },
      inspection('codex', true),
      'foreground-not-agent'
    ],
    [
      'a suspended agent (shell with children)',
      { state: 'unknown', agentForeground: false },
      inspection('zsh', true),
      'foreground-not-agent'
    ],
    ['an agent behind an sh wrapper', {}, inspection('sh', true), 'foreground-not-agent'],
    ['a bare shell main ties to the agent', {}, inspection('zsh', false), 'foreground-not-agent'],
    ['no proof either way', { agentForeground: null }, inspection('node', true), 'process-unknown'],
    ['a state nothing proves', { state: 'unknown' }, inspection('claude', true), 'unreadable'],
    ['processes that cannot be read', {}, UNREADABLE_PROCESSES, 'process-unknown']
  ])('%s', (_label, overrides, processes, keep) => {
    expect(agentProcessKeepReason(reading(overrides), processes)).toBe(keep)
  })

  it('never kills a dev server started after the agent exited, nor writes a resume record', async () => {
    const shutdown = install(HIBERNATION)
    readKeep.mockImplementation(async (targets) => targets.map(agentGone))
    inspectProcess.mockResolvedValue(inspection('node', true))
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[PANE]).toBeUndefined()
    // Nor is the entry dropped: something the person runs holds the pane.
    expect(useAppStore.getState().agentStatusByPaneKey[PANE]).toBeDefined()
    expect(linesFor('hibernation.drop-stale-done')).toEqual([])
  })

  it('keeps a pane whose foreground main cannot tie to its agent', async () => {
    const shutdown = install(HIBERNATION)
    readKeep.mockImplementation(async (targets) =>
      targets.map((target) => ({ ...quiet(target), agentForeground: null }))
    )
    inspectProcess.mockResolvedValue(inspection('node', true))
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('does not drop a suspended agent’s entry (its shell has children)', async () => {
    const shutdown = install(HIBERNATION)
    readKeep.mockImplementation(async (targets) =>
      targets.map((target) => ({ ...quiet(target), state: 'unknown', agentForeground: false }))
    )
    inspectProcess.mockResolvedValue(inspection('zsh', true))
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentStatusByPaneKey[PANE]).toBeDefined()
    expect(linesFor('hibernation.drop-stale-done')).toEqual([])
  })

  it.each(['exited', 'unknown'])(
    'keeps a pane main reads %s even with its agent’s name in the foreground',
    async (state) => {
      const shutdown = install(HIBERNATION)
      readKeep.mockImplementation(async (targets) =>
        targets.map((target) => ({ ...quiet(target), state }))
      )
      inspectProcess.mockResolvedValue(inspection('claude', true))
      await ticks(3)
      expect(shutdown).not.toHaveBeenCalled()
    }
  )
})
