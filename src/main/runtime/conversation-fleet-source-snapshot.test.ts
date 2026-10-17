import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { captureConversationFleetSource } from './conversation-fleet-source-snapshot'
import * as sourceIo from './conversation-fleet-source-io'
import type { SessionFollowUpDeliverables } from '../../shared/session-follow-up-rule-fields'

const gitMock = vi.hoisted(() => vi.fn())
vi.mock('../git/runner', () => ({ gitExecFileAsync: gitMock }))

let root: string
let fixtureRoot: string
async function git(args: string[]) {
  const result = await runProcess({ program: 'git', args, cwd: root, timeoutMs: 10_000 })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}
async function repository() {
  await git(['init'])
  await git(['config', 'user.name', 'Source Snapshot Test'])
  await git(['config', 'user.email', 'snapshot@example.invalid'])
  await git(['config', 'core.autocrlf', 'false'])
  await git(['config', 'commit.gpgsign', 'false'])
  await git(['config', 'core.hooksPath', join(root, 'empty-hooks')])
  await writeFile(join(root, 'first.txt'), 'base one\n')
  await writeFile(join(root, 'second.txt'), 'base two\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'base'])
  await git(['remote', 'add', 'origin', 'git@example.invalid:team/source.git'])
}
async function capture(
  paths: string[] = [],
  includeDirtyTracked = true,
  deliverables?: SessionFollowUpDeliverables
) {
  return captureConversationFleetSource(
    { rootPath: root },
    {
      worktree: 'id:source',
      paths,
      includeDirtyTracked,
      expectedConnectionId: null,
      deliverables
    }
  )
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fleet-source-'))
  fixtureRoot = root
  gitMock.mockReset().mockImplementation(git)
})
afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true })
})

describe('owning host source snapshot', () => {
  it('automatically pins new Git output files only when the completed-source caller requests them', async () => {
    await repository()
    await writeFile(join(root, 'generated.md'), 'Actual newly generated result.\n')
    expect((await capture()).manifest.files).toEqual([])
    const result = await captureConversationFleetSource(
      { rootPath: root },
      {
        worktree: 'id:source',
        paths: [],
        includeDirtyTracked: true,
        includeUntracked: true,
        expectedConnectionId: null
      }
    )
    expect(result.manifest.files.map((file) => file.targetPath)).toEqual(['generated.md'])
    expect(result.bytes.get(result.manifest.files[0]!.id)?.toString()).toBe(
      'Actual newly generated result.\n'
    )
  })

  it('pins real HEAD, source remote, binary dirty bytes, renamed paths, deletions and executable mode', async () => {
    await repository()
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim()
    await rename(join(root, 'first.txt'), join(root, 'renamed.txt'))
    const binary = Buffer.from([0, 255, 128, 10])
    await writeFile(join(root, 'renamed.txt'), binary)
    await chmod(join(root, 'renamed.txt'), 0o755)
    await rm(join(root, 'second.txt'))
    await git(['add', '-A'])
    const result = await capture()
    expect(result.manifest.baseCommit).toBe(head)
    expect(result.manifest.remoteUrl).toBe('git@example.invalid:team/source.git')
    expect(result.manifest.files.map((file) => file.targetPath)).toEqual(['renamed.txt'])
    expect(result.manifest.deletions.sort()).toEqual(['first.txt', 'second.txt'])
    const file = result.manifest.files[0]
    expect(result.bytes.get(file.id)).toEqual(binary)
    expect(file.sha256).toMatch(/^[a-f0-9]{64}$/)
    if (process.platform !== 'win32') {
      expect(file.executable).toBe(true)
    }
  })

  it('captures a folder’s explicitly selected binary files without inheriting another repository', async () => {
    await repository()
    root = join(root, 'folder')
    await mkdir(root)
    await writeFile(join(root, 'document.pdf'), Buffer.from([255, 0, 1]))
    const result = await capture([join(root, 'document.pdf')])
    expect(result.manifest.baseCommit).toBeUndefined()
    expect(result.manifest.warnings).toHaveLength(1)
    expect(result.manifest.files[0].targetPath).toBe('document.pdf')
  })

  it('rejects outside paths, traversal, symlink parents and Git administrative files', async () => {
    await expect(capture(['../escape'])).rejects.toThrow(/safely/)
    await expect(capture(['/outside/source.txt'])).rejects.toThrow(/inside/)
    await expect(capture(['.git/config'])).rejects.toThrow(/administrative|safely/)
    if (process.platform !== 'win32') {
      await mkdir(join(root, 'actual'))
      await writeFile(join(root, 'actual/file'), 'private')
      await symlink(join(root, 'actual'), join(root, 'linked'))
      await expect(capture(['linked/file'])).rejects.toThrow(/symlink/)
    }
  })

  it('requires explicit selection for implicit secret paths and never silently drops a dirty file', async () => {
    await repository()
    await writeFile(join(root, '.env'), 'DUMMY=fixture')
    await git(['add', '.env'])
    await expect(capture()).rejects.toThrow(/possible secret/)
    expect((await capture(['.env'])).manifest.files[0].targetPath).toBe('.env')
    await git(['commit', '-m', 'tracked secret fixture'])
    await rm(join(root, '.env'))
    const deletion = await capture()
    expect(deletion.manifest.deletions).toEqual(['.env'])
    expect(deletion.manifest.files).toEqual([])
  })

  it('rejects source host mismatches before opening any local or remote source', async () => {
    await expect(
      captureConversationFleetSource(
        { rootPath: root, connectionId: 'ssh-other' },
        {
          worktree: 'id:source',
          paths: [],
          includeDirtyTracked: true,
          expectedConnectionId: null
        }
      )
    ).rejects.toThrow(/host changed/)
    expect(gitMock).not.toHaveBeenCalled()
  })

  it('detects a HEAD change during capture instead of combining generations', async () => {
    await repository()
    await writeFile(join(root, 'first.txt'), 'changed')
    let headReads = 0
    gitMock.mockImplementation(async (args: string[]) => {
      if (args.join(' ') === 'rev-parse --verify HEAD' && ++headReads === 2) {
        await git([
          '-c',
          'commit.gpgsign=false',
          'commit',
          '--allow-empty',
          '-m',
          'concurrent edit'
        ])
      }
      return git(args)
    })
    await expect(capture()).rejects.toThrow(/workspace changed/)
  })

  it('refuses more than 30 source files and files over 10 MiB', async () => {
    const paths = Array.from({ length: 31 }, (_, index) => `source-${index}`)
    await Promise.all(paths.map((path) => writeFile(join(root, path), 'x')))
    await expect(capture(paths)).rejects.toThrow(/at most 30/)
    await writeFile(join(root, 'large'), Buffer.alloc(10 * 1024 * 1024 + 1))
    await expect(capture(['large'])).rejects.toThrow(/10 MiB/)
  })

  it('refuses dirty submodule contents instead of returning an empty ordinary file snapshot', async () => {
    await repository()
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim()
    await git(['update-index', '--add', '--cacheinfo', `160000,${head},module`])
    await expect(capture()).rejects.toThrow(/Submodule/)
  })

  it('preserves an explicitly selected tracked deletion and rejects deletion of a Git submodule', async () => {
    await repository()
    await rm(join(root, 'first.txt'))
    expect((await capture(['first.txt'], false)).manifest.deletions).toEqual(['first.txt'])
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim()
    await git(['update-index', '--add', '--cacheinfo', `160000,${head},module`])
    await git(['commit', '-m', 'gitlink'])
    await git(['update-index', '--force-remove', 'module'])
    await expect(capture()).rejects.toThrow(/Submodule/)
  })

  it('explains structural file/directory replacements that the worker cannot materialize', async () => {
    await repository()
    await rm(join(root, 'first.txt'))
    await mkdir(join(root, 'first.txt'))
    await writeFile(join(root, 'first.txt/new.ts'), 'new source')
    await git(['add', '-A'])
    await expect(capture()).rejects.toThrow(/Commit these structural changes/)
  })

  it('keeps explicit people deliverables separate from selected context and dirty source files', async () => {
    await repository()
    await writeFile(join(root, 'first.txt'), 'dirty source')
    await writeFile(join(root, 'context.txt'), 'review context')
    await writeFile(join(root, 'handoff.pdf'), Buffer.from([255, 0, 128]))
    const result = await capture(['context.txt'], true, {
      kind: 'files',
      paths: [join(root, 'handoff.pdf')]
    })
    expect(result.manifest.deliverables).toEqual({ kind: 'files', paths: ['handoff.pdf'] })
    expect(result.manifest.deliverablePaths).toEqual(['handoff.pdf'])
    expect(result.manifest.files.map((file) => file.targetPath).sort()).toEqual([
      'context.txt',
      'first.txt',
      'handoff.pdf'
    ])
  })

  it('captures exact manifest bytes and only the files named by that explicit manifest', async () => {
    await mkdir(join(root, 'outputs'))
    const manifestBytes = Buffer.from('# Outputs\r\n- report.pdf\r\n', 'utf8')
    await writeFile(join(root, 'outputs/manifest.md'), manifestBytes)
    await writeFile(join(root, 'outputs/report.pdf'), Buffer.from([0, 255, 10]))
    await writeFile(join(root, 'outputs/unrelated.pdf'), 'not a deliverable')
    const result = await capture([], false, {
      kind: 'manifest',
      manifestPath: join(root, 'outputs/manifest.md')
    })
    expect(result.manifest.deliverables).toEqual({
      kind: 'manifest',
      manifestPath: 'outputs/manifest.md'
    })
    expect(result.manifest.deliverablePaths?.sort()).toEqual([
      'outputs/manifest.md',
      'outputs/report.pdf'
    ])
    const manifest = result.manifest.files.find(
      (file) => file.targetPath === 'outputs/manifest.md'
    )!
    expect(result.bytes.get(manifest.id)).toEqual(manifestBytes)
  })

  it.skipIf(process.platform === 'win32')(
    'resolves manifest entries through the registered workspace root alias',
    async () => {
      const actual = join(root, 'actual')
      const alias = join(root, 'registered')
      await mkdir(actual)
      await symlink(actual, alias)
      await writeFile(join(actual, 'manifest.md'), `- ${alias}/report.pdf\n`)
      await writeFile(join(actual, 'report.pdf'), 'declared report')
      root = alias
      const result = await capture([], false, {
        kind: 'manifest',
        manifestPath: join(alias, 'manifest.md')
      })
      expect(result.manifest.deliverablePaths?.sort()).toEqual(['manifest.md', 'report.pdf'])
    }
  )

  it('refuses a missing declared handoff file even if Git records a valid tracked deletion', async () => {
    await repository()
    await rm(join(root, 'first.txt'))
    await expect(capture([], true, { kind: 'files', paths: ['first.txt'] })).rejects.toThrow(
      /declared handoff file is missing/
    )
  })

  it('requires explicit user selection before a manifest can include a possible secret file', async () => {
    await writeFile(join(root, 'manifest.md'), '- .env\n')
    await writeFile(join(root, '.env'), 'TEST_FIXTURE=not-a-real-secret')
    const deliverables = { kind: 'manifest' as const, manifestPath: 'manifest.md' }
    await expect(capture([], false, deliverables)).rejects.toThrow(/possible secret file/)
    expect(
      (await capture(['.env'], false, deliverables)).manifest.deliverablePaths?.sort()
    ).toEqual(['.env', 'manifest.md'])
    expect(
      (await capture([], false, { kind: 'files', paths: ['.env'] })).manifest.deliverablePaths
    ).toEqual(['.env'])
  })

  it('rejects manifest substitution between parsing and final source capture', async () => {
    const manifestPath = join(root, 'manifest.md')
    await writeFile(manifestPath, '- first.txt\n')
    await writeFile(join(root, 'first.txt'), 'original declared output')
    const originalCreateIo = sourceIo.createFleetSourceIo
    const spy = vi.spyOn(sourceIo, 'createFleetSourceIo').mockImplementation((connectionId) => {
      const io = originalCreateIo(connectionId)
      return {
        ...io,
        readExact: async (path, maxBytes, expected) => {
          const bytes = await io.readExact(path, maxBytes, expected)
          if (path.endsWith('manifest.md')) {
            await writeFile(manifestPath, '- replacement.txt\n')
          }
          return bytes
        }
      }
    })
    try {
      await expect(capture([], false, { kind: 'manifest', manifestPath })).rejects.toThrow(
        /changed/
      )
    } finally {
      spy.mockRestore()
    }
  })
})
