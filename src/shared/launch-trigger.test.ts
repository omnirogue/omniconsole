import { describe, expect, it } from 'vitest'
import {
  LAUNCH_TRIGGERS,
  isLaunchTrigger,
  normalizeLaunchTrigger,
  resolveLaunchTrigger
} from './launch-trigger'

describe('launch trigger tokens', () => {
  it('accepts every fixed token and nothing else', () => {
    for (const trigger of LAUNCH_TRIGGERS) {
      expect(isLaunchTrigger(trigger)).toBe(true)
      expect(normalizeLaunchTrigger(trigger)).toBe(trigger)
    }
    expect(normalizeLaunchTrigger('rm -rf /Users/maintainer/worktree')).toBe('unknown')
    expect(normalizeLaunchTrigger(undefined)).toBe('unknown')
    expect(normalizeLaunchTrigger(42)).toBe('unknown')
    expect(normalizeLaunchTrigger({ trigger: 'cli' })).toBe('unknown')
  })
})

describe('resolveLaunchTrigger', () => {
  it('defaults to unknown', () => {
    expect(resolveLaunchTrigger({})).toBe('unknown')
  })

  it('lets the auto-continue main armed win over every other signal', () => {
    expect(
      resolveLaunchTrigger({
        interruptedAutoContinue: true,
        rendererTrigger: 'person-reveal',
        tabHint: 'mobile-wake',
        worktreeHint: 'browser-lease'
      })
    ).toBe('restore-interrupted')
  })

  it('never takes restore-interrupted from the renderer', () => {
    // Only main knows the pane was mid-turn; the renderer's claim is no evidence.
    expect(resolveLaunchTrigger({ rendererTrigger: 'restore-interrupted' })).toBe('unknown')
    expect(resolveLaunchTrigger({ rendererTrigger: 'restore-interrupted', tabHint: 'cli' })).toBe(
      'cli'
    )
    expect(
      resolveLaunchTrigger({ rendererTrigger: 'restore-interrupted', worktreeHint: 'mobile-wake' })
    ).toBe('mobile-wake')
    expect(
      resolveLaunchTrigger({ interruptedAutoContinue: false, rendererTrigger: 'person-reveal' })
    ).toBe('person-reveal')
  })

  it('lets a request naming the exact tab win over the renderer guess', () => {
    expect(resolveLaunchTrigger({ rendererTrigger: 'new', tabHint: 'cli' })).toBe('cli')
    expect(
      resolveLaunchTrigger({ rendererTrigger: 'hibernation-wake', tabHint: 'mobile-wake' })
    ).toBe('mobile-wake')
  })

  it('refines only background or unattributed renderer guesses with a worktree-wide hint', () => {
    expect(
      resolveLaunchTrigger({ rendererTrigger: 'background-mount', worktreeHint: 'browser-lease' })
    ).toBe('browser-lease')
    expect(
      resolveLaunchTrigger({ rendererTrigger: 'background-mount', worktreeHint: 'mobile-wake' })
    ).toBe('mobile-wake')
    expect(resolveLaunchTrigger({ worktreeHint: 'browser-lease' })).toBe('browser-lease')
    // A lease or phone mount only mounts hidden panes, so a visible cold restore in the
    // same worktree (the startup tab after a restart) stays a restore.
    expect(
      resolveLaunchTrigger({ rendererTrigger: 'cold-restore-mount', worktreeHint: 'mobile-wake' })
    ).toBe('cold-restore-mount')
    expect(
      resolveLaunchTrigger({ rendererTrigger: 'cold-restore-mount', worktreeHint: 'browser-lease' })
    ).toBe('cold-restore-mount')
    // A person's reveal or a new agent in the same worktree keeps its own attribution.
    expect(
      resolveLaunchTrigger({ rendererTrigger: 'person-reveal', worktreeHint: 'browser-lease' })
    ).toBe('person-reveal')
    expect(resolveLaunchTrigger({ rendererTrigger: 'new', worktreeHint: 'browser-lease' })).toBe(
      'new'
    )
  })

  it('never passes free text through from the renderer', () => {
    expect(resolveLaunchTrigger({ rendererTrigger: 'prompt: fix the billing bug' })).toBe('unknown')
  })
})
