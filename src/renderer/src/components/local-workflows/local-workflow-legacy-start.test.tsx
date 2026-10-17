// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalWorkflowDraft } from '../../../../shared/local-workflow-draft'
import { createLocalWorkflowAuditDraft } from '../../../../shared/workflow-audit-draft'
import type { LocalWorkflowSetupResult } from '../../../../shared/local-workflow-rpc'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { useClearLegacyLocalWorkflowStart } from './local-workflow-legacy-start'

const update = vi.hoisted(() => vi.fn())
vi.mock('@/lib/local-workflow-conversation', () => ({ updateLocalWorkflowConversation: update }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function tab(graph: boolean, executionId?: string): TerminalTab {
  const draft = createLocalWorkflowDraft('council', 'Inspect recovery')
  if (graph) {
    draft.graph = {
      spec: workflowTemplate('council', ['claude', 'codex']),
      team: [{ id: 'seat-1', agent: 'claude', accountId: 'claude-account' }]
    }
  }
  return {
    id: 'workflow-tab',
    worktreeId: 'worktree-1',
    localWorkflow: {
      preset: 'council',
      prompt: 'Inspect recovery',
      draft,
      executionId,
      startRequest: { requestId: 'request-1', draft }
    }
  } as TerminalTab
}

const setup = (executionId?: string) => ({ executionId }) as LocalWorkflowSetupResult

describe('a pending Start an earlier build saved', () => {
  it('is cleared once Setup shows no run, keeping the draft and prompt', () => {
    renderHook(() => useClearLegacyLocalWorkflowStart(tab(false), setup(), true))
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith('worktree-1', 'workflow-tab', { startRequest: undefined })
  })

  it('is kept while Setup loads, when Setup found its run, or when it has a graph', () => {
    renderHook(() => useClearLegacyLocalWorkflowStart(tab(false), setup(), false))
    renderHook(() => useClearLegacyLocalWorkflowStart(tab(false), undefined, true))
    renderHook(() => useClearLegacyLocalWorkflowStart(tab(false), setup('execution-1'), true))
    renderHook(() => useClearLegacyLocalWorkflowStart(tab(false, 'execution-1'), setup(), true))
    renderHook(() => useClearLegacyLocalWorkflowStart(tab(true), setup(), true))
    expect(update).not.toHaveBeenCalled()
  })

  it('keeps a pending Audit Start so an uncertain response can replay the same request', () => {
    const auditTab = tab(false)
    auditTab.localWorkflow!.startRequest!.draft = createLocalWorkflowAuditDraft('Audit recovery')
    renderHook(() => useClearLegacyLocalWorkflowStart(auditTab, setup(), true))
    expect(update).not.toHaveBeenCalled()
  })
})
