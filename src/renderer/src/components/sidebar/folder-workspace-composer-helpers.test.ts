import { describe, expect, it } from 'vitest'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { normalizeWorkspaceLinkedItem } from '../../../../shared/workspace-linked-item'
import {
  getFolderSourceRepos,
  getFolderWorkspacePrimaryActionLabel,
  toFolderWorkspaceLinkedTask
} from './folder-workspace-composer-helpers'

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: '/srv/app',
    displayName: id,
    badgeColor: '#111111',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function group(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-ssh-a',
    name: 'Remote App',
    parentPath: '/srv',
    connectionId: 'ssh-a',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('getFolderSourceRepos', () => {
  it('only returns source repos from the same execution host as the folder group', () => {
    const projectGroup = group()
    const localSamePath = repo('local-same-path', { connectionId: null })
    const otherSshSamePath = repo('ssh-b-same-path', { connectionId: 'ssh-b' })
    const matchingSshByPath = repo('ssh-a-by-path', { connectionId: 'ssh-a' })
    const matchingSshByGroup = repo('ssh-a-by-group', {
      path: '/other/path',
      connectionId: 'ssh-a',
      projectGroupId: projectGroup.id
    })

    expect(
      getFolderSourceRepos(
        [localSamePath, otherSshSamePath, matchingSshByPath, matchingSshByGroup],
        [projectGroup],
        projectGroup
      ).map((item) => item.id)
    ).toEqual(['ssh-a-by-path', 'ssh-a-by-group'])
  })

  it('returns runtime source repos for runtime-owned folder groups', () => {
    const projectGroup = group({ connectionId: null, executionHostId: 'runtime:env-1' })
    const localSamePath = repo('local-same-path', { connectionId: null, executionHostId: 'local' })
    const runtimeByPath = repo('runtime-by-path', {
      connectionId: null,
      executionHostId: 'runtime:env-1'
    })
    const runtimeByGroup = repo('runtime-by-group', {
      path: '/other/path',
      connectionId: null,
      executionHostId: 'runtime:env-1',
      projectGroupId: projectGroup.id
    })

    expect(
      getFolderSourceRepos(
        [localSamePath, runtimeByPath, runtimeByGroup],
        [projectGroup],
        projectGroup
      ).map((item) => item.id)
    ).toEqual(['runtime-by-path', 'runtime-by-group'])
  })
})

describe('getFolderWorkspacePrimaryActionLabel', () => {
  it('uses a stable workspace creation label independent of quick agent selection', () => {
    const label = (getFolderWorkspacePrimaryActionLabel as (...args: unknown[]) => string)({
      id: 'codex'
    })

    expect(label).toBe('Create workspace')
    expect(label).not.toContain('Agent')
  })
})

describe('toFolderWorkspaceLinkedTask hub metadata', () => {
  const linkedItem: LinkedWorkItemSummary = {
    provider: 'backoffice',
    type: 'issue',
    number: 0,
    title: 'Create customer welcome video',
    url: 'https://console.example.test/work/btk_Content123'
  }

  it('preserves canonical identity and revision zero through folder persistence', () => {
    const linkedTask = toFolderWorkspaceLinkedTask({
      ...linkedItem,
      hubTaskId: '  btk_Content123  ',
      hubStateRevision: 0,
      hubNextAction: '  Review the first cut  '
    })

    expect(linkedTask).toEqual({
      ...linkedItem,
      hubTaskId: 'btk_Content123',
      hubStateRevision: 0,
      hubNextAction: 'Review the first cut'
    })
    expect(normalizeWorkspaceLinkedItem(JSON.parse(JSON.stringify(linkedTask)))).toEqual(linkedTask)
  })

  it('omits malformed binding metadata during folder conversion', () => {
    expect(
      toFolderWorkspaceLinkedTask({
        ...linkedItem,
        hubTaskId: 'btk_invalid-id',
        hubStateRevision: 4,
        hubNextAction: 'Review'
      })
    ).toEqual(linkedItem)
  })

  it('leaves ad hoc folders and legacy title-only links unbound', () => {
    expect(toFolderWorkspaceLinkedTask(null)).toBeNull()
    const legacyItem = { ...linkedItem, title: 'btk_Content123 Create customer welcome video' }
    expect(toFolderWorkspaceLinkedTask(legacyItem)).toEqual(legacyItem)
  })

  it('keeps existing provider inference for ordinary issue links without adding a binding', () => {
    const githubItem: LinkedWorkItemSummary = {
      type: 'issue',
      number: 12,
      title: 'Fix the welcome page',
      url: 'https://github.com/org/repo/issues/12'
    }

    expect(toFolderWorkspaceLinkedTask(githubItem)).toEqual({ ...githubItem, provider: 'github' })
  })
})
