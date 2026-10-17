import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _resetLatencyTelemetryEnabledReaderForTests,
  setLatencyTelemetryEnabledReader
} from '../../../observability/latency-probe-switch'
import {
  _launchTriggerHintCountForTests,
  _resetLaunchTriggerHintsForTests,
  noteLaunchTriggerHint
} from '../../../observability/launch-trigger-hints'
import {
  isInterruptedAutoContinueLaunch,
  resolveIpcSpawnLaunchAttribution,
  resolveRuntimeSpawnLaunchAttribution
} from './spawn-launch-attribution'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

beforeEach(() => {
  _resetLaunchTriggerHintsForTests()
})

afterEach(() => {
  _resetLaunchTriggerHintsForTests()
  _resetLatencyTelemetryEnabledReaderForTests()
})

describe('resolveIpcSpawnLaunchAttribution', () => {
  it('records the renderer operation and visibility', () => {
    expect(
      resolveIpcSpawnLaunchAttribution({
        hasLaunchCommand: true,
        launchTrigger: 'person-reveal',
        launchVisible: true,
        worktreeId: 'wt-1',
        tabId: 'tab-1'
      })
    ).toEqual({ launchTrigger: 'renderer-spawn', launchVisible: true })
  })

  it('labels the interrupted-restore auto-continue main armed', () => {
    expect(
      resolveIpcSpawnLaunchAttribution({
        hasLaunchCommand: true,
        interruptedAutoContinue: true,
        launchTrigger: 'background-mount',
        launchVisible: false
      })
    ).toEqual({ launchTrigger: 'restore-interrupted', launchVisible: false })
  })

  it('uses renderer operation when no auto-continue was armed', () => {
    expect(
      resolveIpcSpawnLaunchAttribution({
        hasLaunchCommand: true,
        interruptedAutoContinue: false,
        launchTrigger: 'hibernation-wake',
        launchVisible: true
      })
    ).toEqual({ launchTrigger: 'renderer-spawn', launchVisible: true })
  })

  it('keeps malformed declarations out of the authoritative cause', () => {
    expect(
      resolveIpcSpawnLaunchAttribution({
        hasLaunchCommand: true,
        launchTrigger: 'cat ~/.ssh/id_rsa',
        launchVisible: 'yes'
      })
    ).toEqual({ launchTrigger: 'renderer-spawn' })
  })

  it('keeps an exact CLI hint while preparation reads it again', () => {
    noteLaunchTriggerHint({ worktreeId: 'wt-1', tabId: 'tab-7', trigger: 'cli' })
    expect(
      resolveIpcSpawnLaunchAttribution({
        hasLaunchCommand: true,
        launchTrigger: 'new',
        worktreeId: 'wt-1',
        tabId: 'tab-7'
      }).launchTrigger
    ).toBe('cli')
    // Preparation reads retain the hint until the pipeline records its outcome.
    expect(
      resolveIpcSpawnLaunchAttribution({
        hasLaunchCommand: true,
        launchTrigger: 'hibernation-wake',
        worktreeId: 'wt-1',
        tabId: 'tab-7'
      }).launchTrigger
    ).toBe('cli')
  })

  it('labels hidden restores in a leased worktree, but not a person-revealed or visible one', () => {
    noteLaunchTriggerHint({ worktreeId: 'wt-2', trigger: 'browser-lease' })
    expect(
      resolveIpcSpawnLaunchAttribution({
        hasLaunchCommand: true,
        launchTrigger: 'background-mount',
        worktreeId: 'wt-2',
        tabId: 'tab-1'
      }).launchTrigger
    ).toBe('browser-lease')
    expect(
      resolveIpcSpawnLaunchAttribution({
        hasLaunchCommand: true,
        launchTrigger: 'background-mount',
        worktreeId: 'wt-2',
        tabId: 'tab-2'
      }).launchTrigger
    ).toBe('browser-lease')
    expect(
      resolveIpcSpawnLaunchAttribution({
        hasLaunchCommand: true,
        launchTrigger: 'person-reveal',
        worktreeId: 'wt-2',
        tabId: 'tab-3'
      }).launchTrigger
    ).toBe('renderer-spawn')
    // The lease mounts hidden panes only: the visible startup tab's restore stays a restore.
    expect(
      resolveIpcSpawnLaunchAttribution({
        hasLaunchCommand: true,
        launchTrigger: 'cold-restore-mount',
        worktreeId: 'wt-2',
        tabId: 'tab-5'
      }).launchTrigger
    ).toBe('renderer-spawn')
  })

  it('labels a phone opening the tab as a mobile wake', () => {
    noteLaunchTriggerHint({ worktreeId: 'wt-3', tabId: 'tab-4', trigger: 'mobile-wake' })
    expect(
      resolveIpcSpawnLaunchAttribution({
        hasLaunchCommand: true,
        launchTrigger: 'hibernation-wake',
        worktreeId: 'wt-3',
        tabId: 'tab-4'
      }).launchTrigger
    ).toBe('mobile-wake')
  })

  it('ignores a hint after it expires', () => {
    noteLaunchTriggerHint({ worktreeId: 'wt-4', trigger: 'browser-lease' }, Date.now() - 31_000)
    expect(
      resolveIpcSpawnLaunchAttribution({
        hasLaunchCommand: true,
        launchTrigger: 'background-mount',
        worktreeId: 'wt-4',
        tabId: 'tab-1'
      }).launchTrigger
    ).toBe('renderer-spawn')
  })

  it('leaves a plain shell untouched and does not consume the agent launch hint', () => {
    noteLaunchTriggerHint({ worktreeId: 'wt-5', tabId: 'tab-1', trigger: 'cli' })
    expect(
      resolveIpcSpawnLaunchAttribution({
        hasLaunchCommand: false,
        worktreeId: 'wt-5',
        tabId: 'tab-1'
      })
    ).toEqual({})
    expect(_launchTriggerHintCountForTests()).toBe(1)
  })

  it('returns nothing when the kill switch is off', () => {
    setLatencyTelemetryEnabledReader(() => false)
    noteLaunchTriggerHint({ worktreeId: 'wt-6', tabId: 'tab-1', trigger: 'cli' })
    expect(
      resolveIpcSpawnLaunchAttribution({
        hasLaunchCommand: true,
        launchTrigger: 'new',
        launchVisible: true,
        worktreeId: 'wt-6',
        tabId: 'tab-1'
      })
    ).toEqual({})
    expect(resolveRuntimeSpawnLaunchAttribution()).toEqual({})
    expect(resolveRuntimeSpawnLaunchAttribution('cli')).toEqual({})
  })
})

describe('isInterruptedAutoContinueLaunch', () => {
  const settings = (value?: boolean) => () =>
    ({ autoContinueInterruptedSessions: value }) as unknown as GlobalSettings

  it('is true only when main armed a continuation that the setting lets send', () => {
    expect(isInterruptedAutoContinueLaunch(true, { getSettings: settings(undefined) })).toBe(true)
    expect(isInterruptedAutoContinueLaunch(true, { getSettings: settings(true) })).toBe(true)
    expect(isInterruptedAutoContinueLaunch(true, {})).toBe(true)
    expect(isInterruptedAutoContinueLaunch(false, { getSettings: settings(true) })).toBe(false)
    expect(isInterruptedAutoContinueLaunch(true, { getSettings: settings(false) })).toBe(false)
  })

  it('never throws and claims nothing when the setting cannot be read', () => {
    expect(
      isInterruptedAutoContinueLaunch(true, {
        getSettings: () => {
          throw new Error('store closed')
        }
      })
    ).toBe(false)
  })
})

describe('resolveRuntimeSpawnLaunchAttribution', () => {
  it('records unknown for a main-internal launch that names no cause, never cli', () => {
    // Capacity-recovery successors, orchestration workers, session transfers and
    // worktree-create startups all spawn through the runtime controller naming nothing.
    expect(resolveRuntimeSpawnLaunchAttribution()).toEqual({
      launchTrigger: 'unknown',
      launchVisible: false
    })
  })

  it('records the cause the RPC caller named, with no view attached', () => {
    expect(resolveRuntimeSpawnLaunchAttribution('cli')).toEqual({
      launchTrigger: 'cli',
      launchVisible: false
    })
    expect(resolveRuntimeSpawnLaunchAttribution('mobile-wake')).toEqual({
      launchTrigger: 'mobile-wake',
      launchVisible: false
    })
  })

  it('drops a malformed or restore-interrupted claim to unknown', () => {
    expect(resolveRuntimeSpawnLaunchAttribution('rm -rf /').launchTrigger).toBe('unknown')
    expect(resolveRuntimeSpawnLaunchAttribution('restore-interrupted').launchTrigger).toBe(
      'unknown'
    )
  })
})
