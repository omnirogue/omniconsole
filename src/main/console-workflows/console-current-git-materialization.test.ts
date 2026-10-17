import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  consoleCurrentGitHydrationSources,
  materializeConsoleCurrentGitSource
} from './console-current-git-materialization'
import { hydrateConsoleFolderCandidate } from './console-folder-round-snapshot'
import { canonicalDigestJson } from './console-job-digests'
import {
  createConsoleCurrentGitFixture,
  currentGitAcceptedCandidate,
  currentGitActivation,
  currentGitSha
} from './console-current-git-test-fixture'

describe('captured Git selection materialization', () => {
  let f: Awaited<ReturnType<typeof createConsoleCurrentGitFixture>>
  beforeEach(async () => {
    f = await createConsoleCurrentGitFixture()
  })
  afterEach(async () => {
    await rm(f.directory, { recursive: true, force: true })
  })

  async function expectOriginalPreserved() {
    expect(await readFile(join(f.cwd, 'selected.txt'), 'utf8')).toBe('captured dirty source\n')
    expect(await readFile(join(f.cwd, 'outputs/new.txt'), 'utf8')).toBe(
      'captured untracked output\n'
    )
    await expect(readFile(join(f.cwd, 'deleted.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.git(['rev-parse', 'HEAD'])).stdout.trim()).toBe(f.job.baseSha)
  }

  it.each(['review', 'repair'] as const)(
    'starts the first %s from the exact HEAD and materializes dirty bytes, untracked output and deletion',
    async (action) => {
      f.job.action = action
      f.job.readOnly = action === 'review'
      f.input.loop_stage.role = action === 'review' ? 'participant' : 'repair'
      f.job.artifactResult!.path =
        action === 'review' ? 'folder-review.json' : 'folder-snapshot.json'
      const worktree = await f.worktree()
      expect((await f.git(['status', '--porcelain'], worktree.path)).stdout).toBe('')
      expect(await consoleCurrentGitHydrationSources(f.job, worktree.path)).toMatchObject([
        { target_path: 'deleted.txt', file: { sha256: currentGitSha('committed deletion\n') } },
        { target_path: 'outputs/new.txt', file: { sha256: null } },
        { target_path: 'selected.txt', file: { sha256: currentGitSha('committed source\n') } }
      ])

      await materializeConsoleCurrentGitSource(f.job, worktree.path, f.preparedInputPaths)

      expect(await readFile(join(worktree.path, 'selected.txt'), 'utf8')).toBe(
        'captured dirty source\n'
      )
      expect(await readFile(join(worktree.path, 'outputs/new.txt'), 'utf8')).toBe(
        'captured untracked output\n'
      )
      expect(await readFile(join(worktree.path, 'untouched.txt'), 'utf8')).toBe(
        'unselected committed source\n'
      )
      await expect(readFile(join(worktree.path, 'deleted.txt'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      expect((await f.git(['rev-parse', 'HEAD'], worktree.path)).stdout.trim()).toBe(f.job.baseSha)
      await expectOriginalPreserved()
    }
  )

  it('hydrates round two from the accepted repaired bytes and omissions without restoring the original capture', async () => {
    const first = await f.worktree()
    await materializeConsoleCurrentGitSource(f.job, first.path, f.preparedInputPaths)
    await writeFile(join(first.path, 'selected.txt'), 'accepted repair\n')
    await rm(join(first.path, 'outputs/new.txt'))
    const { artifact, candidate, envelope } = await currentGitAcceptedCandidate(f.job, first.path)
    expect(envelope.files.map((file) => file.path)).toEqual(['selected.txt'])
    expect(envelope.changed_files).toEqual(['deleted.txt', 'outputs/new.txt', 'selected.txt'])

    const originalSource = structuredClone(f.input.current_source)
    f.input.loop_stage.round = 2
    f.input.source_overlay = false
    Object.assign(f.input, { folder_candidate: candidate })
    const second = await f.worktree('round2')
    await hydrateConsoleFolderCandidate({
      activation: currentGitActivation(f.job),
      workspacePath: second.path,
      candidate,
      contentBase64: artifact.contentBase64
    })

    expect(await readFile(join(second.path, 'selected.txt'), 'utf8')).toBe('accepted repair\n')
    await expect(readFile(join(second.path, 'outputs/new.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(readFile(join(second.path, 'deleted.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(f.input.current_source).toEqual(originalSource)
    await expect(
      materializeConsoleCurrentGitSource(f.job, second.path, f.preparedInputPaths)
    ).rejects.toThrow('Only an initial Git round')
    expect(await readFile(join(second.path, 'selected.txt'), 'utf8')).toBe('accepted repair\n')
    await expectOriginalPreserved()
  })

  it('materializes and transfers a deletion-only capture without requiring an uploaded file', async () => {
    f.input.current_source.files = []
    f.input.source_files = []
    f.job.inputs = [f.input]
    f.input.current_source.snapshot_digest = currentGitSha(
      canonicalDigestJson({
        head_sha: f.job.baseSha,
        files: [],
        deleted_paths: ['deleted.txt']
      })
    )
    const first = await f.worktree()
    await materializeConsoleCurrentGitSource(f.job, first.path, [])
    const { artifact, candidate, envelope } = await currentGitAcceptedCandidate(f.job, first.path)
    expect(envelope.files).toEqual([])
    expect(envelope.changed_files).toEqual(['deleted.txt'])
    expect(candidate.manifest).toEqual([])

    f.input.loop_stage.round = 2
    f.input.source_overlay = false
    Object.assign(f.input, { folder_candidate: candidate })
    const second = await f.worktree('round2')
    await hydrateConsoleFolderCandidate({
      activation: currentGitActivation(f.job),
      workspacePath: second.path,
      candidate,
      contentBase64: artifact.contentBase64
    })
    await expect(readFile(join(second.path, 'deleted.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await readFile(join(second.path, 'selected.txt'), 'utf8')).toBe('committed source\n')
    await expectOriginalPreserved()
  })

  it.each(['receipt', 'bytes'] as const)(
    'refuses a changed accepted %s before removing any committed source bytes',
    async (tamper) => {
      const first = await f.worktree()
      await materializeConsoleCurrentGitSource(f.job, first.path, f.preparedInputPaths)
      const { candidate, artifact } = await currentGitAcceptedCandidate(f.job, first.path)
      f.input.loop_stage.round = 2
      f.input.source_overlay = false
      Object.assign(f.input, { folder_candidate: candidate })
      const second = await f.worktree('round2')
      await expect(
        hydrateConsoleFolderCandidate({
          activation: currentGitActivation(f.job),
          workspacePath: second.path,
          candidate: tamper === 'receipt' ? { ...candidate, result_event_id: 13 } : candidate,
          contentBase64:
            tamper === 'bytes'
              ? Buffer.from('changed artifact').toString('base64')
              : artifact.contentBase64
        })
      ).rejects.toThrow(tamper === 'receipt' ? 'activated handoff' : 'accepted artifact')
      expect(await readFile(join(second.path, 'selected.txt'), 'utf8')).toBe('committed source\n')
      expect(await readFile(join(second.path, 'deleted.txt'), 'utf8')).toBe('committed deletion\n')
      expect((await f.git(['status', '--porcelain'], second.path)).stdout).toBe('')
    }
  )

  it.each(['missing', 'changed'] as const)(
    'rejects %s downloaded inputs before materializing any file or deletion',
    async (state) => {
      const worktree = await f.worktree()
      if (state === 'changed') {
        await writeFile(f.preparedInputPaths[0]!, 'wrong downloaded bytes\n')
      }
      await expect(
        materializeConsoleCurrentGitSource(
          f.job,
          worktree.path,
          state === 'missing' ? f.preparedInputPaths.slice(1) : f.preparedInputPaths
        )
      ).rejects.toThrow('captured Git input bytes')
      expect((await f.git(['status', '--porcelain'], worktree.path)).stdout).toBe('')
    }
  )

  it('refuses to materialize directly into the original session', async () => {
    await expect(
      materializeConsoleCurrentGitSource(f.job, f.cwd, f.preparedInputPaths)
    ).rejects.toThrow('isolated worktree')
    await expectOriginalPreserved()
  })

  it.each(['dirty', 'head'] as const)(
    'preserves an isolated checkout whose %s changed while inputs were downloading',
    async (change) => {
      const worktree = await f.worktree()
      await writeFile(join(worktree.path, 'selected.txt'), 'intervening edit\n')
      if (change === 'head') {
        await f.git(['add', 'selected.txt'], worktree.path)
        await f.git(['commit', '-m', 'intervening commit'], worktree.path)
      }
      await expect(
        materializeConsoleCurrentGitSource(f.job, worktree.path, f.preparedInputPaths)
      ).rejects.toThrow('changed before input materialization')
      expect(await readFile(join(worktree.path, 'selected.txt'), 'utf8')).toBe('intervening edit\n')
      expect(await readFile(join(worktree.path, 'deleted.txt'), 'utf8')).toBe(
        'committed deletion\n'
      )
      await expectOriginalPreserved()
    }
  )
})
