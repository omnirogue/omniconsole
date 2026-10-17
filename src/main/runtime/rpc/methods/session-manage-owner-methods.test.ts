import { describe, expect, it } from 'vitest'
import type { SessionManageActor } from '../../../../shared/session-manage-types'
import { sidebarRow } from '../../../session-manage/session-manage-test-fixtures'
import type { RpcContext } from '../core'
import { sessionOwnerScope } from './session-manage-owner-methods'

const GITHUB_REMOTE = {
  canonicalKey: 'github.com/omnirogue/omni-ide',
  remoteName: 'origin',
  remoteUrl: 'https://github.com/omnirogue/omni-ide.git'
}

const ASKER: SessionManageActor = { kind: 'pane', paneKey: 'tab-1:leaf-1', title: 'Parser fix' }

function context(gitRemoteIdentity: typeof GITHUB_REMOTE | null): RpcContext {
  const repo = { id: 'repo', upstream: undefined, repoIcon: undefined, gitRemoteIdentity }
  return { runtime: { listRepos: () => [repo] } } as unknown as RpcContext
}

describe('sessionOwnerScope', () => {
  it("adds the asking repository's shared project id, so the launch can pick the computer", async () => {
    const scope = await sessionOwnerScope(context(GITHUB_REMOTE), [sidebarRow()], ASKER, {})

    expect(scope).toMatchObject({
      worktreeId: 'repo::/w',
      repoId: 'repo',
      projectId: 'github:omnirogue/omni-ide'
    })
  })

  it('adds the project id for a --repo scope too', async () => {
    const scope = await sessionOwnerScope(context(GITHUB_REMOTE), [sidebarRow()], ASKER, {
      repo: 'repo'
    })

    expect(scope).toEqual({ repoId: 'repo', projectId: 'github:omnirogue/omni-ide' })
  })

  it('adds none for a repository only this computer can name', async () => {
    const scope = await sessionOwnerScope(context(null), [sidebarRow()], ASKER, {})

    expect(scope.repoId).toBe('repo')
    expect(scope).not.toHaveProperty('projectId')
  })
})
