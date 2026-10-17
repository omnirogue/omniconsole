// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type * as NewWorkspaceModule from '@/lib/new-workspace'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('@/lib/worktree-activation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace }
})

vi.mock('@/lib/new-workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof NewWorkspaceModule>()
  return { ...actual, ensureAgentStartupInTerminal: mocks.ensureAgentStartupInTerminal }
})

import { submitFolderWorkspaceCreate } from './folder-workspace-composer-submit'

const projectGroup: ProjectGroup = {
  id: 'group-1',
  name: 'Platform',
  parentPath: '/repo/platform',
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const workspace: FolderWorkspace = {
  id: 'folder-workspace-1',
  projectGroupId: 'group-1',
  name: 'hi',
  folderPath: '/repo/platform/hi',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}

describe('submitFolderWorkspaceCreate agent template', () => {
  beforeEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
    Object.assign(window, { api: { agentTrust: { markTrusted: vi.fn() } } })
  })

  afterEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReset()
    mocks.ensureAgentStartupInTerminal.mockReset()
    Reflect.deleteProperty(window, 'api')
  })

  it.each([
    [
      'Fix the failing folder prompt flow',
      'Fix the failing folder prompt flow\n\n---\n\nStanding instructions for this session (agent template "Reviewer"; follow them throughout):\n# Reviewer'
    ],
    ['', '# Reviewer']
  ])('sends a non-linked note %j with the chosen template once', async (note, followupPrompt) => {
    await submitFolderWorkspaceCreate({
      projectGroup,
      name: 'Aider followup',
      lastAutoName: '',
      linkedWorkItem: null,
      note,
      quickAgent: 'aider',
      agentTemplate: { name: 'Reviewer', instructions: '# Reviewer' },
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace: vi.fn(async () => workspace),
      onOpenChange: vi.fn()
    })

    expect(mocks.ensureAgentStartupInTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ startup: expect.objectContaining({ followupPrompt }) })
    )
  })
})
