import { sessionChainStepOutputDir } from '../../shared/session-chain-types'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { sessionOutcomeCandidateVersion } from './session-outcome-candidate'

const folders: string[] = []
async function folder() {
  const path = await mkdtemp(join(tmpdir(), 'candidate-manifest-'))
  folders.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it('identifies over 5000 tracked files from real Git objects, including dirty repairs and ignored files', async () => {
  const path = await folder()
  const git = async (args: string[]) => {
    const result = await runProcess({
      program: 'git',
      args: ['-C', path, ...args],
      timeoutMs: 15000
    })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  await git(['init'])
  await writeFile(join(path, 'seed'), 'original')
  const blob = await git(['hash-object', '-w', 'seed'])
  // Materialize 5101 tracked paths using one blob, without 5101 separate subprocesses.
  await writeFile(
    join(path, 'manifest'),
    Array.from({ length: 5101 }, (_, i) => `100644 blob ${blob}\tfile-${i}\n`).join('')
  )
  const tree = await runProcess({
    program: 'git',
    args: ['-C', path, 'mktree'],
    input: await import('node:fs/promises').then((fs) =>
      fs.readFile(join(path, 'manifest'), 'utf8')
    )
  })
  expect(tree.code, tree.stderr).toBe(0)
  await git(['read-tree', tree.stdout.trim()])
  await git(['checkout-index', '-a'])
  await writeFile(join(path, '.gitignore'), 'ignored\nseed\nmanifest\n')
  const first = await sessionOutcomeCandidateVersion(path, ['./result.json'])
  await writeFile(join(path, 'ignored'), 'log timestamp 123')
  expect(await sessionOutcomeCandidateVersion(path, ['./result.json'])).toBe(first)
  await writeFile(join(path, 'file-5001'), 'repair')
  expect(await sessionOutcomeCandidateVersion(path, ['./result.json'])).not.toBe(first)
  await writeFile(join(path, 'file-5001'), 'original')
  expect(await sessionOutcomeCandidateVersion(path, ['./result.json'])).toBe(first)
})

it('scopes folder reviews to declared deliverables, including relative targets', async () => {
  const path = await folder()
  await writeFile(join(path, 'result'), 'v1')
  const first = await sessionOutcomeCandidateVersion(path, ['./result'])
  await writeFile(join(path, 'unrelated'), 'different work')
  expect(await sessionOutcomeCandidateVersion(path, ['./result'])).toBe(first)
  await writeFile(join(path, 'result'), 'v2')
  expect(await sessionOutcomeCandidateVersion(path, ['./result'])).not.toBe(first)
  await expect(sessionOutcomeCandidateVersion(path)).rejects.toThrow('explicit deliverable')
  // A verify gate alone may pin the folder itself: its work can land away from disk.
  const unnamed = await sessionOutcomeCandidateVersion(path, [], { folderPin: true })
  expect(unnamed).toMatch(/^[0-9a-f]{64}$/)
  await writeFile(join(path, 'notes'), 'more work')
  expect(await sessionOutcomeCandidateVersion(path, [], { folderPin: true })).toBe(unnamed)
})

it('combines Git source identity with ignored and external declared deliverables', async () => {
  const path = await folder(),
    external = await folder()
  await writeFile(join(path, 'source.ts'), 'original source')
  await writeFile(join(path, '.gitignore'), 'manifest.json\nnoise\n')
  for (const args of [['init'], ['add', 'source.ts', '.gitignore']]) {
    const result = await runProcess({ program: 'git', args: ['-C', path, ...args] })
    expect(result.code, result.stderr).toBe(0)
  }
  const deliverables = ['./manifest.json', join(external, 'result')]
  const initial = await sessionOutcomeCandidateVersion(path, deliverables)
  await writeFile(join(path, 'noise'), 'ignored timestamp')
  expect(await sessionOutcomeCandidateVersion(path, deliverables)).toBe(initial)
  await writeFile(join(path, 'source.ts'), 'code-only repair')
  expect(await sessionOutcomeCandidateVersion(path, deliverables)).not.toBe(initial)
  await writeFile(join(path, 'source.ts'), 'original source')
  expect(await sessionOutcomeCandidateVersion(path, deliverables)).toBe(initial)
  await writeFile(join(path, 'manifest.json'), 'actual manifest')
  const manifested = await sessionOutcomeCandidateVersion(path, deliverables)
  expect(manifested).not.toBe(initial)
  await writeFile(join(external, 'result'), 'external delivery')
  expect(await sessionOutcomeCandidateVersion(path, deliverables)).not.toBe(manifested)
})

it('does not downgrade a broken Git checkout to its declared manifest', async () => {
  const path = await folder()
  await writeFile(join(path, '.git'), 'gitdir: missing-git-directory\n')
  await writeFile(join(path, 'manifest'), 'unchanged')
  await expect(sessionOutcomeCandidateVersion(path, ['./manifest'])).rejects.toThrow(
    'Restore Git access'
  )
})

it('ignores only undeclared untracked runtime reports while preserving source, tracked outputs and declared manifests', async () => {
  const path = await folder()
  const outputDir = sessionChainStepOutputDir(path, 'chain', 'writer')
  const reportDir = sessionChainStepOutputDir(path, 'run', 'reviewer')
  const manifest = join(outputDir, 'manifest.md')
  const report = join(reportDir, 'report.md')
  await mkdir(outputDir, { recursive: true })
  await mkdir(reportDir, { recursive: true })
  await writeFile(join(path, 'source.ts'), 'original source')
  await writeFile(manifest, 'final writer manifest')
  const git = (args: string[]) => runProcess({ program: 'git', args: ['-C', path, ...args] })
  expect((await git(['init'])).code).toBe(0)
  expect((await git(['add', 'source.ts'])).code).toBe(0)
  const initial = await sessionOutcomeCandidateVersion(path, [manifest])
  await writeFile(report, 'review findings')
  expect((await git(['check-ignore', report])).code).toBe(1)
  expect((await git(['ls-files', '--others', '--exclude-standard'])).stdout).toContain(
    '.omni/runs/run/reviewer/report.md'
  )
  expect(await sessionOutcomeCandidateVersion(path, [manifest])).toBe(initial)
  await writeFile(report, 'updated review findings')
  expect(await sessionOutcomeCandidateVersion(path, [manifest])).toBe(initial)
  await writeFile(join(path, 'source.ts'), 'reviewer source edit')
  expect(await sessionOutcomeCandidateVersion(path, [manifest])).not.toBe(initial)
  await writeFile(join(path, 'source.ts'), 'original source')
  await writeFile(manifest, 'reviewer changed declared artifact')
  expect(await sessionOutcomeCandidateVersion(path, [manifest])).not.toBe(initial)
  await writeFile(manifest, 'final writer manifest')
  const declaredReport = await sessionOutcomeCandidateVersion(path, [manifest, report])
  await writeFile(report, 'changed explicitly declared report')
  expect(await sessionOutcomeCandidateVersion(path, [manifest, report])).not.toBe(declaredReport)
  expect((await git(['add', report])).code).toBe(0)
  const trackedReport = await sessionOutcomeCandidateVersion(path, [manifest])
  await writeFile(report, 'changed tracked report')
  expect(await sessionOutcomeCandidateVersion(path, [manifest])).not.toBe(trackedReport)
  await writeFile(report, 'changed explicitly declared report')
  await writeFile(join(path, '.omni', 'user-config'), 'user owned settings')
  expect(await sessionOutcomeCandidateVersion(path, [manifest])).not.toBe(trackedReport)
})
