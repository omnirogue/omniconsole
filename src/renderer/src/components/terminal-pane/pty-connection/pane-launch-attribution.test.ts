import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { storeState } = vi.hoisted(() => ({
  storeState: {
    settings: { latencyTelemetry: true } as { latencyTelemetry?: boolean } | null
  }
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => storeState }
}))

import { createPaneLaunchDescriber } from './pane-launch-attribution'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { spawnIpcPty } from '../ipc-pty-spawn-request'
import { installIpcPtyWindow, restorePtySpecWindow } from '../pty-transport-test-harness'
import {
  registerVisibleTerminalTab,
  resetForegroundTerminalTabIdsForTests,
  setForegroundTerminalTabIds
} from '@/lib/foreground-terminal-tabs'
import {
  notePersonInputForRevealEvidence,
  resetPersonRevealEvidenceForTests
} from '@/lib/launch-trigger/person-reveal-evidence'

function fakeSession(overrides: {
  visible: boolean
  active: boolean
  tabId?: string
  wakeInFlight?: string | null
  sleepingOrigin?: 'worktree-sleep' | 'quit' | 'live' | null
}): ConnectPanePtySession {
  return {
    pane: {} as never,
    manager: {} as never,
    deps: {
      tabId: overrides.tabId ?? 'tab-1',
      isVisibleRef: { current: overrides.visible },
      isActiveRef: { current: overrides.active }
    } as never,
    hibernatedWakeInFlightClaimKey: overrides.wakeInFlight ?? null,
    getSleepingRecordForPane: () =>
      overrides.sleepingOrigin === undefined || overrides.sleepingOrigin === null
        ? null
        : { paneKey: 'tab-1:pane-1', record: { origin: overrides.sleepingOrigin } }
  }
}

const resumeSpawn = { resumesAgentSession: true, hasStartupCommand: true }

beforeEach(() => {
  storeState.settings = { latencyTelemetry: true }
})

afterEach(() => {
  resetForegroundTerminalTabIdsForTests()
  resetPersonRevealEvidenceForTests()
})

describe('createPaneLaunchDescriber', () => {
  it('labels a restored agent resumed in a tab a person clicked on screen', () => {
    notePersonInputForRevealEvidence()
    registerVisibleTerminalTab('tab-1')
    const describeLaunch = createPaneLaunchDescriber(
      fakeSession({ visible: true, active: true, sleepingOrigin: 'quit' })
    )
    expect(describeLaunch(resumeSpawn)).toEqual({ trigger: 'person-reveal', visible: true })
  })

  it('labels the startup cold restore of the visible active tab as cold-restore-mount', () => {
    // App start: the daemon has no live session, the active tab mounts on screen and its
    // panes resume before any person input.
    registerVisibleTerminalTab('tab-1')
    setForegroundTerminalTabIds(['tab-1'])
    for (const sleepingOrigin of ['quit', 'live'] as const) {
      const describeLaunch = createPaneLaunchDescriber(
        fakeSession({ visible: true, active: true, sleepingOrigin })
      )
      expect(describeLaunch(resumeSpawn)).toEqual({ trigger: 'cold-restore-mount', visible: true })
    }
    // The person starts typing in that tab afterwards: still the same startup visit.
    notePersonInputForRevealEvidence()
    const afterTyping = createPaneLaunchDescriber(
      fakeSession({ visible: true, active: true, sleepingOrigin: 'quit' })
    )
    expect(afterTyping(resumeSpawn)).toEqual({ trigger: 'cold-restore-mount', visible: true })
  })

  it('labels a tab a person switches to after startup as a person reveal', () => {
    registerVisibleTerminalTab('tab-1')
    notePersonInputForRevealEvidence()
    const unregister = registerVisibleTerminalTab('tab-2')
    expect(
      createPaneLaunchDescriber(
        fakeSession({ visible: true, active: true, tabId: 'tab-2', sleepingOrigin: 'quit' })
      )(resumeSpawn)
    ).toEqual({ trigger: 'person-reveal', visible: true })
    unregister()
  })

  it('labels a hidden restored agent as a background mount', () => {
    const describeLaunch = createPaneLaunchDescriber(fakeSession({ visible: false, active: false }))
    expect(describeLaunch(resumeSpawn)).toEqual({ trigger: 'background-mount', visible: false })
  })

  it('labels a hibernated pane waking from the pane state', () => {
    expect(
      createPaneLaunchDescriber(
        fakeSession({ visible: true, active: true, wakeInFlight: 'claude:abc' })
      )(resumeSpawn)
    ).toEqual({ trigger: 'hibernation-wake', visible: true })
    expect(
      createPaneLaunchDescriber(
        fakeSession({ visible: false, active: false, sleepingOrigin: 'worktree-sleep' })
      )(resumeSpawn)
    ).toEqual({ trigger: 'hibernation-wake', visible: false })
  })

  it('labels a fresh agent launch as new', () => {
    const describeLaunch = createPaneLaunchDescriber(fakeSession({ visible: true, active: true }))
    expect(describeLaunch({ resumesAgentSession: false, hasStartupCommand: true })).toEqual({
      trigger: 'new',
      visible: true
    })
  })

  it('uses the pane visibility G3 uses, not document visibility, for a hidden window', () => {
    // After a restart the window is minimized or occluded (macOS reports the document
    // hidden) while the startup tab's pane is the renderer-visible one. pty-exit-hibernate
    // and the G3 keep rules count it visible, so the launch must too.
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    try {
      registerVisibleTerminalTab('tab-1')
      setForegroundTerminalTabIds(['tab-1'])
      expect(
        createPaneLaunchDescriber(
          fakeSession({ visible: true, active: true, sleepingOrigin: 'quit' })
        )(resumeSpawn)
      ).toEqual({ trigger: 'cold-restore-mount', visible: true })
      expect(
        createPaneLaunchDescriber(
          fakeSession({ visible: false, active: false, sleepingOrigin: 'quit' })
        )(resumeSpawn)
      ).toEqual({ trigger: 'background-mount', visible: false })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('describes the launch while the latencyTelemetry setting is off', () => {
    storeState.settings = { latencyTelemetry: false }
    const describeLaunch = createPaneLaunchDescriber(fakeSession({ visible: true, active: true }))
    expect(describeLaunch(resumeSpawn)).toEqual({ trigger: 'cold-restore-mount', visible: true })
  })
})

describe('a cold-restore resume through the pty:spawn request', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    installIpcPtyWindow(originalWindow, {})
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  // What fresh-spawn-start sends for every cold-restore agent resume of a restored tab
  // (paneStartup null): interruptedRestore rides along whether or not the agent was mid-turn.
  const coldRestoreConnect = {
    url: '',
    callbacks: {},
    interruptedRestore: true,
    command: 'claude --resume abc',
    launchConfig: { agentCommand: 'claude' } as never,
    resumeProviderSession: { key: 'session_id' as const, id: 'abc' },
    launchToken: 'launch-token',
    launchAgent: 'claude' as const
  }

  async function spawnedTrigger(session: ConnectPanePtySession): Promise<unknown> {
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    spawn.mockClear()
    await spawnIpcPty({ describeLaunch: createPaneLaunchDescriber(session) }, coldRestoreConnect)
    const request = spawn.mock.calls[0]?.[0] as Record<string, unknown>
    // Main still gets the flag: its interrupted-restore auto-continue depends on it.
    expect(request.interruptedRestore).toBe(true)
    return request.launchTrigger
  }

  it('keeps the pane attribution instead of claiming restore-interrupted', async () => {
    expect(
      await spawnedTrigger(fakeSession({ visible: true, active: true, wakeInFlight: 'claude:abc' }))
    ).toBe('hibernation-wake')
    expect(
      await spawnedTrigger(
        fakeSession({ visible: false, active: false, sleepingOrigin: 'worktree-sleep' })
      )
    ).toBe('hibernation-wake')
    expect(
      await spawnedTrigger(fakeSession({ visible: false, active: false, sleepingOrigin: 'quit' }))
    ).toBe('background-mount')

    registerVisibleTerminalTab('tab-1')
    setForegroundTerminalTabIds(['tab-1'])
    expect(
      await spawnedTrigger(fakeSession({ visible: true, active: true, sleepingOrigin: 'quit' }))
    ).toBe('cold-restore-mount')

    notePersonInputForRevealEvidence()
    const unregister = registerVisibleTerminalTab('tab-2')
    expect(
      await spawnedTrigger(
        fakeSession({ visible: true, active: true, tabId: 'tab-2', sleepingOrigin: 'live' })
      )
    ).toBe('person-reveal')
    unregister()
  })
})

it('describes with tracing disabled for the durable main ledger', () => {
  storeState.settings = { latencyTelemetry: false }
  const describe = createPaneLaunchDescriber(fakeSession({ visible: true, active: true }))
  expect(describe(resumeSpawn)).toEqual({ trigger: 'cold-restore-mount', visible: true })
})
it('records shell launches through the pane spawn fields', () => {
  const describe = createPaneLaunchDescriber(fakeSession({ visible: false, active: false }))
  expect(describe({ resumesAgentSession: false, hasStartupCommand: false })).toEqual({
    trigger: 'new',
    visible: false
  })
})
