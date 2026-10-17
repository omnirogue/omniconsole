import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { SshTarget } from '../../../shared/ssh-types'
import { getDefaultPersistedState } from '../../../shared/constants'
import { tmpdir } from 'node:os'
import { captureAutomationDeliveryHost } from './automation-delivery-host'

const automation = {
  id: 'routine',
  projectId: 'repo',
  workspaceId: 'folder:folder',
  executionTargetType: 'local',
  executionTargetId: 'local',
  schedulerOwner: 'local_host_service'
} as Automation
const state: PersistedState = {
  ...getDefaultPersistedState(tmpdir()),
  repos: [{ id: 'repo', path: '/repo', connectionId: null } as Repo],
  folderWorkspaces: [
    {
      id: 'folder',
      folderPath: '/remote',
      projectGroupId: 'group',
      connectionId: 'remote'
    } as FolderWorkspace
  ],
  projectGroups: [{ id: 'group', parentPath: '/remote' } as ProjectGroup],
  sshTargets: [{ id: 'remote', generation: 1 } as SshTarget]
}

describe('routine file delivery authority', () => {
  it('captures a folder SSH pin even when the routine record and repository are local', () => {
    expect(captureAutomationDeliveryHost(state, automation)).toBe('ssh:remote')
  })
  it('retains an unresolvable host as unknown instead of permitting local file writes', () => {
    expect(captureAutomationDeliveryHost({ ...state, sshTargets: [] }, automation)).toBeNull()
    expect(
      captureAutomationDeliveryHost({ ...state, repos: [], folderWorkspaces: [] }, automation)
    ).toBeNull()
  })
  it('treats a paired runtime own filesystem as local only in its own authority', () => {
    const remote = {
      ...automation,
      workspaceId: null,
      schedulerOwner: 'remote_host_service' as const
    }
    expect(captureAutomationDeliveryHost(state, remote, 'desktop')).toBeNull()
    expect(captureAutomationDeliveryHost(state, remote, 'runtime')).toBe('local')
  })
})
