/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  setActivityTerminalPortals,
  useActivityTerminalPortals,
  viewHostsTerminalPortals,
  type ActivityTerminalPortalTarget
} from './activity-terminal-portal'

const visibility = vi.hoisted(() => ({ visible: true }))
vi.mock('@/lib/window-park-visibility', () => ({
  getWindowParkVisible: () => visibility.visible,
  subscribeWindowParkVisibility: () => () => {}
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root

beforeEach(() => setActivityTerminalPortals([]))

afterEach(() => {
  act(() => root?.unmount())
  setActivityTerminalPortals([])
})

function portal(target: HTMLElement): ActivityTerminalPortalTarget {
  return {
    slotId: 'primary',
    requestToken: 'primary:tab-a:leaf-a',
    target,
    worktreeId: 'worktree-a',
    tabId: 'tab-a',
    paneKey: 'tab-a:leaf-a',
    forceUnavailable: false,
    active: true
  }
}

describe('Activity terminal portal publication', () => {
  it('does not notify Terminal for a value-identical descriptor array', () => {
    const descriptor = portal(document.createElement('div'))
    setActivityTerminalPortals([descriptor])
    let renders = 0

    function Subscriber(): null {
      useActivityTerminalPortals(true)
      renders += 1
      return null
    }

    root = createRoot(document.createElement('div'))
    act(() => root.render(<Subscriber />))
    const initialRenders = renders
    act(() => setActivityTerminalPortals([{ ...descriptor }]))
    expect(renders).toBe(initialRenders)
  })

  it('publishes a passive viewer change without changing the borrowed target', () => {
    const descriptor = portal(document.createElement('div'))
    setActivityTerminalPortals([descriptor])
    let snapshot: ActivityTerminalPortalTarget[] = []
    function Subscriber(): null {
      snapshot = useActivityTerminalPortals(true, true)
      return null
    }
    root = createRoot(document.createElement('div'))
    act(() => root.render(<Subscriber />))
    act(() => setActivityTerminalPortals([{ ...descriptor, passiveViewer: true }]))
    expect(snapshot[0]).toMatchObject({ passiveViewer: true, target: descriptor.target })
  })

  it('notifies Terminal when a routing value changes', () => {
    const descriptor = portal(document.createElement('div'))
    setActivityTerminalPortals([descriptor])
    let renders = 0

    function Subscriber(): null {
      useActivityTerminalPortals(true)
      renders += 1
      return null
    }

    root = createRoot(document.createElement('div'))
    act(() => root.render(<Subscriber />))
    const initialRenders = renders
    act(() => setActivityTerminalPortals([{ ...descriptor, paneKey: 'tab-a:leaf-b' }]))
    expect(renders).toBe(initialRenders + 1)
  })
})

describe('viewHostsTerminalPortals', () => {
  it('lends terminals to full pages over the hidden workbench, never to the workspace view', () => {
    expect(viewHostsTerminalPortals('activity')).toBe(true)
    expect(viewHostsTerminalPortals('attention')).toBe(true)
    // Build + Review and Local runs show the running worker's own terminal inline.
    expect(viewHostsTerminalPortals('buildReview')).toBe(true)
    expect(viewHostsTerminalPortals('localRuns')).toBe(true)
    expect(viewHostsTerminalPortals('terminal')).toBe(false)
    expect(viewHostsTerminalPortals('settings')).toBe(false)
  })
})

describe('command center portal ownership and visibility', () => {
  afterEach(() => {
    for (const owner of ['activity', 'attention', 'buildReview', 'localRuns', 'grid', 'project']) {
      setActivityTerminalPortals([], owner)
    }
    visibility.visible = true
  })

  function readPortals(commandCenter = true): () => ActivityTerminalPortalTarget[] {
    let targets: ActivityTerminalPortalTarget[] = []
    function Subscriber(): null {
      targets = useActivityTerminalPortals(true, commandCenter)
      return null
    }
    root = createRoot(document.createElement('div'))
    act(() => root.render(<Subscriber />))
    return () => targets
  }

  it('preserves all six owners when another owner clears', () => {
    const owners = ['activity', 'attention', 'buildReview', 'localRuns', 'grid', 'project']
    for (const owner of owners) {
      setActivityTerminalPortals(
        [{ ...portal(document.createElement('div')), slotId: owner }],
        owner
      )
    }
    const read = readPortals()
    expect(read().map((target) => target.slotId)).toEqual(owners)
    act(() => setActivityTerminalPortals([], 'grid'))
    expect(read().map((target) => target.slotId)).toEqual(
      owners.filter((owner) => owner !== 'grid')
    )
  })

  it('preserves the last-writer and clear-all behavior with the setting off', () => {
    setActivityTerminalPortals([portal(document.createElement('div'))], 'grid')
    setActivityTerminalPortals(
      [
        {
          ...portal(document.createElement('div')),
          slotId: 'attention',
          visible: false,
          focused: false
        }
      ],
      'attention'
    )
    const read = readPortals(false)
    expect(read()).toHaveLength(1)
    expect(read()[0]).toMatchObject({ slotId: 'attention', visible: true, active: true })
    act(() => setActivityTerminalPortals([], 'grid'))
    expect(read()).toEqual([])
  })

  it.each(['mounted', 'visible', 'focused'] as const)('publishes changes to %s', (field) => {
    const descriptor = {
      ...portal(document.createElement('div')),
      mounted: true,
      visible: true,
      focused: true
    }
    setActivityTerminalPortals([descriptor], 'grid')
    const read = readPortals()
    act(() => setActivityTerminalPortals([{ ...descriptor, [field]: false }], 'grid'))
    expect(read()[0][field]).toBe(false)
    if (field !== 'focused') {
      expect(read()[0].visible).toBe(false)
      expect(read()[0].active).toBe(false)
    }
  })

  it('reports window hide and restore without removing the mounted target', () => {
    setActivityTerminalPortals([portal(document.createElement('div'))], 'grid')
    const read = readPortals()
    expect(read()[0]).toMatchObject({ mounted: true, visible: true, focused: true })
    visibility.visible = false
    act(() => setActivityTerminalPortals([{ ...portal(document.createElement('div')) }], 'grid'))
    expect(read()[0]).toMatchObject({ mounted: true, visible: false, focused: false })
    visibility.visible = true
    act(() => setActivityTerminalPortals([{ ...portal(document.createElement('div')) }], 'grid'))
    expect(read()[0]).toMatchObject({ mounted: true, visible: true, focused: true })
  })
})
