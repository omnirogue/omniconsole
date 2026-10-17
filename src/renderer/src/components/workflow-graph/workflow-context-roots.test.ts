import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  workflowContextFolderMatches,
  workflowContextLocalCopies,
  workflowContextLocalRoots
} from './workflow-context-roots'

const repo = (fields: Partial<Repo>): Repo =>
  ({ id: 'r1', path: '/w/app', displayName: 'app', addedAt: 0, badgeColor: '', ...fields }) as Repo
const worktree = (fields: Partial<Worktree>): Worktree =>
  ({
    id: 'r1::/w/app',
    repoId: 'r1',
    path: '/w/app',
    branch: 'refs/heads/main',
    isArchived: false,
    isBare: false,
    ...fields
  }) as Worktree

describe('where the picker searches', () => {
  it('lists local workspaces with their branch and GitHub name, never remote ones', () => {
    const roots = workflowContextLocalRoots(
      [
        repo({
          gitRemoteIdentity: {
            canonicalKey: 'github.com/omnirogue/omni-ide',
            remoteName: 'origin',
            remoteUrl: ''
          }
        }),
        repo({ id: 'r2', connectionId: 'ssh-1' })
      ],
      {
        r1: [
          worktree({}),
          worktree({ id: 'r1::/w/old', path: '/w/old', isArchived: true }),
          worktree({ id: 'r1::/w/feat', path: '/w/feat', branch: 'refs/heads/feat/x' })
        ],
        r2: [worktree({ id: 'r2::/remote', repoId: 'r2', path: '/remote' })]
      }
    )
    expect(roots).toEqual([
      {
        worktreeId: 'r1::/w/app',
        label: 'app · main',
        path: '/w/app',
        branch: 'main',
        github: 'omnirogue/omni-ide'
      },
      {
        worktreeId: 'r1::/w/feat',
        label: 'app · feat/x',
        path: '/w/feat',
        branch: 'feat/x',
        github: 'omnirogue/omni-ide'
      }
    ])
    expect(workflowContextLocalCopies(roots, 'omnirogue/Omni-IDE')).toHaveLength(2)
    expect(workflowContextLocalCopies(roots, 'acme/api')).toEqual([])
  })

  it('offers the folders whose own name matches, shortest first', () => {
    expect(
      workflowContextFolderMatches(
        ['docs/guide/intro.md', 'src/docs-site/a.ts', 'src/app.ts', 'docs/b.md'],
        'docs'
      )
    ).toEqual(['docs', 'src/docs-site'])
    expect(workflowContextFolderMatches(['a/b.md'], '  ')).toEqual([])
  })
})
