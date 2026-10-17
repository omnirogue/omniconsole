// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SidebarHeader from './SidebarHeader'
import { publishSidebarCollapsibleGroupKeys } from './sidebar-collapsible-groups'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  openWorkspaceCreationComposerWithTourHandoff: vi.fn()
}))

type MockState = {
  repos: { id: string }[]
  groupBy: string
  collapsedGroups: Set<string>
  setCollapsedGroups: (keys: readonly string[]) => void
  openModal: (modal: string, data?: unknown) => void
}

let mockState: MockState

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: MockState) => unknown) => selector(mockState)
}))

vi.mock('./SidebarWorkspaceOptionsMenu', () => ({ default: () => null }))

vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => '⌘N' }))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('../contextual-tours/workspace-creation-tour-handoff', () => ({
  openWorkspaceCreationComposerWithTourHandoff: mocks.openWorkspaceCreationComposerWithTourHandoff
}))

let container: HTMLDivElement
let root: Root

function newWorkspaceButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[aria-label="New workspace"]')
  if (!button) {
    throw new Error('New workspace button not rendered')
  }
  return button
}

beforeEach(() => {
  mocks.openWorkspaceCreationComposerWithTourHandoff.mockClear()
  mockState = {
    repos: [],
    groupBy: 'repo',
    collapsedGroups: new Set(),
    setCollapsedGroups: vi.fn(),
    openModal: vi.fn()
  }
  publishSidebarCollapsibleGroupKeys([])
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('SidebarHeader', () => {
  it('keeps New workspace clickable with zero projects, since the composer adds the first one', () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    const button = newWorkspaceButton()
    expect(button.disabled).toBe(false)

    act(() => {
      button.click()
    })

    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).toHaveBeenCalledTimes(1)
  })

  it('opens the composer the same way once projects exist', () => {
    mockState.repos = [{ id: 'repo-a' }]
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    act(() => {
      newWorkspaceButton().click()
    })

    expect(newWorkspaceButton().disabled).toBe(false)
    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).toHaveBeenCalledTimes(1)
  })

  it('collapses every published group at once and expands them again', () => {
    publishSidebarCollapsibleGroupKeys(['repo:a', 'repo:b'])
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })
    const collapse = container.querySelector<HTMLButtonElement>('[aria-label="Collapse all"]')
    expect(collapse).not.toBeNull()
    act(() => {
      collapse!.click()
    })
    expect(mockState.setCollapsedGroups).toHaveBeenCalledWith(['repo:a', 'repo:b'])

    mockState.collapsedGroups = new Set(['repo:a', 'repo:b'])
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })
    const expand = container.querySelector<HTMLButtonElement>('[aria-label="Expand all"]')
    expect(expand).not.toBeNull()
    act(() => {
      expand!.click()
    })
    expect(mockState.setCollapsedGroups).toHaveBeenLastCalledWith([])
  })

  it('hides the bulk toggle when no group can be folded', () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })
    expect(container.querySelector('[data-sidebar-collapse-all]')).toBeNull()
  })
})
