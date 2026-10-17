import { afterEach, describe, expect, it } from 'vitest'
import {
  LAUNCH_TRIGGER_HINT_TTL_MS,
  _launchTriggerHintCountForTests,
  _resetLaunchTriggerHintsForTests,
  noteLaunchTriggerHint,
  takeLaunchTriggerHints
} from './launch-trigger-hints'

afterEach(() => {
  _resetLaunchTriggerHintsForTests()
})

describe('launch trigger hints', () => {
  it('consumes a tab hint once and keeps a worktree hint until it expires', () => {
    const now = 1_000_000
    noteLaunchTriggerHint({ worktreeId: 'wt-1', tabId: 'tab-1', trigger: 'mobile-wake' }, now)
    noteLaunchTriggerHint({ worktreeId: 'wt-1', trigger: 'browser-lease' }, now)

    expect(takeLaunchTriggerHints({ worktreeId: 'wt-1', tabId: 'tab-1' }, now + 10)).toEqual({
      tabHint: 'mobile-wake',
      worktreeHint: 'browser-lease'
    })
    expect(takeLaunchTriggerHints({ worktreeId: 'wt-1', tabId: 'tab-1' }, now + 20)).toEqual({
      tabHint: null,
      worktreeHint: 'browser-lease'
    })
    expect(
      takeLaunchTriggerHints(
        { worktreeId: 'wt-1', tabId: 'tab-2' },
        now + LAUNCH_TRIGGER_HINT_TTL_MS + 1
      )
    ).toEqual({ tabHint: null, worktreeHint: null })
  })

  it('matches a tab hint noted without a worktree (a create into the active worktree)', () => {
    noteLaunchTriggerHint({ tabId: 'tab-9', trigger: 'cli' }, 5_000)
    expect(takeLaunchTriggerHints({ worktreeId: 'wt-2', tabId: 'tab-9' }, 5_100).tabHint).toBe(
      'cli'
    )
  })

  it('records nothing for a lease that names no worktree, so it cannot relabel other worktrees', () => {
    // After a restart no browser guest is registered, so a lease with no worktree
    // selector lands during the cold-restore flood; it must not claim those launches.
    noteLaunchTriggerHint({ trigger: 'browser-lease' }, 5_000)
    expect(_launchTriggerHintCountForTests()).toBe(0)
    expect(takeLaunchTriggerHints({ worktreeId: 'wt-3', tabId: 'tab-1' }, 5_100)).toEqual({
      tabHint: null,
      worktreeHint: null
    })
    expect(takeLaunchTriggerHints({ tabId: 'tab-2' }, 5_100)).toEqual({
      tabHint: null,
      worktreeHint: null
    })
  })

  it('keeps a lease naming a worktree to that worktree', () => {
    noteLaunchTriggerHint({ worktreeId: 'wt-lease', trigger: 'browser-lease' }, 5_000)
    expect(
      takeLaunchTriggerHints({ worktreeId: 'wt-lease', tabId: 'tab-1' }, 5_100).worktreeHint
    ).toBe('browser-lease')
    expect(
      takeLaunchTriggerHints({ worktreeId: 'wt-other', tabId: 'tab-1' }, 5_100).worktreeHint
    ).toBeNull()
  })

  it('stays bounded', () => {
    for (let index = 0; index < 1_000; index += 1) {
      noteLaunchTriggerHint({ worktreeId: `wt-${index}`, tabId: `tab-${index}`, trigger: 'cli' }, 1)
    }
    expect(_launchTriggerHintCountForTests()).toBeLessThanOrEqual(256)
  })
})
