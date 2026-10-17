import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { capturedHandoffFile } from '../../shared/exact-handoff-file-read'
import { buildHandoffManifest } from '../../shared/handoff-manifest'
import { captureDirectoryRoot, checkRootedDirectory } from '../filesystem-directory-chain'
import { writeExclusiveFile } from '../filesystem-exclusive-file'
import { defaultMaterializeRoot, materializeHandoffFiles } from './handoff-materialize'

let fixture: string
let workspace: string
const exact = capturedHandoffFile('input.txt', Buffer.from('one exact file'))
const threadFiles = [{ id: 'hfv_test', name: exact.name, sha256: exact.sha256 }]
function manifest(rel = 'nested/input.txt') {
  return buildHandoffManifest({
    createdAt: new Date('2026-09-15T05:00:00Z'),
    source: { sessionLabel: 'containment test' },
    memo: '',
    files: [{ rel, route: 'pin', name: exact.name, size: exact.size, sha256: exact.sha256 }]
  })
}
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'handoff-containment-'))
  workspace = join(fixture, 'workspace')
  await mkdir(workspace)
})
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true })
})

it.skipIf(process.platform === 'win32').each(['outside', 'inside'])(
  'refuses an existing parent symlink pointing %s the workspace',
  async (kind) => {
    const destination = join(kind === 'outside' ? fixture : workspace, 'real')
    await mkdir(destination)
    await symlink(destination, join(workspace, 'nested'))
    const download = vi.fn().mockResolvedValue(exact)
    const result = await materializeHandoffFiles({
      root: workspace,
      manifest: manifest(),
      threadFiles,
      io: { download }
    })
    expect(result.complete).toBe(false)
    expect(download).not.toHaveBeenCalled()
    expect(await readdir(destination)).toEqual([])
  }
)

it.skipIf(process.platform === 'win32')('refuses a matching-content symlink leaf', async () => {
  const source = join(fixture, 'input.txt')
  await writeFile(source, Buffer.from(exact.contentBase64, 'base64'))
  await symlink(source, join(workspace, 'input.txt'))
  const result = await materializeHandoffFiles({
    root: workspace,
    manifest: manifest('input.txt'),
    threadFiles,
    io: { download: vi.fn().mockResolvedValue(exact) }
  })
  expect(result.files[0]?.outcome).toBe('refused')
  expect(await readFile(source, 'utf8')).toBe('one exact file')
})

it('refuses a file in the parent chain without replacing it', async () => {
  await writeFile(join(workspace, 'nested'), 'recipient work')
  const result = await materializeHandoffFiles({
    root: workspace,
    manifest: manifest(),
    threadFiles,
    io: { download: vi.fn().mockResolvedValue(exact) }
  })
  expect(result.complete).toBe(false)
  expect(await readFile(join(workspace, 'nested'), 'utf8')).toBe('recipient work')
})

it('creates a missing handoff prefix beneath the existing workspace and replays unchanged', async () => {
  const fileManifest = {
    ...manifest(),
    git: { repo: 'test/repo', branch: 'handoff/test', sha: 'a'.repeat(40) }
  }
  const root = defaultMaterializeRoot(workspace, fileManifest)
  const input = {
    workspacePath: workspace,
    root,
    manifest: fileManifest,
    threadFiles,
    io: { download: vi.fn().mockResolvedValue(exact) }
  }
  expect((await materializeHandoffFiles(input)).files[0]?.outcome).toBe('written')
  expect((await materializeHandoffFiles(input)).files[0]?.outcome).toBe('unchanged')
  expect(input.io.download).toHaveBeenCalledTimes(1)
  expect(await readdir(workspace)).toEqual(['.omni'])
})

it.skipIf(process.platform === 'win32')(
  'accepts a chosen root alias but refuses a symlink in its missing prefix',
  async () => {
    const alias = join(fixture, 'alias')
    await symlink(workspace, alias)
    const input = {
      workspacePath: alias,
      root: join(alias, 'new', 'prefix'),
      manifest: manifest(),
      threadFiles,
      io: { download: vi.fn().mockResolvedValue(exact) }
    }
    expect((await materializeHandoffFiles(input)).complete).toBe(true)
    await symlink(join(workspace, 'new'), join(workspace, 'redirect'))
    const result = await materializeHandoffFiles({
      ...input,
      root: join(alias, 'redirect', 'missing')
    })
    expect(result.complete).toBe(false)
    expect(await readdir(join(workspace, 'new'))).toEqual(['prefix'])
  }
)

it.skipIf(process.platform === 'win32')(
  'detects a parent replaced during the download and preserves outside files',
  async () => {
    await mkdir(join(workspace, 'nested'))
    const outside = join(fixture, 'outside')
    await mkdir(outside)
    const download = async () => {
      await rename(join(workspace, 'nested'), join(workspace, 'old'))
      await symlink(outside, join(workspace, 'nested'))
      return exact
    }
    const result = await materializeHandoffFiles({
      root: workspace,
      manifest: manifest(),
      threadFiles,
      io: { download }
    })
    expect(result.complete).toBe(false)
    expect(await readdir(outside)).toEqual([])
    expect((await readdir(workspace)).filter((name) => name.endsWith('.omni-tmp'))).toEqual([])
  }
)

it('cleans its temporary file after a destination collision', async () => {
  const target = join(workspace, 'input.txt')
  await writeFile(target, 'recipient work')
  await expect(writeExclusiveFile(target, Buffer.from('new work'))).rejects.toMatchObject({
    code: 'EEXIST'
  })
  expect(await readdir(workspace)).toEqual(['input.txt'])
  expect(await readFile(target, 'utf8')).toBe('recipient work')
})

it.skipIf(process.platform === 'win32')(
  'rechecks just before promotion and cleans staging when a nested parent is replaced',
  async () => {
    const target = join(workspace, 'nested', 'input.txt')
    await mkdir(dirname(target))
    const outside = join(fixture, 'outside')
    await mkdir(outside)
    const root = await captureDirectoryRoot(workspace)
    const canonicalTarget = join(root.path, 'nested', 'input.txt')
    let checks = 0
    await expect(
      writeExclusiveFile(canonicalTarget, Buffer.from('new work'), {
        temporaryDirectory: root.path,
        validateTemporaryParent: () => checkRootedDirectory(root, root.path),
        validateDestinationParent: async () => {
          if (++checks === 2) {
            await rename(dirname(target), join(workspace, 'old'))
            await symlink(outside, dirname(target))
          }
          return checkRootedDirectory(root, dirname(canonicalTarget))
        }
      })
    ).rejects.toThrow('not a real directory')
    expect(await readdir(outside)).toEqual([])
    expect((await readdir(workspace)).filter((name) => name.endsWith('.omni-tmp'))).toEqual([])
  }
)
