import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStewardSwitches } from './steward-switches'
import { CLEANUP_NOT_STARTED } from './cleanup-runs'
import {
  DAY_MS,
  MORNING,
  capacityRow,
  createCleanupHarness,
  settleLaunch
} from './cleanup-runs-test-fixture'

let dir = ''
let restoreSwitches: () => void = () => {}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-cleanup-runs-'))
  restoreSwitches = configureStewardSwitches({ readSettings: () => undefined, environment: {} })
})

afterEach(() => {
  restoreSwitches()
  rmSync(dir, { recursive: true, force: true })
})

function stateFile(): { active?: { runId?: string }; taken: { outcome?: string }[] } {
  return JSON.parse(readFileSync(join(dir, 'session-steward', 'cleanup.json'), 'utf8'))
}

describe('the cleanup reservation', () => {
  it('lets the detector and a click at the same moment start exactly one run', async () => {
    const h = createCleanupHarness(dir)

    const detector = h.controller.admit('automatic', ['Stalled: checkout fix'])
    const click = h.controller.admit('manual')

    expect(detector.ok).toBe(true)
    expect(click).toMatchObject({ ok: false, reason: 'running' })
    // Why: the reservation is on disk before admit returns, before any run exists.
    expect(stateFile().active).toBeDefined()
    await settleLaunch(h.controller)
    expect(h.deps.runNow).toHaveBeenCalledOnce()
    expect(h.runs.map((run) => run.trigger)).toEqual(['automatic'])
    expect(h.runs[0]?.promptOverride).toContain('- Stalled: checkout fix')
  })

  it('records a detector run as automatic and a click as manual', async () => {
    const h = createCleanupHarness(dir)
    h.controller.admit('automatic')
    await settleLaunch(h.controller)
    h.write('run-1', 'completed')
    h.clock.now += 60_000
    expect(h.controller.admit('manual').ok).toBe(true)
    await settleLaunch(h.controller)

    expect(h.runs.map((run) => [run.id, run.trigger])).toEqual([
      ['run-1', 'automatic'],
      ['run-2', 'manual']
    ])
    expect(vi.mocked(h.deps.runNow).mock.calls[1]?.[1]).not.toHaveProperty('trigger')
  })

  it('keeps the slot through a restart until the run is reconciled, never starting a second', async () => {
    const h = createCleanupHarness(dir)
    h.controller.admit('automatic')
    await settleLaunch(h.controller)
    h.write('run-1', 'dispatched', { terminalPaneKey: 'tab-c:leaf-1', terminalPtyId: 'pty-1' })

    const after = h.restart()
    expect(after.admit('manual')).toMatchObject({ ok: false, reason: 'running' })
    expect(after.admit('automatic')).toMatchObject({ ok: false, reason: 'running' })
    // The service's startup reconciliation strands the run it lost; only then does the slot free.
    h.write('run-1', 'dispatch_failed', { error: 'lost the terminal' })
    expect(after.admit('manual').ok).toBe(true)
    await settleLaunch(h.controller)
    expect(h.deps.runNow).toHaveBeenCalledTimes(2)
  })

  it('frees a reservation whose run was never created, without launching one', () => {
    const path = join(dir, 'session-steward', 'cleanup.json')
    mkdirSync(dirname(path), { recursive: true })
    const at = new Date('2026-09-25T08:59:00').getTime()
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        active: { reservationId: 'r-1', source: 'automatic', takenAt: at },
        taken: [{ reservationId: 'r-1', source: 'automatic', day: '2026-09-25', at }],
        skipped: []
      })
    )
    const h = createCleanupHarness(dir)
    h.controller.start()

    expect(stateFile().active).toBeUndefined()
    expect(stateFile().taken[0]?.outcome).toBe('not-started')
    expect(h.deps.runNow).not.toHaveBeenCalled()
    expect(h.controller.view().automaticToday).toBe(1)
  })

  it('fails a run a restart left pending, and only then frees the slot', async () => {
    const h = createCleanupHarness(dir)
    h.controller.admit('manual')
    await settleLaunch(h.controller)
    h.write('run-1', 'pending')

    const after = h.restart()
    await settleLaunch(h.controller)
    expect(h.deps.failRun).toHaveBeenCalledWith('run-1', CLEANUP_NOT_STARTED)
    expect(h.runs[0]?.status).toBe('dispatch_failed')
    expect(after.admit('automatic').ok).toBe(true)
    await settleLaunch(after)
  })

  it('refuses a fourth automatic reservation in a day, counting runs that never started', async () => {
    const h = createCleanupHarness(dir)
    vi.mocked(h.deps.runNow).mockRejectedValueOnce(new Error('no window'))
    for (let index = 0; index < 3; index += 1) {
      expect(h.controller.admit('automatic').ok).toBe(true)
      await settleLaunch(h.controller)
      const run = h.runs.at(-1)
      if (run && run.status !== 'completed') {
        h.write(run.id, 'completed')
      }
      h.clock.now += 60_000
    }
    expect(h.runs).toHaveLength(2)

    expect(h.controller.admit('automatic')).toMatchObject({ ok: false, reason: 'daily-cap' })
    expect(h.controller.view().skipped[0]).toMatchObject({ reason: 'daily-cap' })
    // A click is the person asking: never capped.
    expect(h.controller.admit('manual').ok).toBe(true)
    await settleLaunch(h.controller)
    h.write(h.runs.at(-1)!.id, 'completed')
    h.clock.now += DAY_MS
    h.snapshot.value = {
      claude: [capacityRow('claude', h.clock.now)],
      codex: [],
      builtAt: h.clock.now
    }
    expect(h.controller.admit('automatic').ok).toBe(true)
    await settleLaunch(h.controller)
  })

  it('skips as capacity (codex) when Codex is chosen and its account is limited, whatever Claude has', async () => {
    const h = createCleanupHarness(dir)
    h.controller.admit('manual')
    await settleLaunch(h.controller)
    h.write('run-1', 'completed')
    h.automations[0]!.agentId = 'codex'
    h.snapshot.value = {
      claude: [capacityRow('claude', h.clock.now)],
      codex: [capacityRow('codex', h.clock.now, { state: 'limited', limitedUntil: null })],
      builtAt: h.clock.now
    }

    expect(h.controller.admit('automatic')).toEqual({
      ok: false,
      reason: 'capacity',
      detail: 'capacity (codex)'
    })
    h.clock.now += 60_000
    h.controller.admit('automatic')
    expect(h.controller.view().skipped).toEqual([
      expect.objectContaining({
        reason: 'capacity',
        detail: 'capacity (codex)',
        why: 'the account is limited',
        count: 2
      })
    ])
    expect(h.deps.runNow).toHaveBeenCalledOnce()
  })

  it('treats a stale or missing usage reading as no capacity', () => {
    const h = createCleanupHarness(dir)
    h.snapshot.value = {
      claude: [capacityRow('claude', h.clock.now, { readingAt: h.clock.now - 10 * 60_000 })],
      codex: [],
      builtAt: h.clock.now
    }
    expect(h.controller.admit('automatic')).toMatchObject({ reason: 'capacity' })
    h.snapshot.value = null
    expect(h.controller.admit('automatic')).toMatchObject({ reason: 'capacity' })
    h.snapshot.value = {
      claude: [
        capacityRow('claude', h.clock.now, {
          fiveHour: { remainingPercent: 12, resetsAt: null, windowMinutes: 300 }
        })
      ],
      codex: [],
      builtAt: h.clock.now
    }
    expect(h.controller.admit('automatic')).toMatchObject({ reason: 'capacity' })
    expect(h.controller.view().skipped[0]?.why).toBe('only 12% of its usage is left')
  })

  it('honours the automatic switch and the env stop for automatic runs only', async () => {
    restoreSwitches()
    restoreSwitches = configureStewardSwitches({
      readSettings: () => ({ automaticCleanup: false }),
      environment: {}
    })
    const h = createCleanupHarness(dir)
    expect(h.controller.admit('automatic')).toMatchObject({ ok: false, reason: 'disabled' })
    restoreSwitches()
    restoreSwitches = configureStewardSwitches({
      readSettings: () => undefined,
      environment: { OMNI_STEWARD_DISABLED: '1' }
    })
    expect(h.controller.admit('automatic')).toMatchObject({
      ok: false,
      reason: 'disabled',
      detail: expect.stringContaining('OMNI_STEWARD_DISABLED')
    })
    expect(h.controller.view().automaticOn).toBe(false)
    expect(h.controller.admit('manual').ok).toBe(true)
    // Why: an unsettled launch still writes into `dir` while afterEach removes it (ENOTEMPTY).
    await settleLaunch(h.controller)
  })

  it('runs every cleanup in one disabled automation on a fixed folder: no worktree, ever', async () => {
    const h = createCleanupHarness(dir)
    for (let day = 0; day < 8; day += 1) {
      for (let slot = 0; slot < 3; slot += 1) {
        h.snapshot.value = {
          claude: [capacityRow('claude', h.clock.now)],
          codex: [],
          builtAt: h.clock.now
        }
        expect(h.controller.admit('automatic').ok).toBe(true)
        await settleLaunch(h.controller)
        h.write(h.runs.at(-1)!.id, 'completed')
        h.clock.now += 60_000
      }
      h.clock.now += DAY_MS
    }

    expect(h.runs).toHaveLength(24)
    expect(h.deps.addFolderRepo).toHaveBeenCalledOnce()
    expect(h.deps.createAutomation).toHaveBeenCalledOnce()
    // Only the run that created the folder project waits for the window to load it.
    expect(h.deps.settleNewWorkspace).toHaveBeenCalledOnce()
    expect(h.deps.createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceMode: 'existing',
        workspace: `id:cleanup-repo::${join(dir, 'workspace')}`,
        reuseSession: false,
        enabled: false,
        agentId: 'claude'
      })
    )
    expect(new Set(h.runs.map((run) => run.automationId))).toEqual(new Set(['automation-1']))
  })

  it('makes an automatic run’s pane unattended from dispatch for its whole life, and a click’s never', async () => {
    const h = createCleanupHarness(dir)
    h.controller.admit('automatic')
    await settleLaunch(h.controller)
    h.write('run-1', 'dispatched', { terminalPaneKey: 'tab-c:leaf-1', terminalPtyId: 'pty-1' })
    expect(h.registered.get('tab-c:leaf-1')).toMatchObject({
      source: 'cleanup-run',
      runId: 'run-1'
    })

    h.write('run-1', 'completed')
    expect(h.registered.has('tab-c:leaf-1')).toBe(false)
    expect(h.controller.resolvePane('tab-c:leaf-1')).toMatchObject({ runId: 'run-1' })

    h.controller.admit('manual')
    await settleLaunch(h.controller)
    h.write('run-2', 'dispatched', { terminalPaneKey: 'tab-m:leaf-1' })
    expect(h.registered.has('tab-m:leaf-1')).toBe(false)
    expect(h.controller.resolvePane('tab-m:leaf-1')).toBeNull()
  })

  it('keeps checking a finished automatic run’s terminal for two hours, and never a click’s', async () => {
    const h = createCleanupHarness(dir)
    h.controller.admit('automatic')
    await settleLaunch(h.controller)
    h.write('run-1', 'completed', { terminalPaneKey: 'tab-c:leaf-1', terminalPtyId: 'pty-1' })
    h.clock.now += 60_000
    h.controller.admit('manual')
    await settleLaunch(h.controller)
    h.write('run-2', 'completed', { terminalPaneKey: 'tab-m:leaf-1', terminalPtyId: 'pty-2' })

    expect(h.controller.liveAutomaticRun()).toBeNull()
    expect(h.controller.lingeringAutomaticRuns()).toEqual([
      { context: { source: 'cleanup-run', runId: 'run-1', since: MORNING }, ptyId: 'pty-1' }
    ])
    h.clock.now = MORNING + 2 * 60 * 60 * 1000 + 1
    expect(h.controller.lingeringAutomaticRuns()).toEqual([])
  })

  it('asks the window to End a finished run’s session, retrying until it answers', async () => {
    const h = createCleanupHarness(dir)
    vi.mocked(h.deps.relay).mockRejectedValueOnce(new Error('No renderer window available'))
    h.controller.admit('automatic')
    await settleLaunch(h.controller)
    h.write('run-1', 'completed', { terminalPaneKey: 'tab-c:leaf-1', terminalSessionId: 'tab-c' })
    await settleLaunch(h.controller)
    h.controller.retryEnds()
    await settleLaunch(h.controller)
    h.controller.retryEnds()

    expect(h.deps.relay).toHaveBeenCalledTimes(2)
    expect(h.deps.relay).toHaveBeenLastCalledWith({
      kind: 'scheduleFinish',
      paneKey: 'tab-c:leaf-1',
      tabId: 'tab-c',
      action: 'end'
    })

    h.controller.admit('manual')
    await settleLaunch(h.controller)
    h.write('run-2', 'dispatch_failed', { terminalPaneKey: 'tab-m:leaf-1' })
    expect(h.deps.relay).toHaveBeenCalledTimes(2)
  })

  it('rebuilds an unreadable record from the run store and keeps a live run’s slot', () => {
    const seed = createCleanupHarness(dir)
    seed.automations.push({
      id: 'automation-1',
      creationKey: 'session-steward-cleanup'
    } as never)
    seed.addRun({
      id: 'run-9',
      automationId: 'automation-1',
      status: 'dispatched',
      trigger: 'automatic'
    })
    const path = join(dir, 'session-steward', 'cleanup.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{ not json')

    const after = seed.restart()
    expect(after.admit('manual')).toMatchObject({ ok: false, reason: 'running' })
    expect(stateFile().active?.runId).toBe('run-9')
  })
})
