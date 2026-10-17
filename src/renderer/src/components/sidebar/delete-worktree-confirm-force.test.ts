import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { canForceOnOrdinaryConfirm, forceForTargets } from './delete-worktree-confirm-force'

const repo = { id: 'repo-1', kind: 'git', path: '/repo' } as Repo
const repos = [repo]
const target = (id: string, hostId?: string) =>
  ({ id, hostId, repoId: 'repo-1', isMainWorktree: false }) as unknown as Worktree

describe('canForceOnOrdinaryConfirm (the sidebar confirm force gap)', () => {
  it('forces only a target whose change status the dialog read and showed', () => {
    const args = { forceOnConfirm: true, gitStatusByWorktree: { shown: [{}] }, repos }
    expect(canForceOnOrdinaryConfirm(target('shown'), args)).toBe(true)
    // Why: unread status could hide uncommitted work the person never saw.
    expect(canForceOnOrdinaryConfirm(target('unread'), args)).toBe(false)
    expect(canForceOnOrdinaryConfirm(target('shown'), { ...args, forceOnConfirm: false })).toBe(
      false
    )
  })

  it('reads a remote target by host-qualified identity', () => {
    const remote = target('shared', 'ssh:box')
    const args = {
      forceOnConfirm: true,
      gitStatusByWorktree: { shared: [] },
      gitStatusByWorktreeIdentity: new Map<string, readonly unknown[]>(),
      repos
    }
    expect(canForceOnOrdinaryConfirm(remote, args)).toBe(false)
  })

  it('maps each deleted target back to its confirmed row by host', () => {
    const local = target('same')
    const remote = target('same', 'ssh:box')
    const forceFor = forceForTargets([local, remote], (item) => item.hostId === 'ssh:box')
    expect(forceFor({ id: 'same', hostId: 'ssh:box' })).toBe(true)
    expect(forceFor({ id: 'same', hostId: undefined })).toBe(false)
    expect(forceFor({ id: 'missing', hostId: undefined })).toBe(false)
  })

  it('never forces a Git target because another host has a same-id folder (review R1)', () => {
    const folderElsewhere = { ...repo, kind: 'folder', executionHostId: 'ssh:box' } as Repo
    const args = { forceOnConfirm: true, gitStatusByWorktree: {}, repos: [repo, folderElsewhere] }
    expect(canForceOnOrdinaryConfirm(target('local-git', 'local'), args)).toBe(false)
    expect(canForceOnOrdinaryConfirm(target('unhosted'), args)).toBe(false)
    expect(canForceOnOrdinaryConfirm(target('on-box', 'ssh:box'), args)).toBe(true)
  })

  it('keeps the refusal from Git when the dialog showed no changes (review R2)', () => {
    const args = { forceOnConfirm: true, gitStatusByWorktree: { clean: [] }, repos }
    expect(canForceOnOrdinaryConfirm(target('clean'), args)).toBe(false)
  })

  it('never forces an unhosted target on the strength of a foreign folder alone (R1 round 2)', () => {
    const folderElsewhere = { ...repo, kind: 'folder', executionHostId: 'ssh:box' } as Repo
    const args = { forceOnConfirm: true, gitStatusByWorktree: {}, repos: [folderElsewhere] }
    expect(canForceOnOrdinaryConfirm(target('legacy'), args)).toBe(false)
    expect(canForceOnOrdinaryConfirm(target('elsewhere', 'ssh:other'), args)).toBe(false)
  })
})
