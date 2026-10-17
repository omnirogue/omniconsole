import { describe, expect, it, vi } from 'vitest'
import type { GitStatusEntry, GitStatusResult } from '../../shared/git-status-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { sessionOutcomeSourceChanges } from './session-outcome-source-packet-changes'

function entry(
  path: string,
  status: GitStatusEntry['status'] = 'modified',
  extra: Partial<GitStatusEntry> = {}
): GitStatusEntry {
  return { path, status, area: status === 'untracked' ? 'untracked' : 'unstaged', ...extra }
}

function fixture(entries: GitStatusEntry[], extra: Partial<GitStatusResult> = {}) {
  const getRuntimeGitStatus = vi.fn<OrcaRuntimeService['getRuntimeGitStatus']>().mockResolvedValue({
    entries,
    conflictOperation: 'unknown',
    ...extra
  })
  return { runtime: { getRuntimeGitStatus } as unknown as OrcaRuntimeService, getRuntimeGitStatus }
}

describe('source changes selected from owning runtime Git status', () => {
  it('includes present changed files once, including untracked and rename/copy destinations', async () => {
    const { runtime, getRuntimeGitStatus } = fixture([
      entry('modified.ts'),
      entry('modified.ts', 'modified', { area: 'staged' }),
      entry('added.ts', 'added'),
      entry('untracked.ts', 'untracked'),
      entry('renamed.ts', 'renamed', { oldPath: 'previous.ts' }),
      entry('copied.ts', 'copied', { oldPath: 'source.ts' })
    ])
    await expect(sessionOutcomeSourceChanges(runtime, 'source', '/workspace')).resolves.toEqual({
      paths: [
        '/workspace/added.ts',
        '/workspace/copied.ts',
        '/workspace/modified.ts',
        '/workspace/renamed.ts',
        '/workspace/untracked.ts'
      ],
      unavailable: false
    })
    expect(getRuntimeGitStatus).toHaveBeenCalledWith('id:source', {
      includeLineStats: false,
      admissionTier: 'interactive'
    })
  })

  it('excludes implicit secrets, metadata, deleted files, submodules and paths outside the source workspace', async () => {
    const { runtime } = fixture([
      entry('keep.txt'),
      entry('.env'),
      entry('config/credentials.json'),
      entry('config\\private.key'),
      entry('.omni/runs/chain/step/output.txt'),
      entry('.omni/state.json'),
      entry('.git/config'),
      entry('nested/.GIT/config'),
      entry('removed.txt', 'deleted'),
      entry('module', 'modified', {
        submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: false }
      }),
      entry('module/source.ts', 'modified', { submoduleRoot: 'module' }),
      entry('../outside.txt'),
      entry('/another/workspace/file.txt')
    ])
    await expect(sessionOutcomeSourceChanges(runtime, 'source', '/workspace')).resolves.toEqual({
      paths: ['/workspace/keep.txt'],
      unavailable: false
    })
  })

  it('preserves Windows workspace paths while applying normalized secret exclusions', async () => {
    const { runtime } = fixture([entry('src\\worker.ts'), entry('config\\.env.local')])
    await expect(
      sessionOutcomeSourceChanges(runtime, 'source', 'C:\\work\\source')
    ).resolves.toEqual({ paths: ['C:\\work\\source\\src\\worker.ts'], unavailable: false })
  })

  it.each([{ didHitLimit: true }, { statusLength: 2 }])(
    'refuses incomplete status instead of treating a partial result as all changes: %j',
    async (extra) => {
      const { runtime } = fixture([entry('visible.ts')], extra)
      await expect(sessionOutcomeSourceChanges(runtime, 'source', '/workspace')).rejects.toThrow(
        'truncated'
      )
    }
  )

  it('refuses more than 32 eligible paths without silently dropping source files', async () => {
    const { runtime } = fixture(Array.from({ length: 33 }, (_, index) => entry(`${index}.ts`)))
    await expect(sessionOutcomeSourceChanges(runtime, 'source', '/workspace')).rejects.toThrow(
      '32 changes'
    )
  })

  it('does not count captured runtime copies, secrets, deleted paths or duplicate rows toward the file limit', async () => {
    const ignored = Array.from({ length: 33 }, (_, index) => [
      entry(`.omni/runs/chain/source/retained-${index}.txt`, 'untracked'),
      entry(`credentials.${index}`, 'untracked'),
      entry(`removed-${index}.txt`, 'deleted'),
      entry('keep.txt')
    ]).flat()
    const { runtime } = fixture(ignored, { statusLength: ignored.length })
    await expect(sessionOutcomeSourceChanges(runtime, 'source', '/workspace')).resolves.toEqual({
      paths: ['/workspace/keep.txt'],
      unavailable: false
    })
  })

  it('returns the same ordering when Git changes its staged and unstaged row order', async () => {
    const entries = [entry('second.txt'), entry('first.txt')]
    const { runtime, getRuntimeGitStatus } = fixture(entries)
    const first = await sessionOutcomeSourceChanges(runtime, 'source', '/workspace')
    getRuntimeGitStatus.mockResolvedValue({
      entries: entries.toReversed(),
      conflictOperation: 'unknown'
    })
    await expect(sessionOutcomeSourceChanges(runtime, 'source', '/workspace')).resolves.toEqual(
      first
    )
  })

  it('keeps unavailable status distinct from a confirmed clean source', async () => {
    const { runtime, getRuntimeGitStatus } = fixture([])
    await expect(sessionOutcomeSourceChanges(runtime, 'source', '/workspace')).resolves.toEqual({
      paths: [],
      unavailable: false
    })
    getRuntimeGitStatus.mockRejectedValue(new Error('The source host is unreachable.'))
    await expect(sessionOutcomeSourceChanges(runtime, 'source', '/workspace')).resolves.toEqual({
      paths: [],
      unavailable: true
    })
  })
})
