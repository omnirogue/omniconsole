import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import { mergeSessionFiles, sessionChangedFilesFromStatus } from './next-step-session-changes'

const entry = (
  path: string,
  status: GitStatusEntry['status'],
  extra: Partial<GitStatusEntry> = {}
): GitStatusEntry =>
  ({
    path,
    status,
    area: status === 'untracked' ? 'untracked' : 'unstaged',
    ...extra
  }) as GitStatusEntry

describe('sessionChangedFilesFromStatus', () => {
  it('keeps what the workspace changed as absolute paths, in git order, without deletions or duplicates', () => {
    const files = sessionChangedFilesFromStatus(
      [
        entry('report.md', 'modified'),
        entry('out/data.csv', 'untracked'),
        entry('old.txt', 'deleted'),
        entry('report.md', 'modified', { area: 'staged' }),
        entry('lib', 'modified', { submodule: { status: 'modified' } as never }),
        entry('../outside.md', 'added')
      ],
      '/work',
      10
    )
    expect(files).toEqual({ paths: ['/work/report.md', '/work/out/data.csv'], truncated: false })
  })

  it('caps the list at what a handoff carries and says so', () => {
    const files = sessionChangedFilesFromStatus(
      ['a', 'b', 'c'].map((name) => entry(`${name}.md`, 'added')),
      '/work',
      2
    )
    expect(files).toEqual({ paths: ['/work/a.md', '/work/b.md'], truncated: true })
  })
})

describe('mergeSessionFiles', () => {
  it('starts from the detection and keeps files the person added on top of an earlier one', () => {
    expect(
      mergeSessionFiles({
        detected: ['/work/a.md', '/work/c.md'],
        current: ['/work/a.md', '/work/b.md', '/work/extra.pdf'],
        previousDetected: ['/work/a.md', '/work/b.md'],
        limit: 10
      })
    ).toEqual(['/work/a.md', '/work/c.md', '/work/extra.pdf'])
  })

  it('does not bring back a detected file the person removed, and respects the cap', () => {
    expect(
      mergeSessionFiles({
        detected: ['/work/a.md', '/work/b.md', '/work/c.md'],
        current: ['/work/b.md'],
        previousDetected: ['/work/a.md', '/work/b.md'],
        limit: 2
      })
    ).toEqual(['/work/b.md', '/work/c.md'])
  })
})
