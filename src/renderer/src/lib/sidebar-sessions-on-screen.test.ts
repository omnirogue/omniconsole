import { describe, expect, it } from 'vitest'
import {
  parseWorkspaceOnScreenSignature,
  portalOnScreenTargets,
  selectWorkspaceOnScreenSignature,
  sidebarSessionScreenPresence
} from './sidebar-sessions-on-screen'

const WT = 'wt-1'

function splitState() {
  return {
    activeView: 'terminal' as const,
    activeWorktreeId: WT,
    activeTabId: 'term-a',
    activeTabType: 'terminal' as const,
    groupsByWorktree: {
      [WT]: [
        { id: 'g1', worktreeId: WT, activeTabId: 'u-a', tabOrder: ['u-a'] },
        { id: 'g2', worktreeId: WT, activeTabId: 'u-b', tabOrder: ['u-b'] },
        { id: 'g3', worktreeId: WT, activeTabId: 'u-web', tabOrder: ['u-web'] }
      ]
    },
    activeGroupIdByWorktree: { [WT]: 'g1' },
    unifiedTabsByWorktree: {
      [WT]: [
        { id: 'u-a', entityId: 'term-a', groupId: 'g1', contentType: 'terminal' },
        { id: 'u-b', entityId: 'term-b', groupId: 'g2', contentType: 'terminal' },
        { id: 'u-web', entityId: 'web', groupId: 'g3', contentType: 'browser' }
      ]
    },
    terminalLayoutsByTabId: {},
    layoutByWorktree: {
      [WT]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'g1' },
        second: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', groupId: 'g2' },
          second: { type: 'leaf', groupId: 'g3' }
        }
      }
    }
  }
}

describe('conversations on screen', () => {
  it('lists the front conversation of every split, the focused one marked', () => {
    const targets = parseWorkspaceOnScreenSignature(
      // Why the cast: a partial store double, as the selectors accept.
      selectWorkspaceOnScreenSignature(splitState() as never)
    )
    expect(targets.filter((target) => target.focused).map((target) => target.tabId)).toEqual([
      'term-a'
    ])
    expect([...new Set(targets.map((target) => target.tabId))].sort()).toEqual(['term-a', 'term-b'])
  })

  it('lists nothing off the workspace view', () => {
    expect(
      selectWorkspaceOnScreenSignature({ ...splitState(), activeView: 'settings' } as never)
    ).toBe('')
    expect(parseWorkspaceOnScreenSignature('')).toEqual([])
  })

  it('reads the Grid’s borrowed terminals as on screen', () => {
    const targets = portalOnScreenTargets([
      {
        slotId: 'grid:p1',
        requestToken: 't',
        target: {} as HTMLElement,
        worktreeId: 'wt-2',
        tabId: 'term-x',
        paneKey: '',
        active: false
      }
    ])
    expect(targets).toEqual([{ worktreeId: 'wt-2', tabId: 'term-x', leafId: null, focused: false }])
  })

  it('tells the focused conversation from the others on screen', () => {
    const targets = [
      { worktreeId: WT, tabId: 'term-a', leafId: null, focused: true },
      { worktreeId: WT, tabId: 'term-b', leafId: null, focused: false }
    ]
    const row = (tabId: string) => ({ worktreeId: WT, tabId, paneKey: null })
    expect(sidebarSessionScreenPresence(row('term-a'), targets)).toBe('focused')
    expect(sidebarSessionScreenPresence(row('term-b'), targets)).toBe('visible')
    expect(sidebarSessionScreenPresence(row('term-c'), targets)).toBeNull()
  })
})
