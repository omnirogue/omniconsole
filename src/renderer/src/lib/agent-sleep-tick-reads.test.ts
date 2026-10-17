import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as PlanNow from './agent-hibernation-plan-now'
import { currentCandidates } from './agent-hibernation-plan-now'
import {
  entry,
  guardDeps,
  HIBERNATION,
  install,
  layout,
  LEAF,
  linesFor,
  quiet,
  setUpAgentSleepTest,
  tab,
  tearDownAgentSleepTest,
  ticks
} from './agent-sleep-test-fixture'

vi.mock('./agent-hibernation-plan-now', async (importOriginal) => {
  const actual = await importOriginal<typeof PlanNow>()
  return { ...actual, currentCandidates: vi.fn(actual.currentCandidates) }
})

const { readKeep, inspectProcess } = guardDeps
const plans = vi.mocked(currentCandidates)
const LEAVES = [
  LEAF,
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333'
]

beforeEach(() => {
  setUpAgentSleepTest()
  plans.mockClear()
})
afterEach(tearDownAgentSleepTest)

/** Three done agents in three background tabs, all past the window. */
function installThree(settings: object): ReturnType<typeof vi.fn> {
  const ids = [1, 2, 3]
  return install(settings, {
    tabsByWorktree: { 'wt-bg': ids.map((index) => tab(`tab-${index}`)) },
    terminalLayoutsByTabId: Object.fromEntries(
      ids.map((index) => [`tab-${index}`, layout(`pty-${index}`, LEAVES[index - 1])])
    ),
    ptyIdsByTabId: Object.fromEntries(ids.map((index) => [`tab-${index}`, [`pty-${index}`]])),
    agentStatusByPaneKey: Object.fromEntries(
      ids.map((index) => {
        const paneKey = `tab-${index}:${LEAVES[index - 1]}`
        return [
          paneKey,
          entry({
            paneKey,
            tabId: `tab-${index}`,
            providerSession: { key: 'session_id', id: `session-${index}` }
          })
        ]
      })
    )
  })
}

describe('one reading per tick for every confirmed agent', () => {
  it('in shadow asks main once for all of them and never re-plans per pane', async () => {
    const shutdown = installThree({ idleAutoCloseMode: 'shadow' })
    await ticks(2)
    expect(shutdown).not.toHaveBeenCalled()
    expect(readKeep).toHaveBeenCalledTimes(1)
    expect(readKeep.mock.calls[0]![0]).toHaveLength(3)
    expect(inspectProcess).toHaveBeenCalledTimes(3)
    // One plan per tick; no per-pane re-plan when nothing acts.
    expect(plans).toHaveBeenCalledTimes(2)
    expect(linesFor('hibernation.sleep')).toHaveLength(3)
  })

  it("in 'on' re-plans and re-reads only the pane it is about to sleep (G4)", async () => {
    const shutdown = installThree(HIBERNATION)
    await ticks(2)
    expect(shutdown).toHaveBeenCalledTimes(3)
    // The shared reading, then each pane's own reading right before its shutdown.
    expect(readKeep.mock.calls.map(([targets]) => targets.length)).toEqual([3, 1, 1, 1])
    expect(plans).toHaveBeenCalledTimes(2 + 3)
  })

  it('reads no pane a shared reading kept, and acts on none of them', async () => {
    const shutdown = installThree(HIBERNATION)
    readKeep.mockImplementation(async (targets) =>
      targets.map((target) => ({ ...quiet(target), state: 'awaiting-user' }))
    )
    await ticks(2)
    expect(shutdown).not.toHaveBeenCalled()
    expect(readKeep).toHaveBeenCalledTimes(1)
    expect(plans).toHaveBeenCalledTimes(2)
  })

  it('in shadow lets a keep stand 15 minutes before reading the pane again', async () => {
    install({ idleAutoCloseMode: 'shadow' })
    readKeep.mockImplementation(async (targets) =>
      targets.map((target) => ({ ...quiet(target), listed: false }))
    )
    await ticks(2) // confirmed and read at 1 minute
    await ticks(14) // through 15 minutes
    expect(readKeep).toHaveBeenCalledTimes(1)
    await ticks(1) // 16 minutes: the keep has expired
    expect(readKeep).toHaveBeenCalledTimes(2)
  })
})
