// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  projectGroupTerminalTab,
  useTabGroupItemProjections,
  type TabGroupWorktreeSnapshot
} from './useTabGroupItemProjections'

/**
 * Why these tests exist: the strip rebuilds each terminal tab from the unified tab, and a field it
 * forgot to copy never reached the strip. Workflow tabs lost their anchor that way and showed a
 * generic shell glyph with no preset icon and no state dot.
 */
const workflow: NonNullable<TerminalTab['localWorkflow']> = {
  preset: 'council',
  prompt: 'What are the riskiest defects?',
  executionId: 'execution-1'
}

const unifiedTab: Tab = {
  id: 'unified-1',
  entityId: 'term-1',
  groupId: 'group-1',
  worktreeId: 'wt-1',
  contentType: 'terminal',
  label: 'What are the riskiest defects?',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

const terminalTab: TerminalTab = {
  id: 'term-1',
  ptyId: null,
  worktreeId: 'wt-1',
  title: 'What are the riskiest defects?',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1,
  localWorkflow: workflow
}

describe('projectGroupTerminalTab', () => {
  it('carries the workflow anchor so the tab shows its preset icon and state', () => {
    const projected = projectGroupTerminalTab(unifiedTab, terminalTab, 'wt-1', false)
    expect(projected.localWorkflow).toEqual(workflow)
    expect(projected).toMatchObject({ id: 'term-1', unifiedTabId: 'unified-1', ptyId: null })
  })

  it('leaves an ordinary terminal without a workflow anchor', () => {
    const plain: TerminalTab = { ...terminalTab, localWorkflow: undefined }
    const projected = projectGroupTerminalTab(unifiedTab, plain, 'wt-1', false)
    expect('localWorkflow' in projected).toBe(false)
    expect(projectGroupTerminalTab(unifiedTab, undefined, 'wt-1', false).localWorkflow).toBe(
      undefined
    )
  })
})

describe('useTabGroupItemProjections', () => {
  it('hands the strip a workflow tab with its anchor', () => {
    const group: TabGroup = {
      id: 'group-1',
      worktreeId: 'wt-1',
      activeTabId: 'unified-1',
      tabOrder: ['unified-1']
    }
    const worktreeState: TabGroupWorktreeSnapshot = {
      groups: [group],
      unifiedTabs: [unifiedTab],
      terminalTabs: [terminalTab],
      openFiles: [],
      browserTabs: [],
      expandedPaneByTabId: {},
      terminalLayoutsByTabId: {},
      generatedTabTitlesEnabled: false,
      mobileEmulatorEnabled: false
    }
    const { result } = renderHook(() =>
      useTabGroupItemProjections({ groupId: 'group-1', worktreeId: 'wt-1', worktreeState })
    )
    expect(result.current.terminalTabs).toHaveLength(1)
    expect(result.current.terminalTabs[0].localWorkflow).toEqual(workflow)
    expect(result.current.tabBarOrder).toEqual(['term-1'])
  })
})
