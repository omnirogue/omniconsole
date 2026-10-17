import { describe, expect, it } from 'vitest'
import { createRepeatLaunchGuard } from './attention-launch-repeat-guard'

describe('createRepeatLaunchGuard', () => {
  it('ignores a second click on the same favourite inside the window', () => {
    const guard = createRepeatLaunchGuard(1500)
    expect(guard.tryAcquire('wt codex-team', 1000)).toBe(true)
    expect(guard.tryAcquire('wt codex-team', 1400)).toBe(false)
    expect(guard.tryAcquire('wt codex-team', 2499)).toBe(false)
  })

  it('allows a deliberate relaunch after the window and other favourites at once', () => {
    const guard = createRepeatLaunchGuard(1500)
    expect(guard.tryAcquire('wt codex-team', 1000)).toBe(true)
    expect(guard.tryAcquire('wt claude-teams', 1001)).toBe(true)
    expect(guard.tryAcquire('other-wt codex-team', 1002)).toBe(true)
    expect(guard.tryAcquire('wt codex-team', 2500)).toBe(true)
  })

  it('lets a released key launch again at once and leaves other keys guarded', () => {
    const guard = createRepeatLaunchGuard(1500)
    expect(guard.tryAcquire('wt codex-team', 1000)).toBe(true)
    expect(guard.tryAcquire('wt claude-teams', 1000)).toBe(true)
    guard.release('wt codex-team')
    expect(guard.tryAcquire('wt codex-team', 1001)).toBe(true)
    expect(guard.tryAcquire('wt claude-teams', 1001)).toBe(false)
  })
})
