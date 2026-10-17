import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PERSON_REVEAL_INPUT_WINDOW_MS,
  installPersonRevealEvidence,
  notePersonInputForRevealEvidence,
  noteTerminalTabEnteredForeground,
  resetPersonRevealEvidenceForTests,
  wasTerminalTabRevealedByPerson
} from './person-reveal-evidence'

afterEach(() => {
  resetPersonRevealEvidenceForTests()
})

function fakeTarget(): {
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  fire: (type: string, event: Partial<Event>) => void
  listenerCount: () => number
} {
  const listeners = new Map<string, Set<(event: Event) => void>>()
  return {
    target: {
      addEventListener: (type, listener) => {
        if (typeof listener !== 'function') {
          return
        }
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
      },
      removeEventListener: (type, listener) => {
        if (typeof listener === 'function') {
          listeners.get(type)?.delete(listener)
        }
      }
    },
    fire: (type, event) => {
      for (const listener of listeners.get(type) ?? []) {
        listener(event as Event)
      }
    },
    listenerCount: () => Array.from(listeners.values()).reduce((sum, set) => sum + set.size, 0)
  }
}

describe('person reveal evidence', () => {
  it('does not count a tab that came on screen before any person input (the startup tab)', () => {
    noteTerminalTabEnteredForeground('tab-startup', 1_000)
    expect(wasTerminalTabRevealedByPerson('tab-startup')).toBe(false)
    expect(wasTerminalTabRevealedByPerson('tab-never-seen')).toBe(false)
  })

  it('counts a tab that came on screen right after a press, and only within the window', () => {
    notePersonInputForRevealEvidence(10_000)
    noteTerminalTabEnteredForeground('tab-clicked', 10_050)
    noteTerminalTabEnteredForeground(
      'tab-automated',
      10_000 + PERSON_REVEAL_INPUT_WINDOW_MS + 1
    )
    expect(wasTerminalTabRevealedByPerson('tab-clicked')).toBe(true)
    expect(wasTerminalTabRevealedByPerson('tab-automated')).toBe(false)
  })

  it('ignores a press that came after the tab was already on screen', () => {
    noteTerminalTabEnteredForeground('tab-startup', 1_000)
    notePersonInputForRevealEvidence(1_500)
    expect(wasTerminalTabRevealedByPerson('tab-startup')).toBe(false)
  })

  it('decides again on each new foreground visit', () => {
    noteTerminalTabEnteredForeground('tab-1', 1_000)
    notePersonInputForRevealEvidence(20_000)
    noteTerminalTabEnteredForeground('tab-1', 20_010)
    expect(wasTerminalTabRevealedByPerson('tab-1')).toBe(true)
    noteTerminalTabEnteredForeground('tab-1', 90_000)
    expect(wasTerminalTabRevealedByPerson('tab-1')).toBe(false)
  })

  it('stays bounded', () => {
    notePersonInputForRevealEvidence(1)
    for (let index = 0; index < 2_000; index += 1) {
      noteTerminalTabEnteredForeground(`tab-${index}`, 2)
    }
    expect(wasTerminalTabRevealedByPerson('tab-0')).toBe(false)
    expect(wasTerminalTabRevealedByPerson('tab-1999')).toBe(true)
  })

  it('records trusted pointer and key presses only, and removes its listeners', () => {
    const now = vi.spyOn(performance, 'now')
    const { target, fire, listenerCount } = fakeTarget()
    const uninstall = installPersonRevealEvidence(target)
    expect(listenerCount()).toBe(2)
    // A second install is a no-op.
    installPersonRevealEvidence(target)
    expect(listenerCount()).toBe(2)

    now.mockReturnValue(5_000)
    fire('pointerdown', { isTrusted: false })
    noteTerminalTabEnteredForeground('tab-synthetic', 5_010)
    expect(wasTerminalTabRevealedByPerson('tab-synthetic')).toBe(false)

    fire('keydown', { isTrusted: true })
    noteTerminalTabEnteredForeground('tab-keyboard', 5_020)
    expect(wasTerminalTabRevealedByPerson('tab-keyboard')).toBe(true)

    now.mockReturnValue(50_000)
    fire('pointerdown', { isTrusted: true })
    noteTerminalTabEnteredForeground('tab-clicked', 50_030)
    expect(wasTerminalTabRevealedByPerson('tab-clicked')).toBe(true)

    uninstall()
    expect(listenerCount()).toBe(0)
    now.mockRestore()
  })
})
