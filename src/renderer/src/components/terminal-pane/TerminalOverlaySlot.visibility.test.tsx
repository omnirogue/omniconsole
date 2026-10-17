/** @vitest-environment happy-dom */
import { render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import {
  setActivityTerminalPortals,
  useActivityTerminalPortals,
  type ActivityTerminalPortalTarget
} from '../activity/activity-terminal-portal'
import { TerminalOverlaySlot } from './TerminalOverlaySlot'

const mocks = vi.hoisted(() => ({ pane: vi.fn(), enabled: true }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ settings: { commandCenter: mocks.enabled } }),
    { getState: () => ({ pendingStartupByTabId: {} }) }
  )
}))
vi.mock('./ConversationTerminalPane', () => ({
  default: (props: unknown) => {
    mocks.pane(props)
    return null
  }
}))
vi.mock('../terminal/terminal-tab-actions', () => ({ closeTerminalTab: vi.fn() }))
vi.mock('./terminal-parked-tab-watchers', () => ({ shouldDeferParkedPtyExitTabClose: vi.fn() }))
vi.mock('@/lib/window-park-visibility', () => ({
  getWindowParkVisible: () => true,
  subscribeWindowParkVisibility: () => () => {}
}))

afterEach(() => {
  setActivityTerminalPortals([], 'grid')
  mocks.pane.mockClear()
  mocks.enabled = true
})

function Consumer(): React.JSX.Element {
  const portal = useActivityTerminalPortals(true, true)[0] ?? null
  return (
    <TerminalOverlaySlot
      terminalTabId="tab"
      terminalGeneration={0}
      worktreeId="workspace"
      worktreePath="/workspace"
      startupCwd={undefined}
      groupId={undefined}
      isWorktreeActive={false}
      isVisible={false}
      isActive={false}
      activityTerminalPortal={portal}
      onFocusOwningGroup={undefined}
      consumeSuppressedPtyExit={() => false}
      leaveWorktreeIfEmpty={() => {}}
    />
  )
}

it('passes mounted hidden portals to the terminal with visibility and focus off, then restores them', () => {
  const descriptor: ActivityTerminalPortalTarget = {
    slotId: 'grid:pane',
    requestToken: 'grid:pane:tab',
    target: document.createElement('div'),
    worktreeId: 'workspace',
    tabId: 'tab',
    paneKey: '',
    mounted: true,
    visible: false,
    focused: true,
    active: true,
    passiveViewer: true
  }
  setActivityTerminalPortals([descriptor], 'grid')
  const view = render(<Consumer />)
  expect(mocks.pane.mock.calls.at(-1)?.[0]).toMatchObject({
    isVisible: false,
    isWorktreeActive: false,
    isActive: false,
    passiveViewer: true
  })
  act(() => setActivityTerminalPortals([{ ...descriptor, visible: true }], 'grid'))
  expect(mocks.pane.mock.calls.at(-1)?.[0]).toMatchObject({
    isVisible: true,
    isWorktreeActive: true,
    isActive: true,
    passiveViewer: true
  })
  act(() => {
    mocks.enabled = false
    setActivityTerminalPortals([{ ...descriptor, requestToken: 'off' }], 'grid')
  })
  expect(mocks.pane.mock.calls.at(-1)?.[0].passiveViewer).toBe(false)
  view.unmount()
})
