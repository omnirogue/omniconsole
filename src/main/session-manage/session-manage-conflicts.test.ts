import { describe, expect, it, vi } from 'vitest'
import { findSessionConflicts, type LiveSession } from './session-manage-conflicts'
import { manageEntry, sidebarRow } from './session-manage-test-fixtures'

function live(
  title: string,
  worktreeId: string,
  rowOverrides: Parameters<typeof sidebarRow>[0] = {}
): LiveSession {
  const paneKey = `${title}:leaf`
  return {
    entry: manageEntry({ title, paneKey, worktreeId }),
    row: sidebarRow({ title, paneKey, worktreeId, ...rowOverrides })
  }
}

const changes: Record<string, { files: string[]; branch: string | null }> = {
  'repo::/a': { files: ['src/parser.ts', 'README.md'], branch: 'feat/parser' },
  'repo::/b': { files: ['src/parser.ts', 'src/lexer.ts'], branch: 'feat/lexer' },
  'other::/c': { files: ['src/parser.ts'], branch: 'main' }
}
const readChanged = vi.fn(async (worktreeId: string) => {
  const change = changes[worktreeId]
  if (!change) {
    throw new Error('SSH host is not connected')
  }
  return change
})

describe('findSessionConflicts', () => {
  it('flags a file changed in two worktrees of one repo, with branches and sessions', async () => {
    const result = await findSessionConflicts(
      [
        live('Parser', 'repo::/a', { worktreePath: '/a', branch: 'feat/parser' }),
        live('Lexer', 'repo::/b', { worktreePath: '/b', branch: 'feat/lexer' }),
        live('Other repo', 'other::/c', { repoId: 'other', repoLabel: 'other', worktreePath: '/c' })
      ],
      readChanged
    )
    expect(result.repos).toEqual([
      {
        repo: 'repo',
        sharedFiles: [
          {
            path: 'src/parser.ts',
            worktrees: [
              {
                worktreeId: 'repo::/a',
                path: '/a',
                branch: 'feat/parser',
                sessions: [{ paneKey: 'Parser:leaf', title: 'Parser' }]
              },
              {
                worktreeId: 'repo::/b',
                path: '/b',
                branch: 'feat/lexer',
                sessions: [{ paneKey: 'Lexer:leaf', title: 'Lexer' }]
              }
            ]
          }
        ],
        sharedWorktrees: []
      }
    ])
    expect(result.checkedWorktrees).toBe(3)
  })

  it('flags two live sessions sharing one worktree, with what it changed', async () => {
    const result = await findSessionConflicts(
      [live('One', 'repo::/a'), live('Two', 'repo::/a')],
      readChanged
    )
    expect(result.repos[0]!.sharedWorktrees).toEqual([
      {
        worktreeId: 'repo::/a',
        path: '/w',
        branch: 'feat/parser',
        sessions: [
          { paneKey: 'One:leaf', title: 'One' },
          { paneKey: 'Two:leaf', title: 'Two' }
        ],
        files: ['README.md', 'src/parser.ts']
      }
    ])
  })

  it('says a folder workspace has no git to compare, even when two sessions share it', async () => {
    const folder = {
      workspaceKind: 'folder' as const,
      repoId: null,
      repoLabel: null,
      worktreePath: '/notes'
    }
    const result = await findSessionConflicts(
      [live('Notes A', 'folder:f1', folder), live('Notes B', 'folder:f1', folder)],
      readChanged
    )
    expect(result.repos).toEqual([])
    expect(result.skipped).toEqual([
      {
        worktreeId: 'folder:f1',
        path: '/notes',
        reason:
          'A folder workspace has no git, so there are no git conflicts to compare. 2 live sessions share this one workspace.',
        sessions: ['Notes A', 'Notes B']
      }
    ])
    expect(readChanged).not.toHaveBeenCalledWith('folder:f1')
  })

  it('reports a host whose git cannot be read as unverifiable, never as clean', async () => {
    const result = await findSessionConflicts([live('Remote', 'repo::/ssh')], readChanged)
    expect(result.repos).toEqual([])
    expect(result.skipped[0]!.reason).toContain('unverifiable, not clean')
    expect(result.skipped[0]!.reason).toContain('SSH host is not connected')
  })

  it('does not call the same path in two different repos a conflict', async () => {
    const result = await findSessionConflicts(
      [
        live('Parser', 'repo::/a'),
        live('Other repo', 'other::/c', { repoId: 'other', repoLabel: 'other' })
      ],
      readChanged
    )
    expect(result.repos).toEqual([])
  })
})
